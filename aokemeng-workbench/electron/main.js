'use strict';
/**
 * Electron 桌面壳：在进程内启动本地服务（127.0.0.1 随机端口），并打开窗口。
 * 数据保存在系统用户数据目录（开发运行 npm start 与安装版共用同一份数据）：
 *   Windows: %APPDATA%\AOKEMENG TikTok Operations Workbench\data
 *   macOS:   ~/Library/Application Support/AOKEMENG TikTok Operations Workbench/data
 */
const path = require('path');
const { app, BrowserWindow, shell, dialog } = require('electron');
const { startServer } = require('../server');

// 固定数据目录：不随安装包名称变化；单实例锁也基于此目录，
// 避免开发版与安装版同时运行、同时写同一个数据库
app.setPath('userData', path.join(app.getPath('appData'), 'AOKEMENG TikTok Operations Workbench'));

let running = null;

async function createWindow() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  running = await startServer({ dataDir, port: 0 });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'AOKEMENG TikTok 智能运营工作台',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  // 外部链接（如 TikTok 授权页）在系统浏览器中打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(running.url)) {
      e.preventDefault();
      if (/^https:\/\//.test(url)) shell.openExternal(url);
    }
  });
  await win.loadURL(running.url);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  app.whenReady().then(createWindow).catch((e) => {
    dialog.showErrorBox('启动失败', String(e?.stack || e));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (running) {
      running.server.close();
      running.ctx.close(); // 确保数据库落盘
      running = null;
    }
  });
}
