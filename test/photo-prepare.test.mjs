import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { photoDimensions, fittedPhotoSize, preparePhoto } from '../worker/photo-prepare.mjs';
import { composerScript } from '../worker/composer.mjs';

function source(width, height, { mime = 'image/png', size = 100 } = {}) {
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  if (mime === 'image/png') {
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    view.setUint32(8, 13); view.setUint32(12, 0x49484452);
    view.setUint32(16, width); view.setUint32(20, height);
  } else {
    bytes.set([255, 216, 255, 192, 0, 8, 8, height >> 8, height & 255, width >> 8, width & 255, 3]);
  }
  return new File([bytes], mime === 'image/png' ? 'photo.png' : 'photo.jpg', { type: mime });
}

function browser({ encodedSize = (width, height, mime) => Math.ceil(width * height * (mime === 'image/png' ? 3 : 0.2)), decodeError = false } = {}) {
  const calls = { decode: 0, closed: 0, draws: [], encodes: [], alpha: [] };
  const win = { File, async createImageBitmap(file) {
    calls.decode++;
    if (decodeError) throw new Error('Cannot decode');
    return { ...photoDimensions(new Uint8Array(await file.arrayBuffer())), close() { calls.closed++; } };
  } };
  const doc = { createElement(tag) {
    assert.equal(tag, 'canvas');
    const canvas = { width: 0, height: 0,
      getContext(type, options) {
        assert.equal(type, '2d'); calls.alpha.push(options.alpha);
        return { drawImage(image, x, y, width, height) { calls.draws.push({ x, y, width, height }); } };
      },
      toBlob(callback, mime, quality) {
        calls.encodes.push({ width: canvas.width, height: canvas.height, mime, quality });
        const size = encodedSize(canvas.width, canvas.height, mime, quality);
        callback(size === null ? null : new Blob([new Uint8Array(size)], { type: mime }));
      },
    };
    return canvas;
  } };
  return { win, doc, calls };
}

test('photo dimensions and fitting preserve orientation, aspect ratio and smaller originals', async () => {
  for (const mime of ['image/png', 'image/jpeg']) {
    assert.deepEqual(photoDimensions(new Uint8Array(await source(4000, 3000, { mime }).arrayBuffer())), { width: 4000, height: 3000, mime });
  }
  assert.deepEqual(fittedPhotoSize(4000, 3000, 2048), { width: 2048, height: 1536 });
  assert.deepEqual(fittedPhotoSize(3000, 4000, 512), { width: 384, height: 512 });
  assert.deepEqual(fittedPhotoSize(320, 200, 512), { width: 320, height: 200 });
  assert.deepEqual(fittedPhotoSize(32000000, 1, 512), { width: 512, height: 1 });
  assert.throws(() => fittedPhotoSize(0, 100, 512));
});

test('file size and header pixel limits reject before browser decode or canvas allocation', async () => {
  const b = browser();
  await assert.rejects(preparePhoto({ size: 8 * 1024 * 1024 + 1 }, 'post', b.win, b.doc), /8 MiB/);
  await assert.rejects(preparePhoto(source(8000, 4001), 'post', b.win, b.doc), /32 megapixels/);
  await assert.rejects(preparePhoto(source(0, 100), 'post', b.win, b.doc), /valid JPEG or PNG/);
  await assert.rejects(preparePhoto(new File(['not a photo'], 'photo.png', { type: 'image/png' }), 'post', b.win, b.doc), /valid JPEG or PNG/);
  assert.equal(b.calls.decode, 0); assert.equal(b.calls.draws.length, 0);
  assert.equal(photoDimensions(new Uint8Array(await source(8000, 4000).arrayBuffer())).width, 8000);
});

test('a suitable small post photo stays byte-for-byte unchanged after successful decoding', async () => {
  const b = browser(), file = source(800, 600);
  const result = await preparePhoto(file, 'post', b.win, b.doc);
  assert.equal(result.file, file); assert.equal(result.changed, false);
  assert.equal(b.calls.decode, 1); assert.equal(b.calls.closed, 1); assert.equal(b.calls.encodes.length, 0);
});

