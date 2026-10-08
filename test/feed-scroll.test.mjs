import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { startFeedScroll } from '../worker/feed-scroll.mjs';

function node(dataset = {}) {
  const target = new EventTarget(), attrs = new Map();
  return Object.assign(target, { dataset, attrs, hidden: false, textContent: '',
    getAttribute: key => attrs.get(key) ?? null,
    setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key) });
}
const card = id => Object.assign(node({ postId: id }), { button: { initialized: false } });
function page({ ids = ['b'], viewer = 'viewer-a', next = '/?focus=active&cursor=second', reset = false } = {}) {
  const feed = node({ feedViewer: viewer }), cards = ids.map(card), link = next ? node() : null;
  feed.querySelectorAll = () => cards;
  link?.setAttribute('href', next);
  return { querySelector: selector => selector === '[data-scroll-feed]' ? feed
    : selector === '[data-feed-next]' ? link : selector === '[data-feed-reset]' && reset ? node() : null };
}
function harness(fetch, { href = 'https://turnfeed.example/?focus=active', next = '/?focus=active&cursor=first', anchorShift = false } = {}) {
  const feed = node({ feedViewer: 'viewer-a' }), pager = node(), link = node(), status = node();
  const cards = [card('a')], calls = [], timers = new Map(), events = {}, imported = [], draft = { value: 'Keep my draft' };
  let intersection, enhancements = 0;
  link.setAttribute('href', next);
  pager.querySelector = selector => selector === '[data-feed-next]' ? link : status;
  pager.getBoundingClientRect = () => ({ top: 900 });
  feed.querySelectorAll = () => cards;
  feed.append = (...items) => { cards.push(...items); if (anchorShift) win.scrollY += 300; };
  const doc = { querySelector: selector => selector === '[data-scroll-feed]' ? feed : pager,
    importNode: incoming => { const copy = card(incoming.dataset.postId); imported.push(copy); return copy; } };
  const win = { URL, AbortController, location: { href }, innerHeight: 700, scrollX: 0, scrollY: 867,
    scrollTo: (x, y) => { win.scrollX = x; win.scrollY = y; },
    setTimeout: callback => { timers.set(1, callback); return 1; }, clearTimeout: key => timers.delete(key),
    addEventListener: (type, callback) => { events[type] = callback; },
    fetch: async (...args) => { calls.push(args); return fetch(...args); },
    DOMParser: class { parseFromString(value, type) { assert.equal(type, 'text/html'); return value; } },
    IntersectionObserver: class { constructor(callback) { intersection = callback; } observe() {} disconnect() {} } };
  const enhance = () => { enhancements++; for (const item of cards) item.button.initialized = true; };
  startFeedScroll(win, doc, enhance);
  const click = (options = {}) => { const event = new Event('click', { cancelable: true }); Object.assign(event, options); link.dispatchEvent(event); return event; };
  return { win, doc, feed, cards, link, status, calls, timers, events, imported, draft, click,
    intersect: () => intersection?.([{ isIntersecting: true }]), enhancements: () => enhancements };
}
const response = value => ({ ok: true, text: async () => page(value) });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('appends unique cards, enhances their controls, and preserves scroll, draft and URL', async () => {
  const h = harness(async () => response({ ids: ['a', 'b', 'b', 'c'] }));
  h.intersect(); await flush();
  assert.deepEqual(h.cards.map(item => item.dataset.postId), ['a', 'b', 'c']);
  assert.ok(h.imported.every(item => item.button.initialized)); assert.equal(h.enhancements(), 1);
  assert.equal(h.win.scrollY, 867); assert.equal(h.draft.value, 'Keep my draft');
  assert.equal(h.win.location.href, 'https://turnfeed.example/?focus=active');
  assert.equal(h.link.getAttribute('href'), '/?focus=active&cursor=second');
  const [url, options] = h.calls[0]; assert.equal(url, '/?focus=active&cursor=first');
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(h.timers.size, 0);
});

test('suppresses in-flight and intersection repeats; another scroll can request one more page', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  h.intersect(); h.intersect(); h.click(); h.events.scroll(); assert.equal(h.calls.length, 1);
  finish(response()); await flush();
  h.intersect(); h.intersect(); assert.equal(h.calls.length, 1);
  h.events.scroll(); assert.equal(h.calls.length, 2);
  finish(response({ ids: ['c'], next: null })); await flush();
  assert.equal(h.link.hidden, true); h.events.scroll(); h.intersect(); assert.equal(h.calls.length, 2);
});

