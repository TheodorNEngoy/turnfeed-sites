import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWeb } from '../worker/web-view.mjs';

test('long posts get a compact feed preview and a full conversation body', () => {
  const text = 'A useful guide with several readable sections.\n\n'.repeat(45) + 'The final sentence is preserved.';
  const post = { postId: 'post-long', text, authorName: 'Avery', webLike: { token: 'signed-like', count: 0 } };
  const feed = renderWeb({ kind: 'feed', signedIn: true, data: { items: [post] } });
  assert.match(feed, /class="post-preview"/);
  assert.match(feed, /href="\/post\/post-long">Read more/);
  assert.match(feed, /action="\/web\/like-post"/);
  const thread = renderWeb({ kind: 'thread', signedIn: true, data: { postId: post.postId, thread: post, replyHandoff: {} } });
  assert.ok(thread.includes(text), 'conversation retains the exact complete body');
  assert.doesNotMatch(thread, /class="post-preview"/);
});

test('short posts stay expanded, while multiline or upstream-truncated previews have Read more', () => {
  const feed = text => renderWeb({ data: { items: [{ postId: 'post-1', text }] } });
  assert.doesNotMatch(feed('A brief thought.'), /class="post-preview"/);
  assert.match(feed('A brief thought.'), />Open conversation/);
  assert.match(feed('One\nTwo\nThree\nFour\nFive\nSix\nSeven'), />Read more/);
  assert.match(renderWeb({ data: { items: [{ postId: 'post-1', text: 'Preview…', previewTruncated: true }] } }), />Read more/);
});

test('the composer advertises 3000-character posts and keeps both reply forms at 600', () => {
  const feed = renderWeb({ kind: 'feed', signedIn: true, formToken: 'signed-post' });
  assert.match(feed, /id="post-text" name="text" maxlength="3000"/);
  assert.match(feed, />Up to 3,000 characters\./);
  const thread = renderWeb({ kind: 'thread', signedIn: true, formToken: 'signed-reply', data: {
    postId: 'post-1', thread: { text: 'Root' }, replyHandoff: {},
    recentReplies: [{ text: 'A reply', webReplyToken: 'signed-nested-reply' }],
  } });
  assert.match(thread, /id="reply-text" name="text" maxlength="600"/);
  assert.match(thread, /id="nested-reply-0" name="text" maxlength="600"/);
});
