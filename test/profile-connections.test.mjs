import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, trustedContext, dispatchMcp, catalog } from '../worker/mcp.mjs';
import { accountKey } from '../worker/identity.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import { database } from './sqlite-d1.mjs';

const origin = 'https://connections.example';
const secret = 'profile-connections-tests-012345678901234567890123456789';
const ids = Object.fromEntries(['alice', 'bob', 'carol', 'dave', 'eve', 'viewer', 'ghost'].map(name => [name, accountKey(name, secret)]));
function fixture(change = () => {}) {
  const snapshot = makeCore({ origin, secret }).snapshot();
  snapshot.profiles = Object.fromEntries(Object.entries(ids).filter(([name]) => name !== 'ghost').map(([name, id]) => [id, {
    displayName: name.toUpperCase(), handle: name, bio: 'Private biography should never enter a connection row.',
    avatarUrl: `${origin}/photos/${name}.png`, hiddenWords: ['private-setting'],
  }]));
  snapshot.follows = { [ids.alice]: [ids.bob, ids.carol], [ids.bob]: [ids.alice], [ids.dave]: [ids.alice] };
  change(snapshot);
  return snapshot;
}
async function read(snapshot, subject = 'viewer', args = {}, options = {}) {
  const core = makeCore({ origin, secret, snapshot, ...options });
  const tool = core.tools.get('get_profile_connections');
  const input = { profileHandle: 'alice', kind: 'followers', ...args };
  if (args.targetRef) delete input.profileHandle;
  const parsed = tool.descriptor.inputSchema.safeParse(input);
  assert.equal(parsed.success, true, parsed.error?.message);
  const before = JSON.stringify({ ...core.snapshot(), updatedAt: null }), controls = core.controls();
  const response = await tool.handler(parsed.data, trustedContext(subject));
  const output = response.structuredContent;
  assert.equal(tool.descriptor.outputSchema.safeParse(output).success, true, JSON.stringify(output));
  assert.equal(JSON.stringify({ ...core.snapshot(), updatedAt: null }), before);
  assert.deepEqual(core.controls(), controls);
  const serialized = JSON.stringify(output);
  for (const id of Object.values(ids)) assert.ok(!serialized.includes(id), 'Internal identity escaped');
  for (const field of ['private-setting', 'Private biography', 'followRequests', 'requestId', 'mutedUserIds']) assert.ok(!serialized.includes(field), field);
  return output;
}
const handles = output => output.items.map(item => item.publicHandle).sort();

test('public incoming and outgoing lists use bounded public person projections', async () => {
  const snapshot = fixture();
  const followers = await read(snapshot);
  assert.equal(followers.ok, true);
  assert.deepEqual(handles(followers), ['bob', 'dave']);
  assert.equal(followers.profile.publicHandle, 'alice');
  assert.match(followers.profile.targetRef, /^tfr_/);
  assert.equal(followers.hasMore, false);
  for (const item of followers.items) {
    assert.deepEqual(Object.keys(item).sort(), ['avatarUrl', 'displayName', 'publicHandle', 'targetRef']);
    assert.match(item.targetRef, /^tfr_/);
  }
  assert.deepEqual(handles(await read(snapshot, 'viewer', { kind: 'following' })), ['bob', 'carol']);
  const anonymous = await read(snapshot, '');
  assert.deepEqual(handles(anonymous), ['bob', 'dave']);
  assert.equal(Object.hasOwn(anonymous.profile, 'targetRef'), false);
  assert.ok(anonymous.items.every(item => !Object.hasOwn(item, 'targetRef')));
});

test('references are bound to the actual viewer and generated handles stay private', async () => {
  const snapshot = fixture(value => { value.profiles[ids.bob].handle = 'tf_generated'; });
  const page = await read(snapshot);
  const bob = page.items.find(item => item.displayName === 'BOB');
  assert.equal(bob.publicHandle, '');
  assert.equal((await read(snapshot, 'viewer', { targetRef: bob.targetRef })).ok, true);
  assert.equal((await read(snapshot, 'eve', { targetRef: bob.targetRef })).code, 'profile_unavailable');
  assert.equal((await read(snapshot, 'viewer', { profileHandle: 'tf_generated' })).code, 'profile_unavailable');
});

