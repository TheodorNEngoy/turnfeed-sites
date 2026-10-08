import { MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import worker from '../worker/index.mjs';
import { accountKey, chatGPTDisplayName } from '../worker/identity.mjs';
import { readState } from '../worker/storage.mjs';

installModerationFixture();

const secret = 'local-test-only-012345678901234567890123456789';
const self = { targetKind: 'profile', profileScope: 'self' };
async function call(db, { subject = 'alice', fullName, encoding = 'percent-encoded-utf-8',
  name = 'open_turnfeed_feed', args = self, meta } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (subject) headers.set('oai-authenticated-user-id', subject);
  if (fullName !== undefined) {
    headers.set('oai-authenticated-user-full-name', fullName);
    if (encoding) headers.set('oai-authenticated-user-full-name-encoding', encoding);
  }
  const response = await worker.fetch(new Request('https://turnfeed-native.example/mcp', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args, _meta: meta } }),
  }), { DB: db, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret });
  return (await response.json()).result?.structuredContent;
}

test('ChatGPT name initializes an existing generic profile and persists with no later name header', async () => {
  const db = database();
  const before = await call(db);
  assert.match(before.profile.displayName, /^Turnfeed member /);
  assert.match(before.displayText, /What would you like to be called/);
  const named = await call(db, { fullName: encodeURIComponent('Theodor Engøy') });
  assert.equal(named.profile.displayName, 'Theodor Engøy');
  assert.doesNotMatch(named.displayText, /What would you like to be called/);
  assert.equal((await call(db)).profile.displayName, 'Theodor Engøy');
  assert.match((await call(db, { subject: 'bob' })).profile.displayName, /^Turnfeed member /);
});

test('chosen name, explicit empty name and empty no-op remain chosen', async () => {
  const db = database();
  const setName = displayName => call(db, { fullName: 'ChatGPT%20Name', name: 'set_profile',
    args: { displayName, visibility: 'public' } });
  assert.equal((await setName('Chosen name')).saved, true);
  assert.equal((await call(db, { fullName: 'Another%20Name' })).profile.displayName, 'Chosen name');
  assert.equal((await setName('')).saved, true);
  assert.match((await call(db, { fullName: 'Another%20Name' })).profile.displayName, /^Turnfeed member /);
  const empty = database();
  assert.equal((await call(empty, { name: 'set_profile', args: { displayName: '', visibility: 'public' } })).saved, true);
  assert.match((await call(empty, { fullName: 'ChatGPT%20Name' })).profile.displayName, /^Turnfeed member /);
  assert.equal((await readState(empty)).value.profileNameChoices[accountKey('alice', secret)], true);
});

test('profile edits with an omitted name retain the default; a custom handle remains in use', async () => {
  const db = database();
  await call(db, { fullName: 'Alice%20Example' });
  assert.equal((await call(db, { name: 'set_profile', args: { bio: 'A short bio.', visibility: 'public' } })).saved, true);
  assert.equal((await call(db)).profile.displayName, 'Alice Example');
  const handleDb = database();
  await call(handleDb, { name: 'set_profile', args: { handle: 'reader123', visibility: 'public' } });
  assert.equal((await call(handleDb, { fullName: 'ChatGPT%20Name' })).profile.displayName, '@reader123');
});

test('account reset prevents reimport, including across subsequent requests', async () => {
  const db = database();
  await call(db, { fullName: 'Alice%20Example' });
  assert.equal((await call(db, { name: 'reset_me', args: {}, fullName: 'Alice%20Example' })).ok, true);
  const after = await call(db, { fullName: 'Alice%20Example' });
  assert.match(after.profile.displayName, /^Turnfeed member /);
  assert.doesNotMatch(after.displayText, /What would you like to be called/);
});

test('missing, malformed, reserved and model-supplied names are not imported; email stays private', async () => {
  assert.equal(chatGPTDisplayName(new Headers({ 'oai-authenticated-user-full-name': 'Alice%20Example' })), 'Alice%20Example');
  for (const fullName of [undefined, '%FF', 'OpenAI', 'alice%40example.com', 'alice%40%09example.com']) {
    const db = database();
    const response = await call(db, { fullName, meta: { 'oai-authenticated-user-full-name': 'Forged name' } });
    assert.match(response.profile.displayName, /^Turnfeed member /, String(fullName));
  }
  const anonymous = database();
  await call(anonymous, { subject: '', fullName: 'Forged%20Name', name: 'get_feed_digest', args: {} });
  assert.equal((await readState(anonymous)).value, null);
});

test('failed profile writes do not suppress a later valid ChatGPT default', async () => {
  const db = database();
  const rejected = await call(db, { name: 'set_profile', args: { displayName: 'OpenAI', visibility: 'public' } });
  assert.equal(rejected.ok, false);
  assert.equal((await call(db, { fullName: 'Alice%20Example' })).profile.displayName, 'Alice Example');
});

test('concurrent name initialization and explicit choice keep the explicit name', async () => {
  const db = database();
  await Promise.all([
    call(db, { fullName: 'ChatGPT%20Name' }),
    call(db, { name: 'set_profile', args: { displayName: 'My choice', visibility: 'public' } }),
  ]);
  assert.equal((await call(db, { fullName: 'ChatGPT%20Name' })).profile.displayName, 'My choice');
});
