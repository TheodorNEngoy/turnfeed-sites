import { socialText } from './media.mjs';
import { siteOrigin, supportEmail } from './site-config.mjs';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

const e = escapeHtml;
const list = (value) => Array.isArray(value) ? value : [];
const postUrl = (id) => `/post/${encodeURIComponent(String(id ?? ''))}`;
const signInUrl = (path = '/') => `/signin-with-chatgpt?return_to=${encodeURIComponent(path.startsWith('/') && !path.startsWith('//') ? path : '/')}`;
const supportUrl = `mailto:${supportEmail}`;
const tokenField = (token) => `<input type="hidden" name="token" value="${e(token)}">`;
const count = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback;
const logo = '<img src="/turnfeed-logo.png" width="40" height="40" alt="" aria-hidden="true">';
const arrow = `<span aria-hidden="true">↗</span>`;
const trashIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
const deleteLink = (href, label) => `<a class="delete-action" href="${e(href)}" aria-label="${e(label)}">${trashIcon}<span>Delete</span></a>`;

function publicHandle(value) {
  const handle = String(value ?? '').replace(/^@/, '');
  return handle ? `@${e(handle)}` : '';
}

function localPhotoPath(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === siteOrigin
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/photos\/[a-f0-9]{64}\.(?:png|jpg)$/.test(url.pathname)
      // Preserve exact canonical URLs: reject normalization aliases and empty
      // query/fragment delimiters as well as external origins.
      && value === siteOrigin + url.pathname ? url.pathname : '';
  } catch { return ''; }
}

function avatar(name, url, { large = false } = {}) {
  const path = localPhotoPath(url);
  const initial = Array.from(String(name || 'Turnfeed member').trim())[0] || 'T';
  return `<span class="avatar${large ? ' avatar-large' : ''}" aria-hidden="true">${path ? `<img src="${e(path)}" alt="" loading="lazy" decoding="async">` : e(initial)}</span>`;
}

function profileLink(href, content, label = '') {
  return typeof href === 'string' && /^\/(?:person(?:\?|$)|profile(?:\?|$))/.test(href)
    ? `<a class="profile-link" href="${e(href)}"${label ? ` aria-label="${e(label)}"` : ''}>${content}</a>` : content;
}

function likeControl(item, reply = false) {
  const like = item?.webLike;
  if (!like?.token) return '';
  const label = like.liked ? 'Unlike' : 'Like';
  return `<form class="social-action" data-reaction="${reply ? 'reply' : 'post'}" method="post" action="/web/like-${reply ? 'reply' : 'post'}">${tokenField(like.token)}<button class="reaction${like.liked ? ' is-active' : ''}" type="submit" aria-pressed="${Boolean(like.liked)}" aria-label="${label} ${reply ? 'reply' : 'post'}; ${count(like.count)} ${Number(like.count)===1?'like':'likes'}"><svg width="18" height="18" viewBox="0 0 24 24" fill="${like.liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg><span data-reaction-label>${like.liked ? 'Liked' : 'Like'}</span><span class="reaction-count">${count(like.count)}</span></button><span class="reaction-status" data-reaction-status role="status"></span></form>`;
}

function authorHeader(item, { href = '', small = false } = {}) {
  const name = String(item?.authorName || 'Turnfeed member');
  const handle = publicHandle(item?.authorPublicHandle);
  const timestamp = item?.createdAtLabel
    ? (href ? `<a href="${e(href)}">${e(item.createdAtLabel)}</a>` : `<span>${e(item.createdAtLabel)}</span>`)
    : '';
  return `<div class="author${small ? ' author-small' : ''}">${profileLink(item?.webProfileUrl, avatar(name, item?.authorAvatarUrl), `View ${name}’s profile`)}<div class="author-copy"><div class="author-name">${profileLink(item?.webProfileUrl, e(name))}${handle ? `<span class="handle">${profileLink(item?.webProfileUrl, handle)}</span>` : ''}</div>${timestamp ? `<div class="meta">${timestamp}</div>` : ''}</div></div>`;
}

function corrections(history) {
  const entries = list(history).filter((entry) => entry && typeof entry === 'object');
  if (!entries.length) return '';
  return `<details class="corrections"><summary>Correction history <span class="quiet">(${entries.length})</span></summary><ol>${entries.map((entry) => `<li>${entry.correctedAtLabel || entry.correctedAt ? `<p class="meta">Corrected ${e(entry.correctedAtLabel || entry.correctedAt)}</p>` : ''}<p class="post-text">${e(entry.text)}</p>${entry.reason ? `<p class="correction-reason">${e(entry.reason)}</p>` : ''}</li>`).join('')}</ol></details>`;
}

function postPhoto(item) {
  const photo = list(item?.media).find(media => media?.type === 'image' && localPhotoPath(media.url));
  if (!photo) return '';
  // Fetch through this site's guarded photo route, never an external host.
  const path = localPhotoPath(photo.url);
  const description = item?.authorName ? `Photo shared by ${item.authorName}` : 'Photo attached to this post';
  return `<figure class="post-photo"><a class="post-photo-link" href="${e(path)}"><img src="${e(path)}" alt="${e(description)}" loading="lazy" decoding="async"><span class="post-photo-caption">Open photo ${arrow}</span></a></figure>`;
}

function quoteBlock(quote) {
  if (!quote || typeof quote !== 'object') return '';
  if (quote.unavailable) return '<blockquote class="quote"><p class="quiet">The quoted post is no longer available.</p></blockquote>';
  return `<blockquote class="quote">${authorHeader(quote, { small: true })}${socialText(quote.text, { video: false })}${postPhoto(quote)}${corrections(quote.correctionHistory)}</blockquote>`;
}

function postCard(item) {
  const href = postUrl(item?.postId);
  const replies = list(item?.recentReplies);
  return `<article class="card post-card" data-post-id="${e(item?.postId)}">${authorHeader(item, { href })}${socialText(item?.text)}${postPhoto(item)}${quoteBlock(item?.quote)}${corrections(item?.correctionHistory)}${item?.archived ? '<span class="tag">Archived</span>' : ''}${replies.length ? `<div class="reply-previews">${replies.map((reply) => `<div class="reply-preview"><span class="reply-branch" aria-hidden="true">↳</span><div><div class="preview-meta">${avatar(reply?.authorName, reply?.authorAvatarUrl)}<strong>${profileLink(reply?.webProfileUrl, e(reply?.authorName || 'Turnfeed member'))}</strong>${reply?.createdAtLabel ? `<span>${e(reply.createdAtLabel)}</span>` : ''}</div>${socialText(reply?.text, { video: false })}</div></div>`).join('')}</div>` : ''}<div class="card-bottom">${likeControl(item)}${item?.viewerIsAuthor ? deleteLink(`${href}/delete`, 'Delete post') : ''}<a class="text-link" href="${e(href)}">${item?.previewTruncated ? 'Read full post' : 'Open conversation'} ${arrow}</a></div></article>`;
}

function pagination(data, { focus = 'active', postId } = {}) {
  const isFeed=postId===undefined;
  const path=isFeed ? `/?focus=${encodeURIComponent(focus)}` : postUrl(postId);
  if (data?.cursorResetRequired) return `<div class="notice"${isFeed ? ' data-feed-reset' : ''}>This conversation list changed. <a href="${e(path)}">Start from the beginning</a> to see the latest.</div>`;
  if (!data?.hasMore || !data?.nextCursor) return '';
  const href=`${path}${isFeed ? '&' : '?'}cursor=${encodeURIComponent(String(data.nextCursor))}${isFeed ? '' : '#replies'}`;
  return `<nav class="pagination"${isFeed ? ' data-feed-pagination' : ''} aria-label="${isFeed ? 'More conversations' : 'Reply pages'}"><a class="button button-secondary"${isFeed ? ' data-feed-next' : ''} href="${e(href)}">${isFeed ? 'More conversations' : 'More replies'} <span aria-hidden="true">↓</span></a>${isFeed ? '<p class="form-help" data-feed-status role="status"></p>' : ''}</nav>`;
}

