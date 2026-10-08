// Adapted from retained Turnfeed source 1e1aa82: add verified Sites operator attribution.
import { Buffer } from "node:buffer";

const MAX_EVENTS = 1_000;
const MAX_BYTES = 1_048_576;
const MAX_NOTE_CHARS = 500;
const MAX_ID = Number.MAX_SAFE_INTEGER;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISIBILITY_KEYS = ["id", "kind", "createdAt", "action", "target", "priorHidden", "resultingHidden", "reason", "reasonProvided", "actor", "requestId", "reviewOf"];
const VISIBILITY_INPUT_KEYS = VISIBILITY_KEYS.filter((key) => !["id", "kind", "reasonProvided"].includes(key));
const DISPOSAL_KEYS = ["id", "kind", "createdAt", "reason", "actor", "requestId", "disposedEventIds", "disposedCount"];

function fail(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

const invalidHistory = (message) => fail("moderation_history_invalid", 503, message);
const invalidDecision = (message) => fail("moderation_decision_invalid", 400, message);

function exactObject(value, keys, reject) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("Expected a moderation history object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject("Moderation history objects must contain plain data.");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || keys.some((key) => !ownKeys.includes(key))) {
    reject("Moderation history object has missing or unexpected fields.");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) reject("Moderation history fields must be plain data.");
  }
}

function plainArray(value, reject) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
    reject("Moderation history lists must be plain arrays without extra fields.");
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) reject("Moderation history lists must not contain holes or accessors.");
  }
}

function decisionNumber(value, reject) {
  if (typeof value !== "string" || !/^decision-[1-9][0-9]*$/.test(value)) reject("Invalid moderation decision ID.");
  const number = Number(value.slice("decision-".length));
  if (!Number.isSafeInteger(number) || number < 1) reject("Invalid moderation decision ID.");
  return number;
}

function timestamp(value, reject) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    reject("Moderation timestamps must be canonical UTC ISO strings.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) reject("Invalid moderation timestamp.");
}

function targetId(value, { empty = false } = {}, reject) {
  if (typeof value !== "string" || value.length > 160 || value !== value.trim() || CONTROL_CHARACTERS.test(value) || (!empty && !value)) {
    reject("Invalid moderation target ID.");
  }
}

function validateTarget(target, reject) {
  exactObject(target, ["type", "postId", "replyId", "createdAt", "parentCreatedAt"], reject);
  if (!["post", "reply"].includes(target.type)) reject("Invalid moderation target type.");
  targetId(target.postId, {}, reject);
  timestamp(target.createdAt, reject);
  if (target.type === "post") {
    if (target.replyId !== "" || target.parentCreatedAt !== "") reject("Post decisions cannot name a parent or reply.");
  } else {
    targetId(target.replyId, {}, reject);
    timestamp(target.parentCreatedAt, reject);
  }
}

function validateActor(actor, reject) {
  if (actor?.kind === "sites-operator") {
    exactObject(actor, ["kind", "authSource", "individualIdentityVerified", "operatorKey"], reject);
    if (actor.authSource !== "sites" || actor.individualIdentityVerified !== true || !/^[a-f0-9]{40}$/.test(actor.operatorKey)) {
      reject("Sites moderation requires a verified operator identity.");
    }
    return;
  }
  exactObject(actor, ["kind", "authSource", "individualIdentityVerified"], reject);
  if (actor.kind !== "shared-admin" || !["cookie", "bearer", "test"].includes(actor.authSource) || actor.individualIdentityVerified !== false) {
    reject("Moderation attribution must identify shared administrative access without claiming an individual identity.");
  }
}

function requestId(value, { allowEmpty = false } = {}, reject) {
  if (typeof value !== "string" || (value === "" ? !allowEmpty : !UUID.test(value))) reject("A moderation request ID must be a UUID.");
}

