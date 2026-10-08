import { createHash, createHmac, randomUUID } from 'node:crypto';

export const PHOTO_LIMITS = Object.freeze({ bytes: 1_048_576, dimension: 4096,
  pixels: 16_000_000, globalBytes: 100 * 1_048_576, ownerBytes: 20 * 1_048_576,
  daily: 10, rows: 1024, timeoutMs: 10_000 });
const messages = {
  photo_unavailable: 'Photo storage is unavailable.',
  photo_invalid: 'Use a valid JPEG or PNG photo up to 1 MiB, 4096 pixels per side and 16 megapixels.',
  photo_source_invalid: 'Choose a photo attached to this chat.',
  photo_download_failed: 'The photo could not be downloaded. Attach it again and retry.',
  photo_quota: 'The photo storage or upload limit has been reached.',
  photo_busy: 'This photo upload has not been confirmed. It cannot be published yet.',
  photo_retired: 'This photo was removed. Start a new post with a new photo attachment.',
  photo_not_found: 'The photo was not found.',
};
export class PhotoError extends Error {
  constructor(code, status = 400) { super(messages[code] || messages.photo_unavailable); this.code = code; this.status = status; }
}
const fail = (code = 'photo_invalid', status = 400) => { throw new PhotoError(code, status); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const validOwner = owner => typeof owner === 'string' && /^[a-f0-9]{40}$/.test(owner);
const publicPhoto = row => ({ id: row.id, mime: row.mime, bytes: row.bytes });
function dimensions(width, height) {
  if (!width || !height || width > PHOTO_LIMITS.dimension || height > PHOTO_LIMITS.dimension
      || width * height > PHOTO_LIMITS.pixels) fail();
}
function join(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0), result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  let offset = 8, header = false, palette = 0, transparency = false, data = false, endedData = false, color;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), end = offset + 12 + length;
    if (end > bytes.length) fail();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()
        || crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) fail();
    const body = bytes.subarray(offset + 8, end - 4);
    if (!header && type !== 'IHDR') fail();
    if (type === 'IHDR') {
      if (header || length !== 13) fail();
      dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
      const depth = body[8]; color = body[9];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || body[10] !== 0 || body[11] !== 0 || body[12] > 1) fail();
      header = true;
    } else if (type === 'PLTE') {
      if (data || palette || [0, 4].includes(color) || !length || length % 3 || length > 768) fail();
      palette = length / 3;
    } else if (type === 'tRNS') {
      if (data || transparency || (color === 0 ? length !== 2 : color === 2 ? length !== 6
        : color === 3 ? !palette || !length || length > palette : true)) fail();
      transparency = true;
    } else if (type === 'IDAT') {
      if (endedData || (color === 3 && !palette)) fail();
      data = true; compressed.push(body);
    } else if (type === 'IEND') {
      if (!data || length || end !== bytes.length) fail();
      const stream = join(compressed);
      if (stream.length < 6 || (stream[0] & 15) !== 8 || (stream[0] >> 4) > 7
          || ((stream[0] << 8) + stream[1]) % 31 || (stream[1] & 32)) fail();
      parts.push(bytes.subarray(offset, end));
      return join(parts);
    } else if (type[0] === type[0].toUpperCase()) fail();
    if (data && type !== 'IDAT') endedData = true;
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT'].includes(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  fail();
}
function jpeg(bytes) {
  const parts = [bytes.subarray(0, 2)];
  let offset = 2, frame = false, scan = false, quantization = false, huffman = false;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) fail();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scan || !quantization || !huffman || offset !== bytes.length) fail();
      parts.push(bytes.subarray(start, offset));
      return join(parts);
    }
    if (offset + 2 > bytes.length || marker === undefined) fail();
    const length = (bytes[offset] << 8) | bytes[offset + 1], end = offset + length;
    if (length < 2 || end > bytes.length) fail();
    const body = bytes.subarray(offset + 2, end);
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || body.length < 9 || body[0] !== 8 || ![1, 3].includes(body[5]) || length !== 8 + 3 * body[5]) fail();
      dimensions((body[3] << 8) | body[4], (body[1] << 8) | body[2]);
      frame = true;
    } else if (marker === 0xdb) {
      let p = 0;
      while (p < body.length) {
        const table = body[p++];
        if ((table & 15) > 3 || (table >> 4) > 1) fail();
        p += (table >> 4) ? 128 : 64;
      }
      if (!body.length || p !== body.length) fail();
      quantization = true;
    } else if (marker === 0xc4) {
      let p = 0;
      while (p < body.length) {
        const table = body[p++];
        if ((table & 15) > 3 || (table >> 4) > 1 || p + 16 > body.length) fail();
        const symbols = body.subarray(p, p + 16).reduce((sum, n) => sum + n, 0);
        if (!symbols || symbols > 256) fail();
        p += 16 + symbols;
      }
      if (!body.length || p !== body.length) fail();
      huffman = true;
    } else if (marker === 0xdd) { if (length !== 4) fail(); }
    else if (marker === 0xda) {
      if (!frame || !body.length || ![1, 2, 3].includes(body[0]) || length !== 6 + 2 * body[0]) fail();
      let cursor = end;
      while (cursor < bytes.length) {
        if (bytes[cursor] !== 0xff) { cursor++; continue; }
        let next = cursor + 1;
        while (bytes[next] === 0xff) next++;
        if (next >= bytes.length) fail();
        if (bytes[next] === 0x00 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7)) { cursor = next + 1; continue; }
        break;
      }
      if (cursor === end || cursor >= bytes.length) fail();
      parts.push(bytes.subarray(start, cursor));
      offset = cursor; scan = true; continue;
    } else if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) fail();
    // Drop all APP segments and comments, including EXIF, ICC, XMP and thumbnails.
    if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) parts.push(bytes.subarray(start, end));
    offset = end;
  }
  fail();
}
export function sanitizePhoto(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length || bytes.length > PHOTO_LIMITS.bytes) fail();
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return { data: png(bytes), mime: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { data: jpeg(bytes), mime: 'image/jpeg' };
  fail();
}
function downloadUrl(file) {
  if (!file || typeof file.file_id !== 'string' || !file.file_id.trim() || file.file_id.length > 1024
      || typeof file.download_url !== 'string' || file.download_url.length > 16_384) fail('photo_source_invalid');
  const authority = /^https:\/\/([^/?#]+)/i.exec(file.download_url)?.[1];
  let url;
  try { url = new URL(file.download_url); } catch { fail('photo_source_invalid'); }
  if (!authority || /[@:\\]/.test(authority) || url.protocol !== 'https:' || url.username || url.password || url.port
      || !url.hostname.endsWith('.oaiusercontent.com') || url.hash) fail('photo_source_invalid');
  return url.href;
}
async function download(file, fetcher) {
  const url = downloadUrl(file), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PHOTO_LIMITS.timeoutMs);
  let reader;
  try {
    // Workers supports manual redirects; reject them without following below.
    const response = await fetcher(url, { redirect: 'manual', signal: controller.signal });
    if (response.status !== 200 || response.redirected || !response.body || (response.url && response.url !== url)) fail('photo_download_failed');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > PHOTO_LIMITS.bytes) fail();
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PHOTO_LIMITS.bytes) fail();
      chunks.push(value);
    }
    const result = sanitizePhoto(join(chunks));
    const declared = String(file.mime_type || '').toLowerCase();
    const served = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if ((declared && declared !== result.mime) || (served && served !== 'application/octet-stream' && served !== result.mime)) fail();
    return result;
  } catch (error) { if (error instanceof PhotoError) throw error; fail('photo_download_failed'); }
  finally { clearTimeout(timer); if (reader) await reader.cancel().catch(() => {}); }
}
async function rowFor(db, id) {
  try {
    const response = await db.prepare('SELECT * FROM turnfeed_photos WHERE id = ?').bind(id).all();
    if (response?.success !== true || !Array.isArray(response.results)) fail('photo_unavailable', 503);
    return response.results[0] || null;
  } catch (error) { if (error instanceof PhotoError) throw error; fail('photo_unavailable', 503); }
}
async function run(db, query, values) {
  try {
    const result = await db.prepare(query).bind(...values).run();
    if (result?.success !== true || !Number.isSafeInteger(result.meta?.changes)) fail('photo_unavailable', 503);
    return result.meta.changes;
  } catch { fail('photo_unavailable', 503); }
}
export async function lookupPhoto(db, id) {
  if (!validId(id)) return null;
  const row = await rowFor(db, id);
  return row ? { id: row.id, owner: row.owner, key: row.object_key, mime: row.mime, bytes: row.bytes,
    ready: row.status === 'ready' } : null;
}
export async function stagePhoto({ db, bucket, owner, secret, file, now = Date.now(), fetcher = fetch, screen }) {
  downloadUrl(file);
  return stageValidatedPhoto({db,bucket,owner,secret,fileId:file.file_id,now,screen,load:()=>download(file,fetcher)});
}

