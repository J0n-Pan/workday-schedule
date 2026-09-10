import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer, api, RUN_ID } from './helper.js';
import { buildZip } from '../server/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(__dirname, '.tmp');
const running = [];
const mk = async (opts) => { const s = await startServer(opts); running.push(s); return s; };
after(async () => { for (const s of running) await s.stop(); });

const dirOf = (name) => path.join(tmpRoot, `${RUN_ID}-${name}`);

async function newTask(s, body) {
  const r = await api.post(s.url, '/api/tasks', body);
  return r.task;
}
async function day(s, date) { return api.get(s.url, `/api/days/${date}`); }

/* ============================================================
 * 1. 跨天自动继承与历史快照
 * ========================================================== */
describe('跨天继承与快照', () => {
  test('昨日 60% → 今日承接仍为 60%；今日推进到 80% 后昨日快照仍是 60%', async () => {
    const dir = dirOf('carry-basic');
    const s1 = await mk({ now: '2026-09-08T10:00:00+08:00', dataDir: dir });
    const t = await newTask(s1, { title: '完善项目方案', bizDate: '2026-09-08' });
    await api.post(s1.url, `/api/tasks/${t.id}/progress`, { progress: 60, status: 'in_progress', bizDate: '2026-09-08', version: t.version });
    let d1 = await day(s1, '2026-09-08');
    assert.equal(d1.plans[0].plan.endProgress, 60);
    await s1.stop();

    const s2 = await mk({ now: '2026-09-09T10:00:00+08:00', dataDir: dir, clean: false });
    const carry = await api.post(s2.url, '/api/carry', { date: '2026-09-09', requestId: 'r1' });
    assert.equal(carry.carried.length, 1, '应承接 1 项');
    assert.equal(carry.carried[0].progress, 60, '承接后累计进度仍为 60%');

    let d2 = await day(s2, '2026-09-09');
    assert.equal(d2.plans[0].plan.startProgress, 60);
    assert.equal(d2.plans[0].plan.endProgress, 60);
    assert.equal(d2.plans[0].plan.source, 'carry');
    assert.equal(d2.plans[0].plan.carriedFrom, '2026-09-08');

    const cur = d2.plans[0].task;
    await api.post(s2.url, `/api/tasks/${cur.id}/progress`, { progress: 80, bizDate: '2026-09-09', version: cur.version });
    d2 = await day(s2, '2026-09-09');
    assert.equal(d2.plans[0].plan.endProgress, 80, '今日日末进度应为 80%');
    const dYesterday = await day(s2, '2026-09-08');
    assert.equal(dYesterday.plans[0].plan.endProgress, 60, '昨日日末快照必须仍是 60%');
    assert.equal(dYesterday.plans[0].task.progress, 80, '任务当前进度已更新为 80%');
  });

  test('反复刷新、重试请求、不同 requestId 都不会产生重复计划记录', async () => {
    const dir = dirOf('carry-idem');
    const s1 = await mk({ now: '2026-09-08T10:00:00+08:00', dataDir: dir });
    await newTask(s1, { title: 'A', bizDate: '2026-09-08' });
    await newTask(s1, { title: 'B', bizDate: '2026-09-08' });
    await s1.stop();

    const s2 = await mk({ now: '2026-09-09T10:00:00+08:00', dataDir: dir, clean: false });
    await api.post(s2.url, '/api/carry', { date: '2026-09-09', requestId: 'a' });
    await api.post(s2.url, '/api/carry', { date: '2026-09-09', requestId: 'b' });
    await api.post(s2.url, '/api/carry', { date: '2026-09-09' });
    const again = await api.post(s2.url, '/api/carry', { date: '2026-09-09', requestId: 'a' });
    assert.equal(again.carried.length, 2, '相同 requestId 返回首次结果（幂等）');
    const d = await day(s2, '2026-09-09');
    assert.equal(d.plans.length, 2, '当天计划记录数应为 2，无重复');

    // 存储层唯一约束（绕过 API 直接写入仍应失败）
    const db = new DatabaseSync(path.join(dir, 'workday.db'));
    const p = db.prepare(`SELECT task_id, biz_date FROM daily_plans WHERE biz_date='2026-09-09' LIMIT 1`).get();
    assert.throws(() => {
      db.prepare(`INSERT INTO daily_plans (id, task_id, biz_date, sort_order, is_focus, source, start_progress, end_progress, state, version, created_at, updated_at)
        VALUES ('dup', ?, ?, 0, 0, 'carry', 0, 0, 'active', 1, '', '')`).run(p.task_id, p.biz_date);
    }, /UNIQUE|constraint/i);
    db.close();
  });

  test('已完成 / 已取消 / 延期未到期 / 移出今日 的任务遵守各自承接规则', async () => {
    const dir = dirOf('carry-rules');
    const s1 = await mk({ now: '2026-09-08T10:00:00+08:00', dataDir: dir });
    const normal = await newTask(s1, { title: '正常任务', bizDate: '2026-09-08' });
    const done = await newTask(s1, { title: '已完成', bizDate: '2026-09-08' });
    const cancel = await newTask(s1, { title: '已取消', bizDate: '2026-09-08' });
    const defer = await newTask(s1, { title: '延期到下周', bizDate: '2026-09-08' });
    const removed = await newTask(s1, { title: '移出今日', bizDate: '2026-09-08' });

    await api.post(s1.url, `/api/tasks/${done.id}/progress`, { progress: 100, status: 'done', bizDate: '2026-09-08', version: done.version });
    await api.patch(s1.url, `/api/tasks/${cancel.id}`, { status: 'cancelled', bizDate: '2026-09-08', version: cancel.version });
    await api.post(s1.url, `/api/tasks/${defer.id}/defer`, { date: '2026-09-15' });
    const d1 = await day(s1, '2026-09-08');
    const removedPlan = d1.plans.find((x) => x.task.id === removed.id);
    await api.patch(s1.url, `/api/plans/${removedPlan.plan.id}`, { state: 'removed', version: removedPlan.plan.version });
    await s1.stop();

    const s2 = await mk({ now: '2026-09-09T10:00:00+08:00', dataDir: dir, clean: false });
    const carry = await api.post(s2.url, '/api/carry', { date: '2026-09-09', requestId: 'x' });
    const ids = carry.carried.map((c) => c.taskId);
    assert.ok(ids.includes(normal.id), '未完成任务应被承接');
    assert.ok(!ids.includes(done.id), '已完成任务不应承接');
    assert.ok(!ids.includes(cancel.id), '已取消任务不应承接');
    assert.ok(!ids.includes(defer.id), '延期未到期任务不应承接');
    assert.ok(!ids.includes(removed.id), '移出今日的任务不应在次日被塞回');

    // 目标日期之前都不承接
    const s3 = await mk({ now: '2026-09-14T10:00:00+08:00', dataDir: dir, clean: false });
    const c14 = await api.post(s3.url, '/api/carry', { date: '2026-09-14', requestId: 'y' });
    assert.ok(!c14.carried.map((c) => c.taskId).includes(defer.id), '延期目标日之前仍不承接');
    await s3.stop();

    // 到期当天可承接
    const s4 = await mk({ now: '2026-09-15T10:00:00+08:00', dataDir: dir, clean: false });
    const c15 = await api.post(s4.url, '/api/carry', { date: '2026-09-15', requestId: 'z' });
    assert.ok(c15.carried.map((c) => c.taskId).includes(defer.id), '延期到期当天应可承接');
  });

  test('多日未使用（跨周末）仍可承接遗漏的未完成工作', async () => {
    const dir = dirOf('carry-weekend');
    const s1 = await mk({ now: '2026-09-04T10:00:00+08:00', dataDir: dir }); // 周五
    const t = await newTask(s1, { title: '跨周末任务', bizDate: '2026-09-04' });
    await api.post(s1.url, `/api/tasks/${t.id}/progress`, { progress: 35, bizDate: '2026-09-04', version: t.version });
    await s1.stop();

    const s2 = await mk({ now: '2026-09-07T10:00:00+08:00', dataDir: dir, clean: false }); // 周一
    const carry = await api.post(s2.url, '/api/carry', { date: '2026-09-07', requestId: 'w' });
    assert.equal(carry.carried.length, 1);
    assert.equal(carry.carried[0].carriedFrom, '2026-09-04');
    assert.equal(carry.carried[0].progress, 35);
  });

  test('今日已有预先安排的同任务，继承不会重复添加', async () => {
    const dir = dirOf('carry-prearranged');
    const s1 = await mk({ now: '2026-09-08T10:00:00+08:00', dataDir: dir });
    const t = await newTask(s1, { title: '提前安排的任务', bizDate: '2026-09-08' });
    await api.post(s1.url, '/api/days/2026-09-09/plans', { taskId: t.id, source: 'manual' });
    await s1.stop();

    const s2 = await mk({ now: '2026-09-09T10:00:00+08:00', dataDir: dir, clean: false });
    const carry = await api.post(s2.url, '/api/carry', { date: '2026-09-09', requestId: 'p' });
    assert.equal(carry.carried.length, 0, '已预先安排的任务不应重复继承');
    const d = await day(s2, '2026-09-09');
    assert.equal(d.plans.length, 1);
    assert.equal(d.plans[0].plan.source, 'manual');
  });

  test('连续顺延且无推进会累计次数，达到阈值时提示', async () => {
    const dir = dirOf('carry-streak');
    const s1 = await mk({ now: '2026-09-07T10:00:00+08:00', dataDir: dir });
    await newTask(s1, { title: '一直没推进的任务', bizDate: '2026-09-07' });
    await s1.stop();

    let prev = s1;
    const streaks = [];
    for (const d of ['2026-09-08', '2026-09-09', '2026-09-10']) {
      const s = await mk({ now: `${d}T10:00:00+08:00`, dataDir: dir, clean: false });
      const c = await api.post(s.url, '/api/carry', { date: d, requestId: `s-${d}` });
      streaks.push(c.carried[0] ? c.carried[0].streak : null);
      prev = s;
    }
    assert.deepEqual(streaks, [1, 2, 3], '顺延次数应逐日累加');
    const d = await day(prev, '2026-09-10');
    assert.equal(d.plans[0].task.deferStreak, 3);
    assert.equal(d.deferredStreak.length, 1, '达到阈值后应进入顺延提示');
  });
});

