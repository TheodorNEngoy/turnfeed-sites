import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import worker from '../worker/index.mjs';
import { dispatchMcp, makeCore } from '../worker/mcp.mjs';
import { readState } from '../worker/storage.mjs';
import { accountKey } from '../worker/identity.mjs';
import { logoBase64 } from '../worker/brand.generated.mjs';
import { database } from './sqlite-d1.mjs';
import { MODERATION_KEY, MODERATION_ENDPOINT, allowModerationFetch } from './moderation-fixture.mjs';

// All requests run inside the Worker with in-memory storage and a local moderator.
const origin = 'https://turnfeed.example';
const secret = 'avatar-integration-local-01234567890123456789';
const logo = Buffer.from(logoBase64, 'base64');
const headersFor = subject => subject ? { 'oai-authenticated-user-id': subject } : {};

function fixture(t) {
  const db = database(), objects = new Map(), calls = [];
  const schemas = makeCore({ origin, secret }).tools;
  let mode = 'allow', writes = 0, deletes = 0;
  t.after(() => db.sql.close());
  const env = { DB: db, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret,
    BUCKET: {
      async put(key, bytes) { writes++; objects.set(key, Buffer.from(bytes)); return { key }; },
      async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
      async delete(key) { deletes++; objects.delete(key); },
    },
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, MODERATION_ENDPOINT, 'The fixture must never access a network service');
    const body = JSON.parse(options.body); calls.push(body);
    if (mode === 'outage') return new Response('', { status: 503 });
    const response = await allowModerationFetch(url, options);
    if (mode !== 'flagged' || !body.input.some(input => input?.type === 'image_url')) return response;
    const result = await response.json();
    for (const item of result.results) item.flagged = true;
    return Response.json(result);
  });
  const get = (path, subject = 'alice') => worker.fetch(new Request(new URL(path, origin), {
    headers: headersFor(subject),
  }), env);
  const call = async (name, args = {}, subject = 'alice') => {
    const response = await dispatchMcp(new Request(origin + '/mcp', {
      headers: headersFor(subject),
    }), env, { method: 'tools/call', params: { name, arguments: args } });
    if (response.result?.structuredContent) {
      const schema = schemas.get(name)?.descriptor.outputSchema;
      assert.ok(schema, `${name} must declare its output schema`);
      const parsed = schema.safeParse(response.result.structuredContent);
      assert.equal(parsed.success, true, `${name}: ${JSON.stringify(parsed.error?.issues)}`);
    }
    return response;
  };
  return { db, env, objects, calls, get, call,
    get writes() { return writes; }, get deletes() { return deletes; },
    set mode(value) { mode = value; },
  };
}

const state = async f => (await readState(f.db)).value?.snapshot;
const rows = f => f.db.sql.prepare('SELECT * FROM turnfeed_photos').all();
const savedAvatar = async (f, subject = 'alice') => (await state(f))?.profiles?.[accountKey(subject, secret)]?.avatarUrl || '';

async function avatarToken(f) {
  const response = await f.get('/profile'), html = await response.text();
  assert.equal(response.status, 200, html.slice(-1500));
  const form = html.match(/<form[^>]*action="\/web\/avatar"[^>]*>([\s\S]*?)<\/form>/)?.[1];
  const token = form?.match(/name="token"\s+value="([^"]+)"/)?.[1];
  assert.ok(token, 'My profile must contain a signed picture form');
  return token;
}

async function submit(f, token, { remove = false, subject = 'alice', originHeader = origin, extraHeaders = {} } = {}) {
  const body = remove ? new URLSearchParams({ token }) : new FormData();
  if (!remove) {
    body.set('token', token);
    body.append('photo', new Blob([logo], { type: 'image/png' }), 'turnfeed.png');
  }
  const headers = { ...headersFor(subject), ...extraHeaders };
  if (originHeader !== null) headers.origin = originHeader;
  return worker.fetch(new Request(origin + (remove ? '/web/avatar-remove' : '/web/avatar'), {
    method: 'POST', headers, body,
  }), f.env);
}

async function save(f, token) {
  const response = await submit(f, token || await avatarToken(f));
  assert.equal(response.status, 303, (await response.clone().text()).slice(-1500));
  assert.equal(response.headers.get('location'), '/profile?done=saved');
  const url = await savedAvatar(f);
  assert.match(url, /^https:\/\/turnfeed\.theodornengoy\.chatgpt\.site\/photos\/[a-f0-9]{64}\.png$/);
  return url;
}

