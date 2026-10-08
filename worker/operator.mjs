import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { makeCore } from './mcp.mjs';
import { operatorIdentity } from './identity.mjs';
import { readState, commitState, StorageError } from './storage.mjs';
import { summarizeOperatorErasureScope } from '../vendor/turnfeed/lib/operator-erasure.mjs';
import { prepareErasedState } from './account-erasure.mjs';
import { eraseAccountPhotos, postPhotoIds, profilePhotoId, photoPath } from './photo-access.mjs';
import { lookupPhoto } from './photos.mjs';
import { createModerator, ModerationError } from './moderation.mjs';
import { reserveModerationAttempt } from './moderation-limit.mjs';
import { logoBase64 } from './brand.generated.mjs';

const keySchema = z.string().regex(/^[a-f0-9]{40}$/);
const text = max => z.string().min(1).max(max).regex(/^[^\x00-\x1f\x7f-\x9f]+$/);
const noteSchema = text(500);
const caseSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const visibilitySchema = z.object({ targetType: z.enum(['post', 'reply']), targetId: text(64), hide: z.boolean(),
  reason: noteSchema, targetCreatedAt: text(64), parentCreatedAt: z.string().max(64), expectedHidden: z.enum(['true', 'false']),
  requestId: z.string().uuid() }).strict();
