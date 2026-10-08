import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const PLAN_LIFETIME_MS = 10 * 60_000;
const TOKEN_EXPIRY_MARGIN_MS = 5_000;
const PLAN_MAX_BYTES = 32_768;
const PURPOSE = "private_operator_app_data_erasure";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const HIGH_WATER_MARK_KEYS = ["nextPostId", "nextReplyId", "nextReportId", "nextGroupId", "nextFollowEventId", "nextInviteEventId", "nextLikeEventId"];
const INPUT_KEYS = ["store", "userId", "identityLabel", "caseId", "providerAccessEvidence", "retainedRecordsReason", "signingKey", "now"];
const PLAN_KEYS = ["schemaVersion", "purpose", "target", "caseId", "providerAccessEvidence", "providerEvidenceVerification", "retainedRecordsReason", "createdAt", "expiresAt", "applyAfter", "storeDigest", "scope", "confirmationPhrase", "signature"];

function fail(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

const invalid = (message) => fail("operator_erasure_invalid", 400, message);

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected a plain data object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid("Expected a plain data object.");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
      invalid("Only enumerable plain data fields are accepted.");
    }
  }
}

function exactObject(value, keys, optionalKeys = []) {
  plainObject(value);
  const ownKeys = Object.keys(value);
  if (keys.some((key) => !Object.hasOwn(value, key)) || ownKeys.some((key) => !keys.includes(key) && !optionalKeys.includes(key))) {
    invalid("Missing or unexpected operator erasure fields.");
  }
}

// Stream canonical JSON into the digest rather than allocating a second store.
// Root updatedAt is excluded: buildStoreSnapshot creates it on every read.
function canonicalDigest(value, { signingKey, store = false } = {}) {
  const digest = signingKey === undefined ? createHash("sha256") : createHmac("sha256", signingKey);
  digest.update(store ? "turnfeed-operator-erasure-store-v1|" : "turnfeed-operator-erasure-plan-v1|");
  const maxBytes = store ? 128 * 1024 * 1024 : PLAN_MAX_BYTES;
  const maxNodes = store ? 2_000_000 : 5_000;
  const maxDepth = store ? 128 : 16;
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set();
  const emit = (text) => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) invalid("Operator erasure data exceeds its byte limit.");
    digest.update(text);
  };
  function visit(item, depth) {
    if (++nodes > maxNodes || depth > maxDepth) invalid("Operator erasure data exceeds its structural limit.");
    if (item === null || typeof item === "boolean") return emit(JSON.stringify(item));
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid("Operator erasure data must contain finite JSON values.");
      return emit(JSON.stringify(item));
    }
    if (typeof item === "string") {
      if (item.length > maxBytes) invalid("Operator erasure data exceeds its byte limit.");
      return emit(JSON.stringify(item));
    }
    if (!item || typeof item !== "object" || ancestors.has(item)) invalid("Operator erasure data must be acyclic JSON.");
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > maxNodes || Reflect.ownKeys(item).length !== item.length + 1) {
        invalid("Operator erasure lists must be bounded plain arrays.");
      }
      emit("[");
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) invalid("Operator erasure lists cannot contain holes or accessors.");
        if (index) emit(",");
        visit(descriptor.value, depth + 1);
      }
      emit("]");
    } else {
      plainObject(item);
      const keys = Object.keys(item).filter((key) => !(store && depth === 0 && key === "updatedAt")).sort();
      emit("{");
      for (let index = 0; index < keys.length; index += 1) {
        if (index) emit(",");
        emit(JSON.stringify(keys[index]));
        emit(":");
        visit(item[keys[index]], depth + 1);
      }
      emit("}");
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  return digest.digest("hex");
}

function boundedText(value, label, max, { empty = false } = {}) {
  if (typeof value !== "string" || value.length > max || value !== value.trim() || CONTROL_CHARACTERS.test(value) || (!empty && !value)) {
    invalid(`${label} must be bounded text without surrounding whitespace or control characters.`);
  }
}

function validateUserId(userId) {
  if (typeof userId !== "string" || !/^[a-f0-9]{40}$/.test(userId)) invalid("An exact verified OAuth internal user ID is required.");
}

