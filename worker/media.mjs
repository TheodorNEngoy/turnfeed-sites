const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Derive player URLs from known providers and a single validated video ID.
// Never fetch a post URL, metadata, thumbnail or user-supplied embed markup.
export function videoReference(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  let id;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1) id = url.searchParams.get('v');
    else id = /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  } else if (url.hostname === 'youtu.be') id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (url.hostname === 'www.youtube-nocookie.com') id = /^\/embed\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  if (/^[\w-]{11}$/.test(id || '')) return { provider: 'YouTube', url: `https://www.youtube.com/watch?v=${id}`,
    embed: `https://www.youtube-nocookie.com/embed/${id}?autoplay=0&playsinline=1` };
  if (['vimeo.com', 'www.vimeo.com'].includes(url.hostname)) id = /^\/([1-9]\d{0,11})\/?$/.exec(url.pathname)?.[1];
  else if (url.hostname === 'player.vimeo.com') id = /^\/video\/([1-9]\d{0,11})\/?$/.exec(url.pathname)?.[1];
  if (/^[1-9]\d{0,11}$/.test(id || '') && ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(url.hostname)) {
    return { provider: 'Vimeo', url: `https://vimeo.com/${id}`, embed: `https://player.vimeo.com/video/${id}?autoplay=0&dnt=1` };
  }
  return null;
}

function trimPunctuation(value) {
  value = value.replace(/[.,!?;:]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1);
  }
  return value;
}

export function socialText(value, { video = true } = {}) {
  const text = String(value ?? '');
  let cursor = 0, html = '', selected = null;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const raw = trimPunctuation(match[0]);
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (raw.length > 2048 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) continue;
    html += escape(text.slice(cursor, match.index));
    html += `<a class="social-link" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer nofollow ugc">${escape(raw)}</a>`;
    cursor = match.index + raw.length;
    selected ||= videoReference(raw);
  }
  html += escape(text.slice(cursor));
  return `<p class="post-text">${html}</p>${video && selected ? videoCard(selected) : ''}`;
}

function videoCard(item) {
  return `<section class="video-card" data-video-url="${escape(item.url)}" aria-label="${item.provider} video"><div class="video-placeholder"><span class="video-mark" aria-hidden="true">▶</span><div><strong>${item.provider} video</strong><p>Loads from ${item.provider} when you choose.</p></div></div><div data-video-player></div><div class="video-actions"><button type="button" class="button-secondary" data-video-load>Load ${item.provider} video</button><button type="button" class="button-secondary" data-video-close hidden>Close video</button><a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer nofollow ugc">Open on ${item.provider} ↗</a></div><noscript><p class="form-help">Use the link above to watch this video.</p></noscript></section>`;
}

export function startVideos(doc, parseVideo) {
  let closeCurrent = null;
  const ready=new WeakSet();
  function enhance() {
  for (const card of doc.querySelectorAll('[data-video-url]')) {
    if (ready.has(card)) continue;
    const item = parseVideo(card.getAttribute('data-video-url'));
    const load = card.querySelector('[data-video-load]'), close = card.querySelector('[data-video-close]');
    const player = card.querySelector('[data-video-player]'), placeholder = card.querySelector('.video-placeholder');
    if (!item || !load || !close || !player || !placeholder) continue;
    ready.add(card);
    const unload = () => {
      player.replaceChildren();
      load.hidden = false;
      close.hidden = true;
      placeholder.hidden = false;
    };
    load.addEventListener('click', () => {
      closeCurrent?.();
      const frame = doc.createElement('iframe');
      frame.title = `${item.provider} video player`;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.allow = 'fullscreen; picture-in-picture; encrypted-media';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
      frame.setAttribute('allowfullscreen', '');
      frame.src = item.embed;
      player.replaceChildren(frame);
      load.hidden = true;
      close.hidden = false;
      placeholder.hidden = true;
      closeCurrent = unload;
      close.focus();
    });
    close.addEventListener('click', () => { unload(); closeCurrent = null; load.focus(); });
  }
  }
  enhance();
  doc.addEventListener?.('turnfeed:feed-appended',enhance);
}

// Pass dependencies explicitly so minification cannot leave a renamed closure
// reference in the separately served browser script.
export const mediaScript = `(${startVideos.toString()})(document, ${videoReference.toString()});`;
