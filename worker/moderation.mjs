import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const ENDPOINT = 'https://api.openai.com/v1/moderations';
const MODEL = 'omni-moderation-latest';
const MAX_IMAGE_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 65_536;
const REQUIRED_CATEGORIES = ['harassment', 'harassment/threatening', 'hate', 'hate/threatening',
  'illicit', 'illicit/violent', 'self-harm', 'self-harm/intent', 'self-harm/instructions',
  'sexual', 'sexual/minors', 'violence', 'violence/graphic'];
const digest = value => createHash('sha256').update(value).digest('hex');

export class ModerationError extends Error {
  constructor(code = 'moderation_unavailable') {
    super(code === 'moderation_rejected'
      ? 'This public content did not pass Turnfeed’s safety check. If you think this is a mistake, contact support@turnfeedapp.com for review.'
      : code === 'moderation_rate_limited'
        ? 'Too many safety checks have been requested. Wait up to one minute before trying again. Contact support@turnfeedapp.com if you need help.'
      : 'Turnfeed could not complete its safety check. Please try again later, or contact support@turnfeedapp.com for help or review.');
    this.name = 'ModerationError';
    this.code = ['moderation_rejected', 'moderation_rate_limited'].includes(code) ? code : 'moderation_unavailable';
    this.status = this.code === 'moderation_rejected' ? 422 : this.code === 'moderation_rate_limited' ? 429 : 503;
  }
}
const FAILURE_REASONS = new Set(['input_invalid', 'missing_key', 'fetch_unavailable',
  'before_request', 'network', 'api_status', 'api_redirect', 'response_headers',
  'response_body', 'response_json', 'response_shape', 'timeout', 'internal_error']);
function logUnavailable(reason, upstreamStatus) {
  // Deliberately exclude errors, response bodies/headers, URLs and all inputs.
  // Diagnostics stay in server logs rather than on client-visible errors.
  const diagnostic = { event: 'turnfeed_moderation_unavailable',
    reason: FAILURE_REASONS.has(reason) ? reason : 'internal_error' };
  if (Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599) diagnostic.upstreamStatus = upstreamStatus;
  try { console.error(JSON.stringify(diagnostic)); } catch { /* Logging must not alter the public failure. */ }
}

async function boundedJson(response, signal, unavailable) {
  if (!response.headers || typeof response.headers.get !== 'function'
      || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')
  ) unavailable('response_headers');
  if (!response.body || typeof response.body.getReader !== 'function') unavailable('response_body');
  const reader = response.body.getReader(), chunks = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let length = 0;
  try {
    for (;;) {
      if (signal.aborted) unavailable('timeout');
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) unavailable('response_body');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { unavailable('response_json'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

// Instantiate once per incoming request, then reuse across its storage retries.
// Only approved content hashes are retained, with a small per-request bound.
export function createModerator(apiKey, { fetcher = fetch, timeoutMs = 10_000, beforeRequest } = {}) {
  const approved = new Set();
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(15_000, timeoutMs)) : 10_000;
  return async ({ texts = [], photo } = {}) => {
    let failureReason = 'input_invalid', upstreamStatus, timer, timedOut = false;
    const controller = new AbortController();
    const unavailable = reason => { failureReason = reason; throw new ModerationError(); };
    try {
      if (!Array.isArray(texts) || texts.length > 16 || texts.some(text => typeof text !== 'string')
          || texts.reduce((sum, text) => sum + text.length, 0) > 8192) unavailable('input_invalid');
      texts = [...new Set(texts.filter(text => text.trim()))];
      if (photo !== undefined && (!photo || !(photo.data instanceof Uint8Array)
          || !photo.data.byteLength || photo.data.byteLength > MAX_IMAGE_BYTES
          || !['image/jpeg', 'image/png'].includes(photo.mime))) unavailable('input_invalid');
      if (!texts.length && photo === undefined) return { approved: true };
      if (typeof apiKey !== 'string' || !apiKey.trim()) unavailable('missing_key');
      if (typeof fetcher !== 'function') unavailable('fetch_unavailable');
      failureReason = 'internal_error';
      const key = createHash('sha256').update(MODEL).update(JSON.stringify(texts))
        .update(photo?.mime || '').update(photo?.data || new Uint8Array()).digest('hex');
      if (approved.has(key)) return { approved: true };
      const input = photo ? [
        ...(texts.length ? [{ type: 'text', text: texts.join('\n\n') }] : []),
        { type: 'image_url', image_url: { url: `data:${photo.mime};base64,${Buffer.from(photo.data).toString('base64')}` } },
      ] : texts;
      const expectedResults = photo ? 1 : texts.length;
      await Promise.race([
        (async () => {
          failureReason = 'before_request';
          if (beforeRequest !== undefined) await beforeRequest();
          if (controller.signal.aborted) unavailable('timeout');
          failureReason = 'network';
          // Workers supports manual/follow, not redirect:'error'. Never follow
          // a Location carrying this credential; reject non-200 responses below.
          // This server request has no browser cookie jar or incoming headers.
          const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'manual',
            headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: MODEL, input }), signal: controller.signal });
          upstreamStatus = response?.status;
          if (upstreamStatus !== 200) unavailable('api_status');
          if (response.redirected || (response.url && response.url !== ENDPOINT)) unavailable('api_redirect');
          failureReason = 'response_body';
          const data = await boundedJson(response, controller.signal, unavailable);
          failureReason = 'response_shape';
          if (!Array.isArray(data?.results) || !data.results.length) unavailable('response_shape');
          if (data.results.some(result => result?.flagged === true
              || (result?.categories && Object.values(result.categories).includes(true)))) {
            throw new ModerationError('moderation_rejected');
          }
          if (data.results.length !== expectedResults || data.results.some(result => result?.flagged !== false
              || !result.categories || typeof result.categories !== 'object' || Array.isArray(result.categories)
              || REQUIRED_CATEGORIES.some(category => typeof result.categories[category] !== 'boolean')
              || Object.values(result.categories).some(value => typeof value !== 'boolean'))) unavailable('response_shape');
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new ModerationError()); }, timeout); }),
      ]);
      if (approved.size >= 8) approved.delete(approved.values().next().value);
      approved.add(key);
      return { approved: true };
    } catch (error) {
      if (!(error instanceof ModerationError) || error.code === 'moderation_unavailable') {
        logUnavailable(timedOut ? 'timeout' : failureReason, upstreamStatus);
      }
      if (error instanceof ModerationError) throw error;
      throw new ModerationError();
    } finally { clearTimeout(timer); controller.abort(); }
  };
}

