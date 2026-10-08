import test from 'node:test';
import assert from 'node:assert/strict';
import { invoke } from './moderation-fixture.mjs';
import { database } from './sqlite-d1.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import { digest } from '../worker/storage-records.mjs';
import { SMALL_SELECTION_BYTES } from '../worker/storage-selection.mjs';
import { makeCore, trustedContext } from '../worker/mcp.mjs';
import { accountKey } from '../worker/identity.mjs';

const secret = 'feed-selection-012345678901234567890123456789';
const origin = 'https://feed-selection.example';
const alice = accountKey('alice', secret), bob = accountKey('bob', secret), carol = accountKey('carol', secret);
const fixedTime = Date.parse('2026-10-01T12:00:00Z');
const focuses = ['active', 'latest', 'interesting', 'needs_reply'];
const recordId = path => digest(JSON.stringify(path));
const resultBytes = db => db.reads.reduce((sum, row) => sum + row.bytes, 0);
const fetchedIds = db => db.reads.filter(row => row.query.includes('json_each')).flatMap(row => JSON.parse(row.values[0]));

function fixture() {
  const snapshot = makeCore({ origin, secret }).snapshot();
  snapshot.profiles = {
    [alice]: { displayName: 'Alicia', handle: 'alice' },
    [bob]: { displayName: 'Bobby', handle: 'bob', pinnedPostId: 'post-2' },
    [carol]: { displayName: 'Caroline', handle: 'carol' },
  };
  snapshot.posts = Array.from({ length: 7 }, (_, i) => ({
    id: `post-${i + 1}`, authorId: [alice, bob, carol][i % 3],
    text: `Reading note ${i + 1}: which detail from a favorite book stays with you?`,
    createdAt: `2026-10-01T0${i + 1}:00:00Z`, visibility: 'public', audience: { type: 'public' },
    likes: i + 1, likedBy: [bob], media: [], correctionHistory: [],
    replies: i % 2 ? [] : [{ id: `reply-${i + 1}`, authorId: carol,
      text: `The river journey in chapter ${i + 1} made the setting memorable.`,
      createdAt: `2026-10-01T${10 + i % 2}:05:00Z`, likes: 1, likedBy: [alice], replies: [] }],
  }));
  snapshot.posts[0].createdAt = '2026-09-15T07:00:00Z'; // Old root with a current conversation.
  snapshot.posts[6].createdAt = '2026-09-10T07:00:00Z';
  snapshot.posts[6].replies = [];
  snapshot.follows = { [bob]: [alice], [alice]: [bob], [carol]: [alice, bob] };
  snapshot.followEvents = [{ id: 'follow-1', actorId: bob, targetId: alice, createdAt: '2026-09-30T10:00:00Z' }];
  snapshot.likeEvents = [{ id: 'like-1', actorId: alice, targetId: bob, postId: 'post-2', createdAt: '2026-10-01T10:00:00Z' }];
  snapshot.viewerStates[carol] = { hiddenWords: ['reader preference belonging to another account'] };
  return { format: 1, snapshot, controls: {}, profileNameChoices: {} };
}
async function store(db, value) {
  const loaded = await readState(db);
  assert.equal(await commitState(db, loaded.revision, value, { remaining: 45 }, loaded), true);
}
const read = (db, subject = 'bob', args = {}, extra = {}) => invoke({ db, origin, secret, subject,
  callerKey: subject || 'anonymous', name: 'get_feed_digest', args, ...extra });
async function reference(value, subject, args) {
  const core = makeCore({ origin, secret, snapshot: structuredClone(value.snapshot),
    controls: structuredClone(value.controls), callerKey: subject || 'anonymous' });
  const entry = core.tools.get('get_feed_digest');
  return { result: await entry.handler(entry.descriptor.inputSchema.parse(args), trustedContext(subject)) };
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

test('all feed focuses retain full-core output, social state and one-SELECT small reads without writes', async () => {
  const db = database(), value = fixture(); await store(db, value);
  const before = await readState(db), batches = db.batchCount, writes = db.executed.length;
  for (const subject of ['bob', 'alice', '']) {
    for (const focus of focuses) {
      db.reads.length = 0;
      const output = await equivalent(db, value, subject, { focus, limit: 4 });
      assert.ok(output.items.length > 0);
      assert.equal(db.reads.length, 1, `${subject || 'anonymous'} ${focus}`);
      for (const item of output.items) {
        assert.equal(item.viewerHasLiked, subject ? subject === 'bob' : undefined);
        assert.ok(!Object.hasOwn(item, 'likedBy'));
      }
    }
  }
  await equivalent(db, value); // Omitted focus retains the default active window.
  assert.equal(db.batchCount, batches);
  assert.equal(db.executed.length, writes);
  const after = await readState(db);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.value, before.value);
});

