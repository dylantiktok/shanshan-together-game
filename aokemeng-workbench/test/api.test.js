'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startServer } = require('../server');
const { sign } = require('../server/integrations/tiktok');

let srv, url, token, dir;

async function call(method, p, body, tk = token, contentType) {
  const headers = {};
  if (tk) headers.authorization = `Bearer ${tk}`;
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['content-type'] = contentType || 'application/json';
  }
  const r = await fetch(url + '/api' + p, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}

const waitJobs = async (shopId, done = (jobs) => jobs.every((j) => !['pending', 'running'].includes(j.status))) => {
  for (let i = 0; i < 50; i++) {
    const { body } = await call('GET', `/sync/jobs?shopId=${shopId}`);
    if (body.length && done(body)) return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('jobs did not finish');
};

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-test-'));
  const s = await startServer({ dataDir: dir });
  srv = s;
  url = s.url;
});
test.after(() => {
  srv.server.close();
  srv.ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('首次初始化只能执行一次，弱密码被拒绝', async () => {
  assert.equal((await call('GET', '/system/status')).body.needsSetup, true);
  assert.equal((await call('POST', '/system/setup', { username: 'boss', displayName: 'B', password: 'short' })).status, 400);
  const r = await call('POST', '/system/setup', { username: 'boss', displayName: 'Boss', password: 'Passw0rd1' });
  assert.equal(r.status, 200);
  token = r.body.session.token;
  assert.equal(r.body.user.role, 'director');
  assert.equal((await call('POST', '/system/setup', { username: 'x', displayName: 'x', password: 'Passw0rd1' })).status, 409);
});

test('未登录访问被拒绝；错误密码记录日志', async () => {
  assert.equal((await call('GET', '/dashboard', undefined, null)).status, 401);
  assert.equal((await call('POST', '/auth/login', { username: 'boss', password: 'wrong' }, null)).status, 401);
  const logs = (await call('GET', '/audit-logs?action=auth.login_failed')).body;
  assert.ok(logs.length >= 1);
});

test('没有数据时经营总览为空，不生成虚假数据', async () => {
  const d = (await call('GET', '/dashboard')).body;
  assert.equal(d.hasData, false);
  assert.equal(d.range.sales.valueSen, 0);
  assert.deepEqual(d.range.sales.bySource, {});
});

test('多店铺 + 员工权限：店铺运营只能看到分配的店铺，且看不到用户管理', async () => {
  const a = (await call('POST', '/shops', { platform: 'tiktok', name: 'Shop A' })).body.id;
  const b = (await call('POST', '/shops', { platform: 'tiktok', name: 'Shop B' })).body.id;
  await call('POST', '/products', { shopId: a, title: '洗衣液', sellerSku: 'A-1', price: '20', stock: 100 });
  await call('POST', '/products', { shopId: b, title: '油污清洁剂', sellerSku: 'B-1', price: '15', stock: 100 });
  const cu = await call('POST', '/users', { username: 'op', displayName: 'Op', password: 'Passw0rd1', role: 'shop_operator', shopIds: [a] });
  assert.equal(cu.status, 200);
  const login = await call('POST', '/auth/login', { username: 'op', password: 'Passw0rd1' }, null);
  const op = login.body.session.token;
  assert.equal(login.body.user.mustChangePassword, true);
  const shops = (await call('GET', '/shops', undefined, op)).body;
  assert.deepEqual(shops.map((s) => s.name), ['Shop A']);
  const products = (await call('GET', '/products', undefined, op)).body;
  assert.deepEqual(products.map((p) => p.sellerSku), ['A-1']);
  assert.equal((await call('GET', `/products?shopId=${b}`, undefined, op)).body.length, 0);
  assert.equal((await call('GET', '/users', undefined, op)).status, 403);
  assert.equal((await call('PUT', '/skus/1/cost', { purchase_cost: 1 }, op)).status, 403); // 运营无 costs.manage
  assert.equal((await call('POST', '/orders', { shopId: b, externalOrderId: 'x', orderTime: '2026-11-01 10:00', status: 'completed' }, op)).status, 403);
  // 运营不能创建董事
  assert.equal((await call('POST', '/users', { username: 'd2', displayName: 'd', password: 'Passw0rd1', role: 'director' }, op)).status, 403);
  // 主播看不到财务数据
  await call('POST', '/users', { username: 'host', displayName: 'Host', password: 'Passw0rd1', role: 'host', shopIds: [a] });
  const ht = (await call('POST', '/auth/login', { username: 'host', password: 'Passw0rd1' }, null)).body.session.token;
  const hd = (await call('GET', '/dashboard', undefined, ht)).body;
  assert.equal(hd.range.grossProfit, undefined);
  assert.equal(hd.ranking[0].ad_spend, undefined);
  assert.equal((await call('GET', '/products', undefined, ht)).body[0].cost, undefined);
});

test('人工录入订单 + 成本档案 → 总览区分来源，毛利为估算', async () => {
  await call('PUT', '/skus/1/cost', { purchase_cost: '8', packaging_cost: '1', commission_rate: 5, transaction_fee_rate: 2 });
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const r = await call('POST', '/orders', { shopId: 1, externalOrderId: 'M-1', orderTime: now, status: 'completed', items: [{ sellerSku: 'A-1', quantity: 2, unitPrice: '20' }] });
  assert.equal(r.status, 200);
  await call('POST', '/orders', { shopId: 1, externalOrderId: 'M-2', orderTime: now, status: 'cancelled', total: '99' });
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  await call('POST', '/ads', { shopId: 1, date: today, spend: '10' });
  const d = (await call('GET', '/dashboard')).body;
  assert.equal(d.fixed.today.sales, 4000); // 已取消订单不计入
  assert.deepEqual(Object.keys(d.range.sales.bySource), ['manual']);
  assert.equal(d.range.roas.value, 4);
  // 每件：20 - 8 - 1 - 1 - 0.4 = 9.6 → 2 件 = 19.20
  assert.equal(d.range.grossProfit.valueSen, 1920);
  assert.equal(d.range.grossProfit.source, 'estimate');
  assert.equal(d.range.netProfit.valueSen, 920);
  const csv = await call('GET', '/dashboard/export.csv');
  assert.match(csv.body, /人工录入/);
});

test('CSV 导入订单并去重', async () => {
  const csv = 'order_id,order_time,status,total,seller_sku,quantity,unit_price\nI-1,2026-11-01 10:00,completed,40,A-1,1,20\nI-1,2026-11-01 10:00,completed,40,A-1,1,20\nI-2,2026-11-02 11:00,delivered,20,A-1,1,20\nI-3,bad-date,completed,1,,,\n';
  const r = await call('POST', '/import/orders?shopId=1', csv, token, 'text/csv');
  assert.equal(r.body.created, 2);
  assert.equal(r.body.errors.length, 1);
  const again = await call('POST', '/import/orders?shopId=1', csv, token, 'text/csv');
  assert.equal(again.body.created, 0);
  assert.equal(again.body.updated, 2);
  const detail = (await call('GET', '/orders?q=I-1')).body.rows[0];
  assert.equal(detail.data_source, 'import');
  assert.equal(detail.item_count, 2);
});

test('未连接的接口：同步任务标记 not_connected，绝不显示成功', async () => {
  const r = await call('POST', '/sync/jobs', { shopId: 1, jobType: 'all' });
  assert.equal(r.body.jobs.length, 4);
  const jobs = await waitJobs(1);
  assert.ok(jobs.every((j) => j.status === 'not_connected'), JSON.stringify(jobs.map((j) => j.status)));
  const shopee = (await call('POST', '/shops', { platform: 'shopee', name: 'Shopee MY' })).body.id;
  await call('PUT', '/integrations/shopee', { partnerId: '1', partnerKey: 'k' });
  await call('POST', '/sync/jobs', { shopId: shopee, jobType: 'orders' });
  const sj = await waitJobs(shopee);
  assert.equal(sj[0].status, 'not_connected');
  const ai = (await call('POST', '/ai/analyze', { provider: 'anthropic', question: 'hi' })).body;
  assert.equal(ai.error, 'not_connected');
  const integ = (await call('GET', '/integrations')).body;
  assert.equal(integ.anthropic.status.state, 'not_connected');
});

test('密钥加密存储，接口只返回遮盖值', async () => {
  await call('PUT', '/integrations/anthropic', { apiKey: 'sk-ant-secret-123456', model: 'claude-opus-5-5' });
  const integ = (await call('GET', '/integrations')).body;
  assert.equal(integ.anthropic.config.apiKey, '****3456');
  assert.equal(integ.anthropic.status.state, 'unverified');
  srv.ctx.db.flush();
  assert.ok(!fs.readFileSync(path.join(dir, 'workbench.sqlite')).includes('sk-ant-secret-123456'));
  const logs = JSON.stringify((await call('GET', '/audit-logs?action=integration')).body);
  assert.ok(!logs.includes('sk-ant-secret'));
});

test('离线：网络不可用时任务进入 waiting_network 等待重试', async () => {
  await call('PUT', '/integrations/tiktok', { appKey: 'k', appSecret: 's', apiBase: 'http://127.0.0.1:9' });
  await call('PUT', '/integrations/tiktok/shops/2', { accessToken: 'tok', shopCipher: 'C' });
  await call('POST', '/sync/jobs', { shopId: 2, jobType: 'orders' });
  const jobs = await waitJobs(2);
  assert.equal(jobs[0].status, 'waiting_network');
  assert.match(jobs[0].last_error, /网络/);
});

test('TikTok 官方接口适配：签名校验 + 订单/商品同步写入为平台实际数据', async () => {
  const seen = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const q = Object.fromEntries(u.searchParams);
      const ok = q.sign === sign(u.pathname, q, body, 'secret') && req.headers['x-tts-access-token'] === 'tok';
      seen.push(u.pathname);
      res.setHeader('content-type', 'application/json');
      if (!ok) return res.end(JSON.stringify({ code: 106001, message: 'invalid sign' }));
      const data = u.pathname.includes('/orders/search')
        ? { orders: [{ id: 'TT-100', status: 'AWAITING_SHIPMENT', create_time: Math.floor(Date.now() / 1000), payment: { total_amount: '39.80' }, line_items: [{ sku_id: '9', seller_sku: 'B-1', sale_price: '19.90' }, { sku_id: '9', seller_sku: 'B-1', sale_price: '19.90' }] }] }
        : u.pathname.includes('/products/search')
          ? { products: [{ id: 'P9', title: '油污清洁剂 500ml', status: 'ACTIVATE', skus: [{ id: '9', seller_sku: 'B-1', price: { sale_price: '19.90' }, inventory: [{ quantity: 5 }] }] }] }
          : {};
      res.end(JSON.stringify({ code: 0, message: 'Success', data }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  await call('PUT', '/integrations/tiktok', { appKey: 'k', appSecret: 'secret', apiBase: base });
  await call('POST', '/sync/jobs', { shopId: 2, jobType: 'products' });
  await call('POST', '/sync/jobs', { shopId: 2, jobType: 'orders' });
  await call('POST', '/sync/retry');
  const jobs = await waitJobs(2, (js) => js.filter((j) => j.status === 'success').length >= 2);
  mock.close();
  assert.ok(seen.includes('/product/202309/products/search'));
  const p = (await call('GET', '/products?shopId=2')).body.find((x) => x.sellerSku === 'B-1');
  assert.equal(p.dataSource, 'api');
  assert.equal(p.priceSen, 1990);
  assert.equal(p.stock, 5);
  const o = (await call('GET', '/orders?q=TT-100')).body.rows[0];
  assert.equal(o.data_source, 'api');
  assert.equal(o.total_sen, 3980);
  assert.equal(o.item_count, 2);
  // 平台数据不能被人工覆盖或删除
  assert.equal((await call('POST', '/orders', { shopId: 2, externalOrderId: 'TT-100', orderTime: '2026-11-01 10:00', status: 'cancelled', total: '1' })).status, 409);
  assert.equal((await call('DELETE', `/orders/${o.id}`)).status, 409);
  assert.equal((await call('PATCH', `/skus/${p.skuId}`, { price: '1' })).status, 409);
  assert.ok(jobs.some((j) => j.status === 'success'));
  // 低库存提醒
  const alerts = (await call('GET', '/alerts')).body;
  assert.ok(alerts.some((a) => a.rule === 'low_stock' && a.message.includes('B-1')));
});

test('数据库落盘后可重新打开（离线查看已保存数据）', async () => {
  srv.ctx.db.flush();
  const { openDatabase } = require('../server/db');
  const db2 = await openDatabase(path.join(dir, 'workbench.sqlite'));
  assert.ok(db2.get('SELECT COUNT(*) AS n FROM orders').n >= 4);
  db2.sql.close();
  assert.ok(fs.existsSync(path.join(dir, 'backups')));
});