test('website picture upload creates no post and appears in profile, feed, thread and reply projections', async t => {
  const f = fixture(t);
  const profile = await f.call('set_profile', { displayName: 'Alice', handle: 'alice', bio: 'A reader and walker.', visibility: 'public' });
  assert.equal(profile.result?.structuredContent?.saved, true, JSON.stringify(profile));
  const url = await save(f), path = new URL(url).pathname;
  assert.equal((await state(f)).posts.length, 0);
  assert.equal(f.objects.size, 1); assert.equal(f.writes, 1); assert.equal(rows(f).length, 1);
  const mine = await f.call('open_turnfeed_feed', { targetKind: 'profile', profileScope: 'self' });
  assert.equal(mine.result.structuredContent.profile.avatarUrl, url);
  assert.equal(mine.result.structuredContent.profile.displayName, 'Alice');
  assert.equal(mine.result.structuredContent.profile.bio, 'A reader and walker.');
  const page = await f.get('/profile');
  assert.ok((await page.text()).includes(`src="${path}"`));
  const image = await f.get(path, '');
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('cache-control'), /no-store/);
  assert.ok((await image.arrayBuffer()).byteLength > 0);

  const created = await f.call('create_post', { text: 'Which local walking route would you recommend this weekend?', visibility: 'public', clientId: randomUUID() });
  assert.equal(created.result?.structuredContent?.published, true, JSON.stringify(created));
  const post = (await state(f)).posts[0];
  const other = await f.call('create_post', { text: 'Where is a pleasant outdoor place to spend an hour reading?', visibility: 'public', clientId: randomUUID() }, 'bob');
  assert.equal(other.result?.structuredContent?.published, true, JSON.stringify(other));
  const otherPost = (await state(f)).posts.find(item => item.id !== post.id);
  // Feed previews deliberately omit the post author's own replies, so use a
  // second member's thread to verify the compact reply-avatar projection.
  const replied = await f.call('publish_public_reply_to_post', {
    ...other.result.structuredContent.replyHandoff.targetArguments,
    text: 'The coastal trail has a sheltered place to stop and read.', visibility: 'public', clientId: randomUUID(),
  });
  assert.equal(replied.result?.structuredContent?.published, true, JSON.stringify(replied));
  const feed = (await f.call('get_feed_digest', { focus: 'latest', limit: 4 }, 'bob')).result.structuredContent;
  const item = feed.items.find(item => item.postId === post.id);
  assert.equal(item?.authorAvatarUrl, url);
  assert.equal(feed.items.find(item => item.postId === otherPost.id)?.recentReplies[0]?.authorAvatarUrl, url);
  const thread = (await f.call('get_thread_context', { postId: post.id }, 'bob')).result.structuredContent;
  assert.equal(thread.thread.authorAvatarUrl, url);
  const replyThread = (await f.call('get_thread_context', { postId: otherPost.id }, 'bob')).result.structuredContent;
  assert.equal(replyThread.recentReplies[0]?.authorAvatarUrl, url);
  assert.ok((await (await f.get('/post/' + post.id, 'bob')).text()).includes(`src="${path}"`));
  assert.ok((await (await f.get('/post/' + otherPost.id, 'bob')).text()).includes(`src="${path}"`));
});

test('an identical saved picture retry succeeds during a moderation outage without another object or API call', async t => {
  const f = fixture(t), token = await avatarToken(f), url = await save(f, token);
  const screened = f.calls.length; assert.ok(screened > 0);
  f.mode = 'outage';
  assert.equal(await save(f, token), url);
  assert.equal(f.calls.length, screened);
  assert.equal(f.writes, 1); assert.equal(f.objects.size, 1); assert.equal(rows(f).length, 1);
  assert.equal((await state(f)).posts.length, 0);
});

