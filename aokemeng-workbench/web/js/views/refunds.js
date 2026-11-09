import { api, qs } from '../api.js';
import { t } from '../i18n.js';
import { h, table, modal, badge, money, klDateTime, klDate, addDays, formField, readForm, toast } from '../ui.js';

let filters = { shopId: '', from: addDays(klDate(), -29), to: klDate() };

export async function render(el, app) {
  const body = h('div', {});
  const form = h('form', { class: 'filters' },
    formField({ name: 'shopId', label: t('shop'), type: 'select', options: app.shopOptions(), value: filters.shopId }),
    formField({ name: 'from', label: t('from'), type: 'date', value: filters.from }),
    formField({ name: 'to', label: t('to'), type: 'date', value: filters.to }),
    h('div', { class: 'filter-actions' }, h('button', { class: 'primary' }, t('apply'))));
  form.addEventListener('submit', (e) => { e.preventDefault(); filters = readForm(form); load(); });

  const add = () => modal(t('manualRefund'), [
    { name: 'shopId', label: t('shop'), type: 'select', options: app.shopOptions(false), required: true, value: filters.shopId },
    { name: 'externalOrderId', label: t('orderId') },
    { name: 'externalRefundId', label: 'Refund / Return ID' },
    { name: 'type', label: t('refundType'), type: 'select', options: ['refund', 'return_and_refund', 'replacement'].map((v) => [v, t('type_' + v)]) },
    { name: 'amount', label: `${t('amount')} (MYR)`, type: 'number', required: true },
    { name: 'status', label: t('status'), type: 'select', options: ['pending', 'approved', 'completed', 'rejected'].map((v) => [v, t('rstatus_' + v)]) },
    { name: 'refundTime', label: t('refundTime'), type: 'datetime', required: true, hint: t('orderTimeHint'), value: `${klDate()} ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16)}` },
    { name: 'reason', label: t('reason'), type: 'textarea' },
  ], async (v) => { await api('POST', '/refunds', v); toast(t('saved')); load(); });

  el.append(h('div', { class: 'page-head' }, h('h1', {}, t('nav_refunds')),
    app.can('refunds.manage') ? h('button', { class: 'primary', onclick: add }, t('manualRefund')) : null), form, body);

  async function load() {
    const rows = await api('GET', `/refunds${qs(filters)}`);
    const sum = rows.filter((r) => r.status !== 'rejected').reduce((a, r) => a + r.amount_sen, 0);
    body.replaceChildren(h('p', { class: 'hint' }, `${rows.length} · ${t('refundAmount')} ${money(sum)}`), table([
      { label: t('shop'), key: 'shop_name' },
      { label: t('refundTime'), render: (r) => klDateTime(r.refund_time) },
      { label: t('orderId'), render: (r) => r.external_order_id || '—' },
      { label: t('refundType'), render: (r) => t('type_' + r.type) },
      { label: t('amount'), render: (r) => money(r.amount_sen), class: 'num' },
      { label: t('status'), render: (r) => t('rstatus_' + r.status) },
      { label: t('reason'), render: (r) => r.reason || '—' },
      { label: t('source'), render: (r) => badge(t('src_' + r.data_source), 'src-' + r.data_source) },
    ], rows));
  }
  await load();
}
