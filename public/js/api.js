const listeners = new Set();
let pending = 0;
let lastError = null;
let lastRetry = null;

export function onSaveState(cb) { listeners.add(cb); return () => listeners.delete(cb); }
export function saveState() { return { pending, lastError, lastRetry }; }
export function clearSaveError() { lastError = null; lastRetry = null; emit(); }

function emit() {
  const s = { pending, lastError, lastRetry };
  listeners.forEach((cb) => { try { cb(s); } catch (e) { console.error(e); } });
}

function bumpError(err, retry) {
  lastError = err;
  lastRetry = retry || null;
  emit();
}

async function request(method, path, body, { raw = false, silent = false } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined && !(body instanceof FormData)) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    init.body = body;
  }
  pending++;
  if (!silent) emit();
  try {
    const res = await fetch(path, init);
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!res.ok) {
      const msg = (data && data.message) || `请求失败（HTTP ${res.status}）`;
      const err = new Error(msg);
      err.payload = data;
      err.status = res.status;
      throw err;
    }
    if (!silent && lastError) { lastError = null; lastRetry = null; }
    return raw ? { res, data } : data;
  } finally {
    pending--;
    if (!silent) emit();
  }
}

/** 带自动保存状态跟踪的请求；失败时保留 retry */
export function tracked(method, path, body, opts = {}) {
  const run = () => request(method, path, body, opts);
  return run().catch((err) => {
    bumpError(err.message || '保存失败', () => tracked(method, path, body, opts));
    throw err;
  });
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b, o) => tracked('POST', p, b ?? {}, o),
  patch: (p, b, o) => tracked('PATCH', p, b ?? {}, o),
  del: (p, b, o) => tracked('DELETE', p, b ?? {}, o),
  put: (p, b, o) => tracked('PUT', p, b ?? {}, o),
  upload: (p, form) => tracked('POST', p, form),
  silentGet: (p) => request('GET', p, undefined, { silent: true }),
};
