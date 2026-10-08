import test from 'node:test';
import assert from 'node:assert/strict';
import { startDeletes } from '../worker/deletions.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const response = value => ({ ok: true, json: async () => value });
const preview = (extra = {}) => ({ ok: true, kind: 'post', postId: 'post-one', authorName: 'Avery',
  text: 'A quiet afternoon by the river.', action: '/web/delete', token: 'signed-one', ...extra });
const emit = (node, type) => { const event = new Event(type, { cancelable: true }); node.dispatchEvent(event); return event; };

function setup(fetch, initializeReplies = () => {}) {
  const doc = new EventTarget(), dialog = new EventTarget(), confirm = new EventTarget(), cancel = new EventTarget();
  const calls = [], timers = new Map(), created = [], counts = [{ textContent: '2' }, { textContent: '0' }];
  const title = {}, description = {}, author = {}, content = {}, status = {};
  let timerId = 0;
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; emit(dialog, 'close'); };
  cancel.focus = () => { cancel.focused = true; };
  const nodes = { '[data-delete-title]': title, '[data-delete-description]': description,
    '[data-delete-author]': author, '[data-delete-preview]': content, '[data-delete-status]': status,
    '[data-delete-confirm]': confirm, '[data-delete-cancel]': cancel };
  dialog.querySelector = selector => nodes[selector];
  const replies = { removed: false, remove() { this.removed = true; } };
  const composer = { removed: false, remove() { this.removed = true; } };
  doc.querySelector = selector => ({ '#delete-dialog': dialog, '#replies': replies, '.compose-entry': composer })[selector];
  doc.querySelectorAll = selector => selector === '[data-post-count]' ? counts : [];
  doc.createElement = tag => {
    const element = { tag, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } };
    created.push(element); return element;
  };
  const win = { URL, URLSearchParams, AbortController, location: { href: 'https://turnfeed.example/', origin: 'https://turnfeed.example' },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (...args) => { calls.push(args); return fetch(...args); } };
  startDeletes(win, doc, initializeReplies);
  function link({ kind = 'post', href = '/post/post-one/delete', thread = false } = {}) {
    const card = { replacement: null, classList: { contains: value => thread && value === 'thread-post' },
      replaceWith(value) { this.replacement = value; } };
    const node = { href, dataset: { deleteKind: kind }, isConnected: true, focusCount: 0,
      focus() { this.focusCount++; }, closest: selector => selector === 'a[data-delete-kind]' ? node : selector === 'article.post-card,article.thread-post' ? card : null };
    return { node, card };
  }
  function open(target) {
    const event = new Event('click', { cancelable: true });
    Object.defineProperty(event, 'target', { value: target.node });
    event.button = 0;
    doc.dispatchEvent(event);
    return event;
  }
  return { win, doc, dialog, confirm, cancel, title, description, author, content, status, calls, timers, created, counts,
    replies, composer, link, open, confirmDelete: () => emit(confirm, 'click'), cancelDelete: () => emit(cancel, 'click') };
}

test('cancel and Escape close the preview without any deletion request', async () => {
  for (const escape of [false, true]) {
    const s = setup(async () => response(preview())), target = s.link();
    assert.equal(s.open(target).defaultPrevented, true);
    assert.equal(s.dialog.open, true);
    assert.equal(s.confirm.disabled, true);
    await flush();
    assert.equal(s.confirm.disabled, false);
    assert.equal(s.content.textContent, preview().text);
    if (escape) assert.equal(emit(s.dialog, 'cancel').defaultPrevented, true);
    else s.cancelDelete();
    s.confirmDelete(); await flush();
    assert.equal(s.dialog.open, false);
    assert.equal(target.node.focusCount, 1);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0][1].method, undefined);
    assert.equal(target.card.replacement, null);
    assert.equal(s.timers.size, 0);
  }
});

test('a delayed preview cannot revive a cancelled popup or replace a reopened target', async () => {
  const finishes = [];
  const s = setup(() => new Promise(resolve => finishes.push(resolve)));
  const old = s.link(), fresh = s.link({ href: '/post/post-two/delete' });
  s.open(old); s.cancelDelete();
  finishes[0](response(preview())); await flush();
  assert.equal(s.dialog.open, false);
  assert.equal(s.confirm.disabled, true);
  s.confirmDelete(); assert.equal(s.calls.length, 1);

  s.open(old); s.cancelDelete(); s.open(fresh);
  finishes[2](response(preview({ postId: 'post-two', authorName: 'Maya', text: 'A different post.', token: 'signed-two' })));
  await flush();
  finishes[1](response(preview())); await flush();
  assert.equal(s.dialog.open, true);
  assert.equal(s.content.textContent, 'A different post.');
  assert.equal(s.author.textContent, 'Maya');
  s.confirmDelete();
  assert.equal(s.calls.length, 4);
  assert.equal(s.calls[3][1].body.get('token'), 'signed-two');
  finishes[3](response({ ok: true, deleted: 'post', postId: 'post-two' })); await flush();
  assert.equal(old.card.replacement, null);
  assert.equal(fresh.card.replacement.textContent, 'Post deleted.');
  assert.equal(s.timers.size, 0);
});

