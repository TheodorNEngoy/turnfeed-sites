import test from 'node:test';
import assert from 'node:assert/strict';
import { MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import worker from '../worker/index.mjs';
import { database } from './sqlite-d1.mjs';
import { readState, commitState } from '../worker/storage.mjs';

installModerationFixture();
const origin = 'https://delete-modal.example';
const secret = 'delete-modal-tests-012345678901234567890123456789';
const env = DB => ({ DB, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret });
const identity = subject => subject ? { 'oai-authenticated-user-id': subject } : {};
async function web(db, path, { subject = 'alice', form, originHeader = origin, accept = 'application/json', extraHeaders = {} } = {}) {
  const response = await worker.fetch(new Request(origin + path, { method: form ? 'POST' : 'GET',
    headers: { ...identity(subject), accept, ...extraHeaders,
      ...(form ? { origin: originHeader, 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    ...(form ? { body: new URLSearchParams(form) } : {}) }), env(db));
  const body = await response.text();
  return { status: response.status, headers: response.headers, body,
    data: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(body) : undefined };
}
async function rpc(db, subject, name, args) {
  const response = await worker.fetch(new Request(origin + '/mcp', { method: 'POST', headers: {
    ...identity(subject), 'content-type': 'application/json',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env(db));
  const data = (await response.json()).result?.structuredContent;
  assert.equal(data?.ok, true, JSON.stringify(data));
  return data;
}
async function fixture(t) {
  const db = database(); t.after(() => db.sql.close());
  for (const subject of ['alice', 'bob', 'carol']) await rpc(db, subject, 'set_profile', { displayName: subject.toUpperCase(), handle: subject, visibility: 'public' });
  const post = await rpc(db, 'alice', 'create_post', { text: 'Which story would you read again?', visibility: 'public', clientId: 'modal-post' });
  const other = await rpc(db, 'alice', 'create_post', { text: 'What small detail made your afternoon better?', visibility: 'public', clientId: 'modal-other-post' });
  await rpc(db, 'bob', 'publish_public_reply_to_post', { ...post.replyHandoff.targetArguments, text: 'Earthsea rewards another reading.', visibility: 'public', clientId: 'modal-reply' });
  let context = await rpc(db, 'bob', 'get_thread_context', { postId: post.postId });
  await rpc(db, 'carol', 'publish_public_reply_to_reply', { ...context.recentReplies[0].replyHandoff.targetArguments, text: 'The characters change on each reading.', visibility: 'public', clientId: 'modal-descendant' });
  await rpc(db, 'carol', 'publish_public_reply_to_post', { ...post.replyHandoff.targetArguments, text: 'I would revisit a travel memoir.', visibility: 'public', clientId: 'modal-sibling' });
  const path = `/post/${post.postId}`;
  const page = await web(db, path, { subject: 'bob', accept: 'text/html' });
  const links = [...page.body.matchAll(/href="([^"]*\/actions\?reply=[^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'));
  let replyPath;
  for (const link of new Set(links)) {
    const preview = await web(db, link, { subject: 'bob' });
    if (preview.data?.text === 'Earthsea rewards another reading.') replyPath = link;
  }
  assert.ok(replyPath, 'Missing own reply control');
  return { db, path, replyPath, postId: post.postId, otherPostId: other.postId };
}
async function prepared(f, kind) {
  const subject = kind === 'post' ? 'alice' : 'bob';
  const preview = await web(f.db, kind === 'post' ? f.path + '/delete' : f.replyPath, { subject });
  assert.equal(preview.status, 200, preview.body);
  return { ...preview.data, subject };
}

test('JSON previews return only the reviewed owner target and a signed token without changing data', async t => {
  const f = await fixture(t), before = await readState(f.db), writes = f.db.executed.length;
  for (const kind of ['post', 'reply']) {
    const result = await prepared(f, kind);
    assert.deepEqual(Object.keys(result).sort(), ['action', 'authorName', 'kind', 'ok', 'postId', 'subject', 'text', 'token']);
    assert.equal(result.ok, true);
    assert.equal(result.kind, kind);
    assert.equal(result.postId, f.postId);
    assert.equal(result.authorName, kind === 'post' ? 'ALICE' : 'BOB');
    assert.equal(result.text, kind === 'post' ? 'Which story would you read again?' : 'Earthsea rewards another reading.');
    assert.equal(result.action, kind === 'post' ? '/web/delete' : '/web/delete-reply');
    assert.match(result.token, /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
  }
  const after = await readState(f.db);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.value, before.value);
  assert.equal(f.db.executed.length, writes);
  const html = await web(f.db, f.path + '/delete', { accept: 'text/html' });
  assert.equal(html.status, 200);
  assert.match(html.body, /action="\/web\/delete"/);
  assert.match(html.body, /all replies/);
  const replyHtml = await web(f.db, f.replyPath, { subject: 'bob', accept: 'text/html' });
  assert.match(replyHtml.body, /action="\/web\/delete-reply"/);
});

test('JSON previews deny wrong owners and non-reply action routes', async t => {
  const f = await fixture(t);
  for (const [path, subject] of [[f.path + '/delete', 'bob'], [f.path + '/delete', ''], [f.replyPath, 'alice'], [f.path + '/actions', 'alice'], [f.path + '/actions', 'bob']]) {
    const result = await web(f.db, path, { subject });
    assert.ok([403, 409].includes(result.status), `${subject || 'anonymous'}: ${path} returned ${result.status}`);
    assert.equal(result.data?.ok, undefined);
    assert.doesNotMatch(result.body, /"token":/);
  }
  const anonymous = await web(f.db, f.replyPath, { subject: '' });
  assert.equal(anonymous.status, 303);
  assert.match(anonymous.headers.get('location'), /^\/signin-with-chatgpt/);
});

test('confirmed post deletion returns JSON and removes only the chosen conversation', async t => {
  const f = await fixture(t), preview = await prepared(f, 'post');
  const result = await web(f.db, preview.action, { form: { token: preview.token } });
  assert.equal(result.status, 200, result.body);
  assert.deepEqual(result.data, { ok: true, deleted: 'post', postId: f.postId });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('location'), null);
  const after = await readState(f.db);
  assert.deepEqual(after.value.snapshot.posts.map(post => post.id), [f.otherPostId]);
  const replay = await web(f.db, preview.action, { form: { token: preview.token } });
  assert.ok(replay.status >= 400, replay.body);
  assert.equal(replay.data?.ok, undefined);
  assert.deepEqual((await readState(f.db)).value.snapshot.posts.map(post => post.id), [f.otherPostId]);
});

test('confirmed reply deletion removes its descendants while preserving sibling replies and the post', async t => {
  const f = await fixture(t), preview = await prepared(f, 'reply');
  const result = await web(f.db, preview.action, { subject: 'bob', form: { token: preview.token } });
  assert.equal(result.status, 200, result.body);
  assert.deepEqual(result.data, { ok: true, deleted: 'reply', postId: f.postId });
  const after = await readState(f.db), post = after.value.snapshot.posts.find(item => item.id === f.postId);
  assert.equal(after.value.snapshot.posts.length, 2);
  assert.deepEqual(post.replies.map(reply => reply.text), ['I would revisit a travel memoir.']);
  assert.ok(!JSON.stringify(post).includes('The characters change on each reading.'));
  const replay = await web(f.db, preview.action, { subject: 'bob', form: { token: preview.token } });
  assert.ok(replay.status >= 400, replay.body);
  assert.equal(replay.data?.ok, undefined);
});

test('JSON deletion retains actor, origin, action, signed-token and form-scope validation', async t => {
  const f = await fixture(t);
  for (const kind of ['post', 'reply']) {
    const preview = await prepared(f, kind), before = (await readState(f.db)).value.snapshot.posts;
    const forged = preview.token.slice(0, -1) + (preview.token.endsWith('a') ? 'b' : 'a');
    for (const options of [
      { subject: 'carol', form: { token: preview.token } },
      { subject: preview.subject, form: { token: preview.token }, originHeader: 'https://other.example' },
      { subject: preview.subject, form: { token: preview.token }, extraHeaders: { 'sec-fetch-site': 'same-site' } },
      { subject: preview.subject, form: { token: forged } },
      { subject: preview.subject, form: { token: preview.token, scope: 'all_posts' } },
      { subject: preview.subject, form: [['token', preview.token], ['token', preview.token]] },
    ]) {
      const rejected = await web(f.db, preview.action, options);
      assert.ok(rejected.status >= 400, rejected.body);
      assert.equal(rejected.data?.ok, undefined);
    }
    const wrongAction = await web(f.db, kind === 'post' ? '/web/delete-reply' : '/web/delete', { subject: preview.subject, form: { token: preview.token } });
    assert.equal(wrongAction.status, 403);
    assert.deepEqual((await readState(f.db)).value.snapshot.posts, before);
  }
});

test('changed content and failed storage cannot return a deletion success', async t => {
  const f = await fixture(t), postPreview = await prepared(f, 'post'), replyPreview = await prepared(f, 'reply');
  const loaded = await readState(f.db);
  loaded.value.snapshot.posts.find(post => post.id === f.postId).text = 'The author changed this question after preview.';
  await commitState(f.db, loaded.revision, loaded.value, undefined, loaded);
  for (const preview of [postPreview, replyPreview]) {
    const stale = await web(f.db, preview.action, { subject: preview.subject, form: { token: preview.token } });
    assert.equal(stale.status, 409, stale.body);
    assert.equal(stale.data?.ok, undefined);
  }
  const fresh = await prepared(f, 'post');
  f.db.failBeforeCommit = true;
  const failed = await web(f.db, fresh.action, { form: { token: fresh.token } });
  f.db.failBeforeCommit = false;
  assert.ok(failed.status >= 400, failed.body);
  assert.equal(failed.data?.ok, undefined);
  assert.equal((await readState(f.db)).value.snapshot.posts.length, 2);
});