/* ============================================================
 * 2. 历史浏览与修正
 * ========================================================== */
describe('历史记录与快照修正', () => {
  test('浏览历史日期不会触发继承；修正历史快照不影响任务当前进度', async () => {
    const dir = dirOf('history');
    const s1 = await mk({ now: '2026-09-08T10:00:00+08:00', dataDir: dir });
    const t = await newTask(s1, { title: '历史任务', bizDate: '2026-09-08' });
    await api.post(s1.url, `/api/tasks/${t.id}/progress`, { progress: 60, bizDate: '2026-09-08', version: t.version });
    await s1.stop();

    const s2 = await mk({ now: '2026-09-10T10:00:00+08:00', dataDir: dir, clean: false });

    // 浏览历史日期（GET）不应产生今日计划，也不应触发继承
    const hBrowse = await day(s2, '2026-09-08');
    assert.equal(hBrowse.isHistory, true);
    const today = await day(s2, '2026-09-10');
    assert.equal(today.plans.length, 0, '仅浏览历史不应触发向今天继承');

    // 显式在今天推进（会为今天补建当日计划，起点为任务当时的 60%）
    const pushed = await api.post(s2.url, `/api/tasks/${t.id}/progress`, { progress: 90, bizDate: '2026-09-10', version: 2 });
    assert.equal(pushed.plan.startProgress, 60, '当天开始进度应为 60%');
    assert.equal(pushed.plan.endProgress, 90, '当天日末进度应为 90%');

    const h = await day(s2, '2026-09-08');

    // 修正历史快照
    const planId = h.plans[0].plan.id;
    const fixed = await api.post(s2.url, `/api/plans/${planId}/snapshot`, {
      startProgress: 40, endProgress: 70, note: '当天实际完成到 70%',
    });
    assert.equal(fixed.plan.endProgress, 70);
    const after = await day(s2, '2026-09-08');
    assert.equal(after.plans[0].plan.endProgress, 70, '历史快照已修正');
    assert.equal(after.plans[0].task.progress, 90, '任务当前进度不应被历史修正改写');

    const logs = await api.get(s2.url, `/api/tasks/${t.id}/logs`);
    assert.ok(logs.corrections.length >= 1, '应留下修正记录');
  });
});

