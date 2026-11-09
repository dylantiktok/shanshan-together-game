import { api, qs, download } from '../api.js';
import { t } from '../i18n.js';
import { h, table, modal, badge, money, klDateTime, klDate, addDays, formField, readForm, toast, guard, pickFile, confirmDialog , setContent } from '../ui.js';

let filters = { shopId: '', from: addDays(klDate(), -29), to: klDate(), status: '', source: '', q: '' };
const PAGE = 100;

export async function render(el, app) {
  const statuses = await api('GET', '/meta/order-statuses');
  const canManage = app.can('orders.manage');
  let offset = 0;
  const body = h('div', {});
  const form = h('form', { class: 'filters' },
    formField({ name: 'shopId', label: t('shop'), type: 'select', options: app.shopOptions(), value: filters.shopId }),
    formField({ name: 'from', label: t('from'), type: 'date', value: filters.from }),
    formField({ name: 'to', label: t('to'), type: 'date', value: filters.to }),
    formField({ name: 'status', label: t('status'), type: 'select', options: [['', t('all')], ...statuses.map((s) => [s, s])], value: filters.status }),
    formField({ name: 'source', label: t('source'), type: 'select', options: [['', t('all')], ...['api', 'manual', 'import'].map((s) => [s, t('src_' + s)])], value: filters.source }),
    formField({ name: 'q', label: t('orderId'), value: filters.q }),
    h('div', { class: 'filter-actions' }, h('button', { class: 'primary' }, t('apply')),
      app.can('export.data') ? h('button', { type: 'button', onclick: () => guard(() => download(`/orders/export.csv${qs(filters)}`, `orders-${filters.to}.csv`)) }, t('export')) : null));
  form.addEventListener('submit', (e) => { e.preventDefault(); filters = readForm(form); offset = 0; load(); });

  const manual = () => {
    const items = h('div', { class: 'items' });
    const addLine = () => items.append(h('div', { class: 'grid four item-line' },
      formField({ name: 'sellerSku', label: t('sellerSku') }), formField({ name: 'productName', label: t('productName') }),
      formField({ name: 'quantity', label: t('quantity'), type: 'number', value: 1 }), formField({ name: 'unitPrice', label: `${t('unitPrice')} (MYR)`, type: 'number' })));
    addLine();
    modal(t('manualOrder'), [
      { name: 'shopId', label: t('shop'), type: 'select', options: app.shopOptions(false), required: true, value: filters.shopId },
      { name: 'externalOrderId', label: t('orderId'), required: true },
      { name: 'orderTime', label: t('orderTime'), type: 'datetime', required: true, hint: t('orderTimeHint'), value: `${klDate()} ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16)}` },
      { name: 'status', label: t('status'), type: 'select', options: statuses.map((s) => [s, s]), value: 'completed', required: true },
      { name: 'total', label: `${t('total')} (MYR)`, type: 'number', hint: t('totalHint') },
      items, h('button', { type: 'button', onclick: addLine }, t('addItem')),
    ], async (v, f) => {
      const lines = [...f.querySelectorAll('.item-line')].map((line) => Object.fromEntries([...line.querySelectorAll('input')].map((i) => [i.name, i.value])));
      const { sellerSku, productName, quantity, unitPrice, ...rest } = v;
      await api('POST', '/orders', { ...rest, items: lines });
      toast(t('saved'));
      load();
    });
  };

  const importCsv = async () => {
    const shopId = filters.shopId || app.shops[0]?.id;
    if (!shopId) return toast('请先在筛选中选择店铺', 'error');
    const file = await pickFile();
    if (!file) return;
    const r = await guard(() => api('POST', `/import/orders${qs({ shopId })}`, file.text, { contentType: 'text/csv' }));
    toast(`新增 ${r.created}，更新 ${r.updated}，跳过 ${r.skipped}，错误 ${r.errors.length}`, r.errors.length ? 'warn' : 'ok');
    load();
  };

  const detail = async (o) => {
    const d = await api('GET', `/orders/${o.id}`);
    modal(`${t('orderId')} ${d.external_order_id}`, [h('div', {},
      h('p', {}, `${d.shop_name} · ${klDateTime(d.order_time)} · ${d.status} · ${money(d.total_sen)} `, badge(t('src_' + d.data_source), 'src-' + d.data_source)),
      table([{ label: t('sellerSku'), key: 'seller_sku' }, { label: t('productName'), key: 'product_name' }, { label: t('quantity'), key: 'quantity', class: 'num' },
        { label: t('unitPrice'), render: (i) => money(i.unit_price_sen), class: 'num' }, { label: 'SKU', render: (i) => (i.sku_id ? '✓' : '未匹配') }], d.items),
      d.refunds.length ? h('p', {}, `${t('nav_refunds')}: ${d.refunds.map((r) => money(r.amount_sen)).join(', ')}`) : null,
      canManage && d.data_source !== 'api' ? h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!(await confirmDialog(`${t('delete')} ${d.external_order_id}?`))) return;
        await guard(() => api('DELETE', `/orders/${d.id}`));
        document.querySelector('.overlay')?.remove();
        load();
      } }, t('delete')) : null)], async () => {}, { submitLabel: t('close') });
  };

  el.append(h('div', { class: 'page-head' }, h('h1', {}, t('nav_orders')),
    canManage ? h('div', { class: 'row-actions' },
      h('button', { onclick: importCsv, title: 'CSV 列: order_id,order_time,status,total,seller_sku,product_name,quantity,unit_price' }, t('import')),
      h('button', { class: 'primary', onclick: manual }, t('manualOrder'))) : null), form, body);

  async function load() {
    const { total, rows } = await api('GET', `/orders${qs({ ...filters, limit: PAGE, offset })}`);
    setContent(body,
      h('p', { class: 'hint' }, `${total} ${t('orderCount')}`),
      table([
        { label: t('shop'), key: 'shop_name' },
        { label: t('orderId'), render: (o) => h('button', { class: 'link', type: 'button', onclick: () => guard(() => detail(o)) }, o.external_order_id) },
        { label: t('orderTime'), render: (o) => klDateTime(o.order_time) },
        { label: t('status'), render: (o) => badge(o.status, o.status === 'cancelled' ? 'muted' : '') },
        { label: t('items'), key: 'item_count', class: 'num' },
        { label: t('amount'), render: (o) => money(o.total_sen), class: 'num' },
        { label: t('source'), render: (o) => badge(t('src_' + o.data_source), 'src-' + o.data_source) },
      ], rows),
      total > PAGE ? h('div', { class: 'pager' },
        h('button', { disabled: offset === 0, onclick: () => { offset -= PAGE; load(); } }, '‹'),
        h('span', {}, `${offset + 1}–${Math.min(offset + PAGE, total)} / ${total}`),
        h('button', { disabled: offset + PAGE >= total, onclick: () => { offset += PAGE; load(); } }, '›')) : null);
  }
  await load();
}