test('large JPEG posts shrink within 2048 pixels and one MiB without upscaling', async () => {
  const b = browser();
  const result = await preparePhoto(source(4000, 3000, { mime: 'image/jpeg', size: 2 * 1024 * 1024 }), 'post', b.win, b.doc);
  assert.deepEqual({ width: result.width, height: result.height }, { width: 2048, height: 1536 });
  assert.equal(result.file.type, 'image/jpeg'); assert.equal(result.changed, true);
  assert.ok(result.file.size <= 1024 * 1024); assert.equal(b.calls.closed, 1);
  assert.deepEqual(b.calls.draws[0], { x: 0, y: 0, width: 2048, height: 1536 });
  const smaller = await preparePhoto(source(800, 600, { mime: 'image/jpeg', size: 2 * 1024 * 1024 }), 'post', b.win, b.doc);
  assert.equal(smaller.width, 800); assert.equal(smaller.height, 600);
});

test('avatar preparation keeps PNG transparency and fits its 512 pixel and 200 KiB target', async () => {
  const b = browser();
  const result = await preparePhoto(source(4000, 3000, { size: 2 * 1024 * 1024 }), 'avatar', b.win, b.doc);
  assert.equal(result.file.type, 'image/png'); assert.ok(result.file.name.endsWith('.png'));
  assert.ok(result.width <= 512);
  assert.ok(Math.abs(result.height - result.width * 3 / 4) <= 0.5, 'aspect ratio differs only by whole-pixel rounding');
  assert.ok(result.file.size <= 200 * 1024);
  assert.deepEqual(b.calls.alpha, [true]);
  assert.ok(b.calls.encodes.every(call => call.mime === 'image/png'));
  assert.ok(b.calls.encodes.length <= 6); assert.equal(b.calls.closed, 1);
});

test('decode and encoding failures reject instead of returning an original oversized upload', async () => {
  const broken = browser({ decodeError: true });
  await assert.rejects(preparePhoto(source(200, 100), 'post', broken.win, broken.doc), /could not open/);
  assert.equal(broken.calls.draws.length, 0);
  const cannotEncode = browser({ encodedSize: () => null });
  await assert.rejects(preparePhoto(source(4000, 3000), 'post', cannotEncode.win, cannotEncode.doc), /could not be prepared/);
  assert.equal(cannotEncode.calls.closed, 1);
  const tooLarge = browser({ encodedSize: () => 1_048_577 });
  await assert.rejects(preparePhoto(source(4000, 3000), 'post', tooLarge.win, tooLarge.doc), /upload limit/);
  assert.equal(tooLarge.calls.encodes.length, 6); assert.equal(tooLarge.calls.closed, 1);
});

test('the served composer script includes its preparation helpers without browser imports', () => {
  assert.doesNotMatch(composerScript, /^import |^export /m);
  const context = { window: {}, document: { querySelectorAll: () => [], querySelector: () => null } };
  assert.equal(typeof vm.runInNewContext(composerScript + '\npreparePhoto', context), 'function');
});

// Opt in after the normal Worker build; ordinary source tests must not depend
// on a stale or absent local dist directory.
test('the minified Worker serves a composer whose preparation helpers execute in a browser context',
  { skip: process.env.TURNFEED_TEST_BUILT_ASSETS !== '1' }, async () => {
    const { default: builtWorker } = await import('../dist/server/index.js');
    const response = await builtWorker.fetch(new Request('https://turnfeed.example/assets/composer.js'), {});
    assert.equal(response.status, 200);
    const script = await response.text();
    const context = { window: {}, document: { querySelectorAll: () => [], querySelector: () => null } };
    const prepare = vm.runInNewContext(script + '\npreparePhoto', context);
    const b = browser(), file = source(4000, 3000, { mime: 'image/jpeg', size: 2 * 1024 * 1024 });
    const result = await prepare(file, 'post', b.win, b.doc);
    assert.equal(result.width, 2048); assert.equal(result.height, 1536);
    assert.equal(result.file.type, 'image/jpeg'); assert.ok(result.file.size <= 1024 * 1024);
    assert.equal(b.calls.closed, 1);
  });
