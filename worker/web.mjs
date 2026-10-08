import { createHmac, timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { dispatchMcp } from './mcp.mjs';
import { accountKey } from './identity.mjs';
import { StorageError } from './storage.mjs';
import { renderWeb } from './web-view.mjs';
import { activityPayload } from './activity.mjs';
import { readPhotoForm, webPhotoInput } from './web-photo.mjs';
import { PhotoError } from './photos.mjs';

const LIFETIME = 30 * 60_000;
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
class WebError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const html = (props, status = 200) => new Response(renderWeb(props), { status, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
const redirect = path => new Response(null, { status: 303, headers: { ...headers, location: path } });
const mac = (payload, secret) => createHmac('sha256', secret).update('turnfeed-web-form-v1|').update(payload).digest('hex');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const threadPath = id => `/post/${encodeURIComponent(id)}`;
const reportReasons = [
  ['spam', 'Spam or scam'], ['harassment', 'Harassment or threat'], ['hate', 'Hate or abuse'],
  ['misinformation', 'Misinformation'], ['self-harm', 'Self-harm risk'], ['illegal-content', 'Illegal or exploitative content'],
  ['impersonation', 'Impersonation'], ['privacy', 'Privacy or personal-data exposure'], ['child-safety', 'Child safety'],
  ['intellectual-property', 'Copyright or IP'], ['other', 'Something else'],
].map(([value, label]) => ({ value, label }));
const pagePath = (path, values) => {
  const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value));
  return path + (params.size ? `?${params}` : '');
};
const contentIdentity = item => ({ text: item.text, author: item.authorTargetRef,
  name: item.authorName, handle: item.authorPublicHandle, createdAt: item.createdAt });
const replySelector = item => fingerprint(contentIdentity(item));
const controlsPath = (id, reply, cursor) => pagePath(`${threadPath(id)}/actions`, { reply, cursor });
const personIdentity = item => ({ targetRef: item.targetRef, targetLabel: item.displayName, publicHandle: item.publicHandle });
const handleValue = value => String(value || '').replace(/^@/, '');
function profilePath(item, signedIn) {
  if (signedIn && (item.viewerIsSelf || item.viewerIsAuthor)) return '/profile';
  const handle=handleValue(item.publicHandle || item.authorPublicHandle || item.actorPublicHandle);
  if (/^[a-z0-9_]{1,20}$/i.test(handle)) return pagePath('/person',{handle});
  const ref=item.targetRef || item.authorTargetRef || item.actorTargetRef;
  return signedIn && /^tfr_[A-Za-z0-9_-]{24}$/.test(ref || '') ? pagePath('/person',{ref}) : '';
}
const likeIdentity = item => ({...contentIdentity(item),text:String(item.text || '').replace(/\s+/g,' ').trim(),
  handle:handleValue(item.authorPublicHandle)});
function socialItem(item, actor, secret, {postId='',cursor='',parent,returnTo='/',allowLike=false}={}) {
  const next={...item,webProfileUrl:profilePath(item,Boolean(actor))};
  if (item.quote) next.quote=socialItem(item.quote,actor,secret);
  if (item.recentReplies) next.recentReplies=item.recentReplies.map(reply=>socialItem(reply,actor,secret));
  // A truncated preview cannot bind the exact whole message. Its conversation
  // page provides the like control after displaying the complete text.
  if (allowLike && !item.previewTruncated && Number.isFinite(item.likes)) {
    const liked=item.viewerHasLiked===true, desired=liked?'unlike':'like';
    const target={postId,reply:parent?replySelector(item):'',cursor,
      content:fingerprint(likeIdentity(item)),parent:parent?fingerprint(likeIdentity(parent)):'',desired,returnTo};
    next.webLike={token:actor && typeof item.viewerHasLiked==='boolean'
      ? formToken(actor,parent?'like-reply':'like-post',secret,target) : '',action:desired,count:item.likes,liked};
  }
  return next;
}
function socialItems(data, actor, secret, returnTo) {
  data.items=(data.items || []).map(item=>socialItem(item,actor,secret,{postId:item.postId,returnTo,allowLike:true}));
  return data;
}
function followControl(profile, actor, secret, returnTo, following=profile.viewerFollows) {
  if (!actor || profile.viewerIsSelf || profile.viewerHasBlocked || !profile.targetRef || typeof following!=='boolean') return undefined;
  const requested=profile.viewerHasRequested===true, privateAccount=profile.privateAccount===true;
  const action=following || requested?'unfollow':'follow';
  return {token:formToken(actor,'follow',secret,{person:personIdentity(profile),desired:action,returnTo}),action,following,requested,privateAccount};
}
async function publicProfile(request, env, {handle,ref}) {
  const data=await call(request,env,'open_turnfeed_feed',{targetKind:'profile',
    ...(handle?{profileHandle:handle}:{}),...(ref?{targetRef:ref}:{})});
  if (!data.profile) throw new WebError('This profile is unavailable or no longer visible to you.',404);
  return data;
}

// This is a browser CSRF token, not evidence of an in-chat approval. Sites
// identity and the browser's same-origin form submission establish this action.
function formToken(actor, action, secret, target = null) {
  const payload = Buffer.from(JSON.stringify({ actor, action, target, clientId: randomUUID(), expires: Date.now() + LIFETIME })).toString('base64url');
  return `${payload}.${mac(payload, secret)}`;
}
function readToken(token, actor, action, secret) {
  // Nested targets carry both public message bodies. Allow full-length Unicode
  // handoffs while keeping form input bounded.
  if (typeof token !== 'string' || token.length > 16_384) throw new WebError('This form is unavailable. Open a fresh page and try again.', 403);
  const [payload, signature, extra] = token.split('.');
  if (extra || !/^[a-f0-9]{64}$/.test(signature || '') || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(mac(payload, secret), 'hex'))) {
    throw new WebError('This form is unavailable. Open a fresh page and try again.', 403);
  }
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new WebError('Open a fresh form and try again.', 403); }
  if (value.actor !== actor || value.action !== action || !Number.isSafeInteger(value.expires)
      || value.expires <= Date.now() || value.expires > Date.now() + LIFETIME || typeof value.clientId !== 'string') {
    throw new WebError('This form has expired or belongs to another session. Copy your text, then open a fresh page.', 403);
  }
  return value;
}
async function call(request, env, name, args, includeActivityEvents = false, webPhoto, webAvatar) {
  const result = await dispatchMcp(request, env, { method: 'tools/call', params: { name, arguments: args } }, { includeActivityEvents, webPhoto, webAvatar });
  const data = result.result?.structuredContent;
  if (result.error || result.result?.isError || !data || data.ok === false) {
    const message = result.error?.message || data?.message || data?.error;
    const status = [result.status, data?.status].find(value => Number.isInteger(value) && value >= 400 && value <= 599);
    throw new WebError(typeof message === 'string' ? message.slice(0, 1500) : 'Turnfeed could not complete this action. Check the feed before trying again.', Number.isInteger(status) && status >= 400 && status <= 599 ? status : 422);
  }
  if (result.activityEvents) {
    const actor = accountKey(request.headers.get('oai-authenticated-user-id').trim(), env.TURNFEED_SITE_SECRET);
    data.webActivityBaseline = activityPayload(actor, env.TURNFEED_SITE_SECRET, result.activityEvents);
  }
  return data;
}
async function profilePage(request, env, actor, extra = {}, status = 200) {
  const data = await call(request, env, 'open_turnfeed_feed', { targetKind: 'profile', profileScope: 'self' });
  socialItems(data, actor, env.TURNFEED_SITE_SECRET, '/profile');
  data.avatarToken = formToken(actor, 'avatar', env.TURNFEED_SITE_SECRET, { avatarUrl: data.profile.avatarUrl || '' });
  if (extra.profileDraft) data.profileDraft = extra.profileDraft;
  if (extra.profileErrorField) data.profileErrorField = extra.profileErrorField;
  return html({ kind: 'profile', signedIn: true, data, returnPath: '/profile',
    formToken: formToken(actor, 'profile', env.TURNFEED_SITE_SECRET),
    error: extra.error || '', statusMessage: extra.statusMessage || '' }, status);
}
function query(url, key, max = 4096) {
  const values = url.searchParams.getAll(key);
  if (values.length > 1 || (values[0]?.length || 0) > max) throw new WebError('This page link is invalid. Return to the feed.');
  return values[0] || undefined;
}
function targetFor(data) {
  return { postId: data.postId, content: fingerprint({ text: data.thread?.text, author: data.thread?.authorPublicHandle,
    createdAt: data.thread?.createdAt, replyTarget: data.replyHandoff?.targetArguments }) };
}
async function thread(request, env, id, cursor) {
  const data = await call(request, env, 'get_thread_context', { postId: id, limit: 6, ...(cursor ? { cursor } : {}) });
  if (!data.thread) throw new WebError('This conversation is unavailable or no longer visible to you.', 404);
  return data;
}
async function controlTarget(request, env, postId, reply, cursor) {
  const data = await thread(request, env, postId, cursor);
  const matches = reply ? (data.recentReplies || []).filter(item => replySelector(item) === reply) : [data.thread];
  if (matches.length !== 1) throw new WebError('This reply changed or is no longer on this page. Open the conversation again.', 409);
  const item = matches[0];
  return { postId: data.postId, item, parentText: data.thread.text, parentItem:data.thread, isReply: Boolean(reply),
    viewerOwnsTarget: item.viewerIsAuthor === true,
    target: { postId: data.postId, reply: reply || '', cursor: cursor || '',
      content: fingerprint({ item: contentIdentity(item), parent: contentIdentity(data.thread) }) } };
}
function readableTarget(data) {
  const { item, isReply } = data;
  return { targetLabel: `${isReply ? 'Reply' : 'Post'} by ${item.authorName}`.slice(0, 240),
    ...(isReply ? { replyText: item.text, parentPostText: data.parentText,
      ...(item.authorPublicHandle ? { replyAuthorHandle: item.authorPublicHandle } : {}) }
      : { postId: data.postId, postText: item.text,
        ...(item.authorPublicHandle ? { authorHandle: item.authorPublicHandle } : {}) }),
    ...(item.createdAt ? { createdAt: item.createdAt } : {}) };
}
async function peoplePage(request, env, kind, cursor) {
  if (kind === 'muted') {
    const result = await call(request, env, 'get_my_settings', { mutedLimit: 10, ...(cursor ? { cursor } : {}) });
    return { items: result.settings.muted, count: result.settings.mutedCount, hasMore: result.settings.hasMore, nextCursor: result.settings.nextCursor };
  }
  const result = await call(request, env, 'open_turnfeed_inbox', { relationshipKind: kind === 'following' ? 'following' : 'blocked', limit: 10, ...(cursor ? { cursor } : {}) });
  if (result.cursorResetRequired) throw new WebError('Your people list changed. Open the list again.', 409);
  return { items: result.relationships || [], count: result.relationshipCount, hasMore: result.hasMore, nextCursor: result.nextCursor };
}
export function isWebRoute(path) {
  return ['/', '/profile', '/person', '/following', '/activity', '/preferences', '/privacy-settings'].includes(path) || /^\/post\/[^/]+(?:\/(?:delete|actions))?$/.test(path)
    || /^\/web\/(post|reply|nested-reply|profile|avatar|avatar-remove|delete|report|block|mute|delete-reply|unblock|unmute|like-post|like-reply|follow|person-block|person-mute|privacy|follower)$/.test(path);
}
export function webFailure(error, signedIn = false, draft = '', returnPath = '/') {
  let message = 'Turnfeed is temporarily unavailable. Your action may have completed. Check the feed before trying again.';
  let status = 503;
  if (error instanceof WebError) { message = error.message; status = error.status; }
  else if (error instanceof PhotoError) { message=error.message+' Your photo was not published. Return to the feed and choose the photo again.'; status=error.status; }
  else if (error instanceof StorageError) {
    if (error.code === 'storage_outcome_unknown') message = 'The connection was interrupted while saving. Your action may have completed. Check the feed before trying again; do not publish a second copy.';
    else if (error.code === 'candidate_capacity_reached') message = 'This Turnfeed preview has reached its storage limit. Your change was not saved. Contact support.';
    else if (error.code === 'request_too_large') { message = 'This form is too large. Posts and replies can contain up to 600 characters.'; status = 413; }
  }
  return html({ kind: 'error', signedIn, error: message, draft, returnPath }, status);
}
export async function handleWeb(request, env, readBody) {
  const url = new URL(request.url);
  const subject = request.headers.get('oai-authenticated-user-id')?.trim() || '';
  const signedIn = Boolean(subject && subject.length <= 512);
  let draft = '';
  let recoveryPath = '/';
  try {
    if (typeof env.TURNFEED_SITE_SECRET !== 'string' || env.TURNFEED_SITE_SECRET.length < 32) throw new WebError('Turnfeed is temporarily unavailable.', 503);
    if (subject.length > 512) throw new WebError('Sign in again with ChatGPT.', 403);
    const actor = signedIn ? accountKey(subject, env.TURNFEED_SITE_SECRET) : '';
    if (request.method === 'GET' && !url.pathname.startsWith('/web/')) {
      const returnPath = url.pathname + url.search;
      if (url.pathname === '/') {
        const focus = query(url, 'focus', 20) || 'active';
        if (!['latest', 'active'].includes(focus)) throw new WebError('Choose the Latest or Active feed.');
        const cursor = query(url, 'cursor');
        const data = await call(request, env, 'get_feed_digest', { focus, limit: 4, ...(cursor ? { cursor } : {}) });
        socialItems(data,actor,env.TURNFEED_SITE_SECRET,pagePath('/',{focus,cursor}));
        data.webFeedViewer=mac('feed-viewer|'+actor,env.TURNFEED_SITE_SECRET);
        const notice = query(url, 'done', 20);
        const statusMessage = notice === 'deleted' ? 'Your post and its replies were deleted.' : notice === 'posted' ? 'Your post was published.' : '';
        return html({ kind: 'feed', signedIn, data, focus, statusMessage, returnPath,
          formToken: signedIn ? formToken(actor, 'post', env.TURNFEED_SITE_SECRET) : '' });
      }
      if (url.pathname === '/profile') {
        if (!signedIn) return redirect('/signin-with-chatgpt?return_to=%2Fprofile');
        return await profilePage(request, env, actor, { statusMessage: query(url, 'done', 20) === 'saved' ? 'Your profile was saved.' : '' });
      }
      if (url.pathname === '/privacy-settings') {
        if (!signedIn) return redirect(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnPath)}`);
        const cursor=query(url,'cursor');
        const data=await call(request,env,'get_my_privacy',{limit:50,...(cursor?{cursor}:{})});
        data.privacyToken=formToken(actor,'privacy',env.TURNFEED_SITE_SECRET,{privateAccount:data.privateAccount});
        const members=(items,actions)=>(items || []).map(person=>({...person,webProfileUrl:profilePath(person,true),
          actions:actions.map(action=>({action,token:formToken(actor,'follower',env.TURNFEED_SITE_SECRET,
            {person:personIdentity(person),action,...(person.requestId?{requestId:person.requestId}:{})})}))}));
        data.requests=members(data.requests,['accept','reject']);
        data.followers=members(data.followers,['remove']);
        data.nextUrl=data.hasMore?pagePath('/privacy-settings',{cursor:data.nextCursor}):'';
        const done=query(url,'done',20);
        return html({kind:'privacy-settings',signedIn,data,returnPath,
          statusMessage:done==='saved'?'Your account privacy was saved.':done==='accept'?'Follow request approved.':done==='reject'?'Follow request declined.':done==='remove'?'Follower removed.':''});
      }
      if (url.pathname === '/person') {
        const handle=handleValue(query(url,'handle',21)),ref=query(url,'ref',28);
        if ((!handle && !ref) || (handle && ref) || (handle && !/^[a-z0-9_]{1,20}$/i.test(handle))
          || (ref && !/^tfr_[A-Za-z0-9_-]{24}$/.test(ref))) throw new WebError('This profile link is invalid.');
        if (ref && !signedIn) return redirect(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnPath)}`);
        const data=await publicProfile(request,env,{handle,ref});
        if (data.profile.viewerIsSelf) return redirect('/profile');
        const destination=profilePath(data.profile,signedIn) || pagePath('/person',{handle,ref});
        data.profile.webProfileUrl=destination;
        data.profile.webFollow=followControl(data.profile,actor,env.TURNFEED_SITE_SECRET,destination);
        if (actor && !data.profile.viewerHasBlocked && data.profile.targetRef) {
          data.profile.webPeopleActions=['mute','block'].map(action=>({action,token:formToken(actor,'person-'+action,env.TURNFEED_SITE_SECRET,{person:personIdentity(data.profile)})}));
        }
        socialItems(data,actor,env.TURNFEED_SITE_SECRET,destination);
        return html({kind:'public-profile',signedIn,data,returnPath:destination,
          statusMessage:query(url,'done',20)==='followed'?(data.profile.viewerHasRequested?'Your follow request is pending.':'You are now following this person.'):query(url,'done',20)==='unfollowed'?'You are no longer following or requesting to follow this person.':''});
      }
      if (url.pathname === '/following') {
        if (!signedIn) return redirect(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnPath)}`);
        const cursor=query(url,'cursor'),page=await peoplePage(request,env,'following',cursor);
        const destination=pagePath('/following',{cursor});
        const items=page.items.map(item=>({displayName:item.displayName,publicHandle:item.publicHandle,
          webProfileUrl:profilePath(item,true),webFollow:followControl(item,actor,env.TURNFEED_SITE_SECRET,destination,true)}));
        return html({kind:'following',signedIn,returnPath:destination,data:{items,count:page.count,
          nextUrl:page.hasMore?pagePath('/following',{cursor:page.nextCursor}):''},
          statusMessage:query(url,'done',20)==='unfollowed'?'You unfollowed this person.':''});
      }
      if (url.pathname === '/activity') {
        if (!signedIn) return redirect(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnPath)}`);
        const requestedFilter = query(url, 'filter', 20) || 'all';
        if (!['all', 'replies', 'mentions'].includes(requestedFilter)) throw new WebError('Choose All or Replies and mentions.');
        // The native inbox combines replies and mentions in one filter.
        const filter = requestedFilter === 'mentions' ? 'replies' : requestedFilter;
        const cursor = query(url, 'cursor');
        const data = await call(request, env, 'open_turnfeed_inbox', { notificationsFilter: filter, notificationOrder: 'latest', limit: 10, ...(cursor ? { cursor } : {}) }, filter === 'all' && !cursor);
        data.notifications = (data.notifications || []).map(item => ({ ...item, webThreadUrl: item.postId ? threadPath(item.postId) : '',webProfileUrl:profilePath(item,signedIn) }));
        data.nextUrl = data.hasMore && data.nextCursor ? pagePath('/activity', { filter, cursor: data.nextCursor }) : '';
        const done = query(url, 'done', 20);
        return html({ kind: 'activity', signedIn, data, filter, returnPath,
          activityBaseline: data.webActivityBaseline,
          statusMessage: done === 'blocked' ? 'This person is blocked.' : done === 'muted' ? 'This person is muted in your default feed and activity.' : '' });
      }
      if (url.pathname === '/preferences') {
        if (!signedIn) return redirect(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnPath)}`);
        const blockedCursor = query(url, 'blockedCursor'), mutedCursor = query(url, 'mutedCursor', 100);
        const blocked = await peoplePage(request, env, 'blocked', blockedCursor);
        const muted = await peoplePage(request, env, 'muted', mutedCursor);
        const members = (page, action, cursor) => page.items.map(item => ({ displayName: item.displayName, publicHandle: item.publicHandle,webProfileUrl:profilePath(item,true),
          token: formToken(actor, action, env.TURNFEED_SITE_SECRET, { person: personIdentity(item), cursor: cursor || '' }) }));
        const done = query(url, 'done', 20);
        return html({ kind: 'preferences', signedIn, returnPath, data: {
          blocked: members(blocked, 'unblock', blockedCursor), muted: members(muted, 'unmute', mutedCursor),
          blockedCount: blocked.count, mutedCount: muted.count,
          blockedNextUrl: blocked.hasMore ? pagePath('/preferences', { blockedCursor: blocked.nextCursor, mutedCursor }) : '',
          mutedNextUrl: muted.hasMore ? pagePath('/preferences', { blockedCursor, mutedCursor: muted.nextCursor }) : '',
        }, statusMessage: done === 'unblocked' ? 'This person is unblocked. Previous follows and activity were not restored.' : done === 'unmuted' ? 'This person is unmuted.' : done === 'blocked' ? 'This person is blocked.' : done === 'muted' ? 'This person is muted in your feed and Activity.' : '' });
      }
      const match = /^\/post\/([^/]+)(\/(?:delete|actions))?$/.exec(url.pathname);
      let id;
      try { id = decodeURIComponent(match?.[1] || ''); } catch { throw new WebError('This conversation link is invalid.'); }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new WebError('This conversation link is invalid.');
      const cursor = query(url, 'cursor');
      if (match[2] === '/actions') {
        if (!signedIn) return redirect(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnPath)}`);
        const reply = query(url, 'reply', 64);
        if (reply && !/^[a-f0-9]{64}$/.test(reply)) throw new WebError('This reply link is invalid.');
        const data = await controlTarget(request, env, id, reply, cursor);
        const actions = [];
        const add = (action, label, description) => actions.push({ action, label, description,
          token: formToken(actor, action, env.TURNFEED_SITE_SECRET, data.target) });
        if (data.viewerOwnsTarget && data.isReply) add('delete-reply', 'Delete reply', 'Delete this reply and any replies to it. This cannot be undone.');
        if (!data.viewerOwnsTarget) {
          add('report', `Report ${data.isReply ? 'reply' : 'post'}`, 'Send your chosen reason for moderation review. Reports are retained independently of content deletion and cannot be withdrawn here.');
          if (data.item.authorTargetRef) {
            add('mute', `Mute ${data.item.authorName}`, 'Hide this person from your default feed and activity. Following and access stay unchanged. You can unmute them in My profile → Muted and blocked.');
            add('block', `Block ${data.item.authorName}`, 'Hide this person and prevent interaction. Blocking removes follows, past notifications, private-group invitations and shared private-group memberships. Unblocking does not restore them.');
          }
        }
        const { target: _target, parentItem:_parentItem, ...display } = data;
        display.item=socialItem(display.item,actor,env.TURNFEED_SITE_SECRET);
        return html({ kind: 'controls', signedIn, returnPath, data: { ...display, actions, reportReasons } });
      }
      const data = await thread(request, env, id, cursor);
      const deleting = match[2] === '/delete';
      if (deleting && (!signedIn || !data.viewerOwnsTarget)) throw new WebError('Only the author can delete this post.', 403);
      data.webActionsUrl = data.viewerOwnsTarget ? '' : controlsPath(data.postId, '', cursor);
      data.thread.webActionsUrl = data.webActionsUrl;
      data.recentReplies = (data.recentReplies || []).map(reply => ({ ...reply, webActionsUrl: controlsPath(data.postId, replySelector(reply), cursor) }));
      const destination=pagePath(threadPath(data.postId),{cursor});
      data.thread=socialItem(data.thread,actor,env.TURNFEED_SITE_SECRET,{postId:data.postId,returnTo:destination,allowLike:!deleting});
      data.recentReplies=data.recentReplies.map(reply=>socialItem(reply,actor,env.TURNFEED_SITE_SECRET,
        {postId:data.postId,cursor,parent:data.thread,returnTo:destination+'#replies',allowLike:!deleting}));
      if (signedIn && !deleting && !data.thread.archived) {
        data.recentReplies = (data.recentReplies || []).map(reply => ({ ...reply,
          ...(reply.replyHandoff?.publishTool === 'publish_public_reply_to_reply' ? {
            webReplyToken: formToken(actor, 'nested-reply', env.TURNFEED_SITE_SECRET,
              { postId: data.postId, arguments: reply.replyHandoff.targetArguments }),
          } : {}),
        }));
      }
      return html({ kind: deleting ? 'delete' : 'thread', signedIn, data, returnPath,
        statusMessage: query(url, 'done', 20) === 'replied' ? 'Your reply was published.' : query(url, 'done', 20) === 'posted' ? 'Your post was published.' : query(url, 'done', 20) === 'reported' ? 'Your report was sent for moderation review.' : query(url, 'done', 20) === 'reply-deleted' ? 'Your reply and its replies were deleted.' : '',
        formToken: signedIn ? formToken(actor, deleting ? 'delete' : 'reply', env.TURNFEED_SITE_SECRET, targetFor(data)) : '' });
    }
    if (request.method !== 'POST' || !url.pathname.startsWith('/web/')) throw new WebError('This page does not support that action.', 405);
    if (!signedIn) throw new WebError('Sign in with ChatGPT before publishing or changing your profile.', 401);
    if (request.headers.get('origin') !== url.origin || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))) {
      throw new WebError('Submit this form from Turnfeed itself.', 403);
    }
    const action = url.pathname.slice('/web/'.length);
    if (['profile', 'avatar', 'avatar-remove'].includes(action)) recoveryPath = '/profile';
    if (['privacy','follower'].includes(action)) recoveryPath='/privacy-settings';
    const contentType=request.headers.get('content-type') || '';
    const multipart=['post','avatar'].includes(action) && /^multipart\/form-data(?:;|$)/i.test(contentType);
    if (!multipart && !/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType)) throw new WebError('Use the Turnfeed form to submit this action.', 415);
    const form = multipart ? await readPhotoForm(request) : new URLSearchParams(await readBody(request, 32_768));
    const allowed = action === 'privacy' ? ['token','privateAccount'] : action === 'follower' ? ['token'] : action === 'avatar' ? ['token','photo'] : action === 'avatar-remove' ? ['token'] : action === 'profile' ? ['token', 'displayName', 'handle', 'bio'] : action === 'report' ? ['token', 'reason']
      : ['delete', 'block', 'mute', 'delete-reply', 'unblock', 'unmute', 'like-post', 'like-reply', 'follow', 'person-block', 'person-mute'].includes(action) ? ['token'] : action==='post' && multipart ? ['token','text','photo'] : ['token', 'text'];
    for (const key of form.keys()) if (!allowed.includes(key) || form.getAll(key).length !== 1) throw new WebError('The form contains invalid fields. Open a fresh page.');
    for (const [key,value] of form.entries()) if (key!=='photo' && typeof value!=='string') throw new WebError('The form contains invalid fields. Open a fresh page.');
    draft = (form.get('text') || '').slice(0, 600);
    const token = readToken(form.get('token'), actor, action === 'avatar-remove' ? 'avatar' : action, env.TURNFEED_SITE_SECRET);
    if (action==='privacy') {
      if (!['true','false'].includes(form.get('privateAccount')) || typeof token.target?.privateAccount!=='boolean') throw new WebError('Choose Public or Private from a fresh account privacy page.');
      await call(request,env,'set_account_privacy',{privateAccount:form.get('privateAccount')==='true',expectedPrivateAccount:token.target.privateAccount});
      return redirect('/privacy-settings?done=saved');
    }
    if (action==='follower') {
      if (!['accept','reject','remove'].includes(token.target?.action) || !token.target?.person?.targetRef) throw new WebError('Open your followers again.',403);
      await call(request,env,'manage_follower',{targetRef:token.target.person.targetRef,targetLabel:token.target.person.targetLabel,
        action:token.target.action,...(token.target.requestId?{requestId:token.target.requestId}:{})});
      return redirect('/privacy-settings?done='+token.target.action);
    }
    if (action === 'person-block' || action === 'person-mute') {
      if (!token.target?.person?.targetRef) throw new WebError('Open this profile again.',403);
      const data=await publicProfile(request,env,{ref:token.target.person.targetRef});
      if (fingerprint(personIdentity(data.profile))!==fingerprint(token.target.person) || data.profile.viewerIsSelf || data.profile.viewerHasBlocked) {
        throw new WebError('This person or your access changed. Review their profile again.',409);
      }
      const desired=action==='person-block'?'block':'mute';
      await call(request,env,desired==='block'?'block_user':'mute_user',{
        targetRef:data.profile.targetRef,targetLabel:data.profile.displayName,action:desired,
      });
      return redirect('/preferences?done='+ (desired==='block'?'blocked':'muted'));
    }
    if (['like-post','like-reply','follow'].includes(action)) {
      const destination=token.target?.returnTo;
      if (typeof destination!=='string' || !destination.startsWith('/') || destination.startsWith('//')) throw new WebError('Open a fresh page before trying again.',403);
      recoveryPath=destination;
      if (action==='follow') {
        if (!['follow','unfollow'].includes(token.target.desired) || !token.target.person?.targetRef) throw new WebError('Open this profile again.',403);
        const data=await publicProfile(request,env,{ref:token.target.person.targetRef});
        if (fingerprint(personIdentity(data.profile))!==fingerprint(token.target.person)
          || data.profile.viewerIsSelf || data.profile.viewerHasBlocked) throw new WebError('This person or your access changed. Review their profile again.',409);
        await call(request,env,'follow_user',{targetRef:data.profile.targetRef,targetLabel:data.profile.displayName,action:token.target.desired});
        if (request.headers.get('accept') === 'application/json') {
          const fresh=await publicProfile(request,env,{ref:token.target.person.targetRef});
          if (fingerprint(personIdentity(fresh.profile))!==fingerprint(token.target.person)) throw new WebError('This profile changed. Refresh to check your follow.',409);
          const next=followControl(fresh.profile,actor,env.TURNFEED_SITE_SECRET,destination);
          if (!next?.token) throw new WebError('Refresh to check your follow.',409);
          return Response.json({ok:true,following:next.following,requested:next.requested,privateAccount:next.privateAccount,
            refresh:data.profile.viewerCanReadContent!==fresh.profile.viewerCanReadContent,
            count:fresh.profile.followerCount,token:next.token},{headers});
        }
        const next=new URL(destination,url.origin);next.searchParams.set('done',token.target.desired==='follow'?'followed':'unfollowed');
        // An unfollow changes the list cursor; start its refreshed first page.
        if (next.pathname==='/following') next.searchParams.delete('cursor');
        return redirect(next.pathname+next.search+next.hash);
      }
      if (!['like','unlike'].includes(token.target.desired)) throw new WebError('Open this conversation again.',403);
      const data=await controlTarget(request,env,token.target.postId,token.target.reply,token.target.cursor);
      if ((action==='like-reply')!==data.isReply || fingerprint(likeIdentity(data.item))!==token.target.content) {
        throw new WebError('The content or author changed. Review the conversation again.',409);
      }
      if (data.isReply) {
        // controlTarget binds the displayed parent as well as the selected reply.
        if (fingerprint(likeIdentity(data.parentItem))!==token.target.parent) throw new WebError('The parent post changed. Review the conversation again.',409);
      }
      const {postId:_postId,...readable}=readableTarget(data);
      await call(request,env,data.isReply?'like_reply':'like_post',{...readable,...(!data.isReply?{id:data.postId}:{}),action:token.target.desired});
      if (request.headers.get('accept') === 'application/json') {
        // The core returns only confirmation. Read committed state for the count
        // and next signed action; do not guess from a possibly stale page.
        const fresh = await controlTarget(request,env,token.target.postId,token.target.reply,token.target.cursor);
        if (fingerprint(likeIdentity(fresh.item)) !== token.target.content
            || (fresh.isReply && fingerprint(likeIdentity(fresh.parentItem)) !== token.target.parent)) {
          throw new WebError('The conversation changed. Refresh to check your like.',409);
        }
        const next = socialItem(fresh.item,actor,env.TURNFEED_SITE_SECRET,{postId:fresh.postId,
          cursor:token.target.cursor,parent:fresh.isReply?fresh.parentItem:undefined,returnTo:destination,allowLike:true}).webLike;
        if (!next?.token) throw new WebError('Refresh to check your like.',409);
        return Response.json({ok:true,liked:next.liked,count:next.count,token:next.token}, {headers});
      }
      return redirect(destination);
    }
    if (action === 'avatar' || action === 'avatar-remove') {
      if (typeof token.target?.avatarUrl !== 'string') throw new WebError('Open My profile again before changing your picture.', 403);
      const photo = action === 'avatar' && multipart ? await webPhotoInput(form.get('photo')) : undefined;
      if (action === 'avatar' && !photo) throw new WebError('Choose a JPEG or PNG picture first.');
      await call(request, env, 'set_profile', { visibility: 'public' }, false, undefined,
        { ...(photo || {}), remove: action === 'avatar-remove', clientId: token.clientId, expected: token.target.avatarUrl });
      return redirect('/profile?done=saved');
    }
    if (['reply', 'nested-reply'].includes(action) && /^[A-Za-z0-9_-]{1,64}$/.test(token.target?.postId || '')) {
      recoveryPath = threadPath(token.target.postId);
    }
    if (action === 'post' || action === 'reply' || action === 'nested-reply') {
      const text = form.get('text');
      if (!text?.trim() || text.length > 600) throw new WebError('Write between 1 and 600 characters.');
      if (action === 'post') {
        const photo = multipart ? await webPhotoInput(form.get('photo')) : undefined;
        const data = await call(request, env, 'create_post', { text, visibility: 'public', clientId: token.clientId }, false, photo);
        if (!data.published) throw new WebError('Turnfeed did not confirm publication. Check the feed before trying again.', 503);
        return redirect(data.postId ? `${threadPath(data.postId)}?done=posted` : '/?done=posted');
      }
      if (action === 'nested-reply') {
        // The native handler resolves this signed readable target against fresh
        // state and rechecks visibility, archive, depth, capacity and ambiguity.
        // Do not relocate targets by page position: replies may have moved.
        const result = await call(request, env, 'publish_public_reply_to_reply', {
          ...token.target?.arguments, text, visibility: 'public', clientId: token.clientId,
        });
        if (!result.published || !result.postId) throw new WebError('Turnfeed did not confirm publication. Check the conversation before trying again.', 503);
        return redirect(`${threadPath(result.postId)}?done=replied#replies`);
      }
      const data = await thread(request, env, token.target?.postId);
      if (fingerprint(targetFor(data)) !== fingerprint(token.target)) throw new WebError('The post changed since you opened this form. Copy your reply and review the conversation again.', 409);
      if (data.replyHandoff?.publishTool !== 'publish_public_reply_to_post') throw new WebError('This post is no longer accepting replies.', 409);
      const result = await call(request, env, 'publish_public_reply_to_post', { ...data.replyHandoff.targetArguments, text, visibility: 'public', clientId: token.clientId });
      if (!result.published) throw new WebError('Turnfeed did not confirm publication. Check the conversation before trying again.', 503);
      return redirect(`${threadPath(data.postId)}?done=replied#replies`);
    }
    if (action === 'profile') {
      const profileDraft = { displayName: form.get('displayName') ?? '', handle: form.get('handle') ?? '', bio: form.get('bio') ?? '' };
      try {
        const handle = profileDraft.handle.trim().replace(/^@/, '');
        if (handle && !/^[a-z0-9_]+$/i.test(handle)) {
          throw new WebError('Handles use only a–z, 0–9 and underscores. You can use letters such as ø, æ and å in your display name.', 422);
        }
        await call(request, env, 'set_profile', { ...profileDraft, visibility: 'public' });
      } catch (error) {
        // Only rejected input is safe to offer for correction. Ambiguous saves and
        // authentication/storage failures keep their existing recovery behavior.
        if (!(error instanceof WebError) || ![400, 409, 422].includes(error.status)) throw error;
        return await profilePage(request, env, actor, { profileDraft,
          profileErrorField: /handle/i.test(error.message) ? 'handle' : '',
          error: `Your profile was not saved. ${error.message}` }, error.status);
      }
      return redirect('/profile?done=saved');
    }
    if (['report', 'block', 'mute', 'delete-reply'].includes(action)) {
      const data = await controlTarget(request, env, token.target?.postId, token.target?.reply, token.target?.cursor);
      if (fingerprint(data.target) !== fingerprint(token.target)) throw new WebError('The content or author changed. Review the action again.', 409);
      if (action === 'delete-reply') {
        if (!data.isReply || !data.viewerOwnsTarget) throw new WebError('Only the author can delete this reply.', 403);
        await call(request, env, 'delete_reply', readableTarget(data));
        return redirect(`${threadPath(data.postId)}?done=reply-deleted`);
      }
      if (data.viewerOwnsTarget) throw new WebError('Choose someone else’s content for this action.', 403);
      if (action === 'report') {
        const reason = form.get('reason');
        if (!reportReasons.some(item => item.value === reason)) throw new WebError('Choose a report reason.');
        await call(request, env, data.isReply ? 'report_reply' : 'report_post', { ...readableTarget(data), reason });
        return redirect(`${threadPath(data.postId)}?done=reported`);
      }
      if (!data.item.authorTargetRef) throw new WebError('This person is no longer available for this action.', 409);
      await call(request, env, action === 'block' ? 'block_user' : 'mute_user', {
        targetRef: data.item.authorTargetRef, targetLabel: data.item.authorName, action,
      });
      return redirect(`/activity?done=${action === 'block' ? 'blocked' : 'muted'}`);
    }
    if (action === 'unblock' || action === 'unmute') {
      const page = await peoplePage(request, env, action === 'unblock' ? 'blocked' : 'muted', token.target?.cursor);
      const matches = page.items.filter(item => fingerprint(personIdentity(item)) === fingerprint(token.target?.person));
      if (matches.length !== 1) throw new WebError('This person or your list changed. Open My profile → Muted and blocked again.', 409);
      await call(request, env, action === 'unblock' ? 'block_user' : 'mute_user', {
        targetRef: matches[0].targetRef, targetLabel: matches[0].displayName, action,
      });
      return redirect(`/preferences?done=${action === 'unblock' ? 'unblocked' : 'unmuted'}`);
    }
    if (action === 'delete') {
      const data = await thread(request, env, token.target?.postId);
      if (!data.viewerOwnsTarget) throw new WebError('Only the author can delete this post.', 403);
      if (fingerprint(targetFor(data)) !== fingerprint(token.target)) throw new WebError('The post changed. Review it again before deleting.', 409);
      // Deleting a thread also removes replies; the dedicated confirmation page
      // makes that scope explicit. Never accept bulk-deletion fields from a form.
      await call(request, env, 'delete_post', { id: data.postId, targetLabel: `Post by ${data.thread.authorName}`,
        postText: data.thread.text, ...(data.thread.authorPublicHandle ? { authorHandle: data.thread.authorPublicHandle } : {}),
        ...(data.thread.createdAt ? { createdAt: data.thread.createdAt } : {}), scope: 'one_post' });
      return redirect('/?done=deleted');
    }
    throw new WebError('This action is unavailable.', 404);
  } catch (error) {
    if (!(error instanceof WebError)) console.error(JSON.stringify({ event: 'turnfeed_web_failed', code: error instanceof StorageError ? error.code : 'internal_error' }));
    return webFailure(error, signedIn, draft, recoveryPath);
  }
}
