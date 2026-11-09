import { api, qs } from '../api.js';
import { t } from '../i18n.js';
import { h, table, modal, badge, money, senToInput, toast, guard, formField, readForm, pickFile } from '../ui.js';

let filters = { shopId: '', q: '' };

export async function render(el, app) {
  const canManage = app.can('products.manage');
  const body = h('div', {});
  const form = h('form', { class: 'filters' },
    formField({ name: 'shopId', label: t('shop'), type: 'select', options: app.shopOptions(), value: filters.shopId }),
    formField({ name: 'q', label: t('search'), value: filters.q, placeholder: `${t('title')} / ${t('sellerSku')}` }),
    h('div', { class: 'filter-actions' }, h('button', { class: 'primary' }, t('apply'))));
  form.addEventListener('submit', (e) => { e.preventDefault(); filters = readForm(form); load(); });

  const addProduct = () => modal(t('add'), [
    { name: 'shopId', label: t('shop'), type: 'select', options: app.shopOptions(false), required: true, value: filters.shopId },
    { name: 'title', label: t('title'), required: true, placeholder: 'AOKEMENG 洗衣液 3kg' },
    { name: 'category', label: t('category'), placeholder: '洗衣液 / 厨房清洁' },
    { name: 'sellerSku', label: t('sellerSku'), required: true },
    { name: 'skuName', label: 'SKU 规格 Variant' },
    { name: 'price', label: `${t('price')} (MYR)`, type: 'number', required: true },
    { name: 'stock', label: t('stock'), type: 'number' },
  ], async (v) => { await api('POST', '/products', v); toast(t('saved')); load(); });

  const importCsv = async () => {
    const shopId = filters.shopId || app.shops[0]?.id;
    if (!shopId) return toast('请先选择店铺', 'error');
    const file = await pickFile();
    if (!file) return;
    const res = await guard(() => api('POST', `/import/products${qs({ shopId })}`, file.text, { contentType: 'text/csv' }));
    toast(`OK ${res.ok}，错误 ${res.errors.length}${res.errors.length ? '：' + res.errors.slice(0, 3).map((e) => `第${e.line}行 ${e.error}`).join('；') : ''}`, res.errors.length ? 'warn' : 'ok');
    load();
  };

  const editSku = (p) => {
    const apiManaged = p.dataSource === 'api';
    modal(`${p.sellerSku} · ${p.title}`, [
      apiManaged ? h('p', { class: 'hint' }, '价格与库存来自 TikTok Shop 接口，请在平台后台修改后重新同步。') : null,
      { name: 'title', label: t('title'), value: p.title },
      ...(apiManaged ? [] : [
        { name: 'price', label: `${t('price')} (MYR)`, type: 'number', value: senToInput(p.priceSen) },
        { name: 'stock', label: t('stock'), type: 'number', value: p.stock ?? '' },
      ]),
      { name: 'lowStockThreshold', label: t('lowStock'), type: 'number', value: p.lowStockThreshold },
      { name: 'productStatus', label: t('status'), type: 'select', value: p.productStatus, options: [['active', 'active'], ['inactive', 'inactive']] },
    ].filter(Boolean), async (v) => { await api('PATCH', `/skus/${p.skuId}`, v); toast(t('saved')); load(); });
  };

  el.append(
    h('div', { class: 'page-head' }, h('h1', {}, t('nav_products')),
      h('div', { class: 'row-actions' },
        canManage ? h('button', { onclick: importCsv, title: 'CSV 列: seller_sku,title,price,stock,category,sku_name' }, t('import')) : null,
        canManage ? h('button', { class: 'primary', onclick: addProduct }, t('add')) : null)),
    form, body);

  async function load() {
    const rows = await api('GET', `/products${qs(filters)}`);
    const showCost = app.can('costs.view');
    body.replaceChildren(table([
      { label: t('shop'), key: 'shopName' },
      { label: t('title'), render: (p) => h('div', {}, h('b', {}, p.title), p.skuName ? h('small', { class: 'block' }, p.skuName) : null) },
      { label: t('sellerSku'), key: 'sellerSku' },
      { label: t('price'), render: (p) => money(p.priceSen), class: 'num' },
      { label: t('stock'), render: (p) => (p.stock == null ? '—' : h('span', { class: p.stock <= 0 ? 'bad' : p.stock <= p.lowStockThreshold ? 'warn' : '' }, p.stock)), class: 'num' },
      ...(showCost ? [
        { label: t('unitProfit'), render: (p) => (p.profit ? h('span', { class: p.profit.isLoss ? 'bad' : '' }, money(p.profit.profitSen)) : badge(t('costMissing'), 'muted')), class: 'num' },
        { label: t('margin'), render: (p) => (p.profit?.marginPct != null ? `${p.profit.marginPct}%` : '—'), class: 'num' },
      ] : []),
      { label: t('source'), render: (p) => badge(t('src_' + p.dataSource), 'src-' + p.dataSource) },
      { label: t('actions'), render: (p) => h('div', { class: 'row-actions' },
        canManage ? h('button', { onclick: () => editSku(p) }, t('edit')) : null,
        showCost ? h('button', { onclick: () => app.navigate(`profit?sku=${p.skuId}`) }, t('cost')) : null) },
    ], rows));
  }
  await load();
}
