import { api, onSaveState, clearSaveError } from './api.js';
import { $, $$, esc, toast, todayStr, addDays, mondayOf, weekdayOf, parseD } from './ui.js';
import { renderDay } from './views/day.js';
import { renderWeek } from './views/week.js';
import { renderUnscheduled } from './views/unscheduled.js';
import { renderData } from './views/data.js';
import { newTaskModal } from './views/task.js';

const state = { settings: null, today: '', date: '', view: 'day', day: null };

const ctx = {
  state,
  get settings() { return state.settings; },
  get today() { return state.today; },
  get date() { return state.date; },
  go(hash) { location.hash = hash; },
  refresh() { render(); },
  async reload() { await boot(); },
};

async function boot() {
  const info = await api.get('/api/settings');
  state.settings = info.settings;
  state.today = info.today;
  window.__tz = info.settings.timezone;
  window.__today = info.today;
  document.documentElement.dataset.theme = info.settings.theme === 'dark' ? 'dark' : 'light';
  if (!state.date) state.date = info.today;
  render();
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, date] = h.split('/');
  if (view === 'unscheduled') return { view: 'unscheduled', date: state.date };
  if (view === 'data') return { view: 'data', date: state.date };
  if (view === 'week') return { view: 'week', date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : mondayOf(state.today) };
  if (view === 'day') return { view: 'day', date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : (state.date || state.today) };
  if (/^\d{4}-\d{2}-\d{2}$/.test(view)) return { view: 'day', date: view };
  return { view: 'day', date: state.date || state.today };
}

function render() {
  const r = parseHash();
  state.view = r.view;
  state.date = r.date;

  const root = document.getElementById('app');
  root.innerHTML = shell();
  bindShell();
  updateSaveIndicator();
  const main = $('#main', root);

  if (r.view === 'day') renderDay(main, ctx);
  else if (r.view === 'week') renderWeek(main, ctx);
  else if (r.view === 'unscheduled') renderUnscheduled(main, ctx);
  else renderData(main, ctx);
}

function shell() {
  const s = state.settings;
  const d = state.date;
  const isWeek = state.view === 'week';
  const titleDate = isWeek ? `${mondayOf(d)} ~ ${addDays(mondayOf(d), 6)}` : d;
  return `
  <div class="layout">
    <nav class="sidebar" id="sidebar">
      <div class="brand">
        <div class="brand-name">工作日程</div>
      </div>
      <div class="nav">
        <button class="nav-item ${state.view === 'day' ? 'active' : ''}" data-nav="day">📅 每日工作台</button>
        <button class="nav-item ${state.view === 'unscheduled' ? 'active' : ''}" data-nav="unscheduled">🗂 待安排任务</button>
        <button class="nav-item ${state.view === 'week' ? 'active' : ''}" data-nav="week">📊 周回顾</button>
        <button class="nav-item ${state.view === 'data' ? 'active' : ''}" data-nav="data">⚙️ 数据管理</button>
      </div>
      <div class="mini-cal">
        <div class="mini-cal-head">
          <button class="btn icon ghost sm" id="cal-prev" aria-label="上一月">‹</button>
          <strong id="cal-title"></strong>
          <button class="btn icon ghost sm" id="cal-next" aria-label="下一月">›</button>
        </div>
        <div class="mini-cal-grid" id="cal-grid"></div>
      </div>
      <div class="sidebar-foot">
        <div>时区 ${esc(s.timezone)}</div>
        <div>数据：本地 SQLite 数据库</div>
      </div>
    </nav>

    <div class="main">
      <header class="topbar">
        <button class="btn ghost mobile-only" id="menu" aria-label="打开导航">☰</button>
        <div class="date-nav">
          <button class="btn icon" id="d-prev" aria-label="前一天">‹</button>
          <div class="date-title">
            <b id="d-title">${esc(titleDate)}</b>
            <span id="d-sub">${isWeek ? '周回顾' : `${weekdayOf(d)}${d === state.today ? ' · 今天' : ''}${d < state.today ? ' · 历史记录' : ''}${d > state.today ? ' · 未来' : ''}`}</span>
          </div>
          <button class="btn icon" id="d-next" aria-label="后一天">›</button>
          <button class="btn sm" id="d-today" ${d === state.today ? 'disabled' : ''}>回到今天</button>
        </div>
        <div class="topbar-spacer"></div>
        <div id="save-indicator"></div>
        ${state.view === 'day' ? `<button class="btn primary" id="new-task">+ 新增任务</button>` : ''}
      </header>
      <main class="content" id="main"></main>
    </div>
  </div>`;
}

