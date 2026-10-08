import { createHmac } from 'node:crypto';
import { accountKey, chatGPTDisplayName, operatorIdentity } from './identity.mjs';
import { readState, commitState, StorageError } from './storage.mjs';
import { lookupPhoto, removePhoto } from './photos.mjs';
import { createModerator } from './moderation.mjs';
import { reserveModerationAttempt } from './moderation-limit.mjs';

export const photoPath = (id, mime) => `/photos/${id}.${mime === 'image/png' ? 'png' : 'jpg'}`;
export function photoId(url, origin) {
  try {
    const u = new URL(url);
    return u.origin === origin && !u.search && !u.hash ? /^\/photos\/([a-f0-9]{64})\.(?:png|jpg)$/.exec(u.pathname)?.[1] || '' : '';
  } catch { return ''; }
}
export function postPhotoIds(post, origin) {
  return (post?.media || []).map(m => photoId(m.url, origin)).filter(Boolean);
}
export const profilePhotoId = (profile, origin) => photoId(profile?.avatarUrl, origin);
export async function removePostPhotos(db, bucket, post, origin, retained = {}) {
  if (!bucket) return;
  for (const id of postPhotoIds(post, origin)) if (!retained[id]) await removePhoto(db, bucket, id, post.authorId);
}

// Called after account revocation commits. Ambiguous/in-flight uploads remain
// charged and unavailable until a later operator cleanup can establish outcome.
export async function eraseAccountPhotos(db, bucket, owner, retained = {}) {
  if (!bucket) return { removed: 0, pending: 0 };
  const result = await db.prepare("SELECT id FROM turnfeed_photos WHERE owner = ? AND status != 'deleted'").bind(owner).all();
  let removed = 0, pending = 0;
  for (const row of result.results || []) {
    if (retained[row.id]) continue;
    try { await removePhoto(db, bucket, row.id, owner); removed++; }
    catch { pending++; }
  }
  return { removed, pending };
}

export async function retireUnpublishedPhoto(db,bucket,id,owner,origin) {
  for (let attempt=0; attempt<3; attempt++) {
    const loaded=await readState(db);
    if (loaded.value?.operator?.photoEvidence?.[id]
        || (loaded.value?.snapshot?.posts || []).some(post=>postPhotoIds(post,origin).includes(id))
        || Object.values(loaded.value?.snapshot?.profiles || {}).some(profile=>profilePhotoId(profile,origin)===id)) return;
    if (!loaded.value) {
      // No snapshot exists yet. Guard retirement against the same empty head
      // observed above; a concurrent first publication must also require ready.
      const result=await db.prepare(`UPDATE turnfeed_photos SET status = 'deleting'
        WHERE id = ? AND owner = ? AND status = 'ready'
        AND EXISTS (SELECT 1 FROM turnfeed_state_head WHERE id = 1 AND revision = ?
          AND storage_format = 1 AND chunks = 0 AND bytes = 0)`)
        .bind(id,owner,loaded.revision).run();
      if (result?.success !== true || ![0,1].includes(result.meta?.changes)) throw new StorageError('storage_outcome_unknown');
      if (result.meta.changes === 1) { await removePhoto(db,bucket,id,owner); return; }
      continue;
    }
    if (await commitState(db,loaded.revision,loaded.value,undefined,loaded,{id,owner,retire:true})) {
      await removePhoto(db,bucket,id,owner); return;
    }
  }
}

// Objects are never public R2 URLs. Each fetch requires a current visible post
// or public profile reference, or operator access to retained evidence.
export async function servePhoto(request, env, invoke) {
  const url = new URL(request.url);
  const id = photoId(url.href, url.origin);
  const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; sandbox" };
  const missing = () => new Response(null, { status: 404, headers });
  if (!id || !env.BUCKET || !['GET','HEAD'].includes(request.method)) return missing();
  const secret = env.TURNFEED_SITE_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return missing();
  const subject = request.headers.get('oai-authenticated-user-id')?.trim() || '';
  if (subject.length > 512) return missing();
  const loaded = await readState(env.DB);
  const viewer=accountKey(subject,secret);
  if (loaded.value?.operator?.revoked?.[viewer]) return missing();
  const operator = Boolean(operatorIdentity(request,env));
  const post = loaded.value?.snapshot?.posts?.find(p => postPhotoIds(p,url.origin).includes(id));
  const evidence = operator && loaded.value?.operator?.photoEvidence?.[id];
  const avatar = Object.entries(loaded.value?.snapshot?.profiles || {}).find(([,profile])=>profilePhotoId(profile,url.origin)===id);
  let owner=post?.authorId || evidence?.owner;
  if (!post && !evidence) {
    if (!avatar) return missing();
    const [profileOwner,profile]=avatar;
    // Unknown legacy visibility stays denied. Account privacy also applies to
    // direct avatar URLs, independently of profile-page rendering.
    if ((profile.visibility && profile.visibility!=='public') || loaded.value?.operator?.revoked?.[profileOwner]) return missing();
    const blocks=loaded.value?.snapshot?.blocks || {};
    const blocked=(from,to)=>Array.isArray(blocks[from]) && blocks[from].includes(to);
    if (!operator && viewer && viewer!==profileOwner && (blocked(viewer,profileOwner) || blocked(profileOwner,viewer))) return missing();
    const following=loaded.value?.snapshot?.follows?.[viewer];
    if (!operator && profile.privateAccount === true && viewer !== profileOwner
        && !(viewer && Array.isArray(following) && following.includes(profileOwner))) return missing();
    owner=profileOwner;
  }
  if (post && !operator) {
    const output = await invoke({db:env.DB, origin:url.origin, secret, subject,
    displayName: subject ? chatGPTDisplayName(request.headers) : '', name:'get_thread_context', args:{postId:post.id},
    callerKey:createHmac('sha256',secret).update(subject || 'photo-reader').digest('hex'), moderate:createModerator(env.OPENAI_API_KEY, {
      beforeRequest: () => reserveModerationAttempt({ db:env.DB, actor:accountKey(subject,secret) }),
    })});
    const thread = output.result?.structuredContent?.thread;
    if (!thread || !postPhotoIds(thread,url.origin).includes(id)) return missing();
  }
  const photo = await lookupPhoto(env.DB,id);
  if (!photo?.ready || photo.owner !== owner || photoPath(id,photo.mime) !== url.pathname) return missing();
  const object = await env.BUCKET.get(photo.key);
  if (!object) return missing();
  return new Response(request.method === 'HEAD' ? null : object.body, {headers:{...headers,
    'content-type':photo.mime,'content-length':String(photo.bytes),'content-disposition':'inline'}});
}
