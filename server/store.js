import {
  id, nowISO, todayInTz, addDays, mondayOf, weekRange, weekdayCn,
  clampProgress, badRequest, conflict, notFound, isDateStr, diffDays,
} from './util.js';
import { getSettings } from './db.js';

export const ACTIVE_STATUS = ['not_started', 'in_progress', 'waiting'];
export const PRIORITY = ['high', 'medium', 'low'];
export const STATUS = ['not_started', 'in_progress', 'waiting', 'done', 'cancelled'];

/* ============================ 基础工具 ============================ */

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export function settings(db) {
  const s = getSettings(db);
  return {
    timezone: s.timezone || 'Asia/Shanghai',
    theme: s.theme || 'light',
    focusLimit: Number(s.focusLimit || 3),
    deferStreakThreshold: Number(s.deferStreakThreshold || 3),
    browserNotify: s.browserNotify || 'off',
  };
}

export function audit(db, entityType, entityId, action, detail = {}) {
  db.prepare(`INSERT INTO audit_logs (id, entity_type, entity_id, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id(), entityType, entityId, action, JSON.stringify(detail), nowISO());
}

function bump(row) {
  return { ...row, version: (row.version || 0) + 1, updated_at: nowISO() };
}

function checkVersion(row, expected, label = '数据') {
  if (expected != null && Number(expected) !== Number(row.version)) {
    throw conflict(`${label}已在其他位置被修改（当前版本 ${row.version}，你基于版本 ${expected}）。已保留你的输入，请确认后重试。`, {
      current: publicTask(row), expected,
    });
  }
}

function cleanTaskRow(t) {
  if (!t) return t;
  return {
    ...t,
    deleted: !!t.deleted_at,
    unscheduled: !!t.unscheduled,
    is_adhoc: !!t.is_adhoc,
  };
}

export function publicTask(t) {
  if (!t) return null;
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    project: t.project,
    priority: t.priority,
    status: t.status,
    progress: t.progress,
    dueDate: t.due_date ?? t.dueDate ?? null,
    nextAction: t.next_action ?? t.nextAction ?? '',
    deferredUntil: t.deferred_until ?? t.deferredUntil ?? null,
    unscheduled: !!t.unscheduled,
    isAdhoc: !!t.is_adhoc,
    deferStreak: t.defer_streak ?? t.deferStreak ?? 0,
    lastCarryDate: t.last_carry_date ?? t.lastCarryDate ?? null,
    version: t.version,
    createdAt: t.created_at ?? t.createdAt,
    updatedAt: t.updated_at ?? t.updatedAt,
    deletedAt: t.deleted_at ?? t.deletedAt ?? null,
  };
}

/* ============================ 任务 ============================ */

export function listTasks(db, opts = {}) {
  const { q, status, priority, project, includeDeleted = false, scope } = opts;
  const where = [];
  const args = [];
  if (!includeDeleted) where.push('t.deleted_at IS NULL');
  if (status) { where.push('t.status = ?'); args.push(status); }
  if (priority) { where.push('t.priority = ?'); args.push(priority); }
  if (project) { where.push('t.project = ?'); args.push(project); }
  if (q) {
    where.push('(t.title LIKE ? OR t.description LIKE ? OR t.project LIKE ? OR t.next_action LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  if (scope === 'unscheduled') {
    const today = opts.today;
    where.push(`NOT EXISTS (SELECT 1 FROM daily_plans p WHERE p.task_id = t.id AND p.biz_date >= ? AND p.state = 'active')`);
    args.push(today);
    where.push(`t.status IN ('not_started','in_progress','waiting')`);
  }
  const sql = `SELECT t.* FROM tasks t
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE t.status WHEN 'in_progress' THEN 0 WHEN 'not_started' THEN 1 WHEN 'waiting' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
      CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      t.updated_at DESC`;
  return db.prepare(sql).all(...args).map(publicTask);
}

export function getTask(db, taskId) {
  const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  if (!t) throw notFound('任务不存在');
  return publicTask(t);
}

export function createTask(db, input, ctx) {
  const bizDate = input.bizDate || ctx.today;
  if (!isDateStr(bizDate)) throw badRequest('业务日期格式应为 YYYY-MM-DD');
  const title = String(input.title || '').trim();
  if (!title) throw badRequest('任务标题不能为空');
  if (title.length > 300) throw badRequest('任务标题过长（最多 300 字）');

  const priority = PRIORITY.includes(input.priority) ? input.priority : 'medium';
  const status = STATUS.includes(input.status) ? input.status : 'not_started';
  let progress = clampProgress(input.progress ?? 0);
  if (status === 'done') progress = 100;
  if (progress === 100 && status !== 'cancelled') {
    // 100% 同步为已完成
  }

  const ts = nowISO();
  const taskId = id('t_');
  const finalStatus = progress === 100 && status !== 'cancelled' ? 'done' : status;
  const isAdhoc = input.isAdhoc ? 1 : 0;

  return tx(db, () => {
    db.prepare(`INSERT INTO tasks (id, title, description, project, priority, status, progress,
      due_date, next_action, deferred_until, unscheduled, is_adhoc, defer_streak, last_carry_date,
      version, created_at, updated_at, deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
      .run(taskId, title, String(input.description || ''), String(input.project || ''),
        priority, finalStatus, progress, isDateStr(input.dueDate) ? input.dueDate : null,
        String(input.nextAction || ''), isDateStr(input.deferredUntil) ? input.deferredUntil : null,
        0, isAdhoc, 0, null, 1, ts, ts);

    if (progress > 0) {
      db.prepare(`INSERT INTO progress_logs (id, task_id, biz_date, kind, from_progress, to_progress, from_status, to_status, note, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id(), taskId, bizDate, 'create', 0, progress, 'not_started', finalStatus, '创建任务', ts);
    }

    const planId = id('p_');
    db.prepare(`INSERT INTO daily_plans (id, task_id, biz_date, sort_order, is_focus, source,
      carried_from, start_progress, end_progress, state, version, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(planId, taskId, bizDate, nextSort(db, bizDate), input.isFocus ? 1 : 0,
        isAdhoc ? 'adhoc' : 'manual', null, progress, progress, 'active', 1, ts, ts);

    audit(db, 'task', taskId, 'create', { title, bizDate, source: isAdhoc ? 'adhoc' : 'manual' });
    audit(db, 'daily_plan', planId, 'create', { taskId, bizDate });
    return getTask(db, taskId);
  });
}

export function updateTask(db, taskId, patch, ctx) {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  if (!row) throw notFound('任务不存在');
  checkVersion(row, patch.version, `任务「${row.title}」`);

  const next = { ...row };
  if (patch.title !== undefined) {
    const t = String(patch.title).trim();
    if (!t) throw badRequest('任务标题不能为空');
    if (t.length > 300) throw badRequest('任务标题过长（最多 300 字）');
    next.title = t;
  }
  if (patch.description !== undefined) next.description = String(patch.description);
  if (patch.project !== undefined) next.project = String(patch.project);
  if (patch.priority !== undefined) {
    if (!PRIORITY.includes(patch.priority)) throw badRequest('优先级取值非法');
    next.priority = patch.priority;
  }
  if (patch.dueDate !== undefined) next.due_date = patch.dueDate && isDateStr(patch.dueDate) ? patch.dueDate : null;
  if (patch.nextAction !== undefined) next.next_action = String(patch.nextAction || '');
  if (patch.deferredUntil !== undefined) {
    if (patch.deferredUntil && !isDateStr(patch.deferredUntil)) throw badRequest('延期日期格式应为 YYYY-MM-DD');
    next.deferred_until = patch.deferredUntil || null;
  }

  // 状态 / 进度（含联动规则）
  let statusChanged = false;
  let progressChanged = false;
  if (patch.status !== undefined) {
    if (!STATUS.includes(patch.status)) throw badRequest('状态取值非法');
    if (row.status === 'done' && patch.status !== 'done') {
      // 重新打开已完成任务：必须选择未完成状态且进度 < 100
      if (patch.status === 'done') throw badRequest('该任务已是已完成状态');
    }
    if (patch.status === 'done') {
      next.progress = 100;
      progressChanged = next.progress !== row.progress;
    }
    next.status = patch.status;
    statusChanged = next.status !== row.status;
  }
  if (patch.progress !== undefined && !statusChanged) {
    const p = clampProgress(patch.progress);
    if (row.status === 'done' && p >= 100 && patch.status === undefined) {
      throw badRequest('已完成任务请先把状态改为未完成，并设置小于 100% 的进度');
    }
    next.progress = p;
    progressChanged = next.progress !== row.progress;
  } else if (patch.progress !== undefined && patch.status !== undefined) {
    const p = clampProgress(patch.progress);
    if (row.status === 'done' && patch.status !== 'done' && p >= 100) {
      throw badRequest('重新打开已完成任务时，进度必须小于 100%');
    }
    if (patch.status === 'done') next.progress = 100;
    else next.progress = p;
    progressChanged = next.progress !== row.progress;
  }
  if (next.progress === 100 && next.status !== 'done' && next.status !== 'cancelled' && patch.progress !== undefined) {
    next.status = 'done'; // 设为 100% 同步为已完成
    statusChanged = next.status !== row.status;
  }
  if ((next.status === 'done') !== (row.status === 'done')) statusChanged = true;

  const ts = nowISO();
  return tx(db, () => {
    db.prepare(`UPDATE tasks SET title=?, description=?, project=?, priority=?, status=?, progress=?,
      due_date=?, next_action=?, deferred_until=?, version=?, updated_at=? WHERE id=?`)
      .run(next.title, next.description, next.project, next.priority, next.status, next.progress,
        next.due_date, next.next_action, next.deferred_until, row.version + 1, ts, taskId);

    const bizDate = patch.bizDate && isDateStr(patch.bizDate) ? patch.bizDate : ctx.today;
    if (statusChanged || progressChanged) {
      db.prepare(`INSERT INTO progress_logs (id, task_id, biz_date, kind, from_progress, to_progress,
        from_status, to_status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id(), taskId, bizDate, statusChanged ? 'status' : 'progress',
          row.progress, next.progress, row.status, next.status, String(patch.note || ''), ts);
      syncPlanSnapshot(db, taskId, bizDate, next.progress, { ensure: true, source: 'manual', startFrom: row.progress });
    }
    audit(db, 'task', taskId, 'update', {
      changed: Object.keys(patch).filter((k) => k !== 'version' && k !== 'bizDate'),
      from: { status: row.status, progress: row.progress },
      to: { status: next.status, progress: next.progress },
    });
    return getTask(db, taskId);
  });
}

/** 更新进度（带业务日期快照），返回 { task, plan } */
export function setProgress(db, taskId, body, ctx) {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  if (!row) throw notFound('任务不存在');
  checkVersion(row, body.version, `任务「${row.title}」`);

  let status = body.status && STATUS.includes(body.status) ? body.status : row.status;
  let progress = body.progress !== undefined ? clampProgress(body.progress) : row.progress;

  if (row.status === 'done' && status !== 'done' && progress >= 100) {
    throw badRequest('重新打开已完成任务时，请选择未完成状态并把进度设为小于 100%');
  }
  if (status === 'done') progress = 100;
  if (progress === 100 && status !== 'cancelled') status = 'done';

  const bizDate = body.bizDate && isDateStr(body.bizDate) ? body.bizDate : ctx.today;
  const ts = nowISO();
  return tx(db, () => {
    db.prepare(`UPDATE tasks SET status=?, progress=?, version=?, updated_at=? WHERE id=?`)
      .run(status, progress, row.version + 1, ts, taskId);
    db.prepare(`INSERT INTO progress_logs (id, task_id, biz_date, kind, from_progress, to_progress,
      from_status, to_status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id(), taskId, bizDate, status !== row.status ? 'status' : 'progress',
        row.progress, progress, row.status, status, String(body.note || ''), ts);
    const plan = syncPlanSnapshot(db, taskId, bizDate, progress, { ensure: true, source: 'manual', startFrom: row.progress });
    audit(db, 'task', taskId, 'progress', {
      bizDate, from: { progress: row.progress, status: row.status }, to: { progress, status },
    });
    return { task: getTask(db, taskId), plan: publicPlan(plan) };
  });
}

/** 确保某业务日期存在计划，并把日末进度写为当前值 */
function syncPlanSnapshot(db, taskId, bizDate, progress, { ensure = true, source = 'manual', startFrom } = {}) {
  const plan = db.prepare(`SELECT * FROM daily_plans WHERE task_id = ? AND biz_date = ?`).get(taskId, bizDate);
  const ts = nowISO();
  if (!plan) {
    if (!ensure) return null;
    const planId = id('p_');
    db.prepare(`INSERT INTO daily_plans (id, task_id, biz_date, sort_order, is_focus, source,
      carried_from, start_progress, end_progress, state, version, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(planId, taskId, bizDate, nextSort(db, bizDate), 0, source, null,
        startFrom ?? progress, progress, 'active', 1, ts, ts);
    audit(db, 'daily_plan', planId, 'create', { taskId, bizDate, reason: 'progress_on_unplanned_task' });
    return db.prepare(`SELECT * FROM daily_plans WHERE id = ?`).get(planId);
  }
  db.prepare(`UPDATE daily_plans SET end_progress = ?, updated_at = ?, version = ? WHERE id = ?`)
    .run(progress, ts, plan.version + 1, plan.id);
  return db.prepare(`SELECT * FROM daily_plans WHERE id = ?`).get(plan.id);
}

function nextSort(db, bizDate) {
  const r = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM daily_plans WHERE biz_date = ?`).get(bizDate);
  return r.n;
}

/* ============================ 每日计划 ============================ */

export function addPlan(db, taskId, bizDate, opts = {}) {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  if (!row) throw notFound('任务不存在');
  if (row.deleted_at) throw badRequest('任务已在回收站，请先恢复');
  if (row.status === 'done' || row.status === 'cancelled') throw badRequest('已完成/已取消的任务不能加入当日计划');

  const existing = db.prepare(`SELECT * FROM daily_plans WHERE task_id = ? AND biz_date = ?`).get(taskId, bizDate);
  const ts = nowISO();
  return tx(db, () => {
    if (existing) {
      if (existing.state === 'active') {
        // 幂等：已安排则直接返回
        return publicPlan(existing);
      }
      db.prepare(`UPDATE daily_plans SET state='active', source=COALESCE(?, source), sort_order=?, updated_at=?, version=? WHERE id=?`)
        .run(opts.source || null, nextSort(db, bizDate), ts, existing.version + 1, existing.id);
      db.prepare(`UPDATE tasks SET unscheduled = 0, deferred_until = CASE
          WHEN deferred_until IS NOT NULL AND deferred_until <= ? THEN NULL ELSE deferred_until END,
          updated_at = ?, version = version + 1 WHERE id = ?`).run(bizDate, ts, taskId);
      audit(db, 'daily_plan', existing.id, 'restore', { taskId, bizDate });
      return publicPlan(db.prepare(`SELECT * FROM daily_plans WHERE id = ?`).get(existing.id));
    }
    const planId = id('p_');
    db.prepare(`INSERT INTO daily_plans (id, task_id, biz_date, sort_order, is_focus, source,
      carried_from, start_progress, end_progress, state, version, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(planId, taskId, bizDate, nextSort(db, bizDate), opts.isFocus ? 1 : 0,
        opts.source || 'manual', opts.carriedFrom || null, row.progress, row.progress, 'active', 1, ts, ts);
    db.prepare(`UPDATE tasks SET unscheduled = 0, updated_at = ?, version = version + 1 WHERE id = ?`).run(ts, taskId);
    audit(db, 'daily_plan', planId, 'create', { taskId, bizDate, source: opts.source || 'manual' });
    return publicPlan(db.prepare(`SELECT * FROM daily_plans WHERE id = ?`).get(planId));
  });
}

export function publicPlan(p) {
  if (!p) return null;
  return {
    id: p.id,
    taskId: p.task_id ?? p.taskId,
    bizDate: p.biz_date ?? p.bizDate,
    sortOrder: p.sort_order ?? p.sortOrder ?? 0,
    isFocus: !!(p.is_focus ?? p.isFocus),
    source: p.source,
    carriedFrom: p.carried_from ?? p.carriedFrom ?? null,
    startProgress: p.start_progress ?? p.startProgress ?? 0,
    endProgress: p.end_progress ?? p.endProgress ?? 0,
    state: p.state,
    version: p.version,
    createdAt: p.created_at ?? p.createdAt,
    updatedAt: p.updated_at ?? p.updatedAt,
  };
}

export function updatePlan(db, planId, patch) {
  const plan = db.prepare(`SELECT * FROM daily_plans WHERE id = ?`).get(planId);
  if (!plan) throw notFound('计划记录不存在');
  if (patch.version != null && Number(patch.version) !== Number(plan.version)) {
    throw conflict('该计划记录已在其他位置被修改，请刷新后重试', { current: publicPlan(plan) });
  }
  const ts = nowISO();
  return tx(db, () => {
    if (patch.isFocus !== undefined) {
      if (patch.isFocus) {
        const cfg = settings(db);
        const cnt = db.prepare(`SELECT COUNT(*) c FROM daily_plans WHERE biz_date = ? AND is_focus = 1 AND state = 'active' AND id <> ?`)
          .get(plan.biz_date, planId).c;
        if (cnt >= cfg.focusLimit) throw badRequest(`每天最多设置 ${cfg.focusLimit} 项重点任务`);
      }
      db.prepare(`UPDATE daily_plans SET is_focus = ?, updated_at = ?, version = ? WHERE id = ?`)
        .run(patch.isFocus ? 1 : 0, ts, plan.version + 1, planId);
    }
    if (patch.sortOrder !== undefined) {
      db.prepare(`UPDATE daily_plans SET sort_order = ?, updated_at = ?, version = ? WHERE id = ?`)
        .run(Number(patch.sortOrder) || 0, ts, (plan.version + (patch.isFocus !== undefined ? 1 : 0)), planId);
    }
    if (patch.state !== undefined) {
      if (!['active', 'removed'].includes(patch.state)) throw badRequest('计划状态非法');
      db.prepare(`UPDATE daily_plans SET state = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
        .run(patch.state, ts, planId);
      // markUnscheduled=false 用于"延期"场景：移出当天安排，但任务仍会在目标日期后重新进入承接范围
      if (patch.state === 'removed' && patch.markUnscheduled !== false) {
        db.prepare(`UPDATE tasks SET unscheduled = 1, updated_at = ?, version = version + 1 WHERE id = ?`)
          .run(ts, plan.task_id);
      }
      audit(db, 'daily_plan', planId, patch.state === 'removed' ? 'remove_from_day' : 'restore', {
        taskId: plan.task_id, bizDate: plan.biz_date,
      });
    }
    return publicPlan(db.prepare(`SELECT * FROM daily_plans WHERE id = ?`).get(planId));
  });
}

export function reorderPlans(db, bizDate, planIds) {
  if (!Array.isArray(planIds)) throw badRequest('排序数据格式错误');
  const ts = nowISO();
  return tx(db, () => {
    const st = db.prepare(`UPDATE daily_plans SET sort_order = ?, updated_at = ? WHERE id = ? AND biz_date = ?`);
    planIds.forEach((pid, i) => st.run(i, ts, pid, bizDate));
    return true;
  });
}

/** 显式修正历史快照：只改该日快照 + 留痕，不自动改写任务当前进度 */
export function correctSnapshot(db, planId, body) {
  const plan = db.prepare(`SELECT * FROM daily_plans WHERE id = ?`).get(planId);
  if (!plan) throw notFound('计划记录不存在');
  const start = body.startProgress !== undefined ? clampProgress(body.startProgress) : plan.start_progress;
  const end = body.endProgress !== undefined ? clampProgress(body.endProgress) : plan.end_progress;
  const ts = nowISO();
  return tx(db, () => {
    db.prepare(`UPDATE daily_plans SET start_progress = ?, end_progress = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(start, end, ts, planId);
    audit(db, 'daily_plan', planId, 'correct_snapshot', {
      from: { start: plan.start_progress, end: plan.end_progress },
      to: { start, end },
      note: String(body.note || ''),
      taskId: plan.task_id, bizDate: plan.biz_date,
      correctedAt: ts,
      notice: '仅修正当日快照，未自动改写任务当前进度',
    });
    return publicPlan(db.prepare(`SELECT * FROM daily_plans WHERE id = ?`).get(planId));
  });
}

/** 把任务当前进度同步到指定日快照（显式、单独操作） */
export function syncSnapshotFromTask(db, planId) {
  const plan = db.prepare(`SELECT * FROM daily_plans WHERE id = ?`).get(planId);
  if (!plan) throw notFound('计划记录不存在');
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(plan.task_id);
  const ts = nowISO();
  return tx(db, () => {
    db.prepare(`UPDATE daily_plans SET end_progress = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(task.progress, ts, planId);
    audit(db, 'daily_plan', planId, 'sync_snapshot_from_task', {
      taskId: task.id, bizDate: plan.biz_date, progress: task.progress, at: ts,
    });
    return publicPlan(db.prepare(`SELECT * FROM daily_plans WHERE id = ?`).get(planId));
  });
}

/* ============================ 跨天自动继承（核心） ============================ */

/**
 * 继承口径说明：
 * 1. 仅对"今天"执行，历史/未来日期浏览不触发；
 * 2. 候选 = 未删除 且 状态为未完成三态 且 未被移出今日(unscheduled=0)
 *    且 未延期到未来(deferred_until <= 今天)
 *    且 此前存在 active 的每日计划（即"已进入工作计划且需要继续"）
 *    且 今天尚无该任务的计划记录（含 removed 状态，防止移出后被塞回）；
 * 3. 每个候选在今天新建一条 DailyPlan（source=carry），不复制任务本体；
 * 4. 顺延次数：自上一个计划日以来既无进度变化、也无成果记录，则 +1，否则归零；
 * 5. 唯一约束 (task_id, biz_date) + 幂等键，保证刷新/多标签/重试不产生重复。
 */
export function carryIn(db, date, { requestId } = {}) {
  const cfg = settings(db);
  const today = todayInTz(cfg.timezone);
  if (date !== today) {
    throw badRequest('自动继承只在打开当天工作台时执行，历史与未来日期不会触发继承');
  }
  if (requestId) {
    const prev = db.prepare(`SELECT response FROM idempotency WHERE key = ?`).get(`carry:${date}:${requestId}`);
    if (prev) return JSON.parse(prev.response);
  }

  const result = tx(db, () => {
    const candidates = db.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.deleted_at IS NULL
        AND t.status IN ('not_started','in_progress','waiting')
        AND t.unscheduled = 0
        AND (t.deferred_until IS NULL OR t.deferred_until <= ?)
        AND EXISTS (SELECT 1 FROM daily_plans p WHERE p.task_id = t.id AND p.biz_date < ?)
        AND NOT EXISTS (SELECT 1 FROM daily_plans p2 WHERE p2.task_id = t.id AND p2.biz_date = ?)
      ORDER BY t.priority, t.updated_at
    `).all(date, date, date);

    const carried = [];
    const ts = nowISO();
    for (const t of candidates) {
      const last = db.prepare(`SELECT * FROM daily_plans WHERE task_id = ? AND biz_date < ?
        ORDER BY (state = 'active') DESC, biz_date DESC LIMIT 1`).get(t.id, date);
      if (!last) continue;

      const moved = db.prepare(`SELECT COUNT(*) c FROM progress_logs WHERE task_id = ? AND biz_date >= ? AND from_progress <> to_progress`)
        .get(t.id, last.biz_date).c;
      const achieved = db.prepare(`SELECT COUNT(*) c FROM achievements WHERE task_id = ? AND biz_date >= ? AND deleted_at IS NULL`)
        .get(t.id, last.biz_date).c;
      const progressed = moved > 0 || achieved > 0;
      const streak = progressed ? 0 : (t.defer_streak || 0) + 1;

      const planId = id('p_');
      db.prepare(`INSERT INTO daily_plans (id, task_id, biz_date, sort_order, is_focus, source,
        carried_from, start_progress, end_progress, state, version, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(planId, t.id, date, nextSort(db, date), 0, 'carry', last.biz_date,
          t.progress, t.progress, 'active', 1, ts, ts);

      db.prepare(`UPDATE tasks SET last_carry_date = ?, defer_streak = ?, updated_at = ? WHERE id = ?`)
        .run(date, streak, ts, t.id);

      audit(db, 'task', t.id, 'carry', {
        bizDate: date, from: last.biz_date, progress: t.progress,
        streak, deferStreakThreshold: cfg.deferStreakThreshold,
      });
      carried.push({
        taskId: t.id,
        title: t.title,
        planId,
        carriedFrom: last.biz_date,
        progress: t.progress,
        streak,
        needAttention: streak >= cfg.deferStreakThreshold,
      });
    }
    return { date, carried, threshold: cfg.deferStreakThreshold, at: ts };
  });

  if (requestId) {
    db.prepare(`INSERT OR REPLACE INTO idempotency (key, response, created_at) VALUES (?,?,?)`)
      .run(`carry:${date}:${requestId}`, JSON.stringify(result), nowISO());
  }
  return result;
}

/* ============================ 每日工作台聚合 ============================ */

export function getDay(db, date, ctx) {
  if (!isDateStr(date)) throw badRequest('日期格式应为 YYYY-MM-DD');
  const cfg = settings(db);
  const today = todayInTz(cfg.timezone);

  const planRows = db.prepare(`
    SELECT p.*, t.title, t.description, t.project, t.priority, t.status, t.progress, t.due_date,
           t.next_action, t.deferred_until, t.unscheduled, t.is_adhoc, t.defer_streak,
           t.last_carry_date, t.version AS tversion, t.created_at AS tcreated, t.updated_at AS tupdated
    FROM daily_plans p JOIN tasks t ON t.id = p.task_id
    WHERE p.biz_date = ? AND p.state = 'active' AND t.deleted_at IS NULL
    ORDER BY p.sort_order, p.created_at
  `).all(date);

  const achAtt = new Map();
  const collectAchAttachments = (rows) => {
    if (!rows.length) return;
    const ids = rows.map((a) => a.id);
    const ph = ids.map(() => '?').join(',');
    for (const a of db.prepare(`SELECT * FROM attachments WHERE owner_type='achievement' AND owner_id IN (${ph})`).all(...ids)) {
      if (!achAtt.has(a.owner_id)) achAtt.set(a.owner_id, []);
      achAtt.get(a.owner_id).push(publicAttachment(a));
    }
  };

  const plans = planRows.map((r) => ({
    plan: publicPlan({
      id: r.id, task_id: r.task_id, biz_date: r.biz_date, sort_order: r.sort_order, is_focus: r.is_focus,
      source: r.source, carried_from: r.carried_from, start_progress: r.start_progress,
      end_progress: r.end_progress, state: r.state, version: r.version,
      created_at: r.created_at, updated_at: r.updated_at,
    }),
    task: publicTask({
      id: r.task_id, title: r.title, description: r.description, project: r.project, priority: r.priority,
      status: r.status, progress: r.progress, due_date: r.due_date, next_action: r.next_action,
      deferred_until: r.deferred_until, unscheduled: r.unscheduled, is_adhoc: r.is_adhoc,
      defer_streak: r.defer_streak, last_carry_date: r.last_carry_date, version: r.tversion,
      created_at: r.tcreated, updated_at: r.tupdated, deleted_at: null,
    }),
    achievements: listAchievements(db, { bizDate: date, taskId: r.task_id }),
    blockers: listBlockers(db, r.task_id),
    attachments: db.prepare(`SELECT * FROM attachments WHERE owner_type='task' AND owner_id = ? ORDER BY created_at`)
      .all(r.task_id).map(publicAttachment),
  }));

  const standalone = listAchievements(db, { bizDate: date, standalone: true });

  // 成果附件
  const allAch = [...plans.flatMap((p) => p.achievements), ...standalone];
  collectAchAttachments(allAch);
  for (const p of plans) p.achievements = p.achievements.map((a) => ({ ...a, attachments: achAtt.get(a.id) || [] }));
  const standaloneAchievements = standalone.map((a) => ({ ...a, attachments: achAtt.get(a.id) || [] }));

  const doneCount = plans.filter((p) => p.task.status === 'done').length;
  const stats = {
    total: plans.length,
    done: doneCount,
    inProgress: plans.filter((p) => p.task.status === 'in_progress').length,
    waiting: plans.filter((p) => p.task.status === 'waiting').length,
    notStarted: plans.filter((p) => p.task.status === 'not_started').length,
    achievementCount: plans.reduce((n, p) => n + p.achievements.length, 0) + standalone.length,
    focusDone: plans.filter((p) => p.plan.isFocus && p.task.status === 'done').length,
    focusTotal: plans.filter((p) => p.plan.isFocus).length,
  };

  // 提醒：临近截止 / 已逾期 / 今日待跟进
  const openTasks = db.prepare(`SELECT * FROM tasks WHERE deleted_at IS NULL AND status IN ('not_started','in_progress','waiting')`).all();
  const overdue = openTasks.filter((t) => t.due_date && t.due_date < today).map(publicTask);
  const dueSoon = openTasks.filter((t) => t.due_date && t.due_date >= today && diffDays(today, t.due_date) <= 2).map(publicTask);
  const followUps = db.prepare(`SELECT b.*, t.title AS task_title FROM blockers b JOIN tasks t ON t.id = b.task_id
    WHERE b.status = 'open' AND b.follow_up_date IS NOT NULL AND b.follow_up_date <= ? ORDER BY b.follow_up_date`)
    .all(today);

  return {
    date,
    today,
    weekday: weekdayCn(date),
    isToday: date === today,
    isFuture: date > today,
    isHistory: date < today,
    timezone: cfg.timezone,
    plans,
    standaloneAchievements,
    stats,
    reminders: {
      overdue,
      dueSoon,
      followUps: followUps.map((b) => ({
        id: b.id, taskId: b.task_id, taskTitle: b.task_title, reason: b.reason,
        needWho: b.need_who, followUpDate: b.follow_up_date, overdue: b.follow_up_date < today,
      })),
    },
    deferredStreak: openTasks.filter((t) => (t.defer_streak || 0) >= cfg.deferStreakThreshold).map(publicTask),
  };
}

/* ============================ 成果 ============================ */

export function listAchievements(db, { bizDate, taskId, standalone, includeDeleted = false } = {}) {
  const where = [];
  const args = [];
  if (bizDate) { where.push('a.biz_date = ?'); args.push(bizDate); }
  if (taskId) { where.push('a.task_id = ?'); args.push(taskId); }
  if (standalone) where.push('a.task_id IS NULL');
  if (!includeDeleted) where.push('a.deleted_at IS NULL');
  const rows = db.prepare(`SELECT a.* FROM achievements a ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.created_at`).all(...args);
  return rows.map(publicAchievement);
}

export function publicAchievement(a) {
  return {
    id: a.id,
    taskId: a.task_id ?? a.taskId ?? null,
    bizDate: a.biz_date ?? a.bizDate,
    content: a.content,
    version: a.version,
    createdAt: a.created_at ?? a.createdAt,
    updatedAt: a.updated_at ?? a.updatedAt,
    deletedAt: a.deleted_at ?? a.deletedAt ?? null,
    attachments: [],
  };
}

export function createAchievement(db, body, ctx) {
  const bizDate = body.bizDate && isDateStr(body.bizDate) ? body.bizDate : ctx.today;
  const content = String(body.content || '').trim();
  if (!content) throw badRequest('成果内容不能为空');
  if (content.length > 5000) throw badRequest('成果内容过长（最多 5000 字）');
  const taskId = body.taskId || null;
  if (taskId) {
    const t = db.prepare(`SELECT id FROM tasks WHERE id = ? AND deleted_at IS NULL`).get(taskId);
    if (!t) throw notFound('关联任务不存在');
  }
  const ts = nowISO();
  const aid = id('a_');
  return tx(db, () => {
    db.prepare(`INSERT INTO achievements (id, task_id, biz_date, content, version, created_at, updated_at, deleted_at)
      VALUES (?,?,?,?,?,?,?,NULL)`).run(aid, taskId, bizDate, content, 1, ts, ts);
    audit(db, 'achievement', aid, 'create', { bizDate, taskId, length: content.length });
    return publicAchievement(db.prepare(`SELECT * FROM achievements WHERE id = ?`).get(aid));
  });
}

export function updateAchievement(db, aid, patch) {
  const a = db.prepare(`SELECT * FROM achievements WHERE id = ?`).get(aid);
  if (!a) throw notFound('成果记录不存在');
  if (patch.version != null && Number(patch.version) !== Number(a.version)) {
    throw conflict('该成果已在其他位置被修改，已保留你的输入，请确认后重试', { current: publicAchievement(a) });
  }
  const content = patch.content !== undefined ? String(patch.content) : a.content;
  if (!content.trim()) throw badRequest('成果内容不能为空');
  const ts = nowISO();
  return tx(db, () => {
    db.prepare(`UPDATE achievements SET content = ?, updated_at = ?, version = ? WHERE id = ?`)
      .run(content, ts, a.version + 1, aid);
    audit(db, 'achievement', aid, 'update', { from: a.content.slice(0, 200), to: content.slice(0, 200), at: ts });
    return publicAchievement(db.prepare(`SELECT * FROM achievements WHERE id = ?`).get(aid));
  });
}

export function deleteAchievement(db, aid) {
  const a = db.prepare(`SELECT * FROM achievements WHERE id = ?`).get(aid);
  if (!a) throw notFound('成果记录不存在');
  const ts = nowISO();
  return tx(db, () => {
    db.prepare(`UPDATE achievements SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, aid);
    db.prepare(`DELETE FROM attachments WHERE owner_type='achievement' AND owner_id = ?`).run(aid);
    audit(db, 'achievement', aid, 'delete', { bizDate: a.biz_date, taskId: a.task_id, at: ts });
    return true;
  });
}

/* ============================ 阻碍 ============================ */

export function listBlockers(db, taskId) {
  const rows = taskId
    ? db.prepare(`SELECT * FROM blockers WHERE task_id = ? ORDER BY status, created_at DESC`).all(taskId)
    : db.prepare(`SELECT * FROM blockers ORDER BY status, created_at DESC`).all();
  return rows.map(publicBlocker);
}

export function publicBlocker(b) {
  return {
    id: b.id,
    taskId: b.task_id ?? b.taskId,
    reason: b.reason,
    needWho: b.need_who ?? b.needWho ?? '',
    needWhat: b.need_what ?? b.needWhat ?? '',
    followUpDate: b.follow_up_date ?? b.followUpDate ?? null,
    status: b.status,
    resolvedAt: b.resolved_at ?? b.resolvedAt ?? null,
    createdAt: b.created_at ?? b.createdAt,
    updatedAt: b.updated_at ?? b.updatedAt,
  };
}

export function createBlocker(db, body) {
  const taskId = body.taskId;
  const t = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL`).get(taskId);
  if (!t) throw notFound('关联任务不存在');
  if (body.followUpDate && !isDateStr(body.followUpDate)) throw badRequest('跟进日期格式应为 YYYY-MM-DD');
  const ts = nowISO();
  const bid = id('b_');
  return tx(db, () => {
    db.prepare(`INSERT INTO blockers (id, task_id, reason, need_who, need_what, follow_up_date, status, resolved_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,NULL,?,?)`)
      .run(bid, taskId, String(body.reason || ''), String(body.needWho || ''), String(body.needWhat || ''),
        body.followUpDate || null, 'open', ts, ts);
    if (t.status !== 'waiting') {
      db.prepare(`UPDATE tasks SET status='waiting', updated_at=?, version=version+1 WHERE id=?`).run(ts, taskId);
      db.prepare(`INSERT INTO progress_logs (id, task_id, biz_date, kind, from_progress, to_progress, from_status, to_status, note, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id(), taskId, todayInTz(settings(db).timezone), 'status', t.progress, t.progress, t.status, 'waiting', '记录阻碍', ts);
    }
    audit(db, 'blocker', bid, 'create', { taskId, reason: body.reason });
    return publicBlocker(db.prepare(`SELECT * FROM blockers WHERE id = ?`).get(bid));
  });
}

export function updateBlocker(db, bid, patch) {
  const b = db.prepare(`SELECT * FROM blockers WHERE id = ?`).get(bid);
  if (!b) throw notFound('阻碍记录不存在');
  if (patch.followUpDate !== undefined && patch.followUpDate && !isDateStr(patch.followUpDate)) {
    throw badRequest('跟进日期格式应为 YYYY-MM-DD');
  }
  const status = patch.status === 'resolved' ? 'resolved' : (patch.status || b.status);
  const ts = nowISO();
  return tx(db, () => {
    db.prepare(`UPDATE blockers SET reason=?, need_who=?, need_what=?, follow_up_date=?, status=?, resolved_at=?, updated_at=? WHERE id=?`)
      .run(
        patch.reason !== undefined ? String(patch.reason) : b.reason,
        patch.needWho !== undefined ? String(patch.needWho) : b.need_who,
        patch.needWhat !== undefined ? String(patch.needWhat) : b.need_what,
        patch.followUpDate !== undefined ? (patch.followUpDate || null) : b.follow_up_date,
        status,
        status === 'resolved' ? (b.resolved_at || ts) : null,
        ts, bid,
      );
    audit(db, 'blocker', bid, status === 'resolved' ? 'resolve' : 'update', {
      taskId: b.task_id, from: b.status, to: status, at: ts,
    });
    return publicBlocker(db.prepare(`SELECT * FROM blockers WHERE id = ?`).get(bid));
  });
}

/* ============================ 附件 ============================ */

export function publicAttachment(a) {
  return {
    id: a.id,
    ownerType: a.owner_type ?? a.ownerType,
    ownerId: a.owner_id ?? a.ownerId,
    name: a.name,
    size: a.size,
    mime: a.mime,
    createdAt: a.created_at ?? a.createdAt,
    url: `/api/attachments/${a.id}/file`,
  };
}

export function listAttachments(db, ownerType, ownerId) {
  return db.prepare(`SELECT * FROM attachments WHERE owner_type = ? AND owner_id = ? ORDER BY created_at`)
    .all(ownerType, ownerId).map(publicAttachment);
}

export function addAttachment(db, { ownerType, ownerId, name, size, mime, storedName }) {
  const aid = id('f_');
  const ts = nowISO();
  db.prepare(`INSERT INTO attachments (id, owner_type, owner_id, name, size, mime, stored_name, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(aid, ownerType, ownerId, name, size, mime, storedName, ts);
  audit(db, 'attachment', aid, 'create', { ownerType, ownerId, name, size });
  return publicAttachment(db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(aid));
}

export function getAttachment(db, aid) {
  const a = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(aid);
  if (!a) throw notFound('附件不存在');
  return a;
}

export function deleteAttachment(db, aid) {
  const a = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(aid);
  if (!a) throw notFound('附件不存在');
  db.prepare(`DELETE FROM attachments WHERE id = ?`).run(aid);
  audit(db, 'attachment', aid, 'delete', { name: a.name, ownerType: a.owner_type, ownerId: a.owner_id });
  return a;
}

/* ============================ 删除与回收站 ============================ */

export function softDeleteTask(db, taskId) {
  const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  if (!t) throw notFound('任务不存在');
  const ts = nowISO();
  return tx(db, () => {
    db.prepare(`UPDATE tasks SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(ts, ts, taskId);
    audit(db, 'task', taskId, 'delete', { title: t.title, at: ts, note: '进入回收站，可恢复' });
    return true;
  });
}

export function restoreTask(db, taskId) {
  const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  if (!t) throw notFound('任务不存在');
  if (!t.deleted_at) return publicTask(t);
  const ts = nowISO();
  return tx(db, () => {
    db.prepare(`UPDATE tasks SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?`).run(ts, taskId);
    audit(db, 'task', taskId, 'restore', { at: ts, note: '从回收站恢复，历史计划与成果保留' });
    return getTask(db, taskId);
  });
}

export function purgeTask(db, taskId) {
  const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  if (!t) throw notFound('任务不存在');
  return tx(db, () => {
    db.prepare(`DELETE FROM progress_logs WHERE task_id = ?`).run(taskId);
    db.prepare(`DELETE FROM blockers WHERE task_id = ?`).run(taskId);
    db.prepare(`DELETE FROM daily_plans WHERE task_id = ?`).run(taskId);
    db.prepare(`UPDATE achievements SET deleted_at = ?, task_id = NULL WHERE task_id = ?`).run(nowISO(), taskId);
    db.prepare(`DELETE FROM attachments WHERE owner_type='task' AND owner_id = ?`).run(taskId);
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
    audit(db, 'task', taskId, 'purge', { title: t.title, at: nowISO() });
    return true;
  });
}

export function listTrash(db) {
  const tasks = db.prepare(`SELECT * FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`).all().map(publicTask);
  const achievements = db.prepare(`SELECT * FROM achievements WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`).all().map(publicAchievement);
  return { tasks, achievements };
}

/* ============================ 周回顾 ============================ */

export function getWeekReview(db, anyDate, ctx) {
  if (!isDateStr(anyDate)) throw badRequest('日期格式应为 YYYY-MM-DD');
  const { start, end, days } = weekRange(anyDate);
  const cfg = settings(db);
  const today = todayInTz(cfg.timezone);

  // 本周完成任务（按任务 ID 去重，以状态变为 done 的日志所在业务日期为准）
  const doneRows = db.prepare(`
    SELECT DISTINCT pl.task_id FROM progress_logs pl
    JOIN tasks t ON t.id = pl.task_id
    WHERE pl.biz_date BETWEEN ? AND ? AND pl.to_status = 'done' AND t.deleted_at IS NULL
  `).all(start, end).map((r) => r.task_id);
  const doneTasks = doneRows.map((tid) => db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(tid)).filter(Boolean).map(publicTask);

  // 每日成果（按发生日期统计，不重复计入历史）
  const achRows = db.prepare(`SELECT a.*, t.title AS task_title FROM achievements a
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.biz_date BETWEEN ? AND ? AND a.deleted_at IS NULL ORDER BY a.biz_date, a.created_at`)
    .all(start, end);
  const byDay = {};
  for (const d of days) byDay[d] = [];
  for (const a of achRows) {
    (byDay[a.biz_date] ||= []).push({
      ...publicAchievement(a),
      taskTitle: a.task_title || null,
    });
  }

  // 进行中任务（本周有安排或当前进行中，按 ID 去重）
  const activeRows = db.prepare(`
    SELECT DISTINCT t.* FROM tasks t
    LEFT JOIN daily_plans p ON p.task_id = t.id AND p.state='active' AND p.biz_date BETWEEN ? AND ?
    WHERE t.deleted_at IS NULL AND t.status IN ('not_started','in_progress','waiting')
      AND (p.id IS NOT NULL OR t.status = 'in_progress')
  `).all(start, end).map(publicTask);

  const overdue = db.prepare(`SELECT * FROM tasks WHERE deleted_at IS NULL
    AND status IN ('not_started','in_progress','waiting') AND due_date IS NOT NULL AND due_date < ?
    ORDER BY due_date`).all(today).map(publicTask);

  const blockers = db.prepare(`SELECT b.*, t.title AS task_title FROM blockers b JOIN tasks t ON t.id = b.task_id
    WHERE (b.status = 'open' OR b.created_at >= ?) ORDER BY b.status, b.created_at DESC`)
    .all(`${start}T00:00:00.000Z`)
    .map((b) => ({ ...publicBlocker(b), taskTitle: b.task_title }));

  // 计划外工作：独立成果 + 临时新增事项（含其成果）
  const adhocTasks = db.prepare(`
    SELECT DISTINCT t.* FROM tasks t JOIN daily_plans p ON p.task_id = t.id
    WHERE t.deleted_at IS NULL AND t.is_adhoc = 1 AND p.biz_date BETWEEN ? AND ? AND p.state='active'
  `).all(start, end).map(publicTask);
  const standaloneAchievements = achRows.filter((a) => !a.task_id).map((a) => ({
    ...publicAchievement(a),
    taskTitle: null,
  }));

  const streak = db.prepare(`SELECT * FROM tasks WHERE deleted_at IS NULL AND status IN ('not_started','in_progress','waiting')
    AND defer_streak >= ? ORDER BY defer_streak DESC`).all(cfg.deferStreakThreshold).map(publicTask);

  const carriedCount = db.prepare(`SELECT COUNT(*) c FROM daily_plans WHERE biz_date BETWEEN ? AND ? AND source='carry'`)
    .get(start, end).c;

  return {
    start, end, days,
    today,
    labels: days.map((d) => `${d} ${weekdayCn(d)}`),
    doneTasks,
    achievementsByDay: byDay,
    achievementTotal: achRows.length,
    activeTasks: activeRows,
    overdue,
    blockers,
    adhocTasks,
    standaloneAchievements,
    deferredStreak: streak,
    stats: {
      doneCount: doneTasks.length,
      achievementCount: achRows.length,
      activeCount: activeRows.length,
      overdueCount: overdue.length,
      blockerCount: blockers.filter((b) => b.status === 'open').length,
      adhocCount: adhocTasks.length + standaloneAchievements.length,
      carriedCount,
    },
  };
}

export function weekReviewMarkdown(db, review) {
  const L = [];
  L.push(`# 周回顾 ${review.start} ~ ${review.end}`);
  L.push('');
  L.push(`- 完成任务：${review.stats.doneCount} 项`);
  L.push(`- 成果记录：${review.stats.achievementCount} 条`);
  L.push(`- 进行中任务：${review.stats.activeCount} 项`);
  L.push(`- 逾期任务：${review.stats.overdueCount} 项`);
  L.push(`- 未解决阻碍：${review.stats.blockerCount} 条`);
  L.push(`- 计划外工作：${review.stats.adhocCount} 项`);
  L.push('');
  L.push('## 本周完成任务');
  if (!review.doneTasks.length) L.push('- 无');
  else review.doneTasks.forEach((t) => L.push(`- ${t.title}（${t.project || '未分类'}）`));
  L.push('');
  L.push('## 每日成果');
  for (const d of review.days) {
    const list = review.achievementsByDay[d] || [];
    L.push(`### ${d}`);
    if (!list.length) L.push('- 无');
    else list.forEach((a) => L.push(`- ${a.content.replace(/\n/g, ' ')}${a.taskTitle ? `（任务：${a.taskTitle}）` : '（独立成果）'}`));
  }
  L.push('');
  L.push('## 进行中任务');
  if (!review.activeTasks.length) L.push('- 无');
  else review.activeTasks.forEach((t) => L.push(`- ${t.title}｜进度 ${t.progress}%｜状态 ${statusText(t.status)}｜下一步：${t.nextAction || '未填写'}`));
  L.push('');
  L.push('## 逾期任务');
  if (!review.overdue.length) L.push('- 无');
  else review.overdue.forEach((t) => L.push(`- ${t.title}｜截止 ${t.dueDate}｜进度 ${t.progress}%`));
  L.push('');
  L.push('## 主要阻碍');
  const openBlockers = review.blockers.filter((b) => b.status === 'open');
  if (!openBlockers.length) L.push('- 无');
  else openBlockers.forEach((b) => L.push(`- ${b.taskTitle}：${b.reason || '未填写'}${b.needWho ? `（需 ${b.needWho} 协助）` : ''}${b.followUpDate ? `｜跟进 ${b.followUpDate}` : ''}`));
  L.push('');
  L.push('## 计划外工作');
  if (!review.adhocTasks.length && !review.standaloneAchievements.length) L.push('- 无');
  else {
    review.adhocTasks.forEach((t) => L.push(`- 临时事项：${t.title}`));
    review.standaloneAchievements.forEach((a) => L.push(`- 独立成果（${a.bizDate}）：${a.content.replace(/\n/g, ' ')}`));
  }
  L.push('');
  return L.join('\n');
}

export function statusText(s) {
  return { not_started: '未开始', in_progress: '进行中', waiting: '等待他人', done: '已完成', cancelled: '已取消' }[s] || s;
}

export function priorityText(p) {
  return { high: '高', medium: '中', low: '低' }[p] || p;
}

export { tx, mondayOf, addDays };