/* ============================================================
 * 3. 成果与周回顾
 * ========================================================== */
describe('成果与周回顾', () => {
  test('临时事项可记录成果并计入周回顾；成果按发生日期统计', async () => {
    const s = await mk({ now: '2026-09-09T10:00:00+08:00', dataDir: dirOf('week') });
    const adhoc = await newTask(s, { title: '临时：处理线上告警', bizDate: '2026-09-09', isAdhoc: true });
    await api.post(s.url, '/api/achievements', { taskId: adhoc.id, bizDate: '2026-09-09', content: '定位到缓存配置问题' });
    await api.post(s.url, '/api/achievements', { taskId: null, bizDate: '2026-09-09', content: '协助新同事配置环境' });

    const r = await api.get(s.url, '/api/weeks/2026-09-09');
    assert.equal(r.stats.achievementCount, 2, '本周成果应为 2 条');
    assert.equal(r.achievementsByDay['2026-09-09'].length, 2);
    assert.equal(r.adhocTasks.length, 1, '临时事项应纳入计划外工作');
    assert.equal(r.standaloneAchievements.length, 1, '独立成果应纳入计划外工作');
    assert.equal(r.stats.adhocCount, 2);

    // 早于本周的成果不应被计入本周
    await api.post(s.url, '/api/achievements', { taskId: adhoc.id, bizDate: '2026-08-31', content: '上周的成果' });
    const r2 = await api.get(s.url, '/api/weeks/2026-09-09');
    assert.equal(r2.stats.achievementCount, 2, '历史成果不应重复计入本周');

    const md = await api.get(s.url, '/api/weeks/2026-09-09/markdown');
    assert.ok(md.markdown.includes('周回顾 2026-09-07 ~ 2026-09-13'));
    assert.ok(md.markdown.includes('临时：处理线上告警'));
  });
});

