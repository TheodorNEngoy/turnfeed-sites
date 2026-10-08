import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import { reserveModerationAttempt } from '../worker/moderation-limit.mjs';
import { createModerator, ModerationError } from '../worker/moderation.mjs';

const actor = n => n.toString(16).padStart(40, '0');
const limited = error => error instanceof ModerationError && error.code === 'moderation_rate_limited' && error.status === 429;
const unavailable = error => error instanceof ModerationError && error.code === 'moderation_unavailable' && error.status === 503;
const count = (db, bucket) => db.sql.prepare('SELECT count FROM turnfeed_moderation_limits WHERE bucket = ?').get(bucket)?.count;
const fixture = t => { const db = database(); t.after(() => db.sql.close()); return db; };
const approved = () => Response.json({ results: [{ flagged: false, categories: Object.fromEntries([
  'harassment', 'harassment/threatening', 'hate', 'hate/threatening', 'illicit', 'illicit/violent',
  'self-harm', 'self-harm/intent', 'self-harm/instructions', 'sexual', 'sexual/minors', 'violence', 'violence/graphic',
].map(key => [key, false])) }] });

test('the actor limit is exactly 30, is isolated, and denied actors do not consume global allowance', async t => {
  const db = fixture(t), now = 120_001;
  for (let i = 0; i < 30; i++) await reserveModerationAttempt({ db, actor: actor(1), now });
  for (let i = 0; i < 3; i++) await assert.rejects(reserveModerationAttempt({ db, actor: actor(1), now }), error => {
    assert.equal(error.retryAfterSec, 60);
    return limited(error);
  });
  assert.equal(count(db, `actor:${actor(1)}`), 30);
  assert.equal(count(db, 'global'), 30);
  await reserveModerationAttempt({ db, actor: actor(2), now });
  assert.equal(count(db, `actor:${actor(2)}`), 1);
  assert.equal(count(db, 'global'), 31);
});

test('concurrent different requests obey both exact limits, then roll over and remove expired rows', async t => {
  const db = fixture(t), now = 120_000;
  const ownerResults = await Promise.allSettled(Array.from({ length: 40 }, () => reserveModerationAttempt({ db, actor: actor(1), now })));
  assert.equal(ownerResults.filter(result => result.status === 'fulfilled').length, 30);
  assert.ok(ownerResults.filter(result => result.status === 'rejected').every(result => limited(result.reason)));
  const otherResults = await Promise.allSettled(Array.from({ length: 300 }, (_, i) => reserveModerationAttempt({ db, actor: actor(2 + Math.floor(i / 30)), now })));
  assert.equal(otherResults.filter(result => result.status === 'fulfilled').length, 270);
  assert.ok(otherResults.filter(result => result.status === 'rejected').every(result => limited(result.reason)));
  assert.equal(count(db, 'global'), 300);
  assert.equal(db.sql.prepare("SELECT MAX(count) AS count FROM turnfeed_moderation_limits WHERE bucket != 'global'").get().count, 30);
  await reserveModerationAttempt({ db, actor: actor(1), now: 180_000 });
  assert.equal(count(db, 'global'), 1);
  assert.equal(count(db, `actor:${actor(1)}`), 1);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS count FROM turnfeed_moderation_limits').get().count, 2);
  await assert.rejects(reserveModerationAttempt({ db, actor: actor(1), now }), limited);
  assert.equal(count(db, 'global'), 1, 'a stale request cannot reset the newer minute');
});

test('actor churn cannot exceed 4096 rows or consume the reserved global row, and expired rows are reusable', async t => {
  const db = fixture(t), now = 120_000;
  const insert = db.sql.prepare('INSERT INTO turnfeed_moderation_limits (bucket, minute, count) VALUES (?, 2, 1)');
  db.sql.exec('BEGIN');
  for (let i = 1; i <= 4095; i++) insert.run(`actor:${actor(i)}`);
  db.sql.exec('COMMIT');
  await assert.rejects(reserveModerationAttempt({ db, actor: actor(4096), now }), limited);
  assert.equal(count(db, 'global'), undefined);
  await reserveModerationAttempt({ db, actor: actor(1), now });
  assert.equal(count(db, 'global'), 1);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS count FROM turnfeed_moderation_limits').get().count, 4096);
  await reserveModerationAttempt({ db, actor: actor(4096), now: 180_000 });
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS count FROM turnfeed_moderation_limits').get().count, 2);
});

test('API failures retain their durable allowance and the next blocked call never reaches the API', async t => {
  const db = fixture(t);
  let requests = 0;
  const check = createModerator('local-test-only', {
    beforeRequest: () => reserveModerationAttempt({ db, actor: actor(1), now: 120_000 }),
    fetcher: async () => { requests++; return new Response('', { status: 429 }); },
  });
  for (let i = 0; i < 30; i++) await assert.rejects(check({ texts: [`Candidate ${i}`] }), unavailable);
  await assert.rejects(check({ texts: ['Another candidate'] }), limited);
  assert.equal(requests, 30);
  assert.equal(count(db, `actor:${actor(1)}`), 30);
  assert.equal(count(db, 'global'), 30);
});

test('only actual API attempts count: invalid input, missing credentials and cached approvals skip the hook', async t => {
  const db = fixture(t);
  let requests = 0;
  const options = {
    beforeRequest: () => reserveModerationAttempt({ db, actor: actor(1), now: 120_000 }),
    fetcher: async () => { requests++; return approved(); },
  };
  const check = createModerator('local-test-only', options);
  await check({ texts: [] });
  await assert.rejects(check({ texts: ['x'.repeat(8193)] }), unavailable);
  await assert.rejects(createModerator('', options)({ texts: ['Candidate'] }), unavailable);
  assert.equal(count(db, 'global'), undefined);
  await check({ texts: ['Candidate'] });
  await check({ texts: ['Candidate'] });
  assert.equal(count(db, 'global'), 1);
  await check({ texts: ['Changed candidate'] });
  await createModerator('local-test-only', options)({ texts: ['Candidate'] });
  assert.equal(count(db, 'global'), 3);
  assert.equal(requests, 3);
});

test('storage errors fail closed and a timed-out reservation cannot dispatch a late API request', async () => {
  let requests = 0;
  const fetcher = async () => { requests++; return approved(); };
  const db = { prepare() { throw new Error('private storage detail'); } };
  await assert.rejects(createModerator('local-test-only', {
    fetcher, beforeRequest: () => reserveModerationAttempt({ db, actor: actor(1) }),
  })({ texts: ['Candidate'] }), unavailable);
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  await assert.rejects(createModerator('local-test-only', {
    fetcher, timeoutMs: 5, beforeRequest: () => delayed,
  })({ texts: ['Candidate'] }), unavailable);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
});
