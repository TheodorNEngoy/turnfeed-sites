import test from 'node:test';
import assert from 'node:assert/strict';
import { createModerator, ModerationError, publicTextProjection, changedPublicTexts } from '../worker/moderation.mjs';

const categories = Object.fromEntries(['harassment', 'harassment/threatening', 'hate', 'hate/threatening',
  'illicit', 'illicit/violent', 'self-harm', 'self-harm/intent', 'self-harm/instructions',
  'sexual', 'sexual/minors', 'violence', 'violence/graphic'].map(key => [key, false]));
const result = () => ({ flagged: false, categories: { ...categories } });
const reply = (results = [result()]) => Response.json({ results });
const unavailable = error => error instanceof ModerationError && error.code === 'moderation_unavailable' && error.status === 503;
const rejected = error => error instanceof ModerationError && error.code === 'moderation_rejected' && error.status === 422;

test('fixed endpoint/model, combined image input and content-specific per-request approval cache', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const body = JSON.parse(options.body);
    assert.equal(url, 'https://api.openai.com/v1/moderations');
    assert.equal(body.model, 'omni-moderation-latest');
    assert.equal(options.redirect, 'manual');
    assert.equal(Object.hasOwn(options,'credentials'), false);
    assert.equal(options.headers.authorization, 'Bearer local-test-only');
    return reply(body.input[0]?.type ? [result()] : body.input.map(result));
  };
  const check = createModerator('local-test-only', { fetcher });
  assert.deepEqual(await check({ texts: ['One public caption', 'Another field'] }), { approved: true });
  await check({ texts: ['One public caption', 'Another field'] });
  assert.equal(calls.length, 1);
  await check({ texts: ['A changed caption'] });
  const photo = { data: new Uint8Array([1, 2, 3]), mime: 'image/png' };
  await check({ texts: ['A changed caption'], photo });
  assert.deepEqual(JSON.parse(calls[2].options.body).input, [
    { type: 'text', text: 'A changed caption' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
  ]);
  await check({ texts: ['A changed caption'], photo });
  assert.equal(calls.length, 3);
  photo.data[0] = 9;
  await check({ texts: ['A changed caption'], photo });
  assert.equal(calls.length, 4);
  await createModerator('local-test-only', { fetcher })({ texts: ['A changed caption'] });
  assert.equal(calls.length, 5);
});

test('any flagged result or category rejects and refusals are never cached', async () => {
  let calls = 0;
  const check = createModerator('local-test-only', { fetcher: async () => { calls++; return reply([{ ...result(), flagged: true }]); } });
  await assert.rejects(check({ texts: ['A candidate'] }), rejected);
  await assert.rejects(check({ texts: ['A candidate'] }), rejected);
  assert.equal(calls, 2);
  await assert.rejects(createModerator('local-test-only', { fetcher: async () => reply([
    { ...result(), categories: { ...categories, hate: true } },
  ]) })({ texts: ['A candidate'] }), rejected);
});

test('missing credentials, status, redirects, network failures and timeouts fail closed', async () => {
  let called = false;
  await assert.rejects(createModerator('', { fetcher: async () => { called = true; return reply(); } })({ texts: ['Text'] }), unavailable);
  assert.equal(called, false);
  for (const fetcher of [
    async () => new Response('', { status: 429 }),
    async () => new Response('', { status: 500 }),
    async () => new Response('', { status: 302, headers: { location: 'https://other.example' } }),
    async () => ({ status: 200, redirected: true }),
    async () => ({ status: 200, url: 'https://other.example' }),
    async () => { throw new Error('private transport detail'); },
    async () => new Promise(() => {}),
  ]) await assert.rejects(createModerator('local-test-only', { fetcher, timeoutMs: 5 })({ texts: ['Text'] }), unavailable);
  assert.deepEqual(await createModerator('')({ texts: [] }), { approved: true });
});

test('missing, malformed, incomplete or oversized verdicts cannot approve content', async () => {
  for (const makeResponse of [
    () => Response.json({}), () => reply([]), () => reply([{ categories }]),
    () => reply([{ flagged: false }]), () => reply([{ flagged: false, categories: {} }]),
    () => reply([{ ...result(), categories: { ...categories, hate: 'false' } }]),
    () => reply([result(), result()]),
    () => new Response('{"results":[', { headers: { 'content-type': 'application/json' } }),
    () => new Response(' '.repeat(65_537), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '65537' } }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
  ]) await assert.rejects(createModerator('local-test-only', { fetcher: async () => makeResponse() })({ texts: ['Text'] }), unavailable);
});