function composer({ formToken, draft, reply = false, nestedIndex }) {
  const nested = nestedIndex !== undefined;
  const id = nested ? `nested-reply-${nestedIndex}` : reply ? 'reply-text' : 'post-text';
  const photo = !reply && !nested ? `<div class="photo-picker"><label for="post-photo">Add photo <span class="quiet">(optional)</span></label><input id="post-photo" type="file" name="photo" accept="image/jpeg,image/png" aria-describedby="post-photo-help post-photo-status"><p id="post-photo-help" class="form-help">Choose one JPEG or PNG up to 8 MiB and 32 megapixels. Larger photos are resized before upload; review the prepared preview. Photos are screened before publication.<noscript> Without JavaScript, use an image up to 1 MiB and 4096 pixels per side (16 megapixels total).</noscript> Upload only images you have permission to share.</p><p id="post-photo-status" class="form-help" data-photo-status role="status"></p><img class="photo-preview" data-photo-preview alt="Selected photo preview" hidden><button type="button" class="button-secondary" data-photo-remove hidden>Remove photo</button></div>` : '';
  return `<section class="card composer" aria-labelledby="${id}-label"><form data-composer method="post" action="${nested ? '/web/nested-reply' : reply ? '/web/reply' : '/web/post'}"${photo ? ' enctype="multipart/form-data"' : ''}>${tokenField(formToken)}<label class="composer-label" id="${id}-label" for="${id}">${nested ? 'Your reply' : reply ? 'Join the conversation' : 'What’s on your mind?'}</label><textarea id="${id}" name="text" maxlength="600" required rows="3" placeholder="${reply ? 'Write a thoughtful reply…' : 'Share a thought or start a conversation…'}" aria-describedby="${id}-help">${e(draft)}</textarea>${photo}<div class="composer-bottom"><p class="form-help" id="${id}-help">Your account privacy applies. Replies also depend on who can read the conversation. <a href="/privacy-settings">Check privacy</a>.<br><span data-characters>Up to 600 characters.</span><br>Paste a YouTube or Vimeo link to share a video.</p><button type="submit"><span data-submit-label>${reply ? 'Publish reply' : 'Publish post'}</span> <span aria-hidden="true">↑</span></button></div><p class="form-help composer-status" data-publish-status role="status"></p></form></section>`;
}

function composerEntry(options, label) {
  return `<details class="compose-entry"${options.draft ? ' open' : ''}><summary>${e(label)} <span aria-hidden="true">＋</span></summary>${composer(options)}</details>`;
}

function nestedReplyComposer(reply, index) {
  return `<details class="nested-reply-composer"><summary>Reply to ${e(reply.authorName || 'Turnfeed member')}</summary><blockquote class="quote" aria-label="Reply you are responding to"><p class="post-text">${e(reply.text)}</p></blockquote>${composer({ formToken: reply.webReplyToken, reply: true, nestedIndex: index })}</details>`;
}

function signInCard({ reply = false, returnPath = '/' } = {}) {
  return `<section class="card signin-card"><div><h2>${reply ? 'Add your voice' : 'A place for your next thought'}</h2><p>Sign in with ChatGPT to ${reply ? 'reply to this conversation' : 'publish posts and join the conversation'}.</p></div><a class="button" href="${e(signInUrl(returnPath))}" target="_top">Sign in with ChatGPT ${arrow}</a></section>`;
}

function emptyFeed(signedIn, profile = false) {
  return `<section class="card empty"><div class="empty-mark" aria-hidden="true">${logo}</div><h2>${profile ? 'Your story starts here' : 'A little quiet, for now'}</h2><p>${profile ? 'Your posts will appear here. Share a thought with the feed to start a conversation.' : signedIn ? 'A thought, a question, something worth sharing. Your post can start the first conversation.' : 'There are no posts to read yet. Sign in with ChatGPT to start a conversation.'}</p>${profile ? '<a class="text-link" href="/">Go to the feed <span aria-hidden="true">→</span></a>' : ''}</section>`;
}

function codexHint() {
  return `<details class="codex-hint"><summary>Use Turnfeed alongside Codex</summary><p>Ask Codex: <span class="codex-prompt">“Open ${e(siteOrigin)}/ in the sidebar.”</span></p><p>Then sign in with ChatGPT. Discuss posts privately in your Codex chat, and ask Codex to help write a reply. Review it, then ask Codex to publish it.</p></details>`;
}

function feedView({ data, signedIn, formToken, draft, focus, returnPath }) {
  const items = list(data.items);
  return `<header class="page-heading"><h1>Shared feed<span class="heading-dot">.</span></h1><p>${signedIn ? 'Conversations you can read.' : 'A social feed. Sign in with ChatGPT to join in.'}</p></header>${codexHint()}${signedIn ? composerEntry({ formToken, draft }, 'Create a post') : signInCard({ returnPath })}<div class="feed-heading"><nav class="tabs" aria-label="Feed order"><a href="/?focus=active"${focus === 'active' ? ' aria-current="page"' : ''}>Active</a><a href="/?focus=latest"${focus === 'latest' ? ' aria-current="page"' : ''}>Latest</a></nav></div><section class="feed" data-scroll-feed data-feed-viewer="${e(data.webFeedViewer)}" aria-label="Conversations">${items.length ? items.map(postCard).join('') : emptyFeed(signedIn)}</section>${pagination(data, { focus })}`;
}

function threadView({ data, signedIn, formToken, draft, returnPath }) {
  const thread = data.thread || {};
  const replies = list(data.recentReplies);
  const replyCount = count(data.totalReplyCount, replies.length);
  const href = postUrl(data.postId);
  const replyEntry = thread.archived ? '<div class="notice">This conversation is archived. New replies are closed.</div>'
    : signedIn ? (data.replyHandoff ? composerEntry({ formToken, draft, reply: true }, 'Reply to this post') : '<div class="notice">Replies are unavailable for this conversation.</div>')
    : signInCard({ reply: true, returnPath: returnPath || href });
  return `<a class="back-link" href="/"><span aria-hidden="true">←</span> Back to feed</a><header class="page-heading compact"><h1>Conversation<span class="heading-dot">.</span></h1></header><article class="card thread-post">${authorHeader(thread)}${socialText(thread.text)}${postPhoto(thread)}${quoteBlock(thread.quote)}${corrections(thread.correctionHistory)}<div class="thread-actions">${likeControl(thread)}${thread.archived ? '<span class="tag">Archived</span>' : '<span class="quiet">Shared on Turnfeed</span>'}<div class="content-links">${data.viewerOwnsTarget && signedIn ? deleteLink(`${href}/delete`, 'Delete post') : ''}${signedIn && !data.viewerOwnsTarget && data.webActionsUrl ? `<a href="${e(data.webActionsUrl)}">Post options</a>` : !signedIn ? `<a href="${supportUrl}?subject=${encodeURIComponent('Report a Turnfeed post')}">Report to support</a>` : ''}</div></div></article>${replyEntry}<section id="replies" aria-labelledby="replies-heading"><div class="section-heading"><h2 id="replies-heading">Replies <span class="count">${replyCount}</span></h2></div>${replies.length ? `<div class="card replies">${replies.map((reply, index) => `<article class="reply">${authorHeader(reply, { small: true })}${reply?.replyToAuthorName ? `<p class="reply-to">Replying to ${e(reply.replyToAuthorName)}</p>` : ''}${socialText(reply?.text)}${corrections(reply?.correctionHistory)}${likeControl(reply, true)}${signedIn && reply?.webReplyToken && !thread.archived && !reply.archived && !reply.unavailable ? nestedReplyComposer(reply, index) : ''}${signedIn && reply.webActionsUrl ? (reply.viewerIsAuthor ? deleteLink(reply.webActionsUrl, 'Delete reply') : `<a class="reply-options" href="${e(reply.webActionsUrl)}">Reply options</a>`) : ''}</article>`).join('')}</div>` : `<div class="card empty empty-small"><h3>${replyCount ? 'No replies on this page' : 'Room for a first reply'}</h3><p>${thread.archived ? 'There are no replies to display.' : 'A good conversation starts with someone joining in.'}</p></div>`}${pagination(data, { postId: data.postId })}</section>`;
}

