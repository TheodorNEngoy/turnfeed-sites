import { stagePhoto, stageWebPhoto, screenStoredPhoto, PhotoError } from './photos.mjs';
import { photoPath, photoId, postPhotoIds, removePostPhotos, retireUnpublishedPhoto } from './photo-access.mjs';
import { z } from 'zod';
import { createHmac, createHash } from 'node:crypto';
import { createTurnfeedCore } from './core.generated.mjs';
import { readState, commitState, StorageError } from './storage.mjs';
import { readSelection } from './storage-selection.mjs';
import { accountKey, chatGPTDisplayName, SITES_ISSUER } from './identity.mjs';
import { registerNativePreferences, privateSettingsPage } from './native-preferences.mjs';
import { registerNativePrivacy } from './native-privacy.mjs';
import { registerNativeAccount, invokeNativeAccount, disabledAccountAction } from './native-account.mjs';
import { createModerator, publicTextProjection, changedPublicTexts, ModerationError } from './moderation.mjs';
import { reserveModerationAttempt } from './moderation-limit.mjs';

const PUBLIC_TOOLS = new Set(['start_turnfeed_chat', 'explain_turnfeed_chat_mode', 'get_turnfeed_rules',
  'get_feed_digest', 'get_thread_context', 'open_turnfeed_feed']);
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const issuer = SITES_ISSUER;
const config = { TURNFEED_AGGREGATE_ACTIVATION_ENABLED: '0' };
const photoInput = z.object({ download_url: z.string().min(1).max(8192), file_id: z.string().min(1).max(256), mime_type: z.string().max(100).optional(), file_name: z.string().max(256).optional() }).strict();
const stateDigest = (snapshot, controls, profileNameChoices) => createHash('sha256')
  .update(JSON.stringify({ snapshot: { ...snapshot, updatedAt: null }, controls, profileNameChoices })).digest('hex');
export function makeCore({ origin, secret, subject = '', snapshot, controls, callerKey = '', threadProjection = false, allowedPhotoUrls = [] }) {
  const core = createTurnfeedCore({ origin, secret, issuer, snapshot, controls, config, callerKey, threadProjection, allowedPhotoUrls });
  core.instructions += ' Native Turnfeed also provides get_my_settings, update_my_settings and mute_user for private preferences in chat. Only change those preferences when the user asks. To publish a user-selected JPEG or PNG photo from chat, use create_post with its photo file input and the exact approved caption. Photos are limited to 1 MiB each; URLs alone are not uploaded. Video links from YouTube and Vimeo display on the website after the viewer chooses to load them. Video-file uploads, remote link previews and MCP Events delivery remain unavailable. ChatGPT may supply an initial account name; it can differ from the public ChatGPT profile name and users may change or clear it.';
  core.instructions += ' Use export_my_data for a private account export. Closing a Turnfeed account in chat is temporarily unavailable; direct closure requests to support@turnfeedapp.com. Never substitute reset_me for account closure. Exports stay private.';
  core.instructions += ' Account privacy applies to every post, reply and photo. Private-account content is readable only by its author and approved followers who can also read the conversation. Use get_my_privacy to check privacy and follow requests; change it only when asked. Names and handles remain discoverable. Never describe a private account’s publication as visible to everyone.';
  return registerNativePrivacy(registerNativeAccount(registerNativePreferences(core, secret)), secret);
}

