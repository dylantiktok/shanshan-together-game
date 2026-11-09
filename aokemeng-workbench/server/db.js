'use strict';
/**
 * 本地数据库层（SQLite，基于 sql.js / WebAssembly）
 *
 * 选择 sql.js 的原因：纯 WASM，无需在 Windows/macOS 上编译原生模块，
 * 安装包即可运行。数据库常驻内存，每次写操作后以“临时文件 + 原子重命名”
 * 方式落盘，并按天保留备份，避免断电导致数据库损坏。
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { runMigrations } = require('./migrations');

class Database {
  constructor(sqlDb, filePath) {
    this.sql = sqlDb;
    this.filePath = filePath;
    this.dirty = false;
    this.saveTimer = null;
    this.inTx = 0;
    this.applyPragmas();
  }

  applyPragmas() {
    this.sql.run('PRAGMA foreign_keys = ON;');
  }

  all(query, params = []) {
    const stmt = this.sql.prepare(query);
    try {
      stmt.bind(normalize(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(query, params = []) {
    return this.all(query, params)[0];
  }

  run(query, params = []) {
    this.sql.run(query, normalize(params));
    const changes = this.sql.getRowsModified();
    const lastId = this.sql.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
    this.markDirty();
    return { changes, lastId };
  }

  exec(script) {
    this.sql.exec(script);
    this.markDirty();
  }

  /** 事务：fn 内抛错则整体回滚 */
  tx(fn) {
    if (this.inTx) return fn(this);
    this.sql.run('BEGIN');
    this.inTx++;
    try {
      const result = fn(this);
      this.sql.run('COMMIT');
      return result;
    } catch (err) {
      this.sql.run('ROLLBACK');
      throw err;
    } finally {
      this.inTx--;
      this.markDirty();
    }
  }

  markDirty() {
    if (!this.filePath || this.inTx) return;
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 200);
  }

  /** 原子写盘 */
  flush() {
    if (!this.filePath || !this.dirty) return;
    clearTimeout(this.saveTimer);
    const data = this.sql.export();
    // sql.js 的 export() 会重置连接级 PRAGMA
    this.applyPragmas();
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, this.filePath);
    this.dirty = false;
    this.dailyBackup();
  }

  dailyBackup() {
    const dir = path.join(path.dirname(this.filePath), 'backups');
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const target = path.join(dir, `workbench-${day}.sqlite`);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(this.filePath, target);
    // 只保留最近 30 份
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(dir, files.shift()));
  }

  close() {
    this.flush();
    this.sql.close();
  }
}

function normalize(params) {
  if (Array.isArray(params)) return params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    out[k.startsWith('@') || k.startsWith(':') || k.startsWith('$') ? k : '@' + k] =
      v === undefined ? null : typeof v === 'boolean' ? Number(v) : v;
  }
  return out;
}

let SQL = null;
async function openDatabase(filePath) {
  if (!SQL) SQL = await initSqlJs();
  let sqlDb;
  if (filePath && fs.existsSync(filePath)) {
    sqlDb = new SQL.Database(fs.readFileSync(filePath));
  } else {
    if (filePath) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    sqlDb = new SQL.Database();
  }
  const db = new Database(sqlDb, filePath);
  runMigrations(db);
  db.dirty = true;
  db.flush();
  return db;
}

module.exports = { openDatabase, Database };
