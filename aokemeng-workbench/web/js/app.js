import { api, setToken, setUnauthorizedHandler } from './api.js';
import { t, setLocale, getLocale, LOCALES } from './i18n.js';
import { h, formField, readForm, toast } from './ui.js';

const ROUTES = [
  { path: 'dashboard', perm: 'dashboard.view', icon: '▦', load: () => import('./views/dashboard.js') },
  { path: 'shops', perm: 'shops.view', icon: '🏪', load: () => import('./views/shops.js') },
  { path: 'products', perm: 'products.view', icon: '📦', load: () => import('./views/products.js') },
  { path: 'profit', perm: 'costs.view', icon: '💹', load: () => import('./views/profit.js') },
  { path: 'orders', perm: 'orders.view', icon: '🧾', load: () => import('./views/orders.js') },
  { path: 'refunds', perm: 'refunds.view', icon: '↩', load: () => import('./views/refunds.js') },
  { path: 'ads', perm: 'ads.manage', icon: '📣', load: () => import('./views/ads.js') },
  { path: 'alerts', perm: 'alerts.view', icon: '⚠', load: () => import('./views/alerts.js') },
  { path: 'integrations', perm: 'integrations.manage', icon: '🔌', load: () => import('./views/integrations.js') },
  { path: 'ai', perm: 'ai.use', icon: '✦', load: () => import('./views/ai.js') },
  { path: 'users', perm: 'users.manage', icon: '👥', load: () => import('./views/users.js') },
  { path: 'audit', perm: 'audit.view', icon: '📜', load: () => import('./views/audit.js') },
  { path: 'account', perm: null, icon: '⚙', load: () => import('./views/account.js') },
];

export const app = {
  user: null,
  shops: [],
  can(perm) { return !perm || this.user?.permissions.includes(perm); },
  async reloadShops() {
    this.shops = this.can('shops.view') ? await api('GET', '/shops') : [];
    return this.shops;
  },
  /** 店铺下拉（含“全部店铺”） */
  shopOptions(includeAll = true) {
    const opts = this.shops.map((s) => [s.id, `${s.name} (${s.platform === 'tiktok' ? 'TikTok' : 'Shopee'})`]);
    return includeAll ? [['', t('allShops')], ...opts] : opts;
  },
  navigate(path) { location.hash = `#/${path}`; },
  rerender() { render(); },
};

const root = document.getElementById('app');

setUnauthorizedHandler(() => {
  setToken(null);
  app.user = null;
  render();
});

async function boot() {
  const status = await api('GET', '/system/status');
  app.status = status;
  if (status.needsSetup) return renderSetup();
  try {
    const { user } = await api('GET', '/auth/me');
    await onLogin(user);
  } catch {
    renderLogin();
  }
}

async function onLogin(user) {
  app.user = user;
  if (user.locale && user.locale !== getLocale()) setLocale(user.locale);
  await app.reloadShops();
  if (!location.hash) app.navigate('dashboard');
  render();
}

function langSwitch() {
  return h('select', {
    class: 'lang', 'aria-label': 'language',
    onchange: async (e) => {
      setLocale(e.target.value);
      if (app.user) await api('PATCH', '/auth/me', { locale: e.target.value }).catch(() => {});
      app.user ? render() : boot();
    },
  }, LOCALES.map(([v, l]) => h('option', { value: v, selected: v === getLocale() }, l)));
}

function authShell(title, content) {
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-card' },
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'A'), h('div', {}, h('b', {}, 'AOKEMENG'), h('small', {}, t('appName')))),
      h('h2', {}, title), content, h('div', { class: 'auth-foot' }, langSwitch()))));
}

function renderSetup() {
  const form = h('form', {},
    h('p', { class: 'hint' }, t('setupHint')),
    formField({ name: 'companyName', label: t('companyName'), value: 'AOKEMENG Malaysia Sdn Bhd' }),
    formField({ name: 'displayName', label: t('displayName'), required: true }),
    formField({ name: 'username', label: t('username'), required: true, autocomplete: 'username' }),
    formField({ name: 'password', label: t('password'), type: 'password', required: true, autocomplete: 'new-password' }),
    h('button', { class: 'primary block', type: 'submit' }, t('create')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('POST', '/system/setup', { ...readForm(form), locale: getLocale() });
      setToken(res.session.token);
      await onLogin(res.user);
    } catch (err) { toast(err.message, 'error'); }
  });
  authShell(t('setupTitle'), form);
}

function renderLogin() {
  const form = h('form', {},
    formField({ name: 'username', label: t('username'), required: true, autocomplete: 'username' }),
    formField({ name: 'password', label: t('password'), type: 'password', required: true, autocomplete: 'current-password' }),
    h('button', { class: 'primary block', type: 'submit' }, t('login')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('POST', '/auth/login', readForm(form));
      setToken(res.session.token);
      await onLogin(res.user);
    } catch (err) { toast(err.message, 'error'); }
  });
  authShell(t('login'), form);
}

let renderSeq = 0;
async function render() {
  if (!app.user) return boot();
  const seq = ++renderSeq;
  const path = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'dashboard';
  const allowed = ROUTES.filter((r) => app.can(r.perm));
  const route = allowed.find((r) => r.path === path) || allowed[0];

  const main = h('main', { class: 'content' }, h('div', { class: 'loading' }, t('loading')));
  const offline = h('div', { class: 'offline-banner', hidden: navigator.onLine }, t('offline'));
  root.replaceChildren(h('div', { class: 'layout' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'A'), h('div', {}, h('b', {}, 'AOKEMENG'), h('small', {}, 'TikTok Workbench'))),
      h('nav', {}, allowed.map((r) => h('a', { href: `#/${r.path}`, class: r === route ? 'active' : '' }, h('i', {}, r.icon), t('nav_' + r.path)))),
      h('div', { class: 'me' },
        h('div', {}, h('b', {}, app.user.displayName), h('small', {}, app.user.roleName?.[getLocale()] || app.user.role)),
        langSwitch(),
        h('button', { class: 'link', onclick: logout }, t('logout')))),
    h('div', { class: 'main-col' }, offline, main)));

  if (app.user.mustChangePassword && route.path !== 'account') {
    toast(t('mustChange'), 'warn');
    return app.navigate('account');
  }
  try {
    const mod = await route.load();
    if (seq !== renderSeq) return;
    main.replaceChildren();
    await mod.render(main, app);
  } catch (e) {
    if (seq === renderSeq) main.replaceChildren(h('div', { class: 'error-box' }, e.message));
  }
}

async function logout() {
  await api('POST', '/auth/logout').catch(() => {});
  setToken(null);
  app.user = null;
  boot();
}

window.addEventListener('hashchange', () => app.user && render());
window.addEventListener('online', () => { document.querySelector('.offline-banner')?.setAttribute('hidden', ''); api('POST', '/sync/retry').catch(() => {}); });
window.addEventListener('offline', () => document.querySelector('.offline-banner')?.removeAttribute('hidden'));

setLocale(getLocale());
boot().catch((e) => root.replaceChildren(h('div', { class: 'error-box' }, `无法连接本地服务: ${e.message}`)));
