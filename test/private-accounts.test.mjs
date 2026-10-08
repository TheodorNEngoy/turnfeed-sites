import test from 'node:test';
import assert from 'node:assert/strict';
import { invoke, installModerationFixture } from './moderation-fixture.mjs';
import { database } from './sqlite-d1.mjs';
import { makeCore, trustedContext } from '../worker/mcp.mjs';
import { readState } from '../worker/storage.mjs';
import { accountKey } from '../worker/identity.mjs';

installModerationFixture();
const secret = 'private-account-tests-012345678901234567890123456789';
const origin = 'https://private.example';
const postText = 'A private garden notebook: the climbing beans reached the second support today.';
async function call(db, subject, name, args = {}) {
  const output = await invoke({ db, subject, name, args, origin, secret, callerKey: subject || 'anonymous' });
  if (output.result?.structuredContent?.ok === true) {
    const parsed = makeCore({ origin, secret }).tools.get(name).descriptor.outputSchema.safeParse(output.result.structuredContent);
    assert.equal(parsed.success, true, `${name}: ${parsed.error}`);
  }
  return output.result?.structuredContent || output;
}
async function setup() {
  const db = database();
  for (const [subject, displayName] of [['alice', 'Alicia'], ['bob', 'Bobby'], ['carol', 'Caroline']]) {
    assert.equal((await call(db, subject, 'set_profile', { displayName, handle: subject, bio: `${displayName} likes growing vegetables at home.`, visibility: 'public' })).ok, true);
  }
  const created = await call(db, 'alice', 'create_post', { text: postText, visibility: 'public', clientId: 'private-source' });
  assert.equal(created.ok, true);
  return { db, postId: created.postId, created };
}
const privacy = (db, subject = 'alice', args = {}) => call(db, subject, 'get_my_privacy', args);
const change = (db, value, args = {}) => call(db, 'alice', 'set_account_privacy', { privateAccount: value, ...args });
const follow = (db, subject = 'bob', action = 'follow') => call(db, subject, 'follow_user', { handle: 'alice', targetLabel: 'Alicia', action });
const feed = (db, subject) => call(db, subject, 'get_feed_digest', { focus: 'latest' });
const profile = (db, subject, handle = 'alice') => call(db, subject, 'open_turnfeed_feed', { targetKind: 'profile', profileHandle: handle });
const manage = (db, person, action, subject = 'alice') => call(db, subject, 'manage_follower', { targetRef: person.targetRef, targetLabel: person.displayName, action, ...(person.requestId ? { requestId: person.requestId } : {}) });

test('private posts disappear from feed, search and thread; minimal profile remains discoverable', async () => {
  const { db, postId } = await setup();
  assert.equal((await change(db, true)).ok, true);
  for (const subject of ['', 'bob']) {
    assert.equal((await feed(db, subject)).items.length, 0);
    assert.equal((await call(db, subject, 'get_thread_context', { postId })).ok, false);
    const search = await call(db, subject, 'open_turnfeed_feed', { targetKind: 'feed', feedQuery: 'climbing beans' });
    assert.ok(!JSON.stringify(search).includes(postText));
    const p = await profile(db, subject);
    assert.equal(p.ok, true); assert.equal(p.profile.displayName, 'Alicia');
    assert.equal(p.profile.privateAccount, true); assert.equal(p.profile.viewerCanReadContent, false);
    assert.equal(p.profile.bio, ''); assert.equal(p.profile.avatarUrl, '');
    assert.equal(p.profile.followerCount, 0); assert.equal(p.profile.followingCount, 0);
    assert.equal(p.items.length, 0);
  }
  assert.equal((await feed(db, 'alice')).items.length, 1);
  const denied = await call(db, 'bob', 'like_post', { id: postId, action: 'like', targetLabel: 'Alicia', authorHandle: 'alice', postText });
  assert.notEqual(denied.ok, true);
});

test('pending requests grant no access, owner approves exact request, removal revokes immediately', async () => {
  const { db, postId } = await setup();
  await change(db, true);
  assert.equal((await follow(db)).ok, true);
  const state = await privacy(db);
  assert.equal(state.requestCount, 1); assert.equal(state.followerCount, 0);
  const request = state.requests[0];
  assert.equal((await profile(db, 'bob')).profile.viewerHasRequested, true);
  assert.equal((await feed(db, 'bob')).items.length, 0);
  const stored = (await readState(db)).value.snapshot;
  assert.ok(!stored.follows[accountKey('bob', secret)]?.includes(accountKey('alice', secret)));
  assert.equal((await manage(db, request, 'accept', 'carol')).ok, false);
  assert.equal((await manage(db, { ...request, displayName: 'Caroline' }, 'accept')).ok, false);
  assert.equal((await manage(db, request, 'accept')).ok, true);
  assert.equal((await call(db, 'bob', 'get_thread_context', { postId })).ok, true);
  assert.equal((await feed(db, 'bob')).items.length, 1);
  assert.equal((await privacy(db)).requestCount, 0);
  const follower = (await privacy(db)).followers[0];
  assert.equal((await manage(db, follower, 'remove')).ok, true);
  assert.equal((await call(db, 'bob', 'get_thread_context', { postId })).ok, false);
  assert.equal((await feed(db, 'bob')).items.length, 0);
});

