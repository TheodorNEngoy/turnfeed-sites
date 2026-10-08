import { invoke, MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import { makeCore, catalog } from '../worker/mcp.mjs';
import { readState, commitState, MAX_DOCUMENT_BYTES } from '../worker/storage.mjs';
import worker from '../worker/index.mjs';

installModerationFixture();

const origin = 'https://turnfeed-native.example';
const secret = 'local-test-only-012345678901234567890123456789';
const postText = 'Sharing a practical lesson: keeping the first workflow small makes feedback easier to use.';
const expectedTools = ['start_turnfeed_chat','open_turnfeed_feed','open_turnfeed_inbox','explain_turnfeed_chat_mode','get_turnfeed_rules','get_feed_digest','get_thread_context','check_reply_before_publishing','set_profile','reset_me','create_post','edit_post','like_post','pin_post','delete_post','publish_public_reply_to_post','publish_public_reply_to_reply','edit_reply','like_reply','delete_reply','report_reply','report_post','follow_user','block_user','get_my_settings','update_my_settings','mute_user','export_my_data','get_my_privacy','set_account_privacy','manage_follower'];
const call = async (db, subject, name, args = {}) => invoke({ db, subject, name, args, origin, secret, callerKey: subject || 'anonymous' });
const data = response => response.result?.structuredContent;
async function profile(db, subject, name) {
  const response = await call(db, subject, 'set_profile', { displayName: name, handle: name.toLowerCase(), visibility: 'public' });
  assert.equal(data(response)?.ok, true, JSON.stringify(response));
}
async function post(db, subject, clientId = 'post-local-1', text = postText) {
  const response = await call(db, subject, 'create_post', { text, visibility: 'public', clientId });
  assert.equal(data(response)?.published, true, JSON.stringify(response));
  return data(response);
}
async function rpc(db, name, args, subject, extra = {}) {
  return worker.fetch(new Request(`${origin}/mcp`, { method: 'POST', headers: {
    'content-type': 'application/json', ...(subject ? { 'oai-authenticated-user-id': subject } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, ...extra } }) }), { DB: db, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret });
}

test('retains 24 canonical tools plus seven native settings, export and privacy tools with native annotations', () => {
  const core = makeCore({ origin, secret });
  assert.deepEqual([...core.tools.keys()], expectedTools);
  const tools = catalog(core);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool._meta.ui, undefined);
    assert.equal(tool._meta['openai/outputTemplate'], undefined);
    assert.deepEqual(tool.securitySchemes.filter(s => s.type === 'oauth2').map(s => s.scopes), [[]]);
  }
  assert.equal(tools.find(t => t.name === 'create_post').annotations.destructiveHint, true);
});

test('profile, post, same-client retry and anonymous feed survive independent core instances', async () => {
  const db = database();
  await profile(db, 'alice', 'Alicia');
  await post(db, 'alice');
  await post(db, 'alice');
  const stored = await readState(db);
  assert.equal(stored.value.snapshot.posts.length, 1);
  const response = await call(db, '', 'get_feed_digest', { focus: 'latest', limit: 4 });
  assert.match(JSON.stringify(response), /practical lesson/);
  assert.equal(JSON.stringify(response).includes('local-test-only'), false);
  assert.ok(stored.value.controls.rateState.length);
});

test('anonymous tool arguments and model metadata cannot supply account identity', async () => {
  const db = database();
  const response = await rpc(db, 'set_profile', { displayName: 'Spoof', visibility: 'public' }, '', { _meta: { 'openai/subject': 'alice' }, authInfo: { extra: { sub: 'alice' } } });
  assert.equal(response.status, 401);
  const stored = await readState(db);
  assert.equal(stored.value, null);
});

test('ownership checks reject another account editing a post', async () => {
  const db = database();
  await profile(db, 'alice', 'Alicia');
  await profile(db, 'bob', 'Bobby');
  await post(db, 'alice');
  const before = (await readState(db)).value.snapshot.posts[0];
  const response = await call(db, 'bob', 'edit_post', { targetLabel: 'Alicia’s post', postText, text: 'A different account must not be allowed to replace these words.' });
  assert.equal(data(response)?.ok, false, JSON.stringify(response));
  assert.equal((await readState(db)).value.snapshot.posts[0].text, postText);
});

test('concurrent proposals cannot overwrite the winning revision or delete its chunks', async () => {
  const db = database();
  const first = await readState(db);
  const initial = { format: 1, snapshot: { version: 19, marker: 'winner' }, controls: {} };
  assert.equal(await commitState(db, first.revision, initial), true);
  assert.equal(await commitState(db, first.revision, { ...initial, snapshot: { version: 19, marker: 'loser' } }), false);
  assert.equal((await readState(db)).value.snapshot.marker, 'winner');
  const concurrent = database();
  await Promise.all([profile(concurrent, 'alice', 'Alicia'), profile(concurrent, 'bob', 'Bobby')]);
  assert.equal(Object.keys((await readState(concurrent)).value.snapshot.profiles).length, 2);
});

test('a failed batch rolls back; a lost commit response is never automatically replayed', async () => {
  const db = database();
  await profile(db, 'alice', 'Alicia');
  const before = await readState(db);
  db.failBeforeCommit = true;
  const count = db.batchCount;
  await assert.rejects(() => post(db, 'alice'), { code: 'storage_outcome_unknown' });
  assert.equal(db.batchCount, count + 1);
  assert.equal((await readState(db)).revision, before.revision);
  db.failBeforeCommit = false;
  db.failAfterCommit = true;
  await assert.rejects(() => post(db, 'alice'), { code: 'storage_outcome_unknown' });
  db.failAfterCommit = false;
  assert.equal((await readState(db)).value.snapshot.posts.length, 1);
  await post(db, 'alice');
  assert.equal((await readState(db)).value.snapshot.posts.length, 1);
});

