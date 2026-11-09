'use strict';
/**
 * 本地服务入口。仅监听 127.0.0.1，供桌面窗口（Electron）或本机浏览器访问。
 */
const path = require('path');
const express = require('express');
const { openDatabase } = require('./db');
const { SecretBox, HttpError } = require('./util');
const { CredentialStore } = require('./integrations/credentials');
const { SyncService } = require('./services/sync');
const { evaluateAlerts } = require('./services/alerts');
const { authMiddleware } = require('./auth');

async function createApp({ dataDir, startWorkers = true }) {
  const db = await openDatabase(dataDir ? path.join(dataDir, 'workbench.sqlite') : null);
  const secretBox = new SecretBox(dataDir || require('os').tmpdir());
  const creds = new CredentialStore(db, secretBox);
  const sync = new SyncService(db, creds);
  const ctx = { db, creds, sync, dataDir };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
    next();
  });
  app.use('/api', express.json({ limit: '2mb' }));
  app.use('/api', authMiddleware(db));
  app.use('/api', require('./routes/core')(ctx));
  app.use('/api', require('./routes/business')(ctx));
  app.use('/api', require('./routes/integrations')(ctx));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'not_found', '接口不存在')));
  app.use(express.static(path.join(__dirname, '..', 'web'), { index: 'index.html' }));

  // 统一错误处理
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    if (err.code === 'not_connected') return res.status(409).json({ error: 'not_connected', message: err.message });
    if (err.code === 'network') return res.status(503).json({ error: 'network', message: err.message });
    if (err.code === 'platform_error') return res.status(502).json({ error: 'platform_error', message: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: '请求格式错误' });
    if (/UNIQUE constraint failed/.test(err.message)) return res.status(409).json({ error: 'duplicate', message: '数据重复：' + err.message });
    console.error('[server error]', err);
    res.status(500).json({ error: 'internal', message: '服务器内部错误' });
  });

  if (startWorkers) {
    sync.start();
    evaluateAlerts(db);
    ctx.alertTimer = setInterval(() => {
      try { evaluateAlerts(db); } catch (e) { console.error('[alerts]', e); }
    }, 15 * 60e3);
    ctx.alertTimer.unref?.();
  }

  ctx.close = () => {
    sync.stop();
    clearInterval(ctx.alertTimer);
    db.close();
  };
  return { app, ctx };
}

async function startServer({ dataDir, port = 0, host = '127.0.0.1' } = {}) {
  const { app, ctx } = await createApp({ dataDir });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, ctx, url: `http://${host}:${addr.port}` });
    });
    server.on('error', reject);
  });
}

module.exports = { createApp, startServer };
