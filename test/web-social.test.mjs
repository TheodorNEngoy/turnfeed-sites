import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import { database } from './sqlite-d1.mjs';
import { dispatchMcp } from '../worker/mcp.mjs';
import { accountKey } from '../worker/identity.mjs';
import { readState } from '../worker/storage.mjs';
import worker from '../worker/index.mjs';

installModerationFixture();
const origin='https://turnfeed.example';
const secret='web-social-local-012345678901234567890123456';
const originalText='Which walking route would you recommend near the coast?';
const unescape=value=>value.replaceAll('&amp;','&');
function tokens(page,action) {
  return [...page.body.matchAll(new RegExp(`<form[^>]*action="/web/${action}"[^>]*>([\\s\\S]*?)</form>`,'g'))]
    .map(match=>match[1].match(/name="token" value="([^"]+)"/)?.[1]).filter(Boolean);
}
function token(page,action,index=0) {
  const result=tokens(page,action)[index];
  assert.ok(result,`Missing ${action} form on ${page.status}: ${page.body.slice(-700)}`);return result;
}
async function fixture(t,{handle=true,text=originalText}={}) {
  const db=database();t.after(()=>db.sql.close());
  const env={DB:db,OPENAI_API_KEY:MODERATION_KEY,TURNFEED_SITE_SECRET:secret};
  const rpc=async(subject,name,args={})=>{
    const result=await dispatchMcp(new Request(origin+'/mcp',{headers:subject?{'oai-authenticated-user-id':subject}:{}}),env,
      {method:'tools/call',params:{name,arguments:args}});
    const data=result.result?.structuredContent;
    assert.ok(data && !result.error && !result.result.isError && data.ok!==false,JSON.stringify(result));return data;
  };
  await rpc('alice','set_profile',{displayName:'Alice',...(handle?{handle:'alice'}:{}),visibility:'public'});
  await rpc('bob','set_profile',{displayName:'Bob',handle:'bob',visibility:'public'});
  const post=await rpc('alice','create_post',{text,visibility:'public',clientId:randomUUID()});
  const path='/post/'+post.postId;
  const web=async(pathname,{subject='bob',form,originHeader=origin,headers:extra={}}={})=>{
    const headers={...(subject?{'oai-authenticated-user-id':subject}:{}),...extra};
    if(form) {headers['content-type']='application/x-www-form-urlencoded';if(originHeader!==null)headers.origin=originHeader;}
    const response=await worker.fetch(new Request(origin+pathname,{method:form?'POST':'GET',headers,
      ...(form?{body:new URLSearchParams(form)}:{})}),env);
    return {status:response.status,body:await response.text(),location:response.headers.get('location')};
  };
  return {db,rpc,web,post,path,state:async()=>(await readState(db)).value.snapshot};
}

test('feed and thread post likes use the exact desired state and repeat without toggling or duplicate events',async t=>{
  const f=await fixture(t),feed=await f.web('/');
  assert.match(feed.body,/href="\/person\?handle=alice"/);
  const form={token:token(feed,'like-post')};
  for(let i=0;i<2;i++)assert.equal((await f.web('/web/like-post',{form})).status,303);
  let state=await f.state();
  assert.equal(state.posts[0].likes,1);assert.deepEqual(state.posts[0].likedBy,[accountKey('bob',secret)]);
  assert.equal(state.likeEvents.length,1);
  const page=await f.web(f.path);assert.match(page.body,/aria-label="Unlike post; 1 like"/);
  const unlike={token:token(page,'like-post')};
  for(let i=0;i<2;i++)assert.equal((await f.web('/web/like-post',{form:unlike})).status,303);
  state=await f.state();assert.equal(state.posts[0].likes,0);assert.deepEqual(state.posts[0].likedBy,[]);
  assert.equal(tokens(await f.web(f.path,{subject:''}),'like-post').length,0);
});

