import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION } from './util.js';
import {
  id, nowISO, buildZip, readZip, badRequest, safeFileName,
} from './util.js';

const ENTITIES = [
  'settings', 'tasks', 'dailyPlans', 'progressLogs', 'achievements',
  'attachments', 'blockers', 'auditLogs',
];

export function exportPayload(db) {
  const data = {
    schemaVersion: SCHEMA_VERSION,
    app: 'workday',
    exportedAt: nowISO(),
    entities: {
      settings: db.prepare(`SELECT * FROM settings`).all().map((r) => ({ ...r })),
      tasks: db.prepare(`SELECT * FROM tasks`).all().map((r) => ({ ...r })),
      dailyPlans: db.prepare(`SELECT * FROM daily_plans`).all().map((r) => ({ ...r })),
      progressLogs: db.prepare(`SELECT * FROM progress_logs`).all().map((r) => ({ ...r })),
      achievements: db.prepare(`SELECT * FROM achievements`).all().map((r) => ({ ...r })),
      attachments: db.prepare(`SELECT * FROM attachments`).all().map((r) => ({ ...r })),
      blockers: db.prepare(`SELECT * FROM blockers`).all().map((r) => ({ ...r })),
      auditLogs: db.prepare(`SELECT * FROM audit_logs`).all().map((r) => ({ ...r })),
    },
  };
  return data;
}

export function buildBackupZip(db, attachmentsDir) {
  const payload = exportPayload(db);
  const entries = [
    { name: 'backup.json', data: Buffer.from(JSON.stringify(payload), 'utf8'), compress: true },
  ];
  const missing = [];
  for (const a of payload.entities.attachments) {
    const p = path.join(attachmentsDir, a.stored_name);
    if (fs.existsSync(p)) {
      entries.push({ name: `attachments/${a.stored_name}`, data: fs.readFileSync(p) });
    } else {
      missing.push(a.name);
    }
  }
  entries.push({
    name: 'manifest.txt',
    data: Buffer.from([
      `workday 备份`,
      `schemaVersion: ${payload.schemaVersion}`,
      `exportedAt: ${payload.exportedAt}`,
      `tasks: ${payload.entities.tasks.length}`,
      `dailyPlans: ${payload.entities.dailyPlans.length}`,
      `achievements: ${payload.entities.achievements.length}`,
      `blockers: ${payload.entities.blockers.length}`,
      `attachments: ${payload.entities.attachments.length}`,
      missing.length ? `缺失附件文件: ${missing.join(', ')}` : '附件文件: 完整',
    ].join('\n'), 'utf8'),
    compress: true,
  });
  return { buf: buildZip(entries), payload, missing };
}

