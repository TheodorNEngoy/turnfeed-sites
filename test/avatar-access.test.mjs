import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import { accountKey } from '../worker/identity.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import { photoPath, profilePhotoId, retireUnpublishedPhoto, servePhoto } from '../worker/photo-access.mjs';

const origin='https://turnfeed.example';
const secret='avatar-access-local-0123456789012345678901234';
const owner=accountKey('alice',secret), viewer=accountKey('bob',secret), id='a'.repeat(64);
const path=photoPath(id,'image/png'), url=origin+path;
const initial=()=>({format:1,snapshot:{version:19,writeReceipts:{schemaVersion:1,owners:{}},posts:[],profiles:{},blocks:{}},controls:{}});
async function save(db,change,guard) {
  const loaded=await readState(db), value=loaded.value || initial();
  change(value);
  assert.equal(await commitState(db,loaded.revision,value,undefined,loaded,guard),true);
}
async function fixture(t,{empty=false}={}) {
  const db=database(), bytes=new Uint8Array([1,2,3]), objects=new Map([[path.slice(1),bytes]]);
  t.after(()=>db.sql.close());
  db.sql.prepare(`INSERT INTO turnfeed_photos (id,owner,object_key,mime,bytes,digest,status,claim,created_at,day)
    VALUES (?,?,?,'image/png',3,?,'ready','',1,'2026-10-08')`).run(id,owner,path.slice(1),'b'.repeat(64));
  const env={DB:db,TURNFEED_SITE_SECRET:secret,TURNFEED_OPERATOR_ACCOUNT_KEYS:accountKey('operator',secret),
    BUCKET:{async get(key){return objects.has(key)?{body:objects.get(key)}:null;},async delete(key){objects.delete(key);}}};
  if(!empty) await save(db,value=>{value.snapshot.profiles[owner]={displayName:'Alice',avatarUrl:url};},{id,owner});
  const get=(subject='',method='GET')=>servePhoto(new Request(url,{method,headers:subject?{'oai-authenticated-user-id':subject}:{}}),env,
    async()=>{assert.fail('A profile avatar must not invoke a thread read or import a name');});
  return {db,env,objects,get};
}

test('profile photo IDs accept only the existing same-origin photo route',()=>{
  assert.equal(profilePhotoId({avatarUrl:url},origin),id);
  for(const avatarUrl of ['',url+'?token=x',url+'#fragment',url.replace(origin,'https://other.example'),origin+'/photos/not-an-id.png']) {
    assert.equal(profilePhotoId({avatarUrl},origin),'');
  }
  assert.equal(profilePhotoId(undefined,origin),'');
});

test('a current public avatar is readable anonymously, by its owner and other viewers, with guarded headers',async t=>{
  const f=await fixture(t);
  for(const subject of ['', 'alice', 'bob']) {
    const response=await f.get(subject);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'image/png');
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()),new Uint8Array([1,2,3]));
  }
  const head=await f.get('alice','HEAD');
  assert.equal(head.status,200);assert.equal(await head.text(),'');
});

test('either block direction denies avatar bytes; muting alone and self access do not',async t=>{
  const f=await fixture(t);
  for(const blocks of [{[owner]:[viewer]},{[viewer]:[owner]}]) {
    await save(f.db,value=>{value.snapshot.blocks=blocks;});
    assert.equal((await f.get('bob')).status,404);
    assert.equal((await f.get('alice')).status,200);
    assert.equal((await f.get()).status,200);
  }
  await save(f.db,value=>{value.snapshot.blocks={};value.snapshot.viewerStates={[viewer]:{mutedUserIds:[owner]}};});
  assert.equal((await f.get('bob')).status,200);
});

test('cleared, restricted, wrong-owner and revoked avatars are unavailable; retained evidence remains operator-only',async t=>{
  const f=await fixture(t);
  await save(f.db,value=>{value.snapshot.profiles[owner].avatarUrl='';});
  assert.equal((await f.get()).status,404);
  await save(f.db,value=>{value.snapshot.profiles[owner]={avatarUrl:url,visibility:'private'};});
  assert.equal((await f.get()).status,404);
  await save(f.db,value=>{value.snapshot.profiles={[viewer]:{avatarUrl:url}};});
  assert.equal((await f.get('bob')).status,404);
  await save(f.db,value=>{value.snapshot.profiles={[owner]:{avatarUrl:url}};value.operator={revoked:{[viewer]:{at:'now'}},erasures:[]};});
  assert.equal((await f.get('bob')).status,404);
  await save(f.db,value=>{value.operator.revoked={[owner]:{at:'now'}};});
  assert.equal((await f.get()).status,404);
  assert.equal((await f.get('alice')).status,404);
  await save(f.db,value=>{value.snapshot.profiles={};value.operator.photoEvidence={[id]:{owner,mime:'image/png'}};});
  assert.equal((await f.get()).status,404);
  assert.equal((await f.get('operator')).status,200);
});

