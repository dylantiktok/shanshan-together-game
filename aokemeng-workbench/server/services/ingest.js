'use strict';
/**
 * 统一入库：平台同步(api)、CSV 导入(import)、人工录入(manual) 都通过这里写入，
 * 保证去重键一致，且不会用低可信来源覆盖平台实际数据。
 */
const { nowIso, HttpError } = require('../util');

const ORDER_STATUSES = ['unpaid', 'on_hold', 'awaiting_shipment', 'awaiting_collection', 'in_transit', 'delivered', 'completed', 'cancelled'];
const SOURCE_RANK = { estimate: 0, manual: 1, import: 2, api: 3 };

function normalizeOrderStatus(s) {
  const v = String(s || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'canceled') return 'cancelled';
  if (ORDER_STATUSES.includes(v)) return v;
  const map = { 已取消: 'cancelled', 待付款: 'unpaid', 待发货: 'awaiting_shipment', 已发货: 'in_transit', 已签收: 'delivered', 已完成: 'completed' };
  if (map[s]) return map[s];
  throw new HttpError(400, 'invalid_status', `未知订单状态: ${s}`);
}

function findSkuId(db, shopId, sellerSku, externalSkuId) {
  if (externalSkuId) {
    const r = db.get('SELECT id FROM skus WHERE shop_id = ? AND external_sku_id = ?', [shopId, String(externalSkuId)]);
    if (r) return r.id;
  }
  if (sellerSku) {
    const r = db.get('SELECT id FROM skus WHERE shop_id = ? AND seller_sku = ?', [shopId, String(sellerSku)]);
    if (r) return r.id;
  }
  return null;
}

/**
 * order: { externalOrderId, orderTime(ISO), status, totalSen, shippingFeeSen, buyerNote,
 *          items: [{ sellerSku, externalSkuId, productName, quantity, unitPriceSen }] }
 */