test('preserves the latest reader position when browser scroll anchoring moves the focused pager', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }), { anchorShift: true });
  h.click(); h.win.scrollY = 930;
  finish(response({ next: null })); await flush();
  assert.equal(h.win.scrollY, 930);
});

test('network, HTTP, viewer and malformed continuation failures preserve cards and require manual retry', async () => {
  for (const fail of [async () => { throw Error('network'); }, async () => ({ ok: false }),
    async () => response({ viewer: 'other' }), async () => response({ next: 'https://other.example/?cursor=x' }),
    async () => response({ next: '/?focus=latest&cursor=x' }), async () => response({ next: '/?cursor=x&cursor=y' })]) {
    let shouldFail = true;
    const h = harness((...args) => shouldFail ? fail(...args) : Promise.resolve(response({ next: null })));
    h.intersect(); await flush();
    assert.deepEqual(h.cards.map(item => item.dataset.postId), ['a']); assert.match(h.status.textContent, /try again/);
    h.intersect(); h.events.scroll(); assert.equal(h.calls.length, 1);
    shouldFail = false; assert.equal(h.click().defaultPrevented, true); await flush();
    assert.equal(h.calls.length, 2); assert.deepEqual(h.cards.map(item => item.dataset.postId), ['a', 'b']);
  }
});

test('timeout leaves an explicit retry and never repeats the request automatically', async () => {
  const h = harness((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')))));
  h.intersect(); [...h.timers.values()][0](); await flush();
  h.intersect(); h.events.scroll(); assert.equal(h.calls.length, 1); assert.match(h.status.textContent, /try again/);
  assert.equal(h.cards.length, 1); assert.equal(h.link.getAttribute('aria-disabled'), null);
});

test('cursor reset or repeated cursor exposes a fresh-start link without replacing the feed', async () => {
  for (const result of [{ reset: true }, { next: '/?cursor=first' }, { ids: ['a'], next: '/?cursor=second' }]) {
    const h = harness(async () => response(result)); h.intersect(); await flush();
    assert.deepEqual(h.cards.map(item => item.dataset.postId), ['a']);
    assert.equal(h.link.getAttribute('href'), '/?focus=active'); assert.match(h.status.textContent, /feed changed/);
    assert.equal(h.click().defaultPrevented, false); h.intersect(); h.events.scroll(); assert.equal(h.calls.length, 1);
  }
});

test('manual keyboard activation loads in place; modified links keep normal navigation', async () => {
  const h = harness(async () => response({ next: null }));
  assert.equal(h.click({ ctrlKey: true }).defaultPrevented, false); assert.equal(h.calls.length, 0);
  assert.equal(h.click().defaultPrevented, true); await flush(); assert.equal(h.calls.length, 1);
});

test('missing focus means Active while an explicit Latest feed keeps its ranking', async () => {
  for (const focus of ['', 'latest']) {
    const query = focus ? '?focus=latest&' : '?';
    const h = harness(async () => response({ next: '/' + query + 'cursor=second' }), {
      href: 'https://turnfeed.example/' + (focus ? '?focus=latest' : ''), next: '/' + query + 'cursor=first',
    });
    h.click(); await flush();
    assert.deepEqual(h.cards.map(item => item.dataset.postId), ['a', 'b']);
    assert.equal(h.link.getAttribute('href'), '/' + query + 'cursor=second');
  }
});

test('unsafe initial URL keeps the native fallback; initialization is idempotent and serializable', async () => {
  const invalid = harness(async () => response(), { next: '//elsewhere.example/?cursor=x' });
  assert.equal(invalid.click().defaultPrevented, false); assert.equal(invalid.calls.length, 0);
  const h = harness(async () => response({ next: null }));
  startFeedScroll(h.win, h.doc, () => { throw Error('second initialization'); });
  h.click(); await flush(); assert.equal(h.calls.length, 1);
  assert.equal(typeof vm.runInNewContext('(' + startFeedScroll.toString() + ')'), 'function');
});
