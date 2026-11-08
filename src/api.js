import { Preferences } from '@capacitor/preferences';

// ---- storage helpers -------------------------------------------------------
export async function getPref(key, fallback = '') {
  try {
    const { value } = await Preferences.get({ key });
    return value ?? fallback;
  } catch {
    return localStorage.getItem(key) ?? fallback;
  }
}
export async function setPref(key, value) {
  try { await Preferences.set({ key, value }); } catch { localStorage.setItem(key, value); }
}

// Pre-filled on first launch only. Editable in Settings; never contains keys.
export const DEFAULTS = {
  url: 'https://jarvis-ukcy.onrender.com',
  url2: 'https://jarviss-eight.vercel.app',
};

export const clean = (u) => (u || '').trim().replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message, status = 0, network = false) {
    super(message); this.status = status; this.network = network;
  }
}

function withTimeout(promise, ms, controller) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => { controller?.abort(); rej(new ApiError('Request timed out', 0, true)); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function rawFetch(url, opts = {}, ms = 15000) {
  const controller = new AbortController();
  try {
    return await withTimeout(fetch(url, { ...opts, signal: controller.signal }), ms, controller);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('Cannot reach the server. Check your internet connection.', 0, true);
  }
}

async function parse(res) {
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.ok) return data ?? {};
  const msg = data?.error;
  switch (res.status) {
    case 401: throw new ApiError(msg || 'Wrong app token. Check Settings.', 401);
    case 413: throw new ApiError(msg || 'File too large. Try a smaller file.', 413);
    case 400: throw new ApiError(msg || 'Bad request.', 400);
    case 503: throw new ApiError(msg || 'Server is busy or waking up. Try again.', 503);
    default: throw new ApiError(msg || `Server error (${res.status}).`, res.status);
  }
}

// ---- client with failover --------------------------------------------------
export class Client {
  constructor() { this.bases = []; this.token = ''; this.active = null; this.lastOk = 0; }

  async load() {
    const url = await getPref('backend_url', '__unset__');
    const url2 = await getPref('backend_url2', '__unset__');
    this.bases = [
      clean(url === '__unset__' ? DEFAULTS.url : url),
      clean(url2 === '__unset__' ? DEFAULTS.url2 : url2),
    ].filter(Boolean);
    this.token = await getPref('app_token', '');
    this.active = this.bases[0] || null;
  }

  get configured() { return this.bases.length > 0; }

  // Order to try: active first, then the others.
  ordered() {
    if (!this.active) return [...this.bases];
    return [this.active, ...this.bases.filter((b) => b !== this.active)];
  }

  async health(base, ms = 5000) {
    const res = await rawFetch(`${base}/health`, { method: 'GET' }, ms);
    return parse(res);
  }

  // Race all backends; first healthy one wins.
  async probe(ms = 5000) {
    const attempts = this.ordered().map((b) =>
      this.health(b, ms).then((data) => ({ base: b, data })));
    try {
      const winner = await Promise.any(attempts);
      this.active = winner.base; this.lastOk = Date.now();
      return winner;
    } catch {
      return null;
    }
  }

  // Wake-up logic: probe now, then every 5s for up to 90s.
  async ensureAwake(onWaking) {
    if (this.active && Date.now() - this.lastOk < 10 * 60 * 1000) return true;
    const started = Date.now();
    let first = true;
    while (Date.now() - started < 90000) {
      const t0 = Date.now();
      const ok = await this.probe(5000);
      if (ok) return true;
      if (first) { onWaking?.(); first = false; }
      const wait = Math.max(0, 5000 - (Date.now() - t0));
      await new Promise((r) => setTimeout(r, wait));
    }
    return false;
  }

  headers(json = true) {
    const h = {};
    if (this.token) h['X-API-Token'] = this.token;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  // Try the active backend; on network failure or 503, fail over once to the other(s).
  async request(path, opts, ms) {
    let lastErr;
    for (const base of this.ordered()) {
      try {
        const res = await rawFetch(`${base}${path}`, { ...opts, headers: this.headers(!!opts?.body) }, ms);
        const data = await parse(res);
        this.active = base; this.lastOk = Date.now();
        return data;
      } catch (e) {
        lastErr = e;
        if (!(e.network || e.status === 503 || e.status >= 500)) throw e; // 400/401/413: don't fail over
      }
    }
    throw lastErr;
  }

  chat(message, session_id, files) {
    return this.request('/chat', { method: 'POST', body: JSON.stringify({ message, session_id, files }) }, 180000);
  }
  history(session_id) {
    return this.request(`/history/${encodeURIComponent(session_id)}`, { method: 'GET' }, 30000);
  }
}

export function newSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const arr = new Uint8Array(20);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join('');
}
