import { api } from '../api.js';
import { t } from '../i18n.js';
import { h, formField, readForm, stateBadge, klDate, addDays, toast } from '../ui.js';

export async function render(el, app) {
  const providers = await api('GET', '/ai/providers');
  const out = h('div', { class: 'panel ai-out' });
  const tasks = [['dashboard', t('task_dashboard')], ...(app.can('costs.view') ? [['profit_review', t('task_profit_review')]] : [])];
  const form = h('form', { class: 'panel' },
    h('div', { class: 'grid three' },
      formField({ name: 'provider', label: t('provider'), type: 'select', options: providers.map((p) => [p.provider, `${p.provider === 'anthropic' ? 'Claude' : 'OpenAI'} · ${p.model}${p.configured ? '' : ' (' + t('state_not_connected') + ')'}`]) }),
      formField({ name: 'task', label: t('aiTask'), type: 'select', options: tasks }),
      formField({ name: 'shopId', label: t('shop'), type: 'select', options: app.shopOptions() }),
      formField({ name: 'from', label: t('from'), type: 'date', value: addDays(klDate(), -29) }),
      formField({ name: 'to', label: t('to'), type: 'date', value: klDate() })),
    formField({ name: 'question', label: t('aiQuestion'), type: 'textarea', placeholder: '例如：近30天哪个店铺的广告效率最差？洗衣液 SKU 的定价是否需要调整？' }),
    h('button', { class: 'primary' }, t('ask')),
    h('p', { class: 'hint' }, '只会发送汇总后的经营数据（不含买家个人信息）到所选 AI 服务。AI 结果仅供参考。'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    out.replaceChildren(h('div', { class: 'loading' }, t('loading')));
    try {
      const r = await api('POST', '/ai/analyze', readForm(form));
      out.replaceChildren(h('small', { class: 'hint' }, `${r.model} · ${r.disclaimer}`), h('pre', { class: 'ai-text' }, r.text));
    } catch (err) {
      out.replaceChildren(h('div', { class: 'error-box' }, err.message));
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  el.append(h('div', { class: 'page-head' }, h('h1', {}, t('nav_ai')),
    h('div', { class: 'badges' }, providers.map((p) => [h('span', {}, p.provider === 'anthropic' ? 'Claude ' : 'OpenAI '), stateBadge(p.configured ? p.status.state : 'not_connected')]))),
  form, out);
}
