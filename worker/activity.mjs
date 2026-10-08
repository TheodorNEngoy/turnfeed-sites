import { createHmac } from 'node:crypto';
import { accountKey } from './identity.mjs';
import { readState } from './storage.mjs';
import { makeCore } from './mcp.mjs';

const privateHeaders = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' };
const answer = (data, status = 200) => Response.json(data, { status, headers: privateHeaders });

export function activityPayload(actor, secret, events) {
  const opaque = value => createHmac('sha256', secret).update(`web-activity-v1|${actor}|${value}`).digest('hex');
  return { scope: opaque('session'), keys: events.map(event => opaque(`event|${event.id}|${event.createdAt}`)) };
}

// The browser receives opaque event keys only. It never needs names, text,
// database IDs, or another user's unread state to display an activity dot.
export async function activitySummary(request, env) {
  if (request.method !== 'GET') return answer({ error: 'method_not_allowed' }, 405);
  const origin = new URL(request.url).origin;
  if ((request.headers.get('origin') && request.headers.get('origin') !== origin)
      || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))) return answer({ error: 'same_origin_required' }, 403);
  const subject = request.headers.get('oai-authenticated-user-id')?.trim() || '';
  if (!subject || subject.length > 512) return answer({ error: 'sign_in_required' }, 401);
  const secret = env.TURNFEED_SITE_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return answer({ error: 'unavailable' }, 503);
  try {
    const actor = accountKey(subject, secret);
    const loaded = await readState(env.DB);
    if (loaded.value?.operator?.revoked?.[actor]) return answer({ error: 'account_closed' }, 403);
    const core = makeCore({ origin, secret, subject, snapshot: loaded.value?.snapshot, controls: loaded.value?.controls });
    return answer(activityPayload(actor, secret, core.activityEvents(actor)));
  } catch {
    return answer({ error: 'temporarily_unavailable' }, 503);
  }
}

// This function is also exercised with a deterministic browser harness. There
// are no DOM replacements, sounds, push permissions, or background-page polls.
export function startActivityAlerts(win, doc) {
  const badge = doc.getElementById('new-activity');
  const notice = doc.getElementById('new-activity-notice');
  if (!badge || !notice) return;
  const storageKey = 'turnfeed.activity.v1';
  const period = 60_000;
  let saved = null, timer, pending = false, stopped = false, failures = 0, lastAttempt = -Infinity;
  let pageBaseline = null;
  const valid = value => value && /^[a-f0-9]{64}$/.test(value.scope)
    && Array.isArray(value.keys) && value.keys.length <= 20
    && value.keys.every(key => /^[a-f0-9]{64}$/.test(key));
  try { const value = JSON.parse(doc.body.dataset.activityBaseline || 'null'); if (valid(value)) pageBaseline = value; } catch {}
  try {
    const value = JSON.parse(win.sessionStorage.getItem(storageKey));
    if (valid(value)) saved = value;
  } catch { /* Session storage can be unavailable in embedded/private browsers. */ }
  const show = value => { badge.hidden = !value; notice.hidden = !value; };
  const save = () => { try { win.sessionStorage.setItem(storageKey, JSON.stringify(saved)); } catch {} };
  const clear = () => { saved = null; show(false); try { win.sessionStorage.removeItem(storageKey); } catch {} };
  const schedule = delay => {
    win.clearTimeout(timer);
    if (!stopped && doc.visibilityState === 'visible') timer = win.setTimeout(poll, delay);
  };
  async function poll() {
    if (stopped || pending || doc.visibilityState !== 'visible') return;
    const now = Date.now();
    const minimum = failures ? Math.min(period * 2 ** failures, 10 * period) : 15_000;
    if (now - lastAttempt < minimum) { schedule(minimum - (now - lastAttempt)); return; }
    pending = true;
    lastAttempt = now;
    const controller = new win.AbortController();
    const timeout = win.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await win.fetch('/activity/summary', { credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', headers: { accept: 'application/json' }, signal: controller.signal });
      if ([401, 403].includes(response.status)) { clear(); stopped = true; return; }
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      if (!valid(data)) throw new Error('invalid');
      if (!saved || saved.scope !== data.scope) saved = data;
      // The page baseline comes from the exact snapshot used to render the
      // latest Activity page. Creation timestamps can predate commit, so only
      // event identities determine what has appeared since that snapshot.
      if (pageBaseline?.scope === data.scope) saved = pageBaseline;
      pageBaseline = null;
      const hasNew = data.keys.some(key => !saved.keys.includes(key));
      if (!hasNew) saved = data;
      show(hasNew);
      save();
      failures = 0;
    } catch { failures = Math.min(failures + 1, 4); }
    finally {
      win.clearTimeout(timeout);
      pending = false;
      schedule(failures ? Math.min(period * 2 ** failures, 10 * period) : period);
    }
  }
  doc.addEventListener('visibilitychange', () => {
    win.clearTimeout(timer);
    if (doc.visibilityState === 'visible') void poll();
  });
  win.addEventListener('focus', () => { void poll(); });
  win.addEventListener('pagehide', () => { win.clearTimeout(timer); stopped = true; });
  win.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; void poll(); } });
  void poll();
}

export const activityScript = `(${startActivityAlerts.toString()})(window, document);`;
