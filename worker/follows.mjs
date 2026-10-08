// Keep signed native forms available when enhancement is unsupported. An
// uncertain request is never repeated automatically because it may have saved.
export function startFollows(win, doc) {
  if (!win.fetch || !win.URLSearchParams || !win.AbortController) return;
  for (const form of doc.querySelectorAll('form[data-follow]')) {
    if (form.dataset.followReady) continue;
    const button = form.querySelector('button[type="submit"]');
    const token = form.querySelector('input[name="token"]');
    const status = form.querySelector('[data-follow-status]');
    if (!button || !token || !status) continue;
    form.dataset.followReady = 'true';
    const name = form.dataset.followName || 'this person';
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
        if (data.ok !== true || typeof data.following !== 'boolean' || !Number.isSafeInteger(data.count)
            || data.count < 0 || typeof data.token !== 'string' || !data.token || data.token.length > 16_384) {
          throw new Error('invalid');
        }
        token.value = data.token;
        const label=data.following?'Unfollow':data.requested?'Cancel request':data.privateAccount?'Request to follow':'Follow';
        button.textContent = label;
        button.setAttribute('aria-label', `${label} ${name}`);
        button.classList.toggle('button-secondary', data.following || data.requested===true);
        status.textContent = data.following ? 'You follow this person.' : data.requested ? 'Your follow request is pending.' : 'You no longer follow this person.';
        const count = doc.querySelector('[data-follower-count]');
        if (count) count.textContent = String(data.count);
        // Revocation must remove content the page can no longer read.
        if (data.refresh===true) win.location.reload();
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

export const followsScript = `(${startFollows.toString()})(window, document);`;
