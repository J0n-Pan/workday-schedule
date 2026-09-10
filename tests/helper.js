import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const NODE = process.execPath;

let portSeq = 5300 + Math.floor(Math.random() * 300);
export const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** 仅在明确需要时删除；测试默认使用本次运行独有的目录，避免清理操作 */
export async function rmrf(p) {
  if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

/**
 * 启动一个独立服务实例（独立数据目录 + 可固定的"现在"）
 */
export async function startServer({ now, dataDir, timezone, clean = true } = {}) {
  const port = portSeq++;
  const dir = dataDir || path.join(ROOT, 'tests', '.tmp', `${RUN_ID}-d${port}`);
  void clean;
  fs.mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    WORKDAY_DATA_DIR: dir,
  };
  if (now) env.WORKDAY_NOW = now;
  if (timezone) env.TZ = timezone;
  delete env.WORKDAY_DB;

  const child = spawn(NODE, [path.join(ROOT, 'server', 'index.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) {
        return {
          url,
          dir,
          port,
          // 进程可能已自行退出（例如走了「停止服务」接口），此时直接返回，避免等不到 exit 事件
          stop: () => new Promise((res) => {
            if (child.exitCode !== null || child.signalCode) { res(); return; }
            child.on('exit', res);
            child.kill('SIGTERM');
          }),
          child,
        };
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  child.kill('SIGKILL');
  throw new Error(`服务启动失败：\n${out}`);
}

export const api = {
  async get(url, p) { const r = await fetch(url + p); return handle(r); },
  async post(url, p, body) {
    const r = await fetch(url + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    return handle(r);
  },
  async patch(url, p, body) {
    const r = await fetch(url + p, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    return handle(r);
  },
  async del(url, p, body) {
    const r = await fetch(url + p, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    return handle(r);
  },
  async put(url, p, body) {
    const r = await fetch(url + p, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    return handle(r);
  },
  async raw(url, p) { return fetch(url + p); },
};

async function handle(r) {
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const err = new Error((data && data.message) || `HTTP ${r.status}`);
    err.status = r.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

export function eq(a, b, msg) {
  if (a !== b) throw new Error(`断言失败：${msg}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`);
}
