import crypto from 'node:crypto';
import zlib from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs';

export const SCHEMA_VERSION = 1;

/* ---------------- ids / time ---------------- */

export function id(prefix = '') {
  return prefix + crypto.randomUUID();
}

/**
 * 当前时间。设置环境变量 WORKDAY_NOW（ISO 字符串）可固定"现在"，
 * 仅用于自动化测试跨天/跨周末/时区场景，生产环境不会设置该变量。
 */
export function currentDate() {
  const v = process.env.WORKDAY_NOW;
  if (v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function nowISO() {
  return currentDate().toISOString();
}

/* ---------------- dates (business date vs timestamp) ---------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(v) {
  return typeof v === 'string' && DATE_RE.test(v);
}

/** 业务日期：按用户时区计算的 YYYY-MM-DD */
export function todayInTz(tz, at = currentDate()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(at);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(at);
    const get = (t) => p.find((x) => x.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
}

export function systemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
}

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fmtDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d, utc: new Date(Date.UTC(y, m - 1, d)) };
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayCn(s) {
  return WEEK_CN[parseDate(s).getUTCDay()];
}

/** 周一为一周起点 */
export function mondayOf(s) {
  const dow = parseDate(s).getUTCDay(); // 0=Sun
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(s, -back);
}

export function weekRange(s) {
  const start = mondayOf(s);
  return { start, end: addDays(start, 6), days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) };
}

/* ---------------- errors ---------------- */

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new ApiError(400, 'bad_request', msg, extra);
export const conflict = (msg, extra) => new ApiError(409, 'conflict', msg, extra);
export const notFound = (msg) => new ApiError(404, 'not_found', msg);

/* ---------------- http helpers ---------------- */

export function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new ApiError(413, 'too_large', '内容过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJsonBody(buf) {
  if (!buf || !buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
}

/** 极简 multipart/form-data 解析 */
export function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buf.indexOf(delim);
  if (start < 0) return parts;
  start += delim.length;
  while (start < buf.length) {
    if (buf.slice(start, start + 2).toString() === '--') break;
    // skip CRLF
    if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) break;
    const headRaw = buf.slice(start, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const next = buf.indexOf(delim, bodyStart);
    if (next < 0) break;
    let body = buf.slice(bodyStart, next - 2); // strip trailing CRLF
    const headers = {};
    for (const line of headRaw.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const cd = headers['content-disposition'] || '';
    const nameM = /name="([^"]*)"/.exec(cd);
    const fileM = /filename="([^"]*)"/.exec(cd);
    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileM ? fileM[1] : null,
      contentType: headers['content-type'] || 'application/octet-stream',
      data: fileM ? body : body.toString('utf8'),
    });
    start = next + delim.length;
  }
  return parts;
}

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendBinary(res, status, buf, headers) {
  res.writeHead(status, { 'content-length': buf.length, ...headers });
  res.end(buf);
}

/* ---------------- files ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

export function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root))) return null;
  return full;
}

export function safeFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 120) || 'file';
}

/* ---------------- zip (store + deflate), 纯内置实现 ---------------- */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
export function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 生成 zip。entries: [{ name, data(Buffer), compress:boolean }]
 */
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = (s) => Buffer.from(s, 'utf8');

  for (const e of entries) {
    const nameBuf = enc(e.name);
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const useDeflate = !!e.compress && raw.length > 0;
    const payload = useDeflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const ts = dosTime(new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(ts.time, 10);
    local.writeUInt16LE(ts.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(ts.time, 12);
    cd.writeUInt16LE(ts.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** 读取 zip，返回 [{ name, data(Buffer) }] */
export function readZip(buf) {
  const out = [];
  const eocdIdx = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdIdx < 0) throw badRequest('不是有效的 ZIP 备份文件');
  const count = buf.readUInt16LE(eocdIdx + 10);
  let ptr = buf.readUInt32LE(eocdIdx + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    let data;
    try {
      data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    } catch {
      throw badRequest(`备份文件已损坏：${name}`);
    }
    out.push({ name, data });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ---------------- misc ---------------- */

export function clampProgress(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw badRequest('进度必须是 0~100 的整数');
  return Math.min(100, Math.max(0, n));
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
