import assert from 'node:assert/strict';
import { beforeEach } from 'node:test';
import { createModerator } from '../worker/moderation.mjs';
import { invoke as invokeCore } from '../worker/mcp.mjs';

export const MODERATION_KEY = 'test-only-moderation-key-never-a-real-credential';
export const MODERATION_ENDPOINT = 'https://api.openai.com/v1/moderations';
const categories = ['harassment', 'harassment/threatening', 'hate', 'hate/threatening',
  'illicit', 'illicit/violent', 'self-harm', 'self-harm/intent', 'self-harm/instructions',
  'sexual', 'sexual/minors', 'violence', 'violence/graphic'];

// Exercise the real moderator and its response validation without contacting a service.
// Download fixtures can delegate only this exact endpoint and keep their own allowlist.
export async function allowModerationFetch(url, options) {
  assert.equal(url, MODERATION_ENDPOINT, 'Unexpected network request in test');
  assert.equal(options?.method, 'POST');
  assert.equal(options?.redirect, 'manual');
  assert.equal(Object.hasOwn(options,'credentials'), false);
  assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${MODERATION_KEY}`);
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'omni-moderation-latest');
  assert.ok(Array.isArray(body.input) && body.input.length > 0);
  const count = body.input.every(value => typeof value === 'string') ? body.input.length : 1;
  return Response.json({ id: 'moderation-test-response', model: body.model,
    results: Array.from({ length: count }, () => ({ flagged: false,
      categories: Object.fromEntries(categories.map(name => [name, false])) })) });
}

export function installModerationFixture() {
  beforeEach(t => { t.mock.method(globalThis, 'fetch', allowModerationFetch); });
}

export function invoke(options) {
  return invokeCore({ moderate: createModerator(MODERATION_KEY, { fetcher: allowModerationFetch }), ...options });
}
