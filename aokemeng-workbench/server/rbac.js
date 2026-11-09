'use strict';
/** 角色与权限（RBAC）。权限点集中定义，路由层通过 requirePerm 校验。 */
const PERMISSIONS = [
  'dashboard.view', 'finance.view',
  'shops.view', 'shops.manage',
  'products.view', 'products.manage',
  'costs.view', 'costs.manage',
  'orders.view', 'orders.manage',
  'refunds.view', 'refunds.manage',
  'ads.manage', 'metrics.manage',
  'alerts.view', 'alerts.manage',
  'sync.run', 'integrations.manage',
  'ai.use', 'export.data',
  'users.manage', 'audit.view', 'settings.manage',
];

const ROLES = {
  admin: { zh: '系统管理员', en: 'Administrator', ms: 'Pentadbir', allShops: true, perms: PERMISSIONS },
  director: { zh: '公司董事', en: 'Director', ms: 'Pengarah', allShops: true, perms: PERMISSIONS },
  country_manager: {
    zh: '国家负责人', en: 'Country Manager', ms: 'Pengurus Negara', allShops: true,
    perms: PERMISSIONS.filter((p) => !['users.manage', 'settings.manage'].includes(p)),
  },
  shop_operator: {
    zh: '店铺运营', en: 'Shop Operator', ms: 'Operator Kedai', allShops: false,
    perms: ['dashboard.view', 'finance.view', 'shops.view', 'products.view', 'products.manage', 'costs.view',
      'orders.view', 'orders.manage', 'refunds.view', 'refunds.manage', 'ads.manage', 'metrics.manage',
      'alerts.view', 'alerts.manage', 'sync.run', 'ai.use', 'export.data'],
  },
  content_operator: {
    zh: '内容运营', en: 'Content Operator', ms: 'Operator Kandungan', allShops: false,
    perms: ['dashboard.view', 'shops.view', 'products.view', 'orders.view', 'alerts.view', 'ai.use'],
  },
  host: {
    zh: '主播', en: 'Live Host', ms: 'Hos Siaran Langsung', allShops: false,
    perms: ['dashboard.view', 'shops.view', 'products.view', 'ai.use'],
  },
  creator_bd: {
    zh: '达人 BD', en: 'Creator BD', ms: 'BD Kreator', allShops: false,
    perms: ['dashboard.view', 'shops.view', 'products.view', 'costs.view', 'ai.use'],
  },
  finance: {
    zh: '财务人员', en: 'Finance', ms: 'Kewangan', allShops: true,
    perms: ['dashboard.view', 'finance.view', 'shops.view', 'products.view', 'costs.view', 'costs.manage',
      'orders.view', 'refunds.view', 'refunds.manage', 'ads.manage', 'alerts.view', 'export.data', 'audit.view'],
  },
};

function hasPerm(user, perm) {
  const role = ROLES[user?.role];
  return !!role && role.perms.includes(perm);
}

/** 返回用户可访问的店铺 ID 列表；null 表示全部 */
function shopScope(db, user) {
  if (ROLES[user.role]?.allShops) return null;
  return db.all('SELECT shop_id FROM user_shops WHERE user_id = ?', [user.id]).map((r) => r.shop_id);
}

function canAccessShop(db, user, shopId) {
  const scope = shopScope(db, user);
  return scope === null || scope.includes(Number(shopId));
}

/** 生成 SQL 片段：限制到可访问店铺，并叠加可选的店铺筛选 */
function shopFilterSql(db, user, column, requestedShopId) {
  const scope = shopScope(db, user);
  let ids = scope;
  if (requestedShopId) {
    const id = Number(requestedShopId);
    ids = scope === null || scope.includes(id) ? [id] : [];
  }
  if (ids === null) return { sql: '1=1', params: [] };
  if (!ids.length) return { sql: '1=0', params: [] };
  return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

module.exports = { PERMISSIONS, ROLES, hasPerm, shopScope, canAccessShop, shopFilterSql };
