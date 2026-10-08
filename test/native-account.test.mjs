import { invoke, MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { database } from './sqlite-d1.mjs';
import { makeCore, dispatchMcp, catalog } from '../worker/mcp.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import { accountKey } from '../worker/identity.mjs';
import { invokeNativeAccount } from '../worker/native-account.mjs';
import worker from '../worker/index.mjs';

installModerationFixture();

const origin = 'https://native.example';
const secret = 'local-account-test-012345678901234567890123456789';
const key = subject => accountKey(subject, secret);
async function call(db, subject, name, args = {}) {
  const response = await invoke({ db, origin, secret, subject, name, args, callerKey: subject, displayName: 'Imported name' });
  if (response.result) {
    const parsed = makeCore({ origin, secret }).tools.get(name).descriptor.outputSchema.safeParse(response.result.structuredContent);
    assert.equal(parsed.success, true, `${name}: ${parsed.error}`);
  }
  return response.result?.structuredContent || response;
}
async function setup() {
  const db = database();
  for (const subject of ['alice', 'bob']) {
    assert.equal((await call(db, subject, 'set_profile', { displayName: subject === 'alice' ? 'Alicia' : 'Bobby', handle: subject, visibility: 'public' })).ok, true);
    await call(db, subject, 'update_my_settings', { addHiddenWords: [subject + '-private-word'] });
  }
  assert.equal((await call(db, 'alice', 'create_post', { text: 'What is a practical recipe you would happily cook twice?', visibility: 'public', clientId: 'own-account-post' })).published, true);
  return db;
}
test('account export is private, excludes auth and admin data, and rejects alternate identities', async () => {
  const db = await setup();
  const before = await readState(db);
  const exported = await call(db, 'alice', 'export_my_data');
  assert.equal(exported.ok, true);
  assert.equal(exported.exportPage.hasMore, false);
  const document = JSON.parse(exported.exportPage.jsonChunk);
  assert.deepEqual(document.account.profile.hiddenWords, ['alice-private-word']);
  assert.equal(document.account.posts.length, 1);
  for (const text of ['bob-private-word', key('bob'), 'targetRef', 'viewerToken', 'publicWriteConfirmationClaims', 'supportsAttachmentDisposition', 'supportsHead']) {
    assert.ok(!exported.exportPage.jsonChunk.includes(text), text);
  }
  assert.equal(createHash('sha256').update(exported.exportPage.jsonChunk).digest('hex'), exported.exportPage.sha256);
  assert.equal((await readState(db)).revision, before.revision);
  assert.equal((await call(db, 'alice', 'export_my_data', { userId: key('bob') })).rpcError.code, -32602);
  for (const name of ['export_my_data']) {
    const args = {};
    assert.equal((await call(db, '', name, args)).code, 'chatgpt_sign_in_required');
    const result = await dispatchMcp(new Request(origin + '/mcp'), { DB: db, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret }, { method: 'tools/call', params: { name, arguments: args } });
    assert.equal(result.status, 401);
    const descriptor = catalog(makeCore({ origin, secret })).find(tool => tool.name === name);
    assert.deepEqual(descriptor.securitySchemes, [{ type: 'oauth2', scopes: [] }]);
  }
});

test('exports page without corrupting Unicode, bind cursors to owner and revision, and reconstruct exactly', async () => {
  const db = await setup();
  let saved = await readState(db);
  const template = saved.value.snapshot.posts[0];
  template.replies = [{ id: 'recent-export-reply', authorId: key('bob'), text: 'A useful recipe suggestion.',
    createdAt: new Date(Date.now() - 29.5 * 60000).toISOString(), likes: 0, likedBy: [], replies: [] }];
  for (let i = 1; i <= 35; i++) saved.value.snapshot.posts.push({ ...structuredClone(template), id: 'export-fixture-' + i,
    text: `${i}: A reader’s note 📚 ${'å'.repeat(300)}`, replies: [] });
  assert.equal(await commitState(db, saved.revision, saved.value), true);
  let result = await call(db, 'alice', 'export_my_data');
  const first = result.exportPage;
  assert.equal(first.hasMore, true);
  assert.equal((await call(db, 'bob', 'export_my_data', { cursor: first.nextCursor })).code, 'export_restart_required');
  const chunks = [];
  let position = 0, calls = 0;
  const originalNow = Date.now, later = originalNow() + 60000;
  Date.now = () => later; // A reply crosses the feed activity window between pages.
  try {
  while (true) {
    const page = result.exportPage;
    assert.equal(page.start, position);
    assert.ok(page.jsonChunk.length <= 8192);
    assert.equal(Buffer.from(page.jsonChunk).toString(), page.jsonChunk);
    assert.equal(page.sha256, first.sha256);
    chunks.push(page.jsonChunk); position = page.end;
    if (!page.hasMore) break;
    assert.ok(++calls < 100);
    result = await call(db, 'alice', 'export_my_data', { cursor: page.nextCursor });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  } finally { Date.now = originalNow; }
  const text = chunks.join('');
  assert.equal(text.length, first.totalCharacters);
  assert.equal(createHash('sha256').update(text).digest('hex'), first.sha256);
  assert.equal(JSON.parse(text).account.posts.length, 36);
  assert.ok(JSON.parse(text).account.posts.every(post => !Object.hasOwn(post, 'signalLabel')));
  await call(db, 'bob', 'update_my_settings', { addHiddenWords: ['changed'] });
  assert.equal((await call(db, 'alice', 'export_my_data', { cursor: first.nextCursor })).code, 'export_restart_required');
});

test('export does not save a profile or mutate empty or legacy storage', async () => {
  const db = database();
  const before = await readState(db);
  const exported = await call(db, 'alice', 'export_my_data');
  assert.equal(exported.ok, true);
  assert.equal(JSON.parse(exported.exportPage.jsonChunk).account.posts.length, 0);
  assert.equal((await readState(db)).revision, before.revision);
  assert.equal((await readState(db)).value, null);
  assert.equal(db.batchCount, 0);
  const value = { format: 1, snapshot: makeCore({ origin, secret }).snapshot(), controls: makeCore({ origin, secret }).controls() };
  const json = JSON.stringify(value), digest = createHash('sha256').update(json).digest('hex');
  db.sql.prepare('UPDATE turnfeed_state_head SET revision=?, digest=?, chunks=1, bytes=?, storage_format=1 WHERE id=1').run('legacy-export', digest, Buffer.byteLength(json));
  db.sql.prepare('INSERT INTO turnfeed_state_chunks (revision,position,value) VALUES (?,0,?)').run('legacy-export', json);
  assert.equal((await call(db, 'alice', 'export_my_data')).ok, true);
  const after = await readState(db);
  assert.equal(after.storageFormat, 1);
  assert.equal(after.revision, 'legacy-export');
});

test('closure is absent from discovery and instructions direct requests to support', async () => {
  const tools = catalog(makeCore({ origin, secret }));
  assert.ok(tools.some(tool => tool.name === 'get_profile_connections'));
  assert.ok(tools.some(tool => tool.name === 'export_my_data'));
  for (const name of ['preview_my_account_closure', 'close_my_account']) {
    assert.ok(!tools.some(tool => tool.name === name));
  }
  const initialized = await dispatchMcp(new Request(origin + '/mcp'), { OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret }, { method: 'initialize' });
  assert.match(initialized.result.instructions, /Closing a Turnfeed account in chat is temporarily unavailable/);
  assert.match(initialized.result.instructions, /Never substitute reset_me for account closure/);
  const privacy = await worker.fetch(new Request(origin + '/privacy'), {});
  const html = await privacy.text();
  assert.match(html, /Closing your Turnfeed account in chat is temporarily unavailable/);
  assert.doesNotMatch(html, /requires your later confirmation/);
});

test('cached closure calls fail before storage and argument processing at every dispatcher', async () => {
  // The guard must run even before inspecting a valid-looking old plan or any
  // claimed human confirmation. Storage and arguments deliberately cannot be read.
  const inaccessible = new Proxy({}, { get() { assert.fail('disabled closure accessed state or arguments'); } });
  for (const name of ['preview_my_account_closure', 'close_my_account']) {
    for (const run of [invoke, invokeNativeAccount]) {
      const output = await run({ db: inaccessible, loaded: inaccessible, core: inaccessible,
        origin, secret, subject: 'alice', name, args: inaccessible });
      assert.equal(output.result.isError, true);
      assert.equal(output.result.structuredContent.code, 'account_closure_unavailable');
      assert.equal(output.result.structuredContent.preview, undefined);
      assert.equal(output.result.structuredContent.closure, undefined);
    }
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name,
      arguments: { planToken: 'previously-cached-plan', confirmation: 'previously-cached-confirmation' } } };
    const request = who => new Request(origin + '/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', ...(who ? { 'oai-authenticated-user-id': who } : {}) }, body: JSON.stringify(body) });
    const env = { DB: inaccessible, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret };
    const output = await worker.fetch(request('alice'), env);
    assert.equal(output.status, 200);
    assert.equal((await output.json()).result.structuredContent.code, 'account_closure_unavailable');
    assert.equal((await worker.fetch(request(''), env)).status, 401);
  }
});

test('disabled closure preserves existing data and never reports success for revoked accounts', async () => {
  const db = await setup();
  let saved = await readState(db);
  saved.value.operator = { revoked: { [key('revoked')]: { at: new Date().toISOString() } }, erasures: [] };
  assert.equal(await commitState(db, saved.revision, saved.value), true);
  const before = await readState(db), batches = db.batchCount, reads = db.reads.length;
  for (const subject of ['alice', 'bob', 'revoked']) {
    for (const name of ['preview_my_account_closure', 'close_my_account']) {
      const output = await invoke({ db, origin, secret, subject, name, args: {} });
      assert.equal(output.result.isError, true);
      assert.equal(output.result.structuredContent.code, 'account_closure_unavailable');
    }
  }
  assert.equal(db.batchCount, batches);
  assert.equal(db.reads.length, reads);
  assert.deepEqual(await readState(db), before);
  assert.equal((await call(db, 'revoked', 'export_my_data')).status, 403);
  assert.equal((await call(db, 'alice', 'export_my_data')).ok, true);
});
