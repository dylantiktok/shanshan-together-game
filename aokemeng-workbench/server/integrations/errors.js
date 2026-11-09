'use strict';

/** 未连接：缺少授权或接口尚未接通。不重试，等待用户配置。 */
class NotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'not_connected';
  }
}

/** 网络不可用：离线时排队，网络恢复后自动重试。 */
class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.code = 'network';
  }
}

/** 平台接口返回错误（权限不足、参数错误、令牌过期等）。 */
class PlatformApiError extends Error {
  constructor(message, details) {
    super(message);
    this.code = 'platform_error';
    this.details = details;
  }
}

/** 包装 fetch：区分网络错误与平台错误，带超时 */
async function httpJson(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    throw new NetworkError(`网络请求失败: ${e.cause?.code || e.name || e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new PlatformApiError(`平台返回非 JSON 响应 (HTTP ${res.status})`, { status: res.status, body: text.slice(0, 500) });
  }
  return { status: res.status, body };
}

module.exports = { NotConnectedError, NetworkError, PlatformApiError, httpJson };
