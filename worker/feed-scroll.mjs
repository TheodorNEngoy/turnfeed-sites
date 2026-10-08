// Append server-rendered feed cards while retaining the current page and drafts.
export function startFeedScroll(win, doc, enhance) {
  if (!win.fetch || !win.URL || !win.DOMParser || !win.AbortController) return;
  const feed = doc.querySelector('[data-scroll-feed]');
  const pager = doc.querySelector('[data-feed-pagination]');
  const link = pager?.querySelector('[data-feed-next]');
  const status = pager?.querySelector('[data-feed-status]');
  if (!feed || !link || !status || !feed.dataset.feedViewer || feed.dataset.scrollFeedReady) return;
  const current = new win.URL(win.location.href);
  const focus = current.searchParams.get('focus') || 'active';
  if (current.pathname !== '/' || !['latest', 'active'].includes(focus)) return;
  function nextUrl(value) {
    const url = new win.URL(value, current);
    if (url.origin !== current.origin || url.pathname !== '/' || url.hash || url.username || url.password
        || [...url.searchParams.keys()].some(key => !['focus', 'cursor'].includes(key))
        || url.searchParams.getAll('focus').length > 1 || url.searchParams.getAll('cursor').length !== 1
        || (url.searchParams.get('focus') || 'active') !== focus || !url.searchParams.get('cursor')
        || url.searchParams.get('cursor').length > 4096) throw new Error('invalid continuation');
    return url;
  }
  let next;
  try { next = nextUrl(link.getAttribute('href')); } catch { return; }
  feed.dataset.scrollFeedReady = 'true';
  const seenCursors = new Set(current.searchParams.has('cursor') ? [current.searchParams.get('cursor')] : []);
  const seenPosts = new Set([...feed.querySelectorAll('article[data-post-id]')].map(card => card.dataset.postId));
  let pending = false, stopped = false, paused = false, armed = true, observer;
  function restart(message) {
    stopped = true;
    observer?.disconnect();
    link.hidden = false;
    link.setAttribute('href', '/?focus=' + encodeURIComponent(focus));
    link.textContent = 'Start the feed again';
    status.textContent = message;
  }
  async function load(manual = false) {
    if (pending || stopped || (!manual && (paused || !armed))) return;
    if (seenCursors.has(next.searchParams.get('cursor'))) {
      restart('The feed changed. Open it again to continue.');
      return;
    }
    pending = true;
    armed = false;
    pager.setAttribute('aria-busy', 'true');
    link.setAttribute('aria-disabled', 'true');
    status.textContent = 'Loading more conversations…';
    const controller = new win.AbortController();
    const timeout = win.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await win.fetch(next.pathname + next.search, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { accept: 'text/html' }, signal: controller.signal,
      });
      if (!response.ok) throw new Error('unavailable');
      const page = new win.DOMParser().parseFromString(await response.text(), 'text/html');
      const incoming = page.querySelector('[data-scroll-feed]');
      if (!incoming || incoming.dataset.feedViewer !== feed.dataset.feedViewer) throw new Error('different viewer');
      if (page.querySelector('[data-feed-reset]')) {
        restart('The feed changed. Your place and drafts are still here. Start the feed again to continue.');
        return;
      }
      const nextLink = page.querySelector('[data-feed-next]');
      const following = nextLink ? nextUrl(nextLink.getAttribute('href')) : null;
      if (following && (following.searchParams.get('cursor') === next.searchParams.get('cursor')
          || seenCursors.has(following.searchParams.get('cursor')))) {
        restart('The feed changed. Open it again to continue.');
        return;
      }
      const additions = [], ids = new Set(seenPosts);
      for (const card of incoming.querySelectorAll('article[data-post-id]')) {
        const id = card.dataset.postId;
        if (!id) throw new Error('invalid card');
        if (!ids.has(id)) { additions.push(doc.importNode(card, true)); ids.add(id); }
      }
      if (!additions.length && following) {
        restart('The feed changed. Open it again to continue.');
        return;
      }
      seenCursors.add(next.searchParams.get('cursor'));
      const scrollX = win.scrollX, scrollY = win.scrollY;
      feed.append(...additions);
      for (const card of additions) seenPosts.add(card.dataset.postId);
      if (typeof enhance === 'function') enhance(win, doc);
      paused = false;
      if (following) {
        next = following;
        link.setAttribute('href', next.pathname + next.search);
        status.textContent = `${additions.length} more ${additions.length === 1 ? 'conversation' : 'conversations'} loaded.`;
      } else {
        stopped = true;
        observer?.disconnect();
        link.hidden = true;
        status.textContent = 'You’ve reached the end of this feed.';
      }
      // A focused pager can become the browser's scroll anchor. Preserve the
      // reader's position at the moment cards are appended, even in that case.
      if (typeof win.scrollTo === 'function' && (win.scrollX !== scrollX || win.scrollY !== scrollY)) {
        win.scrollTo(scrollX, scrollY);
      }
    } catch {
      paused = true;
      status.textContent = 'Could not load more conversations. Choose More conversations to try again.';
    } finally {
      win.clearTimeout(timeout);
      pending = false;
      pager.removeAttribute('aria-busy');
      link.removeAttribute('aria-disabled');
    }
  }
  link.addEventListener('click', event => {
    if (stopped || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void load(true);
  });
  if (typeof win.IntersectionObserver === 'function') {
    observer = new win.IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void load();
    }, { rootMargin: '400px 0px' });
    observer.observe(pager);
  }
  win.addEventListener('scroll', () => {
    if (pending || stopped || paused) return;
    armed = true;
    if (pager.getBoundingClientRect().top <= win.innerHeight + 400) void load();
  }, { passive: true });
}
