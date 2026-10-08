import { normalizeWriteReceipts, emptyWriteReceipts } from '../vendor/turnfeed/lib/public-write-receipts.mjs';
import { StorageError, digest } from './storage-records.mjs';

const OWNER = /^[a-f0-9]{40}$/;
export const RECEIPTS_PER_CHUNK = 1024;
// Historical ledgers may already exceed the 10,000-receipt admission limit.
// Preserve them; new publication still uses the retained per-owner limit.
const MAX_RETAINED = 100_000;
const corrupt = () => { throw new StorageError('storage_corrupt'); };
export function legacyReceipts(value) {
  try { return normalizeWriteReceipts(value?.snapshot?.writeReceipts, { allowMissing: value == null, posts: value?.snapshot?.posts }); }
  catch { corrupt(); }
}
export function receiptBaseline(value, metadata, owner, rows) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) corrupt();
  for (const [key, entry] of Object.entries(metadata)) {
    if (!OWNER.test(key) || !entry || !Number.isSafeInteger(entry.count) || entry.count < 1
        || entry.count > MAX_RETAINED || !/^[a-f0-9]{64}$/.test(entry.digest)) corrupt();
  }
  const ledger = emptyWriteReceipts(), chunks = new Map();
  const expected = metadata[owner];
  if (rows.length !== (expected ? Math.ceil(expected.count / RECEIPTS_PER_CHUNK) : 0)) corrupt();
  const entries = [];
  for (const [i, row] of rows.entries()) {
    if (row.part !== i || typeof row.value !== 'string' || row.value.length > 70_000) corrupt();
    let part;
    try { part = JSON.parse(row.value); } catch { corrupt(); }
    if (!Array.isArray(part) || part.length !== Math.min(RECEIPTS_PER_CHUNK, expected.count - entries.length)) corrupt();
    entries.push(...part); chunks.set(`${owner}:${i}`, row.value);
  }
  if (expected) {
    if (entries.length !== expected.count || digest(JSON.stringify(entries)) !== expected.digest) corrupt();
    ledger.owners[owner] = entries;
  }
  try { normalizeWriteReceipts(ledger); } catch { corrupt(); }
  // The shared document must never contain a second, divergent receipt ledger.
  const embedded = value.snapshot.writeReceipts;
  if (embedded?.schemaVersion !== 1 || !embedded.owners || Object.keys(embedded.owners).length) corrupt();
  return { ledger, chunks, metadata: structuredClone(metadata), owner };
}

export function externalizeReceipts(value, previous) {
  let incoming;
  try { incoming = normalizeWriteReceipts(value.snapshot.writeReceipts); } catch { corrupt(); }
  const baseline = previous.receipts;
  const migrating = previous.storageFormat !== 3;
  const metadata = { ...baseline.metadata };
  const owners = new Set([...Object.keys(baseline.ledger.owners), ...Object.keys(incoming.owners)]);
  const revoked = value.operator?.revoked || {};
  const removed = Object.keys(metadata).filter(owner => revoked[owner]);
  const changed = [];
  for (const owner of owners) {
    if (revoked[owner]) { if (!removed.includes(owner)) removed.push(owner); continue; }
    // A shared-only baseline can preserve receipts but cannot author new ones.
    if (!migrating && owner !== baseline.owner) corrupt();
    const entries = [...new Set([...(baseline.ledger.owners[owner] || []), ...(incoming.owners[owner] || [])])];
    if (!entries.length) continue;
    if (entries.length > MAX_RETAINED) throw new StorageError('candidate_capacity_reached');
    metadata[owner] = { count: entries.length, digest: digest(JSON.stringify(entries)) };
    for (let start = 0, part = 0; start < entries.length; start += RECEIPTS_PER_CHUNK, part++) {
      const text = JSON.stringify(entries.slice(start, start + RECEIPTS_PER_CHUNK));
      if (baseline.chunks.get(`${owner}:${part}`) !== text) changed.push([owner, part, text]);
    }
  }
  for (const owner of removed) delete metadata[owner];
  return { value: { ...value, receiptOwners: metadata,
    snapshot: { ...value.snapshot, writeReceipts: emptyWriteReceipts() } }, changed, removed, migrating };
}
