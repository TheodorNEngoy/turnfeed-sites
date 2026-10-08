import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const REPLY_EVENT = "turnfeed.reply.created";
export const EVENTS_LIMITS = Object.freeze({ subscriptions: 512, perOwner: 5, outbox: 4096, ttlMs: 86_400_000, pendingMs: 30_000, leaseMs: 30_000, attempts: 6, retentionMs: 86_400_000, rotationMs: 300_000 });
const id = z.string().regex(/^sub_[a-f0-9]{64}$/);
const owner = z.string().regex(/^[a-f0-9]{40}$/);
const millis = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cipher = z.string().min(1).max(512);
const pending = z.object({ nonce: z.string().uuid(), secret: cipher, expiresAt: millis, until: millis }).strict();
const subscription = z.object({ id, owner, url: z.string().url().max(2048), secret: cipher.nullable(), expiresAt: millis, createdAt: millis, previousSecret: cipher.nullable(), previousUntil: millis, pending: pending.nullable() }).strict();
const item = z.object({ id: z.string().uuid(), subscriptionId: id, postId: z.string().min(1).max(4096), replyId: z.string().regex(/^reply-[1-9][0-9]*$/), createdAt: millis, attempts: z.number().int().min(0).max(EVENTS_LIMITS.attempts), nextAt: millis, lease: z.string().uuid().nullable(), leaseUntil: millis }).strict();
const stateSchema = z.object({ version: z.literal(1), subscriptions: z.array(subscription).max(EVENTS_LIMITS.subscriptions), outbox: z.array(item).max(EVENTS_LIMITS.outbox) }).strict();
export const emptyEventsState = () => ({ version: 1, subscriptions: [], outbox: [] });
export function normalizeEventsState(raw, { allowMissing = false } = {}) {
  if (raw === undefined && allowMissing) return emptyEventsState();
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid persisted MCP Events state");
  const state = parsed.data;
  const ids = new Set(state.subscriptions.map((sub) => sub.id));
  if (ids.size !== state.subscriptions.length || new Set(state.outbox.map((entry) => entry.id)).size !== state.outbox.length
    || state.outbox.some((entry) => !ids.has(entry.subscriptionId))) throw new Error("Inconsistent persisted MCP Events state");
  return state;
}
export function eventSubscriptionId(ownerId, url) {
  return `sub_${createHash("sha256").update(JSON.stringify([ownerId, url, REPLY_EVENT, {}])).digest("hex")}`;
}
export function pruneEventsState(state, now = Date.now()) {
  const subscriptions = state.subscriptions.map((sub) => ({ ...sub,
    pending: sub.pending?.until > now ? sub.pending : null,
    previousSecret: sub.previousUntil > now ? sub.previousSecret : null,
    previousUntil: sub.previousUntil > now ? sub.previousUntil : 0,
  })).filter((sub) => sub.expiresAt > now || sub.pending);
  const ids = new Set(subscriptions.filter((sub) => sub.secret && sub.expiresAt > now).map((sub) => sub.id));
  return { version: 1, subscriptions, outbox: state.outbox.filter((entry) => ids.has(entry.subscriptionId)
    && entry.createdAt + EVENTS_LIMITS.retentionMs > now && entry.attempts < EVENTS_LIMITS.attempts) };
}
export function beginEventSubscription(state, { owner: ownerId, url, secret, ttlMs, authExpiresAt, now = Date.now() }) {
  const clean = pruneEventsState(state, now);
  const requested = ttlMs == null ? EVENTS_LIMITS.ttlMs : ttlMs;
  if (!Number.isSafeInteger(requested) || requested <= 0 || !Number.isFinite(authExpiresAt)) throw new Error("Invalid subscription lifetime");
  const expiresAt = Math.min(now + requested, now + EVENTS_LIMITS.ttlMs, authExpiresAt);
  if (expiresAt <= now) throw new Error("Subscription authorization expired");
  const subscriptionId = eventSubscriptionId(ownerId, url);
  const previous = clean.subscriptions.find((sub) => sub.id === subscriptionId);
  if (previous?.pending) return { ok: false, code: "subscription_busy" };
  if (!previous && (clean.subscriptions.length >= EVENTS_LIMITS.subscriptions
    || clean.subscriptions.filter((sub) => sub.owner === ownerId).length >= EVENTS_LIMITS.perOwner)) return { ok: false, code: "subscription_capacity" };
  const nonce = randomUUID();
  const next = { ...(previous || { id: subscriptionId, owner: ownerId, url, secret: null, expiresAt: 0, createdAt: now, previousSecret: null, previousUntil: 0 }),
    pending: { nonce, secret, expiresAt, until: now + EVENTS_LIMITS.pendingMs } };
  return { ok: true, id: subscriptionId, nonce, state: { ...clean, subscriptions: [...clean.subscriptions.filter((sub) => sub.id !== subscriptionId), next] } };
}
export function finishEventSubscription(state, { id: subscriptionId, nonce, verified, now = Date.now() }) {
  const sub = state.subscriptions.find((entry) => entry.id === subscriptionId);
  if (!sub?.pending || sub.pending.nonce !== nonce) return { ok: false, code: "subscription_cancelled", state };
  const active = verified && sub.pending.until > now && sub.pending.expiresAt > now;
  const next = active ? { ...sub, secret: sub.pending.secret, expiresAt: sub.pending.expiresAt,
    previousSecret: sub.secret && sub.expiresAt > now ? sub.secret : null,
    previousUntil: sub.secret && sub.expiresAt > now ? Math.min(sub.expiresAt, now + EVENTS_LIMITS.rotationMs) : 0,
    pending: null } : { ...sub, pending: null };
  const result = pruneEventsState({ ...state, subscriptions: state.subscriptions.map((entry) => entry.id === subscriptionId ? next : entry) }, now);
  return { ok: active, code: active ? undefined : "callback_verification_failed", state: result,
    result: active ? { id: subscriptionId, refreshBefore: new Date(next.expiresAt).toISOString(), cursor: null, truncated: false } : undefined };
}
export function unsubscribeEvent(state, ownerId, url) {
  const subscriptionId = eventSubscriptionId(ownerId, url);
  return { ...state, subscriptions: state.subscriptions.filter((sub) => sub.id !== subscriptionId), outbox: state.outbox.filter((entry) => entry.subscriptionId !== subscriptionId) };
}
export function eraseEventsOwners(state, ownerIds) {
  const erased = new Set(ownerIds);
  const subscriptions = state.subscriptions.filter((sub) => !erased.has(sub.owner));
  const ids = new Set(subscriptions.map((sub) => sub.id));
  return { ...state, subscriptions, outbox: state.outbox.filter((entry) => ids.has(entry.subscriptionId)) };
}
// Called only at the new reply append point, in the same store transaction.
export function enqueueReplyEvents(state, { owner: ownerId, postId, replyId, now = Date.now() }) {
  const clean = pruneEventsState(state, now);
  const subscriptions = clean.subscriptions.filter((sub) => sub.owner === ownerId && sub.secret && sub.expiresAt > now);
  if (subscriptions.length && (typeof postId !== "string" || !postId.length || postId.length > 4096)) return { ok: false, code: "events_target_unsupported", message: "This historical thread cannot supply reply alerts. Stop its owner's reply monitoring or start a new thread.", status: 409 };
  if (clean.outbox.length + subscriptions.length > EVENTS_LIMITS.outbox) return { ok: false, code: "events_delivery_capacity", message: "Reply notifications are temporarily busy. Try publishing again shortly.", status: 503 };
  const outbox = [...clean.outbox, ...subscriptions.map((sub) => ({ id: randomUUID(), subscriptionId: sub.id, postId, replyId, createdAt: now, attempts: 0, nextAt: now, lease: null, leaseUntil: 0 }))];
  return { ok: true, state: { ...clean, outbox } };
}
export function claimEventDelivery(state, canDeliver, now = Date.now()) {
  const clean = pruneEventsState(state, now);
  const subscriptions = new Map(clean.subscriptions.map((sub) => [sub.id, sub]));
  const outbox = clean.outbox.filter((entry) => canDeliver(entry, subscriptions.get(entry.subscriptionId)));
  const candidate = outbox.find((entry) => entry.nextAt <= now && entry.leaseUntil <= now);
  if (!candidate) return { state: { ...clean, outbox }, delivery: null };
  const entry = { ...candidate, lease: randomUUID(), leaseUntil: now + EVENTS_LIMITS.leaseMs };
  return { state: { ...clean, outbox: outbox.map((item) => item.id === entry.id ? entry : item) }, delivery: { entry, subscription: subscriptions.get(entry.subscriptionId) } };
}
export function finishEventDelivery(state, entry, status, now = Date.now()) {
  const current = state.outbox.find((item) => item.id === entry.id && item.lease === entry.lease);
  if (!current) return state;
  const terminal = (status >= 200 && status < 300) || (status >= 300 && status < 500 && status !== 408 && status !== 429)
    || current.attempts + 1 >= EVENTS_LIMITS.attempts;
  const updated = { ...current, attempts: current.attempts + 1, lease: null, leaseUntil: 0,
    nextAt: now + Math.min(300_000, 1000 * 2 ** current.attempts) };
  const next = { ...state, outbox: terminal ? state.outbox.filter((item) => item.id !== current.id)
    : state.outbox.map((item) => item.id === current.id ? updated : item) };
  // Receiver withdrawal terminates the subscription, including pending refresh.
  if (status === 410) return { ...next, subscriptions: next.subscriptions.filter((sub) => sub.id !== current.subscriptionId), outbox: next.outbox.filter((item) => item.subscriptionId !== current.subscriptionId) };
  return next;
}
