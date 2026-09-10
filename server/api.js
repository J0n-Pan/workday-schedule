import fs from 'node:fs';
import path from 'node:path';
import {
  readBody, parseJsonBody, parseMultipart, sendJson, sendBinary, badRequest, notFound,
  isDateStr, todayInTz, safeFileName, id, nowISO, systemTimezone, ApiError,
} from './util.js';
import { setSetting, getSettings } from './db.js';
import * as S from './store.js';
import {
  buildBackupZip, parseBackup, applyImport, clearAllData,
} from './backup.js';
import { loadDemoData } from './demo.js';

const MAX_UPLOAD = 25 * 1024 * 1024;

export async function handleApi(req, res, ctx, url) {
  const { db } = ctx;
  const method = req.method;
  const p = url.pathname;
  const cfg = S.settings(db);
  const today = todayInTz(cfg.timezone);
  const callCtx = { today, timezone: cfg.timezone };

  const body = async () => parseJsonBody(await readBody(req));

  try {
    /* ---------------- 基础 ---------------- */
    if (p === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, now: nowISO(), today, timezone: cfg.timezone });
    }

    /* ---------------- 停止服务 ---------------- */
    // 网页右下角「停止服务」按钮：先回响应，再优雅关停本机服务进程。
    // 要求自定义头，浏览器对非简单请求会先发预检，可挡住其他站点对本机地址的跨站调用。
    if (p === '/api/system/shutdown' && method === 'POST') {
      if (req.headers['x-workday-action'] !== 'shutdown') {
        throw badRequest('缺少停止动作标识，已拒绝该请求');
      }
      sendJson(res, 200, { ok: true, message: '服务即将停止' });
      setTimeout(() => { if (ctx.requestShutdown) ctx.requestShutdown(); }, 300);
      return;
    }

    if (p === '/api/settings' && method === 'GET') {
      return sendJson(res, 200, {
        settings: cfg,
        all: getSettings(db),
        today,
        systemTimezone: systemTimezone(),
        storage: {
          engine: 'SQLite (node:sqlite)',
          database: ctx.dbPath,
          attachments: ctx.attachmentsDir,
          backups: ctx.backupsDir,
        },
      });
    }

    if (p === '/api/settings' && method === 'PUT') {
      const b = await body();
      if (b.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat('en-CA', { timeZone: b.timezone });
        } catch {
          throw badRequest('时区无效，请使用 IANA 时区名，例如 Asia/Shanghai');
        }
        setSetting(db, 'timezone', b.timezone);
      }
      if (b.theme !== undefined) setSetting(db, 'theme', b.theme === 'dark' ? 'dark' : 'light');
      if (b.focusLimit !== undefined) {
        const n = Number(b.focusLimit);
        if (!Number.isInteger(n) || n < 1 || n > 10) throw badRequest('每日重点数量应在 1~10 之间');
        setSetting(db, 'focusLimit', String(n));
      }
      if (b.deferStreakThreshold !== undefined) {
        const n = Number(b.deferStreakThreshold);
        if (!Number.isInteger(n) || n < 1 || n > 30) throw badRequest('顺延提醒阈值应在 1~30 之间');
        setSetting(db, 'deferStreakThreshold', String(n));
      }
      if (b.browserNotify !== undefined) setSetting(db, 'browserNotify', b.browserNotify === 'on' ? 'on' : 'off');
      return sendJson(res, 200, { ok: true, settings: S.settings(db) });
    }

    /* ---------------- 跨天继承 ---------------- */
    if (p === '/api/carry' && method === 'POST') {
      const b = await body();
      const date = b.date && isDateStr(b.date) ? b.date : today;
      const out = S.carryIn(db, date, { requestId: b.requestId });
      return sendJson(res, 200, out);
    }

    /* ---------------- 每日工作台 ---------------- */
    let m = /^\/api\/days\/(\d{4}-\d{2}-\d{2})$/.exec(p);
    if (m && method === 'GET') {
      return sendJson(res, 200, S.getDay(db, m[1], callCtx));
    }
    if (m && method === 'POST') {
      const b = await body();
      const plan = S.addPlan(db, b.taskId, m[1], { source: b.source || 'manual', isFocus: !!b.isFocus });
      return sendJson(res, 200, { ok: true, plan });
    }

    m = /^\/api\/days\/(\d{4}-\d{2}-\d{2})\/plans$/.exec(p);
    if (m && method === 'POST') {
      const b = await body();
      const plan = S.addPlan(db, b.taskId, m[1], { source: b.source || 'manual', isFocus: !!b.isFocus });
      return sendJson(res, 200, { ok: true, plan });
    }

    if (p === '/api/days/reorder' && method === 'POST') {
      const b = await body();
      if (!isDateStr(b.date)) throw badRequest('日期格式应为 YYYY-MM-DD');
      S.reorderPlans(db, b.date, b.planIds);
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- 任务 ---------------- */
    if (p === '/api/tasks' && method === 'GET') {
      const q = url.searchParams;
      const scope = q.get('scope');
      const list = S.listTasks(db, {
        q: q.get('q') || '',
        status: q.get('status') || '',
        priority: q.get('priority') || '',
        project: q.get('project') || '',
        scope: scope || '',
        today,
      });
      return sendJson(res, 200, { tasks: list, today });
    }

    if (p === '/api/tasks' && method === 'POST') {
      const b = await body();
      const task = S.createTask(db, b, callCtx);
      return sendJson(res, 200, { ok: true, task });
    }

    m = /^\/api\/tasks\/([^/]+)\/logs$/.exec(p);
    if (m && method === 'GET') {
      const taskId = m[1];
      const progressLogs = db.prepare(`SELECT * FROM progress_logs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`)
        .all(taskId).map((l) => ({ ...l }));
      const audits = db.prepare(`SELECT * FROM audit_logs WHERE entity_type = 'daily_plan' AND json_extract(detail, '$.taskId') = ?
        ORDER BY created_at DESC LIMIT 100`).all(taskId).map((a) => {
        let detail = {};
        try { detail = JSON.parse(a.detail); } catch { /* ignore */ }
        return {
          id: a.id, action: a.action, createdAt: a.created_at,
          detail: detail.notice || (detail.from ? `快照 ${detail.from.start}%→${detail.from.end}% 修正为 ${detail.to.start}%→${detail.to.end}%${detail.note ? `（${detail.note}）` : ''}` : a.action),
        };
      });
      return sendJson(res, 200, { progressLogs, corrections: audits });
    }

    m = /^\/api\/tasks\/([^/]+)$/.exec(p);
    if (m) {
      const taskId = m[1];
      if (method === 'GET') return sendJson(res, 200, S.getTask(db, taskId));
      if (method === 'PATCH') {
        const b = await body();
        return sendJson(res, 200, { ok: true, task: S.updateTask(db, taskId, { ...b, bizDate: b.bizDate || today }, callCtx) });
      }
      if (method === 'DELETE') {
        S.softDeleteTask(db, taskId);
        return sendJson(res, 200, { ok: true });
      }
    }

    m = /^\/api\/tasks\/([^/]+)\/progress$/.exec(p);
    if (m && method === 'POST') {
      const b = await body();
      const out = S.setProgress(db, m[1], { ...b, bizDate: b.bizDate || today }, callCtx);
      return sendJson(res, 200, { ok: true, ...out });
    }

    m = /^\/api\/tasks\/([^/]+)\/defer$/.exec(p);
    if (m && method === 'POST') {
      const b = await body();
      if (!isDateStr(b.date)) throw badRequest('请选择延期目标日期');
      const plans = db.prepare(`SELECT * FROM daily_plans WHERE task_id = ? AND biz_date = ? AND state='active'`).all(m[1], today);
      // 延期：移出当天安排，但不标记为"待安排"（目标日期之后仍会重新进入承接范围）
      for (const pl of plans) S.updatePlan(db, pl.id, { state: 'removed', markUnscheduled: false });
      const task = S.updateTask(db, m[1], { deferredUntil: b.date, bizDate: today, note: `延期到 ${b.date}` }, callCtx);
      return sendJson(res, 200, { ok: true, task });
    }

    m = /^\/api\/tasks\/([^/]+)\/restore$/.exec(p);
    if (m && method === 'POST') {
      return sendJson(res, 200, { ok: true, task: S.restoreTask(db, m[1]) });
    }

    m = /^\/api\/tasks\/([^/]+)\/purge$/.exec(p);
    if (m && method === 'DELETE') {
      const b = await body().catch(() => ({}));
      if (b.confirm !== true) throw badRequest('永久删除需要二次确认');
      S.purgeTask(db, m[1]);
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- 计划 ---------------- */
    m = /^\/api\/plans\/([^/]+)$/.exec(p);
    if (m && method === 'PATCH') {
      const b = await body();
      return sendJson(res, 200, { ok: true, plan: S.updatePlan(db, m[1], b) });
    }
    m = /^\/api\/plans\/([^/]+)\/snapshot$/.exec(p);
    if (m && method === 'POST') {
      const b = await body();
      return sendJson(res, 200, { ok: true, plan: S.correctSnapshot(db, m[1], b) });
    }
    m = /^\/api\/plans\/([^/]+)\/sync-snapshot$/.exec(p);
    if (m && method === 'POST') {
      return sendJson(res, 200, { ok: true, plan: S.syncSnapshotFromTask(db, m[1]) });
    }

    /* ---------------- 成果 ---------------- */
    if (p === '/api/achievements' && method === 'GET') {
      const q = url.searchParams;
      return sendJson(res, 200, {
        achievements: S.listAchievements(db, {
          bizDate: q.get('date') || '', taskId: q.get('taskId') || '',
          standalone: q.get('standalone') === '1',
        }),
      });
    }
    if (p === '/api/achievements' && method === 'POST') {
      const b = await body();
      return sendJson(res, 200, { ok: true, achievement: S.createAchievement(db, b, callCtx) });
    }
    m = /^\/api\/achievements\/([^/]+)$/.exec(p);
    if (m && method === 'PATCH') {
      const b = await body();
      return sendJson(res, 200, { ok: true, achievement: S.updateAchievement(db, m[1], b) });
    }
    if (m && method === 'DELETE') {
      S.deleteAchievement(db, m[1]);
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- 阻碍 ---------------- */
    if (p === '/api/blockers' && method === 'GET') {
      return sendJson(res, 200, { blockers: S.listBlockers(db, url.searchParams.get('taskId') || null) });
    }
    if (p === '/api/blockers' && method === 'POST') {
      const b = await body();
      return sendJson(res, 200, { ok: true, blocker: S.createBlocker(db, b) });
    }
    m = /^\/api\/blockers\/([^/]+)$/.exec(p);
    if (m && method === 'PATCH') {
      const b = await body();
      return sendJson(res, 200, { ok: true, blocker: S.updateBlocker(db, m[1], b) });
    }

    /* ---------------- 附件 ---------------- */
    if (p === '/api/attachments' && method === 'POST') {
      const ct = req.headers['content-type'] || '';
      if (!/multipart\/form-data/.test(ct)) throw badRequest('附件上传需要 multipart/form-data');
      const bm = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
      if (!bm) throw badRequest('缺少 multipart boundary');
      const buf = await readBody(req, MAX_UPLOAD);
      const parts = parseMultipart(buf, bm[1] || bm[2]);
      const file = parts.find((x) => x.filename);
      if (!file) throw badRequest('未收到文件');
      const get = (n) => (parts.find((x) => x.name === n && !x.filename) || {}).data || '';
      const ownerType = get('ownerType');
      const ownerId = get('ownerId');
      if (!ownerType || !ownerId) throw badRequest('缺少附件归属信息');
      if (file.data.length > MAX_UPLOAD) throw badRequest('单个附件不能超过 25MB');
      const aid = id('f_');
      const stored = `${aid}_${safeFileName(file.filename)}`;
      fs.writeFileSync(path.join(ctx.attachmentsDir, stored), file.data);
      db.prepare(`INSERT INTO attachments (id, owner_type, owner_id, name, size, mime, stored_name, created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(aid, ownerType, ownerId, safeFileName(file.filename), file.data.length, file.contentType, stored, nowISO());
      S.audit(db, 'attachment', aid, 'create', { ownerType, ownerId, name: file.filename, size: file.data.length });
      return sendJson(res, 200, { ok: true, attachment: S.publicAttachment(db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(aid)) });
    }

    m = /^\/api\/attachments\/([^/]+)\/file$/.exec(p);
    if (m && method === 'GET') {
      const a = S.getAttachment(db, m[1]);
      const fp = path.join(ctx.attachmentsDir, safeFileName(a.stored_name));
      if (!fs.existsSync(fp)) throw notFound('附件文件已丢失');
      return sendBinary(res, 200, fs.readFileSync(fp), {
        'content-type': a.mime || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      });
    }

    m = /^\/api\/attachments\/([^/]+)$/.exec(p);
    if (m && method === 'DELETE') {
      const a = S.deleteAttachment(db, m[1]);
      const fp = path.join(ctx.attachmentsDir, safeFileName(a.stored_name));
      if (fs.existsSync(fp)) fs.rmSync(fp, { force: true });
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- 周回顾 ---------------- */
    m = /^\/api\/weeks\/(\d{4}-\d{2}-\d{2})$/.exec(p);
    if (m && method === 'GET') {
      return sendJson(res, 200, S.getWeekReview(db, m[1], callCtx));
    }
    m = /^\/api\/weeks\/(\d{4}-\d{2}-\d{2})\/markdown$/.exec(p);
    if (m && method === 'GET') {
      const review = S.getWeekReview(db, m[1], callCtx);
      const md = S.weekReviewMarkdown(db, review);
      return sendJson(res, 200, { ok: true, markdown: md, filename: `周回顾-${review.start}~${review.end}.md` });
    }

    /* ---------------- 回收站 ---------------- */
    if (p === '/api/trash' && method === 'GET') {
      return sendJson(res, 200, S.listTrash(db));
    }
    if (p === '/api/trash' && method === 'DELETE') {
      const b = await body();
      if (b.confirm !== true) throw badRequest('清空回收站需要二次确认');
      const trash = S.listTrash(db);
      for (const t of trash.tasks) S.purgeTask(db, t.id);
      db.prepare(`DELETE FROM achievements WHERE deleted_at IS NOT NULL`).run();
      return sendJson(res, 200, { ok: true, purged: trash.tasks.length });
    }

    /* ---------------- 备份与恢复 ---------------- */
    if (p === '/api/backup/export' && method === 'GET') {
      const { buf, missing } = buildBackupZip(db, ctx.attachmentsDir);
      const name = `workday-backup-${today}.zip`;
      if (missing.length) {
        // 附件文件缺失仍导出，但在响应头中提示
        res.setHeader('x-backup-missing-attachments', encodeURIComponent(missing.join(',')));
      }
      return sendBinary(res, 200, buf, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
    }

    if ((p === '/api/backup/preview' || p === '/api/backup/import') && method === 'POST') {
      const ct = req.headers['content-type'] || '';
      if (!/multipart\/form-data/.test(ct)) throw badRequest('请上传 multipart/form-data 备份文件');
      const bm = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
      if (!bm) throw badRequest('缺少 multipart boundary');
      const buf = await readBody(req, 200 * 1024 * 1024);
      const parts = parseMultipart(buf, bm[1] || bm[2]);
      const file = parts.find((x) => x.filename);
      if (!file) throw badRequest('未收到备份文件');
      const get = (n) => (parts.find((x) => x.name === n && !x.filename) || {}).data || '';

      const parsed = parseBackup(file.data); // 解析失败直接抛错，不触碰现有数据
      if (p === '/api/backup/preview') {
        return sendJson(res, 200, { ok: true, summary: parsed.summary, warnings: parsed.warnings });
      }
      const mode = get('mode') === 'overwrite' ? 'overwrite' : 'merge';
      if (mode === 'overwrite' && get('confirm') !== 'true') {
        throw badRequest('覆盖恢复需要二次确认');
      }
      const report = applyImport(db, parsed, {
        mode, attachmentsDir: ctx.attachmentsDir, backupsDir: ctx.backupsDir,
      });
      return sendJson(res, 200, { ok: true, report, summary: parsed.summary, warnings: parsed.warnings });
    }

    /* ---------------- 示例数据（明确入口） ---------------- */
    if (p === '/api/demo/load' && method === 'POST') {
      const out = loadDemoData(db, callCtx, ctx.attachmentsDir);
      return sendJson(res, 200, { ok: true, ...out });
    }
    if (p === '/api/demo/clear' && method === 'POST') {
      const b = await body();
      if (b.confirm !== true) throw badRequest('清空数据需要二次确认');
      clearAllData(db, { attachmentsDir: ctx.attachmentsDir });
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- 审计日志 ---------------- */
    if (p === '/api/audit' && method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
      const rows = db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit);
      return sendJson(res, 200, { logs: rows });
    }

    throw notFound(`接口不存在：${method} ${p}`);
  } catch (err) {
    if (err instanceof ApiError) {
      return sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
    }
    console.error('[api error]', err);
    return sendJson(res, 500, { error: 'internal_error', message: err.message || '服务器内部错误' });
  }
}