function avatarEditor(profile, token) {
  const currentPicture = localPhotoPath(profile.avatarUrl);
  return `<section class="card profile-edit" aria-labelledby="profile-picture-heading"><div class="section-intro"><h2 id="profile-picture-heading">Profile picture</h2><p>Your picture appears beside your posts and replies. On a private account, only approved followers can see it.</p></div><form data-composer method="post" data-photo-kind="avatar" action="/web/avatar" enctype="multipart/form-data">${tokenField(token)}<div class="photo-picker"><label for="profile-photo">${currentPicture ? 'Change' : 'Add'} profile picture</label><input id="profile-photo" type="file" name="photo" accept="image/jpeg,image/png" required aria-describedby="profile-photo-help profile-photo-status"><p id="profile-photo-help" class="form-help">Choose one JPEG or PNG up to 8 MiB and 32 megapixels. Pictures are resized to 512 pixels, screened before publication and displayed in a circle.<noscript> Without JavaScript, use an image up to 1 MiB and 4096 pixels per side (16 megapixels total).</noscript> Choose a picture you have permission to share.</p><p id="profile-photo-status" class="form-help" data-photo-status role="status"></p><img class="photo-preview avatar-preview" data-photo-preview alt="Selected profile picture preview" hidden><button type="button" class="button-secondary" data-photo-remove hidden>Clear selection</button></div><div class="form-actions"><button type="submit"><span data-submit-label>Save picture</span></button></div><p class="form-help composer-status" data-publish-status role="status"></p></form>${currentPicture ? `<form class="avatar-remove" data-composer method="post" action="/web/avatar-remove">${tokenField(token)}<button class="button-secondary" type="submit"><span data-submit-label>Remove current picture</span></button><p class="form-help composer-status" data-publish-status role="status"></p></form>` : ''}<p class="form-help avatar-report"><a href="${supportUrl}?subject=${encodeURIComponent('Report a Turnfeed profile picture')}">Report a profile picture to support</a></p></section>`;
}

function profileView({ data, signedIn, formToken }) {
  const profile = data.profile || {};
  const draft = data.profileDraft || { displayName: profile.displayName, handle: String(profile.publicHandle || '').replace(/^@/, ''), bio: profile.bio };
  const displayName = profile.displayName || 'Your profile';
  const handle = publicHandle(profile.publicHandle);
  const items = list(data.items);
  return `<header class="page-heading"><div class="eyebrow">Your corner of Turnfeed</div><h1>My profile<span class="heading-dot">.</span></h1><p>${profile.privateAccount ? 'Private account · Your content is limited to approved followers.' : 'Public account · Anyone can read your content.'}</p><p><a href="/privacy-settings">Privacy and followers</a> · <a href="/preferences">Muted and blocked</a></p></header><section class="card profile-card" aria-labelledby="profile-name"><div class="profile-identity">${avatar(displayName, profile.avatarUrl, { large: true })}<div><h2 id="profile-name">${e(displayName)}</h2>${handle ? `<p class="handle">${handle}</p>` : ''}</div></div>${profile.bio ? `<p class="post-text profile-bio">${e(profile.bio)}</p>` : ''}<dl class="profile-counts"><div><dt>Posts</dt><dd>${count(profile.postCount)}</dd></div><div><dt><a href="/privacy-settings#followers">Followers</a></dt><dd><a href="/privacy-settings#followers">${count(profile.followerCount)}</a></dd></div><div><dt><a href="/following">Following</a></dt><dd><a href="/following" aria-label="${count(profile.followingCount)} ${Number(profile.followingCount)===1?'person':'people'} you follow">${count(profile.followingCount)}</a></dd></div></dl></section>${signedIn ? `${avatarEditor(profile, data.avatarToken)}<section class="card profile-edit" aria-labelledby="profile-edit-heading"><div class="section-intro"><h2 id="profile-edit-heading">Edit profile</h2><p>Your name and handle are public. On a private account, your bio and picture are limited to approved followers.</p></div><form data-composer data-profile-editor method="post" action="/web/profile">${tokenField(formToken)}<div class="form-field"><label for="display-name">Display name</label><input id="display-name" name="displayName" type="text" maxlength="32" data-saved-value="${e(profile.displayName)}" value="${e(draft.displayName)}" autocomplete="nickname" aria-describedby="display-name-help"><p id="display-name-help" class="form-help">Up to 32 characters. Letters such as ø, æ and å are welcome.</p></div><div class="form-field"><label for="public-handle">Public handle</label><div class="handle-input"><span aria-hidden="true">@</span><input id="public-handle" name="handle" type="text" maxlength="20" pattern="\\s*@?[A-Za-z0-9_]{3,20}\\s*" title="Use 3–20 characters: a–z, 0–9 and underscores." data-saved-value="${e(String(profile.publicHandle || '').replace(/^@/,''))}" value="${e(draft.handle)}"${data.profileErrorField === 'handle' ? ' aria-invalid="true" autofocus' : ''} autocapitalize="none" spellcheck="false" aria-describedby="public-handle-help"></div><p id="public-handle-help" class="form-help">Optional. Use 3–20 characters: a–z, 0–9 and underscores. Use your display name for letters such as ø, æ and å.</p></div><div class="form-field"><label for="bio">Bio</label><textarea id="bio" name="bio" data-saved-value="${e(profile.bio)}" maxlength="160" rows="3" aria-describedby="bio-help">${e(draft.bio)}</textarea><p id="bio-help" class="form-help">A little about you. Up to 160 characters.</p></div><div class="form-actions"><button type="submit"><span data-submit-label>Save profile</span></button></div><p class="form-help composer-status" data-publish-status role="status"></p></form></section>` : signInCard()}<section aria-labelledby="your-posts-heading"><div class="section-heading"><h2 id="your-posts-heading">Your posts</h2></div><div class="feed">${items.length ? items.map(postCard).join('') : emptyFeed(signedIn, true)}</div></section>`;
}

function publicProfileView({ data, signedIn, returnPath }) {
  const profile = data.profile || {};
  const name = profile.displayName || 'Turnfeed member';
  const handle = publicHandle(profile.publicHandle);
  const follow = profile.webFollow || data.webFollow;
  const items = list(data.items);
  const locked=profile.privateAccount===true && profile.viewerCanReadContent!==true;
  const followLabel=follow?.following?'Unfollow':follow?.requested?'Cancel request':follow?.privateAccount?'Request to follow':'Follow';
  return `<a class="back-link" href="/">← Back to feed</a><header class="page-heading compact"><h1>Profile<span class="heading-dot">.</span></h1></header><section class="card profile-card" aria-labelledby="profile-name"><div class="profile-identity">${avatar(name, profile.avatarUrl, { large: true })}<div><h2 id="profile-name">${e(name)}</h2>${handle ? `<p class="handle">${handle}</p>` : ''}${profile.privateAccount ? '<span class="tag">Private account</span>' : ''}</div></div>${profile.bio ? `<p class="post-text profile-bio">${e(profile.bio)}</p>` : ''}${locked ? '' : `<dl class="profile-counts"><div><dt>Posts</dt><dd>${count(profile.postCount)}</dd></div><div><dt>${profile.webConnections ? `<a href="${e(profile.webConnections.followers)}">Followers</a>` : 'Followers'}</dt><dd>${profile.webConnections ? `<a href="${e(profile.webConnections.followers)}" data-follower-count aria-label="View followers of ${e(name)}">${count(profile.followerCount)}</a>` : `<span data-follower-count>${count(profile.followerCount)}</span>`}</dd></div><div><dt>${profile.webConnections ? `<a href="${e(profile.webConnections.following)}">Following</a>` : 'Following'}</dt><dd>${profile.webConnections ? `<a href="${e(profile.webConnections.following)}" aria-label="View people ${e(name)} follows">${count(profile.followingCount)}</a>` : count(profile.followingCount)}</dd></div></dl>`}${follow?.token ? `<form class="follow-form" data-follow data-follow-name="${e(name)}" method="post" action="/web/follow">${tokenField(follow.token)}<button class="${follow.following || follow.requested ? 'button-secondary' : ''}" type="submit" aria-label="${followLabel} ${e(name)}">${followLabel}</button><span class="form-help" data-follow-status role="status">${follow.following ? 'You follow this person.' : follow.requested ? 'Your follow request is pending.' : ''}</span></form>` : !signedIn ? `<a class="button profile-signin" href="${e(signInUrl(returnPath))}">Sign in to follow</a>` : ''}${list(profile.webPeopleActions).length ? `<details class="corrections profile-controls"><summary>Mute or block ${e(name)}</summary><p class="form-help">Mute hides this person from your default feed and Activity. Block also prevents interactions and removes follows, past notifications and shared private-group access. Unblocking does not restore them.</p>${list(profile.webPeopleActions).map(item=>`<form method="post" action="/web/person-${e(item.action)}">${tokenField(item.token)}<button class="${item.action==='block'?'button-danger':'button-secondary'}" type="submit">${item.action==='block'?'Block':'Mute'} ${e(name)}</button></form>`).join('')}<p class="form-help">Undo mutes and blocks in <a href="/preferences">Muted and blocked</a> under My profile.</p></details>` : ''}</section><section aria-labelledby="public-posts-heading"><div class="section-heading"><h2 id="public-posts-heading">Posts</h2></div><div class="feed">${locked ? '<div class="card empty"><h2>This account is private</h2><p>Request to follow to see their posts, replies, bio and photos.</p></div>' : items.length ? items.map(postCard).join('') : '<div class="card empty"><h2>No posts here yet</h2><p>Visible posts from this person will appear here.</p></div>'}</div></section>${data.nextUrl ? `<nav class="pagination"><a class="button button-secondary" href="${e(data.nextUrl)}">More posts ↓</a></nav>` : ''}`;
}