test('retirement retains profile, post and evidence references, then clearing the last reference fences reuse',async t=>{
  const f=await fixture(t);
  const retire=()=>retireUnpublishedPhoto(f.db,f.env.BUCKET,id,owner,origin);
  await retire();assert.equal(f.objects.size,1);
  await save(f.db,value=>{value.snapshot.profiles={};value.snapshot.posts=[{id:'p1',authorId:owner,media:[{url,type:'image'}]}];});
  await retire();assert.equal(f.objects.size,1);
  await save(f.db,value=>{value.snapshot.posts=[];value.operator={photoEvidence:{[id]:{owner}}};});
  await retire();assert.equal(f.objects.size,1);
  await save(f.db,value=>{value.operator.photoEvidence={};});
  await retire();assert.equal(f.objects.size,0);
  assert.equal(f.db.sql.prepare('SELECT status FROM turnfeed_photos WHERE id=?').get(id).status,'deleted');
  const loaded=await readState(f.db);loaded.value.snapshot.profiles[owner]={avatarUrl:url};
  assert.equal(await commitState(f.db,loaded.revision,loaded.value,undefined,loaded,{id,owner}),false);
});

test('a concurrent committed avatar reference wins over retirement from an older snapshot',async t=>{
  const f=await fixture(t);
  await save(f.db,value=>{value.snapshot.profiles={};});
  const batch=f.db.batch.bind(f.db);let raced=false;
  f.db.batch=async statements=>{
    if(!raced && statements.some(statement=>statement.query.includes("UPDATE turnfeed_photos SET status = 'deleting'"))) {
      raced=true;
      await save(f.db,value=>{value.snapshot.profiles[owner]={avatarUrl:url};},{id,owner});
    }
    return batch(statements);
  };
  await retireUnpublishedPhoto(f.db,f.env.BUCKET,id,owner,origin);
  assert.equal(raced,true);assert.equal(f.objects.size,1);
  assert.equal((await f.get()).status,200);
});

test('an unused photo in an empty initial state can retire without inventing a social snapshot',async t=>{
  const f=await fixture(t,{empty:true});
  await retireUnpublishedPhoto(f.db,f.env.BUCKET,id,owner,origin);
  assert.equal(f.objects.size,0);
  assert.equal((await readState(f.db)).value,null);
  const loaded=await readState(f.db),value=initial();value.snapshot.profiles[owner]={avatarUrl:url};
  assert.equal(await commitState(f.db,loaded.revision,value,undefined,loaded,{id,owner}),false);
});

test('a first profile committed concurrently with empty-state retirement remains readable',async t=>{
  const f=await fixture(t,{empty:true}),prepare=f.db.prepare.bind(f.db);let raced=false;
  f.db.prepare=query=>{
    const statement=prepare(query);
    if(!raced && query.includes("UPDATE turnfeed_photos SET status = 'deleting'")) {
      return {...statement,bind(...values){
        const bound=statement.bind(...values);
        return {...bound,async run(){
          raced=true;f.db.prepare=prepare;
          await save(f.db,value=>{value.snapshot.profiles[owner]={avatarUrl:url};},{id,owner});
          return bound.run();
        }};
      }};
    }
    return statement;
  };
  await retireUnpublishedPhoto(f.db,f.env.BUCKET,id,owner,origin);
  assert.equal(raced,true);assert.equal(f.objects.size,1);
  assert.equal((await f.get()).status,200);
});

test('private avatar URLs require current approved access and revoke immediately after follower removal',async t=>{
  const f=await fixture(t);
  await save(f.db,value=>{value.snapshot.profiles[owner].privateAccount=true;value.snapshot.profiles[owner].followRequests=[{userId:viewer,requestId:'1'.repeat(32)}];});
  assert.equal((await f.get()).status,404);assert.equal((await f.get('bob')).status,404);
  assert.equal((await f.get('alice')).status,200);
  await save(f.db,value=>{value.snapshot.follows={[viewer]:[owner]};});
  assert.equal((await f.get('bob')).status,200);
  await save(f.db,value=>{value.snapshot.blocks={[owner]:[viewer]};});
  assert.equal((await f.get('bob')).status,404);
  await save(f.db,value=>{value.snapshot.blocks={};value.snapshot.follows={};});
  assert.equal((await f.get('bob')).status,404);
});