test('feed pages, time filters and cursor resets match the retained reader', async () => {
  const db = database(), value = fixture(); await store(db, value);
  for (const focus of focuses) {
    const args = { focus, limit: 2 }, seen = new Set();
    let page = await equivalent(db, value, 'bob', args);
    assert.equal(page.hasMore, true);
    const cursor = page.nextCursor;
    do {
      for (const item of page.items) { assert.ok(!seen.has(item.postId)); seen.add(item.postId); }
      if (!page.hasMore) break;
      page = await equivalent(db, value, 'bob', { ...args, cursor: page.nextCursor });
    } while (seen.size < 20);
    assert.equal(page.hasMore, false);
    for (const [subject, nextArgs] of [
      ['alice', { ...args, cursor }],
      ['bob', { ...args, focus: focus === 'latest' ? 'interesting' : 'latest', cursor }],
      ['bob', { ...args, cursor: 'invalid-cursor' }],
    ]) assert.equal((await equivalent(db, value, subject, nextArgs)).cursorResetRequired, true);
  }
  for (const args of [
    { focus: 'latest', timeRange: { basis: 'created', pastHours: 8 } },
    { focus: 'active', timeRange: { basis: 'activity', pastHours: 3 } },
    { focus: 'interesting', activityWindow: 'past_24_hours' },
    { targetText: 'Show posts published in the past 8 hours' },
  ]) await equivalent(db, value, 'bob', args);
  const first = await equivalent(db, value, 'bob', { focus: 'latest', limit: 1 });
  value.snapshot.posts.pop(); await store(db, value);
  assert.equal((await equivalent(db, value, 'bob', { focus: 'latest', limit: 1, cursor: first.nextCursor })).cursorResetRequired, true);
});

test('per-viewer suppression, bidirectional blocks, archived posts and groups retain feed filtering', async () => {
  const variants = [
    ['mute author', v => { v.snapshot.viewerStates[bob] = { mutedUserIds: [alice] }; }],
    ['hidden root words', v => { v.snapshot.viewerStates[bob] = { hiddenWords: ['reading note 3'] }; }],
    ['hidden reply words', v => { v.snapshot.viewerStates[bob] = { hiddenWords: ['river journey'] }; }],
    ['viewer blocks author', v => { v.snapshot.blocks[bob] = [alice]; }],
    ['author blocks viewer', v => { v.snapshot.blocks[alice] = [bob]; }],
    ['connector blocks viewer', v => { v.snapshot.blocks[carol] = [bob]; }],
    ['hidden post', v => { v.snapshot.posts[0].hidden = true; }],
    ['hidden reply', v => { v.snapshot.posts[0].replies[0].hidden = true; }],
    ['archived', v => { v.snapshot.posts[0].archived = true; v.snapshot.posts[0].archivedAt = '2026-10-01T11:00:00Z'; }],
    ['group', v => { v.snapshot.posts[0].groupId = 'group-1'; v.snapshot.groups = [{ id: 'group-1', name: 'Readers', visibility: 'private', createdBy: alice, members: [alice, bob] }]; }],
    ['missing profiles', v => { v.snapshot.profiles = {}; }],
  ];
  for (const [label, change] of variants) {
    const db = database(), value = fixture(); change(value); await store(db, value);
    for (const subject of ['bob', 'carol', '']) {
      try { await equivalent(db, value, subject, { focus: 'interesting', limit: 4 }); }
      catch (error) { error.message = `${label}, ${subject || 'anonymous'}: ${error.message}`; throw error; }
    }
  }
});

