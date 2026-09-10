import { api } from '../api.js';
import {
  $, $$, esc, toast, modal, drawer, bindAutosave, saveIndicator, uploadFiles, filePicker,
  STATUS_TEXT, STATUS_CLASS, PRIORITY_TEXT, PRIORITY_CLASS, fmtTime, fmtDateTime, fmtSize,
} from '../ui.js';
import { toggleDone, progressModal, achievementModal, deferModal, achCard } from './day.js';

export function newTaskModal(ctx, date, opts = {}) {
  modal({
    title: opts.adhoc ? '临时新增事项' : '新增任务',
    body: `
      <div class="field"><label>标题</label><input class="input" id="title" placeholder="例如：完善项目方案" autofocus /></div>
      <div class="field"><label>描述（可选）</label><textarea class="input" id="desc" style="min-height:70px"></textarea></div>
      <div class="field-row">
        <div class="field"><label>所属项目 / 分类</label><input class="input" id="project" placeholder="例如：季度规划" /></div>
        <div class="field"><label>优先级</label><select class="input" id="priority">
          <option value="high">高</option><option value="medium" selected>中</option><option value="low">低</option></select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>截止日期（可选）</label><input class="input" type="date" id="due" /></div>
        <div class="field"><label>加入日期</label><input class="input" type="date" id="biz" value="${date}" /></div>
      </div>
      <div class="field"><label>下一步动作</label><input class="input" id="next" placeholder="下次继续时首先要做什么" /></div>
      <div class="row">
        <label class="row small"><input type="checkbox" id="focus" /> 设为当日重点</label>
        ${opts.adhoc ? '<span class="badge amber">临时新增事项</span>' : ''}
      </div>
      <p class="field-hint">${opts.adhoc ? '临时事项同样可以记录成果并计入周回顾统计。' : '任务会加入所选日期的计划；当天未完成的工作会在之后的日子自动承接。'}</p>`,
    actions: [{ label: '取消' }, {
      label: '创建',
      kind: 'primary',
      onClick: async ({ bodyEl }) => {
        const title = $('#title', bodyEl).value.trim();
        if (!title) { toast('请填写标题', 'error'); return false; }
        try {
          const r = await api.post('/api/tasks', {
            title,
            description: $('#desc', bodyEl).value,
            project: $('#project', bodyEl).value,
            priority: $('#priority', bodyEl).value,
            dueDate: $('#due', bodyEl).value || null,
            nextAction: $('#next', bodyEl).value,
            bizDate: $('#biz', bodyEl).value || date,
            isFocus: $('#focus', bodyEl).checked,
            isAdhoc: !!opts.adhoc,
          });
          if ($('#focus', bodyEl).checked) {
            const plan = (await api.get(`/api/days/${$('#biz', bodyEl).value || date}`)).plans.find((x) => x.task.id === r.task.id);
            if (plan) await api.patch(`/api/plans/${plan.plan.id}`, { isFocus: true, version: plan.plan.version });
          }
          toast('已创建', 'ok');
          ctx.refresh();
        } catch (e) { toast(e.message, 'error'); return false; }
      },
    }],
  });
}