test('reply likes remain attached to the selected visible reply and can be undone idempotently',async t=>{
  const f=await fixture(t);
  for(const text of ['The short trail past the lighthouse is worth a visit.','The harbour path has several sheltered places to stop.']) {
    await f.rpc('alice','publish_public_reply_to_post',{...f.post.replyHandoff.targetArguments,text,visibility:'public',clientId:randomUUID()});
  }
  const page=await f.web(f.path),form={token:token(page,'like-reply',1)};
  for(let i=0;i<2;i++)assert.equal((await f.web('/web/like-reply',{form})).status,303);
  let state=await f.state();assert.equal(state.posts[0].replies[0].likes,0);assert.equal(state.posts[0].replies[1].likes,1);
  assert.equal(state.likeEvents.length,1);
  const fresh=await f.web(f.path);assert.match(fresh.body,/aria-label="Unlike reply; 1 like"/);
  const unlike={token:token(fresh,'like-reply',1)};
  for(let i=0;i<2;i++)assert.equal((await f.web('/web/like-reply',{form:unlike})).status,303);
  state=await f.state();assert.equal(state.posts[0].replies[1].likes,0);
});

test('enhanced post and reply likes return committed state and a usable undo token without navigation',async t=>{
  const f=await fixture(t);
  await f.rpc('alice','publish_public_reply_to_post',{...f.post.replyHandoff.targetArguments,text:'Try the harbour.',visibility:'public',clientId:randomUUID()});
  for (const action of ['like-post','like-reply']) {
    const original=token(await f.web(f.path),action);
    const send=token=>f.web('/web/'+action,{form:{token},headers:{accept:'application/json'}});
    const response=await send(original);
    assert.equal(response.status,200);assert.equal(response.location,null);
    const liked=JSON.parse(response.body);
    assert.equal(liked.ok,true);assert.equal(liked.liked,true);assert.equal(liked.count,1);
    assert.notEqual(liked.token,original);
    const replay=JSON.parse((await send(original)).body);
    assert.equal(replay.count,1);assert.equal(replay.liked,true);
    const undo=JSON.parse((await send(liked.token)).body);
    assert.equal(undo.liked,false);assert.equal(undo.count,0);
    assert.equal((await f.web('/web/'+action,{subject:'alice',form:{token:undo.token},headers:{accept:'application/json'}})).status,403);
    assert.equal((await f.web('/web/'+action,{originHeader:'https://elsewhere.example',form:{token:undo.token},headers:{accept:'application/json'}})).status,403);
  }
});

test('social forms require the original actor, origin, signed action and token-only fields',async t=>{
  const f=await fixture(t),form={token:token(await f.web(f.path),'like-post')};
  for(const [options,status] of [
    [{subject:''},401],[{subject:'alice'},403],[{originHeader:null},403],
    [{originHeader:'https://elsewhere.example'},403],[{headers:{'sec-fetch-site':'same-site'}},403],
    [{form:{...form,action:'unlike'}},400],[{form:{token:form.token+'x'}},403],
  ])assert.equal((await f.web('/web/like-post',{form,...options})).status,status);
  assert.equal((await f.web('/web/like-reply',{form})).status,403);
  assert.equal((await f.web('/web/follow',{form})).status,403);
  assert.equal((await f.state()).posts[0].likes,0);
});

test('changed content, changed author labels and newly blocked targets reject old like forms',async t=>{
  const f=await fixture(t),old={token:token(await f.web(f.path),'like-post')};
  const changed='Which coastal walk has the most shelter from wind?';
  await f.rpc('alice','edit_post',{targetLabel:'My coastal question',postText:originalText,text:changed});
  assert.equal((await f.web('/web/like-post',{form:old})).status,409);
  const renamed={token:token(await f.web(f.path),'like-post')};
  await f.rpc('alice','set_profile',{displayName:'Alice Walker',visibility:'public'});
  assert.equal((await f.web('/web/like-post',{form:renamed})).status,409);
  const blocked={token:token(await f.web(f.path),'like-post')};
  await f.rpc('alice','block_user',{handle:'bob',targetLabel:'Bob',action:'block'});
  assert.ok((await f.web('/web/like-post',{form:blocked})).status>=400);
  assert.equal((await f.state()).posts[0].likes,0);
});