function jsonSchema(schema) {
  return z.toJSONSchema(schema instanceof z.ZodType ? schema : z.object(schema), { target: 'draft-7', io: 'input' });
}
export function catalog(core) {
  return [...core.tools].map(([name, { descriptor: d }]) => {
    const schemes = PUBLIC_TOOLS.has(name)
      ? [{ type: 'noauth' }, { type: 'oauth2', scopes: [] }]
      : [{ type: 'oauth2', scopes: [] }];
    let description = d.description.replaceAll('Turnfeed/Auth0 identity', 'ChatGPT identity');
    const inputSchema = jsonSchema(d.inputSchema);
    // Keep page bounds visible when a host renders only a parameter's type and description.
    const pageLimit = inputSchema.properties?.limit;
    if (pageLimit?.type === 'integer' && Number.isInteger(pageLimit.minimum) && Number.isInteger(pageLimit.maximum)) {
      pageLimit.description += ` Optional integer from ${pageLimit.minimum} to ${pageLimit.maximum}, inclusive; omit for the default page size. For more results, follow the returned continuation instructions instead of exceeding this limit.`;
    }
    if (name === 'get_thread_context') {
      description += ` Omit limit for a normal thread read; at most ${pageLimit.maximum} replies fit in one page. Full/all means following nextCursor while hasMore is true, not increasing limit beyond ${pageLimit.maximum}.`;
    }
    if (name === 'publish_public_reply_to_post' || name === 'publish_public_reply_to_reply') {
      description = description.replace('exact public reply text the user supplied',
        'exact public reply text supplied by the user or explicitly approved as a displayed private draft');
      description += ' Discussion and drafting stay private. A later request such as "reply with that" may publish the displayed draft only when its exact wording and target are unambiguous; otherwise clarify before publishing.';
    }
    if (name === 'create_post') {
      description += ' Publish a selected chat photo with the optional photo file input only when the user explicitly asks to publish that image and this exact caption. Accepts one JPEG or PNG up to 1 MiB; removes embedded metadata. Video files are unsupported; YouTube or Vimeo links may appear in the exact post text. Never fetch an unrelated file or silently post text without a requested photo.';
      inputSchema.properties.photo = jsonSchema(photoInput);
      description += ' Successful publication returns the verified postId, createdPost and a replyHandoff when replies are available. Retain these for follow-up requests; never invent a postId. Follow replyHandoff.readFirst before publishing an explicitly requested exact reply.';
      if (inputSchema.properties?.media) {
        inputSchema.properties.media.maxItems = 0;
        inputSchema.properties.media.description = 'Omit this legacy field. Use photo for a selected chat image; non-empty media lists are rejected.';
      }
    }
    if (name === 'set_profile' && inputSchema.properties?.avatarUrl) {
      inputSchema.properties.avatarUrl.maxLength = 0;
      inputSchema.properties.avatarUrl.description = 'Omit or clear this field. To upload or replace a profile picture, use My profile on the Turnfeed website. Arbitrary image URLs are not accepted.';
    }
    return { name, title: d.title, description, inputSchema,
      outputSchema: z.toJSONSchema(d.outputSchema, { target: 'draft-7', io: 'output' }),
      annotations: d.annotations, securitySchemes: schemes, _meta: { ...d._meta, securitySchemes: schemes, ...(name === 'create_post' ? { 'openai/fileParams': ['photo'] } : {}) } };
  });
}

export function trustedContext(subject) {
  // Only call with the Sites dispatch header. MCP arguments and _meta never enter this object.
  return subject ? { authInfo: { extra: { sub: subject, issuer }, scopes: ['turnfeed:read', 'turnfeed:write', 'turnfeed:account'] } } : {};
}

const closedAccountError = () => ({ rpcError: { code: -32001,
  message: 'This Turnfeed account has been closed. Its existing ChatGPT connection cannot create new Turnfeed data.' }, status: 403 });

async function selectedSettings({ db, budget, origin, secret, subject, displayName, args, callerKey }) {
  const selection = await readSelection(db, budget);
  if (!selection) return null;
  const actor = accountKey(subject, secret);
  const [format, version, revoked, preferences, profile, nameChoice] = await selection.project([
    ['format'], ['snapshot', 'version'], ['operator', 'revoked', actor],
    ['snapshot', 'viewerStates', actor], ['snapshot', 'profiles', actor], ['profileNameChoices', actor],
  ]);
  if (format !== 1 || version !== 19) throw new StorageError('storage_corrupt');
  if (revoked) return closedAccountError();
  // Defaults come from the retained core. This temporary snapshot cannot enter
  // the ordinary write path; no partial state is ever offered to commitState.
  const snapshot = makeCore({ origin, secret }).snapshot();
  snapshot.viewerStates = preferences === undefined ? {} : { [actor]: preferences };
  snapshot.profiles = profile === undefined ? {} : { [actor]: profile };
  let core = makeCore({ origin, secret, subject, callerKey, snapshot });
  const parsed = core.tools.get('get_my_settings').descriptor.inputSchema.safeParse(args);
  if (!parsed.success) return { rpcError: { code: -32602, message: 'Invalid tool arguments',
    data: parsed.error.issues.map(i => ({ path: i.path, message: i.message })) } };
  // Preserve the existing first-name import and its durable write using a fresh,
  // complete baseline. Explicit choices, including clears, never trigger it.
  if (displayName && !nameChoice && !core.hasProfileName(actor)) return null;
  const page = privateSettingsPage(core.privatePreferences, secret, actor, parsed.data);
  if (page.ok !== false && page.memberIds.length) {
    const profiles = await selection.project(page.memberIds.map(id => ['snapshot', 'profiles', id]));
    snapshot.profiles = Object.fromEntries([
      ...Object.entries(snapshot.profiles),
      ...page.memberIds.flatMap((id, i) => profiles[i] === undefined ? [] : [[id, profiles[i]]]),
    ]);
    core = makeCore({ origin, secret, subject, callerKey, snapshot });
  }
  return { result: await core.tools.get('get_my_settings').handler(parsed.data, trustedContext(subject)) };
}