/* ============================================================
 * 4. 持久化、并发与失败处理
 * ========================================================== */
describe('持久化与一致性', () => {
  test('重启后数据与附件仍可读取', async () => {
    const dir = dirOf('persist');
    const s1 = await mk({ now: '2026-09-10T10:00:00+08:00', dataDir: dir });
    const t = await newTask(s1, { title: '带附件的任务', bizDate: '2026-09-10' });
    const form = new FormData();
    form.append('ownerType', 'task');
    form.append('ownerId', t.id);
    form.append('file', new Blob([Buffer.from('附件内容-123')], { type: 'text/plain' }), 'note.txt');
    const up = await (await fetch(`${s1.url}/api/attachments`, { method: 'POST', body: form })).json();
    assert.ok(up.attachment.id);
    await s1.stop();

    const s2 = await mk({ now: '2026-09-10T11:00:00+08:00', dataDir: dir, clean: false });
    const d = await day(s2, '2026-09-10');
    assert.equal(d.plans.length, 1);
    assert.equal(d.plans[0].attachments.length, 1);
    const res = await fetch(`${s2.url}/api/attachments/${up.attachment.id}/file`);
    assert.equal(await res.text(), '附件内容-123', '重启后附件内容应完整可读');
  });

  test('并发编辑：旧版本提交会被拒绝，不静默覆盖新数据', async () => {
    const s = await mk({ now: '2026-09-10T10:00:00+08:00', dataDir: dirOf('conflict') });
    const t = await newTask(s, { title: '原标题', bizDate: '2026-09-10' });
    const a = await api.patch(s.url, `/api/tasks/${t.id}`, { title: 'A 的修改', version: 1 });
    assert.equal(a.task.title, 'A 的修改');

    let err = null;
    try {
      await api.patch(s.url, `/api/tasks/${t.id}`, { title: 'B 的修改', version: 1 });
    } catch (e) { err = e; }
    assert.ok(err, '基于旧版本的提交应失败');
    assert.equal(err.status, 409);
    assert.ok(err.payload.current, '冲突响应应带回服务端当前内容');

    const after = await api.get(s.url, `/api/tasks/${t.id}`);
    assert.equal(after.title, 'A 的修改', '旧数据不应静默覆盖新数据');
  });

  test('已完成任务的重新打开规则：必须选择未完成状态且进度小于 100%', async () => {
    const s = await mk({ now: '2026-09-10T10:00:00+08:00', dataDir: dirOf('reopen') });
    const t = await newTask(s, { title: '待完成任务', bizDate: '2026-09-10' });
    const r = await api.post(s.url, `/api/tasks/${t.id}/progress`, { progress: 100, status: 'done', bizDate: '2026-09-10', version: 1 });
    assert.equal(r.task.status, 'done');
    assert.equal(r.task.progress, 100);

    await assert.rejects(
      () => api.post(s.url, `/api/tasks/${t.id}/progress`, { progress: 100, status: 'in_progress', bizDate: '2026-09-10', version: r.task.version }),
      /小于 100%/,
      '重新打开时进度为 100% 应被拒绝',
    );

    const ok = await api.post(s.url, `/api/tasks/${t.id}/progress`, { progress: 70, status: 'in_progress', bizDate: '2026-09-10', version: r.task.version });
    assert.equal(ok.task.status, 'in_progress');
    assert.equal(ok.task.progress, 70);

    // 进度设为 100% 时自动同步为已完成
    const auto = await api.post(s.url, `/api/tasks/${t.id}/progress`, { progress: 100, bizDate: '2026-09-10', version: ok.task.version });
    assert.equal(auto.task.status, 'done');
  });
});

