import { invoke, MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';
import { startActivityAlerts } from '../worker/activity.mjs';
import { database } from './sqlite-d1.mjs';

import { readState, commitState } from '../worker/storage.mjs';
import { accountKey } from '../worker/identity.mjs';

installModerationFixture();

const origin = 'https://turnfeed-activity.example';
const secret = 'local-activity-test-012345678901234567890123456789';
const envFor = DB => ({ DB, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret });
async function rpc(db, subject, name, args = {}) {
  const result = await invoke({ db, origin, secret, subject, name, args, callerKey: subject });
  assert.ok(!result.rpcError && result.result?.structuredContent?.ok !== false, JSON.stringify(result));
  return result.result.structuredContent;
}
async function summary(db, subject = 'alice', extra = {}) {
  return worker.fetch(new Request(origin + '/activity/summary', { headers: {
    ...(subject ? { 'oai-authenticated-user-id': subject } : {}), ...extra,
  } }), envFor(db));
}
async function fixture(db) {
  const post = await rpc(db, 'alice', 'create_post', { text: 'Which book deserves a second reading?', visibility: 'public', clientId: 'activity-post' });
  const context = await rpc(db, 'bob', 'get_thread_context', { postId: post.postId });
  await rpc(db, 'bob', 'publish_public_reply_to_post', { ...context.replyHandoff.targetArguments,
    text: 'I enjoyed rereading The Hobbit.', visibility: 'public', clientId: 'activity-reply' });
  return post;
}

test('summary is private, minimal, stable and does not mutate stored data', async () => {
  const db = database();
  await fixture(db);
  const before = (await readState(db)).revision;
  const firstResponse = await summary(db);
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
  const first = await firstResponse.json(), again = await (await summary(db)).json();
  assert.equal(first.keys.length, 1);
  assert.deepEqual(first.keys, again.keys);
  assert.match(first.keys[0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /Hobbit|bob|postId|authorName/);
  assert.equal((await readState(db)).revision, before);
  const page = await worker.fetch(new Request(origin + '/activity', { headers: { 'oai-authenticated-user-id': 'alice' } }), envFor(db));
  const html = await page.text();
  const baseline = JSON.parse(html.match(/data-activity-baseline="([^"]+)"/)[1].replaceAll('&quot;', '"'));
  assert.deepEqual(baseline, first);
  const native = await rpc(db, 'alice', 'open_turnfeed_inbox', {});
  assert.equal(native.webActivityBaseline, undefined);
  const other = await (await summary(db, 'charlie')).json();
  assert.deepEqual(other.keys, []);
  assert.notEqual(other.scope, first.scope);
  assert.equal((await summary(db, '')).status, 401);
  assert.equal((await summary(db, 'alice', { origin: 'https://other.example' })).status, 403);
  assert.equal((await summary(db, 'alice', { 'sec-fetch-site': 'cross-site' })).status, 403);
  db.sql.close();
});

test('activity summary respects preferences, mute and closed-account access', async () => {
  const db = database();
  await fixture(db);
  assert.equal((await (await summary(db)).json()).keys.length, 1);
  await rpc(db, 'alice', 'update_my_settings', { addHiddenWords: ['Hobbit'] });
  assert.deepEqual((await (await summary(db)).json()).keys, []);
  await rpc(db, 'alice', 'update_my_settings', { clearHiddenWords: true });
  const inbox = await rpc(db, 'alice', 'open_turnfeed_inbox', { notificationOrder: 'latest' });
  const other = inbox.notifications[0];
  await rpc(db, 'alice', 'mute_user', { targetRef: other.actorTargetRef, targetLabel: other.actorName, action: 'mute' });
  assert.deepEqual((await (await summary(db)).json()).keys, []);
  const loaded = await readState(db);
  const actor = accountKey('alice', secret);
  await commitState(db, loaded.revision, { ...loaded.value, operator: { ...loaded.value.operator, revoked: { [actor]: { closedAt: new Date().toISOString() } } } });
  assert.equal((await summary(db)).status, 403);
  db.sql.close();
});

test('self replies do not generate alerts, and only signed-in pages load the script', async () => {
  const db = database();
  const post = await rpc(db, 'alice', 'create_post', { text: 'What did you read this weekend?', visibility: 'public', clientId: 'self-post' });
  await rpc(db, 'alice', 'publish_public_reply_to_post', { ...post.replyHandoff.targetArguments,
    text: 'I started a new novel.', visibility: 'public', clientId: 'self-reply' });
  assert.deepEqual((await (await summary(db)).json()).keys, []);
  const signedIn = await worker.fetch(new Request(origin + '/', { headers: { 'oai-authenticated-user-id': 'alice' } }), envFor(db));
  assert.match(signedIn.headers.get('content-security-policy'), /script-src 'self'; connect-src 'self'/);
  assert.match(await signedIn.text(), /src="\/assets\/activity.js" defer/);
  const signedOut = await worker.fetch(new Request(origin + '/'), envFor(db));
  assert.doesNotMatch(await signedOut.text(), /src="\/assets\/activity.js"/);
  const script = await worker.fetch(new Request(origin + '/assets/activity.js'), {});
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  db.sql.close();
});

// A small deterministic browser harness verifies actual scheduling, storage,
// and visibility behavior without a browser install or network calls.
function browserHarness({ stored, baseline = null } = {}) {
  let now = 100_000, nextId = 0, payload = { scope: 'a'.repeat(64), keys: [] }, status = 200;
  const timers = new Map(), docEvents = {}, winEvents = {}, nodes = {
    'new-activity': { hidden: true }, 'new-activity-notice': { hidden: true },
  };
  let calls = 0;
  const doc = { visibilityState: 'visible', body: { dataset: { activityBaseline: JSON.stringify(baseline) } },
    getElementById: id => nodes[id], addEventListener: (name, fn) => { docEvents[name] = fn; } };
  const win = { AbortController, sessionStorage: {
    getItem: () => stored || null, setItem: (_key, value) => { stored = value; }, removeItem: () => { stored = null; },
  }, setTimeout: (fn, delay) => { timers.set(++nextId, { fn, at: now + delay }); return nextId; },
  clearTimeout: id => timers.delete(id), addEventListener: (name, fn) => { winEvents[name] = fn; },
  fetch: async (url, options) => { calls++; assert.equal(url, '/activity/summary'); assert.equal(options.credentials, 'same-origin');
    if (status === 0) throw new Error('offline');
    return { status, ok: status === 200, json: async () => structuredClone(payload) }; },
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { doc, win, nodes, docEvents, winEvents, settle,
    setData: value => { payload = { ...payload, ...value }; }, setStatus: value => { status = value; },
    clock: () => now, calls: () => calls, stored: () => stored,
    async advance(ms) { now += ms; const due = [...timers].filter(([, value]) => value.at <= now);
      for (const [id, value] of due) { timers.delete(id); value.fn(); } await settle(); },
  };
}

test('browser detects new events without reloading and clears only on latest Activity', async () => {
  const b = browserHarness(), originalNow = Date.now;
  Date.now = b.clock;
  try {
    startActivityAlerts(b.win, b.doc); await b.settle();
    assert.equal(b.nodes['new-activity'].hidden, true);
    b.setData({ keys: ['b'.repeat(64)] });
    await b.advance(60_000);
    assert.equal(b.nodes['new-activity'].hidden, false);
    assert.equal(b.nodes['new-activity-notice'].hidden, false);
    const next = browserHarness({ stored: b.stored(), baseline: { scope: 'a'.repeat(64), keys: ['b'.repeat(64)] } });
    Date.now = next.clock;
    next.setData({ keys: ['b'.repeat(64)] });
    startActivityAlerts(next.win, next.doc); await next.settle();
    assert.equal(next.nodes['new-activity'].hidden, true);
    // An event after the rendered Activity page must not be silently acknowledged.
    const racing = browserHarness({ stored: b.stored(), baseline: { scope: 'a'.repeat(64), keys: ['b'.repeat(64)] } });
    Date.now = racing.clock;
    racing.setData({ keys: ['b'.repeat(64), 'c'.repeat(64)] });
    startActivityAlerts(racing.win, racing.doc); await racing.settle();
    assert.equal(racing.nodes['new-activity'].hidden, false);
  } finally { Date.now = originalNow; }
});

test('polling stops in hidden tabs, throttles focus, backs off errors and clears on sign-out', async () => {
  const b = browserHarness(), originalNow = Date.now;
  Date.now = b.clock;
  try {
    startActivityAlerts(b.win, b.doc); await b.settle();
    b.winEvents.focus(); await b.settle();
    assert.equal(b.calls(), 1);
    b.doc.visibilityState = 'hidden'; b.docEvents.visibilitychange();
    await b.advance(120_000); assert.equal(b.calls(), 1);
    b.doc.visibilityState = 'visible'; b.docEvents.visibilitychange(); await b.settle();
    assert.equal(b.calls(), 2);
    b.setStatus(503); await b.advance(60_000); assert.equal(b.calls(), 3);
    b.winEvents.focus(); await b.settle(); assert.equal(b.calls(), 3);
    await b.advance(60_000); assert.equal(b.calls(), 3);
    await b.advance(60_000); assert.equal(b.calls(), 4);
    b.setStatus(401); await b.advance(240_000);
    assert.equal(b.stored(), null); assert.equal(b.nodes['new-activity'].hidden, true);
    const total = b.calls(); await b.advance(900_000); assert.equal(b.calls(), total);
  } finally { Date.now = originalNow; }
});

test('an account switch discards the previous account activity baseline', async () => {
  const b = browserHarness({ stored: JSON.stringify({ scope: 'f'.repeat(64), keys: [] }) });
  const originalNow = Date.now; Date.now = b.clock;
  try {
    b.setData({ keys: ['c'.repeat(64)] });
    startActivityAlerts(b.win, b.doc); await b.settle();
    assert.equal(b.nodes['new-activity'].hidden, true);
    assert.equal(JSON.parse(b.stored()).scope, 'a'.repeat(64));
  } finally { Date.now = originalNow; }
});
