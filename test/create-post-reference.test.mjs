import { invoke } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-d1.mjs';
import { makeCore } from '../worker/mcp.mjs';
import { readState, commitState } from '../worker/storage.mjs';

const origin = 'https://post-reference.example';
const secret = 'local-post-reference-012345678901234567890123456789';
const text = 'What would you like to be improved with the next ChatGPT model?';
const call = async (db, subject, name, args) => (await invoke({ db, subject, name, args,
  origin, secret, callerKey: subject, displayName: subject === 'alice' ? 'Alicia' : 'Bobby' })).result.structuredContent;
const create = (db, subject = 'alice', clientId = 'reference-post-1', postText = text, extra = {}) =>
  call(db, subject, 'create_post', { text: postText, visibility: 'public', clientId, ...extra });

test('a published post supplies a usable exact reply target without a lookup or extra database read', async () => {
  const db = database();
  await readState(db); // Initialize before measuring the request's normal path.
  const reads = db.reads.length;
  const result = await create(db);
  assert.equal(result.published, true);
  assert.equal(db.reads.length - reads, 1);
  assert.equal(makeCore({ origin, secret }).tools.get('create_post').descriptor.outputSchema.safeParse(result).success, true);
  const stored = await readState(db), post = stored.value.snapshot.posts[0];
  assert.equal(result.postId, post.id);
  assert.equal(result.createdPost.text, text);
  assert.equal(result.createdPost.authorName, 'Alicia');
  assert.equal(result.createdPost.createdAt, post.createdAt);
  assert.equal(result.replyHandoff.readFirst, false);
  assert.deepEqual(result.replyHandoff.readArguments, { postId: post.id });
  assert.equal(JSON.stringify(result).includes(post.authorId), false);
  assert.equal(JSON.stringify(result).includes(post.clientId), false);
  assert.equal(Object.hasOwn(result.replyHandoff.targetArguments, 'postId'), false);

  const replyText = 'I would like better continuity across conversations, so I can spend less time repeating context.';
  const replyArgs = { ...result.replyHandoff.targetArguments, text: replyText,
    visibility: 'public', clientId: 'reference-reply-1' };
  const schema = makeCore({ origin, secret }).tools.get(result.replyHandoff.publishTool).descriptor.inputSchema;
  assert.equal(schema.safeParse(replyArgs).success, true);
  const reply = await call(db, 'alice', result.replyHandoff.publishTool, replyArgs);
  assert.equal(reply.published, true);
  assert.equal(reply.postId, result.postId);
  const thread = await call(db, 'alice', 'get_thread_context', result.replyHandoff.readArguments);
  assert.equal(thread.thread.text, text);
  assert.equal(thread.recentReplies[0].text, replyText);
  assert.equal((await create(db)).replyHandoff.readFirst, true);
});

test('identical retries retain the original post across newer writes and a different owner using the same client ID', async () => {
  const db = database(), first = await create(db);
  const newer = await create(db, 'alice', 'reference-post-2', 'A useful lesson from cooking: prepare the vegetables before heating the pan.');
  const other = await create(db, 'bob', 'reference-post-1', 'What is a short novel you would recommend for a weekend away?');
  assert.notEqual(first.postId, newer.postId);
  assert.notEqual(first.postId, other.postId);
  const retried = await create(db);
  assert.equal(retried.postId, first.postId);
  assert.deepEqual(retried.createdPost, first.createdPost);
  assert.deepEqual(retried.replyHandoff, first.replyHandoff);
  assert.equal((await readState(db)).value.snapshot.posts.length, 3);

  const conflict = await create(db, 'alice', 'reference-post-1', 'Different words cannot reuse an earlier publishing request.');
  assert.equal(conflict.ok, false);
  assert.equal(conflict.postId, undefined);
  assert.equal(conflict.replyHandoff, undefined);
  await call(db, 'alice', 'delete_post', { id: first.postId,
    targetLabel: first.replyHandoff.targetArguments.targetLabel, postText: text });
  const deletedRetry = await create(db);
  assert.equal(deletedRetry.published, false);
  assert.equal(deletedRetry.postId, undefined);
  assert.equal(deletedRetry.createdPost, undefined);
});

test('retry receipts respect hidden and archived posts and quote context', async () => {
  const db = database(), first = await create(db);
  let loaded = await readState(db);
  loaded.value.snapshot.posts[0].hidden = true;
  assert.equal(await commitState(db, loaded.revision, loaded.value, undefined, loaded), true);
  const hidden = await create(db);
  assert.equal(hidden.published, true);
  assert.equal(hidden.createdPost, undefined);
  assert.equal(hidden.replyHandoff, undefined);

  loaded = await readState(db);
  loaded.value.snapshot.posts[0].hidden = false;
  loaded.value.snapshot.posts[0].archivedAt = '2026-10-01T00:00:00Z';
  assert.equal(await commitState(db, loaded.revision, loaded.value, undefined, loaded), true);
  const archived = await create(db);
  assert.equal(archived.published, true);
  assert.equal(archived.postId, first.postId);
  assert.equal(archived.replyHandoff, undefined);

  const quoted = await create(db, 'bob', 'reference-quote-1',
    'Remembering the decisions behind earlier work would make longer projects easier to continue.', {
      quotePostId: first.postId, quoteTargetLabel: first.replyHandoff.targetArguments.targetLabel,
      quoteAuthorName: first.createdPost.authorName, quotePostText: text, quoteCreatedAt: first.createdPost.createdAt,
    });
  assert.equal(quoted.published, true);
  assert.equal(quoted.replyHandoff.readFirst, true);
  assert.deepEqual(quoted.replyHandoff.readArguments, { postId: quoted.postId });
});

test('a lost commit response returns no success receipt and an identical retry resolves the committed post', async () => {
  const db = database();
  db.failAfterCommit = true;
  await assert.rejects(() => create(db), { code: 'storage_outcome_unknown' });
  db.failAfterCommit = false;
  const stored = await readState(db);
  assert.equal(stored.value.snapshot.posts.length, 1);
  const retried = await create(db);
  assert.equal(retried.postId, stored.value.snapshot.posts[0].id);
  assert.equal((await readState(db)).value.snapshot.posts.length, 1);
});
