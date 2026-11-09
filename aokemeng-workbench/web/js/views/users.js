import { api } from '../api.js';
import { t, getLocale } from '../i18n.js';
import { h, table, modal, badge, klDateTime, toast } from '../ui.js';

export async function render(el, app) {
  const [users, roles] = await Promise.all([api('GET', '/users'), api('GET', '/roles')]);
  const roleName = (k) => roles.find((r) => r.key === k)?.[getLocale()] || k;
  const shopName = (id) => app.shops.find((s) => s.id === id)?.name || `#${id}`;
  const roleOptions = roles.map((r) => [r.key, `${r[getLocale()]}${r.allShops ? ' · ' + t('allShopsRole') : ''}`]);
  const shopField = (value) => ({ name: 'shopIds', label: `${t('assignedShops')}（Ctrl/⌘ 多选；全店铺角色可忽略）`, type: 'select', multiple: true, options: app.shopOptions(false), value });

  const add = () => modal(t('newUser'), [
    { name: 'displayName', label: t('displayName'), required: true },
    { name: 'username', label: t('username'), required: true },
    { name: 'password', label: t('initialPassword'), type: 'password', required: true, hint: t('mustChange') },
    { name: 'role', label: t('role'), type: 'select', options: roleOptions, value: 'shop_operator', required: true },
    shopField([]),
  ], async (v) => { await api('POST', '/users', v); toast(t('saved')); app.rerender(); });

  const edit = (u) => modal(`${t('edit')} · ${u.username}`, [
    { name: 'displayName', label: t('displayName'), value: u.displayName, required: true },
    { name: 'role', label: t('role'), type: 'select', options: roleOptions, value: u.role },
    shopField(u.shopIds),
    { name: 'active', label: t('active'), type: 'checkbox', value: u.active },
    { name: 'password', label: `${t('resetPassword')}（留空不修改）`, type: 'password' },
  ], async (v) => {
    if (!v.password) delete v.password;
    await api('PATCH', `/users/${u.id}`, v);
    toast(t('saved'));
    app.rerender();
  });

  el.append(
    h('div', { class: 'page-head' }, h('h1', {}, t('nav_users')), h('button', { class: 'primary', onclick: add }, t('newUser'))),
    table([
      { label: t('displayName'), render: (u) => h('b', {}, u.displayName) },
      { label: t('username'), key: 'username' },
      { label: t('role'), render: (u) => roleName(u.role) },
      { label: t('assignedShops'), render: (u) => (u.allShops ? t('allShopsRole') : u.shopIds.map(shopName).join('、') || '—') },
      { label: t('status'), render: (u) => (u.active ? badge(t('active'), 'ok') : badge('停用', 'muted')) },
      { label: t('lastLogin'), render: (u) => klDateTime(u.lastLoginAt) },
      { label: '', render: (u) => h('button', { onclick: () => edit(u) }, t('edit')) },
    ], users),
    h('h2', {}, t('permissions')),
    table([
      { label: t('role'), render: (r) => r[getLocale()] },
      { label: t('allShopsRole'), render: (r) => (r.allShops ? '✓' : '') },
      { label: t('permissions'), render: (r) => h('small', {}, r.permissions.join(', ')) },
    ], roles));
}
