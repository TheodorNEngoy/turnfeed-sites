import { invoke } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import { digest } from '../worker/storage-records.mjs';
import { SMALL_SELECTION_BYTES } from '../worker/storage-selection.mjs';
import { makeCore, trustedContext } from '../worker/mcp.mjs';
import { accountKey } from '../worker/identity.mjs';

const secret = 'thread-selection-012345678901234567890123456789';
const origin = 'https://thread-selection.example';
const alice = accountKey('alice', secret), bob = accountKey('bob', secret), carol = accountKey('carol', secret);
const fixedTime = Date.parse('2026-10-01T12:00:00Z');
function fixture() {
  const snapshot = makeCore({ origin, secret }).snapshot();
  snapshot.profiles = {
    [alice]: { displayName: 'Alicia', handle: 'alice' },
    [bob]: { displayName: 'Bobby', handle: 'bob' },
    [carol]: { displayName: '', handle: 'tf_generated' },
  };
  snapshot.posts = [{ id: 'post-1', authorId: alice, text: 'Which book would you happily read twice?',
    createdAt: '2026-10-01T10:00:00Z', visibility: 'public', audience: { type: 'public' },
    likes: 2, likedBy: [bob], media: [], correctionHistory: [], replies: [
      { id: 'reply-2', authorId: bob, text: 'I would read a good travel memoir again.', likes: 1, likedBy: [alice],
        createdAt: '2026-10-01T10:02:00Z', replies: [] },
      { id: 'reply-1', authorId: bob, text: 'A short novel is a useful choice for revisiting.', likes: 0,
        createdAt: '2026-10-01T10:02:00Z', replies: [
          { id: 'reply-3', authorId: carol, text: 'The details become clearer on the second reading.',
            createdAt: '2026-10-01T10:03:00Z', likes: 3, likedBy: [bob], replies: [] },
        ] },
    ] }];
  return { format: 1, snapshot, controls: {}, profileNameChoices: {} };
}
async function store(db, value) {
  const loaded = await readState(db);
  assert.equal(await commitState(db, loaded.revision, value, { remaining: 45 }, loaded), true);
}
const read = (db, subject = 'bob', args = {}, extra = {}) => invoke({ db, origin, secret, subject,
  callerKey: subject || 'anonymous', name: 'get_thread_context', args: { postId: 'post-1', ...args }, ...extra });
async function reference(value, subject = 'bob', args = {}) {
  const core = makeCore({ origin, secret, snapshot: value.snapshot, controls: value.controls, callerKey: subject || 'anonymous' });
  return { result: await core.tools.get('get_thread_context').handler({ postId: 'post-1', ...args }, trustedContext(subject)) };
}
async function equivalent(db, value, subject = 'bob', args = {}) {
  const now = Date.now;
  Date.now = () => fixedTime;
  try {
    const actual = await read(db, subject, args);
    assert.deepEqual(actual, await reference(value, subject, args));
    return actual.result.structuredContent;
  } finally { Date.now = now; }
}
const payloadQueries = db => db.reads.filter(row => row.query.includes('json_each'));

test('ordinary thread reads match complete results while leaving unrelated post bodies in D1', async t => {
  const db = database(), value = fixture();
  for (let i = 0; i < 500; i++) {
    const authorId = `other-${i}`;
    value.snapshot.profiles[authorId] = { displayName: `Other reader ${i}`, handle: `reader${i}`, bio: 'Books and reading. '.repeat(25) };
    value.snapshot.posts.push({ id: `post-extra-${i}`, authorId, text: 'A specific detail from a favorite book. '.repeat(65),
      createdAt: '2026-09-01T00:00:00Z', replies: [], likes: 0 });
    value.snapshot.follows[authorId] = [alice, bob];
  }
  value.retainedEvidence = 'Retained safety evidence. '.repeat(24000);
  await store(db, value);
  db.reads.length = 0;
  await readState(db);
  const fullBytes = db.reads.reduce((sum, row) => sum + row.bytes, 0);
  db.reads.length = 0;
  const batches = db.batchCount, writes = db.executed.length;
  const output = await equivalent(db, value);
  assert.equal(output.totalReplyCount, 3);
  assert.equal(output.thread.viewerHasLiked, true);
  assert.equal(db.batchCount, batches);
  assert.equal(db.executed.length, writes);
  const selectedBytes = db.reads.reduce((sum, row) => sum + row.bytes, 0);
  assert.ok(selectedBytes < fullBytes * 0.4);
  assert.equal(db.reads.length, 3);
  const ids = payloadQueries(db).flatMap(row => JSON.parse(row.values[0]));
  assert.ok(ids.includes(digest(JSON.stringify(['snapshot', 'posts', ['id', 'post-1']]))));
  assert.ok(!ids.includes(digest(JSON.stringify(['snapshot', 'posts', ['id', 'post-extra-0']]))));
  assert.ok(!ids.includes(digest(JSON.stringify(['retainedEvidence']))));
  t.diagnostic(JSON.stringify({ fixtureJsonBytes: Buffer.byteLength(JSON.stringify(value)),
    fullReadResultBytes: fullBytes, selectedReadResultBytes: selectedBytes,
    reductionPercent: Number((100 * (1 - selectedBytes / fullBytes)).toFixed(1)), selectedQueries: db.reads.length }));
});

