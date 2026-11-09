'use strict';
/** 第三方接入：TikTok Shop / Shopee / Claude / OpenAI / 飞书 Lark，以及同步任务与 AI 分析 */
const express = require('express');
const { HttpError, nowIso, fromSen } = require('../util');
const { requirePerm } = require('../auth');
const { canAccessShop, shopFilterSql, hasPerm } = require('../rbac');
const { audit } = require('../audit');
const { TikTokShopClient } = require('../integrations/tiktok');
const { NotConnectedError } = require('../integrations/errors');
const ai = require('../integrations/ai');
const { sendLark } = require('../integrations/lark');
const { getNotifySettings } = require('../services/notifier');
const { getDashboard } = require('../services/dashboard');
const { calcUnitProfit } = require('../services/profit');
const { JOB_TYPES } = require('../services/sync');

/** 每个服务允许保存的字段；secret 字段在接口返回时遮盖 */
const PROVIDERS = {
  tiktok: { global: ['appKey', 'appSecret', 'serviceId', 'apiBase'], shop: ['accessToken', 'refreshToken', 'accessTokenExpireAt', 'refreshTokenExpireAt', 'shopCipher'], secrets: ['appSecret', 'accessToken', 'refreshToken'] },
  shopee: { global: ['partnerId', 'partnerKey'], shop: ['accessToken', 'refreshToken', 'shopId'], secrets: ['partnerKey', 'accessToken', 'refreshToken'] },
  anthropic: { global: ['apiKey', 'model', 'effort'], secrets: ['apiKey'] },
  openai: { global: ['apiKey', 'model', 'baseUrl'], secrets: ['apiKey'] },
  lark: { global: ['webhookUrl', 'secret'], secrets: ['webhookUrl', 'secret'] },
};

