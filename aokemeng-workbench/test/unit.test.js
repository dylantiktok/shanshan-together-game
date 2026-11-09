'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { calcUnitProfit, priceForTargetMargin } = require('../server/services/profit');
const { sign: ttSign, mapOrder } = require('../server/integrations/tiktok');
const { larkSign } = require('../server/integrations/lark');
const { parseCsv, toCsv, klDate, klDayStartUtc, toSen } = require('../server/util');
const { parseLocalTime } = require('../server/routes/business');

test('利润计算：费率以成交价为基数，固定成本逐项扣减', () => {
  const r = calcUnitProfit({
    price_sen: 2990, purchase_cost_sen: 950, packaging_cost_sen: 80, commission_rate: 6, transaction_fee_rate: 2.16,
    shipping_cost_sen: 500, shipping_subsidy_sen: 200, affiliate_rate: 10,
  });
  assert.equal(r.breakdown.commissionSen, 179);
  assert.equal(r.breakdown.transactionFeeSen, 65);
  assert.equal(r.breakdown.affiliateSen, 299);
  assert.equal(r.totalCostSen, 950 + 80 + 300 + 179 + 65 + 299);
  assert.equal(r.profitSen, 2990 - r.totalCostSen);
  assert.equal(r.isLoss, false);
  // 保本价验证：以保本价计算利润应 >= 0 且接近 0
  const be = calcUnitProfit({ ...r, price_sen: r.breakEvenPriceSen, purchase_cost_sen: 950, packaging_cost_sen: 80, commission_rate: 6, transaction_fee_rate: 2.16, shipping_cost_sen: 500, shipping_subsidy_sen: 200, affiliate_rate: 10 });
  assert.ok(be.profitSen >= 0 && be.profitSen <= 2, `break-even profit ${be.profitSen}`);
});

test('利润计算：商家优惠降低成交价；亏损识别；目标利润率售价', () => {
  const input = { price_sen: 1000, seller_discount_sen: 200, purchase_cost_sen: 700, commission_rate: 10 };
  const r = calcUnitProfit(input);
  assert.equal(r.netPriceSen, 800);
  assert.equal(r.profitSen, 800 - 700 - 80);
  const loss = calcUnitProfit({ price_sen: 500, purchase_cost_sen: 600 });
  assert.equal(loss.isLoss, true);
  const target = priceForTargetMargin({ purchase_cost_sen: 700, commission_rate: 10 }, 20);
  const check = calcUnitProfit({ price_sen: target, purchase_cost_sen: 700, commission_rate: 10 });
  assert.ok(check.marginPct >= 20 && check.marginPct < 20.2);
  assert.equal(priceForTargetMargin({ purchase_cost_sen: 1, commission_rate: 60 }, 50), null);
});

test('TikTok 签名：排除 sign/access_token，排序拼接 path+参数+body，首尾包裹 secret', () => {
  const secret = 'test_secret';
  const q = { timestamp: 1700000000, app_key: 'abc', shop_cipher: 'C1', access_token: 'SHOULD_SKIP', sign: 'x' };
  const body = '{"a":1}';
  const expected = crypto.createHmac('sha256', secret)
    .update(`${secret}/order/202309/orders/searchapp_keyabcshop_cipherC1timestamp1700000000${body}${secret}`).digest('hex');
  assert.equal(ttSign('/order/202309/orders/search', q, body, secret), expected);
});

test('TikTok 订单映射：逐件行合并为数量，金额转 sen，时间转 ISO', () => {
  const o = mapOrder({
    id: '5768', status: 'COMPLETED', create_time: 1762650000, payment: { total_amount: '59.80', shipping_fee: '4.90' },
    line_items: [{ sku_id: 's1', seller_sku: 'AKM', sale_price: '29.90' }, { sku_id: 's1', seller_sku: 'AKM', sale_price: '29.90' }],
  });
  assert.equal(o.totalSen, 5980);
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].quantity, 2);
  assert.equal(o.status, 'completed');
  assert.equal(o.orderTime, new Date(1762650000 * 1000).toISOString());
});

test('飞书签名：HMAC-SHA256(key=timestamp\\nsecret, 空消息) Base64', () => {
  const expected = crypto.createHmac('sha256', '1700000000\nsec').update('').digest('base64');
  assert.equal(larkSign('1700000000', 'sec'), expected);
});

test('时区：马来西亚 UTC+8 日期边界', () => {
  assert.equal(klDayStartUtc('2026-11-09'), '2026-11-08T16:00:00.000Z');
  assert.equal(klDate(new Date('2026-11-08T16:30:00Z')), '2026-11-09');
  assert.equal(parseLocalTime('2026-11-09 14:30'), '2026-11-09T06:30:00.000Z');
  assert.equal(parseLocalTime('2026-11-09T06:30:00Z'), '2026-11-09T06:30:00.000Z');
  assert.throws(() => parseLocalTime('09/11/2026'));
});

test('CSV 解析与导出（引号、逗号、BOM）', () => {
  const rows = parseCsv('﻿order_id,product_name,total\r\n1,"洗衣液, 3kg ""大""",29.90\n');
  assert.deepEqual(rows, [{ order_id: '1', product_name: '洗衣液, 3kg "大"', total: '29.90' }]);
  const out = toCsv([{ a: 'x,y' }], [{ label: 'A', key: 'a' }]);
  assert.equal(out, '﻿A\r\n"x,y"');
  assert.equal(toSen('RM 1,234.50'), 123450);
});
