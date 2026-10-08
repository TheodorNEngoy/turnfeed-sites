import { invoke } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import { readSelection, SMALL_SELECTION_BYTES } from '../worker/storage-selection.mjs';
import { digest, recordsDigest } from '../worker/storage-records.mjs';
import { makeCore, trustedContext } from '../worker/mcp.mjs';
import { accountKey } from '../worker/identity.mjs';

const secret = 'selection-test-012345678901234567890123456789';
const origin = 'https://selection.example';
const actor = accountKey('alice', secret), bob = accountKey('bob', secret), carol = accountKey('carol', secret);
const settings = (db, args = {}, extra = {}) => invoke({ db, origin, secret, subject: 'alice', callerKey: 'alice', name: 'get_my_settings', args, ...extra });
const envelope = () => ({ format: 1, snapshot: makeCore({ origin, secret }).snapshot(), controls: {}, profileNameChoices: {} });
async function store(db, value) {
  const loaded = await readState(db);
  assert.equal(await commitState(db, loaded.revision, value, { remaining: 45 }, loaded), true);
}
async function fullResult(value, args = {}) {
  const core = makeCore({ origin, secret, snapshot: value.snapshot, controls: value.controls, callerKey: 'alice' });
  return { result: await core.tools.get('get_my_settings').handler(args, trustedContext('alice')) };
}
const id = path => digest(JSON.stringify(path));
function refreshHeadDigest(db) {
  const rows = db.sql.prepare('SELECT * FROM turnfeed_state_records ORDER BY record_id, part').all();
  db.sql.prepare('UPDATE turnfeed_state_head SET digest = ?, chunks = ?, bytes = ?').run(
    recordsDigest(new Map(rows.map(row => [`${row.record_id}:${row.part}`, row]))), rows.length,
    rows.reduce((sum, row) => sum + Buffer.byteLength(row.value), 0));
}

test('settings matches the full core and retrieves much less data from a multi-megabyte store', async t => {
  const db = database(), value = envelope();
  value.snapshot.profiles[actor] = { displayName: 'Alicia', handle: 'alice' };
  value.snapshot.profiles[bob] = { displayName: 'Bobby', handle: 'bob', visibility: 'private' };
  value.snapshot.viewerStates[actor] = { notificationPrefs: { likes: false }, hiddenWords: ['BEANS', ' beans '], mutedUserIds: [bob, carol, bob] };
  for (let i = 0; i < 2400; i++) value.snapshot.profiles[`member-${i}`] = {
    displayName: `Reader ${i}`, handle: `reader${i}`, bio: 'Thoughtful conversations about books. '.repeat(14),
  };
  value.retainedEvidence = 'Retained report evidence. '.repeat(26000);
  await store(db, value);
  db.reads.length = 0;
  await readState(db);
  const fullBytes = db.reads.reduce((sum, read) => sum + read.bytes, 0);
  db.reads.length = 0;
  const batches = db.batchCount, writes = db.executed.length;
  const expected = await fullResult(value, { mutedLimit: 1 });
  const actual = await settings(db, { mutedLimit: 1 });
  assert.deepEqual(actual, expected);
  const selectedBytes = db.reads.reduce((sum, read) => sum + read.bytes, 0);
  assert.ok(selectedBytes < fullBytes * 0.4, `${selectedBytes} vs ${fullBytes}`);
  assert.equal(db.reads.length, 3);
  const fetchedIds = db.reads.filter(read => read.query.includes('json_each')).flatMap(read => JSON.parse(read.values[0]));
  assert.ok(fetchedIds.includes(id(['snapshot', 'profiles', bob])));
  assert.ok(!fetchedIds.includes(id(['snapshot', 'profiles', 'member-0'])));
  assert.ok(!fetchedIds.includes(id(['retainedEvidence'])));
  assert.equal(db.batchCount, batches);
  assert.equal(db.executed.length, writes);
  const nextArgs = { mutedLimit: 1, cursor: actual.result.structuredContent.settings.nextCursor };
  assert.deepEqual(await settings(db, nextArgs), await fullResult(value, nextArgs));
  assert.deepEqual((await readState(db)).value, value);
  t.diagnostic(JSON.stringify({ storedJsonBytes: Buffer.byteLength(JSON.stringify(value)), fullReadResultBytes: fullBytes,
    selectedReadResultBytes: selectedBytes, reductionPercent: Number((100 * (1 - selectedBytes / fullBytes)).toFixed(1)), selectedQueries: 3 }));
});

test('absent preferences and opaque parent records retain the same defaults and aliases', async () => {
  const db = database(), value = envelope();
  value.snapshot.viewerStates = null;
  value.snapshot.profiles = null;
  await store(db, value);
  assert.deepEqual(await settings(db), await fullResult(value));
  const selection = await readSelection(db);
  assert.deepEqual(await selection.project([['snapshot', 'profiles', actor], ['notPresent']]), [undefined, undefined]);
});

test('selected reads preserve initial-name writes and explicit name clears without losing unrelated data', async () => {
  const db = database(), value = envelope();
  value.retainedEvidence = 'Keep this evidence';
  await store(db, value);
  await settings(db, {}, { displayName: 'Theodor N. Engøy' });
  let loaded = await readState(db);
  assert.equal(loaded.value.snapshot.profiles[actor].displayName, 'Theodor N. Engøy');
  assert.equal(loaded.value.retainedEvidence, value.retainedEvidence);
  loaded.value.snapshot.profiles[actor].displayName = '';
  loaded.value.profileNameChoices[actor] = true;
  await store(db, loaded.value);
  const before = await readState(db), batches = db.batchCount;
  assert.equal((await settings(db, {}, { displayName: 'Name must stay cleared' })).result.structuredContent.ok, true);
  assert.equal(db.batchCount, batches);
  assert.equal((await readState(db)).revision, before.revision);
});