test('quotes keep source visibility and corrections from the full snapshot', async () => {
  for (const variant of ['visible', 'hidden', 'muted', 'blocked', 'deleted']) {
    const db = database(), value = fixture(), source = value.snapshot.posts[0];
    source.correctionHistory = [{ text: 'The earlier book question.', reason: 'Clarified the question',
      startedAt: source.createdAt, correctedAt: '2026-10-01T10:00:00Z' }];
    value.snapshot.posts.push({ id: 'post-quote', authorId: carol, quotePostId: source.id,
      text: 'I noticed the same detail when rereading that book.', createdAt: '2026-10-01T11:00:00Z', replies: [] });
    if (variant === 'hidden') source.hidden = true;
    if (variant === 'muted') value.snapshot.viewerStates[bob] = { mutedUserIds: [alice] };
    if (variant === 'blocked') value.snapshot.blocks[alice] = [bob];
    if (variant === 'deleted') value.snapshot.posts.shift();
    await store(db, value);
    const output = await equivalent(db, value, 'bob', { focus: 'latest', limit: 1 });
    assert.equal(output.items[0].postId, 'post-quote');
    assert.equal(output.items[0].quote.unavailable, variant !== 'visible');
  }
});

test('a bounded evidence-heavy store fetches feed payloads while leaving unrelated records in D1', async t => {
  const db = database(), value = fixture();
  value.snapshot.posts = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(value.snapshot.posts[i % 6]),
    id: `post-load-${i}`, text: `Reading note ${i}. ` + 'A complete paragraph about a remembered setting. '.repeat(16),
    replies: [{ id: `reply-load-${i}`, authorId: carol, createdAt: '2026-10-01T10:30:00Z',
      text: 'A reader explains how the setting shapes this scene. '.repeat(12), replies: [] }] }));
  value.snapshot.writeReceipts.owners[alice] = Array.from({ length: 10000 }, (_, i) => digest(`retained-receipt-${i}`));
  value.snapshot.reports = Array.from({ length: 80 }, (_, i) => ({ id: `report-${i}`, postId: `post-removed-${i}`,
    reporterId: bob, reason: 'Stored report evidence', createdAt: '2026-09-20T10:00:00Z',
    targetSnapshot: { targetText: 'A retained source paragraph for a prior report. '.repeat(90) } }));
  value.operator = { revoked: { [carol]: { at: 'retained unrelated admission record' } },
    erasures: [{ id: 'erasure-1', at: '2026-09-01T10:00:00Z', retainedEvidence: 'An account closure receipt.' }] };
  value.controls.recentRequests = [['retained-request', { at: fixedTime, result: 'Stored response evidence.' }]];
  const jsonBytes = Buffer.byteLength(JSON.stringify(value));
  assert.ok(jsonBytes > 1_048_576 && jsonBytes < 2 * 1_048_576, `${jsonBytes} fixture bytes`);
  await store(db, value); db.reads.length = 0;
  await readState(db); const fullBytes = resultBytes(db); db.reads.length = 0;
  const batches = db.batchCount, writes = db.executed.length;
  await equivalent(db, value, 'bob', { focus: 'interesting', limit: 4 });
  const selectedBytes = resultBytes(db), ids = fetchedIds(db);
  assert.equal(db.reads.length, 2);
  assert.ok(selectedBytes < fullBytes * 0.4, `${selectedBytes} vs ${fullBytes}`);
  assert.ok(ids.includes(recordId(['snapshot', 'posts', ['id', 'post-load-99']])));
  for (const path of [
    ['snapshot', 'writeReceipts', 'owners', alice], ['snapshot', 'reports', ['id', 'report-0']],
    ['snapshot', 'viewerStates', carol], ['snapshot', 'moderationHistory', 'schemaVersion'],
    ['snapshot', 'mcpEvents', 'version'], ['operator', 'revoked', carol],
    ['operator', 'erasures', ['id', 'erasure-1']], ['controls', 'recentRequests', ['key', 'retained-request']],
  ]) {
    const id = recordId(path);
    assert.ok(db.sql.prepare('SELECT 1 FROM turnfeed_state_records WHERE record_id = ?').get(id), JSON.stringify(path));
    assert.ok(!ids.includes(id), JSON.stringify(path));
  }
  assert.equal(db.batchCount, batches); assert.equal(db.executed.length, writes);
  assert.deepEqual((await readState(db)).value, value);
  t.diagnostic(JSON.stringify({ fixtureJsonBytes: jsonBytes, fullReadResultBytes: fullBytes,
    selectedReadResultBytes: selectedBytes, reductionPercent: Number((100 * (1 - selectedBytes / fullBytes)).toFixed(1)), selectedQueries: 2 }));
});

