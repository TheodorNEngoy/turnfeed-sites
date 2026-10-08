/** Confirm in place; mutations still require the server's fresh, signed token. */
export function startDeletes(win, doc, initializeReplies = () => {}) {
  const dialog = doc.querySelector('#delete-dialog');
  if (!dialog?.showModal) return;
  const title = dialog.querySelector('[data-delete-title]');
  const description = dialog.querySelector('[data-delete-description]');
  const author = dialog.querySelector('[data-delete-author]');
  const preview = dialog.querySelector('[data-delete-preview]');
  const status = dialog.querySelector('[data-delete-status]');
  const confirm = dialog.querySelector('[data-delete-confirm]');
  const cancel = dialog.querySelector('[data-delete-cancel]');
  let target = null, trigger = null, writing = false, generation = 0;

  async function request(url, options = {}) {
    const controller = new win.AbortController();
    const timer = win.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await win.fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...options, signal: controller.signal });
      if (!response.ok) throw new Error('Request not confirmed');
      return response;
    } finally { win.clearTimeout(timer); }
  }
  function close() {
    if (writing) return;
    generation++;
    target = null;
    dialog.close();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { generation++; target = null; });

  // Delegation also covers posts loaded while scrolling.
  doc.addEventListener('click', async event => {
    const link = event.target.closest?.('a[data-delete-kind]');
    if (!link || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || dialog.open) return;
    event.preventDefault();
    trigger = link;
    target = null;
    const current = ++generation;
    const kind = link.dataset.deleteKind;
    title.textContent = kind === 'reply' ? 'Delete this reply?' : 'Delete this post?';
    description.textContent = kind === 'reply' ? 'This also deletes replies to it. This cannot be undone.' : 'This deletes the post and all its replies. This cannot be undone.';
    author.textContent = '';
    preview.textContent = '';
    status.textContent = 'Loading…';
    confirm.textContent = kind === 'reply' ? 'Delete reply' : 'Delete post';
    confirm.disabled = true;
    cancel.textContent = 'Cancel';
    cancel.disabled = false;
    dialog.showModal();
    cancel.focus();
    try {
      const url = new win.URL(link.href, win.location.href);
      if (url.origin !== win.location.origin) throw new Error('Invalid target');
      const result = await (await request(url.pathname + url.search, { headers: { Accept: 'application/json' } })).json();
      if (current !== generation || !dialog.open) return;
      if (!result.ok || result.kind !== kind || result.action !== (kind === 'reply' ? '/web/delete-reply' : '/web/delete') || !/^[A-Za-z0-9_-]{1,64}$/.test(result.postId) || typeof result.token !== 'string' || !result.token) throw new Error('Invalid preview');
      target = result;
      author.textContent = result.authorName || 'Your content';
      preview.textContent = result.text || 'Photo post';
      status.textContent = '';
      confirm.disabled = false;
    } catch {
      if (current === generation && dialog.open) status.textContent = 'Could not load this content. Close and try again.';
    }
  });

  async function refreshReplies() {
    const previous = doc.querySelector('#replies');
    if (!previous) throw new Error('Missing conversation');
    const key = reply => {
      const link = reply.querySelector('a[data-delete-kind],a.reply-options');
      return link ? new win.URL(link.href, win.location.href).searchParams.get('reply') : null;
    };
    const drafts = new Map();
    for (const reply of previous.querySelectorAll('article.reply')) {
      const text = reply.querySelector('textarea[name="text"]');
      const id = key(reply);
      if (id && text?.value) drafts.set(id, { text: text.value, open: reply.querySelector('details')?.open });
    }
    const url = new win.URL(win.location.href);
    url.searchParams.delete('cursor');
    const html = await (await request(url.pathname + url.search, { headers: { Accept: 'text/html' } })).text();
    const parsed = new win.DOMParser().parseFromString(html, 'text/html');
    const section = parsed.querySelector('#replies');
    if (!section) throw new Error('Missing refreshed conversation');
    const restored = new Set();
    for (const reply of section.querySelectorAll('article.reply')) {
      const id = key(reply), draft = drafts.get(id);
      const text = reply.querySelector('textarea[name="text"]');
      if (draft && text) {
        text.value = draft.text;
        const details = reply.querySelector('details');
        if (details) details.open = draft.open;
        restored.add(id);
      }
    }
    // A deleted branch or changed page must not silently discard someone's draft.
    if ([...drafts.keys()].some(id => !restored.has(id))) throw new Error('Draft needs preserving');
    const x = win.scrollX, y = win.scrollY;
    previous.replaceWith(section);
    initializeReplies(section);
    win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
    win.scrollTo(x, y);
  }
  confirm.addEventListener('click', async () => {
    if (!target || writing || confirm.disabled) return;
    const selected = target;
    writing = true;
    confirm.disabled = true;
    cancel.disabled = true;
    status.textContent = 'Deleting…';
    let deleted = false;
    try {
      const response = await request(selected.action, { method: 'POST', headers: { Accept: 'application/json' }, body: new win.URLSearchParams({ token: selected.token }) });
      const result = await response.json();
      if (!result.ok || result.deleted !== selected.kind || result.postId !== selected.postId) throw new Error('Unconfirmed deletion');
      deleted = true;
      target = null;
      if (selected.kind === 'reply') await refreshReplies();
      else {
        const card = trigger.closest('article.post-card,article.thread-post');
        if (!card) throw new Error('Missing deleted post');
        if (card.classList.contains('thread-post')) {
          doc.querySelector('#replies')?.remove();
          doc.querySelector('.compose-entry')?.remove();
        }
        const notice = doc.createElement('p');
        notice.className = 'notice notice-success';
        notice.setAttribute('role', 'status');
        notice.textContent = 'Post deleted.';
        card.replaceWith(notice);
        for (const count of doc.querySelectorAll('[data-post-count]')) count.textContent = String(Math.max(0, Number(count.textContent) - 1));
      }
      writing = false;
      close();
    } catch {
      target = null; // Never retry an ambiguous mutation from this confirmation.
      status.textContent = deleted ? 'Deleted. Refresh to update the conversation. Copy any unsent replies first.' : 'Deletion wasn’t confirmed. Refresh to check before trying again.';
      cancel.textContent = 'Close';
    } finally {
      writing = false;
      cancel.disabled = false;
    }
  });
}