test('a concurrent closure between metadata and owner read is retried before settings can be served', async () => {
  const db = database(), value = envelope();
  value.retainedEvidence = 'x'.repeat(SMALL_SELECTION_BYTES); // Exercise the multi-query path.
  value.snapshot.viewerStates[actor] = { hiddenWords: ['private'] };
  await store(db, value);
  const baseline = await readState(db);
  let changed = false;
  db.beforeRead = async stmt => {
    if (changed || !stmt.query.includes('json_each')) return;
    changed = true;
    const closed = structuredClone(baseline.value);
    closed.operator = { revoked: { [actor]: { at: '2026-10-01T00:00:00Z' } }, erasures: [] };
    assert.equal(await commitState(db, baseline.revision, closed, { remaining: 45 }, baseline), true);
  };
  const output = await settings(db);
  assert.equal(output.status, 403);
  assert.ok(!JSON.stringify(output).includes('private'));
});

test('a concurrent change before member read restarts the complete projection', async () => {
  const db = database(), value = envelope();
  value.retainedEvidence = 'x'.repeat(SMALL_SELECTION_BYTES); // Exercise the multi-query path.
  value.snapshot.profiles[bob] = { displayName: 'Before' };
  value.snapshot.viewerStates[actor] = { mutedUserIds: [bob], hiddenWords: ['before'] };
  await store(db, value);
  const baseline = await readState(db);
  let reads = 0;
  db.beforeRead = async stmt => {
    if (!stmt.query.includes('json_each') || ++reads !== 2) return;
    const next = structuredClone(baseline.value);
    next.snapshot.profiles[bob].displayName = 'After';
    next.snapshot.viewerStates[actor].hiddenWords = ['after'];
    assert.equal(await commitState(db, baseline.revision, next, { remaining: 45 }, baseline), true);
  };
  const output = (await settings(db)).result.structuredContent.settings;
  assert.equal(output.muted[0].displayName, 'After');
  assert.deepEqual(output.hiddenWords, ['after']);
});

test('continuous revision conflicts stop within the read budget without a write', async () => {
  const db = database(); await store(db, { ...envelope(), retainedEvidence: 'x'.repeat(SMALL_SELECTION_BYTES) });
  const batches = db.batchCount;
  let races = 0;
  db.beforeRead = stmt => {
    if (stmt.query.includes('json_each')) db.sql.prepare('UPDATE turnfeed_state_head SET revision = ?').run(`race-${++races}`);
  };
  await assert.rejects(() => settings(db), { code: 'storage_busy' });
  assert.equal(races, 3);
  assert.equal(db.batchCount, batches);
});

test('missing referenced records, tampered selected values and malformed manifests fail closed', async () => {
  for (const scenario of ['missing-owner', 'missing-revoked', 'bad-owner', 'bad-manifest', 'missing-with-matching-index']) {
    const db = database(), value = envelope();
    value.snapshot.viewerStates[actor] = { hiddenWords: ['private'] };
    value.operator = { revoked: { [actor]: { at: 'closed' } }, erasures: [] };
    await store(db, value);
    const ownerId = id(['snapshot', 'viewerStates', actor]), revokedId = id(['operator', 'revoked', actor]);
    if (scenario === 'missing-owner' || scenario === 'missing-with-matching-index') db.sql.prepare('DELETE FROM turnfeed_state_records WHERE record_id = ?').run(ownerId);
    if (scenario === 'missing-revoked') db.sql.prepare('DELETE FROM turnfeed_state_records WHERE record_id = ?').run(revokedId);
    if (scenario === 'bad-owner') db.sql.prepare("UPDATE turnfeed_state_records SET value = '{}' WHERE record_id = ?").run(ownerId);
    if (scenario === 'bad-manifest') {
      const manifest = JSON.parse(db.sql.prepare("SELECT value FROM turnfeed_state_records WHERE record_id = 'manifest'").get().value);
      manifest.o.push(manifest.o[0]);
      const text = JSON.stringify(manifest);
      db.sql.prepare("UPDATE turnfeed_state_records SET value = ?, digest = ? WHERE record_id = 'manifest'").run(text, digest(text));
      refreshHeadDigest(db);
    }
    if (scenario === 'missing-with-matching-index') refreshHeadDigest(db);
    await assert.rejects(() => settings(db), { code: 'storage_corrupt' }, scenario);
  }
});

test('unselected payload bytes are not read; complete loads still detect their corruption', async () => {
  const db = database(), value = envelope();
  value.retainedEvidence = 'x'.repeat(SMALL_SELECTION_BYTES); // Unselected payloads stay in D1 above the threshold.
  await store(db, value);
  db.sql.prepare("UPDATE turnfeed_state_records SET value = 'bad' WHERE record_id = ?").run(id(['retainedEvidence']));
  assert.equal((await settings(db)).result.structuredContent.ok, true);
  await assert.rejects(() => readState(db), { code: 'storage_corrupt' });
});