function upsertOrder(db, shopId, order, source) {
  return db.tx(() => {
    const existing = db.get('SELECT id, data_source FROM orders WHERE shop_id = ? AND external_order_id = ?', [shopId, order.externalOrderId]);
    if (existing && SOURCE_RANK[existing.data_source] > SOURCE_RANK[source]) {
      return { id: existing.id, skipped: true, reason: `已存在更高可信度来源(${existing.data_source})的数据` };
    }
    const status = normalizeOrderStatus(order.status);
    const t = nowIso();
    let id;
    if (existing) {
      id = existing.id;
      db.run(
        `UPDATE orders SET order_time=?, status=?, total_sen=?, shipping_fee_sen=?, buyer_note=?, data_source=?, updated_at=? WHERE id=?`,
        [order.orderTime, status, order.totalSen, order.shippingFeeSen || 0, order.buyerNote || null, source, t, id],
      );
      db.run('DELETE FROM order_items WHERE order_id = ?', [id]);
    } else {
      id = db.run(
        `INSERT INTO orders (shop_id, external_order_id, order_time, status, total_sen, shipping_fee_sen, buyer_note, data_source, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [shopId, order.externalOrderId, order.orderTime, status, order.totalSen, order.shippingFeeSen || 0, order.buyerNote || null, source, t, t],
      ).lastId;
    }
    for (const it of order.items || []) {
      db.run(
        'INSERT INTO order_items (order_id, sku_id, seller_sku, product_name, quantity, unit_price_sen) VALUES (?,?,?,?,?,?)',
        [id, findSkuId(db, shopId, it.sellerSku, it.externalSkuId), it.sellerSku || null, it.productName || null,
          Math.max(1, Math.floor(it.quantity || 1)), it.unitPriceSen || 0],
      );
    }
    return { id, created: !existing };
  });
}

/** product: { externalProductId, title, category, status, skus: [{ sellerSku, externalSkuId, name, priceSen, stock }] } */
function upsertProduct(db, shopId, product, source) {
  return db.tx(() => {
    const t = nowIso();
    let row = null;
    if (product.productId) row = db.get('SELECT id FROM products WHERE shop_id = ? AND id = ?', [shopId, product.productId]);
    else if (product.externalProductId) row = db.get('SELECT id FROM products WHERE shop_id = ? AND external_product_id = ?', [shopId, product.externalProductId]);
    let productId;
    if (row) {
      productId = row.id;
      db.run('UPDATE products SET title=?, category=COALESCE(?, category), status=?, data_source=?, updated_at=? WHERE id=?',
        [product.title, product.category || null, product.status || 'active', source, t, productId]);
    } else {
      productId = db.run(
        'INSERT INTO products (shop_id, external_product_id, title, category, status, data_source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [shopId, product.externalProductId || null, product.title, product.category || null, product.status || 'active', source, t, t],
      ).lastId;
    }
    for (const s of product.skus || []) upsertSku(db, shopId, productId, s, source);
    return { id: productId, created: !row };
  });
}

function upsertSku(db, shopId, productId, s, source) {
  if (!s.sellerSku) throw new HttpError(400, 'missing_seller_sku', 'SKU 缺少商家编码 (seller_sku)');
  const t = nowIso();
  const ex = db.get('SELECT id FROM skus WHERE shop_id = ? AND (seller_sku = ? OR (external_sku_id IS NOT NULL AND external_sku_id = ?))',
    [shopId, s.sellerSku, s.externalSkuId || '\u0000']);
  if (ex) {
    db.run(
      `UPDATE skus SET product_id=?, seller_sku=?, external_sku_id=COALESCE(?, external_sku_id), name=COALESCE(?, name),
       price_sen=?, stock=?, data_source=?, updated_at=? WHERE id=?`,
      [productId, s.sellerSku, s.externalSkuId || null, s.name || null, s.priceSen, s.stock ?? null, source, t, ex.id],
    );
    return ex.id;
  }
  return db.run(
    `INSERT INTO skus (product_id, shop_id, seller_sku, external_sku_id, name, price_sen, stock, data_source, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [productId, shopId, s.sellerSku, s.externalSkuId || null, s.name || null, s.priceSen || 0, s.stock ?? null, source, t],
  ).lastId;
}

/** refund: { externalRefundId, externalOrderId, type, amountSen, reason, status, refundTime } */
function upsertRefund(db, shopId, r, source) {
  const order = r.externalOrderId
    ? db.get('SELECT id FROM orders WHERE shop_id = ? AND external_order_id = ?', [shopId, r.externalOrderId])
    : null;
  const ex = r.externalRefundId
    ? db.get('SELECT id, data_source FROM refunds WHERE shop_id = ? AND external_refund_id = ?', [shopId, r.externalRefundId])
    : null;
  if (ex) {
    if (SOURCE_RANK[ex.data_source] > SOURCE_RANK[source]) return { id: ex.id, skipped: true };
    db.run(
      'UPDATE refunds SET order_id=?, external_order_id=?, type=?, amount_sen=?, reason=?, status=?, refund_time=?, data_source=? WHERE id=?',
      [order?.id ?? null, r.externalOrderId || null, r.type || 'refund', r.amountSen, r.reason || null, r.status || 'pending', r.refundTime, source, ex.id],
    );
    return { id: ex.id, created: false };
  }
  const id = db.run(
    `INSERT INTO refunds (shop_id, order_id, external_refund_id, external_order_id, type, amount_sen, reason, status, refund_time, data_source, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [shopId, order?.id ?? null, r.externalRefundId || null, r.externalOrderId || null, r.type || 'refund', r.amountSen,
      r.reason || null, r.status || 'pending', r.refundTime, source, nowIso()],
  ).lastId;
  return { id, created: true };
}

module.exports = { upsertOrder, upsertProduct, upsertSku, upsertRefund, normalizeOrderStatus, ORDER_STATUSES };