async function selectedThread({ db, budget, origin, secret, subject, displayName, args, callerKey }) {
  const empty = makeCore({ origin, secret });
  const parsed = empty.tools.get('get_thread_context').descriptor.inputSchema.safeParse(args);
  if (!parsed.success) return null; // Retain ordinary validation/error ordering.
  const selection = await readSelection(db, budget);
  if (!selection) return null;
  const actor = accountKey(subject, secret);
  const [format, version, revoked, preferences, profile, nameChoice, post, following] = await selection.project([
    ['format'], ['snapshot', 'version'], ['operator', 'revoked', actor],
    ['snapshot', 'viewerStates', actor], ['snapshot', 'profiles', actor], ['profileNameChoices', actor],
    ['snapshot', 'posts', ['id', parsed.data.postId]],
    ['snapshot', 'follows', actor],
  ]);
  if (format !== 1 || version !== 19) throw new StorageError('storage_corrupt');
  if (actor && revoked) return closedAccountError();
  // Quotes keep pairwise source/correction-history checks over the complete
  // state. Groups, non-public/unknown shapes and ambiguous IDs also keep the
  // retained path. Never infer a missing thread from a missing stable ID.
  if (!post || post.id !== parsed.data.postId || post.quotePostId || post.groupId
      || (post.visibility && post.visibility !== 'public')
      || (post.audience?.type && post.audience.type !== 'public')) return null;
  const snapshot = empty.snapshot();
  snapshot.posts = [post];
  snapshot.profiles = profile === undefined ? {} : { [actor]: profile };
  snapshot.viewerStates = preferences === undefined ? {} : { [actor]: preferences };
  snapshot.follows = following === undefined ? {} : { [actor]: following };
  if (actor && displayName && !nameChoice && !profile?.displayName && !profile?.handle) return null;
  const participants = new Set(actor ? [actor] : []);
  const pending = [post];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (item.authorId) participants.add(String(item.authorId));
    if (Array.isArray(item.replies)) for (const reply of item.replies) pending.push(reply);
  }
  const people = [...participants];
  const values = await selection.project(people.flatMap(id => [
    ['snapshot', 'profiles', id], ['snapshot', 'blocks', id],
  ]));
  snapshot.profiles = Object.fromEntries(people.flatMap((id, i) => values[i * 2] === undefined ? [] : [[id, values[i * 2]]]));
  snapshot.blocks = Object.fromEntries(people.flatMap((id, i) => values[i * 2 + 1] === undefined ? [] : [[id, values[i * 2 + 1]]]));
  const core = makeCore({ origin, secret, subject, callerKey, snapshot, threadProjection: true });
  return { result: await core.tools.get('get_thread_context').handler(parsed.data, trustedContext(subject)) };
}

async function selectedFeed({ db, budget, origin, secret, subject, displayName, args, callerKey }) {
  const empty = makeCore({ origin, secret });
  const parsed = empty.tools.get('get_feed_digest').descriptor.inputSchema.safeParse(args);
  if (!parsed.success) return null; // Preserve ordinary validation/error ordering.
  const selection = await readSelection(db, budget);
  if (!selection) return null; // Initialization and legacy migration use a full baseline.
  const actor = accountKey(subject, secret);
  // The retained ranker uses whole conversation trees, the relationship graph
  // and follow/like history. Keep these complete so rank, visibility, quotes and
  // continuation fingerprints stay identical. Receipt ledgers, report evidence,
  // moderation history and other people's preferences are not feed inputs.
  const fields = ['posts', 'profiles', 'groups', 'follows', 'blocks', 'followEvents', 'likeEvents'];
  const [format, version, revoked, preferences, nameChoice, ...values] = await selection.project([
    ['format'], ['snapshot', 'version'], ['operator', 'revoked', actor],
    ['snapshot', 'viewerStates', actor], ['profileNameChoices', actor],
    ...fields.map(field => ['snapshot', field]),
  ]);
  if (format !== 1 || version !== 19) throw new StorageError('storage_corrupt');
  if (actor && revoked) return closedAccountError();
  const snapshot = empty.snapshot();
  fields.forEach((field, index) => { snapshot[field] = values[index]; });
  snapshot.viewerStates = actor && preferences !== undefined ? { [actor]: preferences } : {};
  const core = makeCore({ origin, secret, subject, callerKey, snapshot });
  // Importing a first ChatGPT name is a write. It must retain the complete
  // baseline, moderation and compare-and-swap path rather than commit a projection.
  if (actor && displayName && !nameChoice && !core.hasProfileName(actor)) return null;
  return { result: await core.tools.get('get_feed_digest').handler(parsed.data, trustedContext(subject)) };
}