let calMonth = null;
function bindShell() {
  const root = document.getElementById('app');
  const s = state.settings;

  $$('[data-nav]').forEach((b) => b.onclick = () => {
    const v = b.dataset.nav;
    document.getElementById('sidebar').classList.remove('open');
    closeScrim();
    if (v === 'day') location.hash = `#/day/${state.date}`;
    else if (v === 'week') location.hash = `#/week/${mondayOf(state.date)}`;
    else location.hash = `#/${v}`;
  });

  $('#menu').onclick = () => {
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('open');
    if (sb.classList.contains('open')) {
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      scrim.id = 'scrim';
      scrim.onclick = closeScrim;
      document.body.appendChild(scrim);
    } else closeScrim();
  };

  const step = (n) => {
    if (state.view === 'week') location.hash = `#/week/${addDays(mondayOf(state.date), n * 7)}`;
    else if (state.view === 'day') location.hash = `#/day/${addDays(state.date, n)}`;
  };
  $('#d-prev').onclick = () => step(-1);
  $('#d-next').onclick = () => step(1);
  $('#d-today').onclick = () => {
    if (state.view === 'week') location.hash = `#/week/${mondayOf(state.today)}`;
    else location.hash = `#/day/${state.today}`;
  };
  const nt = $('#new-task', root);
  if (nt) nt.onclick = () => newTaskModal(ctx, state.date);

  // 迷你日历
  if (!calMonth) calMonth = state.date.slice(0, 7);
  renderCal();
  $('#cal-prev').onclick = () => { calMonth = shiftMonth(calMonth, -1); renderCal(); };
  $('#cal-next').onclick = () => { calMonth = shiftMonth(calMonth, 1); renderCal(); };

  function renderCal() {
    const [y, m] = calMonth.split('-').map(Number);
    $('#cal-title').textContent = `${y} 年 ${m} 月`;
    const first = new Date(Date.UTC(y, m - 1, 1));
    const startDow = first.getUTCDay();
    const start = addDays(calMonth + '-01', -(startDow === 0 ? 6 : startDow - 1));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i);
      const out = day.slice(0, 7) !== calMonth;
      const cls = ['mini-day'];
      if (out) cls.push('out');
      if (day === state.today) cls.push('today');
      if (day === state.date) cls.push('sel');
      cells.push(`<button class="${cls.join(' ')}" data-d="${day}" title="${day}">${Number(day.slice(8))}</button>`);
    }
    $('#cal-grid').innerHTML = ['一', '二', '三', '四', '五', '六', '日'].map((d) => `<div class="dow">${d}</div>`).join('') + cells.join('');
    $$('#cal-grid [data-d]').forEach((b) => b.onclick = () => {
      location.hash = state.view === 'week' ? `#/week/${mondayOf(b.dataset.d)}` : `#/day/${b.dataset.d}`;
    });
  }
  void s;
}

function closeScrim() {
  const sc = document.getElementById('scrim');
  if (sc) sc.remove();
  const sb = document.getElementById('sidebar');
  if (sb) sb.classList.remove('open');
}

function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* ---------------- 保存状态 ---------------- */
function updateSaveIndicator() { window.__saveState = { pending: 0, lastError: null, lastRetry: null }; renderSaveEl(); }
onSaveState((s) => { window.__saveState = s; renderSaveEl(); });

let lastErrShown = '';
function renderSaveEl() {
  const el = document.getElementById('save-indicator');
  if (!el) return;
  const { pending, lastError, lastRetry } = window.__saveState || { pending: 0, lastError: null, lastRetry: null };
  const s = { pending, lastError, lastRetry };
  if (s.lastError) {
    el.innerHTML = `<span class="save-state error">保存失败：${esc(s.lastError)}
      <button id="retry-save">重试</button><button id="dismiss-save">忽略</button></span>`;
    $('#retry-save', el).onclick = () => { const r = s.lastRetry; clearSaveError(); r && r(); };
    $('#dismiss-save', el).onclick = () => clearSaveError();
    if (s.lastError !== lastErrShown) { lastErrShown = s.lastError; toast(`保存失败：${s.lastError}`, 'error'); }
    return;
  }
  if (s.pending > 0) { el.innerHTML = `<span class="save-state saving"><span class="spinner" style="width:12px;height:12px"></span> 保存中…</span>`; return; }
  el.innerHTML = `<span class="save-state saved">已保存</span>`;
}

window.addEventListener('hashchange', render);
window.addEventListener('beforeunload', (e) => {
  const st = window.__saveState;
  if (st && st.pending > 0) { e.preventDefault(); e.returnValue = ''; }
});

boot().catch((e) => {
  document.getElementById('app').innerHTML =
    `<div class="empty"><h3>无法连接到服务</h3><p>${esc(e.message)}</p>
     <p class="small muted">请确认后端已启动（默认 http://127.0.0.1:5173）。</p></div>`;
});
