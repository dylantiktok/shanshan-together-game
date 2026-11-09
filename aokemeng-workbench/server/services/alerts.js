'use strict';
/**
 * 店铺异常提醒规则引擎。每次运行重新评估规则：
 * 条件成立 → 打开提醒（同一 rule+ref 只保留一条未处理提醒）；条件消失 → 自动关闭。
 */
const { nowIso, klDate, klRangeUtc, addDays } = require('../util');
const { calcUnitProfit } = require('./profit');

const REFUND_RATE_THRESHOLD = 10; // %
const AUTH_EXPIRY_WARN_DAYS = 7;

function evaluateAlerts(db) {
  const found = []; // { shopId, rule, ref, severity, message }

  // 1. 店铺授权状态
  for (const s of db.all('SELECT * FROM shops WHERE status = ?', ['active'])) {
    if (s.auth_status !== 'authorized') {
      found.push({ shopId: s.id, rule: 'shop_not_connected', ref: `shop:${s.id}`, severity: 'info',
        message: `店铺「${s.name}」平台 API 未连接，数据需人工录入或导入` });
    } else if (s.auth_expires_at) {
      const days = (Date.parse(s.auth_expires_at) - Date.now()) / 86400e3;
      if (days < 0) found.push({ shopId: s.id, rule: 'auth_expired', ref: `shop:${s.id}`, severity: 'critical', message: `店铺「${s.name}」授权已过期，同步已停止` });
      else if (days < AUTH_EXPIRY_WARN_DAYS) found.push({ shopId: s.id, rule: 'auth_expiring', ref: `shop:${s.id}`, severity: 'warning', message: `店铺「${s.name}」授权将在 ${Math.ceil(days)} 天内过期` });
    }
  }

  // 2. 库存
  for (const k of db.all(`SELECT k.*, p.title, s.name AS shop_name FROM skus k JOIN products p ON p.id = k.product_id JOIN shops s ON s.id = k.shop_id
                          WHERE k.stock IS NOT NULL AND p.status = 'active'`)) {
    if (k.stock <= 0) found.push({ shopId: k.shop_id, rule: 'out_of_stock', ref: `sku:${k.id}`, severity: 'critical', message: `【${k.shop_name}】${k.seller_sku} ${k.title} 已断货` });
    else if (k.stock <= k.low_stock_threshold) found.push({ shopId: k.shop_id, rule: 'low_stock', ref: `sku:${k.id}`, severity: 'warning', message: `【${k.shop_name}】${k.seller_sku} 库存仅剩 ${k.stock}（预警线 ${k.low_stock_threshold}）` });
  }

  // 3. 亏损 SKU / 缺少成本档案
  for (const k of db.all(`SELECT k.id, k.shop_id, k.seller_sku, k.price_sen, c.*, (c.sku_id IS NOT NULL) AS has_cost
                          FROM skus k JOIN products p ON p.id = k.product_id LEFT JOIN sku_costs c ON c.sku_id = k.id WHERE p.status = 'active'`)) {
    if (!k.has_cost) {
      found.push({ shopId: k.shop_id, rule: 'missing_cost', ref: `sku:${k.id}`, severity: 'info', message: `${k.seller_sku} 未录入成本档案，无法计算利润` });
      continue;
    }
    const r = calcUnitProfit({ ...k, price_sen: k.price_sen });
    if (r.isLoss) found.push({ shopId: k.shop_id, rule: 'negative_margin', ref: `sku:${k.id}`, severity: 'critical', message: `${k.seller_sku} 按当前售价每件亏损 RM ${(-r.profitSen / 100).toFixed(2)}` });
  }

  // 4. 近 30 天退款率
  const to = klDate();
  const { start, end } = klRangeUtc(addDays(to, -29), to);
  for (const s of db.all(`SELECT s.id, s.name,
        (SELECT COALESCE(SUM(total_sen),0) FROM orders WHERE shop_id = s.id AND status NOT IN ('cancelled','unpaid') AND order_time >= ? AND order_time < ?) AS sales,
        (SELECT COALESCE(SUM(amount_sen),0) FROM refunds WHERE shop_id = s.id AND status != 'rejected' AND refund_time >= ? AND refund_time < ?) AS refunds
      FROM shops s`, [start, end, start, end])) {
    if (s.sales > 0) {
      const rate = (s.refunds / s.sales) * 100;
      if (rate > REFUND_RATE_THRESHOLD) found.push({ shopId: s.id, rule: 'high_refund_rate', ref: `shop:${s.id}`, severity: 'warning', message: `店铺「${s.name}」近30天退款率 ${rate.toFixed(1)}%（阈值 ${REFUND_RATE_THRESHOLD}%）` });
    }
  }

  // 应用
  const created = [];
  db.tx(() => {
    const open = db.all('SELECT id, rule, ref FROM alerts WHERE resolved_at IS NULL');
    const key = (a) => `${a.rule}|${a.ref}`;
    const foundKeys = new Set(found.map(key));
    for (const a of open) {
      // 只自动关闭规则引擎产生的提醒
      if (!foundKeys.has(key(a)) && !a.rule.startsWith('sync_')) {
        db.run('UPDATE alerts SET resolved_at = ? WHERE id = ?', [nowIso(), a.id]);
      }
    }
    const openKeys = new Set(open.map(key));
    for (const f of found) {
      if (openKeys.has(key(f))) {
        db.run('UPDATE alerts SET message = ?, severity = ? WHERE rule = ? AND ref = ? AND resolved_at IS NULL', [f.message, f.severity, f.rule, f.ref]);
      } else {
        db.run('INSERT INTO alerts (shop_id, rule, ref, severity, message, created_at) VALUES (?,?,?,?,?,?)',
          [f.shopId ?? null, f.rule, f.ref, f.severity, f.message, nowIso()]);
        created.push(f);
      }
    }
  });
  return { open: found.length, created };
}

/** 同步失败等事件型提醒（需人工关闭） */
function raiseEventAlert(db, shopId, rule, ref, severity, message) {
  const ex = db.get('SELECT id FROM alerts WHERE rule = ? AND ref = ? AND resolved_at IS NULL', [rule, ref]);
  if (ex) db.run('UPDATE alerts SET message = ?, severity = ?, created_at = ? WHERE id = ?', [message, severity, nowIso(), ex.id]);
  else db.run('INSERT INTO alerts (shop_id, rule, ref, severity, message, created_at) VALUES (?,?,?,?,?,?)', [shopId ?? null, rule, ref, severity, message, nowIso()]);
}

module.exports = { evaluateAlerts, raiseEventAlert };
