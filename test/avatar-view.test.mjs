import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWeb } from '../worker/web-view.mjs';

const photo = character => `https://turnfeed.example/photos/${character.repeat(64)}.png`;
const forms = html => html.match(/<form\b[\s\S]*?<\/form>/g) || [];
const author = (name, character) => ({ authorName: name, authorAvatarUrl: photo(character), text: 'Hello.' });

test('feed, reply previews and quotes show owned author pictures through the same-origin route', () => {
  const html = renderWeb({ kind: 'feed', data: { items: [{ postId: 'p1', ...author('Alice', 'a'),
    recentReplies: [author('Bob', 'b')], quote: author('Charlie', 'c'),
  }] } });
  for (const character of ['a', 'b', 'c']) {
    assert.match(html, new RegExp(`<img src="/photos/${character.repeat(64)}\\.png" alt="" loading="lazy" decoding="async">`));
  }
  assert.doesNotMatch(html, /src="https:\/\/turnfeed/);
  assert.match(html, /\.avatar img\{[^}]*object-fit:cover/);
  assert.match(html, /\.avatar\{[^}]*overflow:hidden/);
});

test('conversation and reply headers show author pictures', () => {
  const html = renderWeb({ kind: 'thread', data: { postId: 'p1', thread: author('Alice', 'a'),
    recentReplies: [author('Bob', 'b')],
  } });
  assert.match(html, new RegExp(`/photos/${'a'.repeat(64)}\\.png`));
  assert.match(html, new RegExp(`/photos/${'b'.repeat(64)}\\.png`));
});

test('missing and untrusted avatar URLs fall back to escaped initials', () => {
  const urls = [undefined, '/photos/' + 'a'.repeat(64) + '.png', photo('a') + '?other=true',
    photo('a') + '#fragment', 'https://other.example/photos/' + 'a'.repeat(64) + '.png',
    'https://turnfeed.example@other.example/photo.png', 'data:image/png;base64,AA=='];
  for (const url of urls) {
    const html = renderWeb({ kind: 'feed', data: { items: [{ postId: 'p1', authorName: '<Alice>', authorAvatarUrl: url }] } });
    assert.match(html, /<span class="avatar" aria-hidden="true">&lt;<\/span>/);
    assert.doesNotMatch(html, /<img src="(?:\/photos\/|https:|data:)/);
  }
});

test('profile picture mutations use separate signed native forms and leave text editing unchanged', () => {
  const html = renderWeb({ kind: 'profile', signedIn: true, formToken: 'text-token', data: {
    avatarToken: 'picture-token', profile: { displayName: 'Alice', avatarUrl: photo('a'), publicHandle: 'alice', bio: 'Hello.' },
  } });
  const profileForms = forms(html);
  const upload = profileForms.find(form => form.includes('action="/web/avatar"'));
  const removal = profileForms.find(form => form.includes('action="/web/avatar-remove"'));
  const textForm = profileForms.find(form => form.includes('action="/web/profile"'));
  assert.ok(upload && removal && textForm);
  assert.match(upload, /data-composer method="post"[^>]*enctype="multipart\/form-data"/);
  assert.match(upload, /name="token" value="picture-token"/);
  assert.match(upload, /type="file" name="photo" accept="image\/jpeg,image\/png" required/);
  assert.doesNotMatch(upload, /\b(?:multiple|disabled)\b|name="(?:avatarUrl|text)"/);
  assert.match(upload, /1 MiB and 4096 pixels per side/);
  assert.match(upload, /data-photo-preview alt="Selected profile picture preview" hidden/);
  assert.match(upload, /data-photo-remove hidden>Clear selection/);
  assert.match(upload, /data-submit-label>Save picture/);
  assert.match(removal, /data-composer method="post"/);
  assert.match(removal, /name="token" value="picture-token"/);
  assert.doesNotMatch(removal, /type="file"|enctype=|name="avatarUrl"/);
  assert.match(textForm, /name="token" value="text-token"/);
  assert.match(textForm, /name="displayName"/);
  assert.match(textForm, /name="handle"/);
  assert.match(textForm, /name="bio"/);
  assert.match(textForm, /data-composer data-profile-editor/);
  assert.doesNotMatch(textForm, /type="file"|multipart/);
  assert.match(html, /class="avatar avatar-large" aria-hidden="true"><img src="\/photos\//);
  assert.match(html, /mailto:support@example\.com\?subject=Report%20a%20Turnfeed%20profile%20picture/);
});

test('profiles without an owned picture offer upload only; signed-out readers cannot change a picture', () => {
  const signedIn = renderWeb({ kind: 'profile', signedIn: true, data: { avatarToken: 'picture-token', profile: { displayName: 'Alice' } } });
  assert.match(signedIn, /Add profile picture/);
  assert.doesNotMatch(signedIn, /action="\/web\/avatar-remove"/);
  const signedOut = renderWeb({ kind: 'profile', data: { profile: { displayName: 'Alice', avatarUrl: photo('a') } } });
  assert.doesNotMatch(signedOut, /action="\/web\/avatar|type="file"/);
});