function reasonProvided(value, { allowEmpty = false } = {}, reject) {
  if (typeof value !== "string" || value.length > MAX_NOTE_CHARS || CONTROL_CHARACTERS.test(value)) {
    reject("Moderation reasons must be at most 500 characters without control characters.");
  }
  const provided = value.trim().length > 0;
  if (!provided && !allowEmpty) reject("A moderation reason is required.");
  return provided;
}

function validateVisibility(event, reject) {
  exactObject(event, VISIBILITY_KEYS, reject);
  const number = decisionNumber(event.id, reject);
  timestamp(event.createdAt, reject);
  validateTarget(event.target, reject);
  validateActor(event.actor, reject);
  requestId(event.requestId, { allowEmpty: true }, reject);
  const provided = reasonProvided(event.reason, { allowEmpty: event.requestId === "" }, reject);
  if (event.reasonProvided !== provided) reject("Moderation reasonProvided does not match the stored reason.");
  if (!["hide", "restore"].includes(event.action) || typeof event.priorHidden !== "boolean" || typeof event.resultingHidden !== "boolean") {
    reject("Invalid moderation visibility action or state.");
  }
  if (event.resultingHidden !== (event.action === "hide")) reject("Moderation action does not match its resulting state.");
  if (event.reviewOf !== "" && decisionNumber(event.reviewOf, reject) >= number) reject("A moderation review must reference an earlier decision.");
  if (event.priorHidden === event.resultingHidden && event.reviewOf === "") reject("An unchanged visibility state requires an explicit review reference.");
}

function validateDisposal(event, reject) {
  exactObject(event, DISPOSAL_KEYS, reject);
  const number = decisionNumber(event.id, reject);
  timestamp(event.createdAt, reject);
  reasonProvided(event.reason, {}, reject);
  validateActor(event.actor, reject);
  requestId(event.requestId, {}, reject);
  plainArray(event.disposedEventIds, reject);
  if (event.disposedEventIds.length < 1 || event.disposedEventIds.length > 100) {
    reject("A reviewed disposal must select between 1 and 100 decisions.");
  }
  const selected = new Set();
  for (const id of event.disposedEventIds) {
    if (decisionNumber(id, reject) >= number || selected.has(id)) reject("Disposal references must be unique earlier decision IDs.");
    selected.add(id);
  }
  if (event.disposedCount !== selected.size) reject("Moderation disposal count does not match its selected decisions.");
}

function sameTarget(left, right) {
  return ["type", "postId", "replyId", "createdAt", "parentCreatedAt"].every((key) => left[key] === right[key]);
}

function compactBytes(history) {
  return Buffer.byteLength(JSON.stringify(history), "utf8");
}

export function emptyModerationHistory() {
  return { schemaVersion: 1, nextId: 1, events: [] };
}

export function validateModerationHistory(value, { allowMissing = false } = {}) {
  if (value === undefined && allowMissing) return emptyModerationHistory();
  exactObject(value, ["schemaVersion", "nextId", "events"], invalidHistory);
  if (value.schemaVersion !== 1) invalidHistory("Unsupported moderation history schema.");
  if (!Number.isSafeInteger(value.nextId) || value.nextId < 1) invalidHistory("Invalid moderation history nextId.");
  plainArray(value.events, invalidHistory);
  const byId = new Map();
  const requests = new Set();
  let previous = 0;
  for (const event of value.events) {
    if (event?.kind === "visibility") validateVisibility(event, invalidHistory);
    else if (event?.kind === "retention_disposal") validateDisposal(event, invalidHistory);
    else invalidHistory("Unknown moderation event kind.");
    const number = decisionNumber(event.id, invalidHistory);
    if (number <= previous || number >= value.nextId) invalidHistory("Moderation decision IDs must increase below nextId.");
    previous = number;
    byId.set(event.id, event);
    if (event.requestId) {
      const key = event.requestId.toLowerCase();
      if (requests.has(key)) invalidHistory("Moderation request IDs must be unique.");
      requests.add(key);
    }
  }
  for (const event of value.events) {
    if (event.kind === "retention_disposal") {
      if (event.disposedEventIds.some((id) => byId.has(id))) invalidHistory("A disposed moderation decision cannot remain in the retained history.");
      continue;
    }
    if (event.kind !== "visibility" || !event.reviewOf) continue;
    const reviewed = byId.get(event.reviewOf);
    // Explicit disposal may remove an earlier reference. Retained records keep
    // the original reference, while append requires a currently retained row.
    if (reviewed && (reviewed.kind !== "visibility" || !sameTarget(event.target, reviewed.target))) {
      invalidHistory("A retained moderation review reference names a different target or event kind.");
    }
  }
  // Recovery validates integrity without silently enforcing admission limits.
  return structuredClone(value);
}