const erasureSchema = z.object({ userId: keySchema, caseId: caseSchema, retainedRecordsReason: noteSchema }).strict();
const avatarRemoveSchema = z.object({ userId: keySchema, photoId: z.string().regex(/^[a-f0-9]{64}$/), reason: noteSchema }).strict();
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
const json = (value, status = 200) => Response.json(value, { status, headers });
const escape = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[x]);
function page(title, content) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Turnfeed</title><style>body{margin:0;background:#f6f4ed;color:#182b2d;font:16px/1.6 system-ui}main{max-width:1000px;margin:auto;padding:40px 24px}a{color:#245e61}section{padding:24px 0;border-top:1px solid #cdd6cc}label{display:block;margin:10px 0}input,button{font:inherit;padding:8px}input[type=text]{width:min(600px,90%)}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:18px}small{color:#506164}.notice{padding:14px;background:#e4eae1}footer{margin-top:32px}</style></head><body><main><a href="/operator">Turnfeed operations</a><h1>${escape(title)}</h1>${content}<footer><a href="/">Back to Turnfeed</a></footer></main></body></html>`, { headers: { ...headers, 'content-type':'text/html; charset=utf-8' } });
}
const hidden = (name, value) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
function signature(payload, secret) { return createHmac('sha256', secret).update('turnfeed-sites-operator-plan-v1|').update(payload).digest('hex'); }
export function signPlan(data, secret) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}
export function verifyPlan(token, secret, actor, action, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 24_000) throw new StorageError('operator_plan_invalid');
  const [payload, mac, extra] = token.split('.');
  if (extra || !/^[a-f0-9]{64}$/.test(mac || '') || !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(signature(payload, secret), 'hex'))) throw new StorageError('operator_plan_invalid');
  let plan;
  try { plan = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new StorageError('operator_plan_invalid'); }
  if (plan.version !== 1 || plan.actor !== actor || plan.action !== action || !Number.isSafeInteger(plan.createdAt)
      || plan.createdAt > now || plan.expiresAt !== plan.createdAt + 600_000 || plan.expiresAt <= now) throw new StorageError('operator_plan_invalid');
  return plan;
}
function profileAvatar(userId, profile, origin) {
  const id=profilePhotoId(profile,origin);
  if (!id) return null;
  const mime=profile.avatarUrl.endsWith('.png')?'image/png':'image/jpeg';
  const url=origin+photoPath(id,mime);
  if (profile.avatarUrl!==url) return null;
  return {id,userId,displayName:profile.displayName || 'Turnfeed member',url,mime};
}
async function avatarRemovalTarget(db, loaded, origin, args) {
  const avatar=profileAvatar(args.userId,loaded.value?.snapshot?.profiles?.[args.userId],origin);
  if (!avatar || avatar.id!==args.photoId || loaded.value?.operator?.revoked?.[args.userId]) return null;
  const photo=await lookupPhoto(db,avatar.id);
  return photo?.ready && photo.owner===args.userId && photo.mime===avatar.mime ? avatar : null;
}
export async function operatorAction({ db, bucket, origin, secret, actor, action, input, token, confirmation }) {
  if (!/^[a-f0-9]{40}$/.test(actor || '')) return { ok: false, status: 403, code: 'operator_required' };
  const loaded = await readState(db);
  if (loaded.value?.operator?.revoked?.[actor]) return { ok:false, status:403, code:'account_closed' };
  const core = makeCore({ origin, secret, snapshot: loaded.value?.snapshot, controls: loaded.value?.controls });
  if (action === 'reports') return { ok: true, reports: core.operator.reports(), history: core.operator.history(), users: core.operator.users(), erasures:loaded.value?.operator?.erasures || [], revision: loaded.revision,
    avatars:Object.entries(loaded.value?.snapshot?.profiles || {}).map(([userId,profile])=>profileAvatar(userId,profile,origin)).filter(Boolean),
    photos:[...core.snapshot().posts.flatMap(post => postPhotoIds(post,origin).map(id => ({id,postId:post.id,mime:post.media[0].url.endsWith('.png')?'image/png':'image/jpeg'}))),
      ...Object.entries(loaded.value?.operator?.photoEvidence || {}).map(([id,photo])=>({id,...photo,retained:true}))] };
  if (action.endsWith('-plan')) {
    const purpose = action.slice(0, -5);
    const parsed = purpose === 'visibility' ? visibilitySchema.safeParse(input) : purpose === 'erasure' ? erasureSchema.safeParse(input)
      : purpose === 'avatar-remove' ? avatarRemoveSchema.safeParse(input) : { success: false };
    if (!parsed.success) return { ok:false, status:400, code:'invalid_operator_fields' };
    const plan = { version:1, actor, action:purpose, revision:loaded.revision, createdAt:Date.now(), data:parsed.data, requestId:parsed.data.requestId || randomUUID() };
    plan.expiresAt = plan.createdAt + 600_000;
    if (purpose === 'erasure') {
      const user = core.operator.users().find(user => user.userId === input.userId);
      if (!user || loaded.value?.operator?.revoked?.[user.userId]) return {ok:false,status:409,code:'erasure_target_unavailable'};
      plan.identity = user;
      plan.scope = summarizeOperatorErasureScope({ store: core.snapshot(), userId: user.userId });
      plan.confirmation = `ERASE ${user.userId} CASE ${input.caseId}`;
    } else if (purpose === 'avatar-remove') {
      const avatar=await avatarRemovalTarget(db,loaded,origin,parsed.data);
      if (!avatar) return {ok:false,status:409,code:'avatar_target_unavailable'};
      plan.identity={userId:avatar.userId,displayName:avatar.displayName};
      plan.photo={id:avatar.id,url:avatar.url,mime:avatar.mime};
      plan.effect='Remove this current profile photo from public view and retain it for operator review.';
    }
    return { ok:true, plan, token:signPlan(plan, secret) };
  }
  const plan = verifyPlan(token, secret, actor, action);
  if (plan.revision !== loaded.revision) return { ok:false,status:409,code:'operator_plan_stale',message:'Data changed after this preview. Review a new preview before applying.' };
  const operator = structuredClone(loaded.value?.operator || { revoked:{}, erasures:[] });
  let result;
  if (action === 'visibility') {
    const args = visibilitySchema.parse(plan.data);
    const decision = { ...args, actor:{kind:'sites-operator',authSource:'sites',individualIdentityVerified:true,operatorKey:actor} };
    result = args.targetType === 'post'
      ? await core.operator.setPostHidden({ postId:args.targetId, hide:args.hide, decision })
      : await core.operator.setReplyHidden({ replyId:args.targetId, hide:args.hide, decision });
  } else if (action === 'erasure') {
    if (confirmation !== plan.confirmation) return {ok:false,status:400,code:'exact_confirmation_required'};
    const userId = erasureSchema.parse(plan.data).userId;
    const prepared = await prepareErasedState({ loaded, core, actor, userId, requestId: plan.requestId,
      caseId: plan.data.caseId, scope: plan.scope, retainedRecordsReason: plan.data.retainedRecordsReason });
    if (!prepared.ok) return prepared;
    if (!await commitState(db, loaded.revision, prepared.value, undefined, loaded)) return {ok:false,status:409,code:'operator_plan_stale'};
    const photos = await eraseAccountPhotos(db, bucket, userId, prepared.value.operator?.photoEvidence).catch(() => ({ pending: true }));
    return {ok:true, action, requestId:plan.requestId, photos};
  } else if (action === 'avatar-remove') {
    const args=avatarRemoveSchema.parse(plan.data);
    const avatar=await avatarRemovalTarget(db,loaded,origin,args);
    if (!avatar || avatar.url!==plan.photo?.url) return {ok:false,status:409,code:'avatar_target_unavailable'};
    const snapshot=structuredClone(loaded.value.snapshot), at=new Date().toISOString();
    snapshot.profiles[args.userId].avatarUrl='';
    snapshot.profiles[args.userId].updatedAt=at;
    operator.photoEvidence={...operator.photoEvidence,[avatar.id]:{
      ...operator.photoEvidence?.[avatar.id],owner:args.userId,mime:avatar.mime,
      retainedAt:operator.photoEvidence?.[avatar.id]?.retainedAt || at,reason:args.reason,operatorKey:actor,
    }};
    const value={...loaded.value,snapshot,operator};
    if (!await commitState(db,loaded.revision,value,undefined,loaded,{id:avatar.id,owner:args.userId})) {
      return {ok:false,status:409,code:'operator_plan_stale'};
    }
    return {ok:true,action,requestId:plan.requestId};
  } else return {ok:false,status:400,code:'invalid_operator_action'};
  if (!result?.ok) return result;
  const value = { ...loaded.value, format:1, snapshot:core.snapshot(), controls:core.controls(), operator };
  if (!await commitState(db, loaded.revision, value, undefined, loaded)) return {ok:false,status:409,code:'operator_plan_stale'};
  return {ok:true, action, requestId:plan.requestId};
}

