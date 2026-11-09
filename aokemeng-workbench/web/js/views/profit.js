import { api } from '../api.js';
import { t } from '../i18n.js';
import { h, money, senToInput, formField, readForm, toast, guard, badge } from '../ui.js';

const MONEY_FIELDS = ['purchase_cost', 'packaging_cost', 'shipping_cost', 'shipping_subsidy', 'seller_discount', 'ad_cost_per_unit', 'other_cost'];
const RATE_FIELDS = ['commission_rate', 'transaction_fee_rate', 'affiliate_rate'];

export async function render(el, app) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const products = await api('GET', '/products');
  const canSave = app.can('costs.manage');
  let selected = products.find((p) => String(p.skuId) === params.get('sku')) || null;

  const result = h('div', { class: 'panel result' });
  const formHolder = h('div', {});

  function buildForm() {
    const c = selected?.cost || {};
    const form = h('form', { class: 'calc-form' },
      formField({ name: 'sku', label: t('pickSku'), type: 'select', value: selected?.skuId || '',
        options: [['', '—'], ...products.map((p) => [p.skuId, `${p.shopName} · ${p.sellerSku} · ${p.title}`])] }),
      h('div', { class: 'grid three' },
        formField({ name: 'price', label: `${t('price')} (MYR)`, type: 'number', required: true, value: selected ? senToInput(selected.priceSen) : '' }),
        ...MONEY_FIELDS.map((k) => formField({ name: k, label: `${t(k)} (MYR)`, type: 'number', value: c[k + '_sen'] != null ? senToInput(c[k + '_sen']) : '' })),
        ...RATE_FIELDS.map((k) => formField({ name: k, label: t(k), type: 'number', value: c[k] ?? '' })),
        formField({ name: 'quantity', label: t('quantity'), type: 'number', value: '' }),
        formField({ name: 'targetMarginPct', label: t('targetMargin'), type: 'number', value: '' })),
      formField({ name: 'notes', label: t('notes'), value: c.notes || '' }),
      h('div', { class: 'row-actions' },
        h('button', { class: 'primary', type: 'submit' }, t('trial')),
        canSave && selected ? h('button', { type: 'button', onclick: () => save(form) }, t('saveCost')) : null),
      h('p', { class: 'hint' }, t('calcHint'),
        selected ? [' ', badge(t('src_' + selected.dataSource), 'src-' + selected.dataSource), ` ${t('price')} ← ${selected.sellerSku}`] : null));
    form.querySelector('[name=sku]').addEventListener('change', (e) => {
      selected = products.find((p) => String(p.skuId) === e.target.value) || null;
      history.replaceState(null, '', selected ? `#/profit?sku=${selected.skuId}` : '#/profit');
      buildForm();
    });
    form.addEventListener('input', () => calc(form));
    form.addEventListener('submit', (e) => { e.preventDefault(); calc(form); });
    formHolder.replaceChildren(form);
    calc(form);
  }

  let calcSeq = 0;
  async function calc(form) {
    const v = readForm(form);
    if (v.price === '') { result.replaceChildren(h('div', { class: 'empty' }, t('noData'))); return; }
    const seq = ++calcSeq;
    let r;
    try { r = await api('POST', '/profit/calculate', v); } catch (e) { result.replaceChildren(h('div', { class: 'error-box' }, e.message)); return; }
    if (seq !== calcSeq) return;
    const u = r.unit;
    const row = (label, sen, cls = '') => h('tr', { class: cls }, h('td', {}, label), h('td', { class: 'num' }, money(sen)));
    result.replaceChildren(
      h('div', { class: `big ${u.isLoss ? 'bad' : 'ok'}` }, h('small', {}, t('unitProfit')), money(u.profitSen),
        h('span', {}, u.marginPct != null ? ` ${u.marginPct}%` : ''), u.isLoss ? badge(t('loss'), 'bad') : null),
      h('table', { class: 'breakdown' }, h('tbody', {},
        row(t('netPrice'), u.netPriceSen, 'strong'),
        row(t('purchase_cost'), -u.breakdown.purchaseSen),
        row(t('packaging_cost'), -u.breakdown.packagingSen),
        row(t('commission_rate').replace(' (%)', ''), -u.breakdown.commissionSen),
        row(t('transaction_fee_rate').replace(' (%)', ''), -u.breakdown.transactionFeeSen),
        row(t('affiliate_rate').replace(' (%)', ''), -u.breakdown.affiliateSen),
        row(`${t('shipping_cost')} - ${t('shipping_subsidy')}`, -u.breakdown.shippingNetSen),
        row(t('ad_cost_per_unit'), -u.breakdown.adsSen),
        row(t('other_cost'), -u.breakdown.otherSen),
        row(t('totalCost'), u.totalCostSen, 'strong'),
        row(t('breakEven'), u.breakEvenPriceSen, 'strong'),
        r.targetPriceSen != null ? row(`${t('targetPrice')} (${v.targetMarginPct}%)`, r.targetPriceSen, 'strong') : null,
        r.quantity ? row(`${t('profitTotal')} × ${r.quantity.quantity}`, r.quantity.profitSen, 'strong') : null)),
      h('p', { class: 'hint' }, badge(t('src_estimate'), 'src-estimate'), ' ', t('calcHint')));
  }

  async function save(form) {
    const v = readForm(form);
    await guard(() => api('PUT', `/skus/${selected.skuId}/cost`, v));
    toast(t('saved'));
  }

  el.append(h('div', { class: 'page-head' }, h('h1', {}, t('nav_profit'))), h('div', { class: 'grid calc' }, h('section', { class: 'panel' }, formHolder), result));
  buildForm();
}
