const MAX_PAST_HOURS = 8784;
const HOUR_MS = 60 * 60 * 1000;
const ALLOWED_FIELDS = new Set(["basis", "pastHours", "since", "until"]);
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

function invalidTimeRange(message) {
  const error = new RangeError(message);
  error.code = "invalid_time_range";
  return error;
}

// Date.parse silently rolls some impossible calendar dates into the next month.
// Validate each component before using it to apply the explicit UTC offset.
function parseTimestamp(value) {
  if (typeof value !== "string") return NaN;
  const parts = ISO_TIMESTAMP_RE.exec(value);
  if (!parts) return NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset, , offsetHour, offsetMinute] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText || 0) > 59
    || (offset !== "Z" && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))) return NaN;
  return Date.parse(value);
}

function checkedNow(nowMs) {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
    throw invalidTimeRange("The time range needs a valid current timestamp.");
  }
  return Math.trunc(nowMs);
}

/** Resolve a requested interval once; all boundaries use [since, until). */
export function resolveFeedTimeRange(input, nowMs = Date.now()) {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    || Reflect.ownKeys(input).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw invalidTimeRange("timeRange must contain only basis, pastHours, since, and until.");
  }
  const basis = input.basis === undefined ? "created" : input.basis;
  if (basis !== "created" && basis !== "activity") {
    throw invalidTimeRange("timeRange.basis must be created or activity.");
  }
  const hasPastHours = Object.hasOwn(input, "pastHours");
  const hasSince = Object.hasOwn(input, "since");
  const hasUntil = Object.hasOwn(input, "until");
  if ((hasPastHours && (hasSince || hasUntil)) || (!hasPastHours && !hasSince && !hasUntil)) {
    throw invalidTimeRange("Use either pastHours or at least one of since and until.");
  }
  let sinceMs;
  let untilMs;
  if (hasPastHours) {
    if (typeof input.pastHours !== "number" || !Number.isFinite(input.pastHours)
      || input.pastHours <= 0 || input.pastHours > MAX_PAST_HOURS) {
      throw invalidTimeRange(`timeRange.pastHours must be greater than 0 and at most ${MAX_PAST_HOURS}.`);
    }
    untilMs = checkedNow(nowMs);
    sinceMs = untilMs - input.pastHours * HOUR_MS;
  } else {
    sinceMs = hasSince ? parseTimestamp(input.since) : null;
    untilMs = hasUntil ? parseTimestamp(input.until) : checkedNow(nowMs);
    if ((hasSince && !Number.isFinite(sinceMs)) || !Number.isFinite(untilMs)) {
      throw invalidTimeRange("Time boundaries must be real ISO timestamps with an explicit offset or Z.");
    }
  }
  if ((sinceMs !== null && (!Number.isFinite(new Date(sinceMs).getTime()) || sinceMs >= untilMs))
    || !Number.isFinite(new Date(untilMs).getTime())) {
    throw invalidTimeRange("timeRange.since must be earlier than timeRange.until.");
  }
  const since = sinceMs === null ? "" : new Date(sinceMs).toISOString();
  const until = new Date(untilMs).toISOString();
  // Sub-millisecond relative ranges cannot be represented by stored timestamps.
  if (since && Date.parse(since) >= Date.parse(until)) {
    throw invalidTimeRange("The requested interval is shorter than timestamp precision.");
  }
  return { basis, since, until };
}

/** Check an already resolved range. An omitted range places no time constraint. */
export function timeRangeContainsTimestamp(range, timestamp) {
  if (range === undefined || range === null) return true;
  const timestampMs = typeof timestamp === "number" ? timestamp : parseTimestamp(timestamp);
  const sinceMs = range.since === "" ? -Infinity : parseTimestamp(range.since);
  const untilMs = parseTimestamp(range.until);
  return Number.isFinite(timestampMs) && Number.isFinite(untilMs)
    && (sinceMs === -Infinity || Number.isFinite(sinceMs))
    && timestampMs >= sinceMs && timestampMs < untilMs;
}

