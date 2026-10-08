import { invoke, MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import { makeCore, catalog } from '../worker/mcp.mjs';
import { readState } from '../worker/storage.mjs';
import { accountKey } from '../worker/identity.mjs';
import worker from '../worker/index.mjs';

installModerationFixture();
const secret = 'local-native-prefs-012345678901234567890123456789';
const origin = 'https://native.example';
const text = 'A small cooking tip: soaking beans overnight makes the next evening easier.';
async function call(db, subject, name, args = {}) {
  const r = await invoke({ db, subject, name, args, origin, secret, callerKey: subject || 'anonymous' });
  if (r.result) {
    const parsed = makeCore({ origin, secret }).tools.get(name).descriptor.outputSchema.safeParse(r.result.structuredContent);
    assert.equal(parsed.success, true, `${name}: ${parsed.error}`);
  }
  return r.result?.structuredContent || r;
}
async function setup() {
  const db = database();
  for (const [id, displayName] of [['alice','Alicia'],['bob','Bobby'],['carol','Caroline']]) {
    assert.equal((await call(db,id,'set_profile',{displayName,handle:id,visibility:'public'})).ok,true);
  }
  assert.equal((await call(db,'bob','create_post',{text,visibility:'public',clientId:'native-prefs-post'})).published,true);
  return db;
}
const feed = (db, who='alice') => call(db,who,'get_feed_digest',{focus:'latest',limit:4});
const prefs = (db, who='alice', args={}) => call(db,who,'get_my_settings',args);
const update = (db,args) => call(db,'alice','update_my_settings',args);

test('private settings survive fresh requests, preserve unspecified fields and isolate accounts', async () => {
  const db=await setup();
  assert.deepEqual((await prefs(db)).settings.notificationPrefs,{likes:true,follows:true,replies:true});
  assert.equal((await update(db,{notificationPrefs:{likes:false},addHiddenWords:['Beans']})).ok,true);
  assert.equal((await update(db,{notificationPrefs:{follows:false},addHiddenWords:['spicy food']})).ok,true);
  let s=(await prefs(db)).settings;
  assert.deepEqual(s.notificationPrefs,{likes:false,follows:false,replies:true});
  assert.deepEqual(s.hiddenWords,['beans','spicy food']);
  assert.deepEqual((await prefs(db,'bob')).settings.hiddenWords,[]);
  const spoof=await call(db,'alice','get_my_settings',{userId:accountKey('bob',secret)});
  assert.equal(spoof.rpcError.code,-32602);
  const publicProfile=await call(db,'bob','open_turnfeed_feed',{targetKind:'profile',profileHandle:'alice'});
  assert.ok(!JSON.stringify(publicProfile).includes('spicy food'));
  assert.equal((await update(db,{removeHiddenWords:['BEANS']})).ok,true);
  assert.deepEqual((await prefs(db)).settings.hiddenWords,['spicy food']);
  await update(db,{clearHiddenWords:true});
  s=(await prefs(db)).settings;
  assert.deepEqual(s.hiddenWords,[]);
  assert.deepEqual(s.notificationPrefs,{likes:false,follows:false,replies:true});
});

test('original hidden-word filtering works in the native feed and restores after removal', async () => {
  const db=await setup();
  assert.equal((await feed(db)).items.length,1);
  await update(db,{addHiddenWords:['beans']});
  assert.equal((await feed(db)).items.length,0);
  assert.equal((await feed(db,'carol')).items.length,1);
  await update(db,{removeHiddenWords:['beans']});
  assert.equal((await feed(db)).items.length,1);
});

test('mute is private, preserves following, validates the named target and restores defaults', async () => {
  const db=await setup();
  const post=(await feed(db)).items[0];
  await call(db,'alice','follow_user',{handle:'bob',action:'follow',targetLabel:'Bobby'});
  const wrong=await call(db,'alice','mute_user',{handle:'bob',action:'mute',targetLabel:'Caroline'});
  assert.equal(wrong.code,'target_mismatch');
  assert.equal((await prefs(db)).settings.mutedCount,0);
  const r=await call(db,'alice','mute_user',{targetRef:post.authorTargetRef,action:'mute',targetLabel:'Bobby'});
  assert.equal(r.ok,true);
  assert.equal((await feed(db)).items.length,0);
  assert.equal((await feed(db,'carol')).items.length,1);
  const stored=(await readState(db)).value;
  assert.ok(stored.snapshot.follows[accountKey('alice',secret)].includes(accountKey('bob',secret)));
  const shown=(await prefs(db)).settings.muted[0];
  assert.equal(shown.displayName,'Bobby');
  assert.ok(!JSON.stringify(shown).includes(accountKey('bob',secret)));
  const foreign=await call(db,'carol','mute_user',{targetRef:shown.targetRef,action:'mute',targetLabel:'Bobby'});
  assert.equal(foreign.ok,false);
  const explicit=await call(db,'alice','open_turnfeed_feed',{targetKind:'profile',profileHandle:'bob'});
  assert.equal(explicit.profile.displayName,'Bobby');
  await call(db,'alice','mute_user',{targetRef:shown.targetRef,action:'unmute',targetLabel:'Bobby'});
  assert.equal((await feed(db)).items.length,1);
  assert.equal((await prefs(db)).settings.mutedCount,0);
});

test('muted-list pagination is bounded and rejects another viewer or changed list', async () => {
  const db=await setup();
  for (const [handle,targetLabel] of [['bob','Bobby'],['carol','Caroline']]) {
    await call(db,'alice','mute_user',{handle,targetLabel,action:'mute'});
  }
  const first=(await prefs(db,'alice',{mutedLimit:1})).settings;
  assert.equal(first.hasMore,true); assert.equal(first.muted.length,1);
  const second=(await prefs(db,'alice',{mutedLimit:1,cursor:first.nextCursor})).settings;
  assert.equal(second.hasMore,false); assert.equal(second.muted[0].displayName,'Caroline');
  assert.equal((await prefs(db,'bob',{mutedLimit:1,cursor:first.nextCursor})).cursorResetRequired,true);
  await call(db,'alice','mute_user',{handle:'bob',targetLabel:'Bobby',action:'unmute'});
  assert.equal((await prefs(db,'alice',{mutedLimit:1,cursor:first.nextCursor})).cursorResetRequired,true);
});

test('inbox preferences and mute take effect immediately, including rapid reversals', async () => {
  const db=await setup();
  await call(db,'bob','follow_user',{handle:'alice',targetLabel:'Alicia',action:'follow'});
  const inbox=()=>call(db,'alice','open_turnfeed_inbox');
  assert.equal((await inbox()).notifications.length,1);
  for (const follows of [false,true,false]) {
    assert.equal((await update(db,{notificationPrefs:{follows}})).ok,true);
    assert.equal((await prefs(db)).settings.notificationPrefs.follows,follows);
    assert.equal((await inbox()).notifications.length,follows ? 1 : 0);
  }
  for (const args of [{addHiddenWords:['beans']},{removeHiddenWords:['beans']},{addHiddenWords:['beans']}]) {
    await update(db,args);
    assert.equal((await feed(db)).items.length,args.addHiddenWords ? 0 : 1);
  }
  await update(db,{notificationPrefs:{follows:true},clearHiddenWords:true});
  await call(db,'alice','mute_user',{handle:'bob',targetLabel:'Bobby',action:'mute'});
  assert.equal((await inbox()).notifications.length,0);
  await call(db,'alice','mute_user',{handle:'bob',targetLabel:'Bobby',action:'unmute'});
  assert.equal((await inbox()).notifications.length,1);
});

test('settings rate limits preserve the last value and return the advertised error shape', async () => {
  const db=database();
  for (let i=0;i<20;i++) assert.equal((await update(db,{notificationPrefs:{likes:i%2===0}})).ok,true);
  const before=(await prefs(db)).settings;
  const result=await update(db,{notificationPrefs:{likes:true}});
  assert.equal(result.code,'rate_limited');
  assert.equal(result.status,429);
  assert.ok(result.retryAfterSec>0);
  assert.deepEqual((await prefs(db)).settings,before);
});

test('concurrent private changes merge; invalid or failed changes preserve saved preferences', async () => {
  const db=await setup();
  await Promise.all([update(db,{notificationPrefs:{likes:false},addHiddenWords:['beans']}),update(db,{notificationPrefs:{follows:false},addHiddenWords:['coffee']})]);
  const before=(await prefs(db)).settings;
  assert.deepEqual(before.notificationPrefs,{likes:false,follows:false,replies:true});
  assert.deepEqual([...before.hiddenWords].sort(),['beans','coffee']);
  for (const args of [{},{clearHiddenWords:true,addHiddenWords:['words']},{addHiddenWords:['new  york'],removeHiddenWords:['New York']},{addHiddenWords:['bad\nword']},{addHiddenWords:Array.from({length:32},(_,i)=>`word ${i}`)}]) {
    assert.equal((await update(db,args)).ok,false);
    assert.deepEqual((await prefs(db)).settings,before);
  }
  db.failBeforeCommit=true;
  await assert.rejects(()=>update(db,{notificationPrefs:{replies:false}}),{code:'storage_outcome_unknown'});
  db.failBeforeCommit=false;
  assert.deepEqual((await prefs(db)).settings,before);
});

test('anonymous own-profile reads use native sign-in guidance without legacy OAuth challenges', async () => {
  const db=database(), env={DB:db,OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET:secret};
  const rpc=async(name,args={})=>worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env);
  for (const [name,args] of [['get_my_settings',{}],['open_turnfeed_feed',{targetKind:'profile',profileScope:'self'}]]) {
    const r=await rpc(name,args);assert.equal(r.status,401);
    const data=await r.json();assert.match(data.error.message,/sign in with ChatGPT/i);
    assert.doesNotMatch(JSON.stringify(data),/oauth-protected-resource|turnfeed:read|Auth0/);
  }
  assert.equal((await rpc('get_feed_digest',{focus:'latest'})).status,200);
  assert.equal((await readState(db)).value,null);
});

test('catalog and rules describe the native capabilities and initial-name behavior accurately', async () => {
  const core=makeCore({origin,secret});const tools=catalog(core);
  assert.equal(tools.length,31);
  assert.equal(tools.find(t=>t.name==='create_post').inputSchema.properties.media.maxItems,0);
  for (const name of ['get_my_settings','update_my_settings','mute_user']) assert.deepEqual(tools.find(t=>t.name===name).securitySchemes,[{type:'oauth2',scopes:[]}]);
  const rules=await call(database(),'','get_turnfeed_rules');
  assert.match(rules.agentProtocol.identityDefault,/initial account name/);
  assert.match(core.instructions,/get_my_settings/);
});
