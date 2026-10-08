import test from 'node:test';
import assert from 'node:assert/strict';
import { startComposers } from '../worker/composer.mjs';

function browser(count = 1, { photo = false, avatar = false, profile = false, prepare = async file => ({ file, width: 32, height: 24, changed: false }), dataTransfer = true, formDataEvent = true } = {}) {
  const win = new EventTarget(), timers = new Map();
  const urls = { created: [], revoked: [] };
  win.URL = {
    createObjectURL(file) { urls.created.push(file); return `blob:photo-${urls.created.length}`; },
    revokeObjectURL(url) { urls.revoked.push(url); },
  };
  if (dataTransfer) win.DataTransfer = class {
    files = [];
    items = { add: file => this.files.push(file) };
  };
  if (formDataEvent) win.FormDataEvent = class {};
  let nextTimer = 0;
  win.setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
  win.clearTimeout = id => timers.delete(id);
  win.confirm = () => false;
  const entries = Array.from({ length: count }, (_, index) => {
    const text = avatar || profile ? null : Object.assign(new EventTarget(), { value: '', maxLength: 600 });
    const counter = {}, button = {}, label = { textContent: avatar ? (index === 0 ? 'Save picture' : 'Remove current picture') : 'Publish reply' }, status = {};
    const form = new EventTarget(), attrs = new Map();
    form.dataset = { photoKind: avatar ? 'avatar' : 'post' };
    const fields=profile ? ['Avery','avery','A short bio'].map(value=>Object.assign(new EventTarget(),{value,defaultValue:value})) : [];
    if (profile) form.dataset.profileEditor='';
    form.querySelectorAll=()=>fields;
    const nodes = [text, counter, button, label, status];
    const selectors = ['textarea[name="text"]', '[data-characters]', 'button[type="submit"]', '[data-submit-label]', '[data-publish-status]'];
    const input = (photo || avatar) && index === 0 ? Object.assign(new EventTarget(), { files: [], validationMessage: '', focused: false,
      setCustomValidity(message) { this.validationMessage = message; }, focus() { this.focused = true; },
    }) : null;
    if (input) Object.defineProperty(input, 'value', { set(value) { if (value === '') this.files = []; } });
    const photoStatus = {}, photoRemove = new EventTarget(), photoPreview = {
      hidden: true, removeAttribute(name) { delete this[name]; },
    };
    selectors.push('input[name="photo"]', '[data-photo-status]', '[data-photo-preview]', '[data-photo-remove]');
    nodes.push(input, input && photoStatus, input && photoPreview, input && photoRemove);
    form.querySelector = selector => nodes[selectors.indexOf(selector)];
    form.checkValidity = () => (profile ? true : avatar ? !input || input.files.length > 0 : Boolean(text.value.trim()) && text.value.length <= 600) && !input?.validationMessage;
    form.setAttribute = (key, value) => attrs.set(key, value);
    form.removeAttribute = key => attrs.delete(key);
    return { fields, text, counter, button, label, status, form, attrs, photo: input, photoStatus, photoPreview, photoRemove };
  });
  startComposers(win, { querySelectorAll: () => entries.map(entry => entry.form) }, prepare);
  return { win, entries, timers, urls };
}
function emit(target, type) {
  const event = new Event(type, { cancelable: true });
  target.dispatchEvent(event);
  return event;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function write(entry, value) { entry.text.value = value; emit(entry.text, 'input'); }

test('text-only browser submission omits the empty optional photo part', () => {
  const { entries: [entry] } = browser(1, { photo: true });
  write(entry, 'A simple text post without an image.');
  assert.equal(emit(entry.form, 'submit').defaultPrevented, false);
  const event = new Event('formdata');
  event.formData = new FormData();
  event.formData.set('text', entry.text.value); event.formData.set('photo', '');
  entry.form.dispatchEvent(event);
  assert.equal(event.formData.has('photo'), false);
  assert.equal(event.formData.get('text'), entry.text.value);
});

test('unsent drafts survive cancelled navigation; publishing and Back restore usable controls', () => {
  const { win, entries: [entry] } = browser();
  assert.equal(emit(win, 'beforeunload').defaultPrevented, false);
  write(entry, 'A quiet walk 🌿');
  assert.equal(entry.counter.textContent, `${600 - entry.text.value.length} characters left`);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, true);
  assert.equal(entry.text.value, 'A quiet walk 🌿');
  assert.equal(emit(entry.form, 'submit').defaultPrevented, false);
  assert.equal(entry.button.disabled, true);
  assert.equal(emit(entry.form, 'submit').defaultPrevented, true);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, false);
  emit(win, 'pageshow');
  assert.equal(entry.text.value, 'A quiet walk 🌿');
  assert.equal(entry.button.disabled, false);
  assert.equal(entry.text.readOnly, false);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, true);
  write(entry, '');
  assert.equal(emit(win, 'beforeunload').defaultPrevented, false);
});

