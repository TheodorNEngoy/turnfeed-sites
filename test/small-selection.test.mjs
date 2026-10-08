import { invoke } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import { readSelection, SMALL_SELECTION_BYTES } from '../worker/storage-selection.mjs';
import { digest, encodeRecords } from '../worker/storage-records.mjs';
import { makeCore, trustedContext } from '../worker/mcp.mjs';
import { accountKey } from '../worker/identity.mjs';

const origin = 'https://small-selection.example';
const secret = 'local-small-selection-01234567890123456789012345';
const alice = accountKey('alice', secret), bob = accountKey('bob', secret);
function fixture() {
  const snapshot = makeCore({ origin, secret }).snapshot();
  snapshot.profiles = { [alice]: { displayName: 'Alicia', handle: 'alice' },
    [bob]: { displayName: 'Bobby', handle: 'bob' } };
  snapshot.viewerStates[alice] = { hiddenWords: ['spoiler'], mutedUserIds: [bob] };
  snapshot.posts = [{ id: 'small-post', authorId: alice,
    text: 'Which book would you recommend for a quiet weekend?',
    createdAt: '2026-10-04T12:00:00Z', replies: [], likes: 0 }];
  return { format: 1, snapshot, controls: {}, profileNameChoices: {},
    retainedEvidence: 'Unrelated private evidence stays outside tool output.' };
}
async function save(db, value) {
  const loaded = await readState(db);
  assert.equal(await commitState(db, loaded.revision, value, { remaining: 45 }, loaded), true);
}
const call = (db, name, args = {}) => invoke({ db, origin, secret, subject: 'alice', callerKey: 'alice', name, args });

test('small thread and settings reads match full results with one query and no writes', async t => {
  const db = database(), value = fixture();
  await save(db, value);
  assert.ok(encodeRecords(value).bytes < SMALL_SELECTION_BYTES);
  const batches = db.batchCount, writes = db.executed.length;
  const now = Date.now;
  Date.now = () => Date.parse('2026-10-04T13:00:00Z');
  try {
    for (const [name, args] of [['get_thread_context', { postId: 'small-post' }], ['get_my_settings', {}]]) {
      db.reads.length = 0;
      const actual = await call(db, name, args);
      const core = makeCore({ origin, secret, snapshot: value.snapshot, controls: value.controls, callerKey: 'alice' });
      assert.deepEqual(actual, { result: await core.tools.get(name).handler(args, trustedContext('alice')) });
      assert.equal(db.reads.length, 1, name);
      assert.ok(!JSON.stringify(actual).includes(value.retainedEvidence));
    }
  } finally { Date.now = now; }
  assert.equal(db.batchCount, batches);
  assert.equal(db.executed.length, writes);
  t.diagnostic('Small thread and muted-settings projections each use one SELECT instead of three.');
});

test('the 64 KiB threshold includes exact-boundary multipart values and leaves larger values selective', async () => {
  for (const extra of [0, 1]) {
    const db = database(), value = fixture();
    value.retainedEvidence = '';
    const base = encodeRecords(value).bytes;
    value.retainedEvidence = 'x'.repeat(SMALL_SELECTION_BYTES - base + extra);
    assert.equal(encodeRecords(value).bytes, SMALL_SELECTION_BYTES + extra);
    await save(db, value); db.reads.length = 0;
    const selection = await readSelection(db);
    assert.deepEqual(await selection.project([['retainedEvidence']]), [value.retainedEvidence]);
    assert.equal(db.reads.length, extra === 0 ? 1 : 2);
    await selection.project([['retainedEvidence']]);
    assert.equal(db.reads.length, extra === 0 ? 1 : 2); // Request-local reuse never reloads a value.
  }
});

test('small preloaded records retain payload integrity, exact byte counts and query budgets', async () => {
  for (const scenario of ['payload', 'bytes']) {
    const db = database(); await save(db, fixture());
    if (scenario === 'payload') db.sql.prepare("UPDATE turnfeed_state_records SET value = 'bad' WHERE record_id = ?")
      .run(digest(JSON.stringify(['retainedEvidence'])));
    else db.sql.prepare('UPDATE turnfeed_state_head SET bytes = bytes + 1').run();
    await assert.rejects(() => readSelection(db), { code: 'storage_corrupt' });
  }
  const db = database(), value = fixture(); await save(db, value); db.reads.length = 0;
  await assert.rejects(() => readSelection(db, { remaining: 0 }), { code: 'storage_busy' });
  assert.equal(db.reads.length, 0);
  const budget = { remaining: 1 }, selection = await readSelection(db, budget);
  assert.deepEqual(await selection.project([[]]), [value]);
  assert.equal(budget.remaining, 0);
  assert.equal(db.reads.length, 1);
});

test('small projections stay on one snapshot and a later request sees a changed or closed account', async () => {
  const db = database(), value = fixture(); await save(db, value);
  const selection = await readSelection(db);
  const next = structuredClone(value);
  next.snapshot.profiles[alice].displayName = 'Alicia Updated';
  next.snapshot.posts[0].text = 'What is a useful habit for learning a language?';
  await save(db, next);
  assert.deepEqual(await selection.project([
    ['snapshot', 'profiles', alice, 'displayName'], ['snapshot', 'posts', ['id', 'small-post'], 'text'],
  ]), ['Alicia', value.snapshot.posts[0].text]);
  const fresh = await readSelection(db);
  assert.deepEqual(await fresh.project([['snapshot', 'profiles', alice, 'displayName']]), ['Alicia Updated']);
  next.operator = { revoked: { [alice]: { at: '2026-10-04T13:00:00Z' } }, erasures: [] };
  await save(db, next);
  assert.equal((await call(db, 'get_thread_context', { postId: 'small-post' })).status, 403);
  assert.equal((await call(db, 'get_my_settings')).status, 403);
});
