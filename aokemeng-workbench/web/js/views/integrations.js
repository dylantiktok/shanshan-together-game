import { api } from '../api.js';
import { t } from '../i18n.js';
import { h, table, modal, badge, stateBadge, klDateTime, toast, guard, confirmDialog, formField, readForm } from '../ui.js';

const GLOBAL_FORMS = {
  tiktok: { title: 'TikTok Shop Partner API', fields: [['appKey', 'App Key'], ['appSecret', 'App Secret', 'password'], ['serviceId', 'Service ID（用于生成授权链接）'], ['apiBase', 'API Base（默认 https://open-api.tiktokglobalshop.com）']] },
  shopee: { title: 'Shopee Open Platform（预留）', fields: [['partnerId', 'Partner ID'], ['partnerKey', 'Partner Key', 'password']] },
  anthropic: { title: 'Claude (Anthropic)', fields: [['apiKey', 'API Key', 'password'], ['model', 'Model（默认 claude-opus-5-5）'], ['effort', 'Effort: low / medium / high']] },
  openai: { title: 'OpenAI', fields: [['apiKey', 'API Key', 'password'], ['model', 'Model'], ['baseUrl', 'Base URL（可选）']] },
  lark: { title: '飞书 / Lark 机器人', fields: [['webhookUrl', 'Webhook URL', 'password'], ['secret', '签名密钥 Secret（可选）', 'password']] },
};

const JOB_LABEL = { shop_info: '店铺信息', products: '商品/SKU/库存', orders: '订单', refunds: '退款退货' };