test('unavailable diagnostics distinguish failure stages without exposing content, credentials or transport details', async t => {
  const logs = [];
  t.mock.method(console, 'error', value => logs.push(value));
  const privateText = 'PRIVATE_SUBMITTED_CAPTION', privateKey = 'PRIVATE_API_KEY';
  const privateImage = 'PRIVATE_IMAGE_BYTES', privateBody = 'PRIVATE_RESPONSE_BODY';
  const privateException = 'PRIVATE_EXCEPTION_MESSAGE', privateUrl = 'https://private.example/token';
  const privateHeader = 'PRIVATE_REQUEST_HEADER';
  const photo = { data: new TextEncoder().encode(privateImage), mime: 'image/png' };
  const cases = [
    { reason: 'missing_key', key: '' },
    { reason: 'fetch_unavailable', fetcher: null },
    { reason: 'before_request', beforeRequest: async () => { throw new Error(privateException); } },
    { reason: 'before_request', beforeRequest: async () => { throw new ModerationError(); } },
    { reason: 'network', fetcher: async () => { throw new Error(privateException + privateUrl); } },
    { reason: 'api_status', upstreamStatus: 401,
      fetcher: async () => new Response(privateBody, { status: 401, headers: { 'x-request-id': privateHeader } }) },
    { reason: 'api_redirect', upstreamStatus: 200,
      fetcher: async () => ({ status: 200, redirected: true, url: privateUrl }) },
    { reason: 'response_headers', upstreamStatus: 200,
      fetcher: async () => new Response(privateBody, { headers: { 'content-type': 'text/html', 'x-request-id': privateHeader } }) },
    { reason: 'response_body', upstreamStatus: 200,
      fetcher: async () => new Response(null, { headers: { 'content-type': 'application/json' } }) },
    { reason: 'response_body', upstreamStatus: 200,
      fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateException)); } }),
        { headers: { 'content-type': 'application/json' } }) },
    { reason: 'response_json', upstreamStatus: 200,
      fetcher: async () => new Response(privateBody, { headers: { 'content-type': 'application/json' } }) },
    { reason: 'response_shape', upstreamStatus: 200, fetcher: async () => Response.json({ detail: privateBody }) },
    { reason: 'timeout', fetcher: async () => new Promise(() => {}) },
  ];
  for (const { reason, upstreamStatus, key = privateKey, ...options } of cases) {
    const count = logs.length;
    const check = createModerator(key, { fetcher: async () => reply(), timeoutMs: 5, ...options });
    await assert.rejects(check({ texts: [privateText], photo }), error => {
      assert.ok(unavailable(error));
      assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'status']);
      assert.equal(error.message, new ModerationError().message);
      return true;
    });
    assert.equal(logs.length, count + 1, reason);
    assert.deepEqual(JSON.parse(logs.at(-1)), { event: 'turnfeed_moderation_unavailable', reason,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }) });
  }
  const serialized = JSON.stringify(logs);
  for (const secret of [privateText, privateKey, privateImage, Buffer.from(photo.data).toString('base64'),
    privateBody, privateException, privateUrl, privateHeader]) assert.ok(!serialized.includes(secret));
});

test('approved, rejected and rate-limited checks produce no unavailable diagnostic; logging failures retain the public error', async t => {
  const logs = [];
  const log = t.mock.method(console, 'error', value => logs.push(value));
  await createModerator('local-test-only', { fetcher: async () => reply() })({ texts: ['A candidate'] });
  await assert.rejects(createModerator('local-test-only', { fetcher: async () => reply([{ ...result(), flagged: true }]) })({ texts: ['A candidate'] }), rejected);
  await assert.rejects(createModerator('local-test-only', {
    beforeRequest: async () => { throw new ModerationError('moderation_rate_limited'); },
    fetcher: async () => { assert.fail('Rate-limited calls must not fetch'); },
  })({ texts: ['A candidate'] }), { code: 'moderation_rate_limited' });
  assert.deepEqual(logs, []);
  log.mock.mockImplementation(() => { throw new Error('Log sink unavailable'); });
  await assert.rejects(createModerator('')({ texts: ['A candidate'] }), unavailable);
});

