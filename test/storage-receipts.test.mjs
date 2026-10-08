import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import { invoke } from './moderation-fixture.mjs';
import { makeCore } from '../worker/mcp.mjs';
import { accountKey } from '../worker/identity.mjs';
import { readState, commitState, MAX_DOCUMENT_BYTES } from '../worker/storage.mjs';
import { encodeRecords, digest } from '../worker/storage-records.mjs';
import { writeReceiptDigest } from '../vendor/turnfeed/lib/public-write-receipts.mjs';

const origin = 'https://receipts.example';
const secret = 'local-receipts-test-012345678901234567890123456789';
const alice = accountKey('alice', secret), bob = accountKey('bob', secret);
function envelope() {
  const core = makeCore({ origin, secret });
  return { format: 1, snapshot: core.snapshot(), controls: core.controls(), profileNameChoices: {} };
}
function seedV2(db, value) {
  const encoded = encodeRecords(value);
  db.sql.prepare('INSERT INTO turnfeed_state_head VALUES (1, ?, ?, ?, ?, 2)')
    .run('v2-baseline', encoded.digest, encoded.rows.size, encoded.bytes);
  const insert = db.sql.prepare('INSERT INTO turnfeed_state_records VALUES (?, ?, ?, ?)');
  for (const row of encoded.rows.values()) insert.run(row.record_id, row.part, row.value, row.digest);
  return encoded;
}
const read = (db, owner = '') => readState(db, undefined, owner);
const save = (db, loaded, value = loaded.value, budget = { remaining: 45 }) => commitState(db, loaded.revision, value, budget, loaded);
const count = (db, owner) => db.sql.prepare('SELECT count(*) AS n FROM turnfeed_write_receipts WHERE owner = ?').get(owner).n;
const call = (db, subject, name, args) => invoke({ db, origin, secret, subject, callerKey: subject, name, args });
const post = (db, subject, clientId, text = 'A useful reading habit: leave a short note about the chapter before you stop.') => call(db, subject, 'create_post', {
  text, visibility: 'public', clientId,
});

test('near-capacity v2 receipts migrate atomically and no longer consume shared content capacity', async t => {
  const db = database(), value = envelope();
  for (let n = 0; n < 7; n++) value.snapshot.writeReceipts.owners[accountKey(`historical-${n}`, secret)] =
    Array.from({ length: n === 6 ? 8926 : 8929 }, (_, i) => digest(`historical-${n}-${i}`));
  const encoded = seedV2(db, value);
  assert.ok(encoded.bytes > MAX_DOCUMENT_BYTES * 0.99);
  const result = await post(db, 'alice', 'fresh-at-migration');
  assert.equal(result.result.structuredContent.published, true);
  const loaded = await read(db, alice);
  assert.equal(loaded.storageFormat, 3);
  assert.equal(loaded.receipts.ledger.owners[alice].length, 1);
  for (const [owner, entries] of Object.entries(value.snapshot.writeReceipts.owners)) {
    assert.deepEqual((await read(db, owner)).receipts.ledger.owners[owner], entries);
  }
  loaded.value.snapshot.writeReceipts.owners[alice].push(...Array.from({ length: 9999 }, (_, i) => digest(`alice-retained-${i}`)));
  await save(db, loaded);
  const ledgerBytes = db.sql.prepare('SELECT sum(length(value)) AS n FROM turnfeed_write_receipts').get().n;
  assert.ok(ledgerBytes > MAX_DOCUMENT_BYTES);
  const start = db.reads.length;
  assert.equal((await post(db, 'bob', 'fresh-after-cap')).result.structuredContent.published, true);
  assert.equal(db.reads.length - start, 1);
  assert.ok(db.reads.at(-1).bytes < 30_000);
  const limited = (await post(db, 'alice', 'over-own-limit', 'For the weekend: I am looking for a novel with an unusual setting.')).result.structuredContent;
  assert.equal(limited.published, false, JSON.stringify(limited));
  assert.match(limited.message, /cannot safely record another publishing request/);
  const head = db.sql.prepare('SELECT * FROM turnfeed_state_head').get();
  assert.ok(head.bytes < 15_000);
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM turnfeed_state_chunks').get().n, 0);
  for (const statement of db.executed) for (const value of statement.values) {
    if (typeof value === 'string') assert.ok(Buffer.byteLength(value) < 2_000_000);
  }
  t.diagnostic(JSON.stringify({ oldSharedBytes: encoded.bytes, receiptBytes: ledgerBytes, newSharedBytes: head.bytes,
    freshOwnerReadBytes: db.reads[start].bytes, freshOwnerReadQueries: 1 }));
});