test('cancelled or slow publication recovers without resubmitting or assuming failure', () => {
  const { win, entries: [entry], timers } = browser();
  let submissions = 0;
  entry.form.addEventListener('submit', () => submissions++);
  write(entry, 'My reply remains here.');
  emit(entry.form, 'submit');
  assert.equal(entry.button.disabled, true);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(entry.text.value, 'My reply remains here.');
  assert.equal(entry.button.disabled, false);
  assert.equal(entry.text.readOnly, false);
  assert.match(entry.status.textContent, /not confirmed.*check the feed or conversation/);
  assert.equal(submissions, 1);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, true);
});

test('publishing one reply requires a choice before discarding another draft', () => {
  const { win, entries: [first, second] } = browser(2);
  write(first, 'A reply to the post.');
  write(second, 'An unfinished reply to someone else.');
  assert.equal(emit(first.form, 'submit').defaultPrevented, true);
  assert.equal(first.button.disabled, false);
  assert.equal(second.text.value, 'An unfinished reply to someone else.');
  win.confirm = () => true;
  assert.equal(emit(first.form, 'submit').defaultPrevented, false);
  emit(win, 'pageshow');
  assert.equal(first.button.disabled, false);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, true);
});

test('selected photos preview locally and removing a photo preserves the caption', async () => {
  const { win, entries: [entry], urls } = browser(1, { photo: true });
  const first = { name: 'A quiet walk.jpg', type: 'image/jpeg', size: 700_000 };
  entry.photo.files = [first];
  emit(entry.photo, 'change');
  await flush();
  assert.equal(entry.photoPreview.src, 'blob:photo-1');
  assert.equal(entry.photoPreview.hidden, false);
  assert.equal(entry.photoRemove.hidden, false);
  assert.match(entry.photoStatus.textContent, /A quiet walk.jpg selected/);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, true, 'photo-only draft warns before leaving');
  write(entry, 'An afternoon outside.');
  entry.photo.files = [{ name: 'Another view.png', type: 'image/png', size: 200_000 }];
  emit(entry.photo, 'change');
  await flush();
  assert.deepEqual(urls.revoked, ['blob:photo-1']);
  emit(entry.photoRemove, 'click');
  assert.equal(entry.text.value, 'An afternoon outside.');
  assert.equal(entry.photo.files.length, 0);
  assert.equal(entry.photoPreview.hidden, true);
  assert.equal(entry.photoRemove.hidden, true);
  assert.equal(entry.photo.focused, true);
  assert.deepEqual(urls.revoked, ['blob:photo-1', 'blob:photo-2']);
});

test('invalid selected files block publication until removed or replaced', async () => {
  const { entries: [entry], urls } = browser(1, { photo: true });
  write(entry, 'Keep this caption.');
  for (const file of [
    { name: 'large.jpg', type: 'image/jpeg', size: 8 * 1024 * 1024 + 1 },
    { name: 'video.mp4', type: 'video/mp4', size: 500 },
  ]) {
    entry.photo.files = [file];
    emit(entry.photo, 'change');
  await flush();
    assert.match(entry.photo.validationMessage, /JPEG or PNG up to 8 MiB/);
    assert.equal(emit(entry.form, 'submit').defaultPrevented, true);
    assert.equal(entry.button.disabled, false);
    assert.equal(entry.text.value, 'Keep this caption.');
  }
  assert.equal(urls.created.length, 0);
  emit(entry.photoRemove, 'click');
  assert.equal(entry.photo.validationMessage, '');
  assert.equal(emit(entry.form, 'submit').defaultPrevented, false);
});

test('photo submission keeps its file enabled and Back restores the selection and preview', async () => {
  const { win, entries: [entry], urls } = browser(1, { photo: true });
  const file = { name: 'photo.png', type: 'image/png', size: 1_048_576 };
  write(entry, 'The exact caption.');
  entry.photo.files = [file];
  emit(entry.photo, 'change');
  await flush();
  assert.equal(emit(entry.form, 'submit').defaultPrevented, false);
  assert.notEqual(entry.photo.disabled, true, 'disabled file inputs are omitted from form submission');
  assert.equal(entry.photoRemove.disabled, true);
  assert.deepEqual(entry.photo.files, [file]);
  emit(win, 'pagehide');
  assert.deepEqual(urls.revoked, ['blob:photo-1']);
  emit(win, 'pageshow');
  assert.deepEqual(entry.photo.files, [file]);
  assert.equal(entry.photoPreview.src, 'blob:photo-2');
  assert.equal(entry.photoRemove.disabled, false);
  assert.equal(entry.text.value, 'The exact caption.');
  assert.equal(emit(win, 'beforeunload').defaultPrevented, true);
});

