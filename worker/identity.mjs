import { createHmac } from 'node:crypto';
export const SITES_ISSUER = 'urn:turnfeed:sites:identity:v1';
export function chatGPTDisplayName(headers) {
  const raw = headers.get('oai-authenticated-user-full-name') || '';
  if (!raw || raw.length > 4096) return '';
  try {
    return headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8'
      ? decodeURIComponent(raw) : raw;
  } catch { return ''; }
}
export function accountKey(subject, secret) {
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 512) return '';
  return createHmac('sha256', secret).update('turnfeed-oauth-user-v1|').update(SITES_ISSUER)
    .update('|').update(subject.trim()).digest('hex').slice(0, 40);
}
export function operatorIdentity(request, env) {
  if (typeof env.TURNFEED_SITE_SECRET !== 'string' || env.TURNFEED_SITE_SECRET.length < 32) return '';
  const key = accountKey(request.headers.get('oai-authenticated-user-id'), env.TURNFEED_SITE_SECRET);
  const allowed = String(env.TURNFEED_OPERATOR_ACCOUNT_KEYS || '').split(',').map(v => v.trim()).filter(v => /^[a-f0-9]{40}$/.test(v));
  return key && allowed.includes(key) ? key : '';
}