test('thread identities, bidirectional blocks, mute and hidden-word subtree filtering match the retained reader', async () => {
  const variants = [
    ['anonymous', '', () => {}], ['owner', 'alice', () => {}], ['other', 'carol', () => {}],
    ['missing profiles', 'bob', v => { v.snapshot.profiles = {}; }],
    ['root blocked by viewer', 'bob', v => { v.snapshot.blocks[bob] = [alice]; }],
    ['root blocks viewer', 'bob', v => { v.snapshot.blocks[alice] = [bob]; }],
    ['reply blocked by viewer', 'alice', v => { v.snapshot.blocks[alice] = [bob]; }],
    ['reply blocks viewer', 'alice', v => { v.snapshot.blocks[bob] = [alice]; }],
    ['muted reply', 'alice', v => { v.snapshot.viewerStates[alice] = { mutedUserIds: [bob] }; }],
    ['hidden word parent', 'alice', v => { v.snapshot.viewerStates[alice] = { hiddenWords: ['short novel'] }; }],
    ['hidden word root', 'alice', v => { v.snapshot.viewerStates[alice] = { hiddenWords: ['read twice'] }; }],
    ['hidden parent', 'alice', v => { v.snapshot.posts[0].replies[1].hidden = true; }],
    ['deleted subtree', 'alice', v => { v.snapshot.posts[0].replies.pop(); }],
    ['hidden own root', 'alice', v => { v.snapshot.posts[0].hidden = true; }],
  ];
  for (const [label, subject, change] of variants) {
    const db = database(), value = fixture(); change(value); await store(db, value);
    const revision = (await readState(db)).revision;
    try { await equivalent(db, value, subject); } catch (error) { error.message = `${label}: ${error.message}`; throw error; }
    assert.equal((await readState(db)).revision, revision, label);
  }
});

test('conversation ordering and continuation remain identical across pages, viewers and changed reply trees', async () => {
  const db = database(), value = fixture(); await store(db, value);
  const first = await equivalent(db, value, 'alice', { limit: 1 });
  assert.equal(first.recentReplies[0].text, value.snapshot.posts[0].replies[1].text);
  assert.equal(first.hasMore, true);
  const secondArgs = { limit: 1, cursor: first.nextCursor };
  const second = await equivalent(db, value, 'alice', secondArgs);
  assert.equal(second.recentReplies[0].text, value.snapshot.posts[0].replies[1].replies[0].text);
  assert.match((await equivalent(db, value, 'bob', secondArgs)).displayText, /thread changed/i);
  value.snapshot.posts[0].replies.pop(); await store(db, value);
  assert.match((await equivalent(db, value, 'alice', secondArgs)).displayText, /thread changed/i);
});

test('correction history, archived threads, reply-depth handoffs and large full bodies retain their output', async () => {
  for (const variant of ['corrections', 'archived', 'deep', 'large']) {
    const db = database(), value = fixture(), post = value.snapshot.posts[0];
    if (variant === 'corrections') {
      post.correctionHistory = [{ text: 'An earlier question about books.', reason: 'Made the question clearer', startedAt: post.createdAt, correctedAt: '2026-10-01T10:05:00Z' }];
      post.replies[0].correctionHistory = [{ text: 'An earlier reply.', reason: 'Clarified the recommendation', startedAt: post.replies[0].createdAt, correctedAt: '2026-10-01T10:06:00Z' }];
    }
    if (variant === 'archived') { post.archivedAt = '2026-10-01T11:00:00Z'; post.archived = true; }
    if (variant === 'deep') {
      let reply = post.replies[0];
      for (let i = 0; i < 12; i++) {
        reply.replies = [{ id: `reply-depth-${i}`, authorId: i % 2 ? alice : bob,
          text: `Another observation about the book, number ${i}.`, createdAt: '2026-10-01T10:10:00Z', replies: [] }];
        reply = reply.replies[0];
      }
    }
    if (variant === 'large') {
      post.text = 'A long book question with complete paragraphs.\n'.repeat(25);
      post.replies = Array.from({ length: 80 }, (_, i) => ({ id: `reply-long-${i}`, authorId: bob,
        text: 'A detailed reply that should retain its entire text.\n'.repeat(11), createdAt: '2026-10-01T10:05:00Z', replies: [] }));
    }
    await store(db, value);
    const output = await equivalent(db, value, 'alice', { limit: 6 });
    if (variant === 'corrections') {
      assert.equal(output.thread.correctionHistory.length, 1);
      assert.ok(output.recentReplies.some(reply => reply.correctionHistory.length === 1));
    }
    if (variant === 'archived') { assert.equal(output.thread.archived, true); assert.equal(output.replyHandoff, undefined); }
    if (variant === 'large') assert.equal(output.recentReplies[0].text, post.replies[0].text);
  }
});