/* ============================================================
 * 5. 备份与恢复
 * ========================================================== */
describe('备份与恢复', () => {
  test('完整导出后在干净环境恢复：任务、计划、成果、阻碍与附件一致', async () => {
    const dirA = dirOf('backup-a');
    const dirB = dirOf('backup-b');
    const s1 = await mk({ now: '2026-09-08T10:00:00+08:00', dataDir: dirA });
    const t = await newTask(s1, { title: '备份任务', bizDate: '2026-09-08', project: '项目 X' });
    await api.post(s1.url, `/api/tasks/${t.id}/progress`, { progress: 45, bizDate: '2026-09-08', version: t.version });
    await api.post(s1.url, '/api/achievements', { taskId: t.id, bizDate: '2026-09-08', content: '完成初稿' });
    await api.post(s1.url, '/api/blockers', { taskId: t.id, reason: '等法务反馈', needWho: '李工' });

    const form = new FormData();
    form.append('ownerType', 'task');
    form.append('ownerId', t.id);
    form.append('file', new Blob([Buffer.from('binary-attachment')], { type: 'text/plain' }), 'a.txt');
    const up = await (await fetch(`${s1.url}/api/attachments`, { method: 'POST', body: form })).json();

    const zipRes = await fetch(`${s1.url}/api/backup/export`);
    const zip = Buffer.from(await zipRes.arrayBuffer());
    assert.ok(zip.length > 100, '应导出 zip 备份');
    const dayA = await day(s1, '2026-09-08');

    const s2 = await mk({ now: '2026-09-08T10:00:00+08:00', dataDir: dirB });
    const fd = new FormData();
    fd.append('file', new Blob([zip], { type: 'application/zip' }), 'backup.zip');
    fd.append('mode', 'merge');
    fd.append('confirm', 'true');
    const imp = await (await fetch(`${s2.url}/api/backup/import`, { method: 'POST', body: fd })).json();
    assert.equal(imp.ok, true);
    assert.equal(imp.report.inserted.tasks, 1);
    assert.equal(imp.report.restoredAttachmentFiles, 1, '附件文件应随备份恢复');

    const dayB = await day(s2, '2026-09-08');
    assert.equal(dayB.plans.length, dayA.plans.length);
    assert.equal(dayB.plans[0].task.title, '备份任务');
    assert.equal(dayB.plans[0].task.progress, 45);
    assert.equal(dayB.plans[0].achievements[0].content, '完成初稿');
    assert.equal(dayB.plans[0].blockers[0].reason, '等法务反馈');
    const fileRes = await fetch(`${s2.url}/api/attachments/${up.attachment.id}/file`);
    assert.equal(await fileRes.text(), 'binary-attachment', '恢复后附件内容应一致');
  });

  test('非法备份导入失败时，原有数据保持完好', async () => {
    const s = await mk({ now: '2026-09-10T10:00:00+08:00', dataDir: dirOf('badbackup') });
    await newTask(s, { title: '原有任务', bizDate: '2026-09-10' });

    const bad = async (name, blob) => {
      const fd = new FormData();
      fd.append('file', blob, name);
      fd.append('mode', 'merge');
      const res = await fetch(`${s.url}/api/backup/import`, { method: 'POST', body: fd });
      return res;
    };

    let r = await bad('x.zip', new Blob([Buffer.from('not a zip at all')], { type: 'application/zip' }));
    assert.equal(r.status, 400, '非法 zip 应被拒绝');

    // 合法 zip 但结构不合法的备份
    const badZip = buildZip([{
      name: 'backup.json',
      data: Buffer.from(JSON.stringify({ app: 'workday', schemaVersion: 1, entities: { tasks: 'oops' } })),
      compress: true,
    }]);
    r = await bad('y.zip', new Blob([badZip], { type: 'application/zip' }));
    assert.equal(r.status, 400, '结构不合法的备份应被拒绝');

    // 版本高于当前应用的备份
    const futureZip = buildZip([{
      name: 'backup.json',
      data: Buffer.from(JSON.stringify({ app: 'workday', schemaVersion: 99, entities: {} })),
      compress: true,
    }]);
    r = await bad('z.zip', new Blob([futureZip], { type: 'application/zip' }));
    assert.equal(r.status, 400, '版本过高的备份应被拒绝');

    const d = await day(s, '2026-09-10');
    assert.equal(d.plans.length, 1, '导入失败后原有数据应完好');
    assert.equal(d.plans[0].task.title, '原有任务');
  });
});