test('old approvals reject a cancelled/resubmitted request; blocks clear pending requests', async () => {
  const { db } = await setup(); await change(db, true); await follow(db);
  const old = (await privacy(db)).requests[0];
  await follow(db, 'bob', 'unfollow'); await follow(db);
  const fresh = (await privacy(db)).requests[0];
  assert.notEqual(old.requestId, fresh.requestId);
  assert.equal((await manage(db, old, 'accept')).code, 'request_changed');
  assert.equal((await privacy(db)).requestCount, 1);
  assert.equal((await call(db, 'alice', 'block_user', { handle: 'bob', targetLabel: 'Bobby', action: 'block' })).ok, true);
  assert.equal((await privacy(db)).requestCount, 0);
  assert.equal((await manage(db, fresh, 'accept')).ok, false);
});

test('privacy changes preserve existing followers and profile edits; stale form cannot change privacy', async () => {
  const { db } = await setup(); await follow(db);
  await change(db, true, { expectedPrivateAccount: false });
  assert.equal((await feed(db, 'bob')).items.length, 1);
  assert.equal((await change(db, false, { expectedPrivateAccount: false })).code, 'privacy_changed');
  await call(db, 'alice', 'set_profile', { bio: 'A revised private garden description.', visibility: 'public' });
  assert.equal((await privacy(db)).privateAccount, true);
  assert.equal((await profile(db, 'carol')).profile.bio, '');
  await follow(db, 'carol');
  await change(db, false, { expectedPrivateAccount: true });
  assert.equal((await privacy(db)).requestCount, 0);
  assert.equal((await feed(db, 'carol')).items.length, 1);
  assert.equal((await profile(db, 'carol')).profile.viewerFollows, false);
});

test('private replies hide their descendants, activity and exported conversation context', async () => {
  const { db } = await setup();
  const publicPost = await call(db, 'bob', 'create_post', { text: 'What did your garden teach you about patience this week?', visibility: 'public', clientId: 'public-root' });
  const replyText = 'My climbing beans finally found their support after several careful adjustments.';
  const reply = await call(db, 'alice', 'publish_public_reply_to_post', { ...publicPost.replyHandoff.targetArguments, text: replyText, visibility: 'public', clientId: 'private-reply' });
  assert.equal(reply.ok, true);
  const before = await call(db, 'alice', 'get_thread_context', { postId: publicPost.postId });
  const replyItem = before.recentReplies[0];
  assert.ok(replyItem);
  const nested = await call(db, 'carol', 'publish_public_reply_to_reply', { ...replyItem.replyHandoff.targetArguments, text: 'That is a useful reminder to check supports before the stems become too heavy.', visibility: 'public', clientId: 'nested-public-reply' });
  assert.equal(nested.ok, true);
  await change(db, true);
  const after = await call(db, 'bob', 'get_thread_context', { postId: publicPost.postId });
  assert.equal(after.recentReplies.length, 0);
  const inbox = await call(db, 'bob', 'open_turnfeed_inbox');
  assert.ok(!JSON.stringify(inbox).includes(replyText));
  const full = (await readState(db)).value;
  const core = makeCore({ origin, secret, snapshot: full.snapshot, controls: full.controls });
  assert.ok(!JSON.stringify(core.accountData(accountKey('bob', secret))).includes(replyText));
});

test('existing quotes hide private sources and even approved followers cannot create new private-source quotes', async () => {
  const { db, created, postId } = await setup();
  const args = { visibility: 'public', quotePostId: postId, quoteTargetLabel: created.replyHandoff.targetArguments.targetLabel,
    quoteAuthorName: 'Alicia', quoteAuthorHandle: 'alice', quotePostText: postText, quoteCreatedAt: created.createdPost.createdAt };
  assert.equal((await call(db, 'bob', 'create_post', { ...args, text: 'This observation helped me think about where to place my own garden supports.', clientId: 'quote-before' })).ok, true);
  await follow(db); await change(db, true);
  const anonymous = await feed(db, '');
  assert.equal(anonymous.items.length, 1); assert.equal(anonymous.items[0].quote.unavailable, true);
  assert.ok(!JSON.stringify(anonymous).includes(postText));
  const rejected = await call(db, 'bob', 'create_post', { ...args, text: 'Here is another garden observation that I wanted to share with everyone.', clientId: 'quote-after' });
  assert.equal(rejected.ok, false);
});

