'use strict';
/**
 * 数据库迁移。只追加，不修改已发布的迁移。
 * 约定：金额统一以“仙(sen)”整数存储（1 MYR = 100 sen）；时间统一 ISO-8601 UTC；
 * 业务日期（如广告日报）以马来西亚时区 Asia/Kuala_Lumpur 的 YYYY-MM-DD 存储。
 * data_source 字段取值：api（平台接口实际数据）/ manual（人工录入）/ import（文件导入）/ estimate（估算）
 */
const MIGRATIONS = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'zh',
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok','shopee')),
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'MY',
  external_shop_id TEXT,
  shop_cipher TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  auth_status TEXT NOT NULL DEFAULT 'not_connected',
  auth_expires_at TEXT,
  last_sync_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_shops (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, shop_id)
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  external_product_id TEXT,
  title TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  data_source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, external_product_id)
);

CREATE TABLE skus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  seller_sku TEXT NOT NULL,
  external_sku_id TEXT,
  name TEXT,
  price_sen INTEGER NOT NULL DEFAULT 0,
  stock INTEGER,
  low_stock_threshold INTEGER NOT NULL DEFAULT 20,
  data_source TEXT NOT NULL DEFAULT 'manual',
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, seller_sku)
);

CREATE TABLE sku_costs (
  sku_id INTEGER PRIMARY KEY REFERENCES skus(id) ON DELETE CASCADE,
  purchase_cost_sen INTEGER NOT NULL DEFAULT 0,
  packaging_cost_sen INTEGER NOT NULL DEFAULT 0,
  commission_rate REAL NOT NULL DEFAULT 0,
  transaction_fee_rate REAL NOT NULL DEFAULT 0,
  shipping_cost_sen INTEGER NOT NULL DEFAULT 0,
  shipping_subsidy_sen INTEGER NOT NULL DEFAULT 0,
  affiliate_rate REAL NOT NULL DEFAULT 0,
  seller_discount_sen INTEGER NOT NULL DEFAULT 0,
  ad_cost_per_unit_sen INTEGER NOT NULL DEFAULT 0,
  other_cost_sen INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  external_order_id TEXT NOT NULL,
  order_time TEXT NOT NULL,
  status TEXT NOT NULL,
  total_sen INTEGER NOT NULL DEFAULT 0,
  shipping_fee_sen INTEGER NOT NULL DEFAULT 0,
  buyer_note TEXT,
  data_source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, external_order_id)
);
CREATE INDEX idx_orders_time ON orders(order_time);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku_id INTEGER REFERENCES skus(id) ON DELETE SET NULL,
  seller_sku TEXT,
  product_name TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_sen INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  external_refund_id TEXT,
  external_order_id TEXT,
  type TEXT NOT NULL DEFAULT 'refund',
  amount_sen INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  refund_time TEXT NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_refunds_time ON refunds(refund_time);

CREATE TABLE ad_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'GMV Max',
  spend_sen INTEGER NOT NULL DEFAULT 0,
  attributed_gmv_sen INTEGER,
  data_source TEXT NOT NULL DEFAULT 'manual',
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, date, channel)
);

CREATE TABLE shop_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  value REAL NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, date, metric_key)
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  ref TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX idx_alerts_open ON alerts(rule, ref) WHERE resolved_at IS NULL;

CREATE TABLE credentials (
  provider TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  data_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  PRIMARY KEY (provider, scope)
);

CREATE TABLE sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  last_error TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  next_run_at TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_time ON audit_logs(created_at);

CREATE TABLE notifications_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  title TEXT,
  body TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
`,
  },
];

function runMigrations(db) {
  db.sql.run('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  const done = new Set(db.all('SELECT id FROM schema_migrations').map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.sql.run('BEGIN');
    try {
      db.sql.exec(m.sql);
      db.sql.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)', [m.id, m.name, new Date().toISOString()]);
      db.sql.run('COMMIT');
    } catch (e) {
      db.sql.run('ROLLBACK');
      throw new Error(`Migration ${m.id} failed: ${e.message}`);
    }
  }
}

module.exports = { runMigrations, MIGRATIONS };
