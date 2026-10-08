import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, trustedContext } from '../worker/mcp.mjs';
import { accountKey } from '../worker/identity.mjs';

const origin = 'https://social-projection.example';
const secret = 'social-projection-012345678901234567890123456789';
const alice = accountKey('alice', secret), bob = accountKey('bob', secret);

function fixture(change = () => {}) {
  const snapshot = makeCore({ origin, secret }).snapshot();
  snapshot.profiles = {
    [alice]: { displayName: 'Alicia', handle: 'alice' },
    [bob]: { displayName: 'Bobby', handle: 'bob' },
  };
  snapshot.follows[bob] = [alice];
  snapshot.posts = [{
    id: 'post-social', authorId: alice, text: 'What book would you happily read twice?',
    createdAt: '2026-10-01T10:00:00Z', visibility: 'public', audience: { type: 'public' },
    likes: 3, likedBy: [bob], media: [], correctionHistory: [], replies: [{
      id: 'reply-social', authorId: bob, text: 'A travel memoir offers new details on a second reading.',
      createdAt: '2026-10-01T10:01:00Z', likes: 2, likedBy: [alice], replies: [],
    }],
  }];
  change(snapshot);
  return snapshot;
}

async function read(snapshot, subject, name, args, options = {}) {
  const core = makeCore({ origin, secret, snapshot, callerKey: subject || 'anonymous', ...options });
  const tool = core.tools.get(name);
  const result = await tool.handler(args, trustedContext(subject));
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result));
  const parsed = tool.descriptor.outputSchema.safeParse(result.structuredContent);
  assert.equal(parsed.success, true, parsed.error?.message);
  return result.structuredContent;
}

test('compact feed retains like counts and viewer-specific social state without exposing voter identities', async () => {
  for (const [subject, liked, own] of [['bob', true, false], ['alice', false, true], ['', undefined, undefined]]) {
    const output = await read(fixture(), subject, 'get_feed_digest', { focus: 'latest', limit: 4 });
    const post = output.items.find(item => item.postId === 'post-social');
    assert.ok(post);
    assert.equal(post.likes, 3);
    assert.equal(post.viewerHasLiked, liked);
    assert.equal(post.viewerIsAuthor, own);
    assert.equal(Object.hasOwn(post, 'likedBy'), false);
    if (!subject) {
      assert.equal(Object.hasOwn(post, 'viewerHasLiked'), false);
      assert.equal(Object.hasOwn(post, 'viewerIsAuthor'), false);
    }
  }
});

test('full and selected thread projections retain root and reply counts with accurate viewer like state', async () => {
  for (const threadProjection of [false, true]) {
    for (const [subject, rootLiked, replyLiked] of [['bob', true, false], ['alice', false, true], ['', undefined, undefined]]) {
      const output = await read(fixture(), subject, 'get_thread_context', { postId: 'post-social' }, { threadProjection });
      assert.equal(output.thread.likes, 3);
      assert.equal(output.thread.viewerHasLiked, rootLiked);
      assert.equal(output.recentReplies[0].likes, 2);
      assert.equal(output.recentReplies[0].viewerHasLiked, replyLiked);
      if (!subject) {
        assert.equal(Object.hasOwn(output.thread, 'viewerHasLiked'), false);
        assert.equal(Object.hasOwn(output.recentReplies[0], 'viewerHasLiked'), false);
      }
    }
  }
});

test('profile projection distinguishes following, blocking and anonymous reads, and preserves recent-post social state', async () => {
  for (const [subject, change, follows, blocked] of [
    ['bob', () => {}, true, false],
    ['bob', snapshot => { snapshot.follows[bob] = []; }, false, false],
    ['bob', snapshot => { snapshot.follows[bob] = []; snapshot.blocks[bob] = [alice]; }, false, true],
    ['', () => {}, undefined, undefined],
  ]) {
    const output = await read(fixture(change), subject, 'open_turnfeed_feed', { targetKind: 'profile', profileHandle: 'alice' });
    assert.equal(output.profile.viewerFollows, follows);
    assert.equal(output.profile.viewerHasBlocked, blocked);
    if (blocked) assert.deepEqual(output.items, []);
    else {
      assert.equal(output.items[0].likes, 3);
      assert.equal(output.items[0].viewerHasLiked, subject ? true : undefined);
    }
    if (!subject) {
      assert.equal(Object.hasOwn(output.profile, 'viewerFollows'), false);
      assert.equal(Object.hasOwn(output.profile, 'viewerHasBlocked'), false);
    }
  }
});

test('missing stored count and voter lists project as zero and false', async () => {
  const snapshot = fixture(value => {
    delete value.posts[0].likes; delete value.posts[0].likedBy;
    delete value.posts[0].replies[0].likes; delete value.posts[0].replies[0].likedBy;
  });
  const feed = await read(snapshot, 'bob', 'get_feed_digest', { focus: 'latest' });
  const thread = await read(snapshot, 'bob', 'get_thread_context', { postId: 'post-social' });
  assert.equal(feed.items[0].likes, 0);
  assert.equal(feed.items[0].viewerHasLiked, false);
  assert.equal(thread.thread.likes, 0);
  assert.equal(thread.thread.viewerHasLiked, false);
  assert.equal(thread.recentReplies[0].likes, 0);
  assert.equal(thread.recentReplies[0].viewerHasLiked, false);
});