function validateIdentity(identityLabel) {
  exactObject(identityLabel, ["displayName", "handle"]);
  boundedText(identityLabel.displayName, "Display name", 160, { empty: true });
  boundedText(identityLabel.handle, "Handle", 80, { empty: true });
  if (!identityLabel.displayName && !identityLabel.handle) invalid("A current readable identity is required.");
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid("Times must be canonical UTC ISO strings.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid("Invalid operator erasure time.");
  return parsed;
}

function clockTime(now) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - PLAN_LIFETIME_MS) invalid("A valid current time in milliseconds is required.");
  return now;
}

function validateSigningKey(signingKey) {
  if (!(typeof signingKey === "string" || Buffer.isBuffer(signingKey)) || Buffer.byteLength(signingKey) < 32 || Buffer.byteLength(signingKey) > 4_096) {
    fail("operator_erasure_unavailable", 503, "Operator erasure requires a bounded signing key of at least 32 bytes.");
  }
}

function validateRequestFields({ userId, identityLabel, caseId, providerAccessEvidence, retainedRecordsReason }, now) {
  validateUserId(userId);
  validateIdentity(identityLabel);
  if (typeof caseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(caseId)) invalid("A case reference of at most 80 characters is required.");
  exactObject(providerAccessEvidence, ["issuanceStoppedAt", "latestPossibleTokenExpiryAt", "evidenceRef", "confirmed"]);
  if (providerAccessEvidence.confirmed !== true) invalid("The operator must attest to provider access evidence.");
  const stopped = timestamp(providerAccessEvidence.issuanceStoppedAt);
  const expired = timestamp(providerAccessEvidence.latestPossibleTokenExpiryAt);
  if (expired < stopped || stopped > now || expired > now) invalid("Provider evidence times must be ordered and no later than the current time.");
  const reference = providerAccessEvidence.evidenceRef;
  if (typeof reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,159}$/.test(reference) || /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(reference)) {
    invalid("Provider evidence must be a short record reference, never a credential or token.");
  }
  boundedText(retainedRecordsReason, "Retained-records reason", 1_000);
  return expired;
}

function assertCurrentIdentity(store, userId, identityLabel) {
  const profile = store.profiles?.[userId];
  if (!profile || (profile.displayName || "") !== identityLabel.displayName || (profile.handle || "") !== identityLabel.handle) {
    fail("operator_erasure_identity_mismatch", 409, "The exact current readable identity does not match this target.");
  }
}

const list = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("Expected a store list.");
  return value;
};
const record = (value) => {
  if (value === undefined) return {};
  plainObject(value);
  return value;
};
const countValue = (values, value) => list(values).filter((entry) => entry === value).length;

