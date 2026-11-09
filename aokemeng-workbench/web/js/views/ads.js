import { api, qs } from '../api.js';
import { t } from '../i18n.js';
import { h, table, modal, badge, money, klDate, formField, readForm, toast, guard, confirmDialog, num } from '../ui.js';

let filters = { shopId: '' };

export async function render(el, app) {
  const body = h('div', {});
  const form = h('form', { class: 'filters' },
    formField({ name: 'shopId', label: t('shop'), type: 'select', options: app.shopOptions(), value: filters.shopId }),
    h('div', { class: 'filter-actions' }, h('button', { class: 'primary' }, t('apply'))));
  form.addEventListener('submit', (e) => { e.preventDefault(); filters = readForm(form); load(); });

  const add = () => modal(t('addAdSpend'), [
    { name: 'shopId', label: t('shop'), type: 'select', options: app.shopOptions(false), required: true, value: filters.shopId },
    { name: 'date', label: t('date'), type: 'date', value: klDate(), required: true },
    { name: 'channel', label: t('channel'), type: 'select', options: [['GMV Max', 'GMV Max'], ['Product Shopping Ads', 'Product Shopping Ads'], ['LIVE Ads', 'LIVE Ads'], ['Video Shopping Ads', 'Video Shopping Ads'], ['Spark Ads', 'Spark Ads'], ['Other', 'Other']] },
    { name: 'spend', label: `${t('spend')} (MYR)`, type: 'number', required: true },
    { name: 'attributedGmv', label: `${t('attributedGmv')} (MYR)`, type: 'number', hint: '可选：来自广告后台的归因成交额' },
    { name: 'note', label: t('notes') },
  ], async (v) => { await api('POST', '/ads', v); toast(t('saved')); load(); });

  el.append(h('div', { class: 'page-head' }, h('h1', {}, t('nav_ads')), h('button', { class: 'primary', onclick: add }, t('addAdSpend'))),
    h('p', { class: 'hint' }, 'TikTok 广告（Marketing API）尚未接入；当前广告花费需按广告后台报表人工录入，系统标记为“人工录入”。'), form, body);

  async function load() {
    const rows = await api('GET', `/ads${qs(filters)}`);
    body.replaceChildren(table([
      { label: t('date'), key: 'date' }, { label: t('shop'), key: 'shop_name' }, { label: t('channel'), key: 'channel' },
      { label: t('spend'), render: (a) => money(a.spend_sen), class: 'num' },
      { label: t('attributedGmv'), render: (a) => money(a.attributed_gmv_sen), class: 'num' },
      { label: 'ROAS', render: (a) => (a.attributed_gmv_sen != null && a.spend_sen ? num(a.attributed_gmv_sen / a.spend_sen) : '—'), class: 'num' },
      { label: t('source'), render: (a) => badge(t('src_' + a.data_source), 'src-' + a.data_source) },
      { label: t('notes'), render: (a) => a.note || '' },
      { label: '', render: (a) => (a.data_source === 'api' ? '' : h('button', { class: 'danger', onclick: async () => {
        if (!(await confirmDialog(t('delete') + '?'))) return;
        await guard(() => api('DELETE', `/ads/${a.id}`));
        load();
      } }, t('delete'))) },
    ], rows));
  }
  await load();
}