const UNIT_PATTERN = "minutes?|mins?|hours?|hrs?|days?|weeks?|minutt(?:er|ene)?|time(?:r|ne)?|dag(?:er|ene)?|døgn|uke(?:r|ne)?";
const ROLLING_PATTERN = new RegExp(`\\b(?:last|past|previous|siste)\\s+([+-]?\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`, "giu");
const COMPOUND_PATTERN = new RegExp(`\\b(?:and|or|og|eller)\\s+[+-]?\\d+(?:[.,]\\d+)?\\s*(?:${UNIT_PATTERN})\\b`, "iu");
const UNRESOLVED_ROLLING_PATTERN = new RegExp(`\\b(?:last|past|previous|siste|forrige)\\s+(?:[^\\s]+\\s+){0,3}(?:${UNIT_PATTERN}|months?|years?|måneder?|år)\\b`, "iu");
const CALENDAR_PATTERN = /\b(?:today|yesterday|tonight|tomorrow|this\s+(?:morning|afternoon|evening|week|month|year)|(?:last|previous|this|next)\s+(?:night|morning|afternoon|evening|weekend|spring|summer|autumn|fall|winter)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|i\s+(?:dag|går|morgen)|denne\s+(?:uken|måneden|helgen)|forrige\s+(?:uke|måned|helg)|mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\b/iu;
const DATE_PATTERN = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/]\d{1,2}(?:[/]\d{2,4})?|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}|\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))\b/iu;
const BOUNDARY_PATTERN = /\b(?:since|until|siden|frem\s+til)\b|\b(?:before|after|between|før|etter|mellom)\s+(?:\d|last\b|past\b|this\b|forrige\b|kl(?:okken)?[.\s])/iu;
const ACTIVITY_PATTERN = /\b(?:active|activity|replied|replies|commented|comments|discussed|reacted|updated|aktiv[et]?|aktivitet|svart|kommentarer)\b/iu;

function hoursForUnit(unit) {
  if (/^(?:min|minutt)/u.test(unit)) return 1 / 60;
  if (/^(?:hour|hr|time)/u.test(unit)) return 1;
  if (/^(?:day|dag|døgn)/u.test(unit)) return 24;
  return 7 * 24;
}

/**
 * Bounded fallback for natural-language calls without structured timeRange.
 * Calendar language is deliberately unresolved: the caller must obtain explicit
 * timezone-aware boundaries rather than silently using a rolling 24-hour day.
 */
export function inferFeedTimeRangeFromText(text, { nowMs = Date.now(), timeZone } = {}) {
  if (typeof text !== "string" || !text.trim()) return { status: "none" };
  const normalized = text.normalize("NFKC").toLowerCase();
  const rolling = [...normalized.matchAll(ROLLING_PATTERN)];
  const calendar = CALENDAR_PATTERN.exec(normalized);
  const date = DATE_PATTERN.exec(normalized);
  const boundary = BOUNDARY_PATTERN.exec(normalized);
  if (calendar || date || boundary || rolling.length > 1 || COMPOUND_PATTERN.test(normalized)) {
    return {
      status: "needs_clarification",
      reason: calendar
        ? `Calendar periods need explicit since/until boundaries${timeZone ? ` in ${timeZone}` : " and a timezone"}.`
        : "Specify one time interval using pastHours or explicit since/until timestamps.",
      matchedText: (calendar || date || boundary || rolling[0])?.[0] || "",
    };
  }
  if (rolling.length === 1) {
    const match = rolling[0];
    const basis = ACTIVITY_PATTERN.test(normalized) ? "activity" : "created";
    const timeRangeInput = { basis, pastHours: Number(match[1].replace(",", ".")) * hoursForUnit(match[2]) };
    try {
      return {
        status: "resolved",
        timeRange: resolveFeedTimeRange(timeRangeInput, nowMs),
        timeRangeInput,
        matchedText: match[0],
      };
    } catch (error) {
      if (error.code !== "invalid_time_range") throw error;
      return { status: "invalid", reason: error.message, matchedText: match[0] };
    }
  }
  const unresolvedRolling = UNRESOLVED_ROLLING_PATTERN.exec(normalized);
  if (unresolvedRolling) {
    return {
      status: "needs_clarification",
      reason: "Use a numeric rolling interval in minutes, hours, days, or weeks, or explicit since/until timestamps.",
      matchedText: unresolvedRolling[0],
    };
  }
  return { status: "none" };
}