export async function render(el, app) {
  const data = await api('GET', '/integrations');
  const jobs = await api('GET', '/sync/jobs');

  const editGlobal = (p) => modal(GLOBAL_FORMS[p].title, [
    h('p', { class: 'hint' }, '已保存的密钥只显示末 4 位；留空表示不修改。凭据以 AES-256-GCM 加密保存在本机。'),
    ...GLOBAL_FORMS[p].fields.map(([name, label, type]) => ({ name, label, type: type || 'text', value: type === 'password' ? '' : data[p].config?.[name] || '', placeholder: data[p].config?.[name] || '' })),
  ], async (v) => { await api('PUT', `/integrations/${p}`, v); toast(t('saved')); app.rerender(); });

  const test = async (p, shopId) => {
    const r = await guard(() => api('POST', `/integrations/${p}/test`, shopId ? { shopId } : {}));
    toast(`${t('state_' + r.state)}：${r.message}`, r.state === 'connected' ? 'ok' : 'error');
    app.rerender();
  };

  const providerCard = (p) => {
    const d = data[p];
    return h('div', { class: 'card integ' },
      h('div', { class: 'integ-head' }, h('b', {}, GLOBAL_FORMS[p].title), stateBadge(d.status.state)),
      h('small', {}, d.status.message || ''), d.status.checkedAt ? h('small', { class: 'block' }, klDateTime(d.status.checkedAt)) : null,
      h('div', { class: 'row-actions' },
        h('button', { onclick: () => editGlobal(p) }, t('edit')),
        ['anthropic', 'openai', 'lark'].includes(p) ? h('button', { onclick: () => test(p) }, t('testConnection')) : null,
        d.config ? h('button', { class: 'danger', onclick: async () => {
          if (!(await confirmDialog(`${t('delete')} ${GLOBAL_FORMS[p].title}?`))) return;
          await guard(() => api('DELETE', `/integrations/${p}`));
          app.rerender();
        } }, t('delete')) : null));
  };

  const shopAuth = (s) => {
    if (s.platform !== 'tiktok') {
      return modal(`${s.name} · Shopee`, [h('p', { class: 'hint' }, 'Shopee 适配层已预留（签名算法与凭据结构），业务接口尚未接通，同步会显示“未连接”。'),
        { name: 'shopId', label: 'Shopee Shop ID' }, { name: 'accessToken', label: 'Access Token', type: 'password' }, { name: 'refreshToken', label: 'Refresh Token', type: 'password' }],
      async (v) => { await api('PUT', `/integrations/shopee/shops/${s.id}`, v); toast(t('saved')); app.rerender(); });
    }
    const steps = h('ol', { class: 'steps' },
      h('li', {}, '在 TikTok Shop Partner Center 创建应用，配置上方 App Key / App Secret / Service ID。'),
      h('li', {}, data.tiktok.authorizeUrl ? h('a', { href: data.tiktok.authorizeUrl, target: '_blank', rel: 'noopener' }, t('openAuthorize')) : '配置 Service ID 后可生成授权链接', '，卖家登录并同意授权。'),
      h('li', {}, '授权回调地址中会带有 code 参数，复制到下方换取令牌。'));
    return modal(`${s.name} · TikTok Shop`, [steps, { name: 'authCode', label: t('authCode'), required: true }],
      async (v) => {
        const r = await api('POST', `/integrations/tiktok/shops/${s.id}/auth-code`, v);
        toast(`已授权：${r.sellerName || ''}`);
        app.rerender();
      }, { submitLabel: t('exchangeToken') });
  };

  const notify = await api('GET', '/settings/notify');
  const notifyForm = h('form', { class: 'inline-form' },
    formField({ name: 'criticalAlerts', label: t('notifyCritical'), type: 'checkbox', value: notify.criticalAlerts }),
    formField({ name: 'syncFailures', label: t('notifySync'), type: 'checkbox', value: notify.syncFailures }),
    h('button', {}, t('save')));
  notifyForm.addEventListener('submit', async (e) => { e.preventDefault(); await guard(() => api('PUT', '/settings/notify', readForm(notifyForm))); toast(t('saved')); });

  el.append(
    h('div', { class: 'page-head' }, h('h1', {}, t('nav_integrations')), h('button', { onclick: () => app.rerender() }, t('refresh'))),
    h('div', { class: 'notice' }, t('integrationsHint')),
    h('div', { class: 'grid cards' }, Object.keys(GLOBAL_FORMS).map(providerCard)),
    h('section', { class: 'panel' }, h('h3', {}, 'Lark'), notifyForm),
    h('h2', {}, t('nav_shops')),
    table([
      { label: t('shop'), render: (s) => h('b', {}, s.name) },
      { label: t('platform'), render: (s) => (s.platform === 'tiktok' ? 'TikTok' : 'Shopee') },
      { label: t('authStatus'), render: (s) => stateBadge(s.status.state) },
      { label: t('message'), render: (s) => h('small', {}, s.status.message || '') },
      { label: 'Token 到期', render: (s) => klDateTime(s.auth_expires_at) },
      { label: t('lastSync'), render: (s) => klDateTime(s.last_sync_at) },
      { label: t('actions'), render: (s) => h('div', { class: 'row-actions' },
        h('button', { onclick: () => shopAuth(s) }, t('authStatus')),
        s.platform === 'tiktok' && s.config ? h('button', { onclick: () => test('tiktok', s.id) }, t('testConnection')) : null,
        s.platform === 'tiktok' && s.config?.refreshToken ? h('button', { onclick: async () => { await guard(() => api('POST', `/integrations/tiktok/shops/${s.id}/refresh-token`)); toast(t('saved')); app.rerender(); } }, t('refreshToken')) : null,
        app.can('sync.run') ? h('button', { class: 'primary', onclick: async () => { await guard(() => api('POST', '/sync/jobs', { shopId: s.id, jobType: 'all' })); setTimeout(() => app.rerender(), 800); } }, t('syncNow')) : null,
        s.config ? h('button', { class: 'danger', onclick: async () => {
          if (!(await confirmDialog(`${t('revoke')} ${s.name}?`))) return;
          await guard(() => api('DELETE', `/integrations/${s.platform}/shops/${s.id}`));
          app.rerender();
        } }, t('revoke')) : null) },
    ], data.shops),
    h('div', { class: 'page-head' }, h('h2', {}, t('syncJobs')), h('button', { onclick: async () => { await guard(() => api('POST', '/sync/retry')); setTimeout(() => app.rerender(), 800); } }, t('retryNetwork'))),
    table([
      { label: '#', key: 'id' }, { label: t('shop'), key: 'shop_name' }, { label: t('jobType'), render: (j) => JOB_LABEL[j.job_type] || j.job_type },
      { label: t('status'), render: (j) => badge(t('job_' + j.status), { success: 'ok', failed: 'bad', not_connected: 'muted', waiting_network: 'warn' }[j.status]) },
      { label: t('attempts'), key: 'attempts', class: 'num' },
      { label: t('result'), render: (j) => h('small', {}, j.result ? JSON.stringify(j.result) : j.last_error || '') },
      { label: t('createdAt'), render: (j) => klDateTime(j.created_at) },
      { label: '完成', render: (j) => klDateTime(j.finished_at) },
    ], jobs));
}