test('public profiles follow and unfollow through native state while keeping own profile editing separate',async t=>{
  const f=await fixture(t),page=await f.web('/person?handle=alice');
  assert.equal(page.status,200);assert.match(page.body,/Follow Alice/);assert.doesNotMatch(page.body,/action="\/web\/profile"/);
  const form={token:token(page,'follow')};
  for(let i=0;i<2;i++)assert.equal((await f.web('/web/follow',{form})).status,303);
  let state=await f.state();assert.deepEqual(state.follows[accountKey('bob',secret)],[accountKey('alice',secret)]);
  assert.equal(state.followEvents.length,1);
  const native=await f.rpc('bob','open_turnfeed_feed',{targetKind:'profile',profileHandle:'alice'});
  assert.equal(native.profile.viewerFollows,true);assert.equal(native.profile.followerCount,1);
  const list=await f.web('/following');assert.match(list.body,/Unfollow Alice/);
  const unfollow={token:token(list,'follow')};
  for(let i=0;i<2;i++)assert.equal((await f.web('/web/follow',{form:unfollow})).status,303);
  state=await f.state();assert.deepEqual(state.follows[accountKey('bob',secret)],[]);
  assert.match((await f.web('/following')).body,/haven.t followed anyone/);
  assert.equal((await f.web('/person?handle=bob')).location,'/profile');
  assert.match((await f.web('/profile')).body,/action="\/web\/profile"/);
  const anonymous=await f.web('/person?handle=alice',{subject:''});
  assert.equal(anonymous.status,200);assert.equal(tokens(anonymous,'follow').length,0);assert.match(anonymous.body,/Sign in to follow/);
});

