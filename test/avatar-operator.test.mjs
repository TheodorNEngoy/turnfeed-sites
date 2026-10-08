import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import { accountKey } from '../worker/identity.mjs';
import { makeCore } from '../worker/mcp.mjs';
import { operatorAction, handleOperator } from '../worker/operator.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import { photoPath, servePhoto, retireUnpublishedPhoto } from '../worker/photo-access.mjs';

const origin='https://turnfeed.example';
const secret='avatar-operator-local-0123456789012345678901234';
const actor=accountKey('operator',secret),userId=accountKey('alice',secret),id='a'.repeat(64);
const path=photoPath(id,'image/png'),url=origin+path;
const reason='Reviewed profile photo against the community rules.';
async function fixture(t) {
  const db=database(),objects=new Map([[path.slice(1),new Uint8Array([1,2,3])]]);
  t.after(()=>db.sql.close());
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('Operator avatar removal must not contact an external service');});
  db.sql.prepare(`INSERT INTO turnfeed_photos (id,owner,object_key,mime,bytes,digest,status,claim,created_at,day)
    VALUES (?,?,?,'image/png',3,?,'ready','',1,'2026-10-08')`).run(id,userId,path.slice(1),'b'.repeat(64));
  const core=makeCore({origin,secret}),snapshot=core.snapshot();
  snapshot.profiles[userId]={displayName:'Alice',bio:'A public biography.',avatarUrl:url};
  snapshot.users.push(userId);
  const loaded=await readState(db);
  assert.equal(await commitState(db,loaded.revision,{format:1,snapshot,controls:core.controls()},undefined,loaded,{id,owner:userId}),true);
  let deletes=0;
  const bucket={async get(key){return objects.has(key)?{body:objects.get(key)}:null;},async delete(key){deletes++;objects.delete(key);}};
  const env={DB:db,BUCKET:bucket,TURNFEED_SITE_SECRET:secret,TURNFEED_OPERATOR_ACCOUNT_KEYS:actor};
  const base={db,bucket,origin,secret,actor};
  const plan=()=>operatorAction({...base,action:'avatar-remove-plan',input:{userId,photoId:id,reason}});
  const photo=subject=>servePhoto(new Request(url,{headers:subject?{'oai-authenticated-user-id':subject}:{}}),env,
    async()=>{assert.fail('A profile photo is independent of thread reads');});
  const http=(pathname,subject='',body,requestOrigin=origin)=>handleOperator(new Request(origin+pathname,{
    method:body===undefined?'GET':'POST',headers:{...(subject?{'oai-authenticated-user-id':subject}:{}),
      ...(body===undefined?{}:{origin:requestOrigin,'content-type':'application/x-www-form-urlencoded'})},
    ...(body===undefined?{}:{body:new URLSearchParams(body)}),
  }),env,request=>request.text());
  return {db,base,plan,photo,http,objects,get deletes(){return deletes;}};
}

test('operator review lists canonical current avatars and rejects ambient or cross-origin authority',async t=>{
  const f=await fixture(t);
  const reports=await operatorAction({...f.base,action:'reports'});
  assert.deepEqual(reports.avatars,[{id,userId,displayName:'Alice',url,mime:'image/png'}]);
  for(const subject of ['', 'alice']) {
    assert.equal((await f.http('/operator',subject)).status,403);
    assert.equal((await f.http('/operator/avatar-remove-plan',subject,{userId,photoId:id,reason})).status,403);
  }
  assert.equal((await f.http('/operator/avatar-remove-plan','operator',{userId,photoId:id,reason},'https://other.example')).status,403);
  const page=await f.http('/operator','operator');
  assert.equal(page.status,200);
  const html=await page.text();assert.match(html,/Profile photos for review/);assert.match(html,/action="\/operator\/avatar-remove-plan"/);
  assert.ok(html.includes(url));
  const loaded=await readState(f.db);
  loaded.value.snapshot.profiles[userId].avatarUrl='https://other.example/photo.png';
  assert.equal(await commitState(f.db,loaded.revision,loaded.value,undefined,loaded),true);
  assert.deepEqual((await operatorAction({...f.base,action:'reports'})).avatars,[]);
});

