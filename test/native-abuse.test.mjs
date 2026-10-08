import { invoke, MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';

import { nativeAbuseIssue } from '../worker/abuse.mjs';
import { database } from './sqlite-d1.mjs';
import { readState, commitState } from '../worker/storage.mjs';

installModerationFixture();

const origin = 'https://turnfeed-abuse.example';
const secret = 'local-abuse-test-only-012345678901234567890123456789';
const longReply = 'I tried this approach with a small reading group, and choosing one book together made the weekly discussion much easier to sustain.';
const manyMentions = 'A question for @one @two @three @four @five @six: which book would make a good starting point for our reading group?';
const call = async (db, subject, name, args) => (await invoke({ db, subject, name, args,
  displayName: `${subject} Reader`, origin, secret, callerKey: subject })).result?.structuredContent;
async function post(db, subject, text, clientId) {
  const result = await call(db, subject, 'create_post', { text, visibility: 'public', clientId });
  assert.equal(result.published, true, JSON.stringify(result));
  return result;
}
async function web(db, path, subject, form) {
  const response = await worker.fetch(new Request(origin + path, { method: form ? 'POST' : 'GET',
    headers: { 'oai-authenticated-user-id': subject, ...(form ? { origin, 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    ...(form ? { body: new URLSearchParams(form) } : {}) }), { DB: db, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret });
  return { status: response.status, body: await response.text() };
}
function token(page, action) {
  const form = page.body.match(new RegExp(`<form[^>]*action="/web/${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1];
  const value = form?.match(/name="token"\s+value="([^"]+)"/)?.[1];
  assert.ok(value, `Missing ${action} form`);
  return value;
}
const replyArgs = (root, clientId, text = longReply) => ({ ...root.replyHandoff.targetArguments,
  text, visibility: 'public', clientId });

test('mention parsing counts unique valid handles with the retained inbox boundaries', () => {
  const five = '@one @two @three @four @five';
  assert.equal(nativeAbuseIssue({ text: `${five} @ONE @a @ab @abcdefghijklmnopqrstu reader@example.com reader.notes@example.com reader+notes@example.com` }), '');
  assert.match(nativeAbuseIssue({ text: `${five} (@six)` }), /at most five/);
  // The inbox recognizes @six at this punctuation boundary too.
  assert.match(nativeAbuseIssue({ text: `${five} reader+@six.example` }), /at most five/);
});

test('mention limit applies to both browser and MCP publication without changing exact text', async t => {
  const db = database(); t.after(() => db.sql.close());
  const denied = await call(db, 'alice', 'create_post', { text: manyMentions, visibility: 'public', clientId: 'mentions-rpc' });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /at most five/);
  const page = await web(db, '/', 'alice');
  const browser = await web(db, '/web/post', 'alice', { token: token(page, 'post'), text: manyMentions });
  assert.equal(browser.status, 422);
  assert.match(browser.body, /at most five/);
  assert.equal((await readState(db)).value.snapshot.posts.length, 0);
  const exactText = 'A question for @one @ONE @two @three @four @five: which book should our reading group choose? Send notes to reader@example.com.';
  const created = await post(db, 'alice', exactText, 'mentions-allowed');
  const retried = await post(db, 'alice', exactText, 'mentions-allowed');
  assert.equal(retried.postId, created.postId);
  assert.equal((await readState(db)).value.snapshot.posts[0].text, exactText);
  const deniedEdit = await call(db, 'alice', 'edit_post', {
    targetLabel: created.replyHandoff.targetArguments.targetLabel, postText: exactText, text: manyMentions,
  });
  assert.equal(deniedEdit.ok, false);
  assert.match(deniedEdit.message, /at most five/);
  const deniedReply = await call(db, 'bob', 'publish_public_reply_to_post', replyArgs(created, 'mentions-reply', manyMentions));
  assert.equal(deniedReply.ok, false);
  assert.match(deniedReply.message, /at most five/);
  const stored = (await readState(db)).value.snapshot.posts[0];
  assert.equal(stored.text, exactText);
  assert.equal(stored.replies.length, 0);
});

test('repeated substantial replies across threads use persisted author history and keep identical retries', async t => {
  const db = database(); t.after(() => db.sql.close());
  const roots = [];
  for (const [i, text] of [
    'Which book would you happily read twice, and what changes on a second reading?',
    'A small gardening lesson: planting herbs close to the kitchen makes watering easier to remember.',
    'What is a useful way to prepare for a long train journey with young children?',
  ].entries()) roots.push(await post(db, 'owner', text, `root-${i}`));
  for (let i = 0; i < 2; i++) {
    const result = await call(db, 'alice', 'publish_public_reply_to_post', replyArgs(roots[i], `reply-${i}`));
    assert.equal(result.published, true, JSON.stringify(result));
  }
  const retry = await call(db, 'alice', 'publish_public_reply_to_post', replyArgs(roots[0], 'reply-0'));
  assert.equal(retry.published, true);
  const page = await web(db, `/post/${roots[2].postId}`, 'alice');
  const deniedWeb = await web(db, '/web/reply', 'alice', { token: token(page, 'reply'), text: longReply });
  assert.equal(deniedWeb.status, 422);
  assert.match(deniedWeb.body, /Wait \d+ minutes?/);
  const denied = await call(db, 'alice', 'publish_public_reply_to_post', replyArgs(roots[2], 'reply-2'));
  assert.equal(denied.ok, false);
  assert.match(denied.message, /two conversations recently/);
  const separateActor = await call(db, 'bob', 'publish_public_reply_to_post', replyArgs(roots[2], 'bob-reply'));
  assert.equal(separateActor.published, true, JSON.stringify(separateActor));
  const loaded = await readState(db);
  assert.equal(loaded.value.snapshot.posts.flatMap(p => p.replies).length, 3);
  for (const p of loaded.value.snapshot.posts) for (const r of p.replies) r.createdAt = new Date(Date.now() - 11 * 60_000).toISOString();
  assert.equal(await commitState(db, loaded.revision, loaded.value, undefined, loaded), true);
  const afterWindow = await call(db, 'alice', 'publish_public_reply_to_post', replyArgs(roots[2], 'reply-2'));
  assert.equal(afterWindow.published, true, JSON.stringify(afterWindow));
});

test('short replies, a single repeated thread, and another author do not trigger the cross-thread hold', () => {
  const now = Date.now();
  const entry = (id, text = longReply, authorId = 'alice') => ({ id, text, authorId, createdAt: new Date(now).toISOString(), replies: [] });
  const args = { kind: 'reply', userId: 'alice', targetPostId: 'new-thread', now };
  const short = 'That suggestion helped me choose a book for the weekend.';
  assert.equal(nativeAbuseIssue({ ...args, text: short, posts: [1, 2, 3].map(id => ({ id: `p${id}`, replies: [entry(`r${id}`, short)] })) }), '');
  assert.equal(nativeAbuseIssue({ ...args, text: longReply, posts: [{ id: 'p1', replies: [entry('r1'), entry('r2')] }] }), '');
  assert.equal(nativeAbuseIssue({ ...args, text: longReply, posts: [1, 2].map(id => ({ id: `p${id}`, replies: [entry(`r${id}`, longReply, 'bob')] })) }), '');
});

test('nested and edited substantial replies are included while the edited target is excluded', () => {
  const now = Date.now(), old = new Date(now - 60 * 60_000).toISOString(), fresh = new Date(now - 60_000).toISOString();
  const reply = id => ({ id, authorId: 'alice', text: longReply, createdAt: old, editedAt: fresh, hidden: true, replies: [] });
  const posts = [{ id: 'p1', replies: [{ id: 'parent', replies: [reply('r1')] }] }, { id: 'p2', replies: [reply('r2')] }];
  const args = { posts, text: longReply, kind: 'reply', userId: 'alice', targetPostId: 'p3', now };
  assert.match(nativeAbuseIssue(args), /Wait 9 minutes/);
  assert.equal(nativeAbuseIssue({ ...args, excludeId: 'r2' }), '');
});
