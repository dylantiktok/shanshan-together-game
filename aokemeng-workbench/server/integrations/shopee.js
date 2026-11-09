'use strict';
/**
 * Shopee Open Platform 适配器（预留）。
 *
 * 已实现：官方签名算法（partner_id + path + timestamp [+ access_token + shop_id]，
 * 以 Partner Key 做 HMAC-SHA256）与凭据结构。
 * 未实现：业务数据同步。在完成 Shopee 应用申请与接口联调之前，
 * 所有同步调用都会抛出 NotConnectedError，界面显示“未连接”。
 */
const crypto = require('crypto');
const { NotConnectedError } = require('./errors');

const API_BASE = 'https://partner.shopeemobile.com';

function sign({ partnerId, partnerKey, path, timestamp, accessToken, shopId }) {
  const base = `${partnerId}${path}${timestamp}${accessToken || ''}${shopId || ''}`;
  return crypto.createHmac('sha256', partnerKey).update(base).digest('hex');
}

class ShopeeClient {
  constructor(app, shop = {}) {
    if (!app?.partnerId || !app?.partnerKey) throw new NotConnectedError('Shopee 未连接：未配置 Partner ID / Partner Key');
    this.app = app;
    this.shop = shop;
  }

  notImplemented(what) {
    throw new NotConnectedError(`Shopee ${what} 同步尚未接通（适配层已预留，待完成官方接口联调）`);
  }

  async *searchProducts() { this.notImplemented('商品'); }
  async *searchOrders() { this.notImplemented('订单'); }
  async *searchReturns() { this.notImplemented('退款'); }
}

module.exports = { ShopeeClient, sign, API_BASE };