function connectionsView({ data }) {
  const name=data.profile?.displayName || 'Turnfeed member', following=data.kind==='following';
  const title=following?'Following':'Followers';
  return `<a class="back-link" href="${e(data.webProfileUrl)}">← Back to ${e(name)}’s profile</a><header class="page-heading compact"><h1>${title}<span class="heading-dot">.</span></h1><p>${following?`People ${e(name)} follows.`:`People following ${e(name)}.`}</p></header><nav class="tabs" aria-label="Profile people"><a href="${e(data.webConnections.followers)}"${following?'':' aria-current="page"'}>Followers</a><a href="${e(data.webConnections.following)}"${following?' aria-current="page"':''}>Following</a></nav><section class="card control-section" aria-label="${title}"><ul class="people-list">${list(data.items).map(person=>`<li><div class="connection-person">${profileLink(person.webProfileUrl,avatar(person.displayName,person.avatarUrl),`View ${person.displayName || 'member'}’s profile`)}<div><strong>${profileLink(person.webProfileUrl,e(person.displayName || 'Turnfeed member'))}</strong>${person.publicHandle?`<div class="handle">${profileLink(person.webProfileUrl,publicHandle(person.publicHandle))}</div>`:''}</div></div>${person.webProfileUrl?`<a class="text-link" href="${e(person.webProfileUrl)}" aria-label="Open ${e(person.displayName || 'member')}’s profile">View profile ${arrow}</a>`:''}</li>`).join('') || `<li>No ${following?'following accounts':'followers'} visible to you.</li>`}</ul></section>${data.nextUrl?`<nav class="pagination"><a class="button button-secondary" href="${e(data.nextUrl)}">More people ↓</a></nav>`:''}<p class="form-help">Only people visible to you are shown.</p>`;
}

function followingView({ data }) {
  return `<a class="back-link" href="/profile">← My profile</a><header class="page-heading"><h1>Following<span class="heading-dot">.</span></h1><p>People you follow on Turnfeed.</p></header><section class="card control-section"><ul class="people-list">${list(data.items).map(person => `<li><div><strong>${profileLink(person.webProfileUrl, e(person.displayName || 'Turnfeed member'))}</strong>${person.publicHandle ? `<div class="handle">${profileLink(person.webProfileUrl, publicHandle(person.publicHandle))}</div>` : ''}</div>${person.webFollow?.token ? `<form data-follow data-follow-name="${e(person.displayName || 'this person')}" method="post" action="/web/follow">${tokenField(person.webFollow.token)}<button class="button-secondary" type="submit" aria-label="Unfollow ${e(person.displayName || 'this person')}">Unfollow</button><span class="form-help" data-follow-status role="status"></span></form>` : ''}</li>`).join('') || '<li>You haven’t followed anyone yet. Open someone’s profile from a post to follow them.</li>'}</ul></section>${data.nextUrl ? `<nav class="pagination"><a class="button button-secondary" href="${e(data.nextUrl)}">More people ↓</a></nav>` : ''}`;
}

function deleteView({ data, signedIn, formToken }) {
  const thread = data.thread || {};
  const href = postUrl(data.postId);
  return `<a class="back-link" href="${e(href)}"><span aria-hidden="true">←</span> Back to conversation</a><header class="page-heading compact"><div class="eyebrow">One last check</div><h1>Delete this post?</h1><p>This deletes this post and all replies. This cannot be undone.</p></header><article class="card deletion-preview" aria-label="Post to delete">${authorHeader(thread)}${socialText(thread.text)}${postPhoto(thread)}${quoteBlock(thread.quote)}${corrections(thread.correctionHistory)}</article><section class="card delete-confirm">${signedIn && data.viewerOwnsTarget ? `<form method="post" action="/web/delete">${tokenField(formToken)}<p>Delete the post shown above and every reply in this conversation?</p><div class="form-actions"><a class="button button-secondary" href="${e(href)}">Cancel</a><button class="button-danger" type="submit">${trashIcon} Delete post and all replies</button></div></form>` : `<p>You can only delete your own posts while signed in.</p><a class="button button-secondary" href="${e(href)}">Back to conversation</a>`}</section>`;
}

function activityView({ data, filter }) {
  const notifications = list(data.notifications);
  const selected = data.filter || filter;
  const labels = { reply_to_post: 'replied to your post', reply_to_reply: 'replied to your reply', mention_post: 'mentioned you in a post', mention_reply: 'mentioned you in a reply', like_post: 'liked your post', like_reply: 'liked your reply', follow: 'followed you' };
  return `<header class="page-heading"><h1>Activity<span class="heading-dot">.</span></h1><p>Replies, mentions and other activity for you.</p><p><a href="/privacy-settings#requests">Review follow requests</a></p></header><div class="feed-heading"><nav class="tabs" aria-label="Activity filter"><a href="/activity"${selected === 'all' ? ' aria-current="page"' : ''}>All</a><a href="/activity?filter=replies"${selected === 'replies' ? ' aria-current="page"' : ''}>Replies &amp; mentions</a></nav></div>${data.cursorResetRequired ? '<div class="notice">Your activity changed. <a href="/activity">Open the latest activity</a>.</div>' : ''}<section aria-label="Your activity">${notifications.length ? notifications.map(item => `<article class="card activity-item"><div class="activity-header"><h2>${profileLink(item.webProfileUrl, e(item.actorName || 'A Turnfeed member'))} ${e(labels[item.type] || 'interacted with you')}</h2><span class="meta">${e(item.createdAtLabel)}</span></div>${item.actorPublicHandle ? `<p class="handle">${publicHandle(item.actorPublicHandle)}</p>` : ''}${item.text ? `<p class="post-text">${e(item.text)}</p>` : ''}${item.webThreadUrl ? `<a class="text-link" href="${e(item.webThreadUrl)}">Open conversation ${arrow}</a>` : ''}</article>`).join('') : '<div class="card empty"><h2>No activity here yet</h2><p>When someone replies or mentions you, check here to pick up the conversation.</p></div>'}</section>${data.hasMore && data.nextUrl ? `<nav class="pagination" aria-label="Activity pages"><a class="button button-secondary" href="${e(data.nextUrl)}">More activity ↓</a></nav>` : ''}<p class="form-help activity-note">The New activity indicator checks while this page is visible. Open Activity to see new items. It is local to this browser tab; push and email notifications are not enabled.</p>`;
}

function controlsView({ data }) {
  const item = data.item || {};
  const href = postUrl(data.postId);
  return `<a class="back-link" href="${e(href)}">← Back to conversation</a><header class="page-heading compact"><h1>${data.isReply && data.viewerOwnsTarget ? 'Delete this reply?' : `${data.isReply ? 'Reply' : 'Post'} options`}</h1><p>Review the content before choosing an action.</p></header><article class="card deletion-preview">${authorHeader(item)}<p class="post-text">${e(item.text)}</p></article>${list(data.actions).map((action, index) => `<section class="card control-section"><h2>${e(action.label)}</h2><p>${e(action.description)}</p><form method="post" action="/web/${e(action.action)}">${tokenField(action.token)}${action.action === 'report' ? `<label for="report-reason-${index}">Reason for this report</label><select id="report-reason-${index}" name="reason" required><option value="" disabled selected>Choose a reason</option>${list(data.reportReasons).map(reason => `<option value="${e(reason.value)}">${e(reason.label)}</option>`).join('')}</select>` : ''}<button${action.action === 'delete-reply' || action.action === 'block' ? ' class="button-danger"' : ''} type="submit">${action.action === 'delete-reply' ? trashIcon + ' ' : ''}${e(action.label)}</button></form></section>`).join('') || '<div class="notice">No actions are available for this content.</div>'}`;
}

