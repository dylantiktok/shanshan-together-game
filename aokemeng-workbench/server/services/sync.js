'use strict';
/**
 * 同步任务队列。
 *
 * 状态：
 *   pending          待执行
 *   running          执行中
 *   success          成功（result 中记录真实写入条数）
 *   not_connected    未连接（缺少授权/接口未接通）——不会自动重试，配置后需重新发起
 *   waiting_network  网络不可用——网络恢复后自动重试（指数退避，最多 MAX_ATTEMPTS 次）
 *   failed           平台返回错误
 */
const { nowIso, HttpError } = require('../util');
const { TikTokShopClient } = require('../integrations/tiktok');
const { ShopeeClient } = require('../integrations/shopee');
const { NotConnectedError, NetworkError } = require('../integrations/errors');
const { upsertOrder, upsertProduct, upsertRefund } = require('./ingest');
const { raiseEventAlert, evaluateAlerts } = require('./alerts');
const { notify } = require('./notifier');

const JOB_TYPES = ['shop_info', 'products', 'orders', 'refunds'];
const MAX_ATTEMPTS = 12;
const FIRST_SYNC_DAYS = 30;

class SyncService {
  constructor(db, creds) {
    this.db = db;
    this.creds = creds;
    this.running = false;
    this.timer = null;
  }

  enqueue(shopId, jobType, userId) {
    if (!JOB_TYPES.includes(jobType)) throw new HttpError(400, 'invalid_job_type', `未知同步类型: ${jobType}`);
    const shop = this.db.get('SELECT * FROM shops WHERE id = ?', [shopId]);
    if (!shop) throw new HttpError(404, 'shop_not_found', '店铺不存在');
    const dup = this.db.get("SELECT id FROM sync_jobs WHERE shop_id = ? AND job_type = ? AND status IN ('pending','running','waiting_network')", [shopId, jobType]);
    if (dup) return { id: dup.id, duplicate: true };
    const id = this.db.run(
      'INSERT INTO sync_jobs (provider, shop_id, job_type, status, created_by, created_at, next_run_at) VALUES (?,?,?,?,?,?,?)',
      [shop.platform, shopId, jobType, 'pending', userId ?? null, nowIso(), nowIso()],
    ).lastId;
    setImmediate(() => this.processQueue());
    return { id };
  }

  start(intervalMs = 60e3) {
    this.timer = setInterval(() => this.processQueue(), intervalMs);
    this.timer.unref?.();
    // 启动时恢复异常中断的任务
    this.db.run("UPDATE sync_jobs SET status = 'pending' WHERE status = 'running'");
    setImmediate(() => this.processQueue());
  }

  stop() {
    clearInterval(this.timer);
  }

