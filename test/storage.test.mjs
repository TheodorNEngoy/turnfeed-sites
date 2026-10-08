import { invoke } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { database } from './sqlite-d1.mjs';
import { readState, commitState, MAX_DOCUMENT_BYTES } from '../worker/storage.mjs';
import { makeCore } from '../worker/mcp.mjs';

const secret = 'local-test-storage-012345678901234567890123456789';
const origin = 'https://storage.example';
const envelope = () => {
  const core = makeCore({ origin, secret });
  return { format: 1, snapshot: core.snapshot(), controls: core.controls(), profileNameChoices: {} };
};
function seedLegacy(db, value) {
  const json = JSON.stringify(value), chunks = [];
  for (let start = 0; start < json.length;) {
    let end = Math.min(start + 32768, json.length);
    if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
    chunks.push(json.slice(start, end)); start = end;
  }
  db.sql.prepare('INSERT INTO turnfeed_state_head (id,revision,digest,chunks,bytes) VALUES (1,?,?,?,?)')
    .run('legacy', createHash('sha256').update(json).digest('hex'), chunks.length, Buffer.byteLength(json));
  for (const [i, chunk] of chunks.entries()) db.sql.prepare('INSERT INTO turnfeed_state_chunks VALUES (?,?,?)').run('legacy', i, chunk);
}
const persistedRows = db => db.sql.prepare('SELECT * FROM turnfeed_state_records ORDER BY record_id,part').all();
const store = async (db, value, loaded) => {
  loaded ||= await readState(db);
  return commitState(db, loaded.revision, value, { remaining: 43 }, loaded);
};

test('initialized legacy and record state reads need one query and perform no writes', async () => {
  for (const legacy of [true, false]) {
    const db = database(), value = envelope();
    if (legacy) seedLegacy(db, value);
    else await store(db, value);
    const writes = db.executed.length, reads = db.reads.length, budget = { remaining: 1 };
    const loaded = await readState(db, budget);
    assert.deepEqual(loaded.value, value);
    assert.equal(loaded.storageFormat, legacy ? 1 : 3);
    assert.equal(db.executed.length, writes);
    assert.equal(db.reads.length - reads, 1);
    assert.equal(budget.remaining, 0);
  }
});

test('first use initializes once and preserves a concurrent first writer', async () => {
  const db = database(), budget = { remaining: 3 };
  const empty = await readState(db, budget);
  assert.equal(empty.revision, 'empty');
  assert.equal(empty.value, null);
  assert.equal(db.reads.length, 2);
  assert.equal(db.executed.length, 1);
  assert.equal(budget.remaining, 0);
  assert.deepEqual(await readState(db, { remaining: 1 }), empty);
  assert.equal(db.executed.length, 1);

  const raced = database(), value = envelope(), prepare = raced.prepare.bind(raced);
  value.retainedMetadata = { firstWriter: true };
  raced.prepare = query => {
    const statement = prepare(query);
    if (query.startsWith('INSERT OR IGNORE')) {
      const run = statement.run;
      statement.run = async function () {
        raced.prepare = prepare;
        assert.equal(await store(raced, value), true);
        return run.call(this);
      };
    }
    return statement;
  };
  const loaded = await readState(raced);
  assert.deepEqual(loaded.value, value);
  assert.equal(loaded.storageFormat, 3);
  assert.notEqual(loaded.revision, 'empty');
});

test('insufficient setup budgets and invalid read responses never initialize the database', async () => {
  for (const remaining of [0, 1, 2]) {
    const db = database();
    await assert.rejects(() => readState(db, { remaining }), { code: 'storage_busy' });
    assert.equal(db.executed.length, 0);
    assert.equal(db.sql.prepare('SELECT count(*) AS n FROM turnfeed_state_head').get().n, 0);
  }
  for (const response of [null, {}, { results: [] }, { success: true, results: {} }, { success: false, results: [] }]) {
    const db = database(), prepare = db.prepare.bind(db);
    db.prepare = query => {
      const statement = prepare(query);
      if (query.startsWith('SELECT')) statement.all = async () => response;
      return statement;
    };
    await assert.rejects(() => readState(db), { code: 'storage_corrupt' });
    assert.equal(db.executed.length, 0);
  }
});