test('private list owners allow only themselves, including when another viewer is approved', async () => {
  const snapshot = fixture(value => {
    value.profiles[ids.alice].privateAccount = true;
    value.follows[ids.viewer] = [ids.alice];
  });
  for (const viewer of ['', 'viewer', 'eve']) {
    const result = await read(snapshot, viewer);
    assert.equal(result.code, 'profile_unavailable');
    assert.deepEqual(result.items, []);
    assert.equal(result.profile, undefined);
  }
  const own = await read(snapshot, 'alice');
  assert.equal(own.ok, true);
  assert.equal(own.profile.privateAccount, true);
  assert.equal(own.profile.viewerIsSelf, true);
});

test('each private person and avatar require the actual viewer’s access', async () => {
  const snapshot = fixture(value => {
    value.profiles[ids.bob].privateAccount = true;
    value.follows[ids.alice].push(ids.bob);
  });
  assert.deepEqual(handles(await read(snapshot, '')), ['dave']);
  assert.deepEqual(handles(await read(snapshot)), ['dave']);
  assert.deepEqual(handles(await read(snapshot, 'viewer', { kind: 'following' })), ['carol']);
  snapshot.follows[ids.viewer] = [ids.bob];
  const approved = await read(snapshot);
  assert.deepEqual(handles(approved), ['bob', 'dave']);
  assert.equal(approved.items.find(item => item.publicHandle === 'bob').avatarUrl, `${origin}/photos/bob.png`);
});

test('blocks in both directions hide owner lists and member rows', async () => {
  for (const [blocker, blocked] of [['alice', 'viewer'], ['viewer', 'alice']]) {
    const snapshot = fixture(value => { value.blocks[ids[blocker]] = [ids[blocked]]; });
    assert.equal((await read(snapshot)).code, 'profile_unavailable');
  }
  for (const [blocker, blocked] of [['alice', 'bob'], ['bob', 'alice'], ['viewer', 'bob'], ['bob', 'viewer']]) {
    const snapshot = fixture(value => { value.blocks[ids[blocker]] = [ids[blocked]]; });
    assert.deepEqual(handles(await read(snapshot)), ['dave']);
    assert.deepEqual(handles(await read(snapshot, 'viewer', { kind: 'following' })), ['carol']);
  }
});

test('pending requests, duplicate edges, self edges and missing or revoked people never appear', async () => {
  const snapshot = fixture(value => {
    value.profiles[ids.alice].followRequests = [{ userId: ids.eve, requestId: '1'.repeat(32) }];
    value.profiles[ids.eve].followRequests = [{ userId: ids.alice, requestId: '2'.repeat(32) }];
    value.follows[ids.alice] = [ids.alice, ids.bob, ids.bob, ids.carol, ids.ghost];
    value.follows[ids.ghost] = [ids.alice];
  });
  assert.deepEqual(handles(await read(snapshot)), ['bob', 'dave']);
  assert.deepEqual(handles(await read(snapshot, 'viewer', { kind: 'following' })), ['bob', 'carol']);
  assert.deepEqual(handles(await read(snapshot, 'viewer', {}, { unavailableUserIds: [ids.bob] })), ['dave']);
  const ownerRef = (await read(snapshot)).profile.targetRef;
  delete snapshot.profiles[ids.alice];
  assert.equal((await read(snapshot, 'viewer', { targetRef: ownerRef })).code, 'profile_unavailable');
  assert.equal((await read(fixture(), 'viewer', {}, { unavailableUserIds: [ids.alice] })).code, 'profile_unavailable');
});

