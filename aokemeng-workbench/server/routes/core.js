'use strict';
/** 系统、认证、用户、日志、设置 */
const express = require('express');
const { HttpError, nowIso, requireFields } = require('../util');
const { hashPassword, verifyPassword, validatePassword, login, logout, createSession, publicUser, requireAuth, requirePerm } = require('../auth');
const { ROLES } = require('../rbac');
const { audit } = require('../audit');

const LOCALES = ['zh', 'en', 'ms'];

module.exports = function coreRoutes({ db }) {
  const r = express.Router();

  r.get('/system/status', (req, res) => {
    const users = db.get('SELECT COUNT(*) AS n FROM users').n;
    const company = db.get("SELECT value FROM settings WHERE key = 'company'");
    res.json({
      app: 'AOKEMENG TikTok Operations Workbench', version: require('../../package.json').version,
      needsSetup: users === 0, timezone: 'Asia/Kuala_Lumpur', currency: 'MYR',
      company: company ? JSON.parse(company.value) : null,
    });
  });

  /** 首次启动：创建第一位管理员。系统中已有用户后此接口永久关闭。 */
  r.post('/system/setup', (req, res) => {
    if (db.get('SELECT COUNT(*) AS n FROM users').n > 0) throw new HttpError(409, 'already_setup', '系统已完成初始化');
    const b = req.body || {};
    requireFields(b, ['username', 'displayName', 'password']);
    validatePassword(b.password);
    const id = db.tx(() => {
      const uid = db.run(
        'INSERT INTO users (username, display_name, password_hash, role, locale, created_at) VALUES (?,?,?,?,?,?)',
        [b.username.trim(), b.displayName.trim(), hashPassword(b.password), 'director', LOCALES.includes(b.locale) ? b.locale : 'zh', nowIso()],
      ).lastId;
      db.run("INSERT INTO settings (key, value) VALUES ('company', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [JSON.stringify({ name: b.companyName || 'AOKEMENG Malaysia Sdn Bhd', market: 'MY' })]);
      return uid;
    });
    const user = db.get('SELECT * FROM users WHERE id = ?', [id]);
    req.user = user;
    audit(db, req, 'system.setup', 'user', id, { username: user.username });
    res.json({ user: publicUser(user), session: createSession(db, id) });
  });

  r.post('/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    try {
      const { user, session } = login(db, username, password);
      req.user = user;
      audit(db, req, 'auth.login', 'user', user.id);
      res.json({ user: publicUser(user), session });
    } catch (e) {
      audit(db, req, 'auth.login_failed', 'user', null, { username: String(username || '').slice(0, 64), reason: e.code });
      throw e;
    }
  });

  r.post('/auth/logout', requireAuth, (req, res) => {
    logout(db, req.token);
    audit(db, req, 'auth.logout', 'user', req.user.id);
    res.json({ ok: true });
  });

  r.get('/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

  r.post('/auth/change-password', requireAuth, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!verifyPassword(String(oldPassword || ''), req.user.password_hash)) throw new HttpError(400, 'wrong_password', '原密码错误');
    validatePassword(newPassword);
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hashPassword(newPassword), req.user.id]);
    db.run('DELETE FROM sessions WHERE user_id = ?', [req.user.id]);
    audit(db, req, 'auth.change_password', 'user', req.user.id);
    res.json({ ok: true, session: createSession(db, req.user.id) });
  });

  r.patch('/auth/me', requireAuth, (req, res) => {
    const { locale } = req.body || {};
    if (locale && LOCALES.includes(locale)) db.run('UPDATE users SET locale = ? WHERE id = ?', [locale, req.user.id]);
    res.json({ user: publicUser(db.get('SELECT * FROM users WHERE id = ?', [req.user.id])) });
  });

  // ---- 用户管理 ----
  r.get('/roles', requireAuth, (req, res) => {
    res.json(Object.entries(ROLES).map(([key, v]) => ({ key, zh: v.zh, en: v.en, ms: v.ms, allShops: v.allShops, permissions: v.perms })));
  });

  r.get('/users', requirePerm('users.manage'), (req, res) => {
    const users = db.all('SELECT * FROM users ORDER BY id').map((u) => ({
      ...publicUser(u),
      shopIds: db.all('SELECT shop_id FROM user_shops WHERE user_id = ?', [u.id]).map((x) => x.shop_id),
    }));
    res.json(users);
  });

  r.post('/users', requirePerm('users.manage'), (req, res) => {
    const b = req.body || {};
    requireFields(b, ['username', 'displayName', 'password', 'role']);
    if (!ROLES[b.role]) throw new HttpError(400, 'invalid_role', '角色无效');
    if (b.role === 'admin' || b.role === 'director') ensureTopRole(req);
    validatePassword(b.password);
    if (db.get('SELECT id FROM users WHERE username = ?', [b.username.trim()])) throw new HttpError(409, 'username_taken', '用户名已存在');
    const id = db.tx(() => {
      const uid = db.run(
        'INSERT INTO users (username, display_name, password_hash, role, locale, must_change_password, created_at) VALUES (?,?,?,?,?,1,?)',
        [b.username.trim(), b.displayName.trim(), hashPassword(b.password), b.role, LOCALES.includes(b.locale) ? b.locale : 'zh', nowIso()],
      ).lastId;
      setShops(uid, b.shopIds);
      return uid;
    });
    audit(db, req, 'user.create', 'user', id, { username: b.username, role: b.role, shopIds: b.shopIds || [] });
    res.json({ id });
  });

  r.patch('/users/:id', requirePerm('users.manage'), (req, res) => {
    const id = Number(req.params.id);
    const u = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!u) throw new HttpError(404, 'not_found', '用户不存在');
    const b = req.body || {};
    if (b.role && !ROLES[b.role]) throw new HttpError(400, 'invalid_role', '角色无效');
    if ((b.role && ['admin', 'director'].includes(b.role)) || ['admin', 'director'].includes(u.role)) ensureTopRole(req);
    if (id === req.user.id && (b.active === false || (b.role && b.role !== u.role))) {
      throw new HttpError(400, 'self_change', '不能停用自己或修改自己的角色');
    }
    db.tx(() => {
      if (b.displayName) db.run('UPDATE users SET display_name = ? WHERE id = ?', [b.displayName.trim(), id]);
      if (b.role) db.run('UPDATE users SET role = ? WHERE id = ?', [b.role, id]);
      if (typeof b.active === 'boolean') {
        db.run('UPDATE users SET active = ? WHERE id = ?', [b.active ? 1 : 0, id]);
        if (!b.active) db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
      }
      if (b.password) {
        validatePassword(b.password);
        db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?', [hashPassword(b.password), id]);
        db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
      }
      if (Array.isArray(b.shopIds)) setShops(id, b.shopIds);
    });
    const { password, ...safe } = b;
    audit(db, req, 'user.update', 'user', id, { ...safe, passwordReset: !!password });
    res.json({ ok: true });
  });

  function setShops(userId, shopIds) {
    if (!Array.isArray(shopIds)) return;
    db.run('DELETE FROM user_shops WHERE user_id = ?', [userId]);
    for (const sid of shopIds) db.run('INSERT OR IGNORE INTO user_shops (user_id, shop_id) VALUES (?,?)', [userId, Number(sid)]);
  }

  function ensureTopRole(req) {
    if (!['admin', 'director'].includes(req.user.role)) throw new HttpError(403, 'forbidden', '只有董事或系统管理员可以管理该级别账号');
  }

  // ---- 操作日志 ----
  r.get('/audit-logs', requirePerm('audit.view'), (req, res) => {
    const { q, action, limit = 200, offset = 0 } = req.query;
    const where = ['1=1'], params = [];
    if (action) { where.push('action LIKE ?'); params.push(`${action}%`); }
    if (q) { where.push('(username LIKE ? OR detail LIKE ? OR entity_id = ?)'); params.push(`%${q}%`, `%${q}%`, q); }
    const rows = db.all(`SELECT * FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, Math.min(Number(limit) || 200, 1000), Number(offset) || 0]);
    res.json(rows.map((x) => ({ ...x, detail: x.detail ? JSON.parse(x.detail) : null })));
  });

  return r;
};