test('preview failures keep confirmation disabled and send no mutation', async () => {
  for (const fetch of [async () => { throw new Error('network'); }, async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new Error('not JSON'); } })]) {
    const s = setup(fetch); s.open(s.link()); await flush();
    assert.equal(s.dialog.open, true);
    assert.equal(s.confirm.disabled, true);
    assert.match(s.status.textContent, /Could not load/);
    s.confirmDelete(); await flush();
    assert.equal(s.calls.length, 1);
    assert.equal(s.timers.size, 0);
  }
});

test('same-origin and expected-kind validation reject unavailable or mismatched previews', async () => {
  const external = setup(async () => response(preview()));
  external.open(external.link({ href: 'https://another.example/post/post-one/delete' })); await flush();
  assert.equal(external.calls.length, 0);
  assert.equal(external.confirm.disabled, true);
  for (const [kind, data] of [
    ['post', preview({ kind: 'reply', action: '/web/delete-reply' })],
    ['reply', preview()],
    ['post', preview({ action: '/web/delete-reply' })],
    ['post', preview({ action: 'https://another.example/web/delete' })],
    ['post', preview({ postId: '../another-post' })],
    ['post', preview({ token: '' })],
    ['post', preview({ ok: false })],
  ]) {
    const s = setup(async () => response(data)); s.open(s.link({ kind })); await flush();
    assert.equal(s.confirm.disabled, true);
    assert.match(s.status.textContent, /Could not load/);
    s.confirmDelete(); assert.equal(s.calls.length, 1);
  }
});

test('double confirmation sends one signed POST and updates the card only after confirmation', async () => {
  let finish;
  const s = setup(async (url, options) => options.method === 'POST'
    ? new Promise(resolve => { finish = resolve; }) : response(preview()));
  const target = s.link(); s.open(target); await flush();
  s.confirmDelete(); s.confirmDelete();
  assert.equal(s.calls.length, 2);
  assert.equal(s.confirm.disabled, true);
  assert.equal(s.cancel.disabled, true);
  assert.equal(target.card.replacement, null);
  assert.equal(s.counts[0].textContent, '2');
  s.cancelDelete(); emit(s.dialog, 'cancel');
  assert.equal(s.dialog.open, true);
  const [url, options] = s.calls[1];
  assert.equal(url, '/web/delete');
  assert.equal(options.method, 'POST');
  assert.deepEqual([...options.body], [['token', 'signed-one']]);
  assert.equal(options.headers.Accept, 'application/json');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  finish(response({ ok: true, deleted: 'post', postId: 'post-one' })); await flush();
  assert.equal(s.dialog.open, false);
  assert.equal(target.card.replacement.textContent, 'Post deleted.');
  assert.equal(target.card.replacement.attrs.role, 'status');
  assert.deepEqual(s.counts.map(item => item.textContent), ['1', '0']);
  assert.equal(s.replies.removed, false);
  assert.equal(s.composer.removed, false);
  assert.equal(s.timers.size, 0);
});

test('confirmed thread deletion also removes its reply section and composer', async () => {
  const s = setup(async (url, options) => response(options.method === 'POST'
    ? { ok: true, deleted: 'post', postId: 'post-one' } : preview()));
  const target = s.link({ thread: true }); s.open(target); await flush(); s.confirmDelete(); await flush();
  assert.equal(target.card.replacement.textContent, 'Post deleted.');
  assert.equal(s.replies.removed, true);
  assert.equal(s.composer.removed, true);
});

test('ambiguous mutations retain the card and permanently disable retry from that confirmation', async () => {
  for (const mutate of [async () => { throw new Error('network'); }, async () => ({ ok: false }),
    async () => response({ ok: true, deleted: 'reply', postId: 'post-one' }),
    async () => response({ ok: true, deleted: 'post', postId: 'another-post' }),
    async () => ({ ok: true, json: async () => { throw new Error('not JSON'); } })]) {
    const s = setup((url, options) => options.method === 'POST' ? mutate() : response(preview()));
    const target = s.link(); s.open(target); await flush(); s.confirmDelete(); await flush();
    assert.match(s.status.textContent, /wasn’t confirmed/);
    assert.equal(s.confirm.disabled, true);
    assert.equal(s.cancel.disabled, false);
    assert.equal(s.cancel.textContent, 'Close');
    assert.equal(target.card.replacement, null);
    assert.equal(s.counts[0].textContent, '2');
    s.confirmDelete(); await flush();
    assert.equal(s.calls.length, 2);
    s.cancelDelete(); assert.equal(s.dialog.open, false);
  }
});

