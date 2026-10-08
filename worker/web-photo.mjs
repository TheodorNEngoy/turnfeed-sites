import { PHOTO_LIMITS, PhotoError } from './photos.mjs';

// Limit the raw request before the platform's multipart parser allocates parts.
// A Content-Length header is only an early rejection, never the size authority.
export async function readPhotoForm(request) {
  const limit=PHOTO_LIMITS.bytes+32_768;
  if (Number(request.headers.get('content-length'))>limit) throw new PhotoError('photo_invalid',413);
  const reader=request.body?.getReader();
  if (!reader) throw new PhotoError('photo_invalid');
  const chunks=[]; let length=0;
  try {
    for (;;) {
      const {value,done}=await reader.read(); if (done) break;
      length+=value.byteLength;
      if (length>limit) throw new PhotoError('photo_invalid',413);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  const bytes=new Uint8Array(length); let offset=0;
  for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
  try {return await new Response(bytes,{headers:{'content-type':request.headers.get('content-type')}}).formData();}
  catch {throw new PhotoError('photo_invalid');}
}

export async function webPhotoInput(file) {
  // Multipart runtimes represent an unselected file as either an empty string
  // or an unnamed, empty File. Neither is a photo upload.
  if (file===null || file==='' || (typeof file==='object' && file.size===0 && file.name==='')) return undefined;
  if (!file || typeof file==='string' || typeof file.arrayBuffer!=='function'
      || !['image/jpeg','image/png'].includes(file.type) || !file.size || file.size>PHOTO_LIMITS.bytes) throw new PhotoError('photo_invalid');
  return {bytes:new Uint8Array(await file.arrayBuffer()),mime:file.type};
}