test('input bounds reject before making a request and approval cache stays bounded', async () => {
  let calls = 0;
  const check = createModerator('local-test-only', { fetcher: async () => { calls++; return reply(); } });
  for (const input of [{ texts: ['x'.repeat(8193)] }, { texts: Array(17).fill('text') }, { texts: [null] },
    { photo: { data: new Uint8Array(1_048_577), mime: 'image/png' } },
    { photo: { data: new Uint8Array(), mime: 'image/png' } },
    { photo: { data: new Uint8Array([1]), mime: 'image/svg+xml' } }]) await assert.rejects(check(input), unavailable);
  assert.equal(calls, 0);
  for (let i = 0; i < 9; i++) await check({ texts: [`Caption ${i}`] });
  await check({ texts: ['Caption 0'] });
  assert.equal(calls, 10);
});

test('public projection is immutable despite core aliases and captures edits, nested replies and profile changes', () => {
  const snapshot = { posts: [{ id: 'p1', text: 'Original body', replies: [{ id: 'r1', text: 'First reply', replies: [] }] }],
    profiles: { alice: { displayName: 'Alice', handle: 'alice', bio: 'Books', websiteUrl: 'https://example.com' } } };
  const before = publicTextProjection(snapshot);
  assert.equal(Object.isFrozen(before), true);
  snapshot.posts[0].text = 'Edited body';
  snapshot.posts[0].correctionHistory = [{ text: 'Original body', reason: 'Clarified the example' }];
  snapshot.posts[0].replies[0].replies.push({ id: 'r2', text: 'Nested public reply' });
  snapshot.profiles.alice.bio = 'Gardening';
  assert.deepEqual(new Set(changedPublicTexts(before, snapshot)), new Set([
    'Edited body', 'Clarified the example', 'Nested public reply', 'Gardening',
  ]));
  assert.deepEqual(changedPublicTexts(publicTextProjection(snapshot), snapshot), []);
  snapshot.profiles.bob = { displayName: 'Imported public name' };
  assert.ok(changedPublicTexts(before, snapshot).includes('Imported public name'));
});

test('private fields and hidden, group or restricted content never enter projection; newly visible text does', () => {
  const hidden = { id: 'hidden', hidden: true, text: 'Hidden body', replies: [{ id: 'child', text: 'Hidden child' }] };
  const snapshot = { posts: [hidden,
    { id: 'group', groupId: 'g1', text: 'Group body' },
    { id: 'restricted', visibility: 'followers', text: 'Restricted body' },
    { id: 'audience', audience: { type: 'private' }, text: 'Private audience' },
    { id: 'public', text: 'Public body', media: [{ url: 'private-file-token' }], replies: [
      { id: 'hidden-reply', hidden: true, text: 'Hidden reply', replies: [{ id: 'nested', text: 'Hidden nested' }] },
    ] }], profiles: { alice: { displayName: 'Public name', email: 'private@example.com', avatarUrl: 'private-avatar-token' } },
    reports: [{ text: 'Private report' }], viewerStates: { alice: { hiddenWords: ['private setting'] } },
    messages: [{ text: 'Private conversation' }] };
  const before = publicTextProjection(snapshot);
  assert.deepEqual(new Set(Object.values(before)), new Set(['Public body', 'Public name']));
  hidden.hidden = false;
  assert.deepEqual(new Set(changedPublicTexts(before, snapshot)), new Set(['Hidden body', 'Hidden child']));
});

test('a new public quote screens existing source context without copying hidden or private sources', () => {
  const snapshot = { posts: [{ id: 'source', text: 'Existing public source' },
    { id: 'private', groupId: 'private-group', text: 'Private source' },
    { id: 'hidden', hidden: true, text: 'Hidden source' }] };
  const before = publicTextProjection(snapshot);
  snapshot.posts.push({ id: 'quote', text: 'New commentary', quotePostId: 'source' },
    { id: 'private-quote', text: 'Private source unavailable', quotePostId: 'private' },
    { id: 'hidden-quote', text: 'Hidden source unavailable', quotePostId: 'hidden' });
  const changed = changedPublicTexts(before, snapshot);
  assert.ok(changed.includes('Existing public source'));
  assert.ok(changed.includes('New commentary\n\nExisting public source'));
  assert.ok(!changed.includes('Private source'));
  assert.ok(!changed.includes('Hidden source'));
});
