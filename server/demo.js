import { id, nowISO, addDays } from './util.js';
import * as S from './store.js';

/**
 * 示例数据：只能通过"加载示例数据"明确入口写入，
 * 生成的所有记录都带 demo 标记，可通过"清空全部数据"移除。
 */
export function loadDemoData(db, ctx, attachmentsDir) {
  const today = ctx.today;
  const y = addDays(today, -1);
  const y2 = addDays(today, -2);
  const ts = nowISO();
  let n = 0;

  const mk = (task, planDate, opts = {}) => {
    const tid = id('t_');
    db.prepare(`INSERT INTO tasks (id, title, description, project, priority, status, progress,
      due_date, next_action, deferred_until, unscheduled, is_adhoc, defer_streak, last_carry_date,
      version, created_at, updated_at, deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
      .run(tid, task.title, task.description || '', task.project || '', task.priority || 'medium',
        task.status || 'in_progress', task.progress ?? 0, task.dueDate || null, task.nextAction || '',
        null, 0, task.isAdhoc ? 1 : 0, task.deferStreak || 0, null, 1, ts, ts);
    if (planDate) {
      db.prepare(`INSERT INTO daily_plans (id, task_id, biz_date, sort_order, is_focus, source,
        carried_from, start_progress, end_progress, state, version, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id('p_'), tid, planDate, n++, opts.isFocus ? 1 : 0, opts.source || 'manual',
          opts.carriedFrom || null, opts.start ?? task.progress ?? 0, opts.end ?? task.progress ?? 0,
          'active', 1, ts, ts);
    }
    n++;
    return tid;
  };

  const ach = (taskId, bizDate, content) => {
    db.prepare(`INSERT INTO achievements (id, task_id, biz_date, content, version, created_at, updated_at, deleted_at)
      VALUES (?,?,?,?,?,?,?,NULL)`).run(id('a_'), taskId, bizDate, content, 1, ts, ts);
  };

  const log = (taskId, bizDate, from, to, fromS, toS, note) => {
    db.prepare(`INSERT INTO progress_logs (id, task_id, biz_date, kind, from_progress, to_progress,
      from_status, to_status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id(), taskId, bizDate, 'progress', from, to, fromS, toS, note, ts);
  };

  // 1. 昨天开始、今天承接的主任务（60% → 承接后仍为 60%）
  const t1 = mk({
    title: '完善季度项目方案', description: '补齐预算与风险章节，提交负责人审核',
    project: '季度规划', priority: 'high', status: 'in_progress', progress: 60,
    dueDate: addDays(today, 2), nextAction: '提交负责人审核',
  }, y2, { start: 0, end: 40 });
  log(t1, y2, 0, 40, 'not_started', 'in_progress', '完成初稿骨架');
  ach(t1, y2, '完成方案初稿骨架，确定章节结构。');
  // 昨天的计划（承接自前天，日末快照 60%）
  db.prepare(`INSERT OR IGNORE INTO daily_plans (id, task_id, biz_date, sort_order, is_focus, source,
    carried_from, start_progress, end_progress, state, version, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id('p_'), t1, y, 0, 1, 'carry', y2, 40, 60, 'active', 1, ts, ts);
  log(t1, y, 40, 60, 'in_progress', 'in_progress', '补充预算章节');
  ach(t1, y, '补充预算章节，完成两轮修改。');

  // 2. 等待他人的任务（带阻碍）
  const t2 = mk({
    title: '客户合同用印流程', description: '等待法务反馈模板', project: '客户 A',
    priority: 'high', status: 'waiting', progress: 30, dueDate: addDays(today, 1),
    nextAction: '法务确认后提交用印申请',
  }, y, { start: 30, end: 30 });
  db.prepare(`INSERT INTO blockers (id, task_id, reason, need_who, need_what, follow_up_date, status, resolved_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,NULL,?,?)`)
    .run(id('b_'), t2, '法务尚未反馈合同模板版本', '法务-李工', '最新版合同模板', today, 'open', ts, ts);
  ach(t2, y, '已提交用印申请，等待法务确认模板。');

  // 3. 逾期任务
  const t3 = mk({
    title: '上月费用报销归档', description: '整理发票并归档', project: '行政',
    priority: 'medium', status: 'not_started', progress: 0, dueDate: addDays(today, -2),
    nextAction: '整理纸质发票', deferStreak: 3,
  }, y2, { start: 0, end: 0 });

  // 4. 今日重点
  const t4 = mk({
    title: '本周团队周会材料', description: '汇总本周进展与风险', project: '季度规划',
    priority: 'medium', status: 'not_started', progress: 0, dueDate: today,
    nextAction: '收集各组进展',
  }, today, { isFocus: true, start: 0, end: 0 });

  // 5. 临时新增事项
  const t5 = mk({
    title: '临时：处理线上告警', description: '监控告警，需要排查', project: '运维',
    priority: 'high', status: 'in_progress', progress: 50, isAdhoc: true,
    nextAction: '联系值班同学确认影响面',
  }, today, { source: 'adhoc', start: 0, end: 50 });

  // 独立成果
  ach(null, y, '协助新同事完成环境配置（独立成果，不关联具体任务）。');

  S.audit(db, 'demo', '-', 'load_demo', { at: ts, note: '示例数据已加载，可通过数据管理清空' });

  return { tasks: 5, message: '示例数据已加载（含昨日记录，可执行跨天继承查看效果）', today, yesterday: y };
}
