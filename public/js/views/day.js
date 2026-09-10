import { api } from '../api.js';
import {
  $, $$, esc, toast, modal, drawer, confirmDialog, bindAutosave, saveIndicator, uploadFiles, filePicker,
  STATUS_TEXT, STATUS_CLASS, PRIORITY_TEXT, PRIORITY_CLASS, fmtTime, fmtSize, dateCn, weekdayOf,
} from '../ui.js';
import { openTaskDrawer, newTaskModal } from './task.js';

const carried = new Set();

export async function renderDay(root, ctx) {
  const { date, settings, today } = ctx;
  root.innerHTML = `<div class="loading"><span class="spinner"></span> 正在加载 ${date} 的工作台…</div>`;

  if (date === today && !carried.has(date)) {
    try {
      const r = await api.post('/api/carry', { date, requestId: `${date}:${Math.random().toString(36).slice(2)}` });
      carried.add(date);
      if (r.carried && r.carried.length) {
        toast(`已承接 ${r.carried.length} 项未完成工作`, 'ok');
      }
    } catch (e) {
      toast(`自动承接失败：${e.message}`, 'error');
    }
  }

  let day;
  try {
    day = await api.get(`/api/days/${date}`);
  } catch (e) {
    root.innerHTML = `<div class="empty"><h3>加载失败</h3><p>${esc(e.message)}</p><button class="btn primary" id="retry">重试</button></div>`;
    $('#retry', root).onclick = () => ctx.refresh();
    return;
  }
  ctx.state.day = day;

  const s = day.stats;
  const isToday = day.isToday;
  const canPlan = true;

  root.innerHTML = `
    ${day.isFuture ? `<div class="notice info">未来日期：可以提前安排计划，但不会自动承接"当天尚未结束"的工作。</div>` : ''}
    ${day.isHistory ? `<div class="notice info">正在查看 <b>${dateCn(date)}（${weekdayOf(date)}）</b> 的历史记录。在此页的记录会写入该日期，不会触发跨天继承。</div>` : ''}
    ${day.deferredStreak.length ? `<div class="notice warn">有 ${day.deferredStreak.length} 项任务连续顺延且无推进（阈值 ${settings.deferStreakThreshold} 次），建议拆分任务、调整安排或补充阻碍。</div>` : ''}

    <div class="grid-main">
      <div>
        <section class="card" id="focus-card">
          <div class="card-head">
            <h2>今日重点</h2>
            <span class="hint">每天最多 ${settings.focusLimit} 项${isToday ? '' : '（非今天，仅供参考）'}</span>
            <div style="flex:1"></div>
            <button class="btn sm" id="add-task">+ 新增任务</button>
          </div>
          <div class="card-body tight" id="focus-body"></div>
        </section>

        <section class="card">
          <div class="card-head">
            <h2>今日计划</h2>
            <span class="hint">共 ${s.total} 项 · 已完成 ${s.done} · 进行中 ${s.inProgress}</span>
            <div style="flex:1"></div>
            <button class="btn sm" id="add-adhoc">+ 临时新增事项</button>
          </div>
          <div class="filters">
            <input type="search" id="q" placeholder="搜索标题 / 描述 / 项目 / 下一步" style="min-width:200px;flex:1" />
            <select id="f-status">
              <option value="">全部状态</option>
              <option value="not_started">未开始</option>
              <option value="in_progress">进行中</option>
              <option value="waiting">等待他人</option>
              <option value="done">已完成</option>
              <option value="cancelled">已取消</option>
            </select>
            <select id="f-priority">
              <option value="">全部优先级</option>
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
            <select id="f-project"><option value="">全部项目</option></select>
            <button class="chip" id="f-focus">仅看重点</button>
          </div>
          <div id="plan-body"></div>
        </section>

        <section class="card">
          <div class="card-head">
            <h2>今日成果</h2>
            <span class="hint">当天实际完成的工作增量，共 ${s.achievementCount} 条</span>
            <div style="flex:1"></div>
            <button class="btn sm" id="add-standalone">+ 记录独立成果</button>
          </div>
          <div class="card-body" id="ach-body"></div>
        </section>
      </div>

      <aside class="stack">
        <section class="card">
          <div class="card-head"><h2>提醒</h2></div>
          <div class="card-body" id="remind-body"></div>
        </section>
        <section class="card">
          <div class="card-head"><h2>阻碍与跟进</h2></div>
          <div class="card-body" id="blocker-body"></div>
        </section>
        <section class="card">
          <div class="card-head"><h2>下一步安排</h2></div>
          <div class="card-body" id="next-body"></div>
        </section>
        <section class="card" id="service-card">
          <div class="card-head"><h2>服务</h2><span class="hint">本机后台进程</span></div>
          <div class="card-body">
            <p class="small muted" style="margin:0 0 10px">关闭浏览器页面不会停止服务；需要彻底结束时点下方按钮，本机服务进程会退出，数据已实时保存在磁盘上。</p>
            <button class="btn danger solid block" id="stop-server">停止服务</button>
          </div>
        </section>
      </aside>
    </div>`;

  // 项目筛选
  const projects = [...new Set(day.plans.map((p) => p.task.project).filter(Boolean))];
  const fp = $('#f-project', root);
  projects.forEach((p) => { const o = document.createElement('option'); o.value = p; o.textContent = p; fp.appendChild(o); });

  const filters = { q: '', status: '', priority: '', project: '', focusOnly: false };

  function filtered() {
    return day.plans.filter((p) => {
      const t = p.task;
      if (filters.status && t.status !== filters.status) return false;
      if (filters.priority && t.priority !== filters.priority) return false;
      if (filters.project && t.project !== filters.project) return false;
      if (filters.focusOnly && !p.plan.isFocus) return false;
      if (filters.q) {
        const q = filters.q.toLowerCase();
        const hay = `${t.title} ${t.description} ${t.project} ${t.nextAction}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderPlans() {
    const list = filtered();
    const el = $('#plan-body', root);
    if (!day.plans.length) {
      el.innerHTML = `<div class="empty">
        <h3>${day.isFuture ? '这天还没有安排' : '今天还没有计划'}</h3>
        <p>${day.isFuture ? '可以提前安排任务，到期当天会作为已安排任务处理。' : '新增任务后即可开始记录进度与成果；未完成的工作会在之后的日子自动承接。'}</p>
        <button class="btn primary" id="empty-add">新增任务</button>
      </div>`;
      $('#empty-add', el).onclick = () => newTaskModal(ctx, date);
      return;
    }
    if (!list.length) {
      el.innerHTML = `<div class="empty"><h3>没有符合条件的任务</h3><p>试试调整搜索词或筛选条件。</p><button class="btn" id="clear-filter">清空筛选</button></div>`;
      $('#clear-filter', el).onclick = () => { Object.assign(filters, { q: '', status: '', priority: '', project: '', focusOnly: false }); syncFilterUI(); renderPlans(); };
      return;
    }
    el.innerHTML = `<div class="task-list">${list.map((p, i) => taskRow(p, i, list.length, ctx, day)).join('')}</div>`;
    bindRows(el, list, ctx, day);
  }

  function syncFilterUI() {
    $('#q', root).value = filters.q;
    $('#f-status', root).value = filters.status;
    $('#f-priority', root).value = filters.priority;
    $('#f-project', root).value = filters.project;
    $('#f-focus', root).classList.toggle('on', filters.focusOnly);
  }

  function renderFocus() {
    const focus = day.plans.filter((p) => p.plan.isFocus).slice(0, settings.focusLimit);
    const el = $('#focus-body', root);
    if (!focus.length) {
      el.innerHTML = `<div class="empty" style="padding:16px"><p style="margin:0">还没有设置今日重点。可在下方任务上点击 ☆ 设为重点（最多 ${settings.focusLimit} 项）。</p></div>`;
      return;
    }
    el.innerHTML = `<div class="task-list">${focus.map((p) => taskRow(p, -1, 0, ctx, day, { compact: true })).join('')}</div>`;
    bindRows(el, focus, ctx, day);
  }

  function renderAch() {
    const el = $('#ach-body', root);
    const all = [
      ...day.plans.flatMap((p) => p.achievements.map((a) => ({ ...a, taskTitle: p.task.title }))),
      ...day.standaloneAchievements.map((a) => ({ ...a, taskTitle: null })),
    ].sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
    if (!all.length) {
      el.innerHTML = `<div class="empty" style="padding:20px"><p style="margin:0 0 8px">${day.isFuture ? '未来日期暂无成果' : '今天还没有记录成果'}</p>
        <p class="small muted" style="margin:0">进度百分比不会自动生成成果，推进后请手动记录"今天具体完成了什么"。</p></div>`;
      return;
    }
    el.innerHTML = all.map(achCard).join('');
    $$('[data-del-ach]', el).forEach((b) => b.onclick = async () => {
      if (!await confirmDefault('删除这条成果？删除后可在数据管理中查看审计记录。')) return;
      try { await api.del(`/api/achievements/${b.dataset.delAch}`); toast('已删除', 'ok'); ctx.refresh(); } catch (e) { toast(e.message, 'error'); }
    });
  }

  function renderReminders() {
    const el = $('#remind-body', root);
    const { overdue, dueSoon, followUps } = day.reminders;
    const parts = [];
    if (overdue.length) {
      parts.push(`<div class="notice danger"><div><b>已逾期 ${overdue.length} 项</b><ul class="list-plain" style="margin-top:6px">
        ${overdue.map((t) => `<li><span class="dotmark ${t.priority}"></span><span>${esc(t.title)}</span><span class="badge red">截止 ${t.dueDate}</span></li>`).join('')}
      </ul></div></div>`);
    }
    if (dueSoon.length) {
      parts.push(`<div class="notice warn"><div><b>临近截止 ${dueSoon.length} 项</b><ul class="list-plain" style="margin-top:6px">
        ${dueSoon.map((t) => `<li><span>${esc(t.title)}</span><span class="badge amber">${t.dueDate}</span></li>`).join('')}
      </ul></div></div>`);
    }
    if (followUps.length) {
      parts.push(`<div class="notice info"><div><b>待跟进 ${followUps.length} 项</b><ul class="list-plain" style="margin-top:6px">
        ${followUps.map((f) => `<li><span>${esc(f.taskTitle)}</span><span class="badge ${f.overdue ? 'red' : 'blue'}">${f.followUpDate}${f.overdue ? '（已过期）' : ''}</span></li>`).join('')}
      </ul></div></div>`);
    }
    if (!parts.length) el.innerHTML = `<div class="small muted">没有逾期、临近截止或待跟进事项。</div>`;
    else el.innerHTML = parts.join('');
    bindOpen(el);
  }

  function renderBlockers() {
    const el = $('#blocker-body', root);
    const open = [];
    day.plans.forEach((p) => p.blockers.forEach((b) => open.push({ ...b, taskTitle: p.task.title })));
    const waiting = day.plans.filter((p) => p.task.status === 'waiting');
    if (!open.length && !waiting.length) {
      el.innerHTML = `<div class="small muted">今日计划中没有等待他人或阻碍事项。</div>`;
      return;
    }
    el.innerHTML = `
      ${waiting.map((p) => `<div class="small" style="margin-bottom:8px"><span class="badge amber">等待他人</span>
        <a href="#" data-open="${p.task.id}">${esc(p.task.title)}</a>
        <div class="muted">下一步：${esc(p.task.nextAction || '未填写')}</div></div>`).join('')}
      ${open.map((b) => `<div class="small" style="border-top:1px dashed var(--border);padding-top:8px;margin-top:6px">
        <div><b>${esc(b.taskTitle)}</b> <span class="badge ${b.status === 'open' ? 'amber' : 'green'}">${b.status === 'open' ? '未解决' : '已解决'}</span></div>
        <div class="muted">${esc(b.reason || '未填写原因')}</div>
        ${b.needWho ? `<div class="muted">需 ${esc(b.needWho)} 协助${b.needWhat ? `：${esc(b.needWhat)}` : ''}</div>` : ''}
        ${b.followUpDate ? `<div class="muted">下次跟进：${b.followUpDate}</div>` : ''}
      </div>`).join('')}`;
    bindOpen(el);
  }

  function renderNext() {
    const el = $('#next-body', root);
    const items = day.plans.filter((p) => p.task.status !== 'done' && p.task.status !== 'cancelled');
    if (!items.length) { el.innerHTML = `<div class="small muted">暂无待继续的任务。</div>`; return; }
    el.innerHTML = `<ul class="list-plain">${items.map((p) => `<li>
      <a href="#" data-open="${p.task.id}">${esc(p.task.title)}</a>
      <span class="small muted">${esc(p.task.nextAction || '未填写下一步动作')}</span>
    </li>`).join('')}</ul>`;
    bindOpen(el);
  }

  function bindOpen(el) {
    $$('[data-open]', el).forEach((a) => a.onclick = (e) => {
      e.preventDefault();
      const p = day.plans.find((x) => x.task.id === a.dataset.open);
      if (p) openTaskDrawer(ctx, p, date);
    });
  }

  // 事件绑定
  $('#add-task', root).onclick = () => newTaskModal(ctx, date);
  $('#add-adhoc', root).onclick = () => newTaskModal(ctx, date, { adhoc: true });
  $('#add-standalone', root).onclick = () => achievementModal(ctx, { bizDate: date, taskId: null });
  $('#q', root).addEventListener('input', (e) => { filters.q = e.target.value; renderPlans(); });
  $('#f-status', root).onchange = (e) => { filters.status = e.target.value; renderPlans(); };
  $('#f-priority', root).onchange = (e) => { filters.priority = e.target.value; renderPlans(); };
  $('#f-project', root).onchange = (e) => { filters.project = e.target.value; renderPlans(); };
  $('#f-focus', root).onclick = (e) => { filters.focusOnly = !filters.focusOnly; e.target.classList.toggle('on', filters.focusOnly); renderPlans(); };
  $('#stop-server', root).onclick = () => stopServiceFlow(root);

  renderFocus(); renderPlans(); renderAch(); renderReminders(); renderBlockers(); renderNext();
  void canPlan;
}

function taskRow(p, index, total, ctx, day, opts = {}) {
  const t = p.task;
  const plan = p.plan;
  const overdue = t.dueDate && t.dueDate < day.today && t.status !== 'done' && t.status !== 'cancelled';
  const delta = plan.endProgress - plan.startProgress;
  return `
  <div class="task ${t.status === 'done' ? 'done' : ''} ${t.status === 'cancelled' ? 'cancelled' : ''}" data-task="${t.id}" data-plan="${plan.id}">
    <button class="check ${t.status === 'done' ? 'on' : ''}" data-act="toggle" title="${t.status === 'done' ? '重新打开' : '标记完成'}" aria-label="${t.status === 'done' ? '重新打开任务' : '标记任务完成'}">✓</button>
    <div class="task-main">
      <div class="task-title" data-act="open">${esc(t.title)}</div>
      <div class="task-meta">
        <span class="badge ${PRIORITY_CLASS[t.priority]}"><span class="dotmark ${t.priority}"></span>${PRIORITY_TEXT[t.priority]}优先</span>
        <span class="badge ${STATUS_CLASS[t.status]}">${STATUS_TEXT[t.status]}</span>
        ${t.project ? `<span class="badge gray">${esc(t.project)}</span>` : ''}
        ${plan.isFocus ? `<span class="badge cyan">重点</span>` : ''}
        ${plan.source === 'carry' ? `<span class="badge cyan">承接自 ${plan.carriedFrom || '历史'}</span>` : ''}
        ${plan.source === 'adhoc' || t.isAdhoc ? `<span class="badge amber">临时新增</span>` : ''}
        ${t.dueDate ? `<span class="badge ${overdue ? 'red' : 'gray'}">${overdue ? '已逾期 ' : '截止 '}${t.dueDate}</span>` : ''}
        ${t.deferredUntil ? `<span class="badge amber">已延期至 ${t.deferredUntil}</span>` : ''}
        ${(t.deferStreak || 0) >= ctx.settings.deferStreakThreshold ? `<span class="badge amber">连续顺延 ${t.deferStreak} 次</span>` : ''}
      </div>
      ${t.nextAction ? `<div class="task-next"><b>下一步：</b>${esc(t.nextAction)}</div>` : ''}
      <div class="progress-line">
        <div class="bar ${t.progress === 100 ? 'done' : ''}"><i style="width:${t.progress}%"></i></div>
        <span class="pct">${plan.startProgress}% → <b>${plan.endProgress}%</b>${delta ? ` <span class="delta">(+${delta})</span>` : ''}</span>
      </div>
    </div>
    <div class="task-actions">
      ${opts.compact ? '' : `
        <button class="focus-star ${plan.isFocus ? 'on' : ''}" data-act="focus" title="设为今日重点" aria-label="设为今日重点">${plan.isFocus ? '★' : '☆'}</button>
        <button class="btn sm" data-act="progress">更新进度</button>
        <button class="btn sm" data-act="ach">记成果</button>
        <button class="btn sm" data-act="defer">延期</button>
        ${index >= 0 ? `<button class="btn sm ghost" data-act="up" ${index === 0 ? 'disabled' : ''} aria-label="上移">↑</button>
        <button class="btn sm ghost" data-act="down" ${index === total - 1 ? 'disabled' : ''} aria-label="下移">↓</button>` : ''}
      `}
      <button class="btn sm ghost" data-act="open">详情</button>
    </div>
  </div>`;
}

function bindRows(el, list, ctx, day) {
  $$('[data-task]', el).forEach((row) => {
    const p = list.find((x) => x.task.id === row.dataset.task);
    if (!p) return;
    $$('[data-act]', row).forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        try {
          if (act === 'open') return openTaskDrawer(ctx, p, day.date);
          if (act === 'toggle') return toggleDone(ctx, p, day);
          if (act === 'focus') {
            await api.patch(`/api/plans/${p.plan.id}`, { isFocus: !p.plan.isFocus, version: p.plan.version });
            return ctx.refresh();
          }
          if (act === 'progress') return progressModal(ctx, p, day);
          if (act === 'ach') return achievementModal(ctx, { bizDate: day.date, taskId: p.task.id });
          if (act === 'defer') return deferModal(ctx, p, day);
          if (act === 'up' || act === 'down') {
            const ids = list.map((x) => x.plan.id);
            const i = ids.indexOf(p.plan.id);
            const j = act === 'up' ? i - 1 : i + 1;
            if (j < 0 || j >= ids.length) return;
            [ids[i], ids[j]] = [ids[j], ids[i]];
            await api.post('/api/days/reorder', { date: day.date, planIds: ids });
            return ctx.refresh();
          }
        } catch (err) { toast(err.message, 'error'); }
      };
    });
  });
}

export function achCard(a) {
  return `<div class="ach">
    <div class="ach-head">
      <span class="badge ${a.taskId ? 'blue' : 'cyan'}">${a.taskId ? esc(a.taskTitle || '任务成果') : '独立成果'}</span>
      <span>${a.bizDate} ${fmtTime(a.createdAt, window.__tz)}</span>
      <div style="flex:1"></div>
      <button class="btn sm ghost" data-del-ach="${a.id}">删除</button>
    </div>
    <div class="ach-content">${esc(a.content)}</div>
    ${a.attachments && a.attachments.length ? `<div class="ach-files">${a.attachments.map((f) => `<a class="file-chip" href="${f.url}" target="_blank" rel="noreferrer">📎 ${esc(f.name)}</a>`).join('')}</div>` : ''}
  </div>`;
}

async function confirmDefault(msg) {
  const r = await confirmDialog({ title: '请确认', message: msg, danger: true, confirmText: '确定' });
  return !!r;
}

export function toggleDone(ctx, p, day) {
  const t = p.task;
  if (t.status === 'done') {
    modal({
      title: `重新打开「${t.title}」`,
      body: `<div class="field"><label>选择未完成状态</label>
        <select class="input" id="st"><option value="in_progress">进行中</option><option value="not_started">未开始</option><option value="waiting">等待他人</option></select></div>
        <div class="field"><label>当前进度（必须小于 100%）</label>
        <input class="input" type="number" id="pg" min="0" max="99" value="${Math.min(90, t.progress)}" /></div>
        <p class="field-hint">重新打开后，明天的自动承接会重新包含该任务。</p>`,
      actions: [{ label: '取消' }, {
        label: '重新打开',
        kind: 'primary',
        onClick: async ({ bodyEl }) => {
          const status = $('#st', bodyEl).value;
          const pg = Number($('#pg', bodyEl).value);
          if (!(pg >= 0 && pg < 100)) { toast('进度必须是 0~99 的整数', 'error'); return false; }
          try {
            await api.post(`/api/tasks/${t.id}/progress`, { progress: pg, status, bizDate: day.date, version: t.version });
            toast('已重新打开', 'ok'); ctx.refresh();
          } catch (e) { toast(e.message, 'error'); return false; }
        },
      }],
    });
    return;
  }
  modal({
    title: `完成「${t.title}」`,
    body: `<p style="margin:0 0 10px">完成后进度将设为 100%，并终止后续的自动承接。</p>
      <div class="field"><label>备注（可选）</label><input class="input" id="note" placeholder="例如：已提交负责人审核" /></div>`,
    actions: [{ label: '取消' }, {
      label: '标记完成',
      kind: 'primary',
      onClick: async ({ bodyEl }) => {
        try {
          await api.post(`/api/tasks/${t.id}/progress`, {
            progress: 100, status: 'done', bizDate: day.date, version: t.version, note: $('#note', bodyEl).value,
          });
          toast('已完成', 'ok'); ctx.refresh();
        } catch (e) { toast(e.message, 'error'); return false; }
      },
    }],
  });
}

export function progressModal(ctx, p, day) {
  const t = p.task;
  modal({
    title: `更新进度 · ${t.title}`,
    body: `<div class="field">
        <label>累计进度：<b id="pv">${t.progress}</b>%</label>
        <input type="range" id="pg" min="0" max="100" step="5" value="${t.progress}" style="width:100%" />
        <div class="row"><input class="input" type="number" id="pgn" min="0" max="100" value="${t.progress}" style="width:100px" /><span class="field-hint">0~100 的整数</span></div>
      </div>
      <div class="field"><label>状态</label>
        <select class="input" id="st">${Object.entries(STATUS_TEXT).map(([k, v]) => `<option value="${k}" ${k === t.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div class="field"><label>本次推进说明（可选，写入变更日志）</label>
        <input class="input" id="note" placeholder="例如：补充预算章节" /></div>
      <p class="field-hint">进度百分比不会自动生成成果描述，建议同时在「记成果」中记录今天具体完成了什么。</p>`,
    actions: [{ label: '取消' }, {
      label: '保存',
      kind: 'primary',
      onClick: async ({ bodyEl }) => {
        const pg = Number($('#pgn', bodyEl).value);
        const st = $('#st', bodyEl).value;
        try {
          await api.post(`/api/tasks/${t.id}/progress`, {
            progress: pg, status: st, bizDate: day.date, version: t.version, note: $('#note', bodyEl).value,
          });
          toast('已保存', 'ok'); ctx.refresh();
        } catch (e) { toast(e.message, 'error'); return false; }
      },
    }],
  });
  const range = $('#pg', document);
  const num = $('#pgn', document);
  range.oninput = () => { num.value = range.value; $('#pv', document).textContent = range.value; };
  num.oninput = () => { range.value = num.value; $('#pv', document).textContent = num.value; };
}

export function achievementModal(ctx, { bizDate, taskId, tasks }) {
  modal({
    title: '记录成果',
    body: `<div class="field"><label>成果内容（今天具体完成了什么）</label>
        <textarea class="input" id="content" placeholder="例如：补充预算章节，完成两轮修改。" style="min-height:120px"></textarea></div>
      ${taskId === null && tasks ? `<div class="field"><label>关联任务（可选，留空为独立成果）</label>
        <select class="input" id="tid"><option value="">不关联（独立成果）</option>${tasks.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>附件或链接（可选）</label>
        <div class="row"><button class="btn sm" id="pick">选择文件</button><span class="field-hint" id="finfo">支持多文件，单个不超过 25MB</span></div>
        <div id="flist" class="stack" style="margin-top:6px"></div>
        <input class="input" id="link" placeholder="或粘贴链接，随成果文本一起保存" />
      </div>
      <p class="field-hint">成果归属业务日期：<b>${bizDate}</b>${bizDate === ctx.today ? '' : '（历史日期补记）'}</p>`,
    actions: [{ label: '取消' }, {
      label: '保存成果',
      kind: 'primary',
      onClick: async ({ bodyEl }) => {
        const content = $('#content', bodyEl).value.trim();
        if (!content) { toast('请填写成果内容', 'error'); return false; }
        const link = $('#link', bodyEl).value.trim();
        const finalTaskId = taskId === null && tasks ? ($('#tid', bodyEl).value || null) : (taskId || null);
        try {
          const r = await api.post('/api/achievements', {
            content: link ? `${content}\n${link}` : content,
            bizDate, taskId: finalTaskId,
          });
          if (pendingFiles.length) {
            await uploadFiles('achievement', r.achievement.id, pendingFiles);
          }
          toast('成果已记录', 'ok'); ctx.refresh();
        } catch (e) { toast(e.message, 'error'); return false; }
      },
    }],
  });
  let pendingFiles = [];
  const finfo = $('#finfo', document);
  const flist = $('#flist', document);
  $('#pick', document).onclick = async () => {
    const files = await filePicker(true);
    pendingFiles = pendingFiles.concat(files);
    finfo.textContent = `已选择 ${pendingFiles.length} 个文件（${fmtSize(pendingFiles.reduce((n, f) => n + f.size, 0))}）`;
    flist.innerHTML = pendingFiles.map((f) => `<div class="file-chip">📎 ${esc(f.name)} · ${fmtSize(f.size)}</div>`).join('');
  };
}

export function deferModal(ctx, p, day) {
  const t = p.task;
  modal({
    title: `延期「${t.title}」`,
    body: `<div class="field"><label>延期到</label><input class="input" type="date" id="d" value="${t.deferredUntil || day.today}" /></div>
      <p class="field-hint">延期后该任务会移出今日安排，直到目标日期当天才会重新出现在待承接范围；目标日期过后若仍未完成，下一次打开工作台时会继续承接。</p>`,
    actions: [{ label: '取消' }, {
      label: '确认延期',
      kind: 'primary',
      onClick: async ({ bodyEl }) => {
        const d = $('#d', bodyEl).value;
        if (!d) { toast('请选择日期', 'error'); return false; }
        try {
          await api.post(`/api/tasks/${t.id}/defer`, { date: d });
          toast(`已延期至 ${d}`, 'ok'); ctx.refresh();
        } catch (e) { toast(e.message, 'error'); return false; }
      },
    }],
  });
}

/* ---------------- 停止服务 ---------------- */

async function stopServiceFlow(root) {
  const ok = await confirmDialog({
    title: '停止服务',
    message: '将终止本机后台服务进程，之后本页面无法继续使用，需要重新启动服务才能再次打开。'
      + '<br><br>数据已实时写入本地数据库，停止服务不会丢失任何内容。',
    confirmText: '停止服务',
    danger: true,
  });
  if (!ok) return;

  const btn = $('#stop-server', root);
  if (btn) { btn.disabled = true; btn.textContent = '正在停止…'; }
  try {
    await api.shutdown();
  } catch {
    // 服务在响应送达前就退出时 fetch 会抛网络错误，属预期情况
  }
  showStoppedOverlay();
}

function showStoppedOverlay() {
  if ($('#stopped-mask')) return;
  const el = document.createElement('div');
  el.className = 'stopped-mask';
  el.id = 'stopped-mask';
  el.innerHTML = `
    <div class="stopped-box">
      <h3>服务已停止</h3>
      <p>本机后台服务进程已退出，现在可以安全关闭此页面。</p>
      <p class="small muted">下次使用：双击桌面「工作日程」图标重新启动。</p>
      <button class="btn primary" id="close-page">关闭页面</button>
    </div>`;
  document.body.appendChild(el);
  $('#close-page', el).onclick = () => {
    window.close();
    setTimeout(() => toast('浏览器不允许脚本关闭该标签页，请手动关闭', 'error'), 120);
  };
}

export { bindAutosave, saveIndicator, drawer, uploadFiles };