test('quotes, groups, non-public targets, ambiguous IDs and missing targets retain the complete-read fallback', async () => {
  for (const variant of ['quote', 'group', 'non-public', 'duplicate', 'missing']) {
    const db = database(), value = fixture(), post = value.snapshot.posts[0];
    if (variant === 'quote') { post.quotePostId = 'post-source'; value.snapshot.posts.push({ ...structuredClone(post), id: 'post-source', quotePostId: '', text: 'This is the original quoted thought.', replies: [] }); }
    if (variant === 'group') post.groupId = 'group-1';
    if (variant === 'non-public') post.audience.type = 'followers';
    if (variant === 'duplicate') value.snapshot.posts.push({ ...structuredClone(post), text: 'The second duplicate must not replace the first.' });
    if (variant === 'missing') value.snapshot.posts = [];
    await store(db, value); db.reads.length = 0;
    await equivalent(db, value);
    assert.ok(db.reads.some(row => row.query.includes('turnfeed_state_chunks')), variant);
  }
});

test('name initialization uses the complete baseline and explicit name clears preserve the selected read', async () => {
  const db = database(), value = fixture(); delete value.snapshot.profiles[bob];
  value.retainedEvidence = 'Must survive a fallback write'; await store(db, value);
  await read(db, 'bob', {}, { displayName: 'Bobby Reader' });
  let loaded = await readState(db);
  assert.equal(loaded.value.snapshot.profiles[bob].displayName, 'Bobby Reader');
  assert.equal(loaded.value.retainedEvidence, value.retainedEvidence);
  loaded.value.snapshot.profiles[bob].displayName = ''; loaded.value.profileNameChoices[bob] = true;
  await store(db, loaded.value);
  const batches = db.batchCount;
  await read(db, 'bob', {}, { displayName: 'Must stay cleared' });
  assert.equal(db.batchCount, batches);
  assert.equal((await readState(db)).value.snapshot.profiles[bob].displayName, '');
});

test('participant-read races restart and honor a new block or closed account before returning content', async () => {
  for (const variant of ['block', 'closure']) {
    const db = database(), value = fixture();
    value.retainedEvidence = 'x'.repeat(SMALL_SELECTION_BYTES); // Exercise the multi-query path.
    await store(db, value);
    const baseline = await readState(db); let reads = 0;
    db.beforeRead = async stmt => {
      if (!stmt.query.includes('json_each') || ++reads !== 2) return;
      const changed = structuredClone(baseline.value);
      if (variant === 'block') changed.snapshot.blocks[alice] = [bob];
      else changed.operator = { revoked: { [bob]: { at: '2026-10-01T11:00:00Z' } }, erasures: [] };
      assert.equal(await commitState(db, baseline.revision, changed, { remaining: 45 }, baseline), true);
    };
    const output = await read(db);
    if (variant === 'closure') assert.equal(output.status, 403);
    else assert.equal(output.result.structuredContent.ok, false);
    assert.ok(!JSON.stringify(output).includes('Which book'));
  }
});

test('selected post and participant corruption fail closed; ordinary reads never commit projected state', async () => {
  for (const path of [['snapshot', 'posts', ['id', 'post-1']], ['snapshot', 'profiles', alice]]) {
    const db = database(), value = fixture(); await store(db, value);
    const batches = db.batchCount;
    db.sql.prepare("UPDATE turnfeed_state_records SET value = 'bad' WHERE record_id = ?").run(digest(JSON.stringify(path)));
    await assert.rejects(() => read(db), { code: 'storage_corrupt' });
    assert.equal(db.batchCount, batches);
  }
});
