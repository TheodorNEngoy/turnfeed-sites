import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

// The retained core still hydrates a snapshot. Bound both content and record
// overhead; this is an intermediate capacity limit, not D1's database capacity.
export const MAX_DOCUMENT_BYTES = 4 * 1_048_576;
export const MAX_RECORD_ROWS = 8192;
const CHUNK_CHARS = 16_384; // <=64 KiB of UTF-8, including astral characters.
const bytes = value => Buffer.byteLength(value, 'utf8');
export const digest = value => createHash('sha256').update(value).digest('hex');
const objectPaths = new Set(['', 'snapshot', 'controls', 'operator',
  'snapshot.moderationHistory', 'snapshot.writeReceipts', 'snapshot.mcpEvents',
  'snapshot.profiles', 'snapshot.follows', 'snapshot.blocks',
  'snapshot.notificationSuppressionCutoffs', 'snapshot.viewerStates',
  'snapshot.writeReceipts.owners', 'profileNameChoices', 'operator.revoked']);
const arrayPaths = new Set(['snapshot.posts', 'snapshot.reports', 'snapshot.groups',
  'snapshot.followEvents', 'snapshot.inviteEvents', 'snapshot.likeEvents', 'snapshot.users',
  'snapshot.moderationHistory.events', 'snapshot.mcpEvents.subscriptions', 'snapshot.mcpEvents.outbox',
  'operator.erasures', 'controls.rateState', 'controls.recentRequests',
  'controls.recentSocialSignalSuccesses', 'controls.pendingProfileUpdates',
  'controls.publicWriteConfirmationClaims']);

export class StorageError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = () => { throw new StorageError('storage_corrupt'); };
function capacity() { throw new StorageError('candidate_capacity_reached'); }

export function validateValue(value) {
  if (value?.format !== 1 || value.snapshot?.version !== 19 || !value.controls
      || typeof value.controls !== 'object' || Array.isArray(value.controls)) fail();
}

// IDs survive insertion/reordering when an item has an ID, Map key or string
// value. The manifest separately preserves exact array and object key order.
function identities(values) {
  const keys = values.map((item, i) => {
    if (typeof item === 'string') return ['value', item];
    if (Array.isArray(item) && typeof item[0] === 'string') return ['key', item[0]];
    if (item && ['string', 'number'].includes(typeof item.id)) return ['id', item.id];
    return ['index', i];
  });
  const seen = new Set();
  if (keys.some(key => { const id = JSON.stringify(key); if (seen.has(id)) return true; seen.add(id); return false; })) {
    return values.map((_, i) => ['index', i]);
  }
  return keys;
}

export function encodeRecords(value) {
  validateValue(value);
  // JSON normalization preserves the existing persisted-value contract.
  const json = JSON.stringify(value);
  if (bytes(json) > MAX_DOCUMENT_BYTES) capacity();
  value = JSON.parse(json);
  const rows = new Map();
  let size = 0;
  function record(id, value) {
    const json = JSON.stringify(value);
    for (let start = 0, part = 0; start < json.length; part++) {
      let end = Math.min(start + CHUNK_CHARS, json.length);
      if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
      const text = json.slice(start, end);
      size += bytes(text);
      if (size > MAX_DOCUMENT_BYTES || rows.size >= MAX_RECORD_ROWS) capacity();
      rows.set(`${id}:${part}`, { record_id: id, part, value: text, digest: digest(text) });
      start = end;
    }
    return { r: id };
  }
  function visit(item, path, logicalPath) {
    const location = logicalPath.join('.');
    if (objectPaths.has(location) && item && typeof item === 'object' && !Array.isArray(item)) {
      return { o: Object.entries(item).map(([key, child]) => [key, visit(child, [...path, key], [...logicalPath, key])]) };
    }
    if (arrayPaths.has(location) && Array.isArray(item)) {
      const keys = identities(item);
      return { a: item.map((child, i) => record(digest(JSON.stringify([...path, keys[i]])), child)) };
    }
    return record(digest(JSON.stringify(path)), item);
  }
  const manifest = visit(value, [], []);
  record('manifest', manifest);
  return { rows, bytes: size, digest: recordsDigest(rows) };
}

export function recordsDigest(rows) {
  const hash = createHash('sha256');
  for (const key of [...rows.keys()].sort()) hash.update(`${key}:${rows.get(key).digest}\n`);
  return hash.digest('hex');
}

export function decodeRecords(rows, head) {
  if (rows.size !== head.chunks || recordsDigest(rows) !== head.digest) fail();
  let size = 0;
  const documents = new Map();
  for (const row of rows.values()) {
    if (!/^(manifest|[a-f0-9]{64})$/.test(row.record_id) || !Number.isSafeInteger(row.part)
        || row.part < 0 || typeof row.value !== 'string' || digest(row.value) !== row.digest) fail();
    size += bytes(row.value);
    const parts = documents.get(row.record_id) || [];
    if (row.part !== parts.length) fail();
    parts.push(row.value);
    documents.set(row.record_id, parts);
  }
  if (size !== head.bytes || size > MAX_DOCUMENT_BYTES) fail();
  const used = new Set();
  function parse(id) {
    if (used.has(id) || !documents.has(id)) fail();
    used.add(id);
    try { return JSON.parse(documents.get(id).join('')); } catch { fail(); }
  }
  function visit(node, depth = 0) {
    if (!node || typeof node !== 'object' || Object.keys(node).length !== 1 || depth > 12) fail();
    if (typeof node.r === 'string' && node.r !== 'manifest') return parse(node.r);
    if (Array.isArray(node.a)) return node.a.map(child => visit(child, depth + 1));
    if (Array.isArray(node.o)) {
      const entries = node.o.map(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') fail();
        return [entry[0], visit(entry[1], depth + 1)];
      });
      if (new Set(entries.map(([key]) => key)).size !== entries.length) fail();
      return Object.fromEntries(entries);
    }
    fail();
  }
  const value = visit(parse('manifest'));
  if (used.size !== documents.size) fail();
  validateValue(value);
  return value;
}