test('privacy lists are account-bound, state-bound and bounded; anonymous actions cannot choose an identity', async () => {
  const { db } = await setup(); await follow(db); await change(db, true); await follow(db, 'carol');
  const first = await privacy(db, 'alice', { limit: 1 });
  assert.equal(first.requests.length, 1); assert.equal(first.followers.length, 0); assert.equal(first.hasMore, true);
  const second = await privacy(db, 'alice', { limit: 1, cursor: first.nextCursor });
  assert.equal(second.followers.length, 1); assert.equal(second.hasMore, false);
  assert.equal((await privacy(db, 'bob', { limit: 1, cursor: first.nextCursor })).cursorResetRequired, true);
  await manage(db, first.requests[0], 'reject');
  assert.equal((await privacy(db, 'alice', { limit: 1, cursor: first.nextCursor })).cursorResetRequired, true);
  const anonymous = await call(db, '', 'set_account_privacy', { privateAccount: true });
  assert.notEqual(anonymous.ok, true);
  const spoof = await call(db, 'bob', 'set_account_privacy', { privateAccount: true, userId: accountKey('alice', secret) });
  assert.equal(spoof.rpcError.code, -32602);
});

test('new accounts can choose privacy; reset removes pending requests and keeps other accounts private', async () => {
  const db = database();
  assert.equal((await change(db, true)).ok, true);
  assert.equal((await privacy(db)).privateAccount, true);
  await call(db, 'alice', 'set_profile', { displayName: 'Alicia', handle: 'alice', visibility: 'public' });
  await call(db, 'bob', 'set_profile', { displayName: 'Bobby', handle: 'bob', visibility: 'public' });
  await follow(db);
  assert.equal((await privacy(db)).requestCount, 1);
  assert.equal((await call(db, 'bob', 'reset_me')).ok, true);
  assert.equal((await privacy(db)).requestCount, 0);
  assert.equal((await privacy(db)).privateAccount, true);
});

test('historical report exports redact content after privacy revocation while operator evidence survives', async () => {
  const { db, created } = await setup();
  const { targetKind: _targetKind, ...target } = created.replyHandoff.targetArguments;
  assert.equal((await call(db, 'bob', 'report_post', { ...target, reason: 'other' })).ok, true);
  const quote = await call(db, 'bob', 'create_post', { visibility: 'public', quotePostId: created.postId,
    quoteTargetLabel: target.targetLabel, quoteAuthorName: 'Alicia', quoteAuthorHandle: 'alice', quotePostText: postText,
    quoteCreatedAt: created.createdPost.createdAt, text: 'This notebook is a helpful reminder to plan the garden supports early.', clientId: 'reported-quote' });
  assert.equal(quote.ok, true);
  const { targetKind: _quoteKind, ...quoteTarget } = quote.replyHandoff.targetArguments;
  assert.equal((await call(db, 'carol', 'report_post', { ...quoteTarget, reason: 'other' })).ok, true);
  let value = (await readState(db)).value;
  let core = makeCore({ origin, secret, snapshot: value.snapshot, controls: value.controls });
  assert.ok(JSON.stringify(core.accountData(accountKey('bob', secret))).includes(postText));
  await change(db, true);
  value = (await readState(db)).value;
  core = makeCore({ origin, secret, snapshot: value.snapshot, controls: value.controls });
  assert.ok(!JSON.stringify(core.accountData(accountKey('bob', secret))).includes(postText));
  assert.ok(!JSON.stringify(core.accountData(accountKey('carol', secret))).includes(postText));
  assert.ok(JSON.stringify(core.operator.reports()).includes(postText));
  const firstPage = await call(db, 'bob', 'export_my_data');
  assert.ok(!firstPage.exportPage.jsonChunk.includes(postText));
  assert.equal((await call(db, 'alice', 'delete_post', target)).ok, true);
  value = (await readState(db)).value;
  core = makeCore({ origin, secret, snapshot: value.snapshot, controls: value.controls });
  for (const subject of ['bob', 'carol']) assert.ok(!JSON.stringify(core.accountData(accountKey(subject, secret))).includes(postText));
  assert.ok(JSON.stringify(core.operator.reports()).includes(postText));
});

test('approved follows and pending requests share the outbound relationship limit', async () => {
  const { db } = await setup();
  const { snapshot } = (await readState(db)).value;
  const bob = accountKey('bob', secret), alice = accountKey('alice', secret), carol = accountKey('carol', secret);
  snapshot.follows[bob] = Array.from({ length: 1999 }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
  snapshot.profiles[alice].privateAccount = true;
  snapshot.profiles[alice].followRequests = [{ userId: bob, requestId: '1'.repeat(32) }];
  for (const privateAccount of [true, false]) {
    snapshot.profiles[carol].privateAccount = privateAccount;
    const core = makeCore({ origin, secret, snapshot: structuredClone(snapshot), callerKey: 'bob' });
    const result = await core.tools.get('follow_user').handler({ handle: 'carol', targetLabel: 'Caroline', action: 'follow' }, trustedContext('bob'));
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.code, 'follow_capacity_reached');
  }
  snapshot.profiles[alice].followRequests = [];
  snapshot.profiles[carol].privateAccount = true;
  const core = makeCore({ origin, secret, snapshot, callerKey: 'bob' });
  const result = await core.tools.get('follow_user').handler({ handle: 'carol', targetLabel: 'Caroline', action: 'follow' }, trustedContext('bob'));
  assert.equal(result.structuredContent.ok, true);
  assert.equal(core.snapshot().profiles[carol].followRequests.length, 1);
});