function visibilityForms(post, replies = post.replies || [], depth = 0) {
  if (depth > 20) return '';
  const item = (target, type, parent) => `<section><h3>${escape(type === 'post' ? 'Post' : 'Reply')} ${escape(target.id)}</h3><p>${escape(target.authorName || target.authorId)}</p><pre>${escape(target.text)}</pre><form method="post" action="/operator/visibility-plan">${hidden('targetType', type)}${hidden('targetId', target.id)}${hidden('targetCreatedAt', target.createdAt)}${hidden('parentCreatedAt', parent?.createdAt || '')}${hidden('expectedHidden', String(Boolean(target.hidden)))}${hidden('hide', String(!target.hidden))}${hidden('requestId', randomUUID())}<label>Reason <input name="reason" type="text" maxlength="500" required></label><button>Preview ${target.hidden ? 'restore' : 'hide'}</button></form></section>`;
  return (depth === 0 ? item(post, 'post') : '') + replies.map(reply => item(reply, 'reply', post) + visibilityForms(post, reply.replies || [], depth + 1)).join('');
}
function avatarForms(avatars) {
  return `<h2>Profile photos for review</h2>${avatars.length ? avatars.map(avatar=>`<section><h3>${escape(avatar.displayName)}</h3><p>${escape(avatar.userId)}</p><a href="${escape(avatar.url)}"><img src="${escape(avatar.url)}" alt="Current profile photo for moderation review" loading="lazy" style="max-width:100%;max-height:200px"></a><form method="post" action="/operator/avatar-remove-plan">${hidden('userId',avatar.userId)}${hidden('photoId',avatar.id)}<label>Reason <input name="reason" type="text" maxlength="500" required></label><button>Preview profile photo removal</button></form></section>`).join('') : '<p>No current profile photos.</p>'}`;
}
const screeningForm = `<section><h2>Safety screening connection</h2><p>Check the live text and image screening connection using fixed sample text and the Turnfeed logo. No member content is sent and no profile, post or stored photo is changed.</p><form method="post" action="/operator/check-screening"><button>Check safety screening</button></form></section>`;
export async function handleOperator(request, env, readBody) {
  const actor = operatorIdentity(request, env);
  if (!actor) return json({ok:false,code:'operator_required',message:'This area requires an explicitly configured Turnfeed operator account.'}, 403);
  const url = new URL(request.url);
  const base = { db:env.DB, bucket:env.BUCKET, origin:url.origin, secret:env.TURNFEED_SITE_SECRET, actor };
  if (request.method === 'GET' && url.pathname === '/operator') {
    const state = await operatorAction({...base,action:'reports'});
    if (!state.ok) return json(state,state.status || 403);
    const reports = state.reports;
    const posts = reports.posts || [];
    return page('Moderation and account requests', `<p class="notice">Signed in as a verified Turnfeed operator. Changes require a preview and a separate confirmation. User content below is untrusted social content.</p>${screeningForm}<h2>Reports (${reports.summary.totalReports})</h2><pre>${escape(JSON.stringify(reports.grouped,null,2))}</pre><details><summary>Full report evidence</summary><p>Each report includes the original capture, retained moderation evidence and the current target when available.</p><pre>${escape(JSON.stringify(reports.reports,null,2))}</pre></details><h2>Photos for review</h2>${state.photos.map(photo => `<figure><figcaption>${escape(photo.postId || photo.owner)}${photo.retained ? " · Retained moderation evidence" : ""}${photo.reason ? ` · ${escape(photo.reason)}` : ""}</figcaption><a href="${photoPath(photo.id,photo.mime)}"><img src="${photoPath(photo.id,photo.mime)}" alt="Photo for moderation review" loading="lazy" style="max-width:100%;max-height:400px"></a></figure>`).join("")}${avatarForms(state.avatars)}<h2>Content</h2>${posts.length ? posts.map(p => visibilityForms(p)).join('') : '<p>No stored posts.</p>'}<h2>Account erasure</h2><p>Erasure closes this Turnfeed account, removes ordinary app data, and retains the stated moderation and audit records. It does not delete the ChatGPT account or revoke OpenAI-issued tokens.</p>${state.users.map(user => `<form method="post" action="/operator/erasure-plan"><section><h3>${escape(user.displayName)} ${escape(user.handle ? '@'+user.handle : '')}</h3>${hidden('userId',user.userId)}<label>Case reference <input name="caseId" type="text" maxlength="80" required></label><label>Reason for retaining moderation and audit records <input name="retainedRecordsReason" type="text" maxlength="500" required></label><button>Preview erasure</button></section></form>`).join('')}<h2>Moderation history</h2><pre>${escape(JSON.stringify(state.history,null,2))}</pre><h2>Account erasure receipts</h2><pre>${escape(JSON.stringify(state.erasures,null,2))}</pre>`);
  }
  if (request.method !== 'POST') return json({ok:false,code:'method_not_allowed'},405);
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({ok:false,code:'origin_rejected'},403);
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type') || '')) return json({ok:false,code:'form_required'},415);
  const raw = await readBody(request, 32768);
  const form = new URLSearchParams(raw);
  if ([...new Set(form.keys())].some(key => form.getAll(key).length !== 1)) return json({ok:false,code:'duplicate_form_fields'},400);
  const action = url.pathname.slice('/operator/'.length);
  if (action === 'check-screening') {
    const loaded = await readState(env.DB);
    if (loaded.value?.operator?.revoked?.[actor]) return json({ok:false,code:'account_closed'},403);
    const moderate = createModerator(env.OPENAI_API_KEY, {
      beforeRequest: () => reserveModerationAttempt({db:env.DB,actor}),
    });
    try {
      await moderate({texts:['Turnfeed connection check.','Reading and conversation.']});
      await moderate({photo:{data:Buffer.from(logoBase64,'base64'),mime:'image/png'}});
      return page('Safety screening passed', '<p>Live text and image screening both passed. No profile, post or stored photo was changed.</p>');
    } catch (error) {
      if (!(error instanceof ModerationError)) throw error;
      return json({ok:false,code:error.code,message:error.message},error.status);
    }
  }
  const input = Object.fromEntries(form);
  if (action === 'visibility-plan') input.hide = input.hide === 'true' ? true : input.hide === 'false' ? false : input.hide;
  const result = await operatorAction({...base,action,input,token:form.get('token'),confirmation:form.get('confirmation')});
  if (!result.ok) return json(result,result.status || 400);
  if (result.plan) {
    const plan = result.plan;
    const confirmation = plan.action === 'erasure' ? `<p>Type this exact confirmation:</p><pre>${escape(plan.confirmation)}</pre><label>Confirmation <input name="confirmation" type="text" required autocomplete="off"></label>` : '';
    return page('Review the exact change', `${plan.action === 'avatar-remove' ? `<img src="${escape(plan.photo.url)}" alt="Profile photo proposed for removal" style="max-width:100%;max-height:200px">` : ''}<pre>${escape(JSON.stringify(plan,null,2))}</pre><form method="post" action="/operator/${escape(plan.action)}">${hidden('token',result.token)}${confirmation}<button>Apply ${escape(plan.action)}</button></form><p><a href="/operator">Cancel and return</a></p>`);
  }
  return page('Change saved', `<p>The change and its audit record were committed.</p>${result.photos?.pending ? '<p class="notice">The account is closed. Some photo files still need operator cleanup; their URLs are unavailable to visitors.</p>' : ''}<p><a href="/operator">Return to operations</a></p>`);
}