function preferencesView({ data }) {
  const section = (key, title, description, action, label) => `<section class="card control-section"><h2>${title}</h2><p>${description}</p><ul class="people-list">${list(data[key]).map(person => `<li><div><strong>${e(person.displayName || 'Turnfeed member')}</strong>${person.publicHandle ? `<div class="handle">${publicHandle(person.publicHandle)}</div>` : ''}</div><form method="post" action="/web/${action}">${tokenField(person.token)}<button class="button-secondary" type="submit">${label}</button></form></li>`).join('') || '<li>No people on this page.</li>'}</ul>${data[`${key}NextUrl`] ? `<nav class="pagination"><a class="text-link" href="${e(data[`${key}NextUrl`])}">More ${key} people ↓</a></nav>` : ''}</section>`;
  return `<a class="back-link" href="/profile">← My profile</a><header class="page-heading"><h1>Muted and blocked<span class="heading-dot">.</span></h1><p>Manage the people you have muted or blocked.</p></header>${section('muted', 'Muted people', 'Muting quiets someone in your default feed and Activity. It does not block access.', 'unmute', 'Unmute')}${section('blocked', 'Blocked people', 'Unblocking allows interactions and visible content to return, subject to the other person’s settings.', 'unblock', 'Unblock')}<p class="form-help activity-note">To mute or block someone, open their profile and choose Mute or block. These actions are also available under Post options or Reply options.</p>`;
}

function privacySettingsView({data}) {
  const people=(items,empty)=>`<ul class="people-list">${list(items).map(person=>`<li><div><strong>${profileLink(person.webProfileUrl,e(person.displayName || 'Turnfeed member'))}</strong>${person.publicHandle?`<div class="handle">${publicHandle(person.publicHandle)}</div>`:''}</div><div class="follower-actions">${list(person.actions).map(item=>`<form data-composer data-account-control method="post" action="/web/follower">${tokenField(item.token)}<button class="${item.action==='accept'?'':'button-secondary'}" type="submit"><span data-submit-label>${item.action==='accept'?'Approve':item.action==='reject'?'Decline':'Remove'}</span></button><p class="form-help" data-publish-status role="status"></p></form>`).join('')}</div></li>`).join('') || `<li>${empty}</li>`}</ul>`;
  return `<a class="back-link" href="/profile">← My profile</a><header class="page-heading"><h1>Privacy and followers<span class="heading-dot">.</span></h1><p>Choose who can see your Turnfeed content.</p></header><section class="card control-section"><h2>Account privacy</h2><p>Your account is currently <strong>${data.privateAccount?'private':'public'}</strong>.</p><form data-composer data-account-control method="post" action="/web/privacy">${tokenField(data.privacyToken)}<label for="account-privacy">Who can read your content?</label><select id="account-privacy" name="privateAccount"><option value="false"${!data.privateAccount?' selected':''}>Public — anyone</option><option value="true"${data.privateAccount?' selected':''}>Private — approved followers</option></select><p class="form-help">Private mode applies to existing and new posts, replies, photos, your bio and profile picture. Your name and handle stay public. Replies also require access to their conversation.</p><p class="form-help">Your ${count(data.followerCount)} existing ${Number(data.followerCount)===1?'follower keeps':'followers keep'} access when you switch to private. Remove anyone below to revoke their access. Changing to public makes your content visible to everyone; pending requests are cleared.</p><p class="form-help">People may have saved content they could already read. Moderators can still review reported content.</p><button type="submit"><span data-submit-label>Save privacy</span></button><p class="form-help" data-publish-status role="status"></p></form></section><section id="requests" class="card control-section"><h2>Follow requests <span class="count">${count(data.requestCount)}</span></h2><p>Approve someone to let them read your private content.</p>${people(data.requests,'No pending requests on this page.')}</section><section id="followers" class="card control-section"><h2>Followers <span class="count">${count(data.followerCount)}</span></h2><p>Removing a follower revokes private-account access. It does not stop them reading public content or requesting again; use Block for that.</p>${people(data.followers,'No followers on this page.')}</section>${data.nextUrl?`<nav class="pagination"><a class="button button-secondary" href="${e(data.nextUrl)}">More people ↓</a></nav>`:''}`;
}

function errorView({ error, draft, returnPath }) {
  const conversationPath = /^\/post\/[A-Za-z0-9_-]{1,64}$/.test(returnPath || '') ? returnPath : '';
  return `<header class="page-heading"><div class="eyebrow">A pause in the conversation</div><h1>Something went wrong.</h1></header><section class="card error-card"><p role="alert">${e(error || 'Turnfeed could not complete this request.')}</p>${draft ? `<div class="saved-draft"><h2>Your draft</h2><p class="quiet">Copy this text before leaving this page.</p><pre class="post-text">${e(draft)}</pre></div>` : ''}<a class="button button-secondary" href="${e(conversationPath || (['/profile','/privacy-settings'].includes(returnPath) ? returnPath : '/'))}">${conversationPath ? 'Back to conversation' : returnPath === '/profile' ? 'Back to My profile' : returnPath === '/privacy-settings' ? 'Back to privacy and followers' : 'Back to feed'}</a></section>`;
}