module.exports = function integrationRoutes({ db, creds, sync }) {
  const r = express.Router();
  const provider = (p) => {
    if (!PROVIDERS[p]) throw new HttpError(404, 'unknown_provider', `未知服务: ${p}`);
    return PROVIDERS[p];
  };
  const pick = (body, keys) => Object.fromEntries(keys.filter((k) => k in body).map((k) => [k, body[k] === null ? null : String(body[k]).trim()]));
  const assertShop = (req, id) => {
    const shop = db.get('SELECT * FROM shops WHERE id = ?', [Number(id)]);
    if (!shop) throw new HttpError(404, 'shop_not_found', '店铺不存在');
    if (!canAccessShop(db, req.user, shop.id)) throw new HttpError(403, 'forbidden', '没有该店铺的访问权限');
    return shop;
  };

  r.get('/integrations', requirePerm('integrations.manage'), (req, res) => {
    const out = {};
    for (const [p, def] of Object.entries(PROVIDERS)) {
      out[p] = { config: creds.masked(p, 'global', def.secrets), status: creds.getStatus(p, 'global') };
      if (!out[p].config) out[p].status = { state: 'not_connected', message: '未连接：尚未配置' };
    }
    out.shops = db.all('SELECT id, name, platform, auth_status, auth_expires_at, external_shop_id, last_sync_at FROM shops ORDER BY id').map((s) => ({
      ...s,
      config: creds.masked(s.platform, `shop:${s.id}`, PROVIDERS[s.platform].secrets),
      status: creds.get(s.platform, `shop:${s.id}`) ? creds.getStatus(s.platform, `shop:${s.id}`) : { state: 'not_connected', message: '未连接：店铺未授权' },
    }));
    if (out.tiktok.config?.serviceId) {
      out.tiktok.authorizeUrl = `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(creds.get('tiktok').serviceId)}`;
    }
    res.json(out);
  });

  r.put('/integrations/:provider', requirePerm('integrations.manage'), (req, res) => {
    const def = provider(req.params.provider);
    const data = pick(req.body || {}, def.global);
    creds.set(req.params.provider, 'global', data, req.user.id);
    audit(db, req, 'integration.update', 'integration', req.params.provider, { fields: Object.keys(data) });
    res.json({ ok: true });
  });

  r.delete('/integrations/:provider', requirePerm('integrations.manage'), (req, res) => {
    provider(req.params.provider);
    creds.remove(req.params.provider, 'global');
    audit(db, req, 'integration.remove', 'integration', req.params.provider);
    res.json({ ok: true });
  });

  r.put('/integrations/:provider/shops/:shopId', requirePerm('integrations.manage'), (req, res) => {
    const def = provider(req.params.provider);
    if (!def.shop) throw new HttpError(400, 'no_shop_scope', '该服务没有店铺级配置');
    const shop = assertShop(req, req.params.shopId);
    if (shop.platform !== req.params.provider) throw new HttpError(400, 'platform_mismatch', '店铺平台与服务不匹配');
    const data = pick(req.body || {}, def.shop);
    creds.set(shop.platform, `shop:${shop.id}`, data, req.user.id);
    if (data.accessTokenExpireAt) {
      db.run('UPDATE shops SET auth_expires_at = ?, updated_at = ? WHERE id = ?', [new Date(Number(data.accessTokenExpireAt) * 1000).toISOString(), nowIso(), shop.id]);
    }
    audit(db, req, 'integration.shop_update', 'shop', shop.id, { provider: shop.platform, fields: Object.keys(data) });
    res.json({ ok: true });
  });

  r.delete('/integrations/:provider/shops/:shopId', requirePerm('integrations.manage'), (req, res) => {
    const shop = assertShop(req, req.params.shopId);
    creds.remove(shop.platform, `shop:${shop.id}`);
    db.run("UPDATE shops SET auth_status = 'not_connected', auth_expires_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), shop.id]);
    audit(db, req, 'integration.shop_revoke', 'shop', shop.id, { provider: shop.platform });
    res.json({ ok: true });
  });

  /** TikTok：使用授权回调中的 auth_code 换取令牌 */
  r.post('/integrations/tiktok/shops/:shopId/auth-code', requirePerm('integrations.manage'), async (req, res) => {
    const shop = assertShop(req, req.params.shopId);
    if (shop.platform !== 'tiktok') throw new HttpError(400, 'platform_mismatch', '不是 TikTok 店铺');
    const app = creds.get('tiktok');
    if (!app?.appKey || !app?.appSecret) throw new NotConnectedError('请先配置 TikTok App Key 与 App Secret');
    const authCode = String(req.body?.authCode || '').trim();
    if (!authCode) throw new HttpError(400, 'missing_fields', '缺少 auth_code');
    const tok = await TikTokShopClient.exchangeAuthCode(app, authCode);
    saveTikTokToken(shop, tok, req.user.id);
    audit(db, req, 'integration.tiktok_authorize', 'shop', shop.id, { sellerName: tok.sellerName });
    const job = sync.enqueue(shop.id, 'shop_info', req.user.id);
    res.json({ ok: true, sellerName: tok.sellerName, jobId: job.id });
  });

  r.post('/integrations/tiktok/shops/:shopId/refresh-token', requirePerm('integrations.manage'), async (req, res) => {
    const shop = assertShop(req, req.params.shopId);
    const app = creds.get('tiktok');
    const sc = creds.get('tiktok', `shop:${shop.id}`);
    if (!app?.appKey || !sc?.refreshToken) throw new NotConnectedError('缺少 App 配置或 Refresh Token');
    const tok = await TikTokShopClient.refreshToken(app, sc.refreshToken);
    saveTikTokToken(shop, tok, req.user.id);
    audit(db, req, 'integration.tiktok_refresh', 'shop', shop.id);
    res.json({ ok: true });
  });

  function saveTikTokToken(shop, tok, userId) {
    creds.set('tiktok', `shop:${shop.id}`, {
      accessToken: tok.accessToken, refreshToken: tok.refreshToken,
      accessTokenExpireAt: String(tok.accessTokenExpireAt || ''), refreshTokenExpireAt: String(tok.refreshTokenExpireAt || ''),
    }, userId);
    db.run("UPDATE shops SET auth_status = 'authorized', auth_expires_at = ?, updated_at = ? WHERE id = ?",
      [tok.accessTokenExpireAt ? new Date(tok.accessTokenExpireAt * 1000).toISOString() : null, nowIso(), shop.id]);
  }

  /** 测试连接：只有真实调用成功才标记 connected */
  r.post('/integrations/:provider/test', requirePerm('integrations.manage'), async (req, res) => {
    const p = req.params.provider;
    provider(p);
    const scope = req.body?.shopId ? `shop:${assertShop(req, req.body.shopId).id}` : 'global';
    try {
      let detail;
      if (p === 'anthropic' || p === 'openai') {
        const out = await ai.ask(p, creds.get(p), '你是连接测试助手。', '请只回复：OK');
        detail = `模型 ${out.model} 响应正常`;
      } else if (p === 'lark') {
        await sendLark(creds.get('lark'), 'AOKEMENG 工作台连接测试', `测试时间 ${new Date().toISOString()}`);
        detail = '测试消息已发送';
      } else if (p === 'tiktok') {
        if (scope === 'global') throw new HttpError(400, 'need_shop', '请选择要测试的 TikTok 店铺');
        const client = new TikTokShopClient(creds.get('tiktok'), creds.get('tiktok', scope) || {});
        const shops = await client.getAuthorizedShops();
        detail = `授权有效，可访问 ${shops.length} 个店铺`;
      } else {
        throw new NotConnectedError('Shopee 适配层已预留，业务接口尚未接通');
      }
      const status = { state: 'connected', checkedAt: nowIso(), message: detail };
      creds.setStatus(p, scope, status);
      audit(db, req, 'integration.test', 'integration', p, { scope, result: 'connected' });
      res.json(status);
    } catch (e) {
      const status = { state: e.code === 'not_connected' ? 'not_connected' : 'error', checkedAt: nowIso(), message: e.message };
      creds.setStatus(p, scope, status);
      audit(db, req, 'integration.test', 'integration', p, { scope, result: status.state, error: e.message });
      res.status(200).json(status);
    }
  });

  // ---- 通知设置 ----
  r.get('/settings/notify', requirePerm('integrations.manage'), (req, res) => res.json(getNotifySettings(db)));
  r.put('/settings/notify', requirePerm('integrations.manage'), (req, res) => {
    const v = { criticalAlerts: !!req.body?.criticalAlerts, syncFailures: !!req.body?.syncFailures };
    db.run("INSERT INTO settings (key, value) VALUES ('lark.notify', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(v)]);
    audit(db, req, 'settings.notify', 'settings', 'lark.notify', v);
    res.json(v);
  });
  r.get('/notifications', requirePerm('integrations.manage'), (req, res) => {
    res.json(db.all('SELECT * FROM notifications_log ORDER BY id DESC LIMIT 200'));
  });

  // ---- 同步任务 ----
  r.get('/sync/jobs', requirePerm('shops.view'), (req, res) => {
    const f = shopFilterSql(db, req.user, 'j.shop_id', req.query.shopId);
    res.json(db.all(
      `SELECT j.*, s.name AS shop_name FROM sync_jobs j LEFT JOIN shops s ON s.id = j.shop_id WHERE ${f.sql} ORDER BY j.id DESC LIMIT 200`,
      f.params,
    ).map((j) => ({ ...j, result: j.result ? JSON.parse(j.result) : null })));
  });

  r.post('/sync/jobs', requirePerm('sync.run'), (req, res) => {
    const shop = assertShop(req, req.body?.shopId);
    const types = req.body?.jobType === 'all' ? JOB_TYPES : [req.body?.jobType];
    const jobs = types.map((t) => sync.enqueue(shop.id, t, req.user.id));
    audit(db, req, 'sync.enqueue', 'shop', shop.id, { types });
    res.json({ jobs });
  });

  r.post('/sync/retry', requirePerm('sync.run'), (req, res) => {
    db.run("UPDATE sync_jobs SET next_run_at = ? WHERE status = 'waiting_network'", [nowIso()]);
    sync.processQueue();
    res.json({ ok: true });
  });

  // ---- AI 分析 ----
  r.get('/ai/providers', requirePerm('ai.use'), (req, res) => {
    res.json(['anthropic', 'openai'].map((p) => ({
      provider: p, configured: !!creds.get(p)?.apiKey, model: creds.get(p)?.model || ai.DEFAULT_MODELS[p], status: creds.getStatus(p, 'global'),
    })));
  });

  r.post('/ai/analyze', requirePerm('ai.use'), async (req, res) => {
    const b = req.body || {};
    const p = b.provider === 'openai' ? 'openai' : 'anthropic';
    const question = String(b.question || '').slice(0, 4000);
    const context = buildAiContext(req, b);
    const system = [
      '你是 AOKEMENG Malaysia（马来西亚家庭清洁用品品牌：洗衣液、厨房油污清洁剂等）的 TikTok Shop 运营分析助手。',
      '货币为 MYR，时区 Asia/Kuala_Lumpur。只根据提供的数据作答；数据中标注为 estimate 或 manual 的部分要提醒用户其可信度。',
      '如果数据不足以得出结论，直接说明缺少什么数据，不要编造数字。回答使用用户提问的语言，结构清晰，给出可执行建议。',
      '不要建议任何违反 TikTok Shop 平台规则、刷单、虚假宣传或绕过平台风控的做法。',
    ].join('\n');
    const prompt = `${question || '请分析以下经营数据并给出改进建议。'}\n\n<data>\n${JSON.stringify(context, null, 1)}\n</data>`;
    const out = await ai.ask(p, creds.get(p), system, prompt);
    audit(db, req, 'ai.analyze', 'ai', p, { task: b.task, model: out.model, usage: out.usage });
    res.json({ ...out, disclaimer: 'AI 生成的建议仅供参考，请结合实际业务判断。' });
  });

  function buildAiContext(req, b) {
    const ctx = { generatedAt: nowIso(), currency: 'MYR' };
    if (b.task === 'dashboard' || !b.task) {
      const d = getDashboard(db, req.user, { from: b.from, to: b.to, shopId: b.shopId });
      ctx.dashboard = {
        period: d.period,
        salesMYR: fromSen(d.range.sales.valueSen), salesSources: Object.keys(d.range.sales.bySource),
        orders: d.range.orders.value, aovMYR: fromSen(d.range.aov.valueSen), refundsMYR: fromSen(d.range.refunds.valueSen),
        adSpendMYR: fromSen(d.range.adSpend.valueSen), roas: d.range.roas.value,
        grossProfitMYR_estimate: d.range.grossProfit ? fromSen(d.range.grossProfit.valueSen) : undefined,
        netProfitMYR_estimate: d.range.netProfit ? fromSen(d.range.netProfit.valueSen) : undefined,
        dailyTrend: d.trend.map((t) => ({ day: t.day, orders: t.orders, salesMYR: fromSen(t.sales) })),
        shops: d.ranking.map((s) => ({ name: s.name, salesMYR: fromSen(s.sales), orders: s.orders })),
      };
    }
    if (b.task === 'profit_review') {
      if (!hasPerm(req.user, 'costs.view')) throw new HttpError(403, 'forbidden', '没有查看成本的权限');
      const f = shopFilterSql(db, req.user, 'k.shop_id', b.shopId);
      ctx.skus = db.all(
        `SELECT k.seller_sku, p.title, k.price_sen, k.stock, c.*, (c.sku_id IS NOT NULL) AS has_cost
         FROM skus k JOIN products p ON p.id = k.product_id LEFT JOIN sku_costs c ON c.sku_id = k.id WHERE ${f.sql} LIMIT 200`, f.params,
      ).map((k) => {
        const base = { sku: k.seller_sku, title: k.title, priceMYR: fromSen(k.price_sen), stock: k.stock };
        if (!k.has_cost) return { ...base, cost: '未录入' };
        const pr = calcUnitProfit({ ...k, price_sen: k.price_sen });
        return { ...base, unitProfitMYR_estimate: fromSen(pr.profitSen), marginPct: pr.marginPct, breakEvenPriceMYR: fromSen(pr.breakEvenPriceSen),
          costBreakdownMYR: Object.fromEntries(Object.entries(pr.breakdown).map(([kk, v]) => [kk.replace(/Sen$/, ''), fromSen(v)])) };
      });
    }
    return ctx;
  }

  return r;
};

module.exports.PROVIDERS = PROVIDERS;