test('replacement, removal and reset retire old picture objects and URLs; stale forms cannot overwrite a replacement', async t => {
  const f = fixture(t), first = await save(f);
  const stale = await avatarToken(f), second = await save(f);
  assert.notEqual(second, first, 'Fresh forms give identical file bytes a fresh upload identity');
  assert.equal((await f.get(first, '')).status, 404);
  assert.equal(f.objects.has(new URL(first).pathname.slice(1)), false);
  assert.equal(f.objects.size, 1);
  const staleSave = await submit(f, stale);
  assert.equal(staleSave.status, 409, (await staleSave.text()).slice(-1500));
  const staleRemove = await submit(f, stale, { remove: true });
  assert.equal(staleRemove.status, 409, (await staleRemove.text()).slice(-1500));
  assert.equal(await savedAvatar(f), second); assert.equal(f.objects.size, 1);
  const removed = await submit(f, await avatarToken(f), { remove: true });
  assert.equal(removed.status, 303, (await removed.text()).slice(-1500));
  assert.equal(await savedAvatar(f), ''); assert.equal(f.objects.size, 0);
  assert.equal((await f.get(second, '')).status, 404);
  const third = await save(f);
  assert.equal(f.objects.size, 1);
  const reset = await f.call('reset_me');
  assert.equal(reset.result?.structuredContent?.ok, true, JSON.stringify(reset));
  assert.equal(await savedAvatar(f), ''); assert.equal(f.objects.size, 0);
  assert.equal((await f.get(third, '')).status, 404);
  assert.ok(rows(f).every(row => row.status === 'deleted' && row.bytes === 0));
  assert.equal((await state(f)).posts.length, 0);
});

test('replaying an upload after removal cannot resurrect its tombstone', async t => {
  const f = fixture(t), token = await avatarToken(f), url = await save(f, token);
  assert.equal((await submit(f, await avatarToken(f), { remove: true })).status, 303);
  const before = { calls: f.calls.length, writes: f.writes, deletes: f.deletes };
  const retry = await submit(f, token);
  assert.equal(retry.status, 409, (await retry.text()).slice(-1500));
  assert.equal(await savedAvatar(f), ''); assert.equal(f.objects.size, 0);
  assert.deepEqual({ calls: f.calls.length, writes: f.writes, deletes: f.deletes }, before);
  assert.equal(rows(f).length, 1); assert.equal(rows(f)[0].status, 'deleted'); assert.equal(rows(f)[0].bytes, 0);
  assert.equal((await f.get(url, '')).status, 404);
});

test('anonymous, other-account and cross-origin uploads are rejected before photo storage or screening', async t => {
  const f = fixture(t), token = await avatarToken(f), mutations = f.db.executed.length;
  for (const [options, expected] of [
    [{ subject: '' }, 401], [{ subject: 'bob' }, 403],
    [{ originHeader: null }, 403], [{ originHeader: 'https://other.example' }, 403],
    [{ extraHeaders: { 'sec-fetch-site': 'cross-site' } }, 403],
  ]) {
    for (const remove of [false, true]) {
      const response = await submit(f, token, { ...options, remove });
      assert.equal(response.status, expected, (await response.text()).slice(-1000));
    }
  }
  assert.equal(f.db.executed.length, mutations);
  assert.equal(f.writes, 0); assert.equal(f.objects.size, 0); assert.equal(rows(f).length, 0); assert.equal(f.calls.length, 0);
  assert.equal(await savedAvatar(f), '');
});

test('flagged pictures and unavailable screening never create public pictures or storage objects', async t => {
  const f = fixture(t);
  for (const [mode, expected] of [['flagged', 422], ['outage', 503]]) {
    const token = await avatarToken(f); f.mode = mode;
    const response = await submit(f, token);
    assert.equal(response.status, expected, (await response.text()).slice(-1500));
    assert.equal(await savedAvatar(f), '');
    assert.equal(f.writes, 0); assert.equal(f.objects.size, 0); assert.equal(rows(f).length, 0);
    assert.equal((await state(f))?.posts?.length || 0, 0);
  }
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.input.some(input => input?.type === 'image_url')));
});

test('raw MCP avatar URLs cannot import an external image or reuse another member’s picture', async t => {
  const f = fixture(t), url = await save(f), before = { writes: f.writes, calls: f.calls.length };
  for (const [subject, avatarUrl] of [['alice', 'https://other.example/profile.png'], ['bob', url]]) {
    const result = await f.call('set_profile', { avatarUrl, visibility: 'public' }, subject);
    assert.equal(result.error?.code, -32602, JSON.stringify(result));
  }
  assert.equal(await savedAvatar(f), url); assert.equal(await savedAvatar(f, 'bob'), '');
  assert.equal(f.objects.size, 1); assert.equal(rows(f).length, 1);
  assert.deepEqual({ writes: f.writes, calls: f.calls.length }, before);
});