test('an unsupported storage head is rejected without replacing it', async () => {
  const db = database();
  db.sql.prepare(`INSERT INTO turnfeed_state_head (id, revision, digest, chunks, bytes, storage_format)
    VALUES (1, 'future', 'retained', 0, 0, 4)`).run();
  const before = db.sql.prepare('SELECT * FROM turnfeed_state_head').get();
  await assert.rejects(() => readState(db), { code: 'storage_corrupt' });
  assert.deepEqual(db.sql.prepare('SELECT * FROM turnfeed_state_head').get(), before);
});

test('legacy conversion is lossless, atomic and safe against a stale pre-conversion writer', async () => {
  const db = database();
  const original = envelope();
  original.snapshot.extra = { unicode: '😀'.repeat(18000), unknown: ['keep', { exact: true }] };
  original.controls.recentRequests = [['second', { at: 2 }], ['first', { at: 1 }]];
  original.profileNameChoices = { chosen: true };
  original.operator = { revoked: { closed: { at: 'keep' } }, erasures: [{ id: 'receipt', reason: 'keep' }] };
  seedLegacy(db, original);
  const stale = await readState(db);
  assert.deepEqual(stale.value, original);
  assert.equal(stale.storageFormat, 1);
  db.failBeforeCommit = true;
  await assert.rejects(() => store(db, original, stale), { code: 'storage_outcome_unknown' });
  assert.deepEqual((await readState(db)).value, original);
  assert.equal((await readState(db)).storageFormat, 1);
  db.failBeforeCommit = false;
  assert.equal(await store(db, original, stale), true);
  assert.deepEqual((await readState(db)).value, original);
  assert.equal((await readState(db)).storageFormat, 3);
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM turnfeed_state_chunks').get().n, 0);
  const rows = persistedRows(db);
  assert.equal(await store(db, { ...original, extra: 'stale' }, stale), false);
  assert.deepEqual(persistedRows(db), rows);
  // A request using the old writer's actual revision predicate also loses.
  assert.equal(db.sql.prepare('UPDATE turnfeed_state_head SET revision = ? WHERE id = 1 AND revision = ?').run('old-worker', 'legacy').changes, 0);
});


test('a successful in-chat read migrates legacy data without a synthetic profile or post write', async () => {
  const db = database(), value = envelope();
  value.retainedEnvelopeMetadata = { preserve: true };
  seedLegacy(db, value);
  const result = await invoke({ db, origin, secret, subject: '', callerKey: 'anonymous', name: 'get_feed_digest', args: { focus: 'latest', limit: 1 } });
  assert.equal(result.result.structuredContent.ok, true);
  const stored = await readState(db);
  assert.equal(stored.storageFormat, 3);
  assert.deepEqual(stored.value, value);
});

test('record ordering, duplicate IDs, map keys and large reply trees round-trip exactly', async () => {
  const db = database(), value = envelope();
  value.snapshot.posts = [{ id: 2, replies: [{ id: 'r', text: '😀'.repeat(60000) }] }, { id: 2, text: 'duplicate preserved' }];
  value.snapshot.profiles = JSON.parse('{"__proto__":{"displayName":"retained"},"second":{"bio":"two"},"first":{"bio":"one"}}');
  value.controls.rateState = [['limiter', [['b', { count: 2 }], ['a', { count: 1 }]]]];
  await store(db, value);
  assert.deepEqual((await readState(db)).value, value);
  const loaded = await readState(db);
  loaded.value.snapshot.posts.reverse();
  loaded.value.controls.rateState[0][1].reverse();
  await store(db, loaded.value, loaded);
  assert.deepEqual((await readState(db)).value, loaded.value);
  assert.equal({}.displayName, undefined);
});