  async processQueue() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.db.get(
          "SELECT * FROM sync_jobs WHERE status IN ('pending','waiting_network') AND next_run_at <= ? ORDER BY id LIMIT 1",
          [nowIso()],
        );
        if (!job) break;
        await this.runJob(job);
      }
    } finally {
      this.running = false;
    }
  }

  clientFor(shop) {
    if (shop.platform === 'tiktok') {
      return new TikTokShopClient(this.creds.get('tiktok'), this.creds.get('tiktok', `shop:${shop.id}`) || {});
    }
    if (shop.platform === 'shopee') {
      return new ShopeeClient(this.creds.get('shopee'), this.creds.get('shopee', `shop:${shop.id}`) || {});
    }
    throw new NotConnectedError(`不支持的平台: ${shop.platform}`);
  }

  async runJob(job) {
    const db = this.db;
    db.run("UPDATE sync_jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?", [nowIso(), job.id]);
    const shop = db.get('SELECT * FROM shops WHERE id = ?', [job.shop_id]);
    try {
      const client = this.clientFor(shop);
      const result = await this[`sync_${job.job_type}`](client, shop);
      db.run("UPDATE sync_jobs SET status = 'success', result = ?, last_error = NULL, finished_at = ? WHERE id = ?",
        [JSON.stringify(result), nowIso(), job.id]);
      db.run("UPDATE shops SET last_sync_at = ?, auth_status = 'authorized', updated_at = ? WHERE id = ?", [nowIso(), nowIso(), shop.id]);
      this.creds.setStatus(shop.platform, `shop:${shop.id}`, { state: 'connected', checkedAt: nowIso(), message: '最近一次同步成功' });
      evaluateAlerts(db);
    } catch (e) {
      const attempts = job.attempts + 1;
      if (e instanceof NetworkError && attempts < MAX_ATTEMPTS) {
        const delay = Math.min(30 * 60e3, 60e3 * 2 ** (attempts - 1));
        db.run("UPDATE sync_jobs SET status = 'waiting_network', last_error = ?, next_run_at = ? WHERE id = ?",
          [e.message, new Date(Date.now() + delay).toISOString(), job.id]);
        return;
      }
      const status = e instanceof NotConnectedError ? 'not_connected' : 'failed';
      db.run('UPDATE sync_jobs SET status = ?, last_error = ?, finished_at = ? WHERE id = ?', [status, e.message, nowIso(), job.id]);
      if (status === 'not_connected') {
        db.run("UPDATE shops SET auth_status = CASE WHEN auth_status = 'authorized' THEN 'expired' ELSE auth_status END, updated_at = ? WHERE id = ?", [nowIso(), shop.id]);
        this.creds.setStatus(shop.platform, `shop:${shop.id}`, { state: 'not_connected', checkedAt: nowIso(), message: e.message });
      } else {
        this.creds.setStatus(shop.platform, `shop:${shop.id}`, { state: 'error', checkedAt: nowIso(), message: e.message });
        raiseEventAlert(db, shop.id, 'sync_failed', `shop:${shop.id}:${job.job_type}`, 'warning', `店铺「${shop.name}」${job.job_type} 同步失败：${e.message}`);
        await notify(db, this.creds, 'sync_failure', `同步失败：${shop.name}`, `${job.job_type}：${e.message}`);
      }
    }
  }

  /** 增量游标：同类型上一次成功任务的开始时间（回溯 1 小时容错）；首次同步回溯 30 天 */
  sinceUnix(shop, jobType) {
    const prev = this.db.get(
      "SELECT started_at FROM sync_jobs WHERE shop_id = ? AND job_type = ? AND status = 'success' ORDER BY id DESC LIMIT 1",
      [shop.id, jobType],
    );
    const t = prev ? Date.parse(prev.started_at) - 3600e3 : Date.now() - FIRST_SYNC_DAYS * 86400e3;
    return Math.floor(t / 1000);
  }

  async sync_shop_info(client, shop) {
    const shops = await client.getAuthorizedShops();
    const match = shops.find((s) => String(s.id) === String(shop.external_shop_id)) || (shops.length === 1 ? shops[0] : null);
    if (!match) return { authorizedShops: shops.map((s) => ({ id: s.id, name: s.name, region: s.region })), matched: false };
    const scope = `shop:${shop.id}`;
    this.creds.set(shop.platform, scope, { shopCipher: match.cipher });
    this.db.run('UPDATE shops SET external_shop_id = ?, shop_cipher = ?, region = COALESCE(?, region), updated_at = ? WHERE id = ?',
      [String(match.id), match.cipher, match.region || null, nowIso(), shop.id]);
    return { matched: true, externalShopId: match.id, name: match.name, region: match.region };
  }

  async sync_products(client, shop) {
    let products = 0, created = 0;
    for await (const p of client.searchProducts()) {
      const r = upsertProduct(this.db, shop.id, p, 'api');
      products++;
      if (r.created) created++;
    }
    return { products, created };
  }

  async sync_orders(client, shop) {
    let orders = 0, created = 0, skipped = 0;
    for await (const o of client.searchOrders(this.sinceUnix(shop, 'orders'))) {
      const r = upsertOrder(this.db, shop.id, o, 'api');
      orders++;
      if (r.created) created++;
      if (r.skipped) skipped++;
    }
    return { orders, created, skipped };
  }

  async sync_refunds(client, shop) {
    let refunds = 0;
    for await (const r of client.searchReturns(this.sinceUnix(shop, 'refunds'))) {
      upsertRefund(this.db, shop.id, r, 'api');
      refunds++;
    }
    return { refunds };
  }
}

module.exports = { SyncService, JOB_TYPES };