/** 解析并校验备份，不做任何写入 */
export function parseBackup(buf) {
  let entries;
  try {
    entries = readZip(buf);
  } catch (e) {
    if (e && e.code === 'bad_request') throw e;
    throw badRequest(`备份文件无法解析：${e.message}`);
  }
  const jsonEntry = entries.find((e) => e.name === 'backup.json');
  if (!jsonEntry) throw badRequest('备份中缺少 backup.json，不是有效的完整备份');

  let payload;
  try {
    payload = JSON.parse(jsonEntry.data.toString('utf8'));
  } catch {
    throw badRequest('backup.json 不是合法 JSON');
  }
  if (payload.app && payload.app !== 'workday') throw badRequest('该备份不属于本应用');
  if (!payload.entities || typeof payload.entities !== 'object') throw badRequest('备份缺少 entities 数据');
  if (Number(payload.schemaVersion) > SCHEMA_VERSION) {
    throw badRequest(`备份版本 ${payload.schemaVersion} 高于当前应用支持的版本 ${SCHEMA_VERSION}，请先升级应用`);
  }
  if (Number(payload.schemaVersion) < 1) throw badRequest('备份版本号非法');

  const errors = [];
  for (const k of ENTITIES) {
    if (!Array.isArray(payload.entities[k])) errors.push(`缺少数组字段 entities.${k}`);
  }
  if (errors.length) throw badRequest(`备份结构不完整：${errors.join('；')}`);

  // 关联完整性校验
  const taskIds = new Set(payload.entities.tasks.map((t) => t.id));
  const planIds = new Set(payload.entities.dailyPlans.map((p) => p.id));
  const warnings = [];
  const orphanPlans = payload.entities.dailyPlans.filter((p) => !taskIds.has(p.task_id));
  if (orphanPlans.length) {
    warnings.push(`${orphanPlans.length} 条每日计划缺少对应任务，导入时将被跳过`);
  }
  const orphanAch = payload.entities.achievements.filter((a) => a.task_id && !taskIds.has(a.task_id));
  if (orphanAch.length) {
    warnings.push(`${orphanAch.length} 条成果关联的任务不存在，将转为独立成果导入`);
  }
  const orphanBlockers = payload.entities.blockers.filter((b) => !taskIds.has(b.task_id));
  if (orphanBlockers.length) warnings.push(`${orphanBlockers.length} 条阻碍记录缺少对应任务，将被跳过`);

  const files = new Map();
  for (const e of entries) {
    if (e.name.startsWith('attachments/')) files.set(e.name.slice('attachments/'.length), e.data);
  }
  const missingFiles = payload.entities.attachments.filter((a) => !files.has(a.stored_name)).map((a) => a.name);

  // (task_id, biz_date) 重复检查
  const seen = new Set();
  const dupPlans = [];
  for (const p of payload.entities.dailyPlans) {
    const k = `${p.task_id}|${p.biz_date}`;
    if (seen.has(k)) dupPlans.push(k);
    seen.add(k);
  }
  if (dupPlans.length) warnings.push(`备份内存在 ${dupPlans.length} 条重复的"任务+日期"计划，导入时只保留一条`);

  return {
    payload, files, warnings, taskIds, planIds,
    summary: {
      schemaVersion: Number(payload.schemaVersion),
      exportedAt: payload.exportedAt,
      tasks: payload.entities.tasks.length,
      dailyPlans: payload.entities.dailyPlans.length,
      progressLogs: payload.entities.progressLogs.length,
      achievements: payload.entities.achievements.length,
      blockers: payload.entities.blockers.length,
      attachments: payload.entities.attachments.length,
      attachmentFiles: files.size,
      missingAttachmentFiles: missingFiles,
      auditLogs: payload.entities.auditLogs.length,
    },
  };
}

function insertRow(db, table, row, cols) {
  const keys = cols;
  const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  db.prepare(sql).run(...keys.map((k) => row[k] ?? null));
}

const COLS = {
  tasks: ['id', 'title', 'description', 'project', 'priority', 'status', 'progress', 'due_date',
    'next_action', 'deferred_until', 'unscheduled', 'is_adhoc', 'defer_streak', 'last_carry_date',
    'version', 'created_at', 'updated_at', 'deleted_at'],
  daily_plans: ['id', 'task_id', 'biz_date', 'sort_order', 'is_focus', 'source', 'carried_from',
    'start_progress', 'end_progress', 'state', 'version', 'created_at', 'updated_at'],
  progress_logs: ['id', 'task_id', 'biz_date', 'kind', 'from_progress', 'to_progress', 'from_status', 'to_status', 'note', 'created_at'],
  achievements: ['id', 'task_id', 'biz_date', 'content', 'version', 'created_at', 'updated_at', 'deleted_at'],
  attachments: ['id', 'owner_type', 'owner_id', 'name', 'size', 'mime', 'stored_name', 'created_at'],
  blockers: ['id', 'task_id', 'reason', 'need_who', 'need_what', 'follow_up_date', 'status', 'resolved_at', 'created_at', 'updated_at'],
  audit_logs: ['id', 'entity_type', 'entity_id', 'action', 'detail', 'created_at'],
  settings: ['key', 'value'],
};