test('concurrent closure or content change restarts the entire feed projection', async () => {
  for (const variant of ['closure', 'change']) {
    const db = database(), value = fixture(); value.retainedEvidence = 'x'.repeat(SMALL_SELECTION_BYTES);
    await store(db, value); const baseline = await readState(db); let changed = false;
    const next = structuredClone(value);
    if (variant === 'closure') next.operator = { revoked: { [bob]: { at: '2026-10-01T11:00:00Z' } }, erasures: [] };
    else {
      next.snapshot.posts[0].text = 'The updated root should be read together with the new preferences.';
      next.snapshot.viewerStates[bob] = { hiddenWords: ['updated root'] };
      next.snapshot.blocks[carol] = [bob];
    }
    db.beforeRead = async stmt => {
      if (changed || !stmt.query.includes('json_each')) return;
      changed = true;
      assert.equal(await commitState(db, baseline.revision, next, { remaining: 45 }, baseline), true);
    };
    if (variant === 'closure') assert.equal((await read(db)).status, 403);
    else await equivalent(db, next, 'bob', { focus: 'interesting', limit: 4 });
    assert.equal(changed, true);
    assert.equal(db.reads.filter(row => row.query.includes('AS kind')).length, 2);
  }
});

test('initial-name fallback preserves evidence, and an explicit name clear remains read-only', async () => {
  const db = database(), value = fixture(); delete value.snapshot.profiles[bob];
  value.retainedEvidence = 'Keep complete evidence through the fallback write.';
  value.snapshot.writeReceipts.owners[alice] = [digest('retained-write-receipt')];
  value.snapshot.reports = [{ id: 'report-retained', postId: 'post-1', reason: 'Retained report evidence.' }];
  await store(db, value);
  await read(db, 'bob', {}, { displayName: 'Bobby Reader' });
  let loaded = await readState(db);
  assert.equal(loaded.value.snapshot.profiles[bob].displayName, 'Bobby Reader');
  assert.equal(loaded.value.retainedEvidence, value.retainedEvidence);
  assert.deepEqual(loaded.value.snapshot.writeReceipts, value.snapshot.writeReceipts);
  assert.deepEqual(loaded.value.snapshot.reports, value.snapshot.reports);
  loaded.value.snapshot.profiles[bob].displayName = ''; loaded.value.profileNameChoices[bob] = true;
  await store(db, loaded.value);
  const batches = db.batchCount;
  await read(db, 'bob', {}, { displayName: 'Must remain cleared' });
  assert.equal(db.batchCount, batches);
  assert.equal((await readState(db)).value.snapshot.profiles[bob].displayName, '');
});

test('legacy feed reads keep the complete migration path and preserve unrelated evidence', async () => {
  const db = database(), value = fixture();
  value.retainedEvidence = 'Retained legacy report evidence.';
  const json = JSON.stringify(value);
  db.sql.prepare('INSERT INTO turnfeed_state_head (id, revision, digest, chunks, bytes) VALUES (1, ?, ?, 1, ?)')
    .run('legacy', digest(json), Buffer.byteLength(json));
  db.sql.prepare('INSERT INTO turnfeed_state_chunks VALUES (?, 0, ?)').run('legacy', json);
  await equivalent(db, value, 'bob', { focus: 'latest', limit: 4 });
  assert.ok(db.reads.some(row => row.query.includes('turnfeed_state_chunks')));
  const loaded = await readState(db);
  assert.equal(loaded.storageFormat, 2);
  assert.deepEqual(loaded.value, value);
});
