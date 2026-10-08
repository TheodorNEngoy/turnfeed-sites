import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { MAX_DOCUMENT_BYTES, MAX_RECORD_ROWS, StorageError, digest,
  encodeRecords, decodeRecords, validateValue } from './storage-records.mjs';
import { legacyReceipts, receiptBaseline, externalizeReceipts } from './storage-receipts.mjs';
export { MAX_DOCUMENT_BYTES, StorageError } from './storage-records.mjs';

const LEGACY_MAX_BYTES = 1_048_576;
const MAX_PACK_BYTES = 256 * 1024;
function spend(budget, count) {
  if (budget.remaining < count) throw new StorageError('storage_busy');
  budget.remaining -= count;
}
const corrupt = () => { throw new StorageError('storage_corrupt'); };

// One SELECT observes head and payload in the same primary snapshot, even when
// another request is converting the old representation at that instant.
export async function readState(db, budget = { remaining: 45 }, receiptOwner = '') {
  if (!db) throw new StorageError('storage_unavailable');
  spend(budget, 1);
  const query = db.prepare(`SELECT 0 AS receipt_row, h.*, NULL AS record_id, c.position AS part, c.value, NULL AS record_digest
    FROM turnfeed_state_head h LEFT JOIN turnfeed_state_chunks c ON c.revision = h.revision
    AND h.bytes <= 1048576 AND h.chunks <= 32 WHERE h.id = 1 AND h.storage_format = 1
    UNION ALL
    SELECT 0 AS receipt_row, h.*, r.record_id, r.part, r.value, r.digest AS record_digest
    FROM turnfeed_state_head h LEFT JOIN turnfeed_state_records r
    ON h.bytes <= ? AND h.chunks <= ? WHERE h.id = 1 AND h.storage_format IN (2, 3)
    UNION ALL
    SELECT 1 AS receipt_row, h.*, NULL AS record_id, r.part, r.value, NULL AS record_digest
    FROM turnfeed_state_head h JOIN turnfeed_write_receipts r ON r.owner = ? AND r.part BETWEEN 0 AND 98
    WHERE h.id = 1 AND h.storage_format = 3
    ORDER BY receipt_row, record_id, part`).bind(MAX_DOCUMENT_BYTES, MAX_RECORD_ROWS, receiptOwner);
  let response = await query.all();
  if (response?.success !== true || !Array.isArray(response?.results)) corrupt();
  if (!response.results.length) {
    // Existing databases need only the SELECT. Reserve both setup operations
    // before writing, then re-read in case another request initialized or wrote
    // state first. An unsupported head still fails validation after this retry.
    spend(budget, 2);
    await db.prepare(`INSERT OR IGNORE INTO turnfeed_state_head (id, revision, digest, chunks, bytes)
      VALUES (1, 'empty', '', 0, 0)`).run();
    response = await query.all();
  }
  const rows = response?.results?.filter(row => row.receipt_row === 0);
  const receiptRows = response?.results?.filter(row => row.receipt_row === 1);
  if (response?.success !== true || !Array.isArray(rows) || !rows.length) corrupt();
  const head = rows[0];
  if (!Number.isSafeInteger(head.bytes) || head.bytes < 0 || !Number.isSafeInteger(head.chunks) || head.chunks < 0) corrupt();
  if (head.storage_format === 1) {
    if (head.revision === 'empty' && head.chunks === 0 && head.bytes === 0 && head.digest === '') {
      return { revision: 'empty', value: null, storageFormat: 1, records: new Map(), receipts: { ledger: legacyReceipts(null), metadata: {}, chunks: new Map(), owner: receiptOwner } };
    }
    if (head.chunks < 1 || head.chunks > 32 || rows.length !== head.chunks
        || rows.some((row, i) => row.part !== i || typeof row.value !== 'string') || head.bytes > LEGACY_MAX_BYTES) corrupt();
    const json = rows.map(row => row.value).join('');
    if (Buffer.byteLength(json, 'utf8') !== head.bytes || digest(json) !== head.digest) corrupt();
    let value;
    try { value = JSON.parse(json); } catch { corrupt(); }
    validateValue(value);
    return { revision: head.revision, value, storageFormat: 1, records: new Map(), receipts: { ledger: legacyReceipts(value), metadata: {}, chunks: new Map(), owner: receiptOwner } };
  }
  if (![2, 3].includes(head.storage_format) || head.chunks < 1 || head.chunks > MAX_RECORD_ROWS
      || head.bytes > MAX_DOCUMENT_BYTES || rows.length !== head.chunks) corrupt();
  const records = new Map(rows.map(row => [`${row.record_id}:${row.part}`,
    { record_id: row.record_id, part: row.part, value: row.value, digest: row.record_digest }]));
  const stored = decodeRecords(records, head);
  const { receiptOwners, ...value } = stored;
  const receipts = head.storage_format === 3 ? receiptBaseline(value, receiptOwners, receiptOwner, receiptRows)
    : { ledger: legacyReceipts(value), metadata: {}, chunks: new Map(), owner: receiptOwner };
  if (head.storage_format === 3) value.snapshot.writeReceipts = structuredClone(receipts.ledger);
  return { revision: head.revision, value, storageFormat: head.storage_format, records, receipts };
}