test('legacy migration preserves removed replies and resets keep delayed-retry protection', async () => {
  const db = database(), value = envelope();
  value.snapshot.posts = [{ id: 'old-post', authorId: alice, clientId: 'old-post-client', text: 'Legacy root',
    replies: [{ id: 'old-reply', authorId: bob, clientId: 'old-reply-client', text: 'Legacy reply', replies: [] }] }];
  seedV2(db, value);
  const before = await read(db, alice);
  // Content removal and migration happen together; raw receipts survive pruning.
  before.value.snapshot.posts = [];
  await save(db, before);
  assert.deepEqual((await read(db, bob)).receipts.ledger.owners[bob], [writeReceiptDigest('reply', bob, 'old-reply-client')]);
  assert.equal((await post(db, 'alice', 'old-post-client')).result.structuredContent.published, false);
  assert.equal((await post(db, 'alice', 'new-post-client')).result.structuredContent.published, true);
  await call(db, 'alice', 'reset_me', {});
  assert.equal((await post(db, 'alice', 'new-post-client')).result.structuredContent.published, false);
  assert.equal((await read(db)).value.snapshot.posts.length, 0);
  assert.equal(count(db, bob), 1);
});

test('receipt writes share the state CAS, roll back on failure and survive an ambiguous commit', async () => {
  const db = database();
  const value = envelope(); value.snapshot.writeReceipts.owners[alice] = [digest('first')];
  seedV2(db, value);
  let baseline = await read(db, alice);
  db.failBeforeCommit = true;
  await assert.rejects(() => save(db, baseline), { code: 'storage_outcome_unknown' });
  assert.equal((await read(db)).storageFormat, 2); assert.equal(count(db, alice), 0);
  db.failBeforeCommit = false;
  await save(db, baseline);
  const winner = await read(db, alice), stale = await read(db, alice);
  winner.value.snapshot.writeReceipts.owners[alice].push(digest('winner'));
  assert.equal(await save(db, winner), true);
  stale.value.snapshot.writeReceipts.owners[alice].push(digest('loser'));
  assert.equal(await save(db, stale), false);
  assert.deepEqual((await read(db, alice)).receipts.ledger.owners[alice], [digest('first'), digest('winner')]);
  baseline = await read(db, alice);
  baseline.value.snapshot.writeReceipts.owners[alice].push(digest('lost-response'));
  db.failAfterCommit = true;
  await assert.rejects(() => save(db, baseline), { code: 'storage_outcome_unknown' });
  db.failAfterCommit = false;
  assert.ok((await read(db, alice)).receipts.ledger.owners[alice].includes(digest('lost-response')));
});

test('missing, altered and extra owner chunks fail closed; missing legacy ledger cannot discard history', async () => {
  for (const scenario of ['missing', 'altered', 'extra']) {
    const db = database(), value = envelope();
    value.snapshot.writeReceipts.owners[alice] = [digest('first')]; seedV2(db, value);
    await save(db, await read(db, alice));
    if (scenario === 'missing') db.sql.prepare('DELETE FROM turnfeed_write_receipts WHERE owner = ?').run(alice);
    if (scenario === 'altered') db.sql.prepare('UPDATE turnfeed_write_receipts SET value = ? WHERE owner = ?').run(JSON.stringify([digest('replacement')]), alice);
    if (scenario === 'extra') db.sql.prepare('INSERT INTO turnfeed_write_receipts VALUES (?,1,?)').run(alice, '[]');
    await assert.rejects(() => read(db, alice), { code: 'storage_corrupt' });
    await assert.rejects(() => post(db, 'alice', 'uncertain-history'), { code: 'storage_corrupt' });
  }
  const db = database(), value = envelope(); delete value.snapshot.writeReceipts;
  seedV2(db, value);
  await assert.rejects(() => read(db, alice), { code: 'storage_corrupt' });
});

test('shared-only edits preserve all owner receipts; revocation removes only the erased account atomically', async () => {
  const db = database(), value = envelope();
  value.snapshot.writeReceipts.owners = { [alice]: [digest('a')], [bob]: [digest('b')] };
  seedV2(db, value); await save(db, await read(db));
  let loaded = await read(db);
  assert.deepEqual(loaded.receipts.ledger.owners, {});
  loaded.value.extra = 'an unrelated profile or photo edit'; await save(db, loaded);
  assert.equal(count(db, alice), 1); assert.equal(count(db, bob), 1);
  loaded = await read(db);
  loaded.value.operator = { revoked: { [alice]: { caseId: 'test' } }, erasures: [] };
  db.failBeforeCommit = true;
  await assert.rejects(() => save(db, loaded), { code: 'storage_outcome_unknown' });
  assert.equal(count(db, alice), 1);
  db.failBeforeCommit = false;
  await save(db, loaded);
  assert.equal(count(db, alice), 0); assert.equal(count(db, bob), 1);
  assert.equal((await post(db, 'alice', 'closed-account')).status, 403);
  assert.deepEqual((await read(db, bob)).receipts.ledger.owners[bob], [digest('b')]);
});
