import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { database } from './sqlite-d1.mjs';
import { PHOTO_LIMITS, sanitizePhoto, stagePhoto, lookupPhoto, removePhoto } from '../worker/photos.mjs';

const owner = 'a'.repeat(40), other = 'b'.repeat(40);
const secret = 'photo-test-secret-01234567890123456789';
const now = Date.parse('2026-10-08T10:00:00Z');
const source = { file_id: 'post-one:file-one', download_url: 'https://files.oaiusercontent.com/photo?sig=private-token', mime_type: 'image/png' };
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, body = Buffer.alloc(0)) {
  const result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length); result.write(type, 4); body.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function png({ width = 1, height = 1, metadata = true } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(metadata ? [chunk('tEXt', Buffer.from('Comment\0private-location')), chunk('eXIf', Buffer.from('secret-exif'))] : []),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND')]);
}
function segment(marker, data) {
  const result = Buffer.alloc(data.length + 4); result[0] = 255; result[1] = marker;
  result.writeUInt16BE(data.length + 2, 2); Buffer.from(data).copy(result, 4); return result;
}
function jpeg({ width = 1, height = 1 } = {}) {
  const table = [1, ...Array(15).fill(0), 0];
  return Buffer.concat([Buffer.from([255, 216]), segment(0xe1, Buffer.from('Exif\0secret-location')),
    segment(0xfe, Buffer.from('private comment')), segment(0xdb, [0, ...Array(64).fill(1)]),
    segment(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]),
    segment(0xc4, [0, ...table, 0x10, ...table]), segment(0xda, [1, 1, 0, 0, 63, 0]), Buffer.from([0x3f, 255, 217])]);
}
function bucket() {
  return { objects: new Map(), writes: 0, deletes: 0, failPut: false, failDelete: false,
    async put(key, data, options) { this.writes++; this.objects.set(key, { data: Buffer.from(data), options });
      if (this.failPut) throw new Error('private-url-not-for-users'); return { key }; },
    async delete(key) { this.deletes++; if (this.failDelete) throw new Error('private-url-not-for-users'); this.objects.delete(key); },
  };
}
function fixture() {
  const db = database(), store = bucket(); let fetches = 0;
  return { db, store, get fetches() { return fetches; },
    args: { db, bucket: store, owner, secret, now, file: source,
      fetcher: async (url, init) => { fetches++; assert.equal(url, source.download_url); assert.equal(init.redirect, 'manual');
        assert.equal(Object.hasOwn(init,'credentials'),false); assert.equal(init.headers,undefined);
        assert.ok(init.signal); return new Response(png(), { headers: { 'content-type': 'image/png' } }); } } };
}
const errorCode = code => error => error.code === code && !/private-token|oaiusercontent|private-url/.test(error.message);

test('PNG and JPEG structure checks strip metadata and enforce dimensions/size', () => {
  for (const [input, mime] of [[png(), 'image/png'], [jpeg(), 'image/jpeg']]) {
    const result = sanitizePhoto(input);
    assert.equal(result.mime, mime); assert.ok(result.data.length < input.length);
    assert.doesNotMatch(Buffer.from(result.data).toString('latin1'), /secret|private|Exif|eXIf|tEXt/);
    assert.deepEqual(sanitizePhoto(result.data).data, result.data);
    assert.throws(() => sanitizePhoto(input.subarray(0, -1)), errorCode('photo_invalid'));
    assert.throws(() => sanitizePhoto(Buffer.concat([input, Buffer.from([0])])), errorCode('photo_invalid'));
  }
  for (const input of [png({ width: 4097 }), png({ width: 4096, height: 4096 }), jpeg({ width: 0 }),
    jpeg({ height: 4097 }), Buffer.alloc(PHOTO_LIMITS.bytes + 1), Buffer.from('<svg onload=alert(1)>')]) {
    assert.throws(() => sanitizePhoto(input), errorCode('photo_invalid'));
  }
  const corrupted = png(); corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => sanitizePhoto(corrupted), errorCode('photo_invalid'));
});