test('multi-megabyte storage changes only the edited records and stays within D1 limits', async t => {
  const db = database(), value = envelope();
  // Valid profiles exercise the real retained core without changing post retention.
  for (let i = 0; i < 2400; i++) value.snapshot.profiles[createHash('sha1').update(`member-${i}`).digest('hex')] = {
    displayName: `Reader ${i}`, bio: `A reader who enjoys thoughtful conversations. ${'Book '.repeat(90)}`,
    handle: `reader${i}`, preferences: { locale: 'en' }, joinedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  };
  value.retainedEvidence = 'Verified evidence stays intact. '.repeat(18000);
  const originalBytes = Buffer.byteLength(JSON.stringify(value));
  assert.ok(originalBytes > 2 * 1048576);
  const started = performance.now();
  await store(db, value);
  const loaded = await readState(db), before = new Map(persistedRows(db).map(row => [`${row.record_id}:${row.part}`, row.value]));
  const firstKey = Object.keys(loaded.value.snapshot.profiles)[0];
  loaded.value.snapshot.profiles[firstKey].displayName = 'Changed reader';
  const queryStart = db.executed.length;
  await store(db, loaded.value, loaded);
  const after = persistedRows(db);
  const changedBytes = after.filter(row => before.get(`${row.record_id}:${row.part}`) !== row.value).reduce((n, row) => n + Buffer.byteLength(row.value), 0);
  assert.ok(changedBytes < 4096, `small edit rewrote ${changedBytes} bytes`);
  assert.deepEqual((await readState(db)).value, loaded.value);
  const writes = db.executed.slice(queryStart).filter(s => s.query.includes('json_each'));
  assert.ok(writes.length <= 2);
  for (const stmt of db.executed) {
    assert.ok(stmt.values.length <= 100);
    assert.ok(Buffer.byteLength(stmt.query) < 100000);
    for (const v of stmt.values) if (typeof v === 'string') assert.ok(Buffer.byteLength(v) < 2000000);
  }
  // Run a real MCP profile mutation against the populated state, not just codec calls.
  const result = await invoke({ db, origin, secret, subject: 'owner', callerKey: 'owner', name: 'set_profile',
    args: { displayName: 'Theodor N. Engøy', visibility: 'public' } });
  assert.equal(result.result.structuredContent.saved, true);
  const final = await readState(db);
  assert.equal(final.value.retainedEvidence, value.retainedEvidence);
  t.diagnostic(JSON.stringify({ originalBytes, changedBytes, deltaStatements: writes.length, elapsedMs: Math.round(performance.now() - started) }));
});

test('deleted records and surplus parts are removed, with no stale private copies', async () => {
  const db = database(), value = envelope();
  value.snapshot.posts = [{ id: 'gone', text: 'private marker' }, { id: 'shorten', text: 'private marker'.repeat(7000) }];
  await store(db, value);
  const loaded = await readState(db);
  loaded.value.snapshot.posts = [{ id: 'shorten', text: 'retained' }];
  await store(db, loaded.value, loaded);
  assert.deepEqual((await readState(db)).value, loaded.value);
  assert.ok(persistedRows(db).every(row => !row.value.includes('private marker')));
});

test('corruption, over-capacity and insufficient query budgets leave the prior revision intact', async () => {
  for (const corrupt of ['value', 'missing', 'extra']) {
    const db = database(); await store(db, envelope());
    if (corrupt === 'value') db.sql.exec("UPDATE turnfeed_state_records SET value = 'broken' WHERE record_id = 'manifest' AND part = 0");
    if (corrupt === 'missing') db.sql.exec("DELETE FROM turnfeed_state_records WHERE record_id = 'manifest' AND part = 0");
    if (corrupt === 'extra') db.sql.exec("INSERT INTO turnfeed_state_records VALUES ('extra',0,'null','bogus')");
    await assert.rejects(() => readState(db), { code: 'storage_corrupt' });
  }
  const db = database(); await store(db, envelope()); const before = await readState(db);
  await assert.rejects(() => store(db, { ...before.value, huge: 'x'.repeat(MAX_DOCUMENT_BYTES) }, before), { code: 'candidate_capacity_reached' });
  await assert.rejects(() => commitState(db, before.revision, { ...before.value, added: true }, { remaining: 1 }, before), { code: 'storage_busy' });
  assert.equal((await readState(db)).revision, before.revision);
});