export function openTaskDrawer(ctx, p, bizDate) {
  let task = { ...p.task };
  let plan = { ...p.plan };
  const tz = window.__tz;

  const d = drawer({ title: task.title, body: '', onClose: () => ctx.refresh() });
  const body = d.bodyEl;

  function render() {
    body.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <div class="row">
          <span class="badge ${STATUS_CLASS[task.status]}">${STATUS_TEXT[task.status]}</span>
          <span class="badge ${PRIORITY_CLASS[task.priority]}">${PRIORITY_TEXT[task.priority]}优先</span>
          ${plan.source === 'carry' ? `<span class="badge cyan">承接自 ${plan.carriedFrom || '历史'}</span>` : ''}
          ${task.isAdhoc ? '<span class="badge amber">临时新增</span>' : ''}
        </div>
        <span class="save-state" data-state></span>
      </div>
      <div class="divider"></div>

      <div class="field"><label>标题</label><input class="input" id="f-title" value="${esc(task.title)}" /></div>
      <div class="field"><label>描述</label><textarea class="input" id="f-desc">${esc(task.description)}</textarea></div>
      <div class="field-row">
        <div class="field"><label>项目 / 分类</label><input class="input" id="f-project" value="${esc(task.project)}" /></div>
        <div class="field"><label>优先级</label><select class="input" id="f-priority">
          ${Object.entries(PRIORITY_TEXT).map(([k, v]) => `<option value="${k}" ${k === task.priority ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>状态</label><select class="input" id="f-status">
          ${Object.entries(STATUS_TEXT).map(([k, v]) => `<option value="${k}" ${k === task.status ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field"><label>截止日期</label><input class="input" type="date" id="f-due" value="${task.dueDate || ''}" /></div>
      </div>
      <div class="field"><label>累计进度：<b id="pgv">${task.progress}</b>%</label>
        <input type="range" id="f-pg" min="0" max="100" step="5" value="${task.progress}" style="width:100%" />
      </div>
      <div class="field"><label>下一步动作</label><input class="input" id="f-next" value="${esc(task.nextAction)}" placeholder="下次继续这项任务时首先要做什么" /></div>

      <div class="divider"></div>
      <h4 style="margin:0 0 6px;font-size:13px">${bizDate} 的每日安排</h4>
      <div class="small muted">开始 ${plan.startProgress}% → 日末 ${plan.endProgress}%（任务当前 ${task.progress}%）
        ${plan.endProgress !== task.progress ? ' · <span style="color:var(--amber)">当日快照与当前进度不同</span>' : ''}</div>
      <div class="row" style="margin:8px 0">
        <button class="btn sm" id="b-progress">更新进度</button>
        <button class="btn sm" id="b-ach">记成果</button>
        <button class="btn sm" id="b-defer">延期</button>
        <button class="btn sm" id="b-remove">移出今日</button>
      </div>
      <div class="row">
        <button class="btn sm ghost" id="b-fix">修正当日快照</button>
        <button class="btn sm ghost" id="b-sync">把当前进度写入当日快照</button>
      </div>
      <p class="field-hint">修正历史快照只影响该日期的记录，不会自动改写任务当前进度或后续日期。</p>

      <div class="divider"></div>
      <div class="between"><h4 style="margin:0;font-size:13px">阻碍与协作</h4><button class="btn sm" id="b-blocker">+ 记录阻碍</button></div>
      <div id="blockers" class="small"></div>

      <div class="divider"></div>
      <div class="between"><h4 style="margin:0;font-size:13px">成果（${bizDate}）</h4><button class="btn sm" id="b-addach">+ 记成果</button></div>
      <div id="achs" class="small"></div>

      <div class="divider"></div>
      <div class="between"><h4 style="margin:0;font-size:13px">附件与链接</h4><button class="btn sm" id="b-file">+ 上传附件</button></div>
      <div id="files" class="ach-files"></div>

      <div class="divider"></div>
      <h4 style="margin:0 0 6px;font-size:13px">变更与修正历史</h4>
      <div id="logs" class="small"></div>

      <div class="divider"></div>
      <div class="row">
        <button class="btn danger sm" id="b-delete">删除任务</button>
        <span class="field-hint">删除后进入回收站，可在数据管理中恢复</span>
      </div>`;
    bind();
  }

  function bind() {
    const stateEl = $('[data-state]', body);
    const indicate = saveIndicator(stateEl);

    const textSave = (field, el) => bindAutosave(el, async (v) => {
      const r = await api.patch(`/api/tasks/${task.id}`, { [field]: v, version: task.version, bizDate });
      task = r.task; plan = plan;
    }, { onState: indicate });

    textSave('title', $('#f-title', body));
    textSave('description', $('#f-desc', body));
    textSave('project', $('#f-project', body));
    textSave('nextAction', $('#f-next', body));

    $('#f-priority', body).onchange = async (e) => {
      try { const r = await api.patch(`/api/tasks/${task.id}`, { priority: e.target.value, version: task.version, bizDate }); task = r.task; indicate('saved'); }
      catch (err) { toast(err.message, 'error'); }
    };
    $('#f-due', body).onchange = async (e) => {
      try { const r = await api.patch(`/api/tasks/${task.id}`, { dueDate: e.target.value || null, version: task.version, bizDate }); task = r.task; indicate('saved'); }
      catch (err) { toast(err.message, 'error'); }
    };
    $('#f-status', body).onchange = async (e) => {
      const st = e.target.value;
      if (task.status === 'done' && st !== 'done') {
        e.target.value = task.status;
        return reopenFlow();
      }
      try {
        const r = await api.patch(`/api/tasks/${task.id}`, { status: st, bizDate, version: task.version });
        task = r.task; indicate('saved'); render();
      } catch (err) { toast(err.message, 'error'); render(); }
    };
    let pgTimer = null;
    $('#f-pg', body).addEventListener('input', (e) => {
      $('#pgv', body).textContent = e.target.value;
      if (pgTimer) clearTimeout(pgTimer);
      pgTimer = setTimeout(async () => {
        try {
          const r = await api.post(`/api/tasks/${task.id}/progress`, {
            progress: Number(e.target.value), bizDate, version: task.version,
          });
          task = r.task; plan = r.plan || plan; indicate('saved');
        } catch (err) { toast(err.message, 'error'); }
      }, 800);
    });

    function reopenFlow() {
      modal({
        title: '重新打开已完成任务',
        body: `<p style="margin:0 0 10px">已完成任务重新打开时，需要选择未完成状态并设置小于 100% 的进度。</p>
          <div class="field"><label>状态</label><select class="input" id="st">
            <option value="in_progress">进行中</option><option value="not_started">未开始</option><option value="waiting">等待他人</option></select></div>
          <div class="field"><label>进度（0~99）</label><input class="input" type="number" id="pg" min="0" max="99" value="${Math.min(90, task.progress)}" /></div>`,
        actions: [{ label: '取消' }, {
          label: '确认', kind: 'primary', onClick: async ({ bodyEl }) => {
            const pg = Number($('#pg', bodyEl).value);
            if (!(pg >= 0 && pg < 100)) { toast('进度必须是 0~99 的整数', 'error'); return false; }
            try {
              const r = await api.post(`/api/tasks/${task.id}/progress`, {
                progress: pg, status: $('#st', bodyEl).value, bizDate, version: task.version,
              });
              task = r.task; render(); toast('已重新打开', 'ok');
            } catch (err) { toast(err.message, 'error'); return false; }
          },
        }],
      });
    }

    $('#b-progress', body).onclick = () => progressModal(ctx, { task, plan }, { date: bizDate, today: ctx.today });
    $('#b-ach', body).onclick = () => achievementModal(ctx, { bizDate, taskId: task.id });
    $('#b-addach', body).onclick = () => achievementModal(ctx, { bizDate, taskId: task.id });
    $('#b-defer', body).onclick = () => deferModal(ctx, { task, plan }, { date: bizDate, today: ctx.today });
    $('#b-remove', body).onclick = async () => {
      const r = await import('../ui.js').then((m) => m.confirmDialog({
        title: '移出今日计划', danger: true, confirmText: '移出今日',
        message: `将「${esc(task.title)}」从 ${bizDate} 的计划中移除。任务会进入「待安排任务」，不会被当天刷新或次日继承重新塞回。`,
      }));
      if (!r) return;
      try {
        await api.patch(`/api/plans/${plan.id}`, { state: 'removed', version: plan.version });
        toast('已移出今日计划', 'ok'); d.close(); ctx.refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
    $('#b-fix', body).onclick = () => snapshotModal();
    $('#b-sync', body).onclick = async () => {
      try {
        await api.post(`/api/plans/${plan.id}/sync-snapshot`);
        const r = await api.get(`/api/days/${bizDate}`);
        const np = r.plans.find((x) => x.plan.id === plan.id);
        if (np) { plan = np.plan; task = np.task; }
        render(); toast('已同步', 'ok');
      } catch (e) { toast(e.message, 'error'); }
    };
    $('#b-blocker', body).onclick = () => blockerModal();
    $('#b-file', body).onclick = async () => {
      const files = await filePicker(true);
      if (!files.length) return;
      await uploadFiles('task', task.id, files);
      await loadExtras(); render();
    };
    $('#b-delete', body).onclick = async () => {
      const r = await import('../ui.js').then((m) => m.confirmDialog({
        title: '删除任务', danger: true, confirmText: '删除',
        message: `「${esc(task.title)}」将进入回收站，历史计划、成果与变更记录会保留，可随时恢复。`,
      }));
      if (!r) return;
      try { await api.del(`/api/tasks/${task.id}`); toast('已移入回收站', 'ok'); d.close(); ctx.refresh(); }
      catch (e) { toast(e.message, 'error'); }
    };
  }

  function snapshotModal() {
    modal({
      title: `修正 ${bizDate} 的进度快照`,
      body: `<div class="field-row">
          <div class="field"><label>当日开始进度</label><input class="input" type="number" id="sp" min="0" max="100" value="${plan.startProgress}" /></div>
          <div class="field"><label>当日月末进度</label><input class="input" type="number" id="ep" min="0" max="100" value="${plan.endProgress}" /></div>
        </div>
        <div class="field"><label>修正原因</label><input class="input" id="note" placeholder="例如：当天实际已完成到 70%" /></div>
        <p class="field-hint">仅在当日记录上留痕（含修改时间），不会自动改写任务当前进度（${task.progress}%）或其他日期。</p>`,
      actions: [{ label: '取消' }, {
        label: '保存修正', kind: 'primary', onClick: async ({ bodyEl }) => {
          try {
            const r = await api.post(`/api/plans/${plan.id}/snapshot`, {
              startProgress: Number($('#sp', bodyEl).value),
              endProgress: Number($('#ep', bodyEl).value),
              note: $('#note', bodyEl).value,
            });
            plan = r.plan; render(); toast('已修正', 'ok');
          } catch (e) { toast(e.message, 'error'); return false; }
        },
      }],
    });
  }

  function blockerModal() {
    modal({
      title: '记录阻碍与待协作',
      body: `<div class="field"><label>阻碍原因</label><textarea class="input" id="reason" placeholder="例如：法务尚未反馈合同模板"></textarea></div>
        <div class="field-row">
          <div class="field"><label>需要谁协助</label><input class="input" id="who" placeholder="例如：法务-李工" /></div>
          <div class="field"><label>下次跟进日期</label><input class="input" type="date" id="fu" /></div>
        </div>
        <div class="field"><label>待提供事项</label><input class="input" id="what" placeholder="例如：最新版合同模板" /></div>
        <p class="field-hint">记录后任务状态会变为「等待他人」。系统不会自动发送消息给协作人。</p>`,
      actions: [{ label: '取消' }, {
        label: '保存', kind: 'primary', onClick: async ({ bodyEl }) => {
          try {
            await api.post('/api/blockers', {
              taskId: task.id,
              reason: $('#reason', bodyEl).value,
              needWho: $('#who', bodyEl).value,
              needWhat: $('#what', bodyEl).value,
              followUpDate: $('#fu', bodyEl).value || null,
            });
            await loadExtras(); render(); toast('已记录', 'ok');
          } catch (e) { toast(e.message, 'error'); return false; }
        },
      }],
    });
  }

  async function loadExtras() {
    try {
      const [day, logs] = await Promise.all([
        api.get(`/api/days/${bizDate}`),
        api.get(`/api/tasks/${task.id}/logs`),
      ]);
      const cur = day.plans.find((x) => x.task.id === task.id);
      if (cur) { task = cur.task; plan = cur.plan; }
      const achs = cur ? cur.achievements : [];
      $('#achs', body).innerHTML = achs.length
        ? achs.map((a) => achCard({ ...a, taskTitle: task.title })).join('')
        : `<div class="muted" style="padding:6px 0">当日暂无成果记录。</div>`;
      $$('[data-del-ach]', $('#achs', body)).forEach((b) => b.onclick = async () => {
        try { await api.del(`/api/achievements/${b.dataset.delAch}`); await loadExtras(); toast('已删除', 'ok'); }
        catch (e) { toast(e.message, 'error'); }
      });

      const blockers = cur ? cur.blockers : [];
      $('#blockers', body).innerHTML = blockers.length ? blockers.map((b) => `
        <div style="border-bottom:1px dashed var(--border);padding:6px 0">
          <div class="row"><span class="badge ${b.status === 'open' ? 'amber' : 'green'}">${b.status === 'open' ? '未解决' : '已解决'}</span>
            ${b.followUpDate ? `<span class="badge gray">跟进 ${b.followUpDate}</span>` : ''}
            <div style="flex:1"></div>
            ${b.status === 'open' ? `<button class="btn sm ghost" data-resolve="${b.id}">标记解决</button>` : ''}
          </div>
          <div>${esc(b.reason || '未填写原因')}</div>
          ${b.needWho ? `<div class="muted">需 ${esc(b.needWho)} 协助${b.needWhat ? `：${esc(b.needWhat)}` : ''}</div>` : ''}
        </div>`).join('') : `<div class="muted" style="padding:6px 0">暂无阻碍记录。</div>`;
      $$('[data-resolve]', $('#blockers', body)).forEach((b) => b.onclick = async () => {
        try { await api.patch(`/api/blockers/${b.dataset.resolve}`, { status: 'resolved' }); await loadExtras(); toast('已标记解决', 'ok'); }
        catch (e) { toast(e.message, 'error'); }
      });

      const files = cur ? cur.attachments : [];
      $('#files', body).innerHTML = files.length ? files.map((f) => `
        <span class="file-chip"><a href="${f.url}" target="_blank" rel="noreferrer">📎 ${esc(f.name)}</a>
        <span class="muted">${fmtSize(f.size)}</span>
        <button class="btn sm ghost" data-delfile="${f.id}" aria-label="删除附件">✕</button></span>`).join('') : `<div class="muted">暂无附件。</div>`;
      $$('[data-delfile]', $('#files', body)).forEach((b) => b.onclick = async () => {
        try { await api.del(`/api/attachments/${b.dataset.delfile}`); await loadExtras(); toast('已删除附件', 'ok'); }
        catch (e) { toast(e.message, 'error'); }
      });

      $('#logs', body).innerHTML = [
        ...logs.progressLogs.map((l) => `<div class="history-line">${l.bizDate} ${fmtTime(l.createdAt, tz)} ·
          进度 ${l.from_progress}% → ${l.to_progress}%｜${STATUS_TEXT[l.from_status]} → ${STATUS_TEXT[l.to_status]}
          ${l.note ? `｜${esc(l.note)}` : ''}</div>`),
        ...logs.corrections.map((c) => `<div class="history-line" style="color:var(--amber)">修正记录 · ${fmtDateTime(c.createdAt, tz)}｜${esc(c.detail)}</div>`),
      ].join('') || `<div class="muted">暂无变更记录。</div>`;
    } catch (e) {
      toast(`加载详情失败：${e.message}`, 'error');
    }
  }

  render();
  loadExtras();
  return d;
}
