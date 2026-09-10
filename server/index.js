import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { handleApi } from './api.js';
import { todayInTz, safeJoin, mimeOf, ensureDir, systemTimezone } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.WORKDAY_DATA_DIR
  ? path.resolve(process.env.WORKDAY_DATA_DIR)
  : path.join(ROOT, 'data');
const DB_PATH = process.env.WORKDAY_DB
  ? path.resolve(process.env.WORKDAY_DB)
  : path.join(DATA_DIR, 'workday.db');

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(ROOT, 'public');

ensureDir(DATA_DIR);
ensureDir(ATTACHMENTS_DIR);
ensureDir(BACKUPS_DIR);

const db = openDatabase(DB_PATH);

const ctx = {
  db,
  dbPath: DB_PATH,
  dataDir: DATA_DIR,
  attachmentsDir: ATTACHMENTS_DIR,
  backupsDir: BACKUPS_DIR,
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const file = safeJoin(PUBLIC_DIR, rel);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback
    const fallback = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(fallback)) {
      res.writeHead(200, { 'content-type': mimeOf('.html') });
      res.end(fs.readFileSync(fallback));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('未找到资源');
    return;
  }
  const stat = fs.statSync(file);
  const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': mimeOf(file),
    'content-length': stat.size,
    etag,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('x-content-type-options', 'nosniff');
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, ctx, url);
    return;
  }
  serveStatic(req, res, url.pathname);
});

// 端口被占用等启动失败要给人类能看懂的提示，而不是抛调用栈
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  端口 ${PORT} 已被占用，服务无法启动。`);
    console.error('  换个端口重试（示例）：');
    console.error(`    Windows:  set PORT=5174  && "${process.execPath}" "${path.join(ROOT, 'server', 'index.js')}"`);
    console.error(`    macOS/Linux:  PORT=5174 "${process.execPath}" ${path.join(ROOT, 'server', 'index.js')}`);
    console.error('  或先关闭占用该端口的程序。');
    console.error('');
    process.exit(1);
  }
  console.error('服务启动失败：', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const tz = process.env.TZ || systemTimezone();
  console.log('');
  console.log('  工作日程 · 个人工作日程管理');
  console.log(`  地址:      http://${HOST}:${PORT}`);
  console.log(`  数据库:    ${DB_PATH}`);
  console.log(`  附件目录:  ${ATTACHMENTS_DIR}`);
  console.log(`  备份目录:  ${BACKUPS_DIR}`);
  console.log(`  时区:      ${tz}（今天 ${todayInTz(tz)}）`);
  console.log('');
});

function shutdown(sig) {
  console.log(`\n收到 ${sig}，正在关闭...`);
  try { server.closeAllConnections(); } catch { /* ignore */ }
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { server, db, ctx };
