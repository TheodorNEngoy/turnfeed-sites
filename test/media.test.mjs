import { invoke, MODERATION_KEY, installModerationFixture } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { videoReference, socialText, mediaScript } from '../worker/media.mjs';
import { renderWeb } from '../worker/web-view.mjs';
import worker from '../worker/index.mjs';
import { database } from './sqlite-d1.mjs';

installModerationFixture();


test('known video links produce fixed players; other links remain ordinary links', () => {
  for (const url of ['https://youtu.be/hJxUBxvbGvA', 'https://www.youtube.com/watch?v=hJxUBxvbGvA&si=shared',
    'https://youtube.com/shorts/hJxUBxvbGvA', 'https://youtube.com/live/hJxUBxvbGvA']) {
    assert.equal(videoReference(url).embed, 'https://www.youtube-nocookie.com/embed/hJxUBxvbGvA?autoplay=0&playsinline=1');
  }
  assert.equal(videoReference('https://vimeo.com/76979871').embed, 'https://player.vimeo.com/video/76979871?autoplay=0&dnt=1');
  for (const url of ['https://example.org/watch?v=hJxUBxvbGvA', 'http://youtu.be/hJxUBxvbGvA',
    'https://youtu.be/short', 'https://youtube.com/watch?v=hJxUBxvbGvA&v=abcdefghijk',
    'https://name@youtube.com/watch?v=hJxUBxvbGvA', 'https://vimeo.com/channels/staffpicks']) assert.equal(videoReference(url), null);
  const rendered = socialText('A useful read (https://example.org/a_(b)).\nAnd a video: https://youtu.be/hJxUBxvbGvA.');
  assert.match(rendered, /href="https:\/\/example.org\/a_\(b\)"/);
  assert.match(rendered, /rel="noopener noreferrer nofollow ugc"/);
  assert.match(rendered, /data-video-url=/);
  assert.doesNotMatch(rendered, /<iframe|<img/);
  assert.equal((socialText('https://youtu.be/hJxUBxvbGvA https://vimeo.com/76979871').match(/data-video-url=/g) || []).length, 1);
  assert.doesNotMatch(socialText('https://youtu.be/hJxUBxvbGvA', { video: false }), /data-video-url/);
  assert.match(socialText('<b>A & B</b>'), /&lt;b&gt;A &amp; B&lt;\/b&gt;/);
});

function checkPlayerScript(script) {
  let frames = 0;
  const cards = ['https://youtu.be/hJxUBxvbGvA', 'https://vimeo.com/76979871'].map(url => {
    const load = new EventTarget(), close = new EventTarget(), placeholder = {};
    load.focus = close.focus = () => {};
    const player = { children: [], replaceChildren(...children) { this.children = children; } };
    const nodes = { '[data-video-load]': load, '[data-video-close]': close, '[data-video-player]': player, '.video-placeholder': placeholder };
    return { load, close, player, placeholder, getAttribute: () => url, querySelector: selector => nodes[selector] };
  });
  const document = { querySelectorAll: () => cards, createElement: tag => {
    assert.equal(tag, 'iframe'); frames++;
    return { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  } };
  vm.runInNewContext(script, { document, URL });
  assert.equal(frames, 0);
  cards[0].load.dispatchEvent(new Event('click'));
  const frame = cards[0].player.children[0];
  assert.match(frame.src, /^https:\/\/www.youtube-nocookie.com\/embed\//);
  assert.match(frame.src, /autoplay=0/);
  assert.equal(frame.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(frame.attributes.sandbox, 'allow-scripts allow-same-origin allow-presentation');
  cards[1].load.dispatchEvent(new Event('click'));
  assert.equal(cards[0].player.children.length, 0);
  assert.equal(cards[0].load.hidden, false);
  assert.equal(cards[1].player.children.length, 1);
  cards[1].close.dispatchEvent(new Event('click'));
  assert.equal(cards[1].player.children.length, 0);
  assert.equal(cards[1].placeholder.hidden, false);
}

test('shipped script loads only on click, closes players and keeps one active', () => {
  checkPlayerScript(mediaScript);
});

test('minified Worker serves working video controls', async () => {
  const bundle = await build({ entryPoints: ['worker/index.mjs'], bundle: true,
    format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'],
    inject: ['worker/globals.mjs'], minify: true, write: false });
  const built = (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
  const response = await built.fetch(new Request('https://turnfeed-media.example/assets/media.js'), {});
  assert.equal(response.status, 200);
  checkPlayerScript(await response.text());
});

test('web cards follow normal post visibility without changing native content', async () => {
  const db = database(), origin = 'https://turnfeed-media.example';
  const secret = 'local-media-test-012345678901234567890123456789';
  const text = 'A video worth discussing: https://youtu.be/hJxUBxvbGvA';
  const call = (name, args) => invoke({ db, origin, secret, subject: 'alice', callerKey: 'alice', name, args });
  try {
    const created = (await call('create_post', { text, visibility: 'public', clientId: 'media-card' })).result.structuredContent;
    assert.equal(created.published, true);
    const response = await worker.fetch(new Request(origin + '/post/' + created.postId), { DB: db, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret });
    const page = await response.text();
    assert.match(page, /data-video-url=/);
    assert.match(page, /src="\/assets\/media.js"/);
    assert.doesNotMatch(page, /<iframe|src="https:\/\//);
    assert.match(response.headers.get('content-security-policy'), /frame-src https:\/\/www.youtube-nocookie.com https:\/\/player.vimeo.com;/);
    const native = (await call('get_thread_context', { postId: created.postId })).result.structuredContent;
    assert.equal(native.thread.text, text);
    const deleted = (await call('delete_post', { id: created.postId, targetLabel: 'My video post', postText: text, scope: 'one_post' })).result.structuredContent;
    assert.notEqual(deleted.ok, false);
    const unavailable = await worker.fetch(new Request(origin + '/post/' + created.postId), { DB: db, OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET: secret });
    assert.doesNotMatch(await unavailable.text(), /data-video-url=/);
  } finally { db.sql.close(); }
  const replyPage = renderWeb({ kind: 'thread', data: { thread: { text: 'A conversation' }, recentReplies: [{ text: 'https://vimeo.com/76979871' }] } });
  assert.match(replyPage, /Load Vimeo video/);
});