const styles = `
.composer-status:empty{display:none}
.composer-status{margin:12px 0 0}
[data-composer] button:disabled{opacity:.7;cursor:wait}
.photo-picker{margin-top:18px;min-width:0}
.photo-picker>label{display:block;font-size:15px;font-weight:650;margin-bottom:7px}
.photo-picker input[type=file]{display:block;width:100%;min-width:0;max-width:100%;font-size:16px;padding:8px;min-height:44px;overflow-wrap:anywhere}
.photo-picker input[type=file]::file-selector-button{font:inherit;padding:7px 10px;margin-right:10px;border:1px solid var(--line);border-radius:6px;background:var(--soft);color:var(--ink);cursor:pointer}
.photo-picker .form-help{margin-top:7px;overflow-wrap:anywhere}
.photo-picker [data-photo-status]:empty{display:none}
.photo-preview{display:block;max-width:100%;max-height:260px;object-fit:contain;margin:12px 0;border:1px solid var(--line);border-radius:9px}
.photo-picker [hidden]{display:none}
[data-characters]{font-variant-numeric:tabular-nums}
.nested-reply-composer{margin:14px 0 0}
.nested-reply-composer summary{cursor:pointer;font-size:15px;color:#566249;overflow-wrap:anywhere}
.nested-reply-composer .composer{border:0;box-shadow:none;background:none;padding:0;margin:14px 0 0}
.nested-reply-composer .composer-label{font-size:16px}
.nested-reply-composer .quote{margin:14px 0}

.brand-mark img,.empty-mark img{display:block;width:100%;height:100%;object-fit:contain;border-radius:7px}


:root{color-scheme:light;--paper:#f7f6f2;--card:#fff;--ink:#272820;--muted:#5f6757;--line:#e6e7df;--orange:#c94f20;--orange-pale:#fbede4;--soft:#f5f5f0;--radius:17px}

*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-underline-offset:4px}
button,input,textarea{font:inherit}
button,a,input,textarea,summary{-webkit-tap-highlight-color:transparent}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #a43f19;outline-offset:4px}
a:hover{color:var(--orange)}
button{cursor:pointer}
p,h1,h2,h3{margin:0}
h1{font-size:37px;line-height:1.15;letter-spacing:-1.5px;font-weight:720}
h2{font-size:18px;line-height:1.35;letter-spacing:-.3px}
h3{font-size:17px;line-height:1.4}
svg{display:block;width:100%;height:100%}
.skip-link{position:fixed;top:-100px;left:16px;z-index:5;background:var(--ink);color:#fff;padding:10px 18px;border-radius:8px}
.skip-link:focus{top:12px}
.shell{display:grid;grid-template-columns:186px minmax(0,720px);gap:48px;max-width:1026px;margin:0 auto;padding:48px 32px 28px;align-items:start}
.site-header{position:sticky;top:42px;min-width:0}
.brand{display:flex;gap:9px;align-items:center;text-decoration:none;font-size:25px;letter-spacing:-1px;font-weight:760;width:fit-content}
.brand-mark{height:33px;width:30px;color:var(--orange);flex:none}
.preview-label{display:inline-block;color:var(--muted);border:1px solid #dedfd5;font-size:13px;font-weight:650;line-height:1.5;letter-spacing:.06em;border-radius:5px;padding:2px 6px;margin:11px 0 29px 40px}
.main-nav{display:flex;flex-direction:column;gap:7px}
.main-nav a{display:flex;gap:10px;align-items:center;text-decoration:none;border-radius:10px;padding:11px 13px;font-size:16px;font-weight:570}
.main-nav a[aria-current=page]{background:#e9ece2;color:#303c27}
.nav-icon{font-size:18px;line-height:1;width:18px;text-align:center}
.account-link{display:block;font-size:14px;color:#5a5e51;margin:27px 13px 0}
.sidebar-note{border-top:1px solid var(--line);margin:37px 13px 0;padding-top:20px;font-size:14px;line-height:1.75;color:var(--muted);max-width:174px}
.sidebar-note strong{font-weight:550;color:#4e5646}
main{min-width:0}
.page-heading{margin:2px 0 29px}
.page-heading .eyebrow{margin-bottom:10px}
.eyebrow{color:var(--muted);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.13em}
.heading-dot{color:var(--orange)}
.page-heading>p{color:#666b5e;font-size:16px;margin-top:11px}
.page-heading.compact{margin:12px 0 18px}
.page-heading.compact h1{font-size:32px}
.codex-hint{margin:-12px 0 20px;border:1px solid var(--line);border-radius:12px;background:#eef0e8;color:var(--muted);font-size:14px}
.codex-hint>summary{cursor:pointer;min-height:44px;padding:10px 14px;color:#45503b;font-weight:600;overflow-wrap:anywhere}
.codex-hint p{margin:0 14px 12px;overflow-wrap:anywhere}
.codex-prompt{display:block;margin-top:5px;color:var(--ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 2px 5px #26301503}
.composer{padding:22px 24px;margin-bottom:28px}
.composer-label{display:block;font-weight:650;font-size:16px;letter-spacing:-.2px;margin-bottom:13px}
textarea,input{border:1px solid #dfe1d7;color:var(--ink);background:#fcfcfa;border-radius:9px;padding:11px 12px;display:block;width:100%}
textarea{resize:vertical;min-height:90px;line-height:1.6}
textarea::placeholder{color:#5f6757}
input:hover,textarea:hover{border-color:#b9beaf}
.composer textarea{border:0;background:var(--soft);padding:13px 15px;min-height:111px;font-size:16px}
.composer-bottom{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:15px;flex-wrap:wrap}
.form-help{font-size:13px;line-height:1.65;color:#69705f}
.form-help span{color:#5f6757}
.button,button{display:inline-flex;align-items:center;justify-content:center;gap:12px;border:1px solid transparent;border-radius:9px;padding:10px 15px;font-size:15px;font-weight:650;line-height:1.5;background:var(--ink);color:#fff;text-decoration:none;flex-shrink:0;min-height:44px}
.button:hover,button:hover{background:#444b38;color:#fff}
.button-secondary{background:#f4f5ef;color:#3e4536;border-color:#dfe3d6}
.button-secondary:hover{background:#e9eddf;color:#283421}
.button-danger{background:#a53524}
.button-danger:hover{background:#812516}
.signin-card{padding:24px;display:flex;gap:20px;align-items:center;justify-content:space-between;margin-bottom:28px;background:#fdfaf5;flex-wrap:wrap}
.signin-card h2{font-size:16px}
.signin-card p{font-size:14px;color:var(--muted);margin-top:7px;max-width:280px}
.feed-heading{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dedfd6;margin:0 0 18px;flex-wrap:wrap}
.tabs{display:flex;gap:25px}
.tabs a{font-size:15px;font-weight:600;padding:0 3px 11px;text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px;color:var(--muted)}
.tabs a[aria-current=page]{color:var(--ink);border-bottom-color:var(--orange)}
.feed-hint{font-size:13px;color:#5f6757;padding-bottom:10px}
.feed{display:flex;flex-direction:column;gap:16px}
.post-card,.thread-post,.deletion-preview{padding:23px 25px}
.author{display:flex;align-items:center;gap:10px;margin-bottom:17px;min-width:0}
.avatar{width:37px;height:37px;border-radius:50%;background:#edf0e6;border:1px solid #e5e9dc;color:#5a644b;display:grid;grid-template:minmax(0,1fr)/minmax(0,1fr);place-items:center;flex:none;font-size:17px;font-weight:650;overflow:hidden}
.avatar img{display:block;width:100%;height:100%;min-width:0;min-height:0;object-fit:cover;border-radius:inherit}
.author-copy{min-width:0}
.profile-link{color:inherit;text-decoration:none}
.profile-link:hover{text-decoration:underline;text-underline-offset:3px}
.author>.profile-link{flex:none}
.social-action{display:inline-flex;margin:0}
.reaction{background:transparent;color:var(--muted);border:1px solid var(--line);padding:7px 11px;font-size:14px;gap:7px;min-height:44px}
.reaction svg{width:18px;height:18px;flex:none}
button.reaction{white-space:nowrap;overflow-wrap:normal}
.reaction:hover{background:var(--soft);color:var(--ink)}
.reaction.is-active{background:#fbede7;color:#963c22;border-color:#eed2c5}
.reaction-count{font-variant-numeric:tabular-nums}
.reply>.social-action{margin:13px 12px 0 0}
.follower-actions{display:flex;gap:8px;flex-wrap:wrap}.follower-actions form{margin:0}.follower-actions .form-help:empty{display:none}
.follow-form{display:flex;align-items:center;gap:14px;margin-top:21px;flex-wrap:wrap}
.profile-signin{margin-top:21px}
.author-name{font-size:15px;font-weight:650;line-height:1.45;overflow-wrap:anywhere}
.handle{font-size:13px;font-weight:400;color:#5f6757;margin-left:8px;overflow-wrap:anywhere}
.meta{font-size:13px;color:#5f6757;line-height:1.5;margin-top:2px}
.meta a{text-decoration:none}
.meta a:hover{text-decoration:underline}
.post-text{font-size:17px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-family:inherit}
.thread-post>.post-text{font-size:19px;line-height:1.8}
.quote{margin:19px 0 2px;background:#f8f9f4;border:1px solid #e5e9dc;border-left:3px solid #c6cfb8;border-radius:9px;padding:16px}
.quote .post-text{font-size:17px}
.author-small{margin-bottom:10px;gap:9px}
.author-small .avatar{height:28px;width:28px;font-size:14px}
.author-small .author-name{font-size:15px}
.quote .author-small .avatar{height:25px;width:25px;font-size:13px}
.quote .quiet{font-size:14px}
.card-bottom{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:18px}
.text-link{color:#566249;text-decoration:none;font-size:15px;font-weight:650;display:inline-flex;align-items:center;gap:11px}
.text-link:hover{text-decoration:underline}
.reply-previews{margin-top:19px;border-top:1px solid #edf0e6;padding-top:14px;display:flex;flex-direction:column;gap:12px}
.reply-preview{display:flex;gap:10px;min-width:0}
.reply-preview>div{min-width:0}
.reply-branch{color:#a6af98;line-height:1.5;font-size:20px}
.preview-meta{font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:#5f6757}
.preview-meta .avatar{width:24px;height:24px;font-size:12px}
.preview-meta strong{color:#5a624f;font-size:15px;font-weight:620}
.reply-preview .post-text{font-size:17px;color:#676f5d;margin-top:3px}
.tag{display:inline-block;margin-top:14px;font-size:13px;font-weight:600;line-height:1.5;border-radius:5px;background:#f0f1eb;color:#737968;padding:3px 7px}
.notice{border:1px solid #e7deca;background:#fcf8ef;border-radius:11px;font-size:15px;line-height:1.7;padding:15px 18px;margin:0 0 20px;color:#6a5834;overflow-wrap:anywhere}
.notice-success{background:#eef4e9;border-color:#d8e5cd;color:#395330}
.notice-error{background:#fff1eb;border-color:#efd2c6;color:#893b25}
.pagination{display:flex;justify-content:center;margin:25px 0 0}
.empty{text-align:center;padding:42px 35px}
.empty-mark{color:var(--orange);width:32px;height:36px;margin:0 auto 18px}
.empty h2{font-size:19px}
.empty p{color:var(--muted);font-size:15px;max-width:330px;margin:10px auto 0}
.empty .text-link{margin-top:19px}
.empty-small{padding:29px}
.empty-small h3{font-size:17px}
.back-link{display:inline-flex;align-items:center;gap:9px;font-size:14px;color:#68715a;text-decoration:none}
.thread-post{margin-bottom:19px}
.thread-actions{border-top:1px solid var(--line);padding-top:16px;margin-top:22px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;flex-wrap:wrap}
.thread-actions a{color:#5f6757}
.thread-actions .tag{margin:0}
.section-heading{display:flex;align-items:center;justify-content:space-between;margin:28px 0 14px}
.section-heading h2{font-size:16px}
.count{display:inline-grid;place-items:center;border:1px solid #dce1d2;background:#f0f2e9;min-width:28px;height:28px;padding:0 6px;border-radius:6px;font-size:13px;font-weight:500;margin-left:7px;color:#747d64;vertical-align:middle}
.replies{padding:0 25px}
.reply{padding:23px 0}
.reply+.reply{border-top:1px solid var(--line)}
.reply-to{font-size:13px;color:#5f6757;margin:-2px 0 8px}
.reply>.post-text{padding-left:37px;font-size:17px}
.reply>.corrections{margin-left:37px}
.corrections{font-size:13px;margin-top:15px;color:#6f7862}
.corrections summary{cursor:pointer;width:fit-content}
.corrections ol{padding:0 0 0 19px;margin:12px 0 0}
.corrections li+li{margin-top:14px}
.corrections .post-text{font-size:17px;color:#626a57;margin-top:5px}
.correction-reason{font-size:13px;margin-top:5px;font-style:italic;white-space:pre-wrap;overflow-wrap:anywhere}
.quiet{color:var(--muted)}
.profile-card{padding:27px}
.profile-identity{display:flex;gap:15px;align-items:center}
.profile-identity .avatar-large{height:58px;width:58px;font-size:24px}
.profile-identity h2{font-size:22px;overflow-wrap:anywhere}
.profile-identity .handle{margin:4px 0 0}
.profile-bio{margin-top:21px}
.profile-counts{display:flex;gap:30px;margin:23px 0 0;border-top:1px solid var(--line);padding-top:18px;flex-wrap:wrap}
.profile-counts div{display:flex;flex-direction:column-reverse}
.profile-counts a{color:inherit;text-decoration:none}
.profile-counts a:hover{text-decoration:underline}
.profile-counts dt{font-size:13px;color:var(--muted)}
.profile-counts dd{font-size:17px;font-weight:650;margin:0}
.profile-edit{padding:26px;margin-top:18px}
.avatar-preview{width:112px;height:112px;object-fit:cover;border-radius:50%}
.avatar-remove{margin-top:16px;border-top:1px solid var(--line);padding-top:16px}
.avatar-report{margin-top:20px}
.reaction-status:empty{display:none}
.profile-controls form{display:inline-block;margin:12px 10px 0 0}
[data-feed-pagination]{flex-wrap:wrap}
[data-feed-status]{flex-basis:100%;text-align:center}
.reaction-status{display:block;font-size:13px;max-width:260px;color:var(--muted)}
[data-reaction] button:disabled{opacity:.65;cursor:wait}
.section-intro{margin-bottom:24px}
.section-intro p{color:var(--muted);font-size:14px;margin-top:7px;max-width:440px}
.form-field{margin-top:19px}
.form-field label{display:block;font-size:14px;font-weight:620;margin-bottom:7px}
.form-field .form-help{margin-top:5px}
.form-field input{font-size:16px}
.form-field textarea{font-size:16px}
.handle-input{position:relative}
.handle-input>span{position:absolute;left:12px;top:10px;color:#5f6757;font-size:16px}
.handle-input input{padding-left:30px}
.form-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:24px;flex-wrap:wrap}
.delete-action{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:6px 9px;border-radius:8px;color:#6e7067;font-size:13px;text-decoration:none}
.delete-action:hover{color:#a03830;background:#fff0ec}
.delete-action svg{flex:none}
.button-danger svg{vertical-align:middle}
.delete-confirm{padding:24px;margin-top:18px}
.delete-confirm p{font-size:15px;color:#666e5b}
.deletion-preview{border-color:#e7d8cf}
.error-card{padding:27px}
.error-card>p{font-size:17px;overflow-wrap:anywhere;white-space:pre-wrap}
.error-card>.button{margin-top:24px}
.saved-draft{margin-top:25px;border-top:1px solid var(--line);padding-top:21px}
.saved-draft h2{font-size:16px}
.saved-draft>.quiet{font-size:14px;margin-top:5px}
.saved-draft pre{margin-top:12px;background:var(--soft);padding:15px;border-radius:9px}
.site-footer{margin:34px 0 0;padding:18px 0;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:15px;color:#5f6757;font-size:13px;flex-wrap:wrap}
.site-footer nav{display:flex;gap:19px;flex-wrap:wrap}
.site-footer a{text-decoration:none}
.site-footer a:hover{text-decoration:underline}

@media(max-width:960px){.shell{display:block;max-width:748px;padding:22px 24px 20px}
.site-header{position:static;display:flex;align-items:center;flex-wrap:wrap;gap:12px 15px;margin-bottom:22px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.brand{font-size:22px;gap:8px}
.brand-mark{width:26px;height:29px}
.preview-label{margin:0;font-size:13px}
.main-nav{margin-left:auto;flex-direction:row;gap:4px}
.main-nav a{font-size:14px;padding:7px 10px}
.nav-icon{display:none}
.account-link{margin:0 0 0 4px;font-size:13px}
.sidebar-note{display:none}
.page-heading{margin-bottom:24px}
.page-heading h1{font-size:34px}
.site-footer{margin-top:30px;flex-wrap:wrap}
}

@media(max-width:540px){.shell{padding:18px 16px}
.site-header{gap:10px;margin-bottom:20px;padding-bottom:12px}
.brand{font-size:21px}
.preview-label{margin-right:auto}
.main-nav{margin-left:0;order:3;width:100%;border-top:1px solid #eeeee7;padding-top:7px;margin-top:0}
.main-nav a{padding:7px 12px}
.account-link{font-size:13px;margin:0}
.page-heading h1{font-size:32px}
.page-heading>p{font-size:14px}
.eyebrow{font-size:13px}
.composer{padding:19px 17px;margin-bottom:23px}
.composer-bottom{flex-wrap:wrap;gap:13px}
.composer-bottom .form-help{font-size:13px;flex:1 1 165px}
.composer-bottom button{font-size:15px;padding:9px 11px}
.composer-label{font-size:17px}
.composer textarea{font-size:16px;padding:12px;min-height:108px}
.feed-hint{font-size:13px}
.tabs{gap:21px}
.tabs a{font-size:14px}
.post-card,.thread-post,.deletion-preview{padding:20px 18px}
.post-text{font-size:15px}
.thread-post>.post-text{font-size:17px}
.author-name{font-size:15px}
.author-name .handle{display:block;margin:2px 0 0;font-size:13px}
.author{align-items:flex-start}
.avatar{width:34px;height:34px}
.meta{font-size:13px}
.signin-card{padding:21px 19px;display:block;flex-wrap:wrap}
.signin-card p{max-width:none;font-size:14px}
.signin-card .button{margin-top:18px;font-size:15px}
.empty{padding:34px 22px}
.empty h2{font-size:18px}
.empty p{font-size:14px}
.quote{padding:13px;margin-top:16px}
.quote .author-name .handle{display:inline;margin-left:5px}
.replies{padding:0 18px}
.reply>.post-text{padding-left:0}
.reply>.corrections{margin-left:0}
.reply-to{margin-top:0}
.profile-card,.profile-edit{padding:22px 19px}
.profile-counts{gap:27px;flex-wrap:wrap}
.profile-identity h2{font-size:20px}
.profile-identity .handle{font-size:13px}
.delete-confirm{padding:20px}
.delete-confirm .form-actions{justify-content:flex-start}
.delete-confirm .button,.delete-confirm button{font-size:15px}
.site-footer{align-items:flex-start;flex-wrap:wrap}
.site-footer>span{max-width:175px}
.error-card{padding:23px 19px}
}

[hidden]{display:none!important}
.activity-badge{background:var(--orange);color:#302310;border-radius:999px;padding:1px 7px;font-size:12px;font-weight:750;margin-left:auto}
.activity-alert{border-color:#d8e5cd;background:#eef4e9}
/* Readable controls and wrapping at both desktop and mobile sizes. */
.button,button{max-width:100%;white-space:normal;overflow-wrap:anywhere}

.main-nav a,.tabs a,.account-link,.back-link,.text-link,.thread-actions a,.site-footer a{min-height:44px;display:inline-flex;align-items:center}

.nested-reply-composer summary,.corrections summary{min-height:44px;padding:10px 0}

.composer-bottom .form-help,.signin-card>div{min-width:0;flex:1 1 240px}

.thread-actions a,.site-footer a{padding:8px 0}

.post-text,.thread-post>.post-text{line-height:1.65}

@media(max-width:540px){
.post-text,.thread-post>.post-text,.reply>.post-text,.reply-preview .post-text,.quote .post-text,.corrections .post-text{font-size:16px}

.feed-hint{flex-basis:100%;padding-top:4px}

.site-footer>span{max-width:none}

.profile-counts{gap:16px 24px}

}


.social-link{overflow-wrap:anywhere;text-decoration:underline;text-underline-offset:3px}
.post-photo{margin:18px 0 0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--soft)}
.post-photo-link{display:block;text-decoration:none}
.post-photo-link:focus-visible{outline-offset:-4px}
.post-photo img{display:block;width:100%;height:auto;max-height:640px;max-height:min(70vh,640px);object-fit:contain;background:#eceee7}
.post-photo-caption{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;color:var(--muted);font-size:14px}
.post-photo-link:hover .post-photo-caption{color:var(--orange)}
.quote .post-photo{margin-top:14px}
.video-card{margin:16px 0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#f8f7f2}
.video-placeholder{display:flex;align-items:center;gap:16px;padding:24px}
.video-mark{display:grid;place-items:center;width:48px;height:48px;flex:0 0 48px;border-radius:50%;background:#eee6d9;color:#8c3a21}
.video-placeholder p{margin:4px 0 0;color:var(--muted);font-size:14px}
.video-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--line)}
.video-actions button,.video-actions a{font-size:14px;min-height:44px}
.video-actions a{display:inline-flex;align-items:center;text-underline-offset:3px}
.video-card iframe{display:block;width:100%;aspect-ratio:16/9;min-height:200px;border:0;background:#141716}
.video-card [hidden]{display:none!important}
.compose-entry{border:1px solid var(--line);border-radius:var(--radius);background:var(--card);margin:0 0 20px}
.compose-entry>summary{cursor:pointer;display:flex;align-items:center;justify-content:space-between;min-height:56px;padding:12px 20px;font-weight:650;font-size:16px;list-style:none}
.compose-entry>summary::-webkit-details-marker{display:none}
.compose-entry[open]>summary{border-bottom:1px solid var(--line)}
.compose-entry .composer{border:0;box-shadow:none;margin:0;padding:18px 20px}
.compose-entry .composer textarea{min-height:90px}
.content-links{display:flex;gap:16px;flex-wrap:wrap}
.reply-options{display:inline-flex;align-items:center;min-height:44px;font-size:14px;color:var(--muted)}
select{font:inherit;max-width:100%;padding:11px;border:1px solid #dfe1d7;border-radius:9px;background:#fcfcfa;color:var(--ink)}
select:focus-visible{outline:3px solid #a43f19;outline-offset:4px}
.activity-note{margin-top:24px}
.activity-item{padding:20px 24px}
.activity-item .post-text{margin:10px 0}
.activity-item h2{font-size:16px}
.activity-item+.activity-item{margin-top:12px}
.activity-header{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.control-section{padding:20px 24px;margin-top:16px}
.control-section p{margin:8px 0 16px;color:var(--muted);font-size:15px}
.control-section select{display:block;width:100%;margin:8px 0 16px}
.people-list{list-style:none;padding:0;margin:12px 0 0}
.people-list li{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 0;border-top:1px solid var(--line)}
.people-list li>div{min-width:0;overflow-wrap:anywhere}
.connection-person{display:flex;align-items:center;gap:12px}.connection-person>div{min-width:0}.connection-person>.profile-link{flex-shrink:0}
@media(max-width:540px){.compose-entry>summary{padding:12px 17px}.compose-entry .composer{padding:17px}.activity-item,.control-section{padding:18px}.people-list li{flex-wrap:wrap}}

`;

