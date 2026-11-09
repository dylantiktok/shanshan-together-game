import { api, qs } from '../api.js';
import { t } from '../i18n.js';
import { h, table, klDateTime, formField, readForm } from '../ui.js';

let filters = { q: '', action: '' };

export async function render(el) {
  const body = h('div', {});
  const form = h('form', { class: 'filters' },
    formField({ name: 'q', label: t('search'), value: filters.q }),
    formField({ name: 'action', label: t('action'), value: filters.action, placeholder: 'auth / order / sku_cost / integration …' }),
    h('div', { class: 'filter-actions' }, h('button', { class: 'primary' }, t('apply'))));
  form.addEventListener('submit', (e) => { e.preventDefault(); filters = readForm(form); load(); });
  el.append(h('div', { class: 'page-head' }, h('h1', {}, t('nav_audit'))), form, body);

  async function load() {
    const rows = await api('GET', `/audit-logs${qs(filters)}`);
    body.replaceChildren(table([
      { label: t('createdAt'), render: (r) => klDateTime(r.created_at) },
      { label: t('user'), render: (r) => r.username || '—' },
      { label: t('action'), render: (r) => h('code', {}, r.action) },
      { label: t('entity'), render: (r) => `${r.entity || ''} ${r.entity_id || ''}` },
      { label: t('detail'), render: (r) => h('small', { class: 'mono' }, r.detail ? JSON.stringify(r.detail) : '') },
    ], rows));
  }
  await load();
}
