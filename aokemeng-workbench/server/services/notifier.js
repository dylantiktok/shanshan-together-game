'use strict';
const { sendLark } = require('../integrations/lark');
const { nowIso } = require('../util');

function getNotifySettings(db) {
  const row = db.get("SELECT value FROM settings WHERE key = 'lark.notify'");
  return row ? JSON.parse(row.value) : { criticalAlerts: true, syncFailures: true };
}

/** 发送通知：未配置时记录为 not_connected，不抛错、不伪装成功 */
async function notify(db, creds, event, title, text) {
  const settings = getNotifySettings(db);
  if (event === 'critical_alert' && !settings.criticalAlerts) return { skipped: true };
  if (event === 'sync_failure' && !settings.syncFailures) return { skipped: true };
  const cfg = creds.get('lark');
  const log = (status, error) => db.run('INSERT INTO notifications_log (channel, title, body, status, error, created_at) VALUES (?,?,?,?,?,?)',
    ['lark', title, text, status, error || null, nowIso()]);
  if (!cfg?.webhookUrl) {
    log('not_connected', '飞书/Lark 未连接');
    return { status: 'not_connected' };
  }
  try {
    await sendLark(cfg, title, text);
    log('sent');
    return { status: 'sent' };
  } catch (e) {
    log(e.code || 'failed', e.message);
    return { status: e.code || 'failed', error: e.message };
  }
}

module.exports = { notify, getNotifySettings };
