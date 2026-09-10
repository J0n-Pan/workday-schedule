import { api } from '../api.js';
import { $, $$, esc, toast, modal, confirmDialog, fmtDateTime, filePicker, fmtSize } from '../ui.js';

export async function renderData(root, ctx) {
  root.innerHTML = `<div class="loading"><span class="spinner"></span> 正在读取存储信息…</div>`;
  let info;
  try {
    info = await api.get('/api/settings');
  } catch (e) {
    root.innerHTML = `<div class="empty"><h3>加载失败</h3><p>${esc(e.message)}</p><button class="btn primary" id="retry">重试</button></div>`;
    $('#retry', root).onclick = () => ctx.refresh();
    return;
  }
  const s = info.settings;

  root.innerHTML = `
    <div class="grid-main">
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>数据保存位置与持久化方式</h2></div>
          <div class="card-body stack">
            <div class="small">存储引擎：<b>${esc(info.storage.engine)}</b>（服务端数据库，不走 localStorage / 浏览器存储）</div>
            <div class="small">数据库文件：<code>${esc(info.storage.database)}</code></div>
            <div class="small">附件目录：<code>${esc(info.storage.attachments)}</code></div>
            <div class="small">自动备份目录：<code>${esc(info.storage.backups)}</code></div>
            <div class="small muted">写入方式：每次修改通过事务提交；状态与进度变更即时提交，文本编辑停止输入约 800ms 后防抖自动保存。刷新或重启后数据从数据库重新读取。数据仅保存在这台设备的上述目录中，不会跨设备同步。</div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>备份与恢复</h2><span class="hint">完整备份包含任务、每日计划、进度记录、成果、阻碍、设置与附件文件</span></div>
          <div class="card-body stack">
            <div class="row">
              <button class="btn primary" id="export">导出完整备份（ZIP）</button>
              <button class="btn" id="import">导入备份…</button>
              <span class="field-hint">导入前会校验格式与关联完整性并展示预览；导入失败不会破坏原有数据</span>
            </div>
            <div id="import-result"></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>回收站</h2><span class="hint">删除的任务与成果保留在此，可恢复</span></div>
          <div class="card-body" id="trash"><div class="loading">加载中…</div></div>
        </section>

        <section class="card">
          <div class="card-head"><h2>示例数据与清空</h2></div>
          <div class="card-body row">
            <button class="btn" id="demo">加载示例数据</button>
            <button class="btn danger" id="clear">清空全部数据</button>
            <span class="field-hint">应用默认为真实空数据；示例数据只能通过这里显式加载</span>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>最近操作记录</h2><span class="hint">重要修改、删除、修正与恢复</span></div>
          <div class="card-body" id="audit"><div class="loading">加载中…</div></div>
        </section>
      </div>

      <aside class="stack">
        <section class="card">
          <div class="card-head"><h2>偏好设置</h2></div>
          <div class="card-body stack">
            <div class="field"><label>时区（业务日期按此时区计算）</label>
              <input class="input" id="tz" list="tzs" value="${esc(s.timezone)}" />
              <datalist id="tzs">
                <option value="Asia/Shanghai"></option><option value="Asia/Tokyo"></option>
                <option value="Asia/Singapore"></option><option value="Europe/London"></option>
                <option value="America/New_York"></option><option value="America/Los_Angeles"></option>
                <option value="UTC"></option>
              </datalist>
              <span class="field-hint">系统时区：${esc(info.systemTimezone)}。修改时区不会重新分配已有每日记录的业务日期。</span>
            </div>
            <div class="field"><label>界面主题</label>
              <select class="input" id="theme">
                <option value="light" ${s.theme === 'light' ? 'selected' : ''}>浅色（默认）</option>
                <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>深色</option>
              </select>
            </div>
            <div class="field"><label>每日重点任务上限</label>
              <input class="input" type="number" id="focusLimit" min="1" max="10" value="${s.focusLimit}" />
            </div>
            <div class="field"><label>顺延提醒阈值（次）</label>
              <input class="input" type="number" id="threshold" min="1" max="30" value="${s.deferStreakThreshold}" />
            </div>
            <div class="field"><label>浏览器通知</label>
              <div class="row">
                <button class="btn sm" id="notify">${s.browserNotify === 'on' ? '关闭浏览器通知' : '开启浏览器通知'}</button>
                <span class="field-hint" id="notify-state">${'Notification' in window ? `当前授权：${Notification.permission}` : '当前浏览器不支持通知'}</span>
              </div>
              <span class="field-hint">能力边界：应用内提醒始终有效；浏览器通知需要你授权，且仅在浏览器打开本应用的标签页时才能弹出。关闭浏览器、关闭标签页或设备关机时不会发出任何提醒——本应用没有后台推送服务。</span>
            </div>
            <button class="btn primary" id="save-settings">保存设置</button>
          </div>
        </section>
      </aside>
    </div>`;

  $('#export', root).onclick = () => { window.location.href = '/api/backup/export'; toast('开始导出备份', 'ok'); };

  $('#import', root).onclick = async () => {
    const files = await filePicker(false);
    if (!files.length) return;
    const form = new FormData();
    form.append('file', files[0]);
    let preview;
    try {
      preview = await api.upload('/api/backup/preview', form);
    } catch (e) {
      toast(`备份校验失败：${e.message}`, 'error');
      $('#import-result', root).innerHTML = `<div class="notice danger">导入已中止，现有数据未被修改。原因：${esc(e.message)}</div>`;
      return;
    }
    const sum = preview.summary;
    modal({
      title: '备份导入预览',
      body: `<div class="small stack">
          <div>导出时间：${esc(sum.exportedAt)} · 结构版本：${sum.schemaVersion}</div>
          <div>任务 ${sum.tasks} · 每日计划 ${sum.dailyPlans} · 进度记录 ${sum.progressLogs} · 成果 ${sum.achievements} · 阻碍 ${sum.blockers} · 附件 ${sum.attachments}（含文件 ${sum.attachmentFiles}）</div>
          ${sum.missingAttachmentFiles.length ? `<div class="notice warn">有 ${sum.missingAttachmentFiles.length} 个附件文件不在备份包中：${esc(sum.missingAttachmentFiles.join('、'))}</div>` : ''}
          ${preview.warnings.length ? `<div class="notice warn">${preview.warnings.map(esc).join('<br>')}</div>` : ''}
          <div class="field"><label>导入方式</label>
            <div class="row">
              <label class="row small"><input type="radio" name="mode" value="merge" checked /> 合并导入（按 ID 去重，报告冲突）</label>
              <label class="row small"><input type="radio" name="mode" value="overwrite" /> 覆盖恢复（清空当前数据后恢复）</label>
            </div>
          </div>
          <div class="notice info">合并导入不会删除现有数据；覆盖恢复会先用当前数据生成一份自动备份（保存在备份目录），再执行恢复。</div>
        </div>`,
      actions: [{ label: '取消' }, {
        label: '开始导入', kind: 'primary', onClick: async ({ bodyEl }) => {
          const mode = $('input[name=mode]:checked', bodyEl).value;
          if (mode === 'overwrite') {
            const ok = await confirmDialog({
              title: '确认覆盖恢复？', danger: true, confirmText: '覆盖恢复',
              message: '当前数据库中的所有数据将被备份文件替换。执行前会自动生成一份当前数据的备份。',
            });
            if (!ok) return false;
          }
          const f2 = new FormData();
          f2.append('file', files[0]);
          f2.append('mode', mode);
          f2.append('confirm', 'true');
          try {
            const r = await api.upload('/api/backup/import', f2);
            const ins = r.report.inserted;
            $('#import-result', root).innerHTML = `<div class="notice info">导入完成（${mode === 'overwrite' ? '覆盖恢复' : '合并导入'}）：
              任务 ${ins.tasks} · 计划 ${ins.dailyPlans} · 成果 ${ins.achievements} · 阻碍 ${ins.blockers} · 附件 ${ins.attachments}
              ${r.report.conflicts.length ? ` · 冲突 ${r.report.conflicts.length} 条（已按更新时间保留较新的一份）` : ''}
              ${r.report.preRestoreBackup ? ` · 覆盖前备份：${esc(r.report.preRestoreBackup)}` : ''}</div>`;
            toast('导入完成', 'ok');
            ctx.refresh();
          } catch (e) {
            $('#import-result', root).innerHTML = `<div class="notice danger">导入失败：${esc(e.message)}（原有数据保持完好）</div>`;
            toast('导入失败', 'error');
          }
        },
      }],
    });
  };

  $('#demo', root).onclick = async () => {
    const ok = await confirmDialog({ title: '加载示例数据', message: '会创建若干示例任务、进度与成果（含昨日记录），用于演示跨天继承。可随时在下方清空。', confirmText: '加载' });
    if (!ok) return;
    try { await api.post('/api/demo/load', {}); toast('示例数据已加载', 'ok'); ctx.refresh(); } catch (e) { toast(e.message, 'error'); }
  };
  $('#clear', root).onclick = async () => {
    const ok = await confirmDialog({
      title: '清空全部数据', danger: true, confirmText: '我确认清空',
      message: '将删除所有任务、每日计划、成果、阻碍与附件，并清空任务表。此操作不可撤销，建议先导出备份。',
    });
    if (!ok) return;
    const ok2 = await confirmDialog({ title: '再次确认', danger: true, confirmText: '确认清空', message: '最后一次确认：真的要清空全部数据吗？' });
    if (!ok2) return;
    try { await api.post('/api/demo/clear', { confirm: true }); toast('已清空', 'ok'); ctx.refresh(); } catch (e) { toast(e.message, 'error'); }
  };

  $('#save-settings', root).onclick = async () => {
    try {
      await api.put('/api/settings', {
        timezone: $('#tz', root).value,
        theme: $('#theme', root).value,
        focusLimit: Number($('#focusLimit', root).value),
        deferStreakThreshold: Number($('#threshold', root).value),
      });
      toast('设置已保存', 'ok');
      await ctx.reload();
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#notify', root).onclick = async () => {
    if (s.browserNotify === 'on') {
      await api.put('/api/settings', { browserNotify: 'off' });
      toast('已关闭浏览器通知（应用内提醒仍然有效）', 'ok');
      return ctx.refresh();
    }
    if (!('Notification' in window)) { toast('当前浏览器不支持通知', 'error'); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('未获得通知授权，浏览器通知不会开启', 'error');
      $('#notify-state', root).textContent = `授权被拒绝：${perm}`;
      return;
    }
    await api.put('/api/settings', { browserNotify: 'on' });
    new Notification('工作日', { body: '浏览器通知已开启（仅在本应用页面打开时有效）' });
    toast('已开启浏览器通知', 'ok');
    ctx.refresh();
  };

  // 回收站
  try {
    const trash = await api.get('/api/trash');
    $('#trash', root).innerHTML = `
      <div class="small muted">已删除任务 ${trash.tasks.length} 项 · 已删除成果 ${trash.achievements.length} 条</div>
      ${trash.tasks.length ? `<ul class="list-plain">${trash.tasks.map((t) => `<li>
        <span>${esc(t.title)}</span><span class="small muted">删除于 ${fmtDateTime(t.deletedAt, s.timezone)}</span>
        <div style="flex:1"></div>
        <button class="btn sm" data-restore="${t.id}">恢复</button>
        <button class="btn sm danger" data-purge="${t.id}">永久删除</button>
      </li>`).join('')}</ul>` : '<div class="small muted">回收站为空。</div>'}
      <div class="row" style="margin-top:10px"><button class="btn sm danger" id="purge-all">清空回收站</button></div>`;

    $$('[data-restore]', $('#trash', root)).forEach((b) => b.onclick = async () => {
      try { await api.post(`/api/tasks/${b.dataset.restore}/restore`, {}); toast('已恢复', 'ok'); ctx.refresh(); } catch (e) { toast(e.message, 'error'); }
    });
    $$('[data-purge]', $('#trash', root)).forEach((b) => b.onclick = async () => {
      const ok = await confirmDialog({ title: '永久删除', danger: true, confirmText: '永久删除', message: '该任务及其计划、进度记录、阻碍将被彻底删除，无法恢复。' });
      if (!ok) return;
      try { await api.del(`/api/tasks/${b.dataset.purge}/purge`, { confirm: true }); toast('已永久删除', 'ok'); ctx.refresh(); } catch (e) { toast(e.message, 'error'); }
    });
    $('#purge-all', root).onclick = async () => {
      const ok = await confirmDialog({ title: '清空回收站', danger: true, confirmText: '清空', message: '回收站中的任务将被永久删除。' });
      if (!ok) return;
      try { await api.del('/api/trash', { confirm: true }); toast('回收站已清空', 'ok'); ctx.refresh(); } catch (e) { toast(e.message, 'error'); }
    };
  } catch (e) {
    $('#trash', root).innerHTML = `<div class="small muted">加载失败：${esc(e.message)}</div>`;
  }

  // 审计
  try {
    const { logs } = await api.get('/api/audit?limit=60');
    $('#audit', root).innerHTML = logs.length
      ? logs.map((l) => `<div class="history-line">${fmtDateTime(l.created_at, s.timezone)} ·
          <b>${esc(actionText(l.action))}</b> · ${esc(l.entity_type)} ${esc(String(l.entity_id).slice(0, 12))}</div>`).join('')
      : '<div class="small muted">暂无记录</div>';
  } catch (e) {
    $('#audit', root).innerHTML = `<div class="small muted">加载失败：${esc(e.message)}</div>`;
  }
}

function actionText(a) {
  return {
    create: '创建', update: '更新', delete: '删除', restore: '恢复', purge: '永久删除',
    progress: '进度/状态变更', carry: '跨天承接', remove_from_day: '移出当日计划',
    correct_snapshot: '历史快照修正', sync_snapshot_from_task: '快照同步',
    resolve: '阻碍解决', import_merge: '合并导入', restore_overwrite: '覆盖恢复',
    clear_all: '清空数据', load_demo: '加载示例数据',
  }[a] || a;
}
