import { invoke, MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from './sqlite-d1.mjs';
import { dispatchMcp, makeCore } from '../worker/mcp.mjs';
import { accountKey } from '../worker/identity.mjs';
import { operatorAction, verifyPlan } from '../worker/operator.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import worker from '../worker/index.mjs';

installModerationFixture();

const origin='https://native.example';
const secret='local-operator-test-012345678901234567890123456789';
const actor=accountKey('operator',secret);
const subject='member';
const userId=accountKey(subject,secret);
const postText='A practical note: careful review helps keep shared conversations useful.';
const call=(db,subject,name,args={})=>invoke({db,subject,name,args,origin,secret,callerKey:subject});
test('operator setup exposes only the verified own key and disappears when disabled',async()=>{
  const db=database();
  const request=new Request(origin+'/mcp',{headers:{'oai-authenticated-user-id':'operator'}});
  const body={method:'tools/call',params:{name:'open_turnfeed_feed',arguments:{targetKind:'profile',profileScope:'self'}}};
  const env={DB:db,OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET:secret};
  const disabled=await dispatchMcp(request,env,body);
  assert.equal(disabled.result.structuredContent.turnfeedSitesAccountKey,undefined);
  const enabled=await dispatchMcp(request,{...env,TURNFEED_OPERATOR_SETUP:'1'},body);
  assert.equal(enabled.result.structuredContent.turnfeedSitesAccountKey,actor);
  assert.equal(makeCore({origin,secret}).tools.get('open_turnfeed_feed').descriptor.outputSchema.safeParse(enabled.result.structuredContent).success,true);
});
async function setup() {
  const db=database();
  const result=await call(db,subject,'create_post',{text:postText,visibility:'public',clientId:'operator-test-post'});
  assert.equal(result.result.structuredContent.published,true);
  return {db,origin,secret,actor};
}
async function visibilityPlan(base,hide=true) {
  const state=await readState(base.db);
  const post=state.value.snapshot.posts[0];
  const result=await operatorAction({...base,action:'visibility-plan',input:{targetType:'post',targetId:post.id,hide,
    reason:'Reviewed against the community rules.',targetCreatedAt:post.createdAt,parentCreatedAt:'',expectedHidden:String(Boolean(post.hidden)),requestId:randomUUID()}});
  assert.equal(result.ok,true,JSON.stringify(result));
  return result;
}

test('operators use an explicit verified identity, with no ambient signed-in privilege',async()=>{
  const {db}=await setup();
  const env={DB:db,OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET:secret,TURNFEED_OPERATOR_ACCOUNT_KEYS:actor};
  for(const id of ['',subject]) {
    const r=await worker.fetch(new Request(origin+'/operator',{headers:id?{'oai-authenticated-user-id':id}:{}}),env);
    assert.equal(r.status,403);
  }
  const r=await worker.fetch(new Request(origin+'/operator',{headers:{'oai-authenticated-user-id':'operator'}}),env);
  assert.equal(r.status,200);
  assert.match(await r.text(),/Moderation and account requests/);
  const cross=await worker.fetch(new Request(origin+'/operator/visibility-plan',{method:'POST',headers:{'oai-authenticated-user-id':'operator','content-type':'application/x-www-form-urlencoded',origin:'https://untrusted.example'},body:'hide=true'}),env);
  assert.equal(cross.status,403);
});

test('hide and restore preserve moderation history with verified Sites actor attribution',async()=>{
  const base=await setup();
  const plan=await visibilityPlan(base);
  assert.equal((await operatorAction({...base,action:'visibility',token:plan.token})).ok,true);
  const hidden=await readState(base.db);
  assert.equal(hidden.value.snapshot.posts[0].hidden,true);
  assert.equal(hidden.value.snapshot.moderationHistory.events[0].actor.operatorKey,actor);
  const feed=await call(base.db,'','get_feed_digest');
  assert.equal(feed.result.structuredContent.items.length,0);
  const restore=await visibilityPlan(base,false);
  assert.equal((await operatorAction({...base,action:'visibility',token:restore.token})).ok,true);
  assert.equal((await readState(base.db)).value.snapshot.moderationHistory.events.length,2);
});

test('plans bind the operator, operation, expiry and exact state',async()=>{
  const base=await setup();
  const plan=await visibilityPlan(base);
  assert.throws(()=>verifyPlan(plan.token,secret,userId,'visibility'),{code:'operator_plan_invalid'});
  assert.throws(()=>verifyPlan(plan.token,secret,actor,'erasure'),{code:'operator_plan_invalid'});
  assert.throws(()=>verifyPlan(plan.token,secret,actor,'visibility',plan.plan.expiresAt),{code:'operator_plan_invalid'});
  await call(base.db,subject,'set_profile',{displayName:'Member',visibility:'public'});
  const result=await operatorAction({...base,action:'visibility',token:plan.token});
  assert.equal(result.code,'operator_plan_stale');
  assert.equal(Boolean((await readState(base.db)).value.snapshot.posts[0].hidden),false);
});

test('erasure closes default-only accounts, purges owned controls, preserves evidence and blocks stale connections',async()=>{
  const base=await setup();
  await call(base.db,'reporter','report_post',{targetLabel:'The practical note',postText,reason:'other'});
  await call(base.db,subject,'edit_post',{targetLabel:'My practical note',postText,text:'An updated practical note: careful review helps keep conversations useful.'});
  let saved=await readState(base.db);
  assert.equal(saved.value.controls.recentRequests.some(([key])=>key.includes('updated practical note')),false);
  // Model a retained confirmation and another account's independently owned guard.
  saved.value.controls.publicWriteConfirmationClaims.push(['own',{ownerKey:JSON.stringify([userId,'oauth-user:'+userId]),expiresAt:Date.now()+600000,status:'consumed'}]);
  saved.value.controls.publicWriteConfirmationClaims.push(['other',{ownerKey:JSON.stringify([actor,'oauth-user:'+actor]),expiresAt:Date.now()+600000,status:'consumed'}]);
  assert.equal(await commitState(base.db,saved.revision,saved.value),true);
  saved=await readState(base.db);
  const plan=await operatorAction({...base,action:'erasure-plan',input:{userId,caseId:'privacy-1',retainedRecordsReason:'Retain report evidence, other members’ safety boundaries, and the minimal operation receipt.'}});
  assert.equal(plan.ok,true,JSON.stringify(plan));
  const wrong=await operatorAction({...base,action:'erasure',token:plan.token,confirmation:'yes'});
  assert.equal(wrong.code,'exact_confirmation_required');
  const result=await operatorAction({...base,action:'erasure',token:plan.token,confirmation:plan.plan.confirmation});
  assert.equal(result.ok,true,JSON.stringify(result));
  const after=await readState(base.db);
  assert.equal(after.value.snapshot.posts.length,0);
  assert.equal(after.value.snapshot.profiles[userId],undefined);
  assert.equal(after.value.snapshot.users.includes(userId),false);
  assert.equal(after.value.snapshot.nextPostId,saved.value.snapshot.nextPostId);
  assert.equal(after.value.snapshot.reports.length,1);
  assert.equal(after.value.controls.publicWriteConfirmationClaims.some(([key])=>key==='own'),false);
  assert.equal(after.value.controls.publicWriteConfirmationClaims.some(([key])=>key==='other'),true);
  assert.equal(after.value.operator.erasures.length,1);
  const evidencePage=await worker.fetch(new Request(origin+'/operator',{headers:{'oai-authenticated-user-id':'operator'}}),
    {DB:base.db,OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET:secret,TURNFEED_OPERATOR_ACCOUNT_KEYS:actor});
  const evidenceHtml=await evidencePage.text();
  assert.match(evidenceHtml,/Full report evidence/);
  assert.match(evidenceHtml,/targetSnapshot/);
  assert.ok(evidenceHtml.includes(postText));
  const attempt=await call(base.db,subject,'create_post',{text:'An old connection must not recreate this account after erasure.',visibility:'public',clientId:'blocked-post'});
  assert.equal(attempt.status,403);
  assert.equal(await commitState(base.db,saved.revision,saved.value),false);
  assert.equal((await readState(base.db)).value.snapshot.posts.length,0);
});

test('an erased operator loses both read and write access despite a retained env allowlist',async()=>{
  const base=await setup();
  await call(base.db,'operator','set_profile',{displayName:'Operator',visibility:'public'});
  const plan=await operatorAction({...base,action:'erasure-plan',input:{userId:actor,caseId:'operator-closure',retainedRecordsReason:'Keep the minimal operation receipt.'}});
  assert.equal(plan.ok,true);
  assert.equal((await operatorAction({...base,action:'erasure',token:plan.token,confirmation:plan.plan.confirmation})).ok,true);
  const env={DB:base.db,OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET:secret,TURNFEED_OPERATOR_ACCOUNT_KEYS:actor};
  for (const method of ['GET','POST']) {
    const r=await worker.fetch(new Request(origin+(method==='GET'?'/operator':'/operator/visibility-plan'),{
      method,headers:{'oai-authenticated-user-id':'operator',origin,'content-type':'application/x-www-form-urlencoded'},
      ...(method==='POST'?{body:'hide=true'}:{})}),env);
    assert.equal(r.status,403);
    assert.equal((await r.json()).code,'account_closed');
  }
});

test('erasure and its access block and journal are failure-atomic',async()=>{
  const base=await setup();
  const plan=await operatorAction({...base,action:'erasure-plan',input:{userId,caseId:'privacy-2',retainedRecordsReason:'Retain necessary moderation records.'}});
  base.db.failBeforeCommit=true;
  await assert.rejects(()=>operatorAction({...base,action:'erasure',token:plan.token,confirmation:plan.plan.confirmation}),{code:'storage_outcome_unknown'});
  const state=await readState(base.db);
  assert.equal(state.value.snapshot.posts.length,1);
  assert.equal(state.value.operator,undefined);
});
