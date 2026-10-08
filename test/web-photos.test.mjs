import { MODERATION_KEY, installModerationFixture, allowModerationFetch } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import worker from '../worker/index.mjs';
import { database } from './sqlite-d1.mjs';
import { readState } from '../worker/storage.mjs';
import { PHOTO_LIMITS, sanitizePhoto } from '../worker/photos.mjs';

installModerationFixture();

// Requests go directly to the in-memory Worker, never to this public hostname.
const origin = 'https://turnfeed.example';
const secret = 'website-photo-test-012345678901234567890123456789';
const caption = 'The evening light made this quiet coastal walk worth remembering.';
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, body = Buffer.alloc(0)) {
  const data = Buffer.alloc(body.length + 12);
  data.writeUInt32BE(body.length); data.write(type, 4); body.copy(data, 8);
  data.writeUInt32BE(crc32(data.subarray(4, -4)), data.length - 4);
  return data;
}
function png(blue = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Comment\0private-location')),
    chunk('IDAT', deflateSync(Buffer.from(blue ? [0, 0, 0, 255, 255] : [0, 255, 0, 0, 255]))), chunk('IEND')]);
}
function fixture(t) {
  const db = database(); t.after(() => db.sql.close());
  t.mock.method(globalThis, 'fetch', allowModerationFetch);
  const bucket = { objects: new Map(), writes: 0, reads: 0, deletes: 0,
    async put(key, data, options) { this.writes++; this.objects.set(key, { bytes: Buffer.from(data), options }); return { key }; },
    async get(key) { this.reads++; const value = this.objects.get(key); return value ? { body: value.bytes } : null; },
    async delete(key) { this.deletes++; this.objects.delete(key); },
  };
  return { db, bucket, env: { DB: db, BUCKET: bucket, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret } };
}
function headers(subject = 'alice') {
  return subject ? { 'oai-authenticated-user-id': subject, 'oai-authenticated-user-full-name': subject === 'alice' ? 'Alice Example' : 'Bob Example' } : {};
}
async function get(f, path, subject = 'alice') {
  return worker.fetch(new Request(origin + path, { headers: headers(subject) }), f.env);
}
async function postToken(f) {
  const response = await get(f, '/'), html = await response.text();
  assert.equal(response.status, 200);
  const form = html.match(/<form[^>]*action="\/web\/post"[^>]*>([\s\S]*?)<\/form>/)?.[1];
  assert.ok(form, 'Signed-in feed should provide a post form');
  assert.match(html, /enctype="multipart\/form-data"/);
  const token = form.match(/name="token"\s+value="([^"]+)"/)?.[1];
  assert.ok(token, 'Post form must carry an account-bound token');
  return token;
}
function formFor(token, { text = caption, photo = png(), mime = 'image/png' } = {}) {
  const form = new FormData(); form.set('token', token); form.set('text', text);
  if (photo !== null) form.append('photo', new Blob([photo], { type: mime }), 'walk.png');
  return form;
}
async function submit(f, form, { subject = 'alice', originHeader = origin, extraHeaders = {} } = {}) {
  const requestHeaders = { ...headers(subject), ...extraHeaders };
  if (originHeader !== null) requestHeaders.origin = originHeader;
  return worker.fetch(new Request(origin + '/web/post', { method: 'POST', headers: requestHeaders, body: form }), f.env);
}
async function posts(f) { return (await readState(f.db)).value?.snapshot?.posts || []; }
function photoRows(f) { return f.db.sql.prepare('SELECT * FROM turnfeed_photos').all(); }
async function assertRejectedWithoutWrites(f, response, status) {
  const body = await response.text();
  if (status) assert.equal(response.status, status, body);
  else assert.ok(response.status >= 400, body);
  assert.equal((await posts(f)).length, 0);
  assert.equal(f.bucket.writes, 0); assert.equal(f.bucket.objects.size, 0);
  assert.equal(photoRows(f).length, 0);
}

