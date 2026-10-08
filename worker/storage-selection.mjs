import { Buffer } from 'node:buffer';
import { MAX_DOCUMENT_BYTES, MAX_RECORD_ROWS, StorageError, digest, recordsDigest } from './storage-records.mjs';

const corrupt = () => { throw new StorageError('storage_corrupt'); };
const changed = () => { throw new StorageError('storage_changed'); };
export const SMALL_SELECTION_BYTES = 64 * 1024;
function spend(budget) {
  if (budget.remaining < 1) throw new StorageError('storage_busy');
  budget.remaining--;
}
function parse(text) { try { return JSON.parse(text); } catch { corrupt(); } }

// Read the format-2 manifest and digest index in one primary snapshot. Unselected
// payloads stay in D1 for larger states. Small states arrive in this one snapshot
// so later projections need no round trips. The head authenticates each digest;
// selected payload is checked against that index before it can be used.
// This returns a read-only projection, NEVER a baseline for commitState.
export async function readSelection(db, budget = { remaining: 45 }) {
  if (!db) throw new StorageError('storage_unavailable');
  spend(budget);
  const response = await db.prepare(`SELECT 0 AS kind,
    json_object('revision', revision, 'digest', digest, 'chunks', chunks,
      'bytes', bytes, 'storage_format', storage_format) AS payload
    FROM turnfeed_state_head WHERE id = 1
    UNION ALL
    SELECT 1 AS kind, json_array(r.record_id, r.part, r.digest,
      CASE WHEN r.record_id = 'manifest' OR h.bytes <= ? THEN r.value ELSE NULL END) AS payload
    FROM turnfeed_state_records r JOIN turnfeed_state_head h
      ON h.id = 1 AND h.storage_format = 2 AND h.bytes <= ? AND h.chunks <= ?`)
    .bind(SMALL_SELECTION_BYTES, MAX_DOCUMENT_BYTES, MAX_RECORD_ROWS).all();
  if (response.success === false || !Array.isArray(response.results)) corrupt();
  if (!response.results.length) return null; // First use follows normal initialization.
  const headers = response.results.filter(row => row.kind === 0);
  if (headers.length !== 1) corrupt();
  const head = parse(headers[0].payload);
  if (head.storage_format === 1) return null; // Preserve normal legacy migration.
  if (head.storage_format !== 2 || typeof head.revision !== 'string'
      || !Number.isSafeInteger(head.chunks) || head.chunks < 1 || head.chunks > MAX_RECORD_ROWS
      || !Number.isSafeInteger(head.bytes) || head.bytes < 1 || head.bytes > MAX_DOCUMENT_BYTES) corrupt();
  const rows = new Map(), documents = new Map();
  for (const row of response.results) {
    if (row.kind === 0) continue;
    if (row.kind !== 1) corrupt();
    const entry = parse(row.payload);
    if (!Array.isArray(entry) || entry.length !== 4) corrupt();
    const [record_id, part, hash, value] = entry;
    if (typeof record_id !== 'string' || !/^(manifest|[a-f0-9]{64})$/.test(record_id)
        || !Number.isSafeInteger(part) || part < 0 || !/^[a-f0-9]{64}$/.test(hash)) corrupt();
    const key = `${record_id}:${part}`;
    if (rows.has(key)) corrupt();
    const item = { record_id, part, digest: hash, value };
    rows.set(key, item);
    if (!documents.has(record_id)) documents.set(record_id, []);
    documents.get(record_id).push(item);
  }
  if (rows.size !== head.chunks || recordsDigest(rows) !== head.digest) corrupt();
  for (const parts of documents.values()) {
    parts.sort((a, b) => a.part - b.part);
    if (parts.some((row, index) => row.part !== index)) corrupt();
  }
  const cached = new Map();
  let loadedBytes = 0;
  function decode(id, parts) {
    for (const row of parts) {
      if (typeof row.value !== 'string' || digest(row.value) !== row.digest) corrupt();
      loadedBytes += Buffer.byteLength(row.value, 'utf8');
    }
    if (loadedBytes > head.bytes) corrupt();
    cached.set(id, parse(parts.map(row => row.value).join('')));
  }
  if (!documents.has('manifest')) corrupt();
  decode('manifest', documents.get('manifest'));
  const manifest = cached.get('manifest'), used = new Set(['manifest']);
  function validate(node, depth = 0) {
    if (!node || typeof node !== 'object' || Object.keys(node).length !== 1 || depth > 12) corrupt();
    if (typeof node.r === 'string') {
      if (used.has(node.r) || !documents.has(node.r)) corrupt();
      used.add(node.r);
    } else if (Array.isArray(node.a)) node.a.forEach(child => validate(child, depth + 1));
    else if (Array.isArray(node.o)) {
      const keys = new Set();
      for (const entry of node.o) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || keys.has(entry[0])) corrupt();
        keys.add(entry[0]); validate(entry[1], depth + 1);
      }
    } else corrupt();
  }
  validate(manifest);
  if (used.size !== documents.size) corrupt();
  // Valid stored envelopes always expand these objects in the manifest.
  if (!Array.isArray(manifest.o) || !Array.isArray(manifest.o.find(([key]) => key === 'controls')?.[1]?.o)) corrupt();
  if (head.bytes <= SMALL_SELECTION_BYTES) {
    for (const [id, parts] of documents) if (id !== 'manifest') decode(id, parts);
    if (loadedBytes !== head.bytes) corrupt();
  }
  function locate(path) {
    let node = manifest;
    for (let i = 0; i < path.length; i++) {
      if (node.r) return { node, tail: path.slice(i) };
      // Stable array IDs are authenticated through the manifest just like object
      // paths. Duplicate IDs use positional encoding instead; callers fall back
      // to a complete read when no stable reference is present.
      if (node.a && Array.isArray(path[i]) && path[i].length === 2 && path[i][0] === 'id') {
        const recordId = digest(JSON.stringify(path.slice(0, i + 1)));
        node = node.a.find(child => child.r === recordId);
        if (!node) return {};
        continue;
      }
      const entry = node.o?.find(([key]) => key === path[i]);
      if (!entry) return {};
      node = entry[1];
    }
    return { node, tail: [] };
  }
  function references(node, into) {
    if (!node) return;
    if (node.r) into.add(node.r);
    else if (node.a) node.a.forEach(child => references(child, into));
    else node.o.forEach(([, child]) => references(child, into));
  }
  function materialize(node) {
    if (!node) return undefined;
    if (node.r) return cached.get(node.r);
    if (node.a) return node.a.map(materialize);
    return Object.fromEntries(node.o.map(([key, child]) => [key, materialize(child)]));
  }
  return {
    revision: head.revision,
    async project(paths) {
      const locations = paths.map(locate), needed = new Set();
      locations.forEach(({ node }) => references(node, needed));
      const missing = [...needed].filter(id => !cached.has(id));
      if (missing.length) {
        spend(budget);
        // Head and selected rows share one snapshot. A concurrent commit is a
        // definite read conflict, including account closure between read phases.
        const reply = await db.prepare(`SELECT h.revision, r.record_id, r.part, r.value
          FROM turnfeed_state_head h LEFT JOIN turnfeed_state_records r
            ON r.record_id IN (SELECT value FROM json_each(?))
          WHERE h.id = 1 AND h.storage_format = 2 AND h.revision = ?
          ORDER BY r.record_id, r.part`).bind(JSON.stringify(missing), head.revision).all();
        if (reply.success === false || !Array.isArray(reply.results)) corrupt();
        if (!reply.results.length) changed();
        const fetched = new Map();
        for (const row of reply.results) {
          if (row.revision !== head.revision || !needed.has(row.record_id) || !rows.has(`${row.record_id}:${row.part}`)) corrupt();
          const key = `${row.record_id}:${row.part}`;
          if (fetched.has(key)) corrupt();
          fetched.set(key, row.value);
        }
        for (const id of missing) {
          const parts = documents.get(id).map(row => ({ ...row, value: fetched.get(`${id}:${row.part}`) }));
          decode(id, parts);
        }
      }
      return locations.map(({ node, tail = [] }) => {
        let value = materialize(node);
        for (const key of tail) value = value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
        return value;
      });
    },
  };
}
