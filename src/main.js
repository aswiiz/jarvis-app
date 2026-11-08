import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Client, DEFAULTS, clean, getPref, setPref, newSessionId } from './api.js';

const $ = (id) => document.getElementById(id);
const client = new Client();
let sessionId = '';
let cache = [];           // [{role, content, tasks?, attachments?}]
let pending = [];         // [{name, mime, data, preview}]
let busy = false;

// ---------- UI helpers ----------
function toast(msg, ms = 5000) {
  const t = $('toast');
  t.textContent = msg + '  ✕';
  t.classList.remove('hidden');
  t.onclick = () => t.classList.add('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function banner(msg) {
  const b = $('banner');
  if (!msg) return b.classList.add('hidden');
  b.textContent = msg; b.classList.remove('hidden');
}
function setDot(state) { $('status-dot').className = 'dot ' + (state || ''); }
function scrollDown() { const m = $('messages'); m.scrollTop = m.scrollHeight; }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- rendering ----------
function renderMedia(parent, url, mime) {
  const isAudio = (mime || '').startsWith('audio') || /\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(url);
  if (isAudio) {
    const a = el('audio'); a.controls = true; a.src = url; parent.appendChild(a);
  } else {
    const img = el('img', 'media'); img.src = url; img.loading = 'lazy';
    img.onclick = () => openZoom(url);
    parent.appendChild(img);
  }
}

function renderStepList(tasks) {
  const d = el('details', 'steps');
  d.appendChild(el('summary', null, `Show steps (${tasks.length})`));
  tasks.forEach((t) => {
    const s = el('div', 'step');
    const head = el('div');
    head.appendChild(el('b', null, `${t.task || 'task'}`));
    head.appendChild(document.createTextNode(` · ${t.model || '—'} · `));
    head.appendChild(el('span', t.status === 'done' ? 'st-done' : '', t.status || ''));
    s.appendChild(head);
    if (t.text) s.appendChild(el('div', null, t.text));
    if (t.error) s.appendChild(el('div', 'err', t.error));
    d.appendChild(s);
  });
  return d;
}

function renderMessage(m) {
  const b = el('div', `msg ${m.role}`);
  if (m.content) b.appendChild(document.createTextNode(m.content));
  (m.attachments || []).forEach((a) => {
    if (a.preview) { const i = el('img', 'media'); i.src = a.preview; i.onclick = () => openZoom(a.preview); b.appendChild(i); }
    else b.appendChild(el('div', 'attach-note', '📎 ' + a.name));
  });
  (m.tasks || []).forEach((t) => { if (t.file_url) renderMedia(b, t.file_url, t.mime); });
  if (m.tasks && m.tasks.length) b.appendChild(renderStepList(m.tasks));
  return b;
}

function renderAll() {
  const box = $('messages');
  box.innerHTML = '';
  cache.forEach((m) => box.appendChild(renderMessage(m)));
  scrollDown();
}

function showTyping(on) {
  let t = $('typing');
  if (on && !t) {
    t = el('div', 'typing'); t.id = 'typing';
    t.append(el('span'), el('span'), el('span'));
    $('messages').appendChild(t); scrollDown();
  } else if (!on && t) t.remove();
}

function openZoom(url) { const z = $('zoom'); z.querySelector('img').src = url; z.classList.remove('hidden'); }
$('zoom').onclick = () => $('zoom').classList.add('hidden');

// ---------- persistence ----------
async function saveCache() {
  // Don't store big base64 previews of attachments in cache; keep it light.
  const slim = cache.slice(-200).map((m) => ({
    ...m, attachments: (m.attachments || []).map((a) => ({ name: a.name })),
  }));
  await setPref('chat_' + sessionId, JSON.stringify(slim));
}
async function loadSession() {
  sessionId = await getPref('session_id', '');
  if (!sessionId) { sessionId = newSessionId(); await setPref('session_id', sessionId); }
  try { cache = JSON.parse(await getPref('chat_' + sessionId, '[]')); } catch { cache = []; }
  renderAll();
}

// ---------- attachments ----------
function renderChips() {
  const c = $('chips'); c.innerHTML = '';
  pending.forEach((f, i) => {
    const chip = el('div', 'chip');
    if (f.preview) { const im = el('img'); im.src = f.preview; chip.appendChild(im); } else chip.appendChild(el('span', null, '🎵'));
    chip.appendChild(el('span', 'nm', f.name));
    const x = el('button', null, '✕'); x.onclick = () => { pending.splice(i, 1); renderChips(); };
    chip.appendChild(x); c.appendChild(chip);
  });
}

function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
async function resizeToJpeg(dataUrl, max = 1600, q = 0.85) {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
const stripPrefix = (d) => d.replace(/^data:[^;]+;base64,/, '');

async function addFile(file) {
  if (pending.length >= 4) return toast('Up to 4 files per message.');
  try {
    const dataUrl = await readAsDataURL(file);
    if (file.type.startsWith('image/')) {
      const jpg = await resizeToJpeg(dataUrl);
      const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
      pending.push({ name: base + '.jpg', mime: 'image/jpeg', data: stripPrefix(jpg), preview: jpg });
    } else if (file.type.startsWith('audio/')) {
      pending.push({ name: file.name || 'audio', mime: file.type, data: stripPrefix(dataUrl), preview: null });
    } else {
      toast('Only images and audio files are supported.');
    }
    renderChips();
  } catch { toast('Could not read that file.'); }
}

$('btn-attach').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  for (const f of Array.from(e.target.files)) await addFile(f);
  e.target.value = '';
};
$('btn-camera').onclick = async () => {
  if (pending.length >= 4) return toast('Up to 4 files per message.');
  try {
    const p = await Camera.getPhoto({ quality: 90, resultType: CameraResultType.DataUrl, source: CameraSource.Camera });
    const jpg = await resizeToJpeg(p.dataUrl);
    pending.push({ name: `camera-${Date.now()}.jpg`, mime: 'image/jpeg', data: stripPrefix(jpg), preview: jpg });
    renderChips();
  } catch (e) {
    if (!/cancel/i.test(String(e?.message || e))) toast('Camera unavailable or permission denied.');
  }
};

// ---------- sending ----------
async function send() {
  if (busy) return;
  const input = $('input');
  const text = input.value.trim();
  if (!text && !pending.length) return;
  if (!client.configured) { openSettings(); return toast('Enter your backend URL and app token first.'); }

  busy = true; $('btn-send').disabled = true;
  const files = pending.map(({ name, mime, data }) => ({ name, mime, data }));
  const userMsg = { role: 'user', content: text, attachments: pending.map(({ name, preview }) => ({ name, preview })) };
  cache.push(userMsg);
  input.value = ''; input.style.height = 'auto'; pending = []; renderChips(); renderAll(); showTyping(true);

  try {
    const awake = await client.ensureAwake(() => banner('Waking up the server...'));
    banner('');
    if (!awake) throw Object.assign(new Error('Could not reach any server. Try again in a minute.'), { shown: true });
    setDot('ok');
    const data = await client.chat(text || 'Describe the attached file(s).', sessionId, files);
    cache.push({ role: 'assistant', content: data.response || '(no response)', tasks: data.tasks || [] });
  } catch (e) {
    banner('');
    setDot('bad');
    toast(e.message || 'Something went wrong.');
    cache.push({ role: 'assistant', content: '⚠️ ' + (e.message || 'Request failed.') });
  } finally {
    showTyping(false); renderAll(); await saveCache();
    busy = false; $('btn-send').disabled = false;
  }
}
$('btn-send').onclick = send;
$('input').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px'; });

// ---------- new chat / history ----------
$('btn-new').onclick = async () => {
  sessionId = newSessionId(); await setPref('session_id', sessionId);
  cache = []; pending = []; renderChips(); renderAll();
};
$('btn-history').onclick = async () => {
  $('history').classList.remove('hidden');
  const list = $('history-list'); list.innerHTML = '';
  if (!client.configured) { list.textContent = 'Set up the backend in Settings first.'; return; }
  list.textContent = 'Loading…';
  try {
    const data = await client.history(sessionId);
    list.innerHTML = '';
    (data.messages || []).forEach((m) => list.appendChild(el('div', `msg ${m.role}`, m.content)));
    if (!list.children.length) list.textContent = 'No messages yet.';
  } catch (e) { list.textContent = ''; toast(e.message); }
};
$('btn-close-history').onclick = () => $('history').classList.add('hidden');

// ---------- settings ----------
async function openSettings() {
  $('set-url').value = await getPref('backend_url', DEFAULTS.url);
  $('set-url2').value = await getPref('backend_url2', DEFAULTS.url2);
  $('set-token').value = await getPref('app_token', '');
  $('test-result').textContent = '';
  $('settings').classList.remove('hidden');
}
$('btn-settings').onclick = openSettings;
$('btn-close-settings').onclick = () => $('settings').classList.add('hidden');

$('btn-save').onclick = async () => {
  await setPref('backend_url', clean($('set-url').value));
  await setPref('backend_url2', clean($('set-url2').value));
  await setPref('app_token', $('set-token').value.trim());
  await client.load(); client.lastOk = 0;
  $('settings').classList.add('hidden');
  toast('Saved.', 1500); $('toast').style.background = 'var(--ok)';
  setTimeout(() => { $('toast').style.background = ''; }, 1700);
  pingStatus();
};

$('btn-test').onclick = async () => {
  const out = $('test-result');
  const bases = [clean($('set-url').value), clean($('set-url2').value)].filter(Boolean);
  if (!bases.length) { out.textContent = 'Enter a Backend URL first.'; return; }
  out.textContent = 'Testing… (a sleeping server can take up to a minute)';
  const lines = [];
  for (const b of bases) {
    try {
      const d = await new Client().health(b, 60000);
      lines.push(`✅ ${b}\n   storage: ${d.storage}, LLMs: ${(d.llm_providers || []).join(', ') || 'none'}, HF: ${d.huggingface}`);
    } catch (e) { lines.push(`❌ ${b}\n   ${e.message}`); }
    out.textContent = lines.join('\n');
  }
};

// ---------- startup ----------
async function pingStatus() {
  if (!client.bases.length) return;
  setDot('');
  const r = await client.probe(5000);
  setDot(r ? 'ok' : 'bad');
}

(async function init() {
  await client.load();
  await loadSession();
  if (!client.configured) { openSettings(); } else { pingStatus(); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && client.configured) pingStatus(); });
})();