test('corrupt chunks and candidate capacity fail closed without losing stored data', async () => {
  const db = database();
  const state = await readState(db);
  const value = { format: 1, snapshot: { version: 19, text: '😀'.repeat(20000) }, controls: {} };
  assert.equal(await commitState(db, state.revision, value), true);
  assert.equal((await readState(db)).value.snapshot.text, value.snapshot.text);
  const saved = await readState(db);
  await assert.rejects(() => commitState(db, saved.revision, { ...value, oversized: 'x'.repeat(MAX_DOCUMENT_BYTES) }), { code: 'candidate_capacity_reached' });
  assert.equal((await readState(db)).revision, saved.revision);
  db.sql.exec("DELETE FROM turnfeed_state_records WHERE record_id = 'manifest' AND part = 0");
  await assert.rejects(() => readState(db), { code: 'storage_corrupt' });
});

test('external media is rejected without publication and the request budget persists', async () => {
  const db = database();
  await profile(db, 'alice', 'Alicia');
  const response = await call(db, 'alice', 'create_post', { text: postText, visibility: 'public', clientId: 'media-attempt-1', media: [{ type: 'image', url: 'https://example.com/image.png' }] });
  assert.equal(data(response)?.ok, false);
  const stored = await readState(db);
  assert.equal(stored.value.snapshot.posts.length, 0);
  assert.ok(stored.value.controls.rateState.some(([key]) => key.includes('create_post')));
});

test('cross-origin browser requests and write notifications are rejected', async () => {
  const db = database();
  const env = { DB: db, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret };
  const body = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'reset_me', arguments: {} } };
  const notification = await worker.fetch(new Request(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'alice' }, body: JSON.stringify(body) }), env);
  assert.equal(notification.status, 400);
  const crossOrigin = await worker.fetch(new Request(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' }, body: JSON.stringify({ ...body, id: 1 }) }), env);
  assert.equal(crossOrigin.status, 403);
});

test('social tools preserve replies, quotes, relationships, moderation, edits and deletion across requests', async () => {
  const db = database();
  await profile(db, 'alice', 'Alicia');
  await profile(db, 'bob', 'Bobby');
  await post(db, 'alice');
  const original = (await readState(db)).value.snapshot.posts[0];
  const target = { targetLabel: 'Alicia’s post about practical feedback', postText, authorHandle: 'alicia' };
  const ok = async (subject, name, args = {}) => {
    const response = await call(db, subject, name, args);
    assert.equal(data(response)?.ok, true, `${name}: ${JSON.stringify(response)}`);
    const schema = makeCore({ origin, secret }).tools.get(name).descriptor.outputSchema;
    assert.equal(schema.safeParse(data(response)).success, true, `${name}: output schema`);
    return data(response);
  };
  for (const name of ['start_turnfeed_chat', 'get_turnfeed_rules', 'explain_turnfeed_chat_mode']) await ok('', name);
  const thread = await ok('bob', 'get_thread_context', { postId: original.id });
  assert.match(JSON.stringify(thread), /practical lesson/);
  await ok('bob', 'follow_user', { handle: 'alicia', action: 'follow', targetLabel: 'Alicia' });
  await ok('bob', 'like_post', { ...target, action: 'like' });
  await ok('alice', 'pin_post', { ...target, action: 'pin' });
  await ok('bob', 'check_reply_before_publishing', { targetText: 'Alicia’s post about practical feedback', text: 'I agree that small changes help. One focused question also makes feedback more specific.' });
  const replyText = 'I agree that small changes help. One focused question also makes feedback more specific.';
  await ok('bob', 'publish_public_reply_to_post', { ...target, text: replyText, visibility: 'public', clientId: 'reply-local-1' });
  const replyTarget = { targetLabel: 'Bobby’s reply about one focused question', replyText, parentPostText: postText, replyAuthorHandle: 'bobby' };
  await ok('alice', 'publish_public_reply_to_reply', { ...replyTarget, text: 'That is useful context. I will ask a focused question in the next feedback round.', visibility: 'public', clientId: 'nested-local-1' });
  await ok('alice', 'like_reply', { ...replyTarget, action: 'like' });
  await ok('alice', 'report_reply', { ...replyTarget, reason: 'other' });
  await ok('bob', 'report_post', { ...target, reason: 'other' });
  await ok('alice', 'open_turnfeed_inbox');
  await ok('bob', 'create_post', { text: 'This lesson connects to a useful pattern: ask one specific question before changing the design.', visibility: 'public', clientId: 'quote-local-1', quotePostId: original.id, quoteTargetLabel: target.targetLabel, quoteAuthorName: 'Alicia', quoteAuthorHandle: 'alicia', quotePostText: postText, quoteCreatedAt: original.createdAt });
  const editedReply = 'I agree that small changes help. A specific question makes the feedback easier to act on.';
  await ok('bob', 'edit_reply', { ...replyTarget, text: editedReply });
  await ok('bob', 'delete_reply', { ...replyTarget, replyText: editedReply });
  const editedPost = 'A practical lesson from today: small changes and specific questions make feedback easier to use.';
  await ok('alice', 'edit_post', { ...target, text: editedPost });
  await ok('alice', 'delete_post', { ...target, postText: editedPost });
  await ok('bob', 'block_user', { handle: 'alicia', action: 'block', targetLabel: 'Alicia' });
  await ok('bob', 'block_user', { handle: 'alicia', action: 'unblock', targetLabel: 'Alicia' });
  await ok('bob', 'reset_me');
  await ok('alice', 'open_turnfeed_feed', { targetKind: 'profile', profileScope: 'self' });
});
