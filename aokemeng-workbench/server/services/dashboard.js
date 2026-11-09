'use strict';
/**
 * 经营总览指标计算。
 * 每个指标附带数据来源构成（api / manual / import / estimate），前端据此标注
 * “实际数据 / 人工录入 / 估算”，绝不把估算或人工数据冒充平台实际数据。
 */
const { klDate, klRangeUtc, addDays, HttpError } = require('../util');
const { shopFilterSql, hasPerm } = require('../rbac');
const { calcUnitProfit } = require('./profit');

const EXCLUDED_STATUSES = ['cancelled', 'unpaid'];
const statusSql = `o.status NOT IN (${EXCLUDED_STATUSES.map(() => '?').join(',')})`;

function salesBetween(db, shopF, from, to) {
  const { start, end } = klRangeUtc(from, to);
  const rows = db.all(
    `SELECT o.data_source AS source, COUNT(*) AS orders, COALESCE(SUM(o.total_sen),0) AS sales
     FROM orders o WHERE ${shopF.sql} AND ${statusSql} AND o.order_time >= ? AND o.order_time < ?
     GROUP BY o.data_source`,
    [...shopF.params, ...EXCLUDED_STATUSES, start, end],
  );
  return summarize(rows, ['orders', 'sales']);
}

function summarize(rows, keys) {
  const total = Object.fromEntries(keys.map((k) => [k, 0]));
  const bySource = {};
  for (const r of rows) {
    bySource[r.source] = {};
    for (const k of keys) {
      total[k] += r[k] || 0;
      bySource[r.source][k] = r[k] || 0;
    }
  }
  return { ...total, bySource };
}

