import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, nowISO, systemTimezone } from './util.js';

/* 有版本的迁移机制：每次迁移记录到 meta 表，保留已有记录 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'init',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          project TEXT NOT NULL DEFAULT '',
          priority TEXT NOT NULL DEFAULT 'medium',
          status TEXT NOT NULL DEFAULT 'not_started',
          progress INTEGER NOT NULL DEFAULT 0,
          due_date TEXT,
          next_action TEXT NOT NULL DEFAULT '',
          deferred_until TEXT,
          unscheduled INTEGER NOT NULL DEFAULT 0,
          is_adhoc INTEGER NOT NULL DEFAULT 0,
          defer_streak INTEGER NOT NULL DEFAULT 0,
          last_carry_date TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX idx_tasks_status ON tasks(status);
        CREATE INDEX idx_tasks_deleted ON tasks(deleted_at);

        CREATE TABLE daily_plans (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          biz_date TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_focus INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'manual',
          carried_from TEXT,
          start_progress INTEGER NOT NULL DEFAULT 0,
          end_progress INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'active',
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (task_id, biz_date)
        );
        CREATE INDEX idx_plans_date ON daily_plans(biz_date);
        CREATE INDEX idx_plans_task ON daily_plans(task_id);

        CREATE TABLE progress_logs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          biz_date TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'update',
          from_progress INTEGER NOT NULL,
          to_progress INTEGER NOT NULL,
          from_status TEXT NOT NULL,
          to_status TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_plogs_task ON progress_logs(task_id);
        CREATE INDEX idx_plogs_date ON progress_logs(biz_date);

        CREATE TABLE achievements (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          biz_date TEXT NOT NULL,
          content TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX idx_ach_date ON achievements(biz_date);
        CREATE INDEX idx_ach_task ON achievements(task_id);

        CREATE TABLE attachments (
          id TEXT PRIMARY KEY,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          name TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          mime TEXT NOT NULL DEFAULT '',
          stored_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_att_owner ON attachments(owner_type, owner_id);

        CREATE TABLE blockers (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          need_who TEXT NOT NULL DEFAULT '',
          need_what TEXT NOT NULL DEFAULT '',
          follow_up_date TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          resolved_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_blockers_task ON blockers(task_id);
        CREATE INDEX idx_blockers_follow ON blockers(follow_up_date);

        CREATE TABLE audit_logs (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

        CREATE TABLE idempotency (
          key TEXT PRIMARY KEY,
          response TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
];

const DEFAULT_SETTINGS = {
  timezone: systemTimezone(),
  theme: 'light',
  focusLimit: '3',
  deferStreakThreshold: '3',
  browserNotify: 'off',
};

export function openDatabase(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schemaVersion'`).get();
  const current = row ? Number(row.value) : 0;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      const tx = db.prepare('BEGIN');
      try {
        db.exec('BEGIN');
        m.up(db);
        setMeta(db, 'schemaVersion', String(m.version));
        setMeta(db, `migration_${m.version}_name`, m.name);
        setMeta(db, `migration_${m.version}_at`, nowISO());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      void tx;
    }
  }
  // 默认设置
  const ins = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
}

export function getMeta(db, key) {
  const r = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
  return r ? r.value : null;
}

export function setMeta(db, key, value) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function getSettings(db) {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

export const LATEST_SCHEMA = SCHEMA_VERSION;
