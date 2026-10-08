import test from 'node:test';
import assert from 'node:assert/strict';
import { invoke, MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import { database } from './sqlite-d1.mjs';
import { makeCore, catalog } from '../worker/mcp.mjs';
import { readState } from '../worker/storage.mjs';
import { MAX_POST_TEXT_LENGTH, MAX_REPLY_TEXT_LENGTH } from '../worker/text-limits.mjs';
import worker from '../worker/index.mjs';

installModerationFixture();
const origin = 'https://long-posts.example';
const secret = 'local-long-post-limits-012345678901234567890123456789';
const unicodeText = (length, offset = 0) => Array.from({ length }, (_, i) => String.fromCharCode(0x4e00 + offset + i)).join('');
const postArgs = text => ({ text, visibility: 'public', clientId: 'long-post-1' });
const call = (db, name, args, subject = 'alice') => invoke({ db, subject, name, args,
  origin, secret, callerKey: subject, displayName: subject === 'alice' ? 'Alicia' : 'Bobby' });
const ok = async (db, name, args, subject) => {
  const response = await call(db, name, args, subject);
  assert.equal(response.result?.structuredContent?.ok, true, JSON.stringify(response));
  return response.result.structuredContent;
};
const rejectText = async (db, name, args, subject) => {
  const response = await call(db, name, args, subject);
  assert.equal(response.rpcError?.code, -32602, JSON.stringify(response));
  assert.ok(response.rpcError.data.some(issue => issue.path.join('.') === 'text'));
};
async function web(db, path, { subject = 'alice', form } = {}) {
  const headers = { 'oai-authenticated-user-id': subject, 'oai-authenticated-user-full-name': subject === 'alice' ? 'Alicia' : 'Bobby' };
  if (form) Object.assign(headers, { origin, 'content-type': 'application/x-www-form-urlencoded' });
  const response = await worker.fetch(new Request(origin + path, { headers, method: form ? 'POST' : 'GET',
    ...(form ? { body: new URLSearchParams(form) } : {}) }), { DB: db, TURNFEED_SITE_SECRET: secret, OPENAI_API_KEY: MODERATION_KEY });
  return { status: response.status, body: await response.text(), location: response.headers.get('location') };
}
function token(page, action) {
  assert.equal(page.status, 200, page.body.slice(-2000));
  const form = page.body.match(new RegExp(`<form[^>]*action="/web/${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1];
  const value = form?.match(/name="token"\s+value="([^"]+)"/)?.[1];
  assert.ok(value, `Missing ${action} form`);
  assert.ok(value.length <= 16_384, `Signed ${action} target exceeds token ceiling`);
  return value;
}

test('MCP catalog and input schemas use UTF-16 post 3000 and reply 600 boundaries', () => {
  assert.equal(MAX_POST_TEXT_LENGTH, 3000);
  assert.equal(MAX_REPLY_TEXT_LENGTH, 600);
  const core = makeCore({ origin, secret });
  const tools = catalog(core);
  for (const [name, max] of [['create_post', 3000], ['edit_post', 3000], ['check_reply_before_publishing', 600],
    ['publish_public_reply_to_post', 600], ['publish_public_reply_to_reply', 600], ['edit_reply', 600]]) {
    const schema = core.tools.get(name).descriptor.inputSchema.shape.text;
    const text = '🙂'.repeat(max / 2);
    assert.equal(text.length, max);
    assert.equal(schema.safeParse(text).success, true, name);
    assert.equal(schema.safeParse(text + 'x').success, false, name);
    assert.equal(schema.safeParse(' ' + text).success, false, `${name}: raw length before trimming`);
    assert.equal(tools.find(tool => tool.name === name).inputSchema.properties.text.maxLength, max, name);
  }
});

test('MCP preserves 3000-character posts, edits and history while rejecting over-limit writes', async t => {
  const db = database(); t.after(() => db.sql.close());
  const original = unicodeText(3000), edited = unicodeText(3000, 3500);
  await rejectText(db, 'create_post', postArgs(original + 'x'));
  const created = await ok(db, 'create_post', postArgs(original));
  assert.equal(created.published, true);
  assert.equal(created.createdPost.text, original);
  const initialThread = await ok(db, 'get_thread_context', { postId: created.postId });
  assert.equal(initialThread.thread.text, original);
  const edit = { id: created.postId, targetLabel: created.replyHandoff.targetArguments.targetLabel,
    postText: created.replyHandoff.targetArguments.postText, text: edited };
  await rejectText(db, 'edit_post', { ...edit, text: edited + 'x' });
  assert.equal((await readState(db)).value.snapshot.posts[0].text, original);
  await ok(db, 'edit_post', edit);
  const thread = await ok(db, 'get_thread_context', { postId: created.postId });
  assert.equal(thread.thread.text, edited);
  assert.equal(thread.thread.correctionHistory[0].text, original);
  const persisted = (await readState(db)).value.snapshot.posts[0];
  assert.equal(persisted.text, edited);
  assert.equal(persisted.correctionHistory[0].text, original);
  const feed = await ok(db, 'get_feed_digest', { focus: 'latest', limit: 4 });
  assert.equal(feed.items[0].previewTruncated, true);
  assert.ok(feed.items[0].text.length <= 600);
});

test('MCP replies, nested replies, reply edits and preflight retain the 600-character boundary', async t => {
  const db = database(); t.after(() => db.sql.close());
  const created = await ok(db, 'create_post', postArgs(unicodeText(3000)));
  const replyText = unicodeText(600, 3500), nestedText = unicodeText(600, 4200), editedText = unicodeText(600, 4900);
  const reply = { ...created.replyHandoff.targetArguments, text: replyText, visibility: 'public', clientId: 'long-reply-1' };
  await rejectText(db, 'publish_public_reply_to_post', { ...reply, text: replyText + 'x' }, 'bob');
  const preflight = { targetText: reply.postText, postText: reply.postText, text: replyText };
  await rejectText(db, 'check_reply_before_publishing', { ...preflight, text: replyText + 'x' }, 'bob');
  await ok(db, 'check_reply_before_publishing', preflight, 'bob');
  assert.equal((await ok(db, 'publish_public_reply_to_post', reply, 'bob')).published, true);
  let thread = await ok(db, 'get_thread_context', { postId: created.postId });
  const target = thread.recentReplies[0].replyHandoff.targetArguments;
  const nested = { ...target, text: nestedText, visibility: 'public', clientId: 'long-nested-1' };
  await rejectText(db, 'publish_public_reply_to_reply', { ...nested, text: nestedText + 'x' });
  assert.equal((await ok(db, 'publish_public_reply_to_reply', nested)).published, true);
  const { targetKind: _kind, ...editTarget } = target;
  const edit = { ...editTarget, text: editedText };
  await rejectText(db, 'edit_reply', { ...edit, text: editedText + 'x' }, 'bob');
  await ok(db, 'edit_reply', edit, 'bob');
  thread = await ok(db, 'get_thread_context', { postId: created.postId });
  assert.equal(thread.recentReplies.find(reply => reply.text === editedText).correctionHistory[0].text, replyText);
  const persisted = (await readState(db)).value.snapshot.posts[0].replies[0];
  assert.equal(persisted.text, editedText);
  assert.equal(persisted.replies[0].text, nestedText);
});

test('browser Unicode posts preserve recovery text and support signed replies, likes, report and deletion', async t => {
  const db = database(); t.after(() => db.sql.close());
  const original = unicodeText(3000), replyText = unicodeText(600, 3500);
  const form = { token: token(await web(db, '/'), 'post'), text: original };
  assert.ok(Buffer.byteLength(new URLSearchParams(form).toString()) < 32_768, 'URL-encoded Unicode post exceeds form ceiling');
  const rejected = await web(db, '/web/post', { form: { ...form, text: original + 'x' } });
  assert.equal(rejected.status, 400);
  assert.ok(rejected.body.includes(original + 'x'), 'The rejected draft must retain its final character');
  const created = await web(db, '/web/post', { form });
  assert.equal(created.status, 303, created.body);
  const path = created.location.split('?')[0];
  let page = await web(db, path, { subject: 'bob' });
  assert.ok(page.body.includes(original), 'Conversation must render the complete root');
  const reply = { token: token(page, 'reply'), text: replyText };
  const longReply = await web(db, '/web/reply', { subject: 'bob', form: { ...reply, text: replyText + 'x' } });
  assert.equal(longReply.status, 400);
  assert.ok(longReply.body.includes(replyText + 'x'));
  assert.equal((await web(db, '/web/reply', { subject: 'bob', form: reply })).status, 303);
  page = await web(db, path);
  const nested = { token: token(page, 'nested-reply'), text: unicodeText(600, 4200) };
  assert.ok(nested.token.length > 4096, 'Exercise a large Unicode signed handoff');
  assert.ok(Buffer.byteLength(new URLSearchParams(nested).toString()) < 32_768, 'Nested form exceeds body ceiling');
  assert.equal((await web(db, '/web/nested-reply', { form: { ...nested, text: nested.text + 'x' } })).status, 400);
  const nestedResult = await web(db, '/web/nested-reply', { form: nested });
  assert.equal(nestedResult.status, 303, nestedResult.body);
  const liked = await web(db, '/web/like-post', { subject: 'bob', form: { token: token(await web(db, path, { subject: 'bob' }), 'like-post') } });
  assert.equal(liked.status, 303, liked.body);
  const reportPage = await web(db, path + '/actions', { subject: 'bob' });
  const reported = await web(db, '/web/report', { subject: 'bob', form: { token: token(reportPage, 'report'), reason: 'other' } });
  assert.equal(reported.status, 303, reported.body);
  assert.equal((await readState(db)).value.snapshot.posts[0].text, original);
  const removed = await web(db, '/web/delete', { form: { token: token(await web(db, path + '/delete'), 'delete') } });
  assert.equal(removed.status, 303, removed.body);
});