function summarizeScope(store, userId) {
  const posts = list(store.posts);
  const groups = list(store.groups);
  const reports = list(store.reports).filter(Boolean);
  const removedGroups = new Set(groups.filter((group) => group.createdBy === userId).map((group) => group.id));
  const removedPosts = new Set();
  const removedReplies = new Set();
  const removal = {
    profileRecords: Object.hasOwn(record(store.profiles), userId) ? 1 : 0,
    settingsRecords: Object.hasOwn(record(store.viewerStates), userId) ? 1 : 0,
    userListEntries: countValue(store.users, userId),
    ownedGroups: removedGroups.size,
    ownedPosts: 0,
    otherAuthorsPostsInOwnedGroups: 0,
    ownedReplies: 0,
    otherAuthorsRepliesRemovedWithParents: 0,
    membershipsInSurvivingGroups: 0,
    invitesInSurvivingGroups: 0,
    outgoingFollowEdges: list(record(store.follows)[userId]).length,
    incomingFollowEdges: 0,
    outgoingBlockEdges: list(record(store.blocks)[userId]).length,
    likesOnSurvivingContent: 0,
    followEvents: list(store.followEvents).filter((event) => event && (event.actorId === userId || event.targetId === userId)).length,
    inviteEvents: list(store.inviteEvents).filter((event) => event && (event.actorId === userId || event.targetId === userId)).length,
    likeEvents: 0,
    notificationSuppressionEntries: 0,
    reportReceiptsDetached: reports.filter((report) => report.reporterId === userId).length,
    publicWriteReceipts: list(record(store.writeReceipts?.owners)[userId]).length,
  };
  function walkReplies(replies, parentRemoved) {
    for (const reply of list(replies)) {
      const removed = parentRemoved || reply.authorId === userId;
      if (removed) {
        removedReplies.add(reply.id);
        if (reply.authorId === userId) removal.ownedReplies += 1;
        else removal.otherAuthorsRepliesRemovedWithParents += 1;
      } else removal.likesOnSurvivingContent += countValue(reply.likedBy, userId);
      walkReplies(reply.replies, removed);
    }
  }
  for (const post of posts) {
    const removed = post.authorId === userId || Boolean(post.groupId && removedGroups.has(post.groupId));
    if (removed) {
      removedPosts.add(post.id);
      if (post.authorId === userId) removal.ownedPosts += 1;
      else removal.otherAuthorsPostsInOwnedGroups += 1;
    } else removal.likesOnSurvivingContent += countValue(post.likedBy, userId);
    walkReplies(post.replies, removed);
  }
  for (const group of groups) {
    if (removedGroups.has(group.id)) continue;
    removal.membershipsInSurvivingGroups += countValue(group.members, userId);
    removal.invitesInSurvivingGroups += countValue(group.invites, userId);
  }
  for (const [owner, targets] of Object.entries(record(store.follows))) {
    if (owner !== userId) removal.incomingFollowEdges += countValue(targets, userId);
  }
  for (const [owner, cutoffs] of Object.entries(record(store.notificationSuppressionCutoffs))) {
    const entries = Object.keys(record(cutoffs));
    removal.notificationSuppressionEntries += owner === userId ? entries.length : Number(entries.includes(userId));
  }
  removal.likeEvents = list(store.likeEvents).filter((event) => event && (
    event.actorId === userId || event.targetId === userId || removedPosts.has(event.postId) || removedReplies.has(event.replyId)
  )).length;
  const matchesRemovedContent = (entry) => removedPosts.has(entry?.postId) || removedReplies.has(entry?.replyId);
  const eventsSubscriptions = list(store.mcpEvents?.subscriptions).filter((sub) => sub.owner === userId);
  const eventsSubscriptionIds = new Set(eventsSubscriptions.map((sub) => sub.id));
  removal.replyEventSubscriptions = eventsSubscriptions.length;
  removal.replyEventDeliveries = list(store.mcpEvents?.outbox).filter((entry) => eventsSubscriptionIds.has(entry.subscriptionId) || matchesRemovedContent(entry)).length;
  const moderationEvents = list(store.moderationHistory?.events);
  const highWaterMarks = Object.fromEntries(HIGH_WATER_MARK_KEYS.map((key) => [key, store[key]]));
  highWaterMarks.moderationHistoryNextId = store.moderationHistory?.nextId;
  if (Object.values(highWaterMarks).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    invalid("Every numeric identifier high-water mark must be a positive safe integer.");
  }
  return {
    highWaterMarks,
    ordinaryDataRemoval: removal,
    retainedEvidence: {
      reportRowsTotal: reports.length,
      reportRowsMatchingRemovedContentIds: reports.filter(matchesRemovedContent).length,
      reporterDedupeKeysTotal: reports.filter((report) => Boolean(report.reporterDedupeKey)).length,
      reporterDedupeKeysOnCurrentlyAttributedReports: reports.filter((report) => report.reporterId === userId && report.reporterDedupeKey).length,
      incomingBlockEdges: Object.entries(record(store.blocks)).reduce((total, [owner, targets]) => total + (owner === userId ? 0 : countValue(targets, userId)), 0),
      incomingMuteEdges: Object.entries(record(store.viewerStates)).reduce((total, [owner, state]) => total + (owner === userId ? 0 : countValue(state?.mutedUserIds, userId)), 0),
      moderationHistoryEventsTotal: moderationEvents.length,
      moderationHistoryEventsMatchingRemovedContentIds: moderationEvents.filter((event) => matchesRemovedContent(event?.target)).length,
      countsAreInformational: true,
      identifierMatchesMayIncludeHistoricalIncarnations: true,
      retainedRecordsMayContainPersonalData: true,
    },
    retentionNotice: "Report rows, reporter deduplication keys, incoming blocks and mutes owned by others, and moderation history remain. Reporter receipts are detached. Retained records may contain historical identity labels and content. Counts are informational, not a legal retention determination.",
  };
}

export function summarizeOperatorErasureScope({ store, userId }) {
  validateUserId(userId);
  plainObject(store);
  canonicalDigest(store, { store: true });
  return summarizeScope(store, userId);
}

