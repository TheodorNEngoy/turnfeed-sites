import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import { database } from './sqlite-d1.mjs';
import { dispatchMcp } from '../worker/mcp.mjs';
import worker from '../worker/index.mjs';

installModerationFixture();
const origin='https://turnfeed.example';
const secret='web-privacy-local-01234567890123456789012345';
function tokens(page,action) {
  return [...page.body.matchAll(new RegExp(`<form[^>]*action="/web/${action}"[^>]*>([\\s\\S]*?)</form>`,'g'))]
    .map(match=>match[1].match(/name="token" value="([^"]+)"/)?.[1]).filter(Boolean);
}
function token(page,action,index=0) { const t=tokens(page,action)[index];assert.ok(t,`Missing ${action} on ${page.status}`);return t; }
async function fixture(t) {
  const db=database();t.after(()=>db.sql.close());
  const env={DB:db,OPENAI_API_KEY:MODERATION_KEY,TURNFEED_SITE_SECRET:secret};
  const rpc=async(subject,name,args={})=>{
    const result=await dispatchMcp(new Request(origin+'/mcp',{headers:subject?{'oai-authenticated-user-id':subject}:{}}),env,
      {method:'tools/call',params:{name,arguments:args}});
    const data=result.result?.structuredContent;
    assert.ok(data && !result.error && !result.result.isError && data.ok!==false,JSON.stringify(result));return data;
  };
  for(const subject of ['alice','bob','carol']) await rpc(subject,'set_profile',{displayName:subject.toUpperCase(),handle:subject,bio:`${subject} biography`,visibility:'public'});
  const post=await rpc('alice','create_post',{text:'A quiet weekend at the cabin.',visibility:'public',clientId:randomUUID()});
  const web=async(path,{subject='alice',form,originHeader=origin,headers:extra={}}={})=>{
    const headers={...(subject?{'oai-authenticated-user-id':subject}:{}),...extra};
    if(form) {headers['content-type']='application/x-www-form-urlencoded';if(originHeader!==null)headers.origin=originHeader;}
    const response=await worker.fetch(new Request(origin+path,{method:form?'POST':'GET',headers,...(form?{body:new URLSearchParams(form)}:{})}),env);
    return {status:response.status,body:await response.text(),location:response.headers.get('location')};
  };
  return {db,rpc,web,post};
}

test('private browser accounts request approval, preserve follow-button state, grant and revoke direct-thread access',async t=>{
  const f=await fixture(t);
  assert.match((await f.web('/profile')).body,/Privacy and followers/);
  const privacy=await f.web('/privacy-settings');
  assert.equal((await f.web('/web/privacy',{form:{token:token(privacy,'privacy'),privateAccount:'true'}})).status,303);
  for(const subject of ['', 'bob']) {
    const profile=await f.web('/person?handle=alice',{subject});
    assert.equal(profile.status,200);assert.match(profile.body,/This account is private/);
    assert.doesNotMatch(profile.body,/alice biography|quiet weekend|data-follower-count/);
    assert.ok((await f.web('/post/'+f.post.postId,{subject})).status>=400);
  }
  const before=await f.web('/person?handle=alice',{subject:'bob'});
  assert.match(before.body,/Request to follow ALICE/);
  const follow=await f.web('/web/follow',{subject:'bob',form:{token:token(before,'follow')},headers:{accept:'application/json'}});
  assert.equal(follow.status,200);const result=JSON.parse(follow.body);
  assert.equal(result.following,false);assert.equal(result.requested,true);
  assert.match((await f.web('/person?handle=alice',{subject:'bob'})).body,/Cancel request/);
  assert.ok((await f.web('/post/'+f.post.postId,{subject:'bob'})).status>=400);
  const requested=await f.web('/privacy-settings');assert.match(requested.body,/BOB/);
  const accept={token:token(requested,'follower')};
  assert.equal((await f.web('/web/follower',{subject:'carol',form:accept})).status,403);
  assert.equal((await f.web('/web/follower',{form:accept})).status,303);
  assert.match((await f.web('/post/'+f.post.postId,{subject:'bob'})).body,/quiet weekend/);
  assert.match((await f.web('/person?handle=alice',{subject:'bob'})).body,/alice biography/);
  const approved=await f.web('/privacy-settings');
  assert.equal((await f.web('/web/follower',{form:{token:token(approved,'follower')}})).status,303);
  assert.ok((await f.web('/post/'+f.post.postId,{subject:'bob'})).status>=400);
  assert.notEqual((await f.web('/web/follower',{form:accept})).status,303);
  assert.equal((await f.rpc('alice','get_my_privacy')).followerCount,0);
});

test('privacy controls reject wrong identities, origins, extra fields and stale setting changes',async t=>{
  const f=await fixture(t),page=await f.web('/privacy-settings'),form={token:token(page,'privacy'),privateAccount:'true'};
  for(const options of [{subject:'bob'},{subject:''},{originHeader:null},{originHeader:'https://elsewhere.example'},{form:{...form,userId:'bob'}},{form:{...form,privateAccount:'anything'}}]) {
    assert.ok((await f.web('/web/privacy',{form,...options})).status>=400);
  }
  assert.equal((await f.rpc('alice','get_my_privacy')).privateAccount,false);
  assert.equal((await f.web('/web/privacy',{form})).status,303);
  assert.ok((await f.web('/web/privacy',{form:{...form,privateAccount:'false'}})).status>=400);
  assert.equal((await f.rpc('alice','get_my_privacy')).privateAccount,true);
  const profile=await f.web('/profile');
  assert.equal((await f.web('/web/profile',{form:{token:token(profile,'profile'),displayName:'ALICE',handle:'alice',bio:'A new biography'}})).status,303);
  assert.equal((await f.rpc('alice','get_my_privacy')).privateAccount,true);
  assert.equal((await f.web('/privacy-settings',{subject:''})).status,303);
});

test('a requester can cancel, then an old approval cannot accept the replacement request',async t=>{
  const f=await fixture(t);await f.rpc('alice','set_account_privacy',{privateAccount:true});
  const follow=async()=>f.web('/web/follow',{subject:'bob',form:{token:token(await f.web('/person?handle=alice',{subject:'bob'}),'follow')},headers:{accept:'application/json'}});
  assert.equal((await follow()).status,200);
  const oldApprove={token:token(await f.web('/privacy-settings'),'follower')};
  const canceled=JSON.parse((await follow()).body);assert.equal(canceled.requested,false);
  assert.equal((await f.rpc('alice','get_my_privacy')).requestCount,0);
  assert.equal((await follow()).status,200);
  assert.ok((await f.web('/web/follower',{form:oldApprove})).status>=400);
  assert.equal((await f.rpc('alice','get_my_privacy')).followerCount,0);
});