// Website bytes come only from the bounded same-origin multipart form. They
// never become a fetch URL, and receive the same validation and quotas as chat.
export async function stageWebPhoto({db,bucket,owner,secret,bytes,mime,clientId,now=Date.now(),screen}) {
  const photo=sanitizePhoto(bytes);
  if (mime !== photo.mime || typeof clientId !== 'string' || !clientId || clientId.length>1024) fail();
  const fileId=createHmac('sha256',secret).update('web|'+clientId+'|'+hash(photo.data)).digest('hex');
  return stageValidatedPhoto({db,bucket,owner,secret,fileId,now,screen,load:async()=>photo});
}

async function stageValidatedPhoto({db,bucket,owner,secret,fileId,now,load,screen}) {
  if (!db || !bucket?.put || !validOwner(owner) || typeof secret !== 'string' || secret.length < 32) fail('photo_unavailable', 503);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) fail('photo_invalid');
  const id = createHmac('sha256', secret).update('turnfeed-photo-v1\0').update(owner).update('\0').update(fileId).digest('hex');
  let row = await rowFor(db, id);
  if (row?.owner !== undefined && row.owner !== owner) fail('photo_not_found', 404);
  if (row?.status === 'ready') return {...publicPhoto(row), ...(screen ? {needsScreening:true} : {})};
  if (row && row.status !== 'reserved') fail(row.status === 'deleted' ? 'photo_retired' : 'photo_busy', 409);
  const photo = await load(), digest = hash(photo.data), day = new Date(now).toISOString().slice(0, 10);
  if (screen) await screen(photo);
  const key = `photos/${id}.${photo.mime === 'image/png' ? 'png' : 'jpg'}`;
  if (!row) {
    await run(db, `INSERT INTO turnfeed_photos (id,owner,object_key,mime,bytes,digest,status,claim,created_at,day)
      SELECT ?,?,?,?,?,?,'reserved','',?,? WHERE
      (SELECT COUNT(*) FROM turnfeed_photos) < ? AND
      (SELECT COALESCE(SUM(bytes),0) FROM turnfeed_photos) + ? <= ? AND
      (SELECT COALESCE(SUM(bytes),0) FROM turnfeed_photos WHERE owner = ?) + ? <= ? AND
      COALESCE((SELECT count FROM turnfeed_photo_daily WHERE owner = ? AND day = ?),0) < ?
      ON CONFLICT(id) DO NOTHING`, [id, owner, key, photo.mime, photo.data.length, digest, now, day,
      PHOTO_LIMITS.rows, photo.data.length, PHOTO_LIMITS.globalBytes, owner, photo.data.length,
      PHOTO_LIMITS.ownerBytes, owner, day, PHOTO_LIMITS.daily]);
    row = await rowFor(db, id);
    if (!row) fail('photo_quota', 429);
  }
  if (row.owner !== owner || row.digest !== digest || row.bytes !== photo.data.length || row.mime !== photo.mime) fail('photo_invalid');
  if (row.status === 'ready') return publicPhoto(row);
  const claim = randomUUID();
  const claimed = await run(db, "UPDATE turnfeed_photos SET status = 'uploading', claim = ? WHERE id = ? AND owner = ? AND status = 'reserved'", [claim, id, owner]);
  if (claimed !== 1) fail('photo_busy', 409);
  // An uncertain put or commit retains the reservation and cannot race another upload.
  try {
    const stored = await bucket.put(key, photo.data, { httpMetadata: { contentType: photo.mime,
      cacheControl: 'private, no-store' }, customMetadata: { digest } });
    if (!stored || stored.key !== key) fail('photo_busy', 503);
  } catch { fail('photo_busy', 503); }
  const completed = await run(db, "UPDATE turnfeed_photos SET status = 'ready' WHERE id = ? AND owner = ? AND status = 'uploading' AND claim = ?", [id, owner, claim]);
  if (completed !== 1) fail('photo_busy', 503);
  // Historical rate counters do not affect current quotas; deletion cannot reset today's limit.
  const cutoff = new Date(Math.max(0, now - 30 * 86_400_000)).toISOString().slice(0, 10);
  try { await run(db, 'DELETE FROM turnfeed_photo_daily WHERE day < ?', [cutoff]); } catch {}
  return { id, mime: photo.mime, bytes: photo.data.length };
}
// Called only when a ready/staged object is newly entering public state. An
// existing publication receipt remains readable during a moderation outage.
export async function screenStoredPhoto(db,bucket,id,owner,screen) {
  const row=await rowFor(db,id);
  if (!row || row.owner!==owner || row.status!=='ready') fail('photo_busy',409);
  const stored=await bucket.get(row.object_key);
  if (!stored?.body) fail('photo_unavailable',503);
  const reader=new Response(stored.body).body.getReader(), parts=[]; let length=0;
  try {
    for (;;) {
      const {value,done}=await reader.read(); if(done) break;
      length+=value.length; if(length>PHOTO_LIMITS.bytes) fail(); parts.push(value);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  const data=join(parts);
  if(hash(data)!==row.digest || data.length!==row.bytes) fail('photo_invalid');
  await screen({data,mime:row.mime});
}

export async function removePhoto(db, bucket, id, owner) {
  if (!db || !bucket?.delete || !validOwner(owner) || !validId(id)) fail('photo_not_found', 404);
  const row = await rowFor(db, id);
  if (!row || row.owner !== owner) fail('photo_not_found', 404);
  if (row.status === 'deleted') return { removed: true };
  if (!['ready', 'deleting'].includes(row.status)) fail('photo_busy', 409);
  if (row.status === 'ready') {
    await run(db, "UPDATE turnfeed_photos SET status = 'deleting' WHERE id = ? AND owner = ? AND status = 'ready'", [id, owner]);
  }
  try { await bucket.delete(row.object_key); } catch { fail('photo_busy', 503); }
  // The tombstone prevents replay from recreating deleted bytes. Quotas derive from rows.
  await run(db, "UPDATE turnfeed_photos SET status = 'deleted', bytes = 0, claim = '' WHERE id = ? AND owner = ? AND status = 'deleting'", [id, owner]);
  return { removed: true };
}