test('picture-only forms preview, guard unsaved selection and recover a pending upload', async () => {
  const { win, entries: [entry], timers } = browser(1, { avatar: true });
  assert.equal(emit(entry.form, 'submit').defaultPrevented, true, 'a profile picture is required');
  const file = { name: 'profile.png', type: 'image/png', size: 1234 };
  entry.photo.files = [file];
  emit(entry.photo, 'change');
  await flush();
  assert.equal(entry.photoPreview.hidden, false);
  assert.match(entry.photoStatus.textContent, /Save picture to update your profile/);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, true);
  assert.equal(emit(entry.form, 'submit').defaultPrevented, false);
  assert.equal(entry.label.textContent, 'Saving…');
  assert.match(entry.status.textContent, /Saving your profile picture/);
  assert.notEqual(entry.photo.disabled, true);
  assert.equal(emit(entry.form, 'submit').defaultPrevented, true);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, false, 'native upload navigation is allowed');
  [...timers.values()][0]();
  assert.equal(entry.button.disabled, false);
  assert.equal(entry.label.textContent, 'Save picture');
  assert.deepEqual(entry.photo.files, [file]);
  assert.match(entry.status.textContent, /not confirmed.*Check your profile/);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, true);
  emit(entry.photoRemove, 'click');
  assert.equal(entry.photo.files.length, 0);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, false);
});

test('removing a current picture protects a selected replacement and blocks concurrent mutations', async () => {
  const { win, entries: [upload, removal] } = browser(2, { avatar: true });
  upload.photo.files = [{ name: 'profile.jpg', type: 'image/jpeg', size: 1234 }];
  emit(upload.photo, 'change');
  await flush();
  assert.equal(emit(removal.form, 'submit').defaultPrevented, true);
  assert.equal(removal.button.disabled, false);
  win.confirm = () => true;
  assert.equal(emit(removal.form, 'submit').defaultPrevented, false);
  assert.equal(removal.label.textContent, 'Removing…');
  assert.equal(emit(upload.form, 'submit').defaultPrevented, true);
  emit(win, 'pageshow');
  assert.equal(removal.button.disabled, false);
  assert.equal(removal.label.textContent, 'Remove current picture');
  assert.equal(emit(win, 'beforeunload').defaultPrevented, true);
});

test('preparation blocks submit and installs the exact processed file shown in the preview', async () => {
  let complete, selectedKind;
  const prepare = (file, kind) => { selectedKind = kind; return new Promise(resolve => { complete = resolve; }); };
  const { win, entries: [entry], urls } = browser(1, { avatar: true, prepare });
  const original = { name: 'portrait.png', type: 'image/png', size: 4_000_000 };
  const processed = { name: 'portrait.png', type: 'image/png', size: 120_000 };
  entry.photo.files = [original]; emit(entry.photo, 'change');
  assert.equal(selectedKind, 'avatar');
  assert.equal(entry.button.disabled, true);
  assert.equal(emit(entry.form, 'submit').defaultPrevented, true);
  assert.equal(emit(win, 'beforeunload').defaultPrevented, true);
  assert.equal(urls.created.length, 0, 'the original is not presented as an upload preview');
  complete({ file: processed, width: 512, height: 384, changed: true }); await flush();
  assert.deepEqual(entry.photo.files, [processed]);
  assert.deepEqual(urls.created, [processed]);
  assert.equal(entry.photo.validationMessage, '');
  assert.match(entry.photoStatus.textContent, /512 × 384, 118 KiB/);
  assert.equal(emit(entry.form, 'submit').defaultPrevented, false);
  assert.notEqual(entry.photo.disabled, true);
  emit(win, 'pageshow');
  assert.deepEqual(entry.photo.files, [processed]);
  assert.equal(urls.created.at(-1), processed);
});

test('older preparation results and cleared selections cannot replace the current photo', async () => {
  const waiting = new Map();
  const prepare = file => new Promise((resolve, reject) => waiting.set(file, { resolve, reject }));
  const { entries: [entry], urls } = browser(1, { photo: true, prepare });
  const first = { name: 'first.png', type: 'image/png', size: 1000 };
  const second = { name: 'second.png', type: 'image/png', size: 2000 };
  entry.photo.files = [first]; emit(entry.photo, 'change');
  entry.photo.files = [second]; emit(entry.photo, 'change');
  waiting.get(first).resolve({ file: first, width: 32, height: 32 }); await flush();
  assert.equal(urls.created.length, 0);
  assert.equal(entry.button.disabled, true);
  waiting.get(second).resolve({ file: second, width: 40, height: 30 }); await flush();
  assert.deepEqual(entry.photo.files, [second]); assert.deepEqual(urls.created, [second]);
  entry.photo.files = [first]; emit(entry.photo, 'change');
  emit(entry.photoRemove, 'click');
  waiting.get(first).resolve({ file: first, width: 32, height: 32 }); await flush();
  assert.equal(entry.photo.files.length, 0);
  assert.equal(entry.photoPreview.hidden, true);
  assert.equal(entry.photo.validationMessage, '');
  assert.equal(entry.button.disabled, false);
  assert.deepEqual(urls.created, [second]);
});