function getDashboard(db, user, { from, to, shopId } = {}) {
  const today = klDate();
  to = to || today;
  from = from || addDays(to, -29);
  if (from > to) throw new HttpError(400, 'invalid_range', '开始日期不能晚于结束日期');
  const shopF = shopFilterSql(db, user, 'o.shop_id', shopId);
  const canFinance = hasPerm(user, 'finance.view');

  const fixed = {
    today: salesBetween(db, shopF, today, today),
    yesterday: salesBetween(db, shopF, addDays(today, -1), addDays(today, -1)),
    last7: salesBetween(db, shopF, addDays(today, -6), today),
    last30: salesBetween(db, shopF, addDays(today, -29), today),
  };

  const { start, end } = klRangeUtc(from, to);
  const range = salesBetween(db, shopF, from, to);
  range.aovSen = range.orders ? Math.round(range.sales / range.orders) : null;

  // 退款
  const rf = shopFilterSql(db, user, 'r.shop_id', shopId);
  const refunds = summarize(
    db.all(
      `SELECT r.data_source AS source, COUNT(*) AS count, COALESCE(SUM(r.amount_sen),0) AS amount
       FROM refunds r WHERE ${rf.sql} AND r.status != 'rejected' AND r.refund_time >= ? AND r.refund_time < ?
       GROUP BY r.data_source`,
      [...rf.params, start, end],
    ),
    ['count', 'amount'],
  );

  // 广告
  const af = shopFilterSql(db, user, 'a.shop_id', shopId);
  const ads = summarize(
    db.all(
      `SELECT a.data_source AS source, COALESCE(SUM(a.spend_sen),0) AS spend, COALESCE(SUM(a.attributed_gmv_sen),0) AS attributed
       FROM ad_spend a WHERE ${af.sql} AND a.date >= ? AND a.date <= ? GROUP BY a.data_source`,
      [...af.params, from, to],
    ),
    ['spend', 'attributed'],
  );
  const roas = ads.spend > 0 ? round2(range.sales / ads.spend) : null;
  const attributedRoas = ads.spend > 0 && ads.attributed > 0 ? round2(ads.attributed / ads.spend) : null;

  // 日趋势
  const trend = db.all(
    `SELECT date(o.order_time, '+8 hours') AS day, COUNT(*) AS orders, COALESCE(SUM(o.total_sen),0) AS sales
     FROM orders o WHERE ${shopF.sql} AND ${statusSql} AND o.order_time >= ? AND o.order_time < ?
     GROUP BY day ORDER BY day`,
    [...shopF.params, ...EXCLUDED_STATUSES, start, end],
  );

  // 店铺排名
  const ranking = db.all(
    `SELECT s.id, s.name, s.platform,
       (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id AND ${statusSql} AND o.order_time >= ? AND o.order_time < ?) AS orders,
       (SELECT COALESCE(SUM(o.total_sen),0) FROM orders o WHERE o.shop_id = s.id AND ${statusSql} AND o.order_time >= ? AND o.order_time < ?) AS sales,
       (SELECT COALESCE(SUM(r.amount_sen),0) FROM refunds r WHERE r.shop_id = s.id AND r.status != 'rejected' AND r.refund_time >= ? AND r.refund_time < ?) AS refunds,
       (SELECT COALESCE(SUM(a.spend_sen),0) FROM ad_spend a WHERE a.shop_id = s.id AND a.date >= ? AND a.date <= ?) AS ad_spend
     FROM shops s WHERE ${shopFilterSql(db, user, 's.id', shopId).sql}
     ORDER BY sales DESC`,
    [...EXCLUDED_STATUSES, start, end, ...EXCLUDED_STATUSES, start, end, start, end, from, to,
      ...shopFilterSql(db, user, 's.id', shopId).params],
  ).map((r) => ({ ...r, roas: r.ad_spend > 0 ? round2(r.sales / r.ad_spend) : null }));

  const result = {
    period: { from, to, today, timezone: 'Asia/Kuala_Lumpur', currency: 'MYR' },
    fixed,
    range: {
      sales: { valueSen: range.sales, bySource: range.bySource },
      orders: { value: range.orders, bySource: range.bySource },
      aov: { valueSen: range.aovSen },
      refunds: { valueSen: refunds.amount, count: refunds.count, bySource: refunds.bySource },
      adSpend: { valueSen: ads.spend, bySource: ads.bySource },
      roas: { value: roas, attributedValue: attributedRoas, note: 'ROAS = 区间销售额 ÷ 广告花费；归因 ROAS 仅在录入归因 GMV 时显示' },
    },
    trend,
    ranking: canFinance ? ranking : ranking.map(({ ad_spend, roas: _r, refunds: _f, ...rest }) => rest),
    hasData: range.orders > 0 || ads.spend > 0 || refunds.count > 0,
  };

  if (canFinance) {
    result.range.grossProfit = grossProfit(db, shopF, start, end);
    const gp = result.range.grossProfit;
    result.range.netProfit = {
      valueSen: gp.valueSen === null && !ads.spend && !refunds.amount ? null : (gp.valueSen || 0) - ads.spend - refunds.amount,
      source: 'estimate',
      note: '预估净利润 = 商品毛利(估算) - 广告花费 - 退款金额。未含仓储、人工、平台其他费用；以平台结算及财务账为准。',
      incomplete: gp.coveragePct !== null && gp.coveragePct < 100,
    };
  }
  return result;
}

/** 商品毛利（估算）：按订单行 × SKU 成本档案计算，不含广告（广告单独扣减） */
function grossProfit(db, shopF, start, end) {
  const items = db.all(
    `SELECT oi.quantity, oi.unit_price_sen, c.*, (c.sku_id IS NOT NULL) AS has_cost
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     LEFT JOIN sku_costs c ON c.sku_id = oi.sku_id
     WHERE ${shopF.sql} AND ${statusSql} AND o.order_time >= ? AND o.order_time < ?`,
    [...shopF.params, ...EXCLUDED_STATUSES, start, end],
  );
  let value = 0, covered = 0, revenueCovered = 0, revenueAll = 0;
  for (const it of items) {
    const rev = it.unit_price_sen * it.quantity;
    revenueAll += rev;
    if (!it.has_cost) continue;
    const u = calcUnitProfit({ ...it, price_sen: it.unit_price_sen, ad_cost_per_unit_sen: 0 });
    value += u.profitSen * it.quantity;
    covered++;
    revenueCovered += rev;
  }
  return {
    valueSen: items.length ? value : null,
    source: 'estimate',
    lineItems: items.length,
    lineItemsWithCost: covered,
    // 区间内没有订单行时，毛利与覆盖率都没有意义，返回 null（界面显示“—”而不是 0）
    coveragePct: revenueAll ? round2((revenueCovered / revenueAll) * 100) : null,
    note: '商品毛利按 SKU 成本档案与费率估算；缺少成本档案的订单行未计入。',
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { getDashboard };