export async function invoke({ db, origin, secret, subject, displayName = '', name, args, callerKey, includeActivityEvents = false, allowedPhotoUrls = [], avatarChange, bucket, readyPhotoCheck, moderate = createModerator('') }) {
  const disabled = disabledAccountAction(name);
  if (disabled) return disabled;
  const budget = { remaining: 45 };
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((name === 'get_my_settings' && subject) || name === 'get_thread_context'
        || (name === 'get_feed_digest' && !includeActivityEvents)) {
      try {
        const reader = name === 'get_thread_context' ? selectedThread
          : name === 'get_feed_digest' ? selectedFeed : selectedSettings;
        const selected = await reader({ db, budget, origin, secret, subject, displayName, args, callerKey });
        if (selected) return selected;
      } catch (error) {
        if (error.code !== 'storage_changed') throw error;
        continue;
      }
    }
    const loaded = await readState(db, budget);
    const previousPhotos = (loaded.value?.snapshot?.posts || []).filter(p => p.media?.length).map(p => ({id:p.id, authorId:p.authorId, media:p.media}));
    const previousAvatar = loaded.value?.snapshot?.profiles?.[accountKey(subject,secret)]?.avatarUrl || '';
    if (subject && loaded.value?.operator?.revoked?.[accountKey(subject, secret)]) {
      return closedAccountError();
    }
    if (avatarChange && previousAvatar !== avatarChange.expected && previousAvatar !== avatarChange.url) {
      return {status:409,rpcError:{code:-32602,message:'Your profile picture changed. Open My profile again before changing it.'}};
    }
    const core = makeCore({ origin, secret, subject, callerKey,
      snapshot: loaded.value?.snapshot, controls: loaded.value?.controls, allowedPhotoUrls });
    const entry = core.tools.get(name);
    if (!entry) return { rpcError: { code: -32601, message: 'Unknown tool' } };
    const schema = entry.descriptor.inputSchema;
    const parsed = schema.safeParse(args);
    if (!parsed.success) return { rpcError: { code: -32602, message: 'Invalid tool arguments', data: parsed.error.issues.map(i => ({ path: i.path, message: i.message })) } };
    if (entry.nativeAccount) return invokeNativeAccount({ loaded, core, secret, subject, name, args: parsed.data });
    const profileNameChoices = { ...loaded.value?.profileNameChoices };
    const userId = accountKey(subject, secret);
    const before = stateDigest(core.snapshot(), core.controls(), profileNameChoices);
    // Core objects can alias loaded state. Capture immutable public strings
    // before either implicit name import or the handler changes them.
    const publicBefore = publicTextProjection(core.snapshot());
    // Sites supplies the optional name. Never infer a public name from email,
    // tool arguments or model metadata. Explicit choices (including clears) win.
    if (userId && !profileNameChoices[userId] && name !== 'reset_me'
        && !(name === 'set_profile' && (Object.hasOwn(parsed.data, 'displayName') || Object.hasOwn(parsed.data, 'handle')))) {
      const candidate = String(displayName || '').replace(/[\u0000-\u001F\u007F]/g,'').replace(/\s+/g,' ').trim().slice(0,32);
      if (!core.hasProfileName(userId) && candidate && !/\S+@\S+\.\S+/.test(displayName)) {
        try {
          await moderate({texts:[candidate]});
          await core.initializeProfileName(userId, candidate);
        } catch(error) {
          // An optional name import must not prevent someone reading the feed
          // during an outage. Explicit profile edits still require screening.
          if (!(error instanceof ModerationError)) throw error;
        }
      }
    }
    const result = await entry.handler(parsed.data, trustedContext(subject));
    if (result?.isError && ['chatgpt_sign_in_required', 'chatgpt_access_required'].includes(result.structuredContent?.code)) {
      return { rpcError: { code: -32001, message: result.structuredContent.message }, status: result.structuredContent.status };
    }
    if (userId && result?.structuredContent?.ok === true
        && ((name === 'set_profile' && result.structuredContent.saved === true
          && Object.hasOwn(parsed.data, 'displayName')) || name === 'reset_me')) {
      profileNameChoices[userId] = true;
    }
    if (userId && name === 'open_turnfeed_feed' && result?.structuredContent?.viewerOwnsTarget === true
        && result.structuredContent.profile?.viewerIsSelf === true
        && !profileNameChoices[userId] && !core.hasProfileName(userId)) {
      const prompt = 'What would you like to be called on Turnfeed?';
      result.structuredContent.displayText = `${result.structuredContent.displayText || ''}\n\n${prompt}`;
      result.content.push({ type: 'text', text: prompt });
    }
    const value = { ...loaded.value, format: 1, snapshot: core.snapshot(), controls: core.controls(), profileNameChoices };
    const newText = changedPublicTexts(publicBefore, value.snapshot);
    const newPhoto = allowedPhotoUrls[0] && !previousPhotos.some(p=>p.media.some(m=>m.url===allowedPhotoUrls[0]))
      && value.snapshot.posts.some(p=>p.media?.some(m=>m.url===allowedPhotoUrls[0]));
    const newAvatar = avatarChange?.url && previousAvatar !== avatarChange.url
      && value.snapshot.profiles?.[userId]?.avatarUrl === avatarChange.url;
    if (newText.length || ((newPhoto || newAvatar) && readyPhotoCheck)) {
      try {
        if (newText.length) await moderate({ texts: newText });
        if ((newPhoto || newAvatar) && readyPhotoCheck) await readyPhotoCheck();
      }
      catch (error) {
        if (!(error instanceof ModerationError)) throw error;
        return { result: { isError: true, structuredContent: { ok: false, code: error.code, status: error.status, message: error.message },
          content: [{ type: 'text', text: error.message }] } };
      }
    }
    // Keep restricted original photo evidence when a post is reported. This
    // journal is operator-only and remains within the same global storage cap.
    if (bucket && name === 'report_post' && result?.structuredContent?.ok === true) {
      const evidence = {...value.operator?.photoEvidence};
      for (const report of value.snapshot.reports || []) {
        if (report.targetType !== 'post') continue;
        const post = value.snapshot.posts.find(p => p.id === report.postId && p.createdAt === report.targetIncarnation);
        for (const id of postPhotoIds(post,origin)) if (!evidence[id]) evidence[id] = {
          owner:post.authorId, postId:post.id, mime:post.media[0].url.endsWith('.png')?'image/png':'image/jpeg', retainedAt:report.createdAt,
        };
      }
      value.operator = {...(value.operator || {revoked:{},erasures:[]}), photoEvidence:evidence};
    }
    // Snapshot timestamps are computed at export; do not write solely because time advanced.
    const changed = stateDigest(value.snapshot, value.controls, profileNameChoices) !== before;
    const activityEvents = includeActivityEvents && name === 'open_turnfeed_inbox' && userId
      ? core.activityEvents(userId) : undefined;
    const output = { result, ...(activityEvents ? { activityEvents } : {}) };
    if (!changed && (loaded.storageFormat !== 1 || !loaded.value)) return output;
    // A successful read may migrate an existing legacy snapshot unchanged.
    // This needs no profile edit or synthetic social write to activate storage.
    const photoTransition = avatarChange?.url ? {id:photoId(avatarChange.url,origin),owner:userId}
      : allowedPhotoUrls.length ? {id:photoId(allowedPhotoUrls[0],origin), owner:userId} : undefined;
    if (await commitState(db, loaded.revision, changed ? value : loaded.value, budget, loaded, photoTransition)) {
      if (bucket && previousAvatar && previousAvatar !== (value.snapshot.profiles?.[userId]?.avatarUrl || '')) {
        const id = photoId(previousAvatar,origin);
        if (id) try { await retireUnpublishedPhoto(db,bucket,id,userId,origin); }
        catch { console.error(JSON.stringify({event:'turnfeed_photo_cleanup_pending'})); }
      }
      if (bucket && ['delete_post','reset_me'].includes(name) && result?.structuredContent?.ok === true) {
        const removed = previousPhotos.filter(p => !value.snapshot.posts.some(next => next.id === p.id));
        for (const post of removed) {
          try { await removePostPhotos(db, bucket, post, origin, value.operator?.photoEvidence); }
          catch { console.error(JSON.stringify({event:'turnfeed_photo_cleanup_pending'})); }
        }
      }
      return output;
    }
    // A definite compare-and-swap miss has no effects. Re-run the complete wrapper.
  }
  throw new StorageError('storage_busy');
}

