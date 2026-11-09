'use strict';
/**
 * TikTok Shop Partner API 适配器（API 版本 202309）。
 *
 * 只使用官方开放接口；需要在 TikTok Shop Partner Center 创建应用并获得授权。
 * 未配置 App Key / App Secret / Access Token 时一律抛出 NotConnectedError，
 * 绝不返回伪造数据。
 *
 * 签名算法（官方文档 “Sign your API request”）：
 *   1. 取所有 query 参数，排除 sign 与 access_token，按 key 字典序排序
 *   2. 拼接为 key1value1key2value2...
 *   3. 前面加上请求 path
 *   4. 若 content-type 不是 multipart/form-data，在后面追加请求 body 原文
 *   5. 首尾各包裹 app_secret
 *   6. 以 app_secret 为密钥做 HMAC-SHA256，输出 hex
 */
const crypto = require('crypto');
const { NotConnectedError, PlatformApiError, httpJson } = require('./errors');
const { toSen } = require('../util');

const API_BASE = 'https://open-api.tiktokglobalshop.com';
const AUTH_BASE = 'https://auth.tiktok-shops.com';
const MAX_PAGES = 40;

function sign(path, query, body, appSecret) {
  const keys = Object.keys(query).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  let str = path + keys.map((k) => k + query[k]).join('');
  if (body) str += body;
  str = appSecret + str + appSecret;
  return crypto.createHmac('sha256', appSecret).update(str).digest('hex');
}

class TikTokShopClient {
  /** app: { appKey, appSecret, apiBase? }  shop: { accessToken, shopCipher } */
  constructor(app, shop = {}) {
    if (!app?.appKey || !app?.appSecret) throw new NotConnectedError('TikTok Shop 未连接：未配置 App Key / App Secret');
    this.app = app;
    this.shop = shop;
    this.base = app.apiBase || API_BASE;
  }

  requireShopAuth() {
    if (!this.shop?.accessToken) throw new NotConnectedError('TikTok Shop 店铺未授权：缺少 Access Token');
    if (this.shop.accessTokenExpireAt && this.shop.accessTokenExpireAt * 1000 < Date.now()) {
      throw new NotConnectedError('TikTok Shop 授权已过期，请刷新令牌或重新授权');
    }
  }

  async request(method, path, { query = {}, body, needCipher = true } = {}) {
    this.requireShopAuth();
    const q = { app_key: this.app.appKey, timestamp: Math.floor(Date.now() / 1000), ...query };
    if (needCipher) {
      if (!this.shop.shopCipher) throw new NotConnectedError('TikTok Shop 店铺缺少 shop_cipher，请先执行“获取授权店铺”');
      q.shop_cipher = this.shop.shopCipher;
    }
    const bodyStr = body ? JSON.stringify(body) : '';
    q.sign = sign(path, q, bodyStr, this.app.appSecret);
    const url = `${this.base}${path}?${new URLSearchParams(q)}`;
    const { status, body: resp } = await httpJson(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-tts-access-token': this.shop.accessToken },
      body: bodyStr || undefined,
    });
    if (status === 401 || resp.code === 105002 || resp.code === 105001) {
      throw new NotConnectedError(`TikTok Shop 授权无效或过期: ${resp.message || status}`);
    }
    if (resp.code !== 0) {
      throw new PlatformApiError(`TikTok Shop 接口错误 ${resp.code}: ${resp.message}`, { status, code: resp.code, requestId: resp.request_id, path });
    }
    return resp.data || {};
  }

  /** 用授权码换取 Access Token */
  static async exchangeAuthCode(app, authCode) {
    const q = new URLSearchParams({ app_key: app.appKey, app_secret: app.appSecret, auth_code: authCode, grant_type: 'authorized_code' });
    return tokenCall(`${AUTH_BASE}/api/v2/token/get?${q}`);
  }

  static async refreshToken(app, refreshToken) {
    const q = new URLSearchParams({ app_key: app.appKey, app_secret: app.appSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
    return tokenCall(`${AUTH_BASE}/api/v2/token/refresh?${q}`);
  }

  async getAuthorizedShops() {
    const data = await this.request('GET', '/authorization/202309/shops', { needCipher: false });
    return data.shops || [];
  }

  async *paginate(path, body, query = {}) {
    let pageToken;
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = { page_size: 50, ...query };
      if (pageToken) q.page_token = pageToken;
      const data = await this.request('POST', path, { query: q, body });
      yield data;
      pageToken = data.next_page_token;
      if (!pageToken) return;
    }
  }

  async *searchProducts() {
    for await (const d of this.paginate('/product/202309/products/search', { status: 'ALL' })) {
      for (const p of d.products || []) yield mapProduct(p);
    }
  }

  async *searchOrders(updateTimeGe) {
    const body = { update_time_ge: updateTimeGe };
    for await (const d of this.paginate('/order/202309/orders/search', body, { sort_field: 'update_time', sort_order: 'ASC' })) {
      for (const o of d.orders || []) yield mapOrder(o);
    }
  }

  async *searchReturns(updateTimeGe) {
    for await (const d of this.paginate('/return_refund/202309/returns/search', { update_time_ge: updateTimeGe })) {
      for (const r of d.return_orders || []) yield mapReturn(r);
    }
  }
}

