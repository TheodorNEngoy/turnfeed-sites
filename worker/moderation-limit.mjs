import { ModerationError } from './moderation.mjs';

const WINDOW_MS = 60_000;
const OWNER_LIMIT = 30;
const GLOBAL_LIMIT = 300;
const MAX_ROWS = 4096;

async function run(db, sql, values) {
  try {
    const result = await db.prepare(sql).bind(...values).run();
    if (result?.success !== true || !Number.isSafeInteger(result.meta?.changes) || result.meta.changes < 0) {
      throw new ModerationError();
    }
    return result.meta.changes;
  } catch (error) {
    if (error instanceof ModerationError) throw error;
    throw new ModerationError();
  }
}

// Each UPSERT atomically checks and consumes one allowance. This table is
// independent of social-content commits, so rejected/failed checks still count.
// An actor denied by its own limit never consumes the global allowance.
export async function reserveModerationAttempt({ db, actor, now = Date.now() }) {
  if (!db?.prepare || typeof actor !== 'string' || !/^[a-f0-9]{40}$/.test(actor)
      || !Number.isSafeInteger(now) || now < 0) throw new ModerationError();
  const minute = Math.floor(now / WINDOW_MS);
  const limited = () => {
    const error = new ModerationError('moderation_rate_limited');
    error.retryAfterSec = Math.max(1, Math.ceil(((minute + 1) * WINDOW_MS - now) / 1000));
    throw error;
  };
  await run(db, 'DELETE FROM turnfeed_moderation_limits WHERE minute < ?', [minute]);
  for (const [bucket, limit, capacity] of [[`actor:${actor}`, OWNER_LIMIT, MAX_ROWS - 1], ['global', GLOBAL_LIMIT, MAX_ROWS]]) {
    // Reserve a row for the global counter even when actor churn reaches cap.
    const countedRows = bucket === 'global' ? '' : " WHERE bucket != 'global'";
    const changed = await run(db, `INSERT INTO turnfeed_moderation_limits (bucket, minute, count)
      SELECT ?, ?, 1 WHERE EXISTS (SELECT 1 FROM turnfeed_moderation_limits WHERE bucket = ?)
        OR (SELECT COUNT(*) FROM turnfeed_moderation_limits${countedRows}) < ?
      ON CONFLICT(bucket) DO UPDATE SET
        count = CASE WHEN turnfeed_moderation_limits.minute < excluded.minute THEN 1 ELSE turnfeed_moderation_limits.count + 1 END,
        minute = excluded.minute
      WHERE turnfeed_moderation_limits.minute < excluded.minute
        OR (turnfeed_moderation_limits.minute = excluded.minute AND turnfeed_moderation_limits.count < ?)`,
    [bucket, minute, bucket, capacity, limit]);
    if (changed !== 1) limited();
  }
}
