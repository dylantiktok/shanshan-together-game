'use strict';
/** 业务数据：店铺、商品/SKU、成本、订单、退款、广告、店铺指标、经营总览、利润计算、提醒、导入导出 */
const express = require('express');
const { HttpError, nowIso, requireFields, toSen, toNum, fromSen, klDate, klRangeUtc, toCsv, parseCsv } = require('../util');
const { requirePerm } = require('../auth');
const { canAccessShop, shopFilterSql, hasPerm } = require('../rbac');
const { audit } = require('../audit');
const { getDashboard } = require('../services/dashboard');
const { calcUnitProfit, priceForTargetMargin, calcForQuantity } = require('../services/profit');
const { upsertOrder, upsertProduct, upsertRefund, ORDER_STATUSES } = require('../services/ingest');
const { evaluateAlerts } = require('../services/alerts');

const COST_FIELDS_SEN = ['purchase_cost_sen', 'packaging_cost_sen', 'shipping_cost_sen', 'shipping_subsidy_sen', 'seller_discount_sen', 'ad_cost_per_unit_sen', 'other_cost_sen'];
const COST_FIELDS_RATE = ['commission_rate', 'transaction_fee_rate', 'affiliate_rate'];

module.exports = function businessRoutes({ db }) {
  const r = express.Router();

  const assertShop = (req, shopId) => {
    const shop = db.get('SELECT * FROM shops WHERE id = ?', [Number(shopId)]);
    if (!shop) throw new HttpError(404, 'shop_not_found', '店铺不存在');
    if (!canAccessShop(db, req.user, shop.id)) throw new HttpError(403, 'forbidden', '没有该店铺的访问权限');
    return shop;
  };

  const sendCsv = (req, res, name, rows, columns) => {
    audit(db, req, 'export.csv', name, null, { rows: rows.length, query: req.query });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${name}-${klDate()}.csv"`);
    res.send(toCsv(rows, columns));
  };

  // ================= 店铺 =================
  r.get('/shops', requirePerm('shops.view'), (req, res) => {
    const f = shopFilterSql(db, req.user, 'id');
    const shops = db.all(`SELECT * FROM shops WHERE ${f.sql} ORDER BY id`, f.params);
    res.json(shops);
  });

  r.post('/shops', requirePerm('shops.manage'), (req, res) => {
    const b = req.body || {};
    requireFields(b, ['platform', 'name']);
    if (!['tiktok', 'shopee'].includes(b.platform)) throw new HttpError(400, 'invalid_platform', '平台必须是 tiktok 或 shopee');
    const t = nowIso();
    const id = db.run(
      'INSERT INTO shops (platform, name, region, external_shop_id, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [b.platform, b.name.trim(), b.region || 'MY', b.externalShopId || null, b.notes || null, t, t],
    ).lastId;
    audit(db, req, 'shop.create', 'shop', id, { name: b.name, platform: b.platform });
    evaluateAlerts(db);
    res.json({ id });
  });

  r.patch('/shops/:id', requirePerm('shops.manage'), (req, res) => {
    const shop = assertShop(req, req.params.id);
    const b = req.body || {};
    if (b.status && !['active', 'paused', 'closed'].includes(b.status)) throw new HttpError(400, 'invalid_status', '状态无效');
    db.run(
      'UPDATE shops SET name = COALESCE(?, name), region = COALESCE(?, region), external_shop_id = COALESCE(?, external_shop_id), status = COALESCE(?, status), notes = COALESCE(?, notes), updated_at = ? WHERE id = ?',
      [b.name || null, b.region || null, b.externalShopId || null, b.status || null, b.notes ?? null, nowIso(), shop.id],
    );
    audit(db, req, 'shop.update', 'shop', shop.id, b);
    res.json({ ok: true });
  });

  r.delete('/shops/:id', requirePerm('shops.manage'), (req, res) => {
    const shop = assertShop(req, req.params.id);
    const orders = db.get('SELECT COUNT(*) AS n FROM orders WHERE shop_id = ?', [shop.id]).n;
    if (orders > 0) throw new HttpError(409, 'shop_has_data', `店铺已有 ${orders} 条订单数据，不能删除，请改为“关闭”状态`);
    db.run('DELETE FROM shops WHERE id = ?', [shop.id]);
    audit(db, req, 'shop.delete', 'shop', shop.id, { name: shop.name });
    res.json({ ok: true });
  });

  // 店铺绩效指标（人工录入或接口同步）
  r.get('/shops/:id/metrics', requirePerm('shops.view'), (req, res) => {
    const shop = assertShop(req, req.params.id);
    res.json(db.all('SELECT * FROM shop_metrics WHERE shop_id = ? ORDER BY date DESC, metric_key LIMIT 500', [shop.id]));
  });

  r.post('/shops/:id/metrics', requirePerm('metrics.manage'), (req, res) => {
    const shop = assertShop(req, req.params.id);
    const b = req.body || {};
    requireFields(b, ['date', 'metricKey', 'value']);
    klRangeUtc(b.date, b.date);
    db.run(
      `INSERT INTO shop_metrics (shop_id, date, metric_key, value, data_source, created_at) VALUES (?,?,?,?, 'manual', ?)
       ON CONFLICT(shop_id, date, metric_key) DO UPDATE SET value = excluded.value, data_source = 'manual'`,
      [shop.id, b.date, String(b.metricKey).slice(0, 64), toNum(b.value), nowIso()],
    );
    audit(db, req, 'shop_metric.upsert', 'shop', shop.id, b);
    res.json({ ok: true });
  });

  // ================= 商品与 SKU =================
  r.get('/products', requirePerm('products.view'), (req, res) => {
    const f = shopFilterSql(db, req.user, 'k.shop_id', req.query.shopId);
    const where = [f.sql], params = [...f.params];
    if (req.query.q) { where.push('(p.title LIKE ? OR k.seller_sku LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const showCost = hasPerm(req.user, 'costs.view');
    const rows = db.all(
      `SELECT c.*, k.id AS sku_id, k.seller_sku, k.external_sku_id, k.name AS sku_name, k.price_sen, k.stock, k.low_stock_threshold,
              k.data_source, k.updated_at, p.id AS product_id, p.title, p.category, p.status AS product_status,
              s.id AS shop_id, s.name AS shop_name, s.platform, (c.sku_id IS NOT NULL) AS has_cost
       FROM skus k JOIN products p ON p.id = k.product_id JOIN shops s ON s.id = k.shop_id
       LEFT JOIN sku_costs c ON c.sku_id = k.id
       WHERE ${where.join(' AND ')} ORDER BY s.id, p.title, k.seller_sku`,
      params,
    );
    res.json(rows.map((x) => {
      const base = {
        skuId: x.sku_id, productId: x.product_id, shopId: x.shop_id, shopName: x.shop_name, platform: x.platform,
        title: x.title, category: x.category, productStatus: x.product_status, sellerSku: x.seller_sku,
        externalSkuId: x.external_sku_id, skuName: x.sku_name, priceSen: x.price_sen, stock: x.stock,
        lowStockThreshold: x.low_stock_threshold, dataSource: x.data_source, updatedAt: x.updated_at, hasCost: !!x.has_cost,
      };
      if (showCost && x.has_cost) {
        base.cost = pickCost(x);
        base.profit = calcUnitProfit({ ...x, price_sen: x.price_sen });
      }
      return base;
    }));
  });

  r.post('/products', requirePerm('products.manage'), (req, res) => {
    const b = req.body || {};
    requireFields(b, ['shopId', 'title', 'sellerSku', 'price']);
    assertShop(req, b.shopId);
    const result = upsertProduct(db, Number(b.shopId), {
      externalProductId: b.externalProductId || null, title: b.title.trim(), category: b.category, status: 'active',
      skus: [{ sellerSku: b.sellerSku.trim(), name: b.skuName, priceSen: toSen(b.price), stock: b.stock === '' || b.stock == null ? null : Math.floor(toNum(b.stock)) }],
    }, 'manual');
    audit(db, req, 'product.create', 'product', result.id, { title: b.title, sellerSku: b.sellerSku, price: b.price });
    evaluateAlerts(db);
    res.json(result);
  });

  r.patch('/skus/:id', requirePerm('products.manage'), (req, res) => {
    const sku = db.get('SELECT * FROM skus WHERE id = ?', [Number(req.params.id)]);
    if (!sku) throw new HttpError(404, 'not_found', 'SKU 不存在');
    assertShop(req, sku.shop_id);
    const b = req.body || {};
    if (sku.data_source === 'api' && (b.price !== undefined || b.stock !== undefined)) {
      throw new HttpError(409, 'api_managed', '该 SKU 的价格与库存来自平台接口，请在平台后台修改后重新同步');
    }
    db.tx(() => {
      if (b.price !== undefined) db.run('UPDATE skus SET price_sen = ? WHERE id = ?', [toSen(b.price), sku.id]);
      if (b.stock !== undefined) db.run('UPDATE skus SET stock = ? WHERE id = ?', [b.stock === '' || b.stock === null ? null : Math.floor(toNum(b.stock)), sku.id]);
      if (b.lowStockThreshold !== undefined) db.run('UPDATE skus SET low_stock_threshold = ? WHERE id = ?', [Math.max(0, Math.floor(toNum(b.lowStockThreshold))), sku.id]);
      if (b.name !== undefined) db.run('UPDATE skus SET name = ? WHERE id = ?', [b.name, sku.id]);
      if (b.title) db.run('UPDATE products SET title = ?, updated_at = ? WHERE id = ?', [b.title, nowIso(), sku.product_id]);
      if (b.productStatus) db.run('UPDATE products SET status = ?, updated_at = ? WHERE id = ?', [b.productStatus, nowIso(), sku.product_id]);
      db.run('UPDATE skus SET updated_at = ? WHERE id = ?', [nowIso(), sku.id]);
    });
    audit(db, req, 'sku.update', 'sku', sku.id, { before: { price_sen: sku.price_sen, stock: sku.stock }, changes: b });
    evaluateAlerts(db);
    res.json({ ok: true });
  });

  // ================= SKU 成本 / 利润计算器 =================
  r.get('/skus/:id/cost', requirePerm('costs.view'), (req, res) => {
    const sku = db.get('SELECT * FROM skus WHERE id = ?', [Number(req.params.id)]);
    if (!sku) throw new HttpError(404, 'not_found', 'SKU 不存在');
    assertShop(req, sku.shop_id);
    const c = db.get('SELECT * FROM sku_costs WHERE sku_id = ?', [sku.id]);
    res.json({ sku, cost: c ? pickCost(c) : null, profit: c ? calcUnitProfit({ ...c, price_sen: sku.price_sen }) : null });
  });

  r.put('/skus/:id/cost', requirePerm('costs.manage'), (req, res) => {
    const sku = db.get('SELECT * FROM skus WHERE id = ?', [Number(req.params.id)]);
    if (!sku) throw new HttpError(404, 'not_found', 'SKU 不存在');
    assertShop(req, sku.shop_id);
    const c = parseCostInput(req.body || {});
    const before = db.get('SELECT * FROM sku_costs WHERE sku_id = ?', [sku.id]);
    db.run(
      `INSERT INTO sku_costs (sku_id, ${[...COST_FIELDS_SEN, ...COST_FIELDS_RATE].join(',')}, notes, updated_by, updated_at)
       VALUES (?, ${[...COST_FIELDS_SEN, ...COST_FIELDS_RATE].map(() => '?').join(',')}, ?, ?, ?)
       ON CONFLICT(sku_id) DO UPDATE SET ${[...COST_FIELDS_SEN, ...COST_FIELDS_RATE, 'notes', 'updated_by', 'updated_at'].map((k) => `${k} = excluded.${k}`).join(', ')}`,
      [sku.id, ...COST_FIELDS_SEN.map((k) => c[k]), ...COST_FIELDS_RATE.map((k) => c[k]), c.notes, req.user.id, nowIso()],
    );
    audit(db, req, 'sku_cost.upsert', 'sku', sku.id, { before: before ? pickCost(before) : null, after: c });
    evaluateAlerts(db);
    res.json({ ok: true, profit: calcUnitProfit({ ...c, price_sen: sku.price_sen }) });
  });

  /** 试算：不落库。可传入任意售价与成本（用于定价模拟） */
  r.post('/profit/calculate', requirePerm('costs.view'), (req, res) => {
    const b = req.body || {};
    const input = { ...parseCostInput(b), price_sen: toSen(b.price) };
    res.json({
      unit: calcUnitProfit(input),
      quantity: b.quantity ? calcForQuantity(input, b.quantity) : null,
      targetPriceSen: b.targetMarginPct !== undefined && b.targetMarginPct !== '' ? priceForTargetMargin(input, toNum(b.targetMarginPct)) : null,
    });
  });

  function parseCostInput(b) {
    const out = {};
    for (const k of COST_FIELDS_SEN) out[k] = toSen(b[k.replace(/_sen$/, '')] ?? 0);
    for (const k of COST_FIELDS_RATE) {
      const v = toNum(b[k], 0);
      if (v < 0 || v >= 100) throw new HttpError(400, 'invalid_rate', `${k} 必须在 0 到 100 之间`);
      out[k] = v;
    }
    for (const k of COST_FIELDS_SEN) if (out[k] < 0) throw new HttpError(400, 'negative_amount', `${k} 不能为负数`);
    out.notes = b.notes || null;
    return out;
  }

  // ================= 订单 =================
  r.get('/orders', requirePerm('orders.view'), (req, res) => {
    const { where, params } = orderWhere(req);
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const offset = Number(req.query.offset) || 0;
    const total = db.get(`SELECT COUNT(*) AS n FROM orders o WHERE ${where}`, params).n;
    const rows = db.all(
      `SELECT o.*, s.name AS shop_name, s.platform,
        (SELECT COALESCE(SUM(quantity),0) FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o JOIN shops s ON s.id = o.shop_id WHERE ${where} ORDER BY o.order_time DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    res.json({ total, rows });
  });

  r.get('/orders/export.csv', requirePerm('orders.view', 'export.data'), (req, res) => {
    const { where, params } = orderWhere(req);
    const rows = db.all(
      `SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id = o.shop_id WHERE ${where} ORDER BY o.order_time DESC LIMIT 100000`, params);
    sendCsv(req, res, 'orders', rows, [
      { label: '店铺', key: 'shop_name' }, { label: '订单号', key: 'external_order_id' },
      { label: '下单时间(MYT)', value: (x) => new Date(Date.parse(x.order_time) + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) },
      { label: '状态', key: 'status' }, { label: '订单金额(MYR)', value: (x) => fromSen(x.total_sen).toFixed(2) },
      { label: '数据来源', key: 'data_source' },
    ]);
  });

  r.get('/orders/:id', requirePerm('orders.view'), (req, res) => {
    const o = db.get('SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.id = ?', [Number(req.params.id)]);
    if (!o) throw new HttpError(404, 'not_found', '订单不存在');
    assertShop(req, o.shop_id);
    o.items = db.all('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
    o.refunds = db.all('SELECT * FROM refunds WHERE order_id = ?', [o.id]);
    res.json(o);
  });

  /** 人工录入订单（无 API 权限时使用，data_source = manual） */
  r.post('/orders', requirePerm('orders.manage'), (req, res) => {
    const b = req.body || {};
    requireFields(b, ['shopId', 'externalOrderId', 'orderTime', 'status']);
    assertShop(req, b.shopId);
    const items = (b.items || []).filter((i) => i.sellerSku || i.productName).map((i) => ({
      sellerSku: i.sellerSku, productName: i.productName, quantity: Math.floor(toNum(i.quantity, 1)), unitPriceSen: toSen(i.unitPrice),
    }));
    const itemsTotal = items.reduce((a, i) => a + i.quantity * i.unitPriceSen, 0);
    const orderTime = parseLocalTime(b.orderTime);
    const result = upsertOrder(db, Number(b.shopId), {
      externalOrderId: String(b.externalOrderId).trim(), orderTime, status: b.status,
      totalSen: b.total !== undefined && b.total !== '' ? toSen(b.total) : itemsTotal, shippingFeeSen: toSen(b.shippingFee), buyerNote: b.note, items,
    }, 'manual');
    if (result.skipped) throw new HttpError(409, 'source_conflict', result.reason);
    audit(db, req, 'order.manual_upsert', 'order', result.id, { externalOrderId: b.externalOrderId, shopId: b.shopId });
    res.json(result);
  });

  r.delete('/orders/:id', requirePerm('orders.manage'), (req, res) => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', [Number(req.params.id)]);
    if (!o) throw new HttpError(404, 'not_found', '订单不存在');
    assertShop(req, o.shop_id);
    if (o.data_source === 'api') throw new HttpError(409, 'api_managed', '平台同步的订单不能在本地删除');
    db.run('DELETE FROM orders WHERE id = ?', [o.id]);
    audit(db, req, 'order.delete', 'order', o.id, { externalOrderId: o.external_order_id, totalSen: o.total_sen, source: o.data_source });
    res.json({ ok: true });
  });

  /**
   * CSV 导入订单（如从 TikTok Seller Center 导出的订单报表整理而来）
   * 必需列：order_id, order_time(YYYY-MM-DD HH:mm, 马来西亚时间), status, total
   * 可选列：seller_sku, product_name, quantity, unit_price（同一订单多行 = 多个商品行）
   */
  r.post('/import/orders', requirePerm('orders.manage'), express.text({ type: '*/*', limit: '20mb' }), (req, res) => {
    const shop = assertShop(req, req.query.shopId);
    const rows = parseCsv(String(req.body || ''));
    if (!rows.length) throw new HttpError(400, 'empty_file', 'CSV 为空');
    for (const col of ['order_id', 'order_time', 'status', 'total']) {
      if (!(col in rows[0])) throw new HttpError(400, 'missing_column', `CSV 缺少列: ${col}`);
    }
    const grouped = new Map();
    const errors = [];
    rows.forEach((row, i) => {
      try {
        const id = row.order_id;
        if (!id) throw new Error('order_id 为空');
        const g = grouped.get(id) || { externalOrderId: id, orderTime: parseLocalTime(row.order_time), status: row.status, totalSen: toSen(row.total), items: [] };
        if (row.seller_sku || row.product_name) {
          g.items.push({ sellerSku: row.seller_sku, productName: row.product_name, quantity: Math.floor(toNum(row.quantity, 1)), unitPriceSen: toSen(row.unit_price) });
        }
        grouped.set(id, g);
      } catch (e) {
        errors.push({ line: i + 2, error: e.message });
      }
    });
    let created = 0, updated = 0, skipped = 0;
    for (const o of grouped.values()) {
      try {
        const r2 = upsertOrder(db, shop.id, o, 'import');
        if (r2.skipped) skipped++; else if (r2.created) created++; else updated++;
      } catch (e) {
        errors.push({ orderId: o.externalOrderId, error: e.message });
      }
    }
    audit(db, req, 'import.orders', 'shop', shop.id, { created, updated, skipped, errors: errors.length });
    evaluateAlerts(db);
    res.json({ created, updated, skipped, errors });
  });

  /** CSV 导入商品：seller_sku, title, price 必需；可选 stock, category, sku_name */
  r.post('/import/products', requirePerm('products.manage'), express.text({ type: '*/*', limit: '20mb' }), (req, res) => {
    const shop = assertShop(req, req.query.shopId);
    const rows = parseCsv(String(req.body || ''));
    if (!rows.length) throw new HttpError(400, 'empty_file', 'CSV 为空');
    for (const col of ['seller_sku', 'title', 'price']) {
      if (!(col in rows[0])) throw new HttpError(400, 'missing_column', `CSV 缺少列: ${col}`);
    }
    let ok = 0;
    const errors = [];
    rows.forEach((row, i) => {
      try {
        const existing = db.get('SELECT product_id, data_source FROM skus WHERE shop_id = ? AND seller_sku = ?', [shop.id, row.seller_sku]);
        if (existing?.data_source === 'api') throw new Error('该 SKU 由平台接口管理，已跳过');
        upsertProduct(db, shop.id, {
          title: row.title, category: row.category, productId: existing?.product_id,
          skus: [{ sellerSku: row.seller_sku, name: row.sku_name, priceSen: toSen(row.price), stock: row.stock === '' || row.stock === undefined ? null : Math.floor(toNum(row.stock)) }],
        }, 'import');
        ok++;
      } catch (e) {
        errors.push({ line: i + 2, error: e.message });
      }
    });
    audit(db, req, 'import.products', 'shop', shop.id, { ok, errors: errors.length });
    evaluateAlerts(db);
    res.json({ ok, errors });
  });

  function orderWhere(req) {
    const f = shopFilterSql(db, req.user, 'o.shop_id', req.query.shopId);
    const where = [f.sql], params = [...f.params];
    if (req.query.from || req.query.to) {
      const { start, end } = klRangeUtc(req.query.from || '2000-01-01', req.query.to || klDate());
      where.push('o.order_time >= ? AND o.order_time < ?');
      params.push(start, end);
    }
    if (req.query.status) { where.push('o.status = ?'); params.push(req.query.status); }
    if (req.query.source) { where.push('o.data_source = ?'); params.push(req.query.source); }
    if (req.query.q) { where.push('o.external_order_id LIKE ?'); params.push(`%${req.query.q}%`); }
    return { where: where.join(' AND '), params };
  }

  // ================= 退款退货 =================
  r.get('/refunds', requirePerm('refunds.view'), (req, res) => {
    const f = shopFilterSql(db, req.user, 'r.shop_id', req.query.shopId);
    const where = [f.sql], params = [...f.params];
    if (req.query.from || req.query.to) {
      const { start, end } = klRangeUtc(req.query.from || '2000-01-01', req.query.to || klDate());
      where.push('r.refund_time >= ? AND r.refund_time < ?');
      params.push(start, end);
    }
    res.json(db.all(`SELECT r.*, s.name AS shop_name FROM refunds r JOIN shops s ON s.id = r.shop_id WHERE ${where.join(' AND ')} ORDER BY r.refund_time DESC LIMIT 2000`, params));
  });

  r.post('/refunds', requirePerm('refunds.manage'), (req, res) => {
    const b = req.body || {};
    requireFields(b, ['shopId', 'amount', 'refundTime']);
    assertShop(req, b.shopId);
    if (!['refund', 'return_and_refund', 'replacement'].includes(b.type || 'refund')) throw new HttpError(400, 'invalid_type', '类型无效');
    if (!['pending', 'approved', 'completed', 'rejected'].includes(b.status || 'pending')) throw new HttpError(400, 'invalid_status', '状态无效');
    const result = upsertRefund(db, Number(b.shopId), {
      externalRefundId: b.externalRefundId || `manual-${Date.now()}`, externalOrderId: b.externalOrderId, type: b.type,
      amountSen: toSen(b.amount), reason: b.reason, status: b.status, refundTime: parseLocalTime(b.refundTime),
    }, 'manual');
    audit(db, req, 'refund.manual_upsert', 'refund', result.id, b);
    evaluateAlerts(db);
    res.json(result);
  });

  // ================= 广告花费 =================
  r.get('/ads', requirePerm('dashboard.view'), (req, res) => {
    const f = shopFilterSql(db, req.user, 'a.shop_id', req.query.shopId);
    res.json(db.all(`SELECT a.*, s.name AS shop_name FROM ad_spend a JOIN shops s ON s.id = a.shop_id WHERE ${f.sql} ORDER BY a.date DESC LIMIT 1000`, f.params));
  });

  r.post('/ads', requirePerm('ads.manage'), (req, res) => {
    const b = req.body || {};
    requireFields(b, ['shopId', 'date', 'spend']);
    assertShop(req, b.shopId);
    klRangeUtc(b.date, b.date);
    const channel = (b.channel || 'GMV Max').slice(0, 64);
    const ex = db.get('SELECT data_source FROM ad_spend WHERE shop_id = ? AND date = ? AND channel = ?', [Number(b.shopId), b.date, channel]);
    if (ex?.data_source === 'api') throw new HttpError(409, 'api_managed', '该日广告数据来自平台接口，不能人工覆盖');
    db.run(
      `INSERT INTO ad_spend (shop_id, date, channel, spend_sen, attributed_gmv_sen, data_source, note, created_at) VALUES (?,?,?,?,?,'manual',?,?)
       ON CONFLICT(shop_id, date, channel) DO UPDATE SET spend_sen = excluded.spend_sen, attributed_gmv_sen = excluded.attributed_gmv_sen, note = excluded.note`,
      [Number(b.shopId), b.date, channel, toSen(b.spend), b.attributedGmv === undefined || b.attributedGmv === '' ? null : toSen(b.attributedGmv), b.note || null, nowIso()],
    );
    audit(db, req, 'ad_spend.upsert', 'shop', b.shopId, b);
    res.json({ ok: true });
  });

  r.delete('/ads/:id', requirePerm('ads.manage'), (req, res) => {
    const a = db.get('SELECT * FROM ad_spend WHERE id = ?', [Number(req.params.id)]);
    if (!a) throw new HttpError(404, 'not_found', '记录不存在');
    assertShop(req, a.shop_id);
    if (a.data_source === 'api') throw new HttpError(409, 'api_managed', '平台同步数据不能删除');
    db.run('DELETE FROM ad_spend WHERE id = ?', [a.id]);
    audit(db, req, 'ad_spend.delete', 'ad_spend', a.id, a);
    res.json({ ok: true });
  });

  // ================= 经营总览 =================
  r.get('/dashboard', requirePerm('dashboard.view'), (req, res) => {
    res.json(getDashboard(db, req.user, req.query));
  });

  r.get('/dashboard/export.csv', requirePerm('dashboard.view', 'export.data'), (req, res) => {
    const d = getDashboard(db, req.user, req.query);
    const money = (v) => (v == null ? '' : fromSen(v).toFixed(2));
    const rows = [
      ['统计区间', `${d.period.from} ~ ${d.period.to}`, ''],
      ['今日销售额(MYR)', money(d.fixed.today.sales), sourceLabel(d.fixed.today.bySource)],
      ['昨日销售额(MYR)', money(d.fixed.yesterday.sales), sourceLabel(d.fixed.yesterday.bySource)],
      ['近7天销售额(MYR)', money(d.fixed.last7.sales), sourceLabel(d.fixed.last7.bySource)],
      ['近30天销售额(MYR)', money(d.fixed.last30.sales), sourceLabel(d.fixed.last30.bySource)],
      ['区间销售额(MYR)', money(d.range.sales.valueSen), sourceLabel(d.range.sales.bySource)],
      ['订单数', d.range.orders.value, sourceLabel(d.range.orders.bySource)],
      ['客单价(MYR)', money(d.range.aov.valueSen), ''],
      ['退款金额(MYR)', money(d.range.refunds.valueSen), sourceLabel(d.range.refunds.bySource)],
      ['广告花费(MYR)', money(d.range.adSpend.valueSen), sourceLabel(d.range.adSpend.bySource)],
      ['广告 ROAS', d.range.roas.value ?? '', ''],
    ];
    if (d.range.grossProfit) {
      rows.push(['商品毛利(MYR)', money(d.range.grossProfit.valueSen), d.range.grossProfit.coveragePct === null ? '无数据' : `估算；成本覆盖率 ${d.range.grossProfit.coveragePct}%`]);
      rows.push(['预估净利润(MYR)', money(d.range.netProfit.valueSen), d.range.netProfit.valueSen === null ? '无数据' : '估算']);
    }
    rows.push(['', '', ''], ['店铺排名', '', '']);
    d.ranking.forEach((s, i) => rows.push([`${i + 1}. ${s.name}`, money(s.sales), `${s.orders} 单`]));
    sendCsv(req, res, 'dashboard', rows, [{ label: '指标', value: (x) => x[0] }, { label: '数值', value: (x) => x[1] }, { label: '数据来源/备注', value: (x) => x[2] }]);
  });

  // ================= 异常提醒 =================
  r.get('/alerts', requirePerm('alerts.view'), (req, res) => {
    const f = shopFilterSql(db, req.user, 'a.shop_id', req.query.shopId);
    const open = req.query.status !== 'resolved';
    res.json(db.all(
      `SELECT a.*, s.name AS shop_name FROM alerts a LEFT JOIN shops s ON s.id = a.shop_id
       WHERE (a.shop_id IS NULL OR ${f.sql}) AND a.resolved_at IS ${open ? '' : 'NOT'} NULL
       ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.created_at DESC LIMIT 500`,
      f.params,
    ));
  });

  r.post('/alerts/refresh', requirePerm('alerts.view'), (req, res) => res.json(evaluateAlerts(db)));

  r.post('/alerts/:id/resolve', requirePerm('alerts.manage'), (req, res) => {
    const a = db.get('SELECT * FROM alerts WHERE id = ?', [Number(req.params.id)]);
    if (!a) throw new HttpError(404, 'not_found', '提醒不存在');
    if (a.shop_id) assertShop(req, a.shop_id);
    db.run('UPDATE alerts SET resolved_at = ?, resolved_by = ? WHERE id = ?', [nowIso(), req.user.id, a.id]);
    audit(db, req, 'alert.resolve', 'alert', a.id, { rule: a.rule, message: a.message });
    res.json({ ok: true });
  });

  r.get('/meta/order-statuses', (req, res) => res.json(ORDER_STATUSES));

  return r;
};

function pickCost(c) {
  return {
    purchase_cost_sen: c.purchase_cost_sen, packaging_cost_sen: c.packaging_cost_sen, commission_rate: c.commission_rate,
    transaction_fee_rate: c.transaction_fee_rate, shipping_cost_sen: c.shipping_cost_sen, shipping_subsidy_sen: c.shipping_subsidy_sen,
    affiliate_rate: c.affiliate_rate, seller_discount_sen: c.seller_discount_sen, ad_cost_per_unit_sen: c.ad_cost_per_unit_sen,
    other_cost_sen: c.other_cost_sen, notes: c.notes, updated_at: c.updated_at,
  };
}

/** "2026-11-09 14:30" 视为马来西亚时间；带时区的 ISO 字符串保持原样 */
function parseLocalTime(s) {
  const str = String(s).trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(str)) {
    const t = Date.parse(str);
    if (Number.isNaN(t)) throw new HttpError(400, 'invalid_time', `时间格式错误: ${s}`);
    return new Date(t).toISOString();
  }
  const m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new HttpError(400, 'invalid_time', `时间格式错误: ${s}（应为 YYYY-MM-DD HH:mm）`);
  const [, y, mo, d, h = '0', mi = '0', se = '0'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +se)).toISOString();
}

function sourceLabel(bySource = {}) {
  const names = { api: '平台实际', manual: '人工录入', import: '文件导入', estimate: '估算' };
  return Object.keys(bySource).map((k) => names[k] || k).join(' + ');
}

module.exports.parseLocalTime = parseLocalTime;