export async function dispatchMcp(request, env, body, { includeActivityEvents = false, webPhoto, webAvatar } = {}) {
  const origin = new URL(request.url).origin;
  const secret = env.TURNFEED_SITE_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return { status: 503, error: { code: -32603, message: 'Turnfeed configuration is unavailable.' } };
  if (body.method === 'initialize') return { result: {
    protocolVersion: SUPPORTED_PROTOCOLS.includes(body.params?.protocolVersion) ? body.params.protocolVersion : SUPPORTED_PROTOCOLS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'turnfeed-native', title: 'Turnfeed', version: '0.1.0' },
    instructions: makeCore({ origin, secret }).instructions,
  } };
  if (body.method === 'ping') return { result: {} };
  if (body.method === 'notifications/initialized') return { notification: true };
  if (body.method === 'tools/list') return { result: { tools: catalog(makeCore({ origin, secret })) } };
  if (body.method !== 'tools/call') return { error: { code: -32601, message: 'Unknown method' } };
  const name = body.params?.name;
  const subject = request.headers.get('oai-authenticated-user-id')?.trim() || '';
  if (subject.length > 512) return { status: 403, error: { code: -32001, message: 'Invalid authenticated identity.' } };
  if (!PUBLIC_TOOLS.has(name) && !subject) return { status: 401, error: { code: -32001, message: 'Sign in with ChatGPT to use this action.' } };
  const callerKey = createHmac('sha256', secret).update(subject ? `user:${subject}` : `public:${request.headers.get('cf-connecting-ip') || 'anonymous'}`).digest('hex');
  const moderate = createModerator(env.OPENAI_API_KEY, {
    beforeRequest: () => reserveModerationAttempt({ db: env.DB, actor: accountKey(subject, secret) }),
  });
  let args = body.params?.arguments ?? {}, allowedPhotoUrls = [], readyPhotoCheck, avatarChange;
  if (name === 'set_profile' && args.avatarUrl) {
    return {error:{code:-32602,message:'Choose a profile picture in My profile on the Turnfeed website. Arbitrary avatar URLs are not accepted.'}};
  }
  if (name === 'set_profile' && webAvatar) {
    const owner=accountKey(subject,secret), state=await readState(env.DB);
    if (state.value?.operator?.revoked?.[owner]) return {status:403,error:closedAccountError().rpcError};
    const entry=makeCore({origin,secret}).tools.get(name);
    if (!subject || typeof webAvatar.expected !== 'string' || typeof webAvatar.clientId !== 'string' || !entry.descriptor.inputSchema.safeParse(args).success) {
      return {status:400,error:{code:-32602,message:'Open My profile and choose the picture again.'}};
    }
    // A browser-signed form binds the expected picture. Old forms may confirm
    // an identical save, but cannot overwrite a newer picture or removal.
    if (webAvatar.remove) {
      avatarChange={expected:webAvatar.expected,url:''};args={...args,avatarUrl:''};
    } else {
      const storage={db:env.DB,bucket:env.BUCKET,owner,secret,screen:photo=>moderate({photo})};
      let staged;
      try {
        staged=await stageWebPhoto({...storage,bytes:webAvatar.bytes,mime:webAvatar.mime,clientId:'avatar|'+webAvatar.clientId});
        const url=origin+photoPath(staged.id,staged.mime);
        avatarChange={expected:webAvatar.expected,url};args={...args,avatarUrl:url};
        if (staged.needsScreening) readyPhotoCheck=()=>screenStoredPhoto(env.DB,env.BUCKET,staged.id,owner,storage.screen);
      } catch(error) {
        const known=error instanceof PhotoError || error instanceof ModerationError;
        return {result:{isError:true,structuredContent:{ok:false,status:known?error.status:503,
          message:'Your profile picture was not changed. '+(known?error.message:'Please try again later.')},content:[]}};
      }
    }
  }
  if (name === 'create_post' && (Object.hasOwn(args, 'photo') || webPhoto)) {
    const {photo, ...postArgs} = args;
    const parsed = photoInput.safeParse(photo);
    const entry = makeCore({origin,secret}).tools.get('create_post');
    if ((!webPhoto && !parsed.success) || (webPhoto && Object.hasOwn(args,'photo')) || !entry.descriptor.inputSchema.safeParse(postArgs).success || postArgs.media?.length) {
      return {error:{code:-32602,message:'Use one JPEG or PNG photo and a valid exact caption. Omit media.'}};
    }
    // Check account revocation before fetching a file or reserving upload space.
    const state = await readState(env.DB);
    if (state.value?.operator?.revoked?.[accountKey(subject,secret)]) return {status:403,error:closedAccountError().rpcError};
    try {
      // webPhoto is a server-internal option after browser CSRF validation;
      // it is never read from MCP arguments or JSON request fields.
      const storage={db:env.DB,bucket:env.BUCKET,owner:accountKey(subject,secret),secret,
        screen: async photo => {
          // Reject an unsafe caption before sending its image for screening.
          // Known/suspected child-abuse reports never enter this upload path.
          await moderate({texts:[postArgs.text]});
          await moderate({photo});
        }};
      const staged = webPhoto
        ? await stageWebPhoto({...storage,...webPhoto,clientId:postArgs.clientId})
        : await stagePhoto({...storage,
          file:{...parsed.data,file_id:createHmac('sha256',secret).update(postArgs.clientId+'|'+parsed.data.file_id).digest('hex')}});
      if (staged.needsScreening) readyPhotoCheck = () => screenStoredPhoto(env.DB,env.BUCKET,staged.id,storage.owner,storage.screen);
      const latest = await readState(env.DB);
      if (latest.value?.operator?.revoked?.[accountKey(subject,secret)]) {
        await removePostPhotos(env.DB,env.BUCKET,{authorId:accountKey(subject,secret),media:[{url:origin+photoPath(staged.id,staged.mime)}]},origin,latest.value?.operator?.photoEvidence);
        return {status:403,error:closedAccountError().rpcError};
      }
      const photoUrl = origin + photoPath(staged.id,staged.mime);
      args = {...postArgs,media:[{url:photoUrl,type:'image'}]};
      allowedPhotoUrls = [photoUrl];
    } catch (error) {
      const known = error instanceof PhotoError || error instanceof ModerationError;
      const message='Photo upload was not confirmed. No post was published by this attempt. '+(known ? error.message : 'Please try again later or contact support.');
      return {result:{isError:true,structuredContent:{ok:false,message,status:known ? error.status : 503},content:[{type:'text',text:message}]}};
    }
  }
  const output = await invoke({ db: env.DB, origin, secret, subject,
    displayName: subject ? chatGPTDisplayName(request.headers) : '', name, args, callerKey, includeActivityEvents,
    allowedPhotoUrls, avatarChange, bucket:env.BUCKET, readyPhotoCheck, moderate });
  if (avatarChange?.url) {
    try { await retireUnpublishedPhoto(env.DB,env.BUCKET,photoId(avatarChange.url,origin),accountKey(subject,secret),origin); }
    catch { console.error(JSON.stringify({event:'turnfeed_photo_cleanup_pending'})); }
  }
  if (allowedPhotoUrls.length) {
    try { await retireUnpublishedPhoto(env.DB,env.BUCKET,photoId(allowedPhotoUrls[0],origin),accountKey(subject,secret),origin); }
    catch { console.error(JSON.stringify({event:'turnfeed_photo_cleanup_pending'})); }
  }
  if (output.rpcError) return { error: output.rpcError, status: output.status };
  if (env.TURNFEED_OPERATOR_SETUP === '1' && subject && name === 'open_turnfeed_feed'
      && body.params?.arguments?.targetKind === 'profile' && body.params?.arguments?.profileScope === 'self'
      && output.result?.structuredContent?.viewerOwnsTarget === true) {
    // The installed connector omits MCP _meta. Return this own-account setup
    // identifier in structured data only while the owner-private flag is enabled.
    output.result.structuredContent.turnfeedSitesAccountKey = accountKey(subject, secret);
  }
  return output;
}
