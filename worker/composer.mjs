import { preparePhoto, photoPreparationScript } from './photo-prepare.mjs';
import { startReactions, reactionsScript } from './reactions.mjs';
import { followsScript } from './follows.mjs';
import { startDeletes } from './deletions.mjs';

/** Progressive enhancement only: publishing still uses the signed browser form. */
export function startComposers(win, doc, prepare = preparePhoto) {
  const entries = [...doc.querySelectorAll('form[data-composer]')].map(form => ({
    form, accountControl: form.dataset?.accountControl !== undefined,
    profileFields: form.dataset?.profileEditor !== undefined ? [...form.querySelectorAll('input[name="displayName"],input[name="handle"],textarea[name="bio"]')] : [],
    text: form.querySelector('textarea[name="text"]'),
    counter: form.querySelector('[data-characters]'),
    button: form.querySelector('button[type="submit"]'),
    label: form.querySelector('[data-submit-label]'),
    status: form.querySelector('[data-publish-status]'),
    photo: form.querySelector('input[name="photo"]'),
    photoStatus: form.querySelector('[data-photo-status]'),
    photoPreview: form.querySelector('[data-photo-preview]'),
    photoRemove: form.querySelector('[data-photo-remove]'),
  }));
  if (!entries.length) return;
  let pending = null, guarding = false, pendingTimer;
  const hasDraft = entry => entry.form.isConnected !== false && Boolean(entry.text?.value.length || entry.photo?.files?.length || entry.profileFields.some(field=>field.value!==(field.dataset?.savedValue ?? field.defaultValue)));
  function warnBeforeLeaving(event) {
    if (!entries.some(hasDraft)) return;
    event.preventDefault();
    event.returnValue = '';
  }
  function updateGuard() {
    const needed = !pending && entries.some(hasDraft);
    if (needed === guarding) return;
    guarding = needed;
    if (needed) win.addEventListener('beforeunload', warnBeforeLeaving);
    else win.removeEventListener('beforeunload', warnBeforeLeaving);
  }
  function updateCount(entry) {
    if (entry.text && entry.counter) {
      const remaining = Math.max(0, entry.text.maxLength - entry.text.value.length);
      entry.counter.textContent = `${remaining} ${remaining === 1 ? 'character' : 'characters'} left`;
    }
    updateGuard();
  }
  function clearPreview(entry) {
    if (entry.previewUrl) win.URL.revokeObjectURL(entry.previewUrl);
    entry.previewUrl = '';
    entry.photoPreview.removeAttribute('src');
    entry.photoPreview.hidden = true;
  }
  function showPrepared(entry) {
    const result = entry.prepared;
    entry.photoStatus.textContent = `${result.file.name} selected. ${result.width} × ${result.height}, ${Math.ceil(result.file.size / 1024)} KiB. ${entry.text ? 'It will be published with your post.' : 'Save picture to update your profile.'}`;
    if (typeof win.URL?.createObjectURL === 'function') {
      try {
        entry.previewUrl = win.URL.createObjectURL(result.file);
        entry.photoPreview.src = entry.previewUrl;
        entry.photoPreview.hidden = false;
      } catch { /* A valid prepared file can still submit without a preview. */ }
    }
  }
  function installPrepared(entry, result, original) {
    entry.useFormData = false;
    if (result.file === original) return;
    try {
      const transfer = new win.DataTransfer();
      transfer.items.add(result.file);
      entry.photo.files = transfer.files;
      const selected = entry.photo.files?.[0];
      if (entry.photo.files.length === 1 && selected?.name === result.file.name
          && selected?.size === result.file.size && selected?.type === result.file.type) return;
    } catch { /* Use the native formdata event when replacing FileList is unavailable. */ }
    if (typeof win.FormDataEvent === 'function') { entry.useFormData = true; return; }
    throw new Error('This browser cannot attach the resized photo. Choose a photo already within the upload size, or use another browser.');
  }
  function updatePhoto(entry, force = false) {
    clearPreview(entry);
    const file = entry.photo.files?.[0];
    entry.photoRemove.hidden = !file;
    if (!force && file && file === entry.photoSource) {
      if (entry.prepared) showPrepared(entry);
      entry.button.disabled = Boolean(pending || entry.processing);
      updateGuard();
      return;
    }
    const selection = entry.selection = (entry.selection || 0) + 1;
    entry.photoSource = file;
    entry.prepared = null;
    entry.processing = false;
    entry.useFormData = false;
    const error = file && (entry.photo.files.length !== 1 || file.size < 1 || file.size > 8 * 1024 * 1024
      || (file.type && !['image/jpeg', 'image/png'].includes(file.type)))
      ? 'Choose one JPEG or PNG up to 8 MiB, or remove the selected file.' : '';
    entry.photo.setCustomValidity(error);
    entry.photoStatus.textContent = error;
    entry.button.disabled = Boolean(pending);
    updateGuard();
    if (!file || error) return;
    entry.processing = true;
    entry.button.disabled = true;
    entry.photo.setCustomValidity('Wait for photo preparation to finish.');
    entry.photoStatus.textContent = 'Preparing photo on this device…';
    const current = () => entry.selection === selection && entry.photo.files?.[0] === file;
    entry.preparation = (async () => {
      try {
        const kind = entry.form.dataset?.photoKind === 'avatar' ? 'avatar' : 'post';
        const result = await prepare(file, kind, win, doc);
        if (!current()) return;
        installPrepared(entry, result, file);
        entry.photoSource = entry.photo.files?.[0];
        entry.prepared = result;
        entry.photo.setCustomValidity('');
        showPrepared(entry);
      } catch (error) {
        if (entry.selection !== selection) return;
        const message = error instanceof Error ? error.message : 'This photo could not be prepared. Choose another JPEG or PNG.';
        entry.photo.setCustomValidity(message);
        entry.photoStatus.textContent = message;
      } finally {
        if (entry.selection === selection) {
          entry.processing = false;
          entry.button.disabled = Boolean(pending);
          updateGuard();
        }
      }
    })();
  }
  for (const entry of entries) {
    entry.originalLabel = entry.label.textContent;
    for (const field of entry.profileFields) field.addEventListener('input',updateGuard);
    entry.text?.addEventListener('input', () => updateCount(entry));
    if (entry.photo) {
      entry.photo.addEventListener('change', () => updatePhoto(entry, true));
      entry.photoRemove.addEventListener('click', () => {
        if (pending) return;
        entry.photo.value = '';
        updatePhoto(entry);
        entry.photo.focus();
      });
      entry.form.addEventListener('formdata', event => {
        if (!entry.photo.files?.length) { event.formData.delete('photo'); return; }
        if (entry.useFormData && entry.prepared && !entry.processing
            && entry.photo.files?.[0] === entry.photoSource) {
          event.formData.set('photo', entry.prepared.file, entry.prepared.file.name);
        }
      });
    }
    entry.form.addEventListener('submit', event => {
      if (pending || entry.processing || !entry.form.checkValidity()) { event.preventDefault(); return; }
      if (entries.some(other => other !== entry && hasDraft(other))
          && !win.confirm('This leaves the page. Discard your other unsaved changes?')) {
        event.preventDefault();
        return;
      }
      pending = entry;
      entry.button.disabled = true;
      if (entry.text) entry.text.readOnly = true;
      for (const field of entry.profileFields) field.readOnly=true;
      // Keep the file input enabled so native form submission includes its bytes.
      if (entry.photoRemove) entry.photoRemove.disabled = true;
      entry.label.textContent = entry.text ? 'Publishing…' : entry.photo || entry.profileFields.length ? 'Saving…' : 'Removing…';
      entry.form.setAttribute('aria-busy', 'true');
      entry.status.textContent = entry.text ? 'Publishing. Please wait before leaving this page.' : entry.profileFields.length ? 'Saving your profile. Please wait before leaving this page.' : `${entry.photo ? 'Saving' : 'Removing'} your profile picture. Please wait before leaving this page.`;
      if (entry.accountControl) {
        entry.label.textContent='Saving…';
        entry.status.textContent='Saving your change. Please wait before leaving this page.';
      }
      updateGuard();
      // Stop/Escape can cancel navigation without firing pageshow. Recover the
      // controls, but never infer failure or automatically repeat the write.
      pendingTimer = win.setTimeout(() => {
        restore();
        entry.status.textContent = entry.text ? 'Publication is not confirmed here. Copy your text and check the feed or conversation before trying again.' : 'The update is not confirmed here. Check your profile before trying again.';
      }, 30_000);
    });
  }
  function restore() {
    // Browsers can restore both the typed draft and disabled controls on Back.
    pending = null;
    win.clearTimeout(pendingTimer);
    for (const entry of entries) {
      entry.button.disabled = false;
      if (entry.text) entry.text.readOnly = false;
      for (const field of entry.profileFields) field.readOnly=false;
      if (entry.photoRemove) entry.photoRemove.disabled = false;
      entry.label.textContent = entry.originalLabel;
      entry.form.removeAttribute('aria-busy');
      entry.status.textContent = '';
      updateCount(entry);
      if (entry.photo) updatePhoto(entry);
    }
  }
  win.addEventListener('pageshow', restore);
  win.addEventListener('pagehide', () => {
    for (const entry of entries) if (entry.photo) clearPreview(entry);
  });
  restore();
}

export const composerScript = `${reactionsScript}\n${followsScript}\n${photoPreparationScript}\n(${startComposers.toString()})(window, document, preparePhoto);\n(${startDeletes.toString()})(window, document, section => { (${startReactions.toString()})(window, section); (${startComposers.toString()})(window, section, preparePhoto); });`;
