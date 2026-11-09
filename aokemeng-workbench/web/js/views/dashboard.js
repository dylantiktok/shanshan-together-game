import { api, qs, download } from '../api.js';
import { t } from '../i18n.js';
import { h, money, num, sourceBadges, badge, table, formField, readForm, klDate, addDays, barChart, guard , setContent } from '../ui.js';

let filters = { from: addDays(klDate(), -29), to: klDate(), shopId: '' };

export async function render(el, app) {
  const form = h('form', { class: 'filters' },
    formField({ name: 'from', label: t('from'), type: 'date', value: filters.from }),
    formField({ name: 'to', label: t('to'), type: 'date', value: filters.to }),
    formField({ name: 'shopId', label: t('shop'), type: 'select', options: app.shopOptions(), value: filters.shopId }),
    h('div', { class: 'filter-actions' },
      h('button', { class: 'primary', type: 'submit' }, t('apply')),
      app.can('export.data') ? h('button', { type: 'button', onclick: () => guard(() => download(`/dashboard/export.csv${qs(filters)}`, `dashboard-${filters.to}.csv`)) }, t('export')) : null));
  form.addEventListener('submit', (e) => { e.preventDefault(); filters = readForm(form); load(); });

  const body = h('div', {});
  el.append(h('div', { class: 'page-head' }, h('h1', {}, t('nav_dashboard'))), form,
    h('div', { class: 'legend' }, h('b', {}, t('legendTitle'), '：'), badge(t('src_api'), 'src-api'), badge(t('src_manual'), 'src-manual'), badge(t('src_import'), 'src-import'), badge(t('src_estimate'), 'src-estimate'), h('span', {}, t('legendText'))),
    body);

  async function load() {
    body.replaceChildren(h('div', { class: 'loading' }, t('loading')));
    const d = await api('GET', `/dashboard${qs(filters)}`);
    const card = (label, value, extra, kind = '') => h('div', { class: `card stat ${kind}` }, h('small', {}, label), h('strong', {}, value), h('div', { class: 'card-foot' }, extra));
    const fixedCards = h('div', { class: 'grid cards' },
      card(t('todaySales'), money(d.fixed.today.sales), [sourceBadges(d.fixed.today.bySource), ` ${d.fixed.today.orders} ${t('orderCount')}`]),
      card(t('yesterdaySales'), money(d.fixed.yesterday.sales), [sourceBadges(d.fixed.yesterday.bySource), ` ${d.fixed.yesterday.orders} ${t('orderCount')}`]),
      card(t('last7Sales'), money(d.fixed.last7.sales), sourceBadges(d.fixed.last7.bySource)),
      card(t('last30Sales'), money(d.fixed.last30.sales), sourceBadges(d.fixed.last30.bySource)));

    const r = d.range;
    const rangeCards = h('div', { class: 'grid cards' },
      card(t('rangeSales'), money(r.sales.valueSen), sourceBadges(r.sales.bySource)),
      card(t('orderCount'), num(r.orders.value, 0), sourceBadges(r.orders.bySource)),
      card(t('aov'), money(r.aov.valueSen), sourceBadges(r.sales.bySource)),
      card(t('refundAmount'), money(r.refunds.valueSen), [sourceBadges(r.refunds.bySource), ` ×${r.refunds.count}`]),
      card(t('adSpend'), money(r.adSpend.valueSen), sourceBadges(r.adSpend.bySource)),
      card(t('roas'), r.roas.value == null ? '—' : num(r.roas.value), h('small', { title: r.roas.note }, r.roas.attributedValue != null ? `${t('attributedGmv')} ROAS ${num(r.roas.attributedValue)}` : 'ⓘ')),
      r.grossProfit ? card(t('grossProfit'), money(r.grossProfit.valueSen), [badge(t('src_estimate'), 'src-estimate'), ` ${t('coverage')} ${r.grossProfit.coveragePct}%`], r.grossProfit.coveragePct < 100 ? 'warn' : '') : null,
      r.netProfit ? card(t('netProfit'), money(r.netProfit.valueSen), [badge(t('src_estimate'), 'src-estimate'), h('small', { title: r.netProfit.note }, ' ⓘ')], r.netProfit.valueSen < 0 ? 'bad' : '') : null);

    const hasFinance = !!r.grossProfit;
    const rankingCols = [
      { label: '#', render: (_, i) => '' },
      { label: t('shop'), render: (s) => s.name },
      { label: t('platform'), render: (s) => (s.platform === 'tiktok' ? 'TikTok' : 'Shopee') },
      { label: t('rangeSales'), render: (s) => money(s.sales), class: 'num' },
      { label: t('orderCount'), key: 'orders', class: 'num' },
    ];
    if (hasFinance) rankingCols.push(
      { label: t('refundAmount'), render: (s) => money(s.refunds), class: 'num' },
      { label: t('adSpend'), render: (s) => money(s.ad_spend), class: 'num' },
      { label: 'ROAS', render: (s) => (s.roas == null ? '—' : num(s.roas)), class: 'num' });
    const ranked = d.ranking.map((s, i) => ({ ...s, _rank: i + 1 }));
    rankingCols[0].render = (s) => s._rank;

    setContent(body,
      d.hasData ? null : h('div', { class: 'notice' }, t('noDataHint')),
      fixedCards, h('h2', {}, `${d.period.from} ~ ${d.period.to}`), rangeCards,
      h('div', { class: 'grid two' },
        h('section', { class: 'panel' }, h('h3', {}, t('salesTrend')), barChart(d.trend)),
        h('section', { class: 'panel' }, h('h3', {}, t('shopRanking')), table(rankingCols, ranked))),
      r.grossProfit ? h('p', { class: 'hint' }, r.grossProfit.note, ' ', r.netProfit.note) : null);
  }
  await load();
}
