import { api, setToken } from '../api.js';
import { t, getLocale } from '../i18n.js';
import { h, formField, readForm, toast } from '../ui.js';

export async function render(el, app) {
  const u = app.user;
  const form = h('form', { class: 'panel narrow' },
    h('h3', {}, t('changePassword')),
    u.mustChangePassword ? h('div', { class: 'notice' }, t('mustChange')) : null,
    formField({ name: 'oldPassword', label: t('oldPassword'), type: 'password', required: true, autocomplete: 'current-password' }),
    formField({ name: 'newPassword', label: t('newPassword'), type: 'password', required: true, autocomplete: 'new-password', hint: '≥ 8, A-z + 0-9' }),
    h('button', { class: 'primary' }, t('save')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/auth/change-password', readForm(form));
      setToken(r.session.token);
      app.user = (await api('GET', '/auth/me')).user;
      toast(t('saved'));
      app.rerender();
    } catch (err) { toast(err.message, 'error'); }
  });
  el.append(h('div', { class: 'page-head' }, h('h1', {}, t('nav_account'))),
    h('section', { class: 'panel narrow' },
      h('p', {}, h('b', {}, u.displayName), ` (${u.username}) · ${u.roleName?.[getLocale()] || u.role}`),
      h('p', { class: 'hint' }, `${t('permissions')}: ${u.permissions.join(', ')}`)),
    form);
}
