// Keep the native signed form as the no-JavaScript fallback. A failed fetch is
// never replayed automatically: its write may already have committed.
export function startReactions(win, doc) {
  if (!win.fetch || !win.URLSearchParams || !win.AbortController) return;
  for (const form of doc.querySelectorAll('form[data-reaction]')) {
    if (form.dataset.reactionReady) continue;
    form.dataset.reactionReady = 'true';
    const button = form.querySelector('button[type="submit"]');
    const token = form.querySelector('input[name="token"]');
    const label = form.querySelector('[data-reaction-label]');
    const count = form.querySelector('.reaction-count');
    const icon = form.querySelector('svg');
    const status = form.querySelector('[data-reaction-status]');
    let pending = false;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending) return;
      pending = true;
      button.disabled = true;
      form.setAttribute('aria-busy', 'true');
      status.textContent = '';
      const controller = new win.AbortController();
      const timeout = win.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await win.fetch(form.getAttribute('action'), {
          method: 'POST', body: new win.URLSearchParams({ token: token.value }),
          credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { accept: 'application/json' }, signal: controller.signal,
        });
        if (!response.ok) throw new Error('unconfirmed');
        const data = await response.json();
        if (data.ok !== true || typeof data.liked !== 'boolean' || !Number.isSafeInteger(data.count)
            || data.count < 0 || typeof data.token !== 'string' || !data.token || data.token.length > 16_384) {
          throw new Error('invalid');
        }
        token.value = data.token;
        label.textContent = data.liked ? 'Liked' : 'Like';
        count.textContent = String(data.count);
        button.classList.toggle('is-active', data.liked);
        button.setAttribute('aria-pressed', String(data.liked));
        button.setAttribute('aria-label', `${data.liked ? 'Unlike' : 'Like'} ${form.dataset.reaction}; ${data.count} ${data.count === 1 ? 'like' : 'likes'}`);
        icon.setAttribute('fill', data.liked ? 'currentColor' : 'none');
      } catch {
        status.textContent = 'Update not confirmed. Refresh to check, or try again.';
      } finally {
        win.clearTimeout(timeout);
        pending = false;
        button.disabled = false;
        form.removeAttribute('aria-busy');
      }
    });
  }
}

export const reactionsScript = `(${startReactions.toString()})(window, document);`;