test('signed-in multipart photo publication renders in its thread and serves sanitized bytes', async t => {
  const f = fixture(t), token = await postToken(f);
  const response = await submit(f, formFor(token));
  assert.equal(response.status, 303, await response.clone().text());
  const location = response.headers.get('location'); assert.match(location, /^\/post\/[^?]+\?done=posted$/);
  const saved = await posts(f); assert.equal(saved.length, 1); assert.equal(saved[0].text, caption);
  assert.equal(saved[0].media.length, 1); assert.equal(saved[0].media[0].type, 'image');
  const imagePath = new URL(saved[0].media[0].url).pathname;
  assert.match(imagePath, /^\/photos\/[a-f0-9]{64}\.png$/);
  const thread = await get(f, location, '');
  assert.equal(thread.status, 200); assert.ok((await thread.text()).includes(`src="${imagePath}"`));
  const image = await get(f, imagePath, '');
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('cache-control'), /no-store/);
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await image.arrayBuffer());
  assert.deepEqual(bytes, Buffer.from(sanitizePhoto(png()).data));
  assert.equal(Number(image.headers.get('content-length')), bytes.length);
  assert.doesNotMatch(bytes.toString('latin1'), /private-location/);
  assert.equal(f.bucket.writes, 1); assert.equal(f.bucket.objects.size, 1);
});

test('same signed token and photo retries produce one post and one object', async t => {
  const f = fixture(t), token = await postToken(f);
  const first = await submit(f, formFor(token));
  assert.equal(first.status, 303, await first.clone().text());
  const retry = await submit(f, formFor(token));
  assert.equal(retry.status, 303, await retry.clone().text());
  assert.equal(retry.headers.get('location'), first.headers.get('location'));
  assert.equal((await posts(f)).length, 1); assert.equal(f.bucket.writes, 1);
  assert.equal(f.bucket.objects.size, 1); assert.equal(photoRows(f).length, 1);
});