export function applyImport(db, parsed, { mode, attachmentsDir, backupsDir }) {
  const { payload, files } = parsed;
  const report = { mode, inserted: {}, conflicts: [], skipped: {}, restoredAttachmentFiles: 0, preRestoreBackup: null };

  if (mode === 'overwrite') {
    // 覆盖恢复前保留可恢复备份
    const { buf } = buildBackupZip(db, attachmentsDir);
    fs.mkdirSync(backupsDir, { recursive: true });
    const name = `pre-restore-${nowISO().replace(/[:.]/g, '-')}.zip`;
    fs.writeFileSync(path.join(backupsDir, name), buf);
    report.preRestoreBackup = name;
  }

  db.exec('BEGIN');
  try {
    if (mode === 'overwrite') {
      for (const t of ['progress_logs', 'daily_plans', 'blockers', 'attachments', 'achievements', 'audit_logs', 'tasks']) {
        db.exec(`DELETE FROM ${t}`);
      }
    }

    const count = (k) => (report.inserted[k] = 0);
    Object.keys(report.inserted).forEach(() => {});
    for (const k of ['tasks', 'dailyPlans', 'progressLogs', 'achievements', 'blockers', 'attachments', 'auditLogs', 'settings']) count(k);

    const exists = (table, rid) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(rid);

    const doEntity = (key, table, rows, { normalize } = {}) => {
      for (const raw of rows) {
        let row = raw;
        if (normalize) {
          const n = normalize(row);
          if (!n) { report.skipped[key] = (report.skipped[key] || 0) + 1; continue; }
          row = n;
        }
        const already = exists(table, row.id);
        if (already) {
          if (mode === 'overwrite') {
            insertRow(db, table, row, COLS[table]);
            report.inserted[key]++;
          } else {
            const cur = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id);
            const curTs = String(cur.updated_at || cur.created_at || '');
            const newTs = String(row.updated_at || row.created_at || '');
            if (newTs > curTs) {
              insertRow(db, table, row, COLS[table]);
              report.conflicts.push({ entity: key, id: row.id, action: 'updated', reason: '备份中的记录更新' });
              report.inserted[key]++;
            } else {
              report.conflicts.push({ entity: key, id: row.id, action: 'kept_existing', reason: '本地记录更新或同样新，已保留本地' });
            }
          }
        } else {
          insertRow(db, table, row, COLS[table]);
          report.inserted[key]++;
        }
      }
    };

    const taskIds = new Set(payload.entities.tasks.map((t) => t.id));

    doEntity('tasks', 'tasks', payload.entities.tasks);
    doEntity('dailyPlans', 'daily_plans', payload.entities.dailyPlans, {
      normalize: (r) => (taskIds.has(r.task_id) ? r : null),
    });
    doEntity('progressLogs', 'progress_logs', payload.entities.progressLogs, {
      normalize: (r) => (taskIds.has(r.task_id) ? r : null),
    });
    doEntity('achievements', 'achievements', payload.entities.achievements, {
      normalize: (r) => (r.task_id && !taskIds.has(r.task_id) ? { ...r, task_id: null } : r),
    });
    doEntity('blockers', 'blockers', payload.entities.blockers, {
      normalize: (r) => (taskIds.has(r.task_id) ? r : null),
    });
    doEntity('attachments', 'attachments', payload.entities.attachments);
    doEntity('auditLogs', 'audit_logs', payload.entities.auditLogs);

    if (mode === 'overwrite') {
      for (const s of payload.entities.settings) {
        db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)`).run(s.key, s.value);
        report.inserted.settings++;
      }
    } else {
      for (const s of payload.entities.settings) {
        const cur = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(s.key);
        if (!cur) {
          db.prepare(`INSERT INTO settings (key, value) VALUES (?,?)`).run(s.key, s.value);
          report.inserted.settings++;
        }
      }
    }

    // 导入审计
    db.prepare(`INSERT INTO audit_logs (id, entity_type, entity_id, action, detail, created_at) VALUES (?,?,?,?,?,?)`)
      .run(id(), 'backup', '-', mode === 'overwrite' ? 'restore_overwrite' : 'import_merge',
        JSON.stringify({ exportedAt: payload.exportedAt, report }), nowISO());

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }

  // 附件文件（事务外写盘）
  fs.mkdirSync(attachmentsDir, { recursive: true });
  for (const a of payload.entities.attachments) {
    const data = files.get(a.stored_name);
    if (!data) continue;
    const target = path.join(attachmentsDir, safeFileName(a.stored_name));
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, data);
      report.restoredAttachmentFiles++;
    }
  }
  return report;
}

export function clearAllData(db, { attachmentsDir }) {
  db.exec('BEGIN');
  try {
    for (const t of ['progress_logs', 'daily_plans', 'blockers', 'attachments', 'achievements', 'audit_logs', 'tasks', 'idempotency']) {
      db.exec(`DELETE FROM ${t}`);
    }
    db.prepare(`INSERT INTO audit_logs (id, entity_type, entity_id, action, detail, created_at) VALUES (?,?,?,?,?,?)`)
      .run(id(), 'data', '-', 'clear_all', '{}', nowISO());
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  if (fs.existsSync(attachmentsDir)) {
    for (const f of fs.readdirSync(attachmentsDir)) fs.rmSync(path.join(attachmentsDir, f), { force: true });
  }
}
