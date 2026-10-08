import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWeb } from '../worker/web-view.mjs';

const origin = 'https://turnfeed.example';
const path = `/photos/${'a'.repeat(64)}.jpg`;
const photo = { type: 'image', url: origin + path };
const post = { postId: 'photo-post', authorName: 'Alice "Reader" & friends',
  text: 'An afternoon outside.', media: [photo] };
const figures = html => html.match(/<figure class="post-photo">[\s\S]*?<\/figure>/g) || [];

test('feed, profile, conversation and delete previews render one accessible local photo', () => {
  for (const [kind, data] of [
    ['feed', { items: [post] }],
    ['profile', { items: [post] }],
    ['thread', { postId: post.postId, thread: post }],
    ['delete', { postId: post.postId, thread: post, viewerOwnsTarget: true }],
  ]) {
    const html = renderWeb({ kind, data, signedIn: true });
    const images = figures(html);
    assert.equal(images.length, 1, kind);
    assert.ok(images[0].includes(`href="${path}"`), kind);
    assert.ok(images[0].includes(`src="${path}"`), kind);
    assert.match(images[0], /alt="Photo shared by Alice &quot;Reader&quot; &amp; friends"/);
    assert.match(images[0], /loading="lazy" decoding="async"/);
    assert.match(images[0], /Open photo/);
    assert.doesNotMatch(images[0], /https:|<iframe|<video|autoplay/);
    assert.match(html, /object-fit:contain/);
    if (kind === 'thread' || kind === 'delete') assert.doesNotMatch(html, /type="file"/);
  }
});

test('quoted photos render without exposing an unavailable quote and preserve video cards', () => {
  const quote = { text: 'A photograph from the trip.', media: [{ ...photo, url: origin + path.replace('.jpg', '.png') }] };
  const data = { items: [{ ...post, text: 'A related video: https://youtu.be/hJxUBxvbGvA', quote }] };
  const html = renderWeb({ data });
  assert.equal(figures(html).length, 2);
  assert.match(html, /<blockquote class="quote">[\s\S]*<figure class="post-photo">/);
  assert.match(html, /alt="Photo attached to this post"/);
  assert.match(html, /data-video-url=/);
  assert.match(html, /Load YouTube video/);
  const unavailable = renderWeb({ data: { items: [{ ...post, media: [], quote: { ...quote, unavailable: true } }] } });
  assert.equal(figures(unavailable).length, 0);
  assert.match(unavailable, /quoted post is no longer available/);
});

test('only canonical image attachment URLs render; unsafe or unrelated URLs stay absent', () => {
  const invalid = [
    `https://outside.example${path}`, `http://turnfeed.example${path}`,
    `https://turnfeed.example.outside.example${path}`,
    `https://user@turnfeed.example${path}`,
    `https://user:password@turnfeed.example${path}`,
    `https://@turnfeed.example${path}`,
    `https://turnfeed.example:8443${path}`,
    `https://turnfeed.example:443${path}`, `https://TURNFEED.example${path}`,
    `//turnfeed.example${path}`, path,
    `${origin}${path}?download=1`, `${origin}${path}#image`,
    `${origin}${path}?`, `${origin}${path}#`, ` ${origin}${path}`,
    `${origin}/photos/${'A'.repeat(64)}.jpg`, `${origin}/photos/${'a'.repeat(63)}.jpg`,
    `${origin}/photos/${'a'.repeat(64)}.svg`, `${origin}/other/../${path.slice(1)}`,
    'javascript:alert(1)', 'data:image/png;base64,AAAA', `${origin}${path}" onerror="alert(1)`,
  ];
  for (const url of invalid) {
    const html = renderWeb({ data: { items: [{ ...post, media: [{ type: 'image', url }] }] } });
    assert.equal(figures(html).length, 0, url);
  }
  for (const media of [null, {}, [{ type: 'video', url: photo.url }], [{ type: 'image', url: null }]]) {
    assert.equal(figures(renderWeb({ data: { items: [{ ...post, media }] } })).length, 0);
  }
  const multiple = renderWeb({ data: { items: [{ ...post, media: [photo, { ...photo, url: origin + path.replace('.jpg', '.png') }] }] } });
  assert.equal(figures(multiple).length, 1);
});
