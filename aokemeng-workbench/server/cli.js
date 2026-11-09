'use strict';
/**
 * 无桌面壳运行（开发/调试或服务器部署）：
 *   node server/cli.js [--data ./data] [--port 3780]
 * 然后在本机浏览器打开输出的地址。
 */
const path = require('path');
const { startServer } = require('./index');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};

(async () => {
  const dataDir = path.resolve(arg('data', process.env.AOKEMENG_DATA_DIR || path.join(__dirname, '..', 'data')));
  const port = Number(arg('port', process.env.PORT || 3780));
  const { url, ctx, server } = await startServer({ dataDir, port });
  console.log(`AOKEMENG Workbench 已启动: ${url}`);
  console.log(`数据目录: ${dataDir}`);
  const shutdown = () => {
    server.close();
    ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
