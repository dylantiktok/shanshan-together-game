// 本地服务 API 客户端
let token = null;
try { token = sessionStorage.getItem('token'); } catch { /* ignore */ }

export function setToken(t) {
  token = t;
  try { t ? sessionStorage.setItem('token', t) : sessionStorage.removeItem('token'); } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, path, body, { raw = false, contentType } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') { payload = body; headers['content-type'] = contentType || 'text/plain'; }
    else { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  if (raw && res.ok) return res;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, data?.error, data?.message || `HTTP ${res.status}`);
  }
  return data;
}

/** 带鉴权下载文件（CSV 导出） */
export async function download(path, filename) {
  const res = await api('GET', path, undefined, { raw: true });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