test('decode failures keep the selected photo and block posting until it is removed', async () => {
  const { entries: [entry] } = browser(1, { photo: true, prepare: async () => { throw new Error('This photo could not be opened.'); } });
  write(entry, 'Keep the exact caption while I choose another image.');
  const file = { name: 'broken.png', type: 'image/png', size: 1000 };
  entry.photo.files = [file]; emit(entry.photo, 'change'); await flush();
  assert.deepEqual(entry.photo.files, [file]);
  assert.match(entry.photo.validationMessage, /could not be opened/);
  assert.equal(emit(entry.form, 'submit').defaultPrevented, true);
  assert.equal(entry.photoPreview.hidden, true);
  emit(entry.photoRemove, 'click');
  assert.equal(entry.text.value, 'Keep the exact caption while I choose another image.');
  assert.equal(emit(entry.form, 'submit').defaultPrevented, false);
});

test('formdata fallback submits the processed bytes when DataTransfer is unavailable', async () => {
  const original = { name: 'large.png', type: 'image/png', size: 3_000_000 };
  const processed = { name: 'large.png', type: 'image/png', size: 200_000 };
  const { entries: [entry], urls } = browser(1, { photo: true, dataTransfer: false,
    prepare: async () => ({ file: processed, width: 1024, height: 768 }) });
  write(entry, 'A resized photo from the coast.');
  entry.photo.files = [original]; emit(entry.photo, 'change'); await flush();
  assert.deepEqual(entry.photo.files, [original]);
  assert.deepEqual(urls.created, [processed]);
  assert.equal(emit(entry.form, 'submit').defaultPrevented, false);
  const event = new Event('formdata'), submitted = [];
  event.formData = { set(...args) { submitted.push(args); } };
  entry.form.dispatchEvent(event);
  assert.deepEqual(submitted, [['photo', processed, processed.name]]);
});

test('unsupported upload replacement blocks a changed photo but still allows already suitable originals', async () => {
  const original = { name: 'large.png', type: 'image/png', size: 3_000_000 };
  const processed = { name: 'large.png', type: 'image/png', size: 200_000 };
  const { entries: [entry], urls } = browser(1, { photo: true, dataTransfer: false, formDataEvent: false,
    prepare: async file => ({ file: file.size > 1_048_576 ? processed : file, width: 800, height: 600 }) });
  write(entry, 'My caption remains available.');
  entry.photo.files = [original]; emit(entry.photo, 'change'); await flush();
  assert.match(entry.photo.validationMessage, /cannot attach the resized photo/);
  assert.equal(emit(entry.form, 'submit').defaultPrevented, true);
  assert.equal(urls.created.length, 0);
  entry.photo.files = [processed]; emit(entry.photo, 'change'); await flush();
  assert.equal(entry.photo.validationMessage, '');
  assert.equal(emit(entry.form, 'submit').defaultPrevented, false);
});


test('unsaved profile fields are guarded and saving restores clean controls after Back', () => {
  const { win, entries: [entry] }=browser(1,{profile:true});
  assert.equal(emit(win,'beforeunload').defaultPrevented,false);
  entry.fields[0].value='Avery New';emit(entry.fields[0],'input');
  assert.equal(emit(win,'beforeunload').defaultPrevented,true);
  assert.equal(emit(entry.form,'submit').defaultPrevented,false);
  assert.equal(entry.fields[0].readOnly,true);
  assert.equal(emit(win,'beforeunload').defaultPrevented,false);
  emit(win,'pageshow');assert.equal(entry.fields[0].value,'Avery New');
  assert.equal(entry.fields[0].readOnly,false);
  assert.equal(emit(win,'beforeunload').defaultPrevented,true);
  entry.fields[0].value='Avery';emit(entry.fields[0],'input');
  assert.equal(emit(win,'beforeunload').defaultPrevented,false);
});


test('a rejected server-rendered profile draft remains unsaved even though it is the HTML default', () => {
  const { win, entries: [entry] }=browser(1,{profile:true});
  entry.fields[0].defaultValue=entry.fields[0].value='Avery Rejected';
  entry.fields[0].dataset={savedValue:'Avery'};
  emit(win,'pageshow');
  assert.equal(emit(win,'beforeunload').defaultPrevented,true);
  entry.fields[0].value='Avery';emit(entry.fields[0],'input');
  assert.equal(emit(win,'beforeunload').defaultPrevented,false);
});