/** Escapes social content and builds local URLs. */
export function renderWeb({ kind = 'feed', signedIn = false, data = {}, formToken = '', error = '', draft = '', focus = 'active', statusMessage = '', returnPath = '', filter = 'all', activityBaseline = null } = {}) {
  returnPath ||= kind === 'thread' || kind === 'delete' || kind === 'controls' ? postUrl(data.postId) : kind === 'feed' ? `/?focus=${focus === 'active' ? 'active' : 'latest'}` : `/${kind}`;
  const selectedFocus = focus === 'active' ? 'active' : 'latest';
  const options = { kind, signedIn: Boolean(signedIn), data: data || {}, formToken, error, draft, focus: selectedFocus, returnPath, filter };
  const views = { feed: feedView, thread: threadView, profile: profileView, 'public-profile': publicProfileView, following: followingView, connections: connectionsView, delete: deleteView, activity: activityView, controls: controlsView, preferences: preferencesView, 'privacy-settings': privacySettingsView, error: errorView };
  const title = { feed: 'Shared feed', thread: 'Conversation', profile: 'My profile', 'public-profile': 'Profile', following: 'Following', connections: data.kind === 'following' ? 'Following' : 'Followers', delete: 'Delete post', activity: 'Activity', controls: 'Content options', preferences: 'Muted and blocked', 'privacy-settings': 'Privacy and followers', error: 'Something went wrong' }[kind] || 'Turnfeed';
  const body = (views[kind] || errorView)(options);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" type="image/png" href="/turnfeed-logo.png"><meta name="theme-color" content="#f7f6f2"><title>${e(title)} · Turnfeed</title><style>${styles}</style><script src="/assets/media.js" defer></script>${kind === 'feed' ? '<script src="/assets/feed.js" defer></script>' : ''}${signedIn ? '<script src="/assets/activity.js" defer></script><script src="/assets/composer.js" defer></script>' : ''}</head><body${activityBaseline ? ` data-activity-baseline="${e(JSON.stringify(activityBaseline))}"` : ''}><a class="skip-link" href="#main">Skip to content</a><div class="shell"><header class="site-header"><a class="brand" href="/" aria-label="Turnfeed home"><span class="brand-mark">${logo}</span>Turnfeed</a><span class="preview-label">Preview</span><nav class="main-nav" aria-label="Main navigation"><a href="/"${kind === 'feed' ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">☷</span>Feed</a>${signedIn ? `<a href="/activity"${kind === 'activity' ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">◎</span>Activity<span id="new-activity" class="activity-badge" hidden aria-label="New activity">New</span></a><a href="/profile"${['profile', 'preferences'].includes(kind) ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">○</span>My profile</a>` : ''}</nav>${signedIn ? '<a class="account-link" href="/signout-with-chatgpt?return_to=%2F" target="_top">Sign out</a>' : `<a class="account-link" href="${e(signInUrl(returnPath))}" target="_top">Sign in with ChatGPT</a>`}<p class="sidebar-note"><strong>Good conversations<br>have a place here.</strong><br>Read, share, and pick up where you left off.</p></header><main id="main">${signedIn ? '<div id="new-activity-notice" class="notice activity-alert" role="status" aria-live="polite" hidden><a href="/activity">New activity — open to see it</a></div>' : ''}${statusMessage ? `<div class="notice notice-success" role="status">${e(statusMessage)}</div>` : ''}${error && kind !== 'error' ? `<div class="notice notice-error" role="alert">${e(error)}</div>` : ''}${body}<footer class="site-footer"><span>Turnfeed · A shared feed for your conversations.</span><nav aria-label="Footer"><a href="/privacy">Privacy</a><a href="/support">Support</a></nav></footer></main></div></body></html>`;
}