test('confirmed reply deletion with an unavailable refresh asks to preserve drafts without retrying', async () => {
  const s = setup(async (url, options) => response(options.method === 'POST'
    ? { ok: true, deleted: 'reply', postId: 'post-one' }
    : preview({ kind: 'reply', action: '/web/delete-reply' })));
  const target = s.link({ kind: 'reply', href: '/post/post-one/actions?reply=selector' });
  s.open(target); await flush(); s.confirmDelete(); await flush();
  assert.match(s.status.textContent, /Deleted\. Refresh/);
  assert.match(s.status.textContent, /Copy any unsent replies/);
  assert.equal(s.confirm.disabled, true);
  assert.equal(s.cancel.disabled, false);
  s.confirmDelete(); assert.equal(s.calls.length, 2);
  assert.equal(target.card.replacement, null);
});

function replyRefreshSetup(deletedDraft = '') {
  const initialized = [], history = [], scrolls = [];
  const s = setup(async (url, options) => options.method === 'POST'
    ? response({ ok: true, deleted: 'reply', postId: 'post-one' })
    : options.headers.Accept === 'text/html' ? { ok: true, text: async () => '<main>Refreshed conversation</main>' }
      : response(preview({ kind: 'reply', action: '/web/delete-reply' })), section => initialized.push(section));
  const reply = (id, value = '', open = false) => {
    const text = { value }, details = { open }, link = { href: `/post/post-one/actions?reply=${id}` };
    return { text, details, querySelector: selector => ({ 'textarea[name="text"]': text, details,
      'a[data-delete-kind],a.reply-options': link })[selector] };
  };
  const deleted = reply('deleted-branch', deletedDraft, true), previousRemaining = reply('remaining-branch', 'Keep this unsent reply.', true);
  const refreshedRemaining = reply('remaining-branch'), section = { querySelectorAll: () => [refreshedRemaining] };
  s.replies.querySelectorAll = () => [deleted, previousRemaining];
  s.replies.replaceWith = value => { s.replies.replacement = value; };
  s.win.DOMParser = class {
    parseFromString(html, type) {
      assert.equal(html, '<main>Refreshed conversation</main>');
      assert.equal(type, 'text/html');
      return { querySelector: selector => selector === '#replies' ? section : null };
    }
  };
  s.win.location.href = 'https://turnfeed.example/post/post-one?cursor=old-page&focus=latest#replies';
  s.win.scrollX = 3; s.win.scrollY = 650;
  s.win.history = { state: { marker: true }, replaceState: (...args) => history.push(args) };
  s.win.scrollTo = (...args) => scrolls.push(args);
  return { ...s, initialized, history, scrolls, deleted, previousRemaining, refreshedRemaining, section };
}

test('successful reply refresh restores remaining drafts, initializes the new section and preserves scroll without the old cursor', async () => {
  const s = replyRefreshSetup();
  s.open(s.link({ kind: 'reply', href: '/post/post-one/actions?reply=deleted-branch&cursor=old-page' }));
  await flush(); s.confirmDelete(); await flush();
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[2][0], '/post/post-one?focus=latest');
  assert.equal(s.calls[2][1].headers.Accept, 'text/html');
  assert.equal(s.replies.replacement, s.section);
  assert.equal(s.refreshedRemaining.text.value, 'Keep this unsent reply.');
  assert.equal(s.refreshedRemaining.details.open, true);
  assert.deepEqual(s.initialized, [s.section]);
  assert.deepEqual(s.history, [[{ marker: true }, '', '/post/post-one?focus=latest#replies']]);
  assert.deepEqual(s.scrolls, [[3, 650]]);
  assert.equal(s.dialog.open, false);
  assert.equal(s.timers.size, 0);
});

test('a draft in a deleted branch prevents section replacement and remains available to copy', async () => {
  const s = replyRefreshSetup('Do not discard this draft.');
  s.open(s.link({ kind: 'reply', href: '/post/post-one/actions?reply=deleted-branch' }));
  await flush(); s.confirmDelete(); await flush();
  assert.equal(s.calls.length, 3);
  assert.equal(s.replies.replacement, undefined);
  assert.equal(s.deleted.text.value, 'Do not discard this draft.');
  assert.equal(s.previousRemaining.text.value, 'Keep this unsent reply.');
  assert.deepEqual(s.initialized, []);
  assert.deepEqual(s.history, []);
  assert.deepEqual(s.scrolls, []);
  assert.match(s.status.textContent, /Deleted\. Refresh/);
  assert.match(s.status.textContent, /Copy any unsent replies/);
  assert.equal(s.dialog.open, true);
  assert.equal(s.confirm.disabled, true);
  s.confirmDelete(); assert.equal(s.calls.length, 3);
});
