// Browser-only preparation. The server independently validates the uploaded file.
function createPhotoPreparation() {
  function photoDimensions(bytes) {
    const invalid = () => { throw new Error('Choose a valid JPEG or PNG photo.'); };
    let width, height, mime;
    if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) invalid();
      width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) invalid();
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9 || marker === undefined) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > bytes.length) invalid();
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length) invalid();
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          if (length < 8) invalid();
          height = (bytes[offset + 3] << 8) | bytes[offset + 4];
          width = (bytes[offset + 5] << 8) | bytes[offset + 6]; mime = 'image/jpeg';
          break;
        }
        offset += length;
      }
    }
    if (!width || !height || !mime) invalid();
    if (width * height > 32_000_000) throw new Error('Choose a photo with no more than 32 megapixels.');
    return { width, height, mime };
  }

  function fittedPhotoSize(width, height, maxSide) {
    if (![width, height, maxSide].every(value => Number.isFinite(value) && value > 0)) throw new Error('This photo has invalid dimensions.');
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  async function decodedPhoto(file, win) {
    if (typeof win.createImageBitmap === 'function') {
      try {
        const bitmap = await win.createImageBitmap(file, { imageOrientation: 'from-image' });
        return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
      } catch { /* Some browsers need the Image decoder instead. */ }
    }
    if (typeof win.Image !== 'function' || typeof win.URL?.createObjectURL !== 'function') {
      throw new Error('This browser could not open the photo. Try another JPEG or PNG, or another browser.');
    }
    const url = win.URL.createObjectURL(file), image = new win.Image();
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('This photo could not be opened. Choose another JPEG or PNG.'));
        image.src = url;
      });
      return { image, width: image.naturalWidth, height: image.naturalHeight,
        close: () => { win.URL.revokeObjectURL(url); image.src = ''; } };
    } catch (error) { win.URL.revokeObjectURL(url); throw error; }
  }

  function encodedPhoto(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      if (typeof canvas.toBlob !== 'function') return reject(new Error('This browser cannot resize photos. Try another browser.'));
      canvas.toBlob(blob => blob && blob.size > 0 && blob.type === mime ? resolve(blob)
        : reject(new Error('This photo could not be prepared. Choose another JPEG or PNG.')), mime, quality);
    });
  }

  async function preparePhoto(file, kind, win, doc) {
    if (!file || !Number.isFinite(file.size) || file.size < 1 || file.size > 8 * 1024 * 1024) {
      throw new Error('Choose one JPEG or PNG up to 8 MiB.');
    }
    if (file.type && !['image/jpeg', 'image/png'].includes(file.type)) throw new Error('Choose a JPEG or PNG photo.');
    if (typeof file.arrayBuffer !== 'function') throw new Error('This browser cannot prepare this photo. Try another browser.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length !== file.size) throw new Error('This photo could not be read. Choose it again.');
    const header = photoDimensions(bytes);
    if (file.type && file.type !== header.mime) throw new Error('The photo contents do not match its JPEG or PNG format.');
    const decoded = await decodedPhoto(file, win);
    let canvas;
    try {
      const { width, height } = decoded;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 32_000_000) {
        throw new Error('Choose a photo with no more than 32 megapixels.');
      }
      const avatar = kind === 'avatar', maxSide = avatar ? 512 : 2048;
      const targetBytes = avatar ? 200 * 1024 : 1024 * 1024;
      if (Math.max(width, height) <= maxSide && file.size <= targetBytes && file.type === header.mime) {
        return { file, width, height, changed: false };
      }
      if (typeof win.File !== 'function') throw new Error('This browser cannot prepare uploads. Try another browser.');
      canvas = doc.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error('This browser cannot resize photos. Try another browser.');
      let side = Math.min(maxSide, Math.max(width, height)), blob, size;
      for (let attempt = 0; attempt < 6; attempt++) {
        size = fittedPhotoSize(width, height, side);
        canvas.width = size.width; canvas.height = size.height;
        context.drawImage(decoded.image, 0, 0, size.width, size.height);
        blob = await encodedPhoto(canvas, header.mime, attempt === 1 ? 0.72 : 0.86);
        if (blob.size <= targetBytes) break;
        if (header.mime === 'image/jpeg' && attempt === 0) continue;
        side = Math.max(1, Math.floor(side * Math.max(0.5, Math.min(0.85, Math.sqrt(targetBytes / blob.size) * 0.9))));
      }
      if (!blob || blob.size > 1024 * 1024) throw new Error('This photo could not fit the upload limit. Choose a smaller photo.');
      const stem = String(file.name || 'photo').replace(/\.[^.]*$/, '').slice(0, 100) || 'photo';
      const output = new win.File([blob], `${stem}.${header.mime === 'image/png' ? 'png' : 'jpg'}`, { type: header.mime });
      return { file: output, ...size, changed: true };
    } finally {
      decoded.close();
      if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
  }
  return { photoDimensions, fittedPhotoSize, preparePhoto };
}

export const { photoDimensions, fittedPhotoSize, preparePhoto } = createPhotoPreparation();

// Serialize one closed factory so minification keeps helper references together.
export const photoPreparationScript = `const {preparePhoto}=(${createPhotoPreparation.toString()})();`;