test('multipart forms without a chosen file still publish ordinary text', async t => {
  const f = fixture(t);
  const first = await submit(f, formFor(await postToken(f), { photo: null }));
  assert.equal(first.status, 303, await first.clone().text());
  // Browsers encode filename="" for an unselected file input. Node's FormData
  // serializer drops that parameter, so preserve the actual browser wire form.
  const nextToken = await postToken(f), boundary = 'empty-browser-photo';
  const form = [
    `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${nextToken}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nA second walking route follows the river through the old town.`,
    `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n`,
    `--${boundary}--\r\n`,
  ].join('\r\n');
  const second = await submit(f, form, { extraHeaders: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(second.status, 303, await second.clone().text());
  const saved = await posts(f); assert.equal(saved.length, 2); assert.ok(saved.every(post => post.media.length === 0));
  assert.equal(f.bucket.writes, 0); assert.equal(photoRows(f).length, 0);
});

test('cross-origin, unsigned and other-account multipart requests fail before R2', async t => {
  const f = fixture(t), token = await postToken(f);
  for (const [options, status] of [
    [{ subject: '' }, 401], [{ subject: 'bob' }, 403], [{ originHeader: null }, 403],
    [{ originHeader: 'https://unrelated.example' }, 403],
    [{ extraHeaders: { 'sec-fetch-site': 'cross-site' } }, 403],
    [{ extraHeaders: { 'sec-fetch-site': 'same-site' } }, 403],
  ]) await assertRejectedWithoutWrites(f, await submit(f, formFor(token), options), status);
  await assertRejectedWithoutWrites(f, await submit(f, formFor(token + 'x')), 403);
});

test('an empty string photo field publishes text without storing a photo', async t => {
  const f = fixture(t), form = formFor(await postToken(f), { photo: null });
  // Some deployed multipart parsers return this for the browser's empty file.
  form.set('photo', '');
  const response = await submit(f, form);
  assert.equal(response.status, 303, await response.clone().text());
  const saved = await posts(f);
  assert.equal(saved.length, 1); assert.equal(saved[0].text, caption);
  assert.equal(saved[0].media.length, 0); assert.equal(f.bucket.writes, 0);
  assert.equal(photoRows(f).length, 0);
});

test('a selected but empty named file is still rejected', async t => {
  const f = fixture(t);
  await assertRejectedWithoutWrites(f, await submit(f, formFor(await postToken(f), { photo: Buffer.alloc(0) })), 400);
});

test('duplicate files, string photo fields and MIME mismatches fail without publishing', async t => {
  const f = fixture(t), token = await postToken(f);
  const duplicate = formFor(token); duplicate.append('photo', new Blob([png()], { type: 'image/png' }), 'second.png');
  await assertRejectedWithoutWrites(f, await submit(f, duplicate), 400);
  const textPhoto = formFor(token, { photo: null }); textPhoto.set('photo', 'https://example.org/fake.png');
  await assertRejectedWithoutWrites(f, await submit(f, textPhoto), 400);
  await assertRejectedWithoutWrites(f, await submit(f, formFor(token, { mime: 'image/jpeg' })), 400);
  await assertRejectedWithoutWrites(f, await submit(f, formFor(token, { mime: 'text/html' })), 400);
  const badText = formFor(token); badText.set('text', new Blob(['caption'], { type: 'text/plain' }), 'caption.txt');
  await assertRejectedWithoutWrites(f, await submit(f, badText), 400);
});

test('file and streamed request size limits reject before creating an object or post', async t => {
  const f = fixture(t), token = await postToken(f);
  await assertRejectedWithoutWrites(f, await submit(f, formFor(token, { photo: Buffer.alloc(PHOTO_LIMITS.bytes + 1) })), 400);
  const huge = formFor(token, { photo: Buffer.alloc(PHOTO_LIMITS.bytes + 32_769) });
  // A forged low Content-Length cannot bypass the actual stream byte limit.
  await assertRejectedWithoutWrites(f, await submit(f, huge, { extraHeaders: { 'content-length': '0' } }), 413);
});

test('raw MCP webPhoto JSON cannot access the trusted browser upload option', async t => {
  const f = fixture(t);
  for (const [index, placement] of ['arguments', 'params', 'root'].entries()) {
    const fakePhoto = { bytes: [...png()], mime: 'image/png' };
    const args = { text: 'A note about a different walking trail number ' + index + '.', visibility: 'public', clientId: 'raw-web-photo-' + index };
    const body = { jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name: 'create_post', arguments: args } };
    if (placement === 'arguments') args.webPhoto = fakePhoto;
    else if (placement === 'params') body.params.webPhoto = fakePhoto;
    else body.webPhoto = fakePhoto;
    const response = await worker.fetch(new Request(origin + '/mcp', { method: 'POST', headers: {
      ...headers(), 'content-type': 'application/json', origin,
    }, body: JSON.stringify(body) }), f.env);
    assert.ok(response.status < 500, await response.clone().text());
    assert.equal(f.bucket.writes, 0); assert.equal(photoRows(f).length, 0);
    assert.ok((await posts(f)).every(post => post.media.length === 0));
  }
});

test('changed retries preserve the original post and retire a rejected replacement photo', async t => {
  const f = fixture(t), token = await postToken(f);
  const first = await submit(f, formFor(token));
  assert.equal(first.status, 303, await first.clone().text());
  const original = (await posts(f))[0], originalUrl = original.media[0].url;
  const changedText = await submit(f, formFor(token, { text: 'This replacement caption must not change an earlier published post.' }));
  assert.ok(changedText.status >= 400, await changedText.clone().text());
  assert.equal(f.bucket.objects.size, 1); assert.equal(f.bucket.writes, 1);
  const changedPhoto = await submit(f, formFor(token, { photo: png(true) }));
  assert.ok(changedPhoto.status >= 400, await changedPhoto.clone().text());
  const saved = await posts(f); assert.equal(saved.length, 1); assert.equal(saved[0].text, caption);
  assert.equal(saved[0].media[0].url, originalUrl); assert.equal(f.bucket.objects.size, 1);
  assert.equal(photoRows(f).filter(row => row.status === 'ready').length, 1);
  assert.equal(photoRows(f).filter(row => row.status === 'deleted' && row.bytes === 0).length, 1);
  const image = await get(f, new URL(originalUrl).pathname, ''); assert.equal(image.status, 200);
});

test('a definite caption rejection leaves no ready unpublished photo or object', async t => {
  const f = fixture(t), token = await postToken(f);
  const rejected = await submit(f, formFor(token, { text: 'Hello' }));
  assert.ok(rejected.status >= 400, await rejected.clone().text());
  assert.equal((await posts(f)).length, 0); assert.equal(f.bucket.objects.size, 0);
  assert.equal(f.bucket.writes, 1); assert.equal(f.bucket.deletes, 1);
  const rows = photoRows(f); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'deleted'); assert.equal(rows[0].bytes, 0);
});