function unsignedPlan(input, now) {
  const { store, userId, identityLabel, caseId, providerAccessEvidence, retainedRecordsReason } = input;
  const expiry = validateRequestFields(input, now);
  plainObject(store);
  const storeDigest = canonicalDigest(store, { store: true });
  assertCurrentIdentity(store, userId, identityLabel);
  return {
    schemaVersion: 1,
    purpose: PURPOSE,
    target: { userId, identityLabel: { ...identityLabel } },
    caseId,
    providerAccessEvidence: { ...providerAccessEvidence },
    providerEvidenceVerification: "operator_attestation_only",
    retainedRecordsReason,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PLAN_LIFETIME_MS).toISOString(),
    applyAfter: new Date(expiry + TOKEN_EXPIRY_MARGIN_MS).toISOString(),
    storeDigest,
    scope: summarizeScope(store, userId),
    confirmationPhrase: `ERASE APP DATA ${userId} CASE ${caseId}`,
  };
}

export function buildOperatorErasurePlan(input) {
  exactObject(input, INPUT_KEYS.filter((key) => key !== "now"), ["now"]);
  validateSigningKey(input.signingKey);
  const plan = unsignedPlan(input, clockTime(input.now ?? Date.now()));
  return { ...plan, signature: canonicalDigest(plan, { signingKey: input.signingKey }) };
}

export function validateOperatorErasureApply(input) {
  exactObject(input, ["store", "plan", "confirmation", "signingKey"], ["now"]);
  const { store, plan, confirmation, signingKey } = input;
  validateSigningKey(signingKey);
  const now = clockTime(input.now ?? Date.now());
  // Validate plain bounded JSON before reading any nested untrusted fields.
  canonicalDigest(plan);
  exactObject(plan, PLAN_KEYS);
  exactObject(plan.target, ["userId", "identityLabel"]);
  if (typeof plan.signature !== "string" || !/^[a-f0-9]{64}$/.test(plan.signature)) invalid("Invalid operator erasure signature.");
  const { signature, ...unsigned } = plan;
  const expectedSignature = canonicalDigest(unsigned, { signingKey });
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedSignature, "hex"))) {
    fail("operator_erasure_signature_invalid", 409, "The operator erasure plan has changed or its signing key is no longer valid.");
  }
  const createdAt = timestamp(plan.createdAt);
  const expiresAt = timestamp(plan.expiresAt);
  if (createdAt > now || expiresAt !== createdAt + PLAN_LIFETIME_MS || now >= expiresAt) {
    fail("operator_erasure_plan_expired", 409, "The operator erasure plan is expired or has invalid validity times. Prepare a new plan.");
  }
  const expiry = validateRequestFields({ ...plan.target, caseId: plan.caseId, providerAccessEvidence: plan.providerAccessEvidence, retainedRecordsReason: plan.retainedRecordsReason }, createdAt);
  if (timestamp(plan.applyAfter) !== expiry + TOKEN_EXPIRY_MARGIN_MS || now < expiry + TOKEN_EXPIRY_MARGIN_MS) {
    fail("operator_erasure_tokens_not_expired", 409, "Wait until every possible provider token has expired plus the five-second margin.");
  }
  if (typeof confirmation !== "string" || confirmation !== plan.confirmationPhrase) {
    fail("operator_erasure_confirmation_required", 400, "The exact confirmation phrase from the private plan is required.");
  }
  plainObject(store);
  if (canonicalDigest(store, { store: true }) !== plan.storeDigest) {
    fail("operator_erasure_plan_stale", 409, "The operator erasure plan no longer matches the current store. Prepare a new plan.");
  }
  const current = unsignedPlan({ store, ...plan.target, caseId: plan.caseId, providerAccessEvidence: plan.providerAccessEvidence, retainedRecordsReason: plan.retainedRecordsReason }, createdAt);
  if (canonicalDigest(current) !== canonicalDigest(unsigned)) {
    fail("operator_erasure_plan_stale", 409, "The operator erasure plan no longer matches the current store. Prepare a new plan.");
  }
  // This validates a single current state, not persistent idempotency. The caller
  // must validate and clear data together in its existing mutation transaction.
  return {
    userId: plan.target.userId,
    identityLabel: { ...plan.target.identityLabel },
    caseId: plan.caseId,
    providerEvidenceVerification: plan.providerEvidenceVerification,
    retainedRecordsReason: plan.retainedRecordsReason,
    scope: structuredClone(plan.scope),
  };
}
