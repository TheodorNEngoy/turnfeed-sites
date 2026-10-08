import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWeb } from '../worker/web-view.mjs';

const forms = html => html.match(/<form\b[\s\S]*?<\/form>/g) || [];

test('the signed-in new-post form supports one optional photo with native multipart submission', () => {
  const html = renderWeb({ kind: 'feed', signedIn: true, formToken: 'signed-form-token', draft: 'An exact caption & a <view>.' });
  const form = forms(html).find(value => value.includes('action="/web/post"'));
  assert.ok(form);
  assert.match(form, /method="post"/);
  assert.match(form, /enctype="multipart\/form-data"/);
  assert.match(form, /name="token" value="signed-form-token"/);
  assert.match(form, /<label for="post-photo">Add photo/);
  const input = form.match(/<input[^>]*type="file"[^>]*>/)?.[0];
  assert.ok(input);
  assert.match(input, /name="photo"/);
  assert.match(input, /accept="image\/jpeg,image\/png"/);
  assert.doesNotMatch(input, /\b(?:multiple|required|disabled|hidden)\b/);
  assert.match(form, /1 MiB and 4096 pixels per side/);
  assert.match(form, /<textarea[^>]*name="text"[^>]*required/);
  assert.match(form, /An exact caption &amp; a &lt;view&gt;\./);
  assert.match(form, /data-photo-remove hidden>Remove photo/);
  assert.match(form, /data-photo-preview alt="Selected photo preview" hidden/);
  assert.match(form, /<button type="submit"><span data-submit-label>Publish post/);
  assert.match(html, /<details class="compose-entry" open>/);
});

test('reply and nested-reply forms keep their text-only submission behavior', () => {
  const html = renderWeb({ kind: 'thread', signedIn: true, formToken: 'reply-token', data: {
    postId: 'post-1', thread: { text: 'The conversation.', authorName: 'Alice' },
    replyHandoff: {}, recentReplies: [{ text: 'A reply.', authorName: 'Bob', webReplyToken: 'nested-token' }],
  } });
  const replies = forms(html).filter(value => /action="\/web\/(?:reply|nested-reply)"/.test(value));
  assert.equal(replies.length, 2);
  for (const form of replies) {
    assert.doesNotMatch(form, /type="file"|name="photo"|multipart\/form-data/);
    assert.match(form, /name="text"/);
    assert.match(form, /Publish reply/);
  }
});

test('signed-out readers see sign-in rather than an upload form', () => {
  const html = renderWeb({ kind: 'feed', signedIn: false });
  assert.doesNotMatch(html, /type="file"|action="\/web\/post"/);
  assert.match(html, /Sign in with ChatGPT/);
});
