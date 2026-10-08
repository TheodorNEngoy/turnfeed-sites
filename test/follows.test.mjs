import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { startFollows, followsScript } from '../worker/follows.mjs';

function setup(fetch, { followerCount = true, start = true } = {}) {
  const form = new EventTarget(), attrs = new Map(), calls = [], timers = new Map();
  form.dataset = { followName: 'Alice Example' };
  form.getAttribute = () => '/web/follow';
  form.setAttribute = (key, value) => attrs.set(key, value);
  form.removeAttribute = key => attrs.delete(key);
  const button = { disabled: false, textContent: 'Follow', setAttribute: (key, value) => attrs.set(key, value),
    classList: { toggle: (key, value) => attrs.set(key, value) } };
  const token = { value: 'follow-token' }, status = { textContent: '' }, count = { textContent: '4' };
  const draft = { value: 'A draft stays here' };
  const nodes = { 'button[type="submit"]': button, 'input[name="token"]': token, '[data-follow-status]': status };
  form.querySelector = selector => nodes[selector];
  const doc = { querySelectorAll: () => [form], querySelector: selector => selector === '[data-follower-count]' && followerCount ? count : null };
  const win = { URLSearchParams, AbortController, location: { href: 'https://turnfeed.example/person?handle=alice' }, scrollY: 867,
    setTimeout: callback => { timers.set(1, callback); return 1; }, clearTimeout: id => timers.delete(id),
    fetch: async (...args) => { calls.push(args); return fetch(...args); } };
  if (start) startFollows(win, doc);
  const submit = () => { const event = new Event('submit', { cancelable: true }); form.dispatchEvent(event); return event; };
  return { win, doc, form, button, token, status, count, draft, attrs, calls, timers, submit };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = data => ({ ok: true, json: async () => ({ ok: true, following: true, count: 5, token: 'unfollow-token', ...data }) });

test('one signed request updates confirmed follow state and count, then supports unfollow with the new token', async () => {
  let finish;
  const s = setup(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(s.submit().defaultPrevented, true); s.submit();
  assert.equal(s.calls.length, 1); assert.equal(s.button.disabled, true);
  assert.equal(s.button.textContent, 'Follow'); assert.equal(s.count.textContent, '4');
  const [url, options] = s.calls[0];
  assert.equal(url, '/web/follow'); assert.equal(options.method, 'POST');
  assert.deepEqual([...options.body], [['token', 'follow-token']]);
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error'); assert.equal(options.headers.accept, 'application/json');
  finish(response()); await flush();
  assert.equal(s.button.textContent, 'Unfollow'); assert.equal(s.count.textContent, '5');
  assert.equal(s.token.value, 'unfollow-token'); assert.equal(s.attrs.get('aria-label'), 'Unfollow Alice Example');
  assert.equal(s.attrs.get('button-secondary'), true); assert.equal(s.status.textContent, 'You follow this person.');
  assert.equal(s.button.disabled, false); assert.equal(s.attrs.has('aria-busy'), false); assert.equal(s.timers.size, 0);
  s.submit(); assert.equal(s.calls[1][1].body.get('token'), 'unfollow-token');
  finish(response({ following: false, count: 4, token: 'follow-again-token' })); await flush();
  assert.equal(s.button.textContent, 'Follow'); assert.equal(s.count.textContent, '4');
  assert.equal(s.attrs.get('aria-label'), 'Follow Alice Example'); assert.equal(s.attrs.get('button-secondary'), false);
  assert.equal(s.status.textContent, 'You no longer follow this person.');
  assert.equal(s.win.scrollY, 867); assert.equal(s.draft.value, 'A draft stays here');
  assert.equal(s.win.location.href, 'https://turnfeed.example/person?handle=alice');
});

test('network, HTTP and invalid responses preserve confirmed fields without replay', async () => {
  for (const fetch of [async () => { throw Error('network'); }, async () => ({ ok: false }),
    async () => response({ following: 'yes' }), async () => response({ count: -1 }),
    async () => response({ count: 1.5 }), async () => response({ count: Number.MAX_SAFE_INTEGER + 1 }),
    async () => response({ token: '' }), async () => response({ token: 'x'.repeat(16_385) })]) {
    const s = setup(fetch); s.submit(); await flush();
    assert.equal(s.calls.length, 1); assert.equal(s.token.value, 'follow-token');
    assert.equal(s.button.textContent, 'Follow'); assert.equal(s.count.textContent, '4');
    assert.equal(s.attrs.has('button-secondary'), false); assert.match(s.status.textContent, /not confirmed/);
    assert.equal(s.button.disabled, false); assert.equal(s.timers.size, 0);
  }
});

test('timeout restores the control without inferring failure or automatically retrying', async () => {
  const s = setup((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')))));
  s.submit(); [...s.timers.values()][0](); await flush();
  assert.equal(s.calls.length, 1); assert.equal(s.button.disabled, false);
  assert.equal(s.token.value, 'follow-token'); assert.equal(s.button.textContent, 'Follow');
  assert.match(s.status.textContent, /not confirmed/); assert.equal(s.attrs.has('aria-busy'), false);
});

test('repeated initialization attaches once and a following-list form needs no profile count', async () => {
  const s = setup(async () => response(), { followerCount: false });
  startFollows(s.win, s.doc); startFollows(s.win, s.doc);
  s.submit(); await flush();
  assert.equal(s.calls.length, 1); assert.equal(s.button.textContent, 'Unfollow');
  assert.equal(s.count.textContent, '4'); assert.equal(s.token.value, 'unfollow-token');
});

test('serialized script initializes without module dependencies and unsupported browsers keep native forms', async () => {
  const s = setup(async () => response(), { start: false });
  vm.runInNewContext(followsScript, { window: s.win, document: s.doc });
  s.submit(); await flush(); assert.equal(s.calls.length, 1); assert.equal(s.button.textContent, 'Unfollow');
  const fallback = setup(async () => response(), { start: false });
  fallback.win.AbortController = undefined;
  startFollows(fallback.win, fallback.doc);
  assert.equal(fallback.submit().defaultPrevented, false); assert.equal(fallback.calls.length, 0);
});

test('private follows display pending and cancellation without claiming approval',async()=>{
  const s=setup(async()=>response({following:false,requested:true,privateAccount:true,count:0}));
  s.submit();await flush();
  assert.equal(s.button.textContent,'Cancel request');assert.match(s.status.textContent,/pending/);
  assert.equal(s.attrs.get('button-secondary'),true);
});

test('revoking private access refreshes the page to remove restricted content',async()=>{
  let reloaded=0;
  const s=setup(async()=>response({following:false,requested:false,privateAccount:true,refresh:true,count:0}));
  s.win.location.reload=()=>reloaded++;
  s.submit();await flush();assert.equal(reloaded,1);assert.equal(s.button.textContent,'Request to follow');
});
