'use strict';
/**
 * 集成凭据与连接状态存储。凭据以 AES-256-GCM 加密保存在本地数据库，
 * 接口只返回遮盖后的值。连接状态只在真实调用成功后才标记为 connected。
 */
const { nowIso, mask } = require('../util');

class CredentialStore {
  constructor(db, secretBox) {
    this.db = db;
    this.box = secretBox;
  }

  get(provider, scope = 'global') {
    const row = this.db.get('SELECT data_enc FROM credentials WHERE provider = ? AND scope = ?', [provider, scope]);
    if (!row) return null;
    try {
      return this.box.decrypt(row.data_enc);
    } catch {
      return null; // 密钥文件丢失或损坏时视为未配置
    }
  }

  /** 合并保存：空字符串或 undefined 的字段保持原值，null 表示清除 */
  set(provider, scope, patch, userId) {
    const current = this.get(provider, scope) || {};
    const next = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') continue;
      if (v === null) delete next[k];
      else next[k] = v;
    }
    this.db.run(
      `INSERT INTO credentials (provider, scope, data_enc, updated_at, updated_by) VALUES (?,?,?,?,?)
       ON CONFLICT(provider, scope) DO UPDATE SET data_enc = excluded.data_enc, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [provider, scope, this.box.encrypt(next), nowIso(), userId ?? null],
    );
    // 凭据变化后，之前的连接状态不再可信
    this.setStatus(provider, scope, { state: 'unverified', checkedAt: nowIso(), message: '凭据已更新，尚未验证连接' });
    return next;
  }

  remove(provider, scope) {
    this.db.run('DELETE FROM credentials WHERE provider = ? AND scope = ?', [provider, scope]);
    this.setStatus(provider, scope, { state: 'not_connected', checkedAt: nowIso(), message: '凭据已删除' });
  }

  masked(provider, scope, secretKeys = []) {
    const c = this.get(provider, scope);
    if (!c) return null;
    const out = {};
    for (const [k, v] of Object.entries(c)) out[k] = secretKeys.includes(k) ? mask(v) : v;
    return out;
  }

  getStatus(provider, scope = 'global') {
    const row = this.db.get('SELECT value FROM settings WHERE key = ?', [`integration_status:${provider}:${scope}`]);
    return row ? JSON.parse(row.value) : { state: 'not_connected', checkedAt: null, message: '未连接' };
  }

  setStatus(provider, scope, status) {
    this.db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`integration_status:${provider}:${scope}`, JSON.stringify(status)],
    );
  }
}

module.exports = { CredentialStore };
