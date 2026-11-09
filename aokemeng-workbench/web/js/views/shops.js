import { api } from '../api.js';
import { t } from '../i18n.js';
import { h, table, modal, badge, klDateTime, confirmDialog, toast, guard, klDate } from '../ui.js';

const METRIC_KEYS = [
  ['shop_rating', '店铺评分 Shop rating'], ['late_dispatch_rate', '延迟发货率 Late dispatch (%)'], ['cancellation_rate', '取消率 Cancellation (%)'],
  ['return_rate', '退货率 Return rate (%)'], ['response_rate', '客服响应率 Response rate (%)'], ['negative_review_rate', '差评率 Negative review (%)'],
  ['violation_points', '违规扣分 Violation points'],
];

export async function render(el, app) {
  const shops = await app.reloadShops();
  const canManage = app.can('shops.manage');
  const authKind = { authorized: 'ok', expired: 'bad', not_connected: 'muted' };

  const editShop = (s) => modal(s ? t('edit') : t('add'), [
    ...(s ? [] : [{ name: 'platform', label: t('platform'), type: 'select', options: [['tiktok', 'TikTok Shop'], ['shopee', 'Shopee (预留)']], value: 'tiktok', required: true }]),
    { name: 'name', label: t('shop'), value: s?.name, required: true },
    { name: 'region', label: t('region'), value: s?.region || 'MY' },
    { name: 'externalShopId', label: t('externalShopId'), value: s?.external_shop_id },
    ...(s ? [{ name: 'status', label: t('status'), type: 'select', value: s.status, options: ['active', 'paused', 'closed'].map((v) => [v, t('shopStatus_' + v)]) }] : []),
    { name: 'notes', label: t('notes'), type: 'textarea', value: s?.notes },
  ], async (v) => {
    if (s) await api('PATCH', `/shops/${s.id}`, v); else await api('POST', '/shops', v);
    toast(t('saved'));
    app.rerender();
  });

  const metrics = async (s) => {
    const rows = await api('GET', `/shops/${s.id}/metrics`);
    const label = Object.fromEntries(METRIC_KEYS);
    const content = h('div', {},
      table([
        { label: t('date'), key: 'date' }, { label: '指标 Metric', render: (m) => label[m.metric_key] || m.metric_key },
        { label: '值 Value', key: 'value', class: 'num' }, { label: t('source'), render: (m) => badge(t('src_' + m.data_source), 'src-' + m.data_source) },
      ], rows));
    modal(`${s.name} · 店铺绩效 Performance`, app.can('metrics.manage') ? [
      content,
      { name: 'date', label: t('date'), type: 'date', value: klDate(), required: true },
      { name: 'metricKey', label: '指标 Metric', type: 'select', options: METRIC_KEYS, required: true },
      { name: 'value', label: '值 Value', type: 'number', required: true },
    ] : [content], async (v) => {
      if (!app.can('metrics.manage')) return;
      await api('POST', `/shops/${s.id}/metrics`, v);
      toast(t('saved'));
    }, { submitLabel: app.can('metrics.manage') ? t('add') : t('close') });
  };

  el.append(
    h('div', { class: 'page-head' }, h('h1', {}, t('nav_shops')), canManage ? h('button', { class: 'primary', onclick: () => editShop() }, t('add')) : null),
    table([
      { label: 'ID', key: 'id' },
      { label: t('shop'), render: (s) => h('b', {}, s.name) },
      { label: t('platform'), render: (s) => (s.platform === 'tiktok' ? 'TikTok Shop' : 'Shopee') },
      { label: t('region'), key: 'region' },
      { label: t('status'), render: (s) => t('shopStatus_' + s.status) },
      { label: t('authStatus'), render: (s) => badge(t('auth_' + s.auth_status), authKind[s.auth_status]) },
      { label: t('externalShopId'), render: (s) => s.external_shop_id || '—' },
      { label: t('lastSync'), render: (s) => klDateTime(s.last_sync_at) },
      { label: t('actions'), render: (s) => h('div', { class: 'row-actions' },
        h('button', { onclick: () => guard(() => metrics(s)) }, '绩效'),
        canManage ? h('button', { onclick: () => editShop(s) }, t('edit')) : null,
        app.can('integrations.manage') ? h('button', { onclick: () => app.navigate('integrations') }, t('authStatus')) : null,
        canManage ? h('button', { class: 'danger', onclick: async () => {
          if (!(await confirmDialog(`${t('delete')} ${s.name}?`))) return;
          await guard(() => api('DELETE', `/shops/${s.id}`));
          app.rerender();
        } }, t('delete')) : null) },
    ], shops),
  );
}
