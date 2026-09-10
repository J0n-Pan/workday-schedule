import { api } from './api.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------------- 格式化 ---------------- */
export const STATUS_TEXT = { not_started: '未开始', in_progress: '进行中', waiting: '等待他人', done: '已完成', cancelled: '已取消' };
export const STATUS_CLASS = { not_started: 'gray', in_progress: 'blue', waiting: 'amber', done: 'green', cancelled: 'gray' };
export const PRIORITY_TEXT = { high: '高', medium: '中', low: '低' };
export const PRIORITY_CLASS = { high: 'red', medium: 'amber', low: 'gray' };
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
export function parseD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function addDays(s, n) {
  const d = parseD(s); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function mondayOf(s) {
  const dow = parseD(s).getUTCDay();
  return addDays(s, dow === 0 ? -6 : 1 - dow);
}
export function todayStr(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
export function fmtTime(iso, tz) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch {
    return String(iso).slice(11, 16);
  }
}
export function fmtDateTime(iso, tz) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch {
    return String(iso).replace('T', ' ').slice(0, 16);
  }
}
export function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function dateCn(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}

/* ---------------- Toast ---------------- */
export function toast(msg, kind = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, kind === 'error' ? 4200 : 2200);
}

/* ---------------- Modal ---------------- */
export function modal({ title, body, actions = [], width }) {
  const root = document.getElementById('modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const modalEl = document.createElement('div');
  modalEl.className = 'modal';
  if (width) modalEl.style.width = width;
  modalEl.innerHTML = `
    <div class="modal-head">${esc(title)}</div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div>`;
  const bodyEl = $('.modal-body', modalEl);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else bodyEl.appendChild(body);

  const close = () => mask.remove();
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = `btn ${a.kind || ''}`;
    b.textContent = a.label;
    if (a.disabled) b.disabled = true;
    b.onclick = async () => {
      if (a.onClick) {
        const r = await a.onClick({ bodyEl, close });
        if (r === false) return;
      }
      close();
    };
    $('.modal-foot', modalEl).appendChild(b);
  });
  if (!actions.length) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = '关闭';
    b.onclick = close;
    $('.modal-foot', modalEl).appendChild(b);
  }
  mask.appendChild(modalEl);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  root.appendChild(mask);
  return { close, bodyEl };
}

export function confirmDialog({ title, message, confirmText = '确定', kind = 'primary', extra, danger }) {
  return new Promise((resolve) => {
    let body = `<p style="margin:0 0 10px">${message}</p>`;
    if (extra) body += extra;
    modal({
      title,
      body,
      actions: [
        { label: '取消', onClick: () => { resolve(false); } },
        {
          label: confirmText,
          kind: danger ? 'danger' : kind,
          onClick: ({ bodyEl }) => { resolve({ ok: true, bodyEl }); },
        },
      ],
    });
  });
}

/* ---------------- Drawer ---------------- */
export function drawer({ title, body, onClose }) {
  const root = document.getElementById('drawer-root');
  const mask = document.createElement('div');
  mask.className = 'drawer-mask';
  const el = document.createElement('aside');
  el.className = 'drawer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="drawer-head">
      <h3></h3>
      <button class="btn icon ghost" data-close aria-label="关闭">✕</button>
    </div>
    <div class="drawer-body"></div>`;
  $('h3', el).textContent = title || '';
  const bodyEl = $('.drawer-body', el);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else bodyEl.appendChild(body);

  const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  $('[data-close]', el).onclick = close;
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  mask.appendChild(el);
  root.appendChild(mask);
  return { close, bodyEl, el };
}

/* ---------------- 自动保存（防抖 800ms） ---------------- */
export function bindAutosave(inputEl, saveFn, { delay = 800, onState } = {}) {
  let timer = null;
  let inflight = null;
  let lastValue = inputEl.value;
  const set = (s, extra) => onState && onState(s, extra);

  async function save() {
    const value = inputEl.value;
    if (value === lastValue) return;
    set('saving');
    const prev = lastValue;
    lastValue = value;
    try {
      inflight = saveFn(value);
      await inflight;
      set('saved');
    } catch (e) {
      lastValue = prev; // 失败后允许再次重试同一内容
      set('error', e);
    }
  }
  function schedule() {
    set('pending');
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, delay);
  }
  inputEl.addEventListener('input', schedule);
  inputEl.addEventListener('blur', () => { if (timer) { clearTimeout(timer); save(); } });

  return {
    flush: async () => { if (timer) { clearTimeout(timer); await save(); } },
    dispose: () => { if (timer) clearTimeout(timer); },
  };
}

export function saveIndicator(el) {
  return (state, err) => {
    if (state === 'pending') { el.className = 'save-state'; el.textContent = '待保存…'; return; }
    if (state === 'saving') { el.className = 'save-state saving'; el.innerHTML = '<span class="spinner" style="width:12px;height:12px"></span> 保存中…'; return; }
    if (state === 'saved') { el.className = 'save-state saved'; el.textContent = '已保存'; return; }
    if (state === 'error') {
      el.className = 'save-state error';
      el.innerHTML = `<span>保存失败：${esc(err?.message || '未知错误')}</span>`;
      const b = document.createElement('button');
      b.textContent = '重试';
      b.onclick = () => {
        const retry = window.__lastRetry;
        if (retry) retry();
      };
      el.appendChild(b);
    }
  };
}

/* ---------------- 附件上传 ---------------- */
export async function uploadFiles(ownerType, ownerId, files, onDone) {
  if (!files || !files.length) return;
  for (const f of files) {
    const form = new FormData();
    form.append('ownerType', ownerType);
    form.append('ownerId', ownerId);
    form.append('file', f);
    try {
      await api.upload('/api/attachments', form);
    } catch (e) {
      toast(`附件「${f.name}」上传失败：${e.message}`, 'error');
    }
  }
  onDone && onDone();
}

export function filePicker(multiple = true) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = multiple;
  input.style.display = 'none';
  document.body.appendChild(input);
  const p = new Promise((resolve) => {
    input.addEventListener('change', () => {
      resolve(Array.from(input.files || []));
      input.remove();
    });
  });
  input.click();
  return p;
}