test('stage preserves bytes privately, returns stable owner-bound IDs and retries without another fetch', async () => {
  const f = fixture();
  try {
    const result = await stagePhoto(f.args), row = await lookupPhoto(f.db, result.id);
    assert.match(result.id, /^[a-f0-9]{64}$/); assert.equal(row.owner, owner); assert.equal(row.ready, true);
    assert.equal(row.bytes, f.store.objects.get(row.key).data.length);
    assert.equal(f.store.objects.get(row.key).options.httpMetadata.cacheControl, 'private, no-store');
    assert.doesNotMatch(JSON.stringify(f.db.sql.prepare('SELECT * FROM turnfeed_photos').all()), /private-token|oaiusercontent|file-one/);
    assert.deepEqual(await stagePhoto(f.args), result); assert.equal(f.fetches, 1); assert.equal(f.store.writes, 1);
    const second = await stagePhoto({ ...f.args, owner: other }); assert.notEqual(second.id, result.id);
    assert.equal(await lookupPhoto(f.db, 'bad'), null);
    await assert.rejects(stagePhoto({ ...f.args, bucket: null }), errorCode('photo_unavailable'));
  } finally { f.db.sql.close(); }
});

test('download requires exact OpenAI HTTPS hosts, refuses redirects, wrong MIME and over-limit streams', async () => {
  const f = fixture();
  try {
    for (const url of ['http://files.oaiusercontent.com/a', 'https://oaiusercontent.com/a', 'https://files.oaiusercontent.com.evil.test/a',
      'https://files.oaiusercontent.com:443/a', 'https://user@files.oaiusercontent.com/a', 'https://127.0.0.1/a',
      'https://files.oaiusercontent.com/a#fragment', 'https:\\files.oaiusercontent.com/a']) {
      await assert.rejects(stagePhoto({ ...f.args, file: { ...source, download_url: url } }), errorCode('photo_source_invalid'));
    }
    assert.equal(f.fetches, 0);
    for (const fetcher of [async () => Response.redirect('https://evil.test', 302),
      async () => new Response(png(), { status:206, headers: { 'content-type':'image/png' } }),
      async () => new Response(png(), { headers: { 'content-type': 'text/html' } }),
      async () => new Response(Buffer.alloc(PHOTO_LIMITS.bytes + 1)),
      async () => new Response(png(), { headers: { 'content-length': String(PHOTO_LIMITS.bytes + 1) } })]) {
      await assert.rejects(stagePhoto({ ...f.args, fetcher }), error => ['photo_invalid', 'photo_download_failed'].includes(error.code));
    }
    await assert.rejects(stagePhoto({ ...f.args, file: { ...source, mime_type: 'image/jpeg' } }), errorCode('photo_invalid'));
    assert.equal(f.db.sql.prepare('SELECT COUNT(*) AS n FROM turnfeed_photos').get().n, 0);
    assert.equal(f.store.writes, 0);
  } finally { f.db.sql.close(); }
});

test('concurrent identical stages make at most one object write', async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled([stagePhoto(f.args), stagePhoto(f.args)]);
    const good = results.filter(r => r.status === 'fulfilled');
    assert.ok(good.length >= 1); assert.equal(f.store.writes, 1);
    assert.equal(f.db.sql.prepare('SELECT COUNT(*) AS n FROM turnfeed_photos').get().n, 1);
    assert.equal(f.db.sql.prepare('SELECT count FROM turnfeed_photo_daily').get().count, 1);
    for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'photo_busy');
  } finally { f.db.sql.close(); }
});

test('ambiguous object write retains quota and forbids unsafe automatic upload or removal', async () => {
  const f = fixture(); f.store.failPut = true;
  try {
    await assert.rejects(stagePhoto(f.args), errorCode('photo_busy'));
    const row = f.db.sql.prepare('SELECT * FROM turnfeed_photos').get();
    assert.equal(row.status, 'uploading'); assert.ok(row.bytes > 0);
    assert.equal((await lookupPhoto(f.db, row.id)).ready, false);
    await assert.rejects(stagePhoto(f.args), errorCode('photo_busy'));
    await assert.rejects(removePhoto(f.db, f.store, row.id, owner), errorCode('photo_busy'));
    assert.equal(f.store.writes, 1); assert.equal(f.store.deletes, 0);
  } finally { f.db.sql.close(); }
});