// Each JSON parameter remains well below D1's 2 MB value limit. json_each avoids
// exceeding 100 bound parameters while keeping migration/erasure in one batch.
function packs(values) {
  const result = [];
  let items = [], size = 2;
  for (const value of values) {
    const json = JSON.stringify(value), length = Buffer.byteLength(json, 'utf8') + 1;
    if (length + 2 > MAX_PACK_BYTES) throw new StorageError('candidate_capacity_reached');
    if (size + length > MAX_PACK_BYTES) { result.push(`[${items.join(',')}]`); items = []; size = 2; }
    items.push(json); size += length;
  }
  if (items.length) result.push(`[${items.join(',')}]`);
  return result;
}

export async function commitState(db, previousRevision, value, budget = { remaining: 45 }, loaded, photoTransition) {
  if (!db) throw new StorageError('storage_unavailable');
  // Callers pass the immutable serialized baseline returned by readState before
  // the core can mutate hydrated objects. Direct callers may obtain it here.
  const previous = loaded || await readState(db, budget);
  if (previous.revision !== previousRevision) return false;
  const receipts = externalizeReceipts(value, previous);
  const encoded = encodeRecords(receipts.value);
  const changed = [...encoded.rows].filter(([key, row]) => previous.records.get(key)?.digest !== row.digest).map(([, row]) => row);
  const deleted = [...previous.records].filter(([key]) => !encoded.rows.has(key)).map(([, row]) => [row.record_id, row.part]);
  const revision = randomUUID();
  // Photo publication and retirement share this transaction. A rejected call
  // cannot delete an object while another request commits a post referencing it.
  const photoGuard = photoTransition ? " AND EXISTS (SELECT 1 FROM turnfeed_photos WHERE id = ? AND owner = ? AND status = 'ready')" : '';
  const statements = [db.prepare(`UPDATE turnfeed_state_head
    SET revision = ?, digest = ?, chunks = ?, bytes = ?, storage_format = 3 WHERE id = 1 AND revision = ?${photoGuard}`)
    .bind(revision, encoded.digest, encoded.rows.size, encoded.bytes, previousRevision,
      ...(photoTransition ? [photoTransition.id,photoTransition.owner] : []))];
  if (photoTransition?.retire) statements.push(db.prepare(`UPDATE turnfeed_photos SET status = 'deleting'
    WHERE id = ? AND owner = ? AND status = 'ready'
    AND EXISTS (SELECT 1 FROM turnfeed_state_head WHERE id = 1 AND revision = ?)`)
    .bind(photoTransition.id,photoTransition.owner,revision));
  if (previous.storageFormat === 1) {
    statements.push(db.prepare(`DELETE FROM turnfeed_state_records WHERE EXISTS
      (SELECT 1 FROM turnfeed_state_head WHERE id = 1 AND revision = ?)`).bind(revision));
  }
  for (const pack of packs(changed)) statements.push(db.prepare(`INSERT INTO turnfeed_state_records (record_id, part, value, digest)
    SELECT json_extract(value, '$.record_id'), json_extract(value, '$.part'), json_extract(value, '$.value'), json_extract(value, '$.digest')
    FROM json_each(?) WHERE EXISTS (SELECT 1 FROM turnfeed_state_head WHERE id = 1 AND revision = ?)
    ON CONFLICT (record_id, part) DO UPDATE SET value = excluded.value, digest = excluded.digest`).bind(pack, revision));
  for (const pack of packs(deleted)) statements.push(db.prepare(`DELETE FROM turnfeed_state_records
    WHERE (record_id, part) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
    AND EXISTS (SELECT 1 FROM turnfeed_state_head WHERE id = 1 AND revision = ?)`).bind(pack, revision));
  if (previous.storageFormat === 1) {
    statements.push(db.prepare(`DELETE FROM turnfeed_state_chunks WHERE EXISTS
      (SELECT 1 FROM turnfeed_state_head WHERE id = 1 AND revision = ?)`).bind(revision));
  }
  // The head CAS guards every ledger mutation in this same atomic batch.
  // A format-3 head prevents an older binary from dropping replay protection.
  if (receipts.migrating) statements.push(db.prepare(`DELETE FROM turnfeed_write_receipts WHERE EXISTS
    (SELECT 1 FROM turnfeed_state_head WHERE id = 1 AND revision = ?)`).bind(revision));
  for (const pack of packs(receipts.changed)) statements.push(db.prepare(`INSERT INTO turnfeed_write_receipts (owner, part, value)
    SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
    FROM json_each(?) WHERE EXISTS (SELECT 1 FROM turnfeed_state_head WHERE id = 1 AND revision = ?)
    ON CONFLICT (owner, part) DO UPDATE SET value = excluded.value`).bind(pack, revision));
  for (const pack of packs(receipts.removed)) statements.push(db.prepare(`DELETE FROM turnfeed_write_receipts
    WHERE owner IN (SELECT value FROM json_each(?))
    AND EXISTS (SELECT 1 FROM turnfeed_state_head WHERE id = 1 AND revision = ?)`).bind(pack, revision));
  // No database mutation occurs until the entire operation fits the budget.
  spend(budget, statements.length);
  let result;
  try { result = await db.batch(statements); }
  catch { throw new StorageError('storage_outcome_unknown'); }
  if (!Array.isArray(result) || result.length !== statements.length || result.some(row => row.success === false)) {
    throw new StorageError('storage_outcome_unknown');
  }
  const changes = result[0]?.meta?.changes;
  if (changes === 0) return false;
  if (changes !== 1) throw new StorageError('storage_outcome_unknown');
  return true;
}
