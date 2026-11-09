'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TZ = 'Asia/Kuala_Lumpur';
const KL_OFFSET_MS = 8 * 3600e3; // 马来西亚无夏令时，固定 UTC+8

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const nowIso = () => new Date().toISOString();

/** 返回某一时刻在吉隆坡时区的日期 YYYY-MM-DD */
function klDate(d = new Date()) {
  return new Date(new Date(d).getTime() + KL_OFFSET_MS).toISOString().slice(0, 10);
}

/** 吉隆坡日期 -> 当天 00:00 (KL) 对应的 UTC ISO */
function klDayStartUtc(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new HttpError(400, 'invalid_date', `日期格式错误: ${dateStr}`);
  return new Date(Date.parse(dateStr + 'T00:00:00Z') - KL_OFFSET_MS).toISOString();
}

function addDays(dateStr, n) {
  const t = Date.parse(dateStr + 'T00:00:00Z') + n * 86400e3;
  return new Date(t).toISOString().slice(0, 10);
}

/** 闭区间 [from, to]（KL 日期）转为 UTC 半开区间 */
function klRangeUtc(from, to) {
  return { start: klDayStartUtc(from), end: klDayStartUtc(addDays(to, 1)) };
}

/** "12.30" / 12.3 -> 1230 sen */
function toSen(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\sRM]/gi, ''));
  if (!Number.isFinite(n)) throw new HttpError(400, 'invalid_amount', `金额无效: ${v}`);
  return Math.round(n * 100);
}
const fromSen = (s) => (s == null ? null : Math.round(s) / 100);

function toNum(v, def = 0) {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, 'invalid_number', `数值无效: ${v}`);
  return n;
}

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || String(body[f]).trim() === '');
  if (missing.length) throw new HttpError(400, 'missing_fields', `缺少必填字段: ${missing.join(', ')}`);
}

/** 本地密钥加密（AES-256-GCM），用于保存 API 密钥等敏感配置 */
class SecretBox {
  constructor(dataDir) {
    const keyFile = path.join(dataDir, 'secret.key');
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    this.key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  }
  encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  }
  decrypt(str) {
    const [iv, tag, enc] = str.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
  }
}

/** 遮盖敏感值，仅显示末4位 */
function mask(v) {
  if (!v) return '';
  const s = String(v);
  return s.length <= 4 ? '****' : '****' + s.slice(-4);
}

function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return '﻿' + [head, ...body].join('\r\n'); // BOM 便于 Excel 正确识别中文
}

/** 简单 CSV 解析（支持引号转义） */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows.shift().map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

module.exports = {
  TZ, HttpError, nowIso, klDate, klDayStartUtc, klRangeUtc, addDays,
  toSen, fromSen, toNum, requireFields, SecretBox, mask, toCsv, parseCsv,
};
