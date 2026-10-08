import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

export const stateHead = sqliteTable('turnfeed_state_head', {
  id: integer('id').primaryKey(),
  revision: text('revision').notNull(),
  digest: text('digest').notNull(),
  chunks: integer('chunks').notNull(),
  bytes: integer('bytes').notNull(),
  storageFormat: integer('storage_format').notNull().default(1),
});

export const stateChunks = sqliteTable('turnfeed_state_chunks', {
  revision: text('revision').notNull(),
  position: integer('position').notNull(),
  value: text('value').notNull(),
}, (t) => [primaryKey({ columns: [t.revision, t.position] })]);

// Logical records have stable IDs; large records are split below D1 row limits.
export const stateRecords = sqliteTable('turnfeed_state_records', {
  recordId: text('record_id').notNull(),
  part: integer('part').notNull(),
  value: text('value').notNull(),
  digest: text('digest').notNull(),
}, (t) => [primaryKey({ columns: [t.recordId, t.part] })]);

// Append-only replay receipts, loaded for one authenticated owner at a time.
// Count/digest commitments live in the CAS-protected shared state document.
export const writeReceipts = sqliteTable('turnfeed_write_receipts', {
  owner: text('owner').notNull(),
  part: integer('part').notNull(),
  value: text('value').notNull(),
}, (t) => [primaryKey({ columns: [t.owner, t.part] })]);

// File bytes live in R2. Reservations and tombstones stay outside the core snapshot.
export const photos = sqliteTable('turnfeed_photos', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  objectKey: text('object_key').notNull(),
  mime: text('mime').notNull(),
  bytes: integer('bytes').notNull(),
  digest: text('digest').notNull(),
  status: text('status').notNull(),
  claim: text('claim').notNull(),
  createdAt: integer('created_at').notNull(),
  day: text('day').notNull(),
});

export const photoDaily = sqliteTable('turnfeed_photo_daily', {
  owner: text('owner').notNull(),
  day: text('day').notNull(),
  count: integer('count').notNull(),
}, (t) => [primaryKey({ columns: [t.owner, t.day] })]);

// API attempts count even if publication or the external safety check fails.
export const moderationLimits = sqliteTable('turnfeed_moderation_limits', {
  bucket: text('bucket').primaryKey(),
  minute: integer('minute').notNull(),
  count: integer('count').notNull(),
}, (t) => [index('turnfeed_moderation_limits_minute').on(t.minute)]);
