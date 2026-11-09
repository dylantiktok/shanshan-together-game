'use strict';
/**
 * 飞书（Lark）自定义机器人 Webhook 通知。
 * 签名校验（可选）：sign = Base64(HMAC-SHA256(key = timestamp + "\n" + secret, msg = ""))
 * 国际版 Lark 与国内飞书均使用相同的签名规则，webhook 地址由用户在群机器人中复制。
 */
const crypto = require('crypto');
const { NotConnectedError, PlatformApiError, httpJson } = require('./errors');

function larkSign(timestamp, secret) {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

async function sendLark(cfg, title, text) {
  if (!cfg?.webhookUrl) throw new NotConnectedError('飞书/Lark 未连接：未配置机器人 Webhook');
  if (!/^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\//.test(cfg.webhookUrl)) {
    throw new NotConnectedError('Webhook 地址格式不正确，应为 open.feishu.cn 或 open.larksuite.com 的机器人地址');
  }
  const payload = {
    msg_type: 'post',
    content: { post: { zh_cn: { title, content: [[{ tag: 'text', text }]] } } },
  };
  if (cfg.secret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = ts;
    payload.sign = larkSign(ts, cfg.secret);
  }
  const { body } = await httpJson(cfg.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const code = body.code ?? body.StatusCode;
  if (code !== 0) throw new PlatformApiError(`飞书返回错误 ${code}: ${body.msg || body.StatusMessage}`);
  return true;
}

module.exports = { sendLark, larkSign };