test('pagination is stable and binds viewer, owner, kind, limit and visible list version', async () => {
  const snapshot = fixture(value => { value.follows[ids.eve] = [ids.alice]; });
  const first = await read(snapshot, 'viewer', { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  const second = await read(snapshot, 'viewer', { limit: 1, cursor: first.nextCursor });
  const third = await read(snapshot, 'viewer', { limit: 1, cursor: second.nextCursor });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.publicHandle).sort(), ['bob', 'dave', 'eve']);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, undefined);
  for (const [viewer, extra] of [['eve', {}], ['', {}], ['viewer', { kind: 'following' }], ['viewer', { profileHandle: 'bob' }], ['viewer', { limit: 2 }], ['viewer', { cursor: first.nextCursor + 'a' }]]) {
    const rejected = await read(snapshot, viewer, { limit: 1, cursor: first.nextCursor, ...extra });
    assert.equal(rejected.cursorResetRequired, true);
    assert.deepEqual(rejected.items, []);
    assert.equal(rejected.profile, undefined);
  }
  for (const change of [
    value => { value.follows[ids.dave] = []; },
    value => { value.profiles[ids.bob].privateAccount = true; },
    value => { value.blocks[ids.viewer] = [ids.eve]; },
    value => { value.profiles[ids.eve].displayName = 'Updated public name'; },
  ]) {
    const changed = structuredClone(snapshot); change(changed);
    assert.equal((await read(changed, 'viewer', { limit: 1, cursor: first.nextCursor })).cursorResetRequired, true);
  }
});

test('default and maximum page sizes are enforced without losing people', async () => {
  const snapshot = fixture(value => {
    value.follows = {};
    for (let i = 0; i < 55; i++) {
      const id = accountKey(`person-${i}`, secret);
      value.profiles[id] = { handle: `person${i}`, displayName: `Person ${i}` };
      value.follows[id] = [ids.alice];
    }
  });
  assert.equal((await read(snapshot)).items.length, 20);
  const first = await read(snapshot, '', { limit: 50 });
  assert.equal(first.items.length, 50);
  const second = await read(snapshot, '', { limit: 50, cursor: first.nextCursor });
  assert.equal(second.items.length, 5);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.publicHandle)).size, 55);
});

test('dispatch supports anonymous handles, validates targets and cannot import names or write state', async () => {
  const db = database(), loaded = await readState(db);
  const value = { format: 1, snapshot: fixture(), controls: {}, profileNameChoices: {}, operator: { revoked: { [ids.carol]: true } } };
  assert.equal(await commitState(db, loaded.revision, value, { remaining: 45 }, loaded), true);
  const before = await readState(db), writes = db.executed.length, batches = db.batchCount;
  async function call(subject, args) {
    return dispatchMcp(new Request(origin + '/mcp', { headers: {
      ...(subject ? { 'oai-authenticated-user-id': subject } : {}), 'oai-authenticated-user-full-name': 'A new profile name',
    } }), { DB: db, TURNFEED_SITE_SECRET: secret }, { method: 'tools/call', params: { name: 'get_profile_connections', arguments: args } });
  }
  const args = { profileHandle: 'alice', kind: 'following' };
  const anonymous = await call('', args);
  assert.equal(anonymous.result.structuredContent.ok, true);
  assert.deepEqual(handles(anonymous.result.structuredContent), ['bob']);
  assert.equal((await call('new-reader', args)).result.structuredContent.ok, true);
  const targetRef = (await call('viewer', args)).result.structuredContent.profile.targetRef;
  assert.equal((await call('', { targetRef, kind: 'followers' })).status, 401);
  for (const invalid of [{ kind: 'followers' }, { ...args, targetRef }, { ...args, limit: 51 }, { ...args, limit: 0 }, { ...args, limit: 1.5 }, { ...args, userId: ids.alice }, { ...args, profileHandle: '' }]) {
    assert.equal((await call('viewer', invalid)).error.code, -32602);
  }
  const after = await readState(db);
  assert.deepEqual(after.value, before.value);
  assert.equal(after.revision, before.revision);
  assert.equal(db.executed.length, writes);
  assert.equal(db.batchCount, batches);
  const descriptor = catalog(makeCore({ origin, secret })).find(tool => tool.name === 'get_profile_connections');
  assert.equal(descriptor.annotations.readOnlyHint, true);
  assert.deepEqual(descriptor.securitySchemes, [{ type: 'noauth' }, { type: 'oauth2', scopes: [] }]);
  db.sql.close();
});
