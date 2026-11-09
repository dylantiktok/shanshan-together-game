'use strict';
const { nowIso } = require('./util');

/** 写入操作日志。重要操作必须调用。detail 中不得包含明文密钥。 */
function audit(db, req, action, entity, entityId, detail) {
  const user = req?.user;
  db.run(
    'INSERT INTO audit_logs (user_id, username, action, entity, entity_id, detail, ip, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [user?.id ?? null, user?.username ?? null, action, entity ?? null, entityId == null ? null : String(entityId),
      detail === undefined ? null : JSON.stringify(detail), req?.ip ?? null, nowIso()],
  );
}

module.exports = { audit };
