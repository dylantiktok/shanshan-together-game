import { api, qs } from '../api.js';
import { t } from '../i18n.js';
import { h, table, badge, klDateTime, guard } from '../ui.js';

let status = 'open';

export async function render(el, app) {
  const body = h('div', {});
  const tabs = h('div', { class: 'tabs' },
    ['open', 'resolved'].map((s) => h('button', { class: s === status ? 'active' : '', onclick: () => { status = s; app.rerender(); } }, t(s === 'open' ? 'showOpen' : 'showResolved'))));
  el.append(h('div', { class: 'page-head' }, h('h1', {}, t('nav_alerts')),
    h('button', { onclick: async () => { await guard(() => api('POST', '/alerts/refresh')); load(); } }, t('refresh'))), tabs, body);

  const sevKind = { critical: 'bad', warning: 'warn', info: 'muted' };
  async function load() {
    const rows = await api('GET', `/alerts${qs({ status })}`);
    body.replaceChildren(table([
      { label: t('severity'), render: (a) => badge(t('sev_' + a.severity), sevKind[a.severity]) },
      { label: t('shop'), render: (a) => a.shop_name || '—' },
      { label: t('message'), key: 'message' },
      { label: t('createdAt'), render: (a) => klDateTime(a.created_at) },
      { label: '', render: (a) => (status === 'open' && app.can('alerts.manage')
        ? h('button', { onclick: async () => { await guard(() => api('POST', `/alerts/${a.id}/resolve`)); load(); } }, t('resolve'))
        : klDateTime(a.resolved_at)) },
    ], rows));
  }
  await load();
}
