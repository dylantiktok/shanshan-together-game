'use strict';
const crypto = require('crypto');
const { HttpError, nowIso } = require('./util');
const { ROLES, hasPerm } = require('./rbac');

const SESSION_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const SCRYPT = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'weak_password', '密码至少 8 位');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'weak_password', '密码需同时包含字母和数字');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DUMMY_HASH = hashPassword('dummy-password-1');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  db.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
  db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', [sha256(token), userId, nowIso(), expires]);
  return { token, expiresAt: expires };
}

function login(db, username, password) {
  const user = db.get('SELECT * FROM users WHERE username = ?', [String(username || '').trim()]);
  const fail = () => new HttpError(401, 'invalid_credentials', '用户名或密码错误');
  if (!user || !user.active) {
    verifyPassword(String(password || 'x'), DUMMY_HASH); // 恒定耗时，避免枚举用户名
    throw fail();
  }
  if (user.locked_until && user.locked_until > nowIso()) {
    throw new HttpError(423, 'account_locked', `连续登录失败，账号已锁定 ${LOCK_MINUTES} 分钟`);
  }
  if (!verifyPassword(String(password || ''), user.password_hash)) {
    const failed = user.failed_logins + 1;
    const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60e3).toISOString() : null;
    db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [lock ? 0 : failed, lock, user.id]);
    throw fail();
  }
  db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
  return { user, session: createSession(db, user.id) };
}

function userFromToken(db, token) {
  if (!token) return null;
  return db.get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    [sha256(token), nowIso()],
  ) || null;
}

function logout(db, token) {
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

function publicUser(u) {
  if (!u) return null;
  const role = ROLES[u.role];
  return {
    id: u.id, username: u.username, displayName: u.display_name, role: u.role,
    roleName: role ? { zh: role.zh, en: role.en, ms: role.ms } : null,
    locale: u.locale, active: !!u.active, mustChangePassword: !!u.must_change_password,
    permissions: role ? role.perms : [], allShops: !!role?.allShops,
    lastLoginAt: u.last_login_at, createdAt: u.created_at,
  };
}

function authMiddleware(db) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    req.token = h.startsWith('Bearer ') ? h.slice(7) : null;
    req.user = userFromToken(db, req.token);
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'unauthenticated', '请先登录'));
  next();
}

function requirePerm(...perms) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'unauthenticated', '请先登录'));
    if (!perms.every((p) => hasPerm(req.user, p))) return next(new HttpError(403, 'forbidden', '没有权限执行此操作'));
    next();
  };
}

module.exports = {
  hashPassword, verifyPassword, validatePassword, login, logout, createSession,
  userFromToken, publicUser, authMiddleware, requireAuth, requirePerm,
};
