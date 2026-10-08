import { Buffer } from 'node:buffer';
import { logoBase64 } from './brand.generated.mjs';
import { servePhoto } from './photo-access.mjs';
import { dispatchMcp, invoke } from './mcp.mjs';
import { StorageError } from './storage.mjs';
import { handleOperator } from './operator.mjs';
import { handleWeb, isWebRoute, webFailure } from './web.mjs';
import { activitySummary, activityScript } from './activity.mjs';
import { composerScript } from './composer.mjs';
import { mediaScript } from './media.mjs';
import { feedScript } from './feed-client.mjs';

const MAX_BODY = 65_536;
let activeRequests = 0;
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
const json = (data, status = 200) => Response.json(data, { status, headers });
const rpcError = (id, code, message, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status);

async function bodyText(request, limit = MAX_BODY) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request');
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel(); throw new StorageError('request_too_large'); }
    chunks.push(value);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

function page(signedIn, path) {
  const content = path === '/privacy'
    ? `<h1>Privacy on Turnfeed</h1><p>Before new or changed text is published, Turnfeed sends that text to OpenAI’s Moderation API for automated safety screening. Selected photos are checked after embedded metadata is removed and before upload to Turnfeed’s file storage. Only submitted content is sent; private ChatGPT conversations, account credentials and private Turnfeed settings are not included. OpenAI processes these requests under its API data policies. Automated checks can make mistakes: contact support@turnfeedapp.com to ask about a blocked submission. Reporting and human moderation remain available.</p><p>Posts and replies may include links to other websites. YouTube and Vimeo players load only after you choose to load a video. Loading a player connects your browser to that provider, which receives connection information such as your IP address and this Site’s origin and may use cookies under its own policies. You can close the player at any time. Turnfeed does not fetch external thumbnails or link metadata.</p><p>Turnfeed runs on ChatGPT Sites. Sites provides the server, ChatGPT sign-in and a D1 database. Turnfeed derives an internal account identifier from the authenticated Site user ID. When ChatGPT supplies your name, Turnfeed uses it as your initial public display name. You can change or clear that name in your profile or through chat. Your email is never used as your public name. If ChatGPT does not supply a usable name, Turnfeed asks what you would like to be called when you open your profile.</p><p>The database stores the profile you choose, posts, replies, relationships, preferences, reports, moderation history, action receipts and temporary rate-limit and confirmation records. Tool arguments needed to handle your request reach the server. Turnfeed does not publish or reconstruct your private ChatGPT conversation.</p><p>This Turnfeed website is public. Public-account posts, replies and profiles can be read by other visitors. In My profile → Privacy and followers, you can make your account private, approve or decline follow requests, and remove followers. Private mode covers existing and new posts, replies, attached photos, your bio and profile picture. Your name and handle remain public. Existing followers keep access when you switch to private; new followers need approval. Replies also require access to the parent conversation. Quoting a private account’s post is disabled. Changing to public makes your content visible to everyone and clears pending requests. Removing a follower or blocking them revokes future private-content access, but cannot remove copies they already saved. Moderators can still access retained report evidence. Sign in with ChatGPT to post, reply or manage your account. The website and its native plugin use the same data and account identity. Access to the native plugin in chat is managed separately from access to this website. This preview has a separate database from the existing Turnfeed service at turnfeedapp.com. You can publish posts and replies, update your profile, read your private Activity, and manage muted or blocked people on the website. You can report content for moderation and delete your own posts or replies after reviewing the confirmation page. Deleting a post or reply also deletes its replies. While a signed-in page is visible, Turnfeed checks for new activity about once a minute. Its indicator uses opaque event keys in this browser tab’s session storage, clears when you open the latest Activity page, and is not a cross-device unread count. These checks do not send push or email notifications. Browser forms use temporary signed tokens to protect your actions; these expire after 30 minutes. Reset removes ordinary profile and activity data; some moderation evidence and safety records may remain. Account erasure removes ordinary app data and closes access to this Turnfeed account, including existing connections. Minimal closure records and moderation evidence are retained. It does not delete your ChatGPT account. Ask in chat to export your Turnfeed data. Closing your Turnfeed account in chat is temporarily unavailable. For account closure, contact support@turnfeedapp.com. Reset does not close your account. Selected JPEG and PNG photos are stored separately in file storage. Embedded image metadata is removed; original filenames and temporary chat download URLs are not saved. Photo access follows the current visibility of its post or profile, including account privacy and approved-follower access. Profile pictures are chosen explicitly in My profile; they are not imported from ChatGPT. Replacing or removing a profile picture removes ordinary access to the old picture. Deletion or reset removes ordinary attached photo files; reported photos may be retained as restricted moderation evidence. Failed or uncertain uploads stay private and may require cleanup. Exports include your profile and settings, relationships, authored content with readable conversation context, and report receipts; they exclude internal safety and operational records and complete notification or like history. Contact support@turnfeedapp.com for other privacy requests.</p>`
    : path === '/support'
      ? `<h1>Support</h1><p>Turnfeed is operated by Theodor N. Engøy in Norway.</p><p>For help, privacy requests or a security concern, email <a href="mailto:support@turnfeedapp.com">support@turnfeedapp.com</a>. Describe the action and approximate time; do not include passwords or private conversation content.</p><p>This public preview lets you read the feed and sign in with ChatGPT to post and reply. Activity and people controls are available after sign-in. Use Add photo in the website’s post composer to attach one JPEG or PNG. Posting photos on the website needs no plugin. In My profile, you can upload, replace or remove a profile picture using the same photo limits and screening. Profile pictures follow account privacy: public accounts show them publicly; private accounts show them only to approved followers. To report a profile picture, email support with its image link; do not download or forward the image. With JavaScript enabled, select a JPEG or PNG up to 8 MiB and 32 megapixels. The browser prepares post photos at up to 2048 pixels and profile pictures at up to 512 pixels, without enlarging small images. Review the prepared preview before publishing. Stored uploads remain limited to 1 MiB and 4096 pixels per side, with a 16-megapixel limit. Photo storage is capped at 20 MiB per account and 100 MiB for this preview, with 10 new uploads per account per day. Photos and text from both public and private accounts receive automated safety screening before publication. If screening is unavailable, the submission stays unpublished. You can report a post or reply from its content options; for urgent child-safety concerns contact support@turnfeedapp.com with the post link, without downloading or forwarding the image. Never upload exploitative or illegal imagery. Video files are not uploaded; YouTube and Vimeo links can be played after a viewer chooses to load them. The existing Turnfeed service remains at <a href="https://turnfeedapp.com">turnfeedapp.com</a>.</p>`
      : `<div class="eyebrow">TURNFEED · PRIVATE PREVIEW</div><h1>A shared feed.<br>Inside your conversation.</h1><p class="lead">Read, post and reply in ChatGPT. Your words, your profile, your choice to publish.</p><div class="status"><span class="dot"></span>Private candidate · ${signedIn ? 'Signed in with ChatGPT' : 'ChatGPT sign-in available'}</div><section><h2>Open it in ChatGPT</h2><p>Connect this private Turnfeed preview from your personal plugins, then say <strong>“Open Turnfeed.”</strong> The feed appears directly in your conversation.</p><p>Posts, replies, quotes, profiles, likes, follows, blocks, reports and inbox tools use the retained Turnfeed core. This candidate uses fresh data.</p>${signedIn ? '<a class="button secondary" href="/signout-with-chatgpt?return_to=%2F" target="_top">Sign out</a>' : '<a class="button" href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a>'}</section><section><h2>What is being verified</h2><p>Sites hosting, database persistence, account isolation and native tool approvals. Selected JPEG and PNG chat photos are supported with size and storage limits. Video-file uploads and real-time Events delivery are currently unavailable.</p><p>A connected plugin and passing checks are required before this replaces the current Turnfeed service.</p></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Turnfeed</title><style>*{box-sizing:border-box}body{margin:0;background:#f6f4ed;color:#182b2d;font:17px/1.65 system-ui,sans-serif}main{max-width:850px;margin:auto;padding:72px 30px}.eyebrow{font-size:12px;letter-spacing:.16em;font-weight:750;color:#477476}h1{font-size:clamp(40px,7vw,70px);line-height:1.05;letter-spacing:-.045em;margin:24px 0}h2{font-size:23px;letter-spacing:-.025em}.lead{font-size:22px;max-width:570px;color:#506164}.status{font-size:13px;margin:28px 0 40px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#477476;margin-right:8px}section{border-top:1px solid #cdd6cc;padding:18px 0 24px}p{max-width:680px}a{color:#245e61;text-underline-offset:4px}.button{display:inline-block;background:#1d5053;color:#fff;border-radius:999px;padding:12px 22px;text-decoration:none;font-size:15px}.secondary{background:#e4eae1;color:#1d5053}footer{font-size:13px;border-top:1px solid #cdd6cc;padding-top:22px;display:flex;flex-wrap:wrap;gap:22px}</style></head><body><main>${content}<footer><a href="/">Turnfeed</a><a href="/privacy">Privacy</a><a href="/support">Support</a><a href="https://turnfeedapp.com">Turnfeed</a><a href="https://github.com/TheodorNEngoy/chatgpt-social-mvp">Turnfeed core source</a></footer></main></body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (['/assets/activity.js', '/assets/composer.js', '/assets/media.js', '/assets/feed.js'].includes(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
      const script = url.pathname === '/assets/activity.js' ? activityScript : url.pathname === '/assets/media.js' ? mediaScript : url.pathname === '/assets/feed.js' ? feedScript : composerScript;
      return new Response(request.method === 'HEAD' ? null : script, { headers: {
        'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
      } });
    }
    if (url.pathname.startsWith('/photos/')) {
      if (activeRequests >= 2) return new Response(null,{status:503});
      activeRequests++;
      try { return await servePhoto(request,env,invoke); }
      catch { return new Response(null,{status:503,headers:{'cache-control':'no-store'}}); }
      finally { activeRequests--; }
    }
    if (url.pathname === '/activity/summary') {
      if (activeRequests >= 2) return json({error:'server_busy'},503);
      activeRequests++;
      try { return await activitySummary(request, env); }
      finally { activeRequests--; }
    }
    if (url.pathname === '/turnfeed-logo.png' && ['GET', 'HEAD'].includes(request.method)) {
      return new Response(request.method === 'HEAD' ? null : Buffer.from(logoBase64, 'base64'), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
    }
    if (url.pathname === '/health') return json({ ok: Boolean(env.DB && env.TURNFEED_SITE_SECRET?.length >= 32), candidate: true, moderationConfigured: Boolean(env.OPENAI_API_KEY) });
    if (request.method === 'GET' && ['/privacy', '/support'].includes(url.pathname)) {
      return new Response(page(Boolean(request.headers.get('oai-authenticated-user-id')), url.pathname), { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
    }
    if (isWebRoute(url.pathname)) {
      if (activeRequests >= 2) return webFailure(new Error('server_busy'), Boolean(request.headers.get('oai-authenticated-user-id')));
      activeRequests++;
      try { return await handleWeb(request, env, bodyText); }
      finally { activeRequests--; }
    }
    if (url.pathname === '/operator' || url.pathname.startsWith('/operator/')) {
      if (activeRequests >= 2) return json({ok:false,code:'server_busy'},503);
      activeRequests++;
      try { return await handleOperator(request, env, bodyText); }
      catch(error) {
        const code = error instanceof StorageError ? error.code : 'operator_request_failed';
        console.error(JSON.stringify({event:'turnfeed_operator_failed',code}));
        return json({ok:false,code,message:code === 'storage_outcome_unknown'
          ? 'Storage confirmation was lost. Inspect the operation history before retrying.'
          : 'The operation could not be completed. Review a fresh preview before retrying.'},503);
      } finally { activeRequests--; }
    }
    if (url.pathname !== '/mcp') return json({ error: 'not_found' }, 404);
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return rpcError(null, -32001, 'Origin rejected.', 403);
    if (request.headers.get('sec-fetch-site') === 'cross-site') return rpcError(null, -32001, 'Cross-site requests are unavailable.', 403);
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return rpcError(null, -32600, 'Use application/json.', 415);
    if (activeRequests >= 2) return rpcError(null, -32000, 'Turnfeed is busy. Try again shortly.', 503);
    activeRequests++;
    let id = null;
    try {
      let body;
      try { body = JSON.parse(await bodyText(request)); }
      catch (error) { return rpcError(null, -32700, error.code === 'request_too_large' ? 'Request too large.' : 'Invalid JSON.', error.code === 'request_too_large' ? 413 : 400); }
      if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(null, -32600, 'Invalid request.', 400);
      if (body.method === 'notifications/initialized' && !Object.hasOwn(body, 'id')) return new Response(null, { status: 202, headers });
      if (!Object.hasOwn(body, 'id') || !['string', 'number'].includes(typeof body.id) || String(body.id).length > 200) return rpcError(null, -32600, 'A request ID is required.', 400);
      id = body.id;
      const response = await dispatchMcp(request, env, body);
      return json({ jsonrpc: '2.0', id, ...(response.error ? { error: response.error } : { result: response.result }) }, response.status || 200);
    } catch (error) {
      const code = error instanceof StorageError ? error.code : 'internal_error';
      console.error(JSON.stringify({ event: 'turnfeed_request_failed', code }));
      const message = code === 'storage_outcome_unknown'
        ? 'Storage confirmation was lost. This action may have completed. Read the current state before deciding whether to retry.'
        : code === 'candidate_capacity_reached'
          ? 'This private candidate has reached its storage safety limit. No changes were saved.'
          : 'Turnfeed could not complete this request. Please try again shortly.';
      return rpcError(id, -32603, message, 503);
    } finally { activeRequests--; }
  },
};
