import { createHash } from "node:crypto";

// Admission limits, not eviction limits. Never expire or discard a receipt to
// admit another write: an arbitrarily delayed old request could otherwise replay.
export const MAX_WRITE_RECEIPTS_PER_OWNER = 10_000;
export const MAX_WRITE_RECEIPTS = 200_000;
const MAX_RECEIPT_INPUT_ITEMS = 1_000_000;
const USER_ID = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invalid() {
  const error = new Error("Invalid public-write receipt ledger; refusing to discard replay protection.");
  error.code = "WRITE_RECEIPTS_INVALID";
  throw error;
}

export const emptyWriteReceipts = () => ({ schemaVersion: 1, owners: {} });

export function writeReceiptDigest(kind, userId, clientId) {
  if (!["post", "reply"].includes(kind) || !USER_ID.test(userId)) return "";
  const id = typeof clientId === "string" ? clientId.trim().slice(0, 64) : "";
  if (!id) return "";
  return createHash("sha256").update(JSON.stringify(["turnfeed-public-write-v1", kind, userId, id])).digest("hex");
}

export function normalizeWriteReceipts(value, { allowMissing = false, posts = [] } = {}) {
  if (value === undefined && allowMissing) value = emptyWriteReceipts();
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== 1 || Object.keys(value).some((key) => !["schemaVersion", "owners"].includes(key))
    || !value.owners || typeof value.owners !== "object" || Array.isArray(value.owners)) invalid();
  const owners = {};
  let count = 0;
  for (const [userId, receipts] of Object.entries(value.owners)) {
    if (!USER_ID.test(userId) || !Array.isArray(receipts)) invalid();
    count += receipts.length;
    if (count > MAX_RECEIPT_INPUT_ITEMS || receipts.some((digest) => typeof digest !== "string" || !DIGEST.test(digest))) invalid();
    const unique = new Set(receipts);
    if (unique.size !== receipts.length) invalid();
    owners[userId] = unique;
  }
  // Capture even raw content which normal content normalization will prune.
  // Iterative traversal deliberately has no reply-depth or archive cutoff.
  const stack = [{ items: Array.isArray(posts) ? posts : [], index: 0, kind: "post" }];
  const seen = new Set();
  let visited = 0;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.items.length) { stack.pop(); continue; }
    const item = frame.items[frame.index++];
    if (++visited > MAX_RECEIPT_INPUT_ITEMS) invalid();
    if (!item || typeof item !== "object") continue;
    if (seen.has(item)) invalid();
    seen.add(item);
    // Only exact authenticated internal IDs can match a real caller. Invalid
    // historical author labels must not be trimmed/lowercased into another user.
    const userId = typeof item.authorId === "string" ? item.authorId : "";
    const digest = writeReceiptDigest(frame.kind, userId, item.clientId);
    if (digest) {
      const entries = owners[userId] || (owners[userId] = new Set());
      if (!entries.has(digest)) {
        if (++count > MAX_RECEIPT_INPUT_ITEMS) invalid();
        entries.add(digest);
      }
    }
    if (Array.isArray(item.replies)) stack.push({ items: item.replies, index: 0, kind: "reply" });
  }
  return { schemaVersion: 1, owners: Object.fromEntries(Object.entries(owners).map(([id, entries]) => [id, [...entries]])) };
}

export function hasWriteReceipt(ledger, kind, userId, clientId) {
  const digest = writeReceiptDigest(kind, userId, clientId);
  return Boolean(digest && own(ledger.owners, userId) && ledger.owners[userId].includes(digest));
}

export function writeReceiptCapacityAvailable(ledger, userId) {
  return (ledger.owners[userId]?.length || 0) < MAX_WRITE_RECEIPTS_PER_OWNER
    && Object.values(ledger.owners).reduce((sum, entries) => sum + entries.length, 0) < MAX_WRITE_RECEIPTS;
}

// All updates replace nested values: mutation rollback snapshots share references.
export function rememberWriteReceipt(ledger, kind, userId, clientId) {
  const digest = writeReceiptDigest(kind, userId, clientId);
  if (!digest || hasWriteReceipt(ledger, kind, userId, clientId)) return ledger;
  if (!writeReceiptCapacityAvailable(ledger, userId)) {
    const error = new Error("Public-write receipt capacity exhausted.");
    error.code = "WRITE_RECEIPTS_FULL";
    throw error;
  }
  return { schemaVersion: 1, owners: { ...ledger.owners, [userId]: [...(ledger.owners[userId] || []), digest] } };
}

export function eraseOwnerWriteReceipts(ledger, userId) {
  const { [userId]: removed, ...owners } = ledger.owners;
  return { schemaVersion: 1, owners };
}