async function tokenCall(url) {
  const { body } = await httpJson(url, { method: 'GET' });
  if (body.code !== 0) throw new PlatformApiError(`TikTok Shop 授权接口错误 ${body.code}: ${body.message}`, body);
  const d = body.data || {};
  return {
    accessToken: d.access_token,
    accessTokenExpireAt: d.access_token_expire_in,
    refreshToken: d.refresh_token,
    refreshTokenExpireAt: d.refresh_token_expire_in,
    sellerName: d.seller_name,
    sellerBaseRegion: d.seller_base_region,
  };
}

const PRODUCT_STATUS = { ACTIVATE: 'active', DRAFT: 'draft', PENDING: 'pending', FAILED: 'failed', SELLER_DEACTIVATED: 'inactive', PLATFORM_DEACTIVATED: 'inactive', FREEZE: 'frozen', DELETED: 'deleted' };

function mapProduct(p) {
  return {
    externalProductId: String(p.id),
    title: p.title || `(TikTok 商品 ${p.id})`,
    status: PRODUCT_STATUS[p.status] || String(p.status || 'unknown').toLowerCase(),
    skus: (p.skus || []).map((s) => ({
      externalSkuId: String(s.id),
      sellerSku: s.seller_sku || `TT-${s.id}`,
      priceSen: toSen(s.price?.sale_price ?? s.price?.tax_exclusive_price ?? 0),
      stock: Array.isArray(s.inventory) ? s.inventory.reduce((a, w) => a + (Number(w.quantity) || 0), 0) : null,
    })),
  };
}

function mapOrder(o) {
  // 202309 版本中每个 line_item 代表 1 件商品，这里按 SKU 合并数量
  const grouped = new Map();
  for (const li of o.line_items || []) {
    const key = `${li.sku_id}|${li.sale_price}`;
    const g = grouped.get(key) || { externalSkuId: String(li.sku_id), sellerSku: li.seller_sku, productName: li.product_name, quantity: 0, unitPriceSen: toSen(li.sale_price || 0) };
    g.quantity += Number(li.quantity) || 1;
    grouped.set(key, g);
  }
  return {
    externalOrderId: String(o.id),
    orderTime: new Date(Number(o.create_time) * 1000).toISOString(),
    status: String(o.status || '').toLowerCase(),
    totalSen: toSen(o.payment?.total_amount || 0),
    shippingFeeSen: toSen(o.payment?.shipping_fee || 0),
    buyerNote: o.buyer_message || null,
    items: [...grouped.values()],
  };
}

function mapReturn(r) {
  return {
    externalRefundId: String(r.return_id),
    externalOrderId: r.order_id ? String(r.order_id) : null,
    type: String(r.return_type || 'refund').toLowerCase(),
    amountSen: toSen(r.refund_amount?.refund_total || 0),
    reason: r.return_reason_text || r.return_reason || null,
    status: String(r.return_status || 'pending').toLowerCase(),
    refundTime: new Date(Number(r.create_time) * 1000).toISOString(),
  };
}

module.exports = { TikTokShopClient, sign, mapOrder, mapProduct, mapReturn, API_BASE };
