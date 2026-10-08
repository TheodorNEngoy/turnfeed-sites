import { MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';
import { database } from './sqlite-d1.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import { readFileSync } from 'node:fs';
import { dispatchMcp } from '../worker/mcp.mjs';

installModerationFixture();

const origin = 'https://turnfeed-web.example';
const secret = 'local-web-test-012345678901234567890123456789';
const envFor = db => ({ DB: db, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret });
async function web(db, path, { subject = 'alice', form, originHeader = origin, extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (subject) {
    headers['oai-authenticated-user-id'] = subject;
    headers['oai-authenticated-user-full-name'] = subject === 'alice' ? 'Alice Example' : 'Bob Example';
  }
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; if (originHeader !== null) headers.origin = originHeader; }
  const response = await worker.fetch(new Request(origin + path, { method: form ? 'POST' : 'GET', headers,
    ...(form ? { body: new URLSearchParams(form) } : {}) }), envFor(db));
  return { status: response.status, body: await response.text(), location: response.headers.get('location'), headers: response.headers };
}
function token(page, action) {
  const form = page.body.match(new RegExp(`<form[^>]*action="/web/${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1];
  assert.ok(form, `missing ${action} form on status ${page.status}: ${page.body.slice(-2000)}`);
  const value = form.match(/name="token"\s+value="([^"]+)"/)?.[1];
  assert.ok(value, 'missing signed form token');
  return value;
}
async function rpc(db, subject, name, args) {
  const result = await worker.fetch(new Request(origin + '/mcp', { method: 'POST', headers: {
    'content-type': 'application/json', 'oai-authenticated-user-id': subject,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), envFor(db));
  return (await result.json()).result?.structuredContent;
}
async function post(db, text, subject = 'alice') {
  const page = await web(db, '/', { subject });
  const form = { token: token(page, 'post'), text };
  const result = await web(db, '/web/post', { subject, form });
  assert.equal(result.status, 303, result.body);
  return { path: result.location.split('?')[0], form };
}

test('browser posts and replies share native data and suppress identical retries', async () => {
  const db = database();
  const created = await post(db, 'What is a book you would happily read twice?');
  assert.equal((await web(db, '/web/post', { form: created.form })).status, 303);
  assert.equal((await readState(db)).value.snapshot.posts.length, 1);
  const id = created.path.slice('/post/'.length);
  const native = await rpc(db, 'bob', 'get_thread_context', { postId: id });
  assert.equal(native.thread.text, created.form.text);
  assert.equal(native.thread.authorName, 'Alice Example');
  const page = await web(db, created.path, { subject: 'bob' });
  const replyForm = { token: token(page, 'reply'), text: 'A Wizard of Earthsea is a wonderful second read.' };
  assert.equal((await web(db, '/web/reply', { subject: 'bob', form: replyForm })).status, 303);
  const retried = await web(db, '/web/reply', { subject: 'bob', form: replyForm });
  assert.equal(retried.status, 303, retried.body);
  const conversation = await rpc(db, 'alice', 'get_thread_context', { postId: id });
  assert.equal(conversation.totalReplyCount, 1);
  assert.equal(conversation.recentReplies[0].text, replyForm.text);
  assert.equal(conversation.recentReplies[0].authorName, 'Bob Example');
  assert.match((await web(db, created.path)).body, /A Wizard of Earthsea/);
  db.sql.close();
});

test('browser nested replies stay attached to the selected reply and retain retry protection', async () => {
  const db = database(), created = await post(db, 'Which book would you reread?');
  const top = await web(db, created.path, { subject: 'bob' });
  const parentText = 'A Wizard of Earthsea rewards another read.';
  assert.equal((await web(db, '/web/reply', { subject: 'bob', form: { token: token(top, 'reply'), text: parentText } })).status, 303);
  const page = await web(db, created.path);
  const form = { token: token(page, 'nested-reply'), text: 'What stood out to you the second time?' };
  assert.match(page.body, /Reply to Bob Example/);
  assert.equal((await web(db, '/web/nested-reply', { subject: 'bob', form })).status, 403);
  const result = await web(db, '/web/nested-reply', { form });
  assert.equal(result.status, 303, result.body);
  assert.equal(result.location, `${created.path}?done=replied#replies`);
  assert.equal((await web(db, '/web/nested-reply', { form })).status, 303);
  const state = (await readState(db)).value.snapshot.posts[0];
  assert.equal(state.replies.length, 1);
  assert.equal(state.replies[0].text, parentText);
  assert.equal(state.replies[0].replies.length, 1);
  assert.equal(state.replies[0].replies[0].text, form.text);
  const native = await rpc(db, 'alice', 'get_thread_context', { postId: state.id });
  assert.equal(native.totalReplyCount, 2);
  assert.equal(native.recentReplies.find(reply => reply.text === form.text).replyToAuthorName, 'Bob Example');
  assert.doesNotMatch((await web(db, created.path, { subject: '' })).body, /action="\/web\/nested-reply"/);
  const loaded = await readState(db);
  loaded.value.snapshot.posts[0].archivedAt = new Date().toISOString();
  await commitState(db, loaded.revision, loaded.value, undefined, loaded);
  assert.doesNotMatch((await web(db, created.path)).body, /action="\/web\/nested-reply"/);
  db.sql.close();
});

test('signed nested targets support long Unicode and reject a substantively changed target', async () => {
  const db = database();
  const postText = '読み返すと物語の新しい意味に気づきます。'.repeat(35).slice(0, 600);
  const replyText = '登場人物の選択についてもう一度考えてみたいです。'.repeat(30).slice(0, 600);
  const created = await post(db, 'A longer conversation about rereading stories.');
  const top = await web(db, created.path, { subject: 'bob' });
  assert.equal((await web(db, '/web/reply', { subject: 'bob', form: { token: token(top, 'reply'), text: 'The characters make different impressions on a second reading.' } })).status, 303);
  // Isolate form sizing from the content-moderation heuristics for repeated text.
  const fixture = await readState(db);
  fixture.value.snapshot.posts[0].text = postText;
  fixture.value.snapshot.posts[0].replies[0].text = replyText;
  await commitState(db, fixture.revision, fixture.value, undefined, fixture);
  const native = (await dispatchMcp(new Request(origin + '/mcp', { headers: { 'oai-authenticated-user-id': 'alice' } }), envFor(db),
    { method: 'tools/call', params: { name: 'get_thread_context', arguments: { postId: fixture.value.snapshot.posts[0].id } } })).result;
  assert.ok(Buffer.byteLength(JSON.stringify(native)) < 15_500);
  assert.equal(native.structuredContent.thread.text, postText);
  assert.equal(native.structuredContent.recentReplies[0].text, replyText);
  assert.ok(native.content[0].text.includes(postText));
  assert.ok(native.content[0].text.includes(replyText));
  const page = await web(db, created.path);
  const signedToken = token(page, 'nested-reply');
  assert.ok(signedToken.length > 4096, `Unicode handoff length: ${signedToken.length}`);
  const form = { token: signedToken, text: 'I noticed different choices on my second read too.' };
  const result = await web(db, '/web/nested-reply', { form });
  assert.equal(result.status, 303, result.body);
  const fresh = await web(db, created.path);
  const stale = { token: token(fresh, 'nested-reply'), text: 'A follow-up to the earlier version of the reply.' };
  const loaded = await readState(db);
  const targetText = JSON.parse(Buffer.from(stale.token.split('.')[0], 'base64url')).target.arguments.replyText;
  const pending = [...loaded.value.snapshot.posts[0].replies];
  while (pending.length) {
    const reply = pending.pop();
    if (reply.text === targetText) { reply.text = 'This reply has been replaced with a different recommendation.'; break; }
    pending.push(...(reply.replies || []));
  }
  await commitState(db, loaded.revision, loaded.value, undefined, loaded);
  const rejected = await web(db, '/web/nested-reply', { form: stale });
  assert.ok(rejected.status >= 400, rejected.body);
  assert.ok(rejected.body.includes(`<pre class="post-text">${stale.text}</pre>`));
  assert.ok(rejected.body.includes(`href="${created.path}">Back to conversation</a>`));
  const after = await readState(db);
  assert.equal(JSON.stringify(after.value.snapshot.posts).includes(stale.text), false);
  db.sql.close();
});

test('browser actions require the signed-in account, exact origin and action-bound form', async () => {
  const db = database();
  const page = await web(db, '/');
  const form = { token: token(page, 'post'), text: 'A small note about reading.' };
  for (const [options, status] of [
    [{ subject: '' }, 401], [{ subject: 'bob' }, 403], [{ originHeader: null }, 403],
    [{ originHeader: 'https://other.example' }, 403], [{ extraHeaders: { 'sec-fetch-site': 'same-site' } }, 403],
    [{ form: { ...form, token: form.token + 'x' } }, 403], [{ form: { ...form, subject: 'bob' } }, 400],
  ]) assert.equal((await web(db, '/web/post', { form, ...options })).status, status);
  assert.equal((await web(db, '/web/profile', { form: { token: form.token } })).status, 403);
  assert.equal((await readState(db)).value.snapshot.posts.length, 0);
  const anonymous = await web(db, '/', { subject: '' });
  assert.doesNotMatch(anonymous.body, /action="\/web\/post"/);
  assert.match(anonymous.body, /signin-with-chatgpt/);
  db.sql.close();
});

test('profile edits belong to the browser identity and appear in the native plugin', async () => {
  const db = database();
  const page = await web(db, '/profile');
  const saved = await web(db, '/web/profile', { form: { token: token(page, 'profile'), displayName: 'Alice Reader', handle: 'alice_reader', bio: 'Books and walks.' } });
  assert.equal(saved.status, 303, saved.body);
  const profile = await rpc(db, 'alice', 'open_turnfeed_feed', { targetKind: 'profile', profileScope: 'self' });
  assert.equal(profile.profile.displayName, 'Alice Reader');
  assert.equal(profile.profile.bio, 'Books and walks.');
  const other = await rpc(db, 'bob', 'open_turnfeed_feed', { targetKind: 'profile', profileScope: 'self' });
  assert.notEqual(other.profile.displayName, 'Alice Reader');
  db.sql.close();
});

test('invalid handles keep profile edits available without changing the saved profile', async () => {
  const db = database();
  const initial = await web(db, '/profile');
  const initialNative = await rpc(db, 'alice', 'open_turnfeed_feed', { targetKind: 'profile', profileScope: 'self' });
  const draft = { displayName: 'Theodor N. Engøy', handle: 'engøy', bio: 'Bøker, ærlighet og åpenhet. <script>alert(1)</script>' };
  const rejected = await web(db, '/web/profile', { form: { token: token(initial, 'profile'), ...draft } });
  assert.equal(rejected.status, 422);
  assert.match(rejected.body, /Your profile was not saved/);
  assert.match(rejected.body, /Handles use only a–z, 0–9 and underscores/);
  assert.match(rejected.body, /value="engøy" aria-invalid="true" autofocus/);
  assert.match(rejected.body, /value="Theodor N. Engøy"/);
  assert.match(rejected.body, /Bøker, ærlighet og åpenhet\. &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rejected.body, /<script>alert\(1\)<\/script>|Something went wrong/);
  const unchanged = await rpc(db, 'alice', 'open_turnfeed_feed', { targetKind: 'profile', profileScope: 'self' });
  assert.deepEqual(unchanged.profile, initialNative.profile);
  const short = await web(db, '/web/profile', { form: { token: token(rejected, 'profile'), ...draft, handle: 'ab' } });
  assert.equal(short.status, 422);
  assert.match(short.body, /Handle must be 3-20 characters/);
  assert.match(short.body, /value="ab" aria-invalid="true"/);
  const saved = await web(db, '/web/profile', { form: { token: token(short, 'profile'), ...draft, handle: 'engoy', bio: 'Bøker, ærlighet og åpenhet.' } });
  assert.equal(saved.status, 303, saved.body);
  const profile = await rpc(db, 'alice', 'open_turnfeed_feed', { targetKind: 'profile', profileScope: 'self' });
  assert.equal(profile.profile.displayName, draft.displayName);
  assert.equal(profile.profile.publicHandle, 'engoy');
  db.sql.close();
});

test('own-post deletion requires review and cannot delete another account thread', async () => {
  const db = database(), created = await post(db, 'A temporary reading recommendation.');
  assert.equal((await web(db, created.path + '/delete', { subject: 'bob' })).status, 403);
  const preview = await web(db, created.path + '/delete');
  assert.match(preview.body, /replies/i);
  const form = { token: token(preview, 'delete') };
  assert.equal((await web(db, '/web/delete', { subject: 'bob', form })).status, 403);
  const removed = await web(db, '/web/delete', { form });
  assert.equal(removed.status, 303, removed.body);
  assert.equal((await readState(db)).value.snapshot.posts.length, 0);
  db.sql.close();
});

test('text stays text in HTML and feed pagination preserves older posts', async () => {
  const db = database();
  const markup = 'Does <b>bold</b> mean emphasis? I prefer plain text & clarity.';
  const first = await post(db, markup);
  const page = await web(db, first.path);
  assert.match(page.body, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.doesNotMatch(page.body, /<b>bold<\/b>/);
  assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  for (let i = 0; i < 4; i++) {
    const result = await rpc(db, `fixture-${i}`, 'create_post', { text: `Reading recommendation number ${i + 1}.`, visibility: 'public', clientId: `page-${i}` });
    assert.equal(result.published, true);
  }
  const feed = await web(db, '/?focus=latest');
  const href = feed.body.match(/href="([^"#]*cursor=[^"]+)"/)?.[1];
  assert.ok(href, 'next page link');
  const older = await web(db, href.replaceAll('&amp;', '&'));
  assert.equal(older.status, 200);
  assert.match(older.body, /&lt;b&gt;bold/);
  db.sql.close();
});

test('the feed serves the existing Turnfeed logo without changing its bytes', async () => {
  const response = await worker.fetch(new Request(origin + '/turnfeed-logo.png'), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(new URL('../assets/turnfeed-logo.png', import.meta.url)));
});

test('a lost storage acknowledgement never retries publishing automatically', async () => {
  const db = database();
  const page = await web(db, '/');
  const form = { token: token(page, 'post'), text: 'A note saved despite an interrupted acknowledgement.' };
  const batches = db.batchCount;
  db.failAfterCommit = true;
  const response = await web(db, '/web/post', { form });
  assert.equal(response.status, 503);
  assert.match(response.body, /may have completed/);
  assert.equal(db.batchCount, batches + 1);
  db.failAfterCommit = false;
  assert.equal((await readState(db)).value.snapshot.posts.length, 1);
  assert.equal((await web(db, '/web/post', { form })).status, 303);
  assert.equal((await readState(db)).value.snapshot.posts.length, 1);
  db.sql.close();
});
