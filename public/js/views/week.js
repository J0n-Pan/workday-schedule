import { api } from '../api.js';
import { $, $$, esc, toast, modal, mondayOf, addDays, weekdayOf, STATUS_TEXT, STATUS_CLASS, PRIORITY_TEXT } from '../ui.js';
import { openTaskDrawer } from './task.js';

export async function renderWeek(root, ctx) {
  const date = ctx.date;
  root.innerHTML = `<div class="loading"><span class="spinner"></span> 正在生成周回顾…</div>`;
  let r;
  try {
    r = await api.get(`/api/weeks/${date}`);
  } catch (e) {
    root.innerHTML = `<div class="empty"><h3>加载失败</h3><p>${esc(e.message)}</p><button class="btn primary" id="retry">重试</button></div>`;
    $('#retry', root).onclick = () => ctx.refresh();
    return;
  }

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>周回顾 ${r.start} ~ ${r.end}</h2>
        <span class="hint">统计口径：任务按任务 ID 去重；成果按发生日期统计，不重复计入历史成果；进度百分比不做平均</span>
        <div style="flex:1"></div>
        <button class="btn sm" id="prev">上一周</button>
        <button class="btn sm" id="cur">本周</button>
        <button class="btn sm" id="next">下一周</button>
        <button class="btn sm" id="copy">复制为文本</button>
        <button class="btn sm primary" id="md">导出 Markdown</button>
      </div>
      <div class="card-body">
        <div class="kpi">
          <div class="kpi-item"><b>${r.stats.doneCount}</b><span>本周完成任务</span></div>
          <div class="kpi-item"><b>${r.stats.achievementCount}</b><span>成果记录</span></div>
          <div class="kpi-item"><b>${r.stats.activeCount}</b><span>进行中任务</span></div>
          <div class="kpi-item"><b>${r.stats.overdueCount}</b><span>逾期任务</span></div>
          <div class="kpi-item"><b>${r.stats.blockerCount}</b><span>未解决阻碍</span></div>
          <div class="kpi-item"><b>${r.stats.adhocCount}</b><span>计划外工作</span></div>
        </div>
      </div>
    </div>

    <div class="grid-main" style="margin-top:14px">
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>本周完成任务</h2><span class="hint">按任务 ID 去重</span></div>
          <div class="card-body">${list(r.doneTasks.map((t) => `<span class="badge ${STATUS_CLASS[t.status]}">${STATUS_TEXT[t.status]}</span> <a href="#" data-t="${t.id}">${esc(t.title)}</a>${t.project ? ` <span class="muted small">· ${esc(t.project)}</span>` : ''}`))}</div>
        </section>

        <section class="card">
          <div class="card-head"><h2>每日成果</h2><span class="hint">按发生日期统计，共 ${r.stats.achievementCount} 条</span></div>
          <div class="card-body">
            <div class="week-grid">
              ${r.days.map((d) => `
                <div class="week-day ${d === r.today ? 'today' : ''}">
                  <h4>${d} ${weekdayOf(d)}${d === r.today ? ' · 今天' : ''}</h4>
                  ${(r.achievementsByDay[d] || []).length
                    ? (r.achievementsByDay[d]).map((a) => `<div class="ach">
                        <div class="ach-content">${esc(a.content)}</div>
                        <div class="ach-head">${a.taskId ? `任务：${esc(a.taskTitle || '')}` : '<span class="badge cyan">独立成果</span>'}</div>
                      </div>`).join('')
                    : '<div class="small muted">无</div>'}
                </div>`).join('')}
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>计划外工作</h2><span class="hint">临时新增事项与独立成果</span></div>
          <div class="card-body">${list([
            ...r.adhocTasks.map((t) => `<span class="badge amber">临时事项</span> <a href="#" data-t="${t.id}">${esc(t.title)}</a>`),
            ...r.standaloneAchievements.map((a) => `<span class="badge cyan">独立成果</span> <span>${a.bizDate}：${esc(a.content)}</span>`),
          ])}</div>
        </section>
      </div>

      <aside class="stack">
        <section class="card">
          <div class="card-head"><h2>进行中任务</h2><span class="hint">${r.stats.activeCount} 项</span></div>
          <div class="card-body">${list(r.activeTasks.map((t) => `<span class="badge ${STATUS_CLASS[t.status]}">${STATUS_TEXT[t.status]}</span> <a href="#" data-t="${t.id}">${esc(t.title)}</a> <span class="muted small">${t.progress}%</span>`))}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>逾期任务</h2></div>
          <div class="card-body">${list(r.overdue.map((t) => `<span class="badge red">${t.dueDate}</span> <a href="#" data-t="${t.id}">${esc(t.title)}</a>`))}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>主要阻碍</h2></div>
          <div class="card-body">${list(r.blockers.filter((b) => b.status === 'open').map((b) => `
            <div><a href="#" data-t="${b.taskId}">${esc(b.taskTitle || '')}</a> <span class="badge amber">未解决</span></div>
            <div class="small muted">${esc(b.reason || '未填写')}${b.needWho ? ` · 需 ${esc(b.needWho)} 协助` : ''}${b.followUpDate ? ` · 跟进 ${b.followUpDate}` : ''}</div>`))}
          </div>
        </section>
        ${r.deferredStreak.length ? `<section class="card">
          <div class="card-head"><h2>顺延提示</h2></div>
          <div class="card-body">${list(r.deferredStreak.map((t) => `<span class="badge amber">连续 ${t.deferStreak} 次无推进</span> <a href="#" data-t="${t.id}">${esc(t.title)}</a>`))}
          <p class="field-hint">顺延次数口径：自动承接时，若自上一个计划日以来既无进度变化、也无成果记录，则次数 +1；有推进则归零。达到阈值的任务建议拆分、调整安排或补充阻碍。</p></div>
        </section>` : ''}
      </aside>
    </div>`;

  $('#prev', root).onclick = () => ctx.go(`#/week/${addDays(r.start, -7)}`);
  $('#next', root).onclick = () => ctx.go(`#/week/${addDays(r.start, 7)}`);
  $('#cur', root).onclick = () => ctx.go(`#/week/${mondayOf(ctx.today)}`);

  $('#copy', root).onclick = async () => {
    const md = (await api.get(`/api/weeks/${r.start}/markdown`)).markdown;
    try {
      await navigator.clipboard.writeText(md);
      toast('周回顾已复制到剪贴板', 'ok');
    } catch {
      modal({ title: '周回顾文本', body: `<textarea class="input" style="min-height:300px">${esc(md)}</textarea>`, actions: [{ label: '关闭' }] });
    }
  };
  $('#md', root).onclick = async () => {
    const out = await api.get(`/api/weeks/${r.start}/markdown`);
    const blob = new Blob([out.markdown], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = out.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('已导出 Markdown', 'ok');
  };

  $$('[data-t]', root).forEach((el) => el.onclick = async (e) => {
    e.preventDefault();
    const id = el.dataset.t;
    try {
      const day = await api.get(`/api/days/${ctx.date}`);
      let found = day.plans.find((x) => x.task.id === id);
      if (!found) {
        const list = await api.get('/api/tasks');
        const t = list.tasks.find((x) => x.id === id);
        if (!t) { toast('未找到该任务', 'error'); return; }
        found = { task: t, plan: { id: null, bizDate: ctx.date, startProgress: t.progress, endProgress: t.progress, source: 'manual', isFocus: false, version: 1 } };
      }
      openTaskDrawer(ctx, found, ctx.date);
    } catch (err) { toast(err.message, 'error'); }
  });
}

function list(items) {
  if (!items.length) return `<div class="small muted">无</div>`;
  return `<ul class="list-plain">${items.map((i) => `<li><div style="min-width:0">${i}</div></li>`).join('')}</ul>`;
}