test('public profile counts open the correct follower and following lists, including signed-out readers',async t=>{
  const f=await fixture(t);
  await f.rpc('carol','set_profile',{displayName:'Carol',handle:'carol',visibility:'public'});
  await f.rpc('bob','follow_user',{handle:'alice',targetLabel:'Alice',action:'follow'});
  await f.rpc('alice','follow_user',{handle:'carol',targetLabel:'Carol',action:'follow'});
  for(const subject of ['bob','']) {
    const page=await f.web('/person?handle=alice',{subject});
    assert.match(page.body,/href="\/connections\?handle=alice&amp;kind=followers"/);
    assert.match(page.body,/href="\/connections\?handle=alice&amp;kind=following"/);
    assert.match(page.body,/data-follower-count[^>]*>1<\/a>/);
    const followers=await f.web('/connections?handle=alice&kind=followers',{subject});
    assert.equal(followers.status,200,followers.body);
    assert.match(followers.body,/>Bob<\/a>/);assert.doesNotMatch(followers.body,/>Carol<\/a>/);
    const following=await f.web('/connections?handle=alice&kind=following',{subject});
    assert.equal(following.status,200,following.body);
    assert.match(following.body,/href="\/person\?handle=carol"/);
    assert.doesNotMatch(following.body,/>Bob<\/a>/);
  }
  await f.rpc('alice','set_account_privacy',{privateAccount:true});
  // Even an existing approved follower must not gain a new private graph view.
  assert.doesNotMatch((await f.web('/person?handle=alice')).body,/href="\/connections/);
  for(const subject of ['bob',''])assert.ok((await f.web('/connections?handle=alice&kind=followers',{subject})).status>=400);
});

test('profile people links validate targets and preserve viewer-bound references',async t=>{
  const f=await fixture(t,{handle:false});
  const page=await f.web(f.path);
  const person=unescape(page.body.match(/href="(\/person\?ref=tfr_[A-Za-z0-9_-]+)"/)?.[1] || '');assert.ok(person);
  const profile=await f.web(person);
  const list=unescape(profile.body.match(/href="(\/connections\?ref=[^"]+&amp;kind=followers)"/)?.[1] || '');assert.ok(list);
  assert.equal((await f.web(list)).status,200);
  assert.ok((await f.web(list,{subject:'carol'})).status>=400);
  assert.match((await f.web(list,{subject:''})).location,/signin-with-chatgpt/);
  for(const path of ['/connections','/connections?handle=alice&handle=bob','/connections?handle=alice&ref=tfr_fake','/connections?handle=alice&kind=blocked'])assert.equal((await f.web(path)).status,400);
});

test('public people pages paginate without leaking hidden relationships or reusing another list cursor',async t=>{
  const f=await fixture(t);
  for(let i=0;i<21;i++) {
    const handle=`member_${i}`,displayName=`Member ${i}`;
    await f.rpc(handle,'set_profile',{displayName,handle,visibility:'public'});
    await f.rpc(handle,'follow_user',{handle:'alice',targetLabel:'Alice',action:'follow'});
  }
  const first=await f.web('/connections?handle=alice&kind=followers');
  assert.equal(first.status,200,first.body);assert.equal((first.body.match(/class="connection-person"/g)||[]).length,20);
  const href=unescape(first.body.match(/href="(\/connections\?[^\"]+cursor=[^\"]+)"/)?.[1] || '');assert.ok(href);
  const second=await f.web(href);assert.equal(second.status,200,second.body);assert.equal((second.body.match(/class="connection-person"/g)||[]).length,1);
  assert.ok((await f.web(href.replace('kind=followers','kind=following'))).status>=400);
  assert.ok((await f.web(href,{subject:''})).status>=400);
  await f.rpc('member_0','set_account_privacy',{privateAccount:true});
  assert.ok((await f.web(href)).status>=400);
  const refreshed=await f.web('/connections?handle=alice&kind=followers');
  assert.doesNotMatch(refreshed.body,/href="\/person\?handle=member_0"/);
});

test('handle-less profiles use viewer-bound references and follow tokens reject changed identities and blocks',async t=>{
  const f=await fixture(t,{handle:false}),page=await f.web(f.path);
  const href=unescape(page.body.match(/href="(\/person\?ref=tfr_[A-Za-z0-9_-]+)"/)?.[1] || '');
  assert.ok(href);assert.ok(!page.body.includes(accountKey('alice',secret)));
  const profile=await f.web(href);assert.equal(profile.status,200);
  const form={token:token(profile,'follow')};
  assert.ok((await f.web(href,{subject:'charlie'})).status>=400);
  assert.match((await f.web(href,{subject:''})).location,/signin-with-chatgpt/);
  await f.rpc('alice','set_profile',{displayName:'Alice Walker',visibility:'public'});
  assert.equal((await f.web('/web/follow',{form})).status,409);
  const fresh={token:token(await f.web(href),'follow')};
  await f.rpc('bob','block_user',{targetRef:JSON.parse(Buffer.from(fresh.token.split('.')[0],'base64url')).target.person.targetRef,targetLabel:'Alice Walker',action:'block'});
  assert.equal((await f.web('/web/follow',{form:fresh})).status,409);
  assert.equal(tokens(await f.web(href),'follow').length,0);
});

test('following pages retain bounded native pagination and account-bound unfollow controls',async t=>{
  const f=await fixture(t);
  for(let i=0;i<11;i++) {
    const handle=`walker_${i}`,displayName=`Walker ${i}`;
    await f.rpc('member-'+i,'set_profile',{displayName,handle,visibility:'public'});
    await f.rpc('bob','follow_user',{handle,targetLabel:displayName,action:'follow'});
  }
  const first=await f.web('/following');assert.equal(tokens(first,'follow').length,10);
  const href=unescape(first.body.match(/href="(\/following\?cursor=[^"]+)"/)?.[1] || '');assert.ok(href);
  const second=await f.web(href);assert.equal(second.status,200);assert.equal(tokens(second,'follow').length,1);
  const form={token:token(second,'follow')};
  assert.equal((await f.web('/web/follow',{subject:'alice',form})).status,403);
  const result=await f.web('/web/follow',{form});assert.equal(result.status,303);assert.equal(result.location,'/following?done=unfollowed');
  assert.equal((await f.state()).follows[accountKey('bob',secret)].length,10);
  assert.match((await f.web('/following',{subject:''})).location,/signin-with-chatgpt/);
});

test('multiline complete feed previews bind the same post as the full conversation',async t=>{
  const text=Array.from({length:10},(_,i)=>`Coastal walking note ${i+1}: bring a warm layer.`).join('\n');
  const f=await fixture(t,{text});
  const native=await f.rpc('bob','get_feed_digest',{focus:'latest',limit:4});
  assert.equal(native.items[0].previewTruncated,false);
  const feed=await f.web('/');assert.equal(tokens(feed,'like-post').length,1);
  assert.equal((await f.web('/web/like-post',{form:{token:token(feed,'like-post')}})).status,303);
  assert.match((await f.web(f.path)).body,/aria-label="Unlike post; 1 like"/);
});

test('enhanced follow returns committed counts and a working unfollow token',async t=>{
  const f=await fixture(t),page=await f.web('/person?handle=alice');
  const follow=await f.web('/web/follow',{form:{token:token(page,'follow')},headers:{accept:'application/json'}});
  assert.equal(follow.status,200,follow.body);
  const data=JSON.parse(follow.body);assert.equal(data.following,true);assert.equal(data.count,1);
  const undo=await f.web('/web/follow',{form:{token:data.token},headers:{accept:'application/json'}});
  assert.equal(undo.status,200,undo.body);assert.equal(JSON.parse(undo.body).following,false);
  assert.equal(JSON.parse(undo.body).count,0);
});

test('profile mute and block use the displayed identity and appear in People controls',async t=>{
  const f=await fixture(t),page=await f.web('/person?handle=alice');
  assert.match(page.body,/Mute or block Alice/);
  const mute=await f.web('/web/person-mute',{form:{token:token(page,'person-mute')}});
  assert.equal(mute.status,303,mute.body);assert.equal(mute.location,'/preferences?done=muted');
  let settings=await f.web('/preferences');assert.equal(tokens(settings,'unmute').length,1);
  const block=await f.web('/web/person-block',{form:{token:token(page,'person-block')}});
  assert.equal(block.status,303,block.body);assert.equal(block.location,'/preferences?done=blocked');
  settings=await f.web('/preferences');assert.equal(tokens(settings,'unblock').length,1);
  assert.doesNotMatch((await f.web('/')).body,new RegExp(originalText));
  const unblock=await f.web('/web/unblock',{form:{token:token(settings,'unblock')}});
  assert.equal(unblock.status,303,unblock.body);
});

test('profile controls reject wrong accounts, origins, altered actions and stale identities',async t=>{
  const f=await fixture(t),page=await f.web('/person?handle=alice');
  for(const action of ['person-mute','person-block']) {
    const form={token:token(page,action)};
    assert.equal((await f.web('/web/'+action,{form,subject:'alice'})).status,403);
    assert.equal((await f.web('/web/'+action,{form,originHeader:'https://unrelated.example'})).status,403);
    assert.equal((await f.web('/web/'+action,{form:{...form,targetRef:'anything'}})).status,400);
    assert.equal((await f.web('/web/'+action,{form:{token:token(page,action==='person-mute'?'person-block':'person-mute')}})).status,403);
  }
  await f.rpc('alice','set_profile',{displayName:'Alice Updated',visibility:'public'});
  for(const action of ['person-mute','person-block']) assert.equal((await f.web('/web/'+action,{form:{token:token(page,action)}})).status,409);
  const settings=await f.web('/preferences');
  assert.equal(tokens(settings,'unmute').length,0);assert.equal(tokens(settings,'unblock').length,0);
  assert.equal(tokens(await f.web('/person?handle=alice',{subject:''}),'person-block').length,0);
  assert.equal(tokens(await f.web('/profile'),'person-block').length,0);
});

test('feed defaults to Active and continuation markup preserves viewer scope',async t=>{
  const f=await fixture(t);
  for (const text of ['A local library is a wonderful place to discover an unexpected book.','Coffee outside after a walk is my favourite way to start the weekend.','Sharing a recipe helps me remember where I first learned to cook it.','A long train journey leaves plenty of time to finish a good novel.']) {
    await f.rpc('alice','create_post',{text,visibility:'public',clientId:randomUUID()});
  }
  const first=await f.web('/');
  assert.match(first.body,/href="\/\?focus=active" aria-current="page"/);
  const next=unescape(first.body.match(/data-feed-next href="([^"]+)"/)[1]);
  assert.match(next,/focus=active/);
  const second=await f.web(next);
  const scope=body=>body.match(/data-feed-viewer="([^"]+)"/)[1];
  assert.equal(scope(first.body),scope(second.body));
  assert.notEqual(scope(first.body),scope((await f.web('/',{subject:''})).body));
  const ids=body=>[...body.matchAll(/data-post-id="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids(first.body).length,4);assert.equal(ids(second.body).length,1);
  assert.equal(new Set([...ids(first.body),...ids(second.body)]).size,5);
  assert.match((await f.web('/?focus=latest')).body,/href="\/\?focus=latest" aria-current="page"/);
});