/* ============================================================
 * 6. 日期、时区与迁移
 * ========================================================== */
describe('日期、时区与迁移', () => {
  test('业务日期按用户时区计算，不受 UTC 日期影响', async () => {
    const s = await mk({ now: '2026-09-10T00:30:00Z', dataDir: dirOf('tz') });
    let h = await api.get(s.url, '/api/health');
    const tzDefault = h.timezone;
    await api.put(s.url, '/api/settings', { timezone: 'Asia/Shanghai' });
    h = await api.get(s.url, '/api/health');
    assert.equal(h.today, '2026-09-10', 'UTC+8 应为 09-10');

    await api.put(s.url, '/api/settings', { timezone: 'America/New_York' });
    h = await api.get(s.url, '/api/health');
    assert.equal(h.today, '2026-09-09', 'UTC-4 同一时刻应为 09-09');
    void tzDefault;
  });

  test('修改时区不会重新分配已有每日记录的业务日期', async () => {
    const s = await mk({ now: '2026-09-10T10:00:00+08:00', dataDir: dirOf('tz2') });
    await newTask(s, { title: '时区测试', bizDate: '2026-09-10' });
    await api.put(s.url, '/api/settings', { timezone: 'America/New_York' });
    const d = await api.get(s.url, '/api/days/2026-09-10');
    assert.equal(d.plans.length, 1, '已有记录的业务日期不应被重新分配');
  });

  test('数据库迁移机制：重启后 schemaVersion 稳定，已有记录保留', async () => {
    const dir = dirOf('migrate');
    const s1 = await mk({ now: '2026-09-10T10:00:00+08:00', dataDir: dir });
    await newTask(s1, { title: '迁移前任务', bizDate: '2026-09-10' });
    await s1.stop();

    const db = new DatabaseSync(path.join(dir, 'workday.db'));
    const v = db.prepare(`SELECT value FROM meta WHERE key='schemaVersion'`).get();
    assert.equal(Number(v.value) >= 1, true, '应记录 schemaVersion');
    db.close();

    const s2 = await mk({ now: '2026-09-10T10:00:00+08:00', dataDir: dir, clean: false });
    const d = await day(s2, '2026-09-10');
    assert.equal(d.plans.length, 1, '迁移/重启后记录应保留');
    const s3 = await mk({ now: '2026-09-10T10:00:00+08:00', dataDir: dir, clean: false });
    const d3 = await day(s3, '2026-09-10');
    assert.equal(d3.plans.length, 1, '重复打开不应清空数据');
  });
});

/* ============================================================
 * 7. 回收站与删除语义
 * ========================================================== */
describe('删除与回收站', () => {
  test('删除进入回收站可恢复；移出今日与删除互不影响', async () => {
    const s = await mk({ now: '2026-09-10T10:00:00+08:00', dataDir: dirOf('trash') });
    const t = await newTask(s, { title: '待删除任务', bizDate: '2026-09-10' });
    await api.post(s.url, '/api/achievements', { taskId: t.id, bizDate: '2026-09-10', content: '已有成果' });

    await api.del(s.url, `/api/tasks/${t.id}`);
    let d = await day(s, '2026-09-10');
    assert.equal(d.plans.length, 0, '删除后不应出现在当日计划');

    const trash = await api.get(s.url, '/api/trash');
    assert.equal(trash.tasks.length, 1);

    const restored = await api.post(s.url, `/api/tasks/${t.id}/restore`, {});
    assert.equal(restored.task.deletedAt, null);

    // 移出今日：任务仍在，但当日计划消失
    let d2 = await day(s, '2026-09-10');
    assert.equal(d2.plans.length, 1);
    await api.patch(s.url, `/api/plans/${d2.plans[0].plan.id}`, { state: 'removed', version: d2.plans[0].plan.version });
    d2 = await day(s, '2026-09-10');
    assert.equal(d2.plans.length, 0, '移出今日后当日计划为空');
    const list = await api.get(s.url, '/api/tasks?scope=unscheduled');
    assert.equal(list.tasks.length, 1, '移出后应出现在待安排任务');
    const still = await api.get(s.url, `/api/tasks/${t.id}`);
    assert.equal(still.deletedAt, null, '移出今日不等于删除任务');
  });
});

before(() => { fs.mkdirSync(tmpRoot, { recursive: true }); });