// Capture before running the core: its objects may alias the loaded snapshot.
// Values are immutable strings; identities are used locally and never sent.
export function publicTextProjection(snapshot) {
  const projection = Object.create(null);
  const put = (scope, field, value) => {
    if (typeof value === 'string' && value.trim()) projection[JSON.stringify([...scope, field, digest(value)])] = value;
  };
  const visible = item => item && !item.hidden && !item.groupId
    && (!item.visibility || item.visibility === 'public')
    && (!item.audience?.type || item.audience.type === 'public');
  const content = (item, scope) => {
    put(scope, 'text', item.text);
    for (const entry of Array.isArray(item.correctionHistory) ? item.correctionHistory : []) {
      // A previous body moved into public edit history is still the same text.
      put(scope, 'text', entry?.text);
      put(scope, 'reason', entry?.reason);
    }
  };
  const posts = Array.isArray(snapshot?.posts) ? snapshot.posts : [];
  const postById = new Map(posts.filter(post => typeof post?.id === 'string').map(post => [post.id, post]));
  for (const post of posts) {
    if (!visible(post) || typeof post.id !== 'string') continue;
    content(post, ['post', post.id]);
    // A quote republishes source context. Resolve it from public stored content,
    // never from request target labels, reports or private group records.
    const source = postById.get(post.quotePostId);
    if (visible(source) && !source.quotePostId) {
      content(source, ['quote', post.id, source.id]);
      if (typeof post.text === 'string' && typeof source.text === 'string') {
        put(['quote', post.id, source.id], 'context', `${post.text}\n\n${source.text}`);
      }
    }
    const pending = [...(Array.isArray(post.replies) ? post.replies : [])], seen = new Set();
    while (pending.length) {
      const reply = pending.pop();
      if (!visible(reply) || seen.has(reply) || typeof reply.id !== 'string') continue;
      seen.add(reply);
      content(reply, ['reply', post.id, reply.id]);
      if (Array.isArray(reply.replies)) pending.push(...reply.replies);
    }
  }
  for (const [id, profile] of Object.entries(snapshot?.profiles || {})) {
    for (const field of ['displayName', 'handle', 'bio', 'websiteUrl']) put(['profile', id], field, profile?.[field]);
  }
  return Object.freeze(projection);
}

export function changedPublicTexts(before, snapshot) {
  return [...new Set(Object.entries(publicTextProjection(snapshot))
    .filter(([key, value]) => before?.[key] !== value).map(([, value]) => value))];
}
