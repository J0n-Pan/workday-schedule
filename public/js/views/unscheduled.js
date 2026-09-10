import { api } from '../api.js';
import { $, $$, esc, toast, modal, STATUS_TEXT, STATUS_CLASS, PRIORITY_TEXT, PRIORITY_CLASS } from '../ui.js';
import { openTaskDrawer, newTaskModal } from './task.js';

export async function renderUnscheduled(root, ctx) {
  root.innerHTML = `<div class="loading"><span class="spinner"></span> 正在加载待安排任务…</div>`;
  let data;
  try {
    data = await api.get('/api/tasks?scope=unscheduled');
  } catch (e) {
    root.innerHTML = `<div class="empty"><h3>加载失败</h3><p>${esc(e.message)}</p><button class="btn primary" id="retry">重试</button></div>`;
    $('#retry', root).onclick = () => ctx.refresh();
    return;
  }
  const list = data.tasks;

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>待安排任务</h2>
        <span class="hint">已在某天出现但当前没有安排的任务；不会被引擎自动塞回，需显式安排</span>
        <div style="flex:1"></div>
        <button class="btn sm primary" id="new">+ 新增任务</button>
      </div>
      ${list.length ? `<div class="task-list">${list.map(row).join('')}</div>` : `<div class="empty">
        <h3>没有待安排的任务</h3>
        <p>把任务"移出今日"或"延期"后，会出现在这里，等待你重新安排。</p>
        <button class="btn primary" id="empty-new">新增任务</button></div>`}
    </div>
    <p class="field-hint" style="margin-top:10px">说明：移出今日的任务不会被当天刷新或次日继承重新加入；延期任务在目标日期之前不会继承，到期或错过目标日期后下一次打开工作台时可承接。</p>`;

  $('#new', root).onclick = () => newTaskModal(ctx, ctx.today);
  const en = $('#empty-new', root); if (en) en.onclick = () => newTaskModal(ctx, ctx.today);

  $$('[data-id]', root).forEach((el) => {
    const t = list.find((x) => x.id === el.dataset.id);
    el.onclick = async (e) => {
      const act = e.target.dataset.act;
      try {
        if (act === 'today') {
          await api.post(`/api/days/${ctx.today}/plans`, { taskId: t.id, source: 'manual' });
          toast('已加入今天', 'ok'); ctx.refresh();
        } else if (act === 'other') {
          modal({
            title: `安排「${t.title}」到指定日期`,
            body: `<div class="field"><label>目标日期</label><input class="input" type="date" id="d" value="${ctx.today}" /></div>
              <p class="field-hint">安排到未来日期属于"提前安排"，该日期不会重复自动承接同一任务。</p>`,
            actions: [{ label: '取消' }, {
              label: '安排', kind: 'primary', onClick: async ({ bodyEl }) => {
                const d = $('#d', bodyEl).value;
                if (!d) { toast('请选择日期', 'error'); return false; }
                try { await api.post(`/api/days/${d}/plans`, { taskId: t.id, source: 'manual' }); toast(`已安排到 ${d}`, 'ok'); ctx.refresh(); }
                catch (err) { toast(err.message, 'error'); }
              },
            }],
          });
        } else if (act === 'open') {
          openTaskDrawer(ctx, {
            task: t,
            plan: { id: null, bizDate: ctx.today, startProgress: t.progress, endProgress: t.progress, isFocus: false, source: 'manual', version: 1 },
          }, ctx.today);
        }
      } catch (err) { toast(err.message, 'error'); }
    };
  });
}

function row(t) {
  const reason = t.deferredUntil
    ? `已延期至 ${t.deferredUntil}`
    : (t.unscheduled ? '已移出当日计划' : '暂未安排');
  return `<div class="task" data-id="${t.id}">
    <span class="dotmark ${t.priority}" style="margin-top:6px"></span>
    <div class="task-main">
      <div class="task-title" data-act="open">${esc(t.title)}</div>
      <div class="task-meta">
        <span class="badge ${PRIORITY_CLASS[t.priority]}">${PRIORITY_TEXT[t.priority]}优先</span>
        <span class="badge ${STATUS_CLASS[t.status]}">${STATUS_TEXT[t.status]}</span>
        <span class="badge gray">${reason}</span>
        ${t.project ? `<span class="badge gray">${esc(t.project)}</span>` : ''}
        ${t.dueDate ? `<span class="badge ${t.dueDate < window.__today ? 'red' : 'gray'}">截止 ${t.dueDate}</span>` : ''}
      </div>
      <div class="task-next">当前进度 ${t.progress}%${t.nextAction ? ` · 下一步：${esc(t.nextAction)}` : ''}</div>
    </div>
    <div class="task-actions">
      <button class="btn sm" data-act="today">安排到今天</button>
      <button class="btn sm" data-act="other">安排到…</button>
      <button class="btn sm ghost" data-act="open">详情</button>
    </div>
  </div>`;
}