function assertRequestUnused(history, id) {
  if (id && history.events.some((event) => event.requestId.toLowerCase() === id.toLowerCase())) {
    fail("moderation_decision_already_recorded", 409, "This moderation request has already been recorded.");
  }
}

function nextDecisionId(history) {
  if (history.nextId >= MAX_ID) fail("moderation_history_id_exhausted", 409, "Moderation decision IDs are exhausted.");
  return `decision-${history.nextId}`;
}

function admit(history, events, { allowRecoveryReduction = false } = {}) {
  const candidate = { schemaVersion: 1, nextId: history.nextId + 1, events };
  const candidateBytes = compactBytes(candidate);
  if (candidate.events.length > MAX_EVENTS || candidateBytes > MAX_BYTES) {
    // Reviewed disposal alone may gradually repair recovered over-cap history.
    // Each such batch must reduce both dimensions; no record is dropped by
    // validation or by an ordinary visibility-event admission.
    if (allowRecoveryReduction) {
      const existingBytes = compactBytes(history);
      const recovering = history.events.length > MAX_EVENTS || existingBytes > MAX_BYTES;
      if (recovering && candidate.events.length < history.events.length && candidateBytes < existingBytes) return candidate;
    }
    fail("moderation_history_capacity", 409, "Moderation history needs a reviewed retention decision before another event can be stored.");
  }
  return candidate;
}

export function appendModerationDecision(history, input) {
  const current = validateModerationHistory(history);
  exactObject(input, VISIBILITY_INPUT_KEYS, invalidDecision);
  const event = { id: nextDecisionId(current), kind: "visibility", ...input, reasonProvided: typeof input.reason === "string" && input.reason.trim().length > 0 };
  validateVisibility(event, invalidDecision);
  assertRequestUnused(current, event.requestId);
  if (event.reviewOf) {
    const reviewed = current.events.find((entry) => entry.id === event.reviewOf);
    if (!reviewed || reviewed.kind !== "visibility" || !sameTarget(event.target, reviewed.target)) {
      fail("moderation_review_reference_invalid", 409, "Review the currently retained decision for this exact target incarnation.");
    }
  }
  return admit(current, [...current.events, structuredClone(event)]);
}

export function disposeModerationDecisions(history, input) {
  const current = validateModerationHistory(history);
  exactObject(input, ["eventIds", "reason", "actor", "createdAt", "requestId"], invalidDecision);
  const event = {
    id: nextDecisionId(current), kind: "retention_disposal", createdAt: input.createdAt,
    reason: input.reason, actor: input.actor, requestId: input.requestId,
    disposedEventIds: input.eventIds, disposedCount: Array.isArray(input.eventIds) ? input.eventIds.length : 0,
  };
  validateDisposal(event, invalidDecision);
  assertRequestUnused(current, event.requestId);
  const selected = new Set(input.eventIds);
  const existing = new Set(current.events.map((entry) => entry.id));
  if ([...selected].some((id) => !existing.has(id))) {
    fail("moderation_disposal_target_missing", 409, "One or more selected moderation decisions are no longer retained.");
  }
  return admit(current, [...current.events.filter((entry) => !selected.has(entry.id)), structuredClone(event)], { allowRecoveryReduction: true });
}

export function moderationHistorySummary(history) {
  const current = validateModerationHistory(history);
  return { eventCount: current.events.length, compactBytes: compactBytes(current), maxEvents: MAX_EVENTS, maxBytes: MAX_BYTES };
}