test('delete validates ownership, retains quota on failure and leaves an idempotent tombstone', async () => {
  const f = fixture();
  try {
    const photo = await stagePhoto(f.args);
    await assert.rejects(removePhoto(f.db, f.store, photo.id, other), errorCode('photo_not_found'));
    assert.equal(f.store.deletes, 0);
    f.store.failDelete = true;
    await assert.rejects(removePhoto(f.db, f.store, photo.id, owner), errorCode('photo_busy'));
    const pending = await lookupPhoto(f.db, photo.id); assert.ok(pending.bytes > 0); assert.equal(pending.ready, false);
    await assert.rejects(stagePhoto(f.args), errorCode('photo_busy'));
    f.store.failDelete = false;
    assert.deepEqual(await removePhoto(f.db, f.store, photo.id, owner), { removed: true });
    const tombstone = await lookupPhoto(f.db, photo.id); assert.equal(tombstone.bytes, 0); assert.equal(tombstone.ready, false);
    assert.equal(f.store.objects.size, 0);
    assert.deepEqual(await removePhoto(f.db, f.store, photo.id, owner), { removed: true });
    await assert.rejects(stagePhoto(f.args), errorCode('photo_retired'));
    assert.equal(f.db.sql.prepare('SELECT count FROM turnfeed_photo_daily').get().count, 1);
  } finally { f.db.sql.close(); }
});

test('daily cap survives deletion and advances only with UTC date', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < PHOTO_LIMITS.daily; i++) {
      const photo = await stagePhoto({ ...f.args, file: { ...source, file_id: 'daily-' + i } });
      await removePhoto(f.db, f.store, photo.id, owner);
    }
    await assert.rejects(stagePhoto({ ...f.args, file: { ...source, file_id: 'daily-overflow' } }), errorCode('photo_quota'));
    assert.ok((await stagePhoto({ ...f.args, now: now + 86_400_000, file: { ...source, file_id: 'tomorrow' } })).id);
  } finally { f.db.sql.close(); }
});

test('global bytes, account bytes and object count include incomplete reservations', async () => {
  const f = fixture();
  try {
    f.db.sql.prepare(`INSERT INTO turnfeed_photos (id,owner,object_key,mime,bytes,digest,status,claim,created_at,day)
      VALUES (?,?,?,?,?,?,'uploading','',?,?)`).run('e'.repeat(64), owner, 'existing', 'image/png', PHOTO_LIMITS.ownerBytes, 'digest', now, '2026-10-08');
    await assert.rejects(stagePhoto(f.args), errorCode('photo_quota'));
    f.db.sql.prepare('UPDATE turnfeed_photos SET owner = ?, bytes = ?').run(other, PHOTO_LIMITS.globalBytes);
    await assert.rejects(stagePhoto(f.args), errorCode('photo_quota'));
    f.db.sql.prepare('UPDATE turnfeed_photos SET bytes = 0').run();
    const insert = f.db.sql.prepare(`INSERT INTO turnfeed_photos (id,owner,object_key,mime,bytes,digest,status,claim,created_at,day)
      VALUES (?,?,?,'image/png',0,'digest','deleted','',?,'2026-09-01')`);
    for (let i = 1; i < PHOTO_LIMITS.rows; i++) insert.run(i.toString(16).padStart(64, '0'), other, 'old-' + i, now);
    await assert.rejects(stagePhoto(f.args), errorCode('photo_quota'));
    assert.equal(f.store.writes, 0);
  } finally { f.db.sql.close(); }
});

test('a lost reservation response retains one charged row and permits a safe later claim', async () => {
  const f = fixture(), prepare = f.db.prepare.bind(f.db); let failReservation = true;
  f.db.prepare = query => {
    const statement = prepare(query);
    if (!query.startsWith('INSERT INTO turnfeed_photos')) return statement;
    const bind = statement.bind;
    statement.bind = (...values) => {
      const bound = bind(...values), run = bound.run;
      bound.run = async () => { const result = await run.call(bound); if (failReservation) { failReservation = false; throw new Error('lost response'); } return result; };
      return bound;
    };
    return statement;
  };
  try {
    await assert.rejects(stagePhoto(f.args), errorCode('photo_unavailable'));
    assert.equal(f.db.sql.prepare('SELECT status FROM turnfeed_photos').get().status, 'reserved');
    assert.equal(f.store.writes, 0);
    const photo = await stagePhoto(f.args);
    assert.equal((await lookupPhoto(f.db, photo.id)).ready, true);
    assert.equal(f.db.sql.prepare('SELECT count FROM turnfeed_photo_daily').get().count, 1);
  } finally { f.db.sql.close(); }
});