test('a removal preview requires the exact current avatar and binds the operator and photo',async t=>{
  const f=await fixture(t);
  for(const input of [{userId,photoId:'c'.repeat(64),reason},{userId:actor,photoId:id,reason}]) {
    assert.equal((await operatorAction({...f.base,action:'avatar-remove-plan',input})).code,'avatar_target_unavailable');
  }
  assert.equal((await operatorAction({...f.base,action:'avatar-remove-plan',input:{userId,photoId:id,reason,extra:true}})).code,'invalid_operator_fields');
  const planned=await f.plan();
  assert.equal(planned.ok,true);
  assert.deepEqual(planned.plan.identity,{userId,displayName:'Alice'});
  assert.deepEqual(planned.plan.photo,{id,url,mime:'image/png'});
  const review=await f.http('/operator/avatar-remove-plan','operator',{userId,photoId:id,reason});
  assert.equal(review.status,200);
  const html=await review.text();assert.match(html,/Profile photo proposed for removal/);assert.match(html,/action="\/operator\/avatar-remove"/);
  assert.equal((await f.photo()).status,200,'preview does not remove the avatar');
  await assert.rejects(operatorAction({...f.base,actor:accountKey('other-operator',secret),action:'avatar-remove',token:planned.token}),{code:'operator_plan_invalid'});
  await assert.rejects(operatorAction({...f.base,action:'avatar-remove',token:planned.token+'x'}),{code:'operator_plan_invalid'});
});

test('confirmed removal clears only the current avatar, retains attributed evidence and rejects replay',async t=>{
  const f=await fixture(t),planned=await f.plan();
  const response=await f.http('/operator/avatar-remove','operator',{token:planned.token});
  assert.equal(response.status,200);assert.match(await response.text(),/Change saved/);
  const saved=(await readState(f.db)).value;
  assert.equal(saved.snapshot.profiles[userId].avatarUrl,'');
  assert.equal(saved.snapshot.profiles[userId].displayName,'Alice');
  assert.equal(saved.snapshot.profiles[userId].bio,'A public biography.');
  const evidence=saved.operator.photoEvidence[id];
  assert.equal(evidence.owner,userId);assert.equal(evidence.mime,'image/png');
  assert.equal(evidence.reason,reason);assert.equal(evidence.operatorKey,actor);
  assert.ok(Number.isFinite(Date.parse(evidence.retainedAt)));
  assert.equal((await f.photo()).status,404);
  assert.equal((await f.photo('alice')).status,404);
  assert.equal((await f.photo('operator')).status,200);
  await retireUnpublishedPhoto(f.db,f.base.bucket,id,userId,origin);
  assert.equal(f.objects.size,1);assert.equal(f.deletes,0);
  assert.equal((await operatorAction({...f.base,action:'avatar-remove',token:planned.token})).code,'operator_plan_stale');
});

test('a changed profile invalidates the removal preview without clearing its newer avatar',async t=>{
  const f=await fixture(t),planned=await f.plan(),loaded=await readState(f.db);
  const replacement=origin+photoPath('c'.repeat(64),'image/jpeg');
  loaded.value.snapshot.profiles[userId].avatarUrl=replacement;
  assert.equal(await commitState(f.db,loaded.revision,loaded.value,undefined,loaded),true);
  assert.equal((await operatorAction({...f.base,action:'avatar-remove',token:planned.token})).code,'operator_plan_stale');
  assert.equal((await readState(f.db)).value.snapshot.profiles[userId].avatarUrl,replacement);
  assert.equal(f.deletes,0);
});

test('removal and evidence retention roll back together, and retirement cannot race the ready-photo guard',async t=>{
  const f=await fixture(t),planned=await f.plan();
  f.db.failBeforeCommit=true;
  await assert.rejects(operatorAction({...f.base,action:'avatar-remove',token:planned.token}),{code:'storage_outcome_unknown'});
  f.db.failBeforeCommit=false;
  let saved=(await readState(f.db)).value;
  assert.equal(saved.snapshot.profiles[userId].avatarUrl,url);assert.equal(saved.operator,undefined);
  const batch=f.db.batch.bind(f.db);
  f.db.batch=async statements=>{
    f.db.sql.prepare("UPDATE turnfeed_photos SET status='deleting' WHERE id=?").run(id);
    return batch(statements);
  };
  assert.equal((await operatorAction({...f.base,action:'avatar-remove',token:planned.token})).code,'operator_plan_stale');
  saved=(await readState(f.db)).value;
  assert.equal(saved.snapshot.profiles[userId].avatarUrl,url);assert.equal(saved.operator,undefined);
  assert.equal(f.deletes,0);
});
