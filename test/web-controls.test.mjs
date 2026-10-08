import { MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';
import { database } from './sqlite-d1.mjs';
import { readState, commitState } from '../worker/storage.mjs';

installModerationFixture();

const origin = 'https://turnfeed-web.example';
const secret = 'local-web-controls-012345678901234567890123456789';
const envFor = DB => ({ DB, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret });
const identity = subject => subject ? { 'oai-authenticated-user-id': subject,
  'oai-authenticated-user-full-name': subject === 'alice' ? 'Alice Example' : subject === 'bob' ? 'Bob Example' : subject } : {};
async function web(db, path, { subject = 'alice', form, originHeader = origin } = {}) {
  const response = await worker.fetch(new Request(origin + path, { method: form ? 'POST' : 'GET',
    headers: { ...identity(subject), ...(form ? { origin: originHeader, 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    ...(form ? { body: new URLSearchParams(form) } : {}) }), envFor(db));
  return { status: response.status, body: await response.text(), location: response.headers.get('location') };
}
async function rpc(db, subject, name, args = {}) {
  const response = await worker.fetch(new Request(origin + '/mcp', { method: 'POST', headers: {
    ...identity(subject), 'content-type': 'application/json',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), envFor(db));
  const data = (await response.json()).result?.structuredContent;
  assert.ok(data && data.ok !== false, JSON.stringify(data));
  return data;
}
function token(page, action) {
  const form = page.body.match(new RegExp(`<form[^>]*action="/web/${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1];
  assert.ok(form, `missing ${action} form: ${page.status} ${page.body.slice(-2500)}`);
  const result = form.match(/name="token"\s+value="([^"]+)"/)?.[1];
  assert.ok(result);
  return result;
}
const unescape = value => value.replaceAll('&amp;', '&');
const replyLinks = page => [...page.body.matchAll(/href="([^"]*\/actions\?reply=[^"]+)"/g)].map(match => unescape(match[1]));
const nextLink = (page, label) => unescape(page.body.match(new RegExp(`href="([^"]+)"[^>]*>${label}`))?.[1] || '');
async function fixture(db, { nested = false } = {}) {
  const post = await rpc(db, 'alice', 'create_post', { text: 'Which story would you read again?', visibility: 'public', clientId: 'fixture-post' });
  const context = await rpc(db, 'bob', 'get_thread_context', { postId: post.postId });
  await rpc(db, 'bob', 'publish_public_reply_to_post', { ...context.replyHandoff.targetArguments,
    text: 'Earthsea rewards another reading.', visibility: 'public', clientId: 'fixture-reply' });
  if (nested) {
    const replyContext = await rpc(db, 'alice', 'get_thread_context', { postId: post.postId });
    await rpc(db, 'alice', 'publish_public_reply_to_reply', { ...replyContext.recentReplies[0].replyHandoff.targetArguments,
      text: 'The characters change on each reading.', visibility: 'public', clientId: 'fixture-nested' });
  }
  return `/post/${post.postId}`;
}

test('Activity is private, uses native reply activity and preserves sign-in return paths', async () => {
  const db = database();
  const path = await fixture(db);
  const page = await web(db, '/activity?filter=replies');
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /Bob Example/);
  assert.match(page.body, /Earthsea rewards another reading/);
  assert.match(page.body, new RegExp(`href="${path}"`));
  assert.doesNotMatch((await web(db, '/activity', { subject: 'charlie' })).body, /Earthsea rewards another reading/);
  const signedOut = await web(db, '/activity?filter=replies&cursor=page', { subject: '' });
  assert.equal(signedOut.status, 303);
  assert.equal(signedOut.location, '/signin-with-chatgpt?return_to=%2Factivity%3Ffilter%3Dreplies%26cursor%3Dpage');
  const publicThread = await web(db, path + '?done=replied', { subject: '' });
  assert.match(publicThread.body, new RegExp(`return_to=${encodeURIComponent(path + '?done=replied')}`));
  db.sql.close();
});

test('post and reply reports use reviewed content and chosen reasons', async () => {
  const db = database();
  const path = await fixture(db);
  const postReview = await web(db, path + '/actions', { subject: 'bob' });
  assert.equal(postReview.status, 200);
  assert.match(postReview.body, /Which story would you read again/);
  const postForm = { token: token(postReview, 'report'), reason: 'other' };
  assert.equal((await web(db, '/web/report', { subject: 'bob', form: { ...postForm, reason: 'not-a-reason' } })).status, 400);
  assert.equal((await web(db, '/web/report', { subject: 'bob', form: postForm })).status, 303);
  const thread = await web(db, path);
  const review = await web(db, replyLinks(thread)[0]);
  const result = await web(db, '/web/report', { form: { token: token(review, 'report'), reason: 'spam' } });
  assert.equal(result.status, 303, result.body);
  const reports = (await readState(db)).value.snapshot.reports;
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.map(report => report.targetType).sort(), ['post', 'reply']);
  assert.deepEqual(reports.map(report => report.reason).sort(), ['other', 'spam']);
  db.sql.close();
});

test('browser mute and block have private named undo controls', async () => {
  const db = database();
  const path = await fixture(db);
  const thread = await web(db, path);
  const review = await web(db, replyLinks(thread)[0]);
  const muted = await web(db, '/web/mute', { form: { token: token(review, 'mute') } });
  assert.equal(muted.status, 303, muted.body);
  assert.equal((await rpc(db, 'alice', 'get_my_settings')).settings.mutedCount, 1);
  let people = await web(db, '/preferences');
  assert.match(people.body, /Bob Example/);
  const unmuteForm = { token: token(people, 'unmute') };
  assert.equal((await web(db, '/web/unmute', { subject: 'bob', form: unmuteForm })).status, 403);
  assert.equal((await web(db, '/web/unmute', { form: unmuteForm })).status, 303);
  assert.equal((await rpc(db, 'alice', 'get_my_settings')).settings.mutedCount, 0);
  const fresh = await web(db, replyLinks(await web(db, path))[0]);
  const blocked = await web(db, '/web/block', { form: { token: token(fresh, 'block') } });
  assert.equal(blocked.status, 303, blocked.body);
  assert.equal((await rpc(db, 'alice', 'open_turnfeed_inbox', { relationshipKind: 'blocked' })).relationships.length, 1);
  people = await web(db, '/preferences');
  const unblocked = await web(db, '/web/unblock', { form: { token: token(people, 'unblock') } });
  assert.equal(unblocked.status, 303, unblocked.body);
  assert.equal((await rpc(db, 'alice', 'open_turnfeed_inbox', { relationshipKind: 'blocked' })).relationships.length, 0);
  db.sql.close();
});

test('own reply deletion reviews descendant scope and deletes only that reply branch', async () => {
  const db = database();
  const path = await fixture(db, { nested: true });
  const bobPage = await web(db, path, { subject: 'bob' });
  const ownReview = await web(db, replyLinks(bobPage)[0], { subject: 'bob' });
  assert.match(ownReview.body, /any replies to it/);
  const form = { token: token(ownReview, 'delete-reply') };
  assert.equal((await web(db, '/web/delete-reply', { form })).status, 403);
  const removed = await web(db, '/web/delete-reply', { subject: 'bob', form });
  assert.equal(removed.status, 303, removed.body);
  const state = (await readState(db)).value.snapshot;
  assert.equal(state.posts.length, 1);
  assert.equal(state.posts[0].replies.length, 0);
  db.sql.close();
});

test('control forms retain normal account, action, origin and fresh-content validation', async () => {
  const db = database();
  const path = await fixture(db);
  const review = await web(db, replyLinks(await web(db, path))[0]);
  const form = { token: token(review, 'report'), reason: 'other' };
  assert.equal((await web(db, '/web/report', { subject: 'bob', form })).status, 403);
  assert.equal((await web(db, '/web/report', { form, originHeader: 'https://another.example' })).status, 403);
  assert.equal((await web(db, '/web/block', { form: { token: form.token } })).status, 403);
  assert.equal((await web(db, '/web/report', { form: { ...form, subject: 'bob' } })).status, 400);
  const state = await readState(db);
  state.value.snapshot.posts[0].replies[0].text = 'The reply now recommends another book.';
  await commitState(db, state.revision, state.value, undefined, state);
  const stale = await web(db, '/web/report', { form });
  assert.equal(stale.status, 409, stale.body);
  assert.equal((await readState(db)).value.snapshot.reports.length, 0);
  db.sql.close();
});

test('Activity and reply options preserve pagination context', async () => {
  const db = database();
  const path = await fixture(db);
  for (let i = 0; i < 10; i++) {
    const context = await rpc(db, `reader-${i}`, 'get_thread_context', { postId: path.slice(6) });
    await rpc(db, `reader-${i}`, 'publish_public_reply_to_post', { ...context.replyHandoff.targetArguments,
      text: `I remember a different detail from chapter ${i + 1}.`, visibility: 'public', clientId: `pagination-reply-${i}` });
  }
  const activity = await web(db, '/activity?filter=replies');
  const moreActivity = nextLink(activity, 'More activity');
  assert.ok(moreActivity.includes('filter=replies') && moreActivity.includes('cursor='), activity.body.slice(-5000));
  const olderActivity = await web(db, moreActivity);
  assert.equal(olderActivity.status, 200, olderActivity.body);
  const first = await web(db, path);
  const moreReplies = nextLink(first, 'More replies');
  assert.ok(moreReplies.includes('cursor='));
  const olderReplies = await web(db, moreReplies);
  const links = replyLinks(olderReplies);
  assert.ok(links.length);
  assert.ok(links.every(link => link.includes('&cursor=')));
  const review = await web(db, links[0]);
  assert.equal(review.status, 200);
  const result = await web(db, '/web/report', { form: { token: token(review, 'report'), reason: 'other' } });
  assert.equal(result.status, 303, result.body);
  assert.equal((await readState(db)).value.snapshot.reports.length, 1);
  db.sql.close();
});
