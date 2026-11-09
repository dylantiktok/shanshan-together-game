'use strict';
/** npm start：若 Electron 尚未下载则先自动下载，再启动桌面窗口 */
const path = require('path');
const { spawnSync, spawn } = require('child_process');

function electronPath() {
  try {
    delete require.cache[require.resolve('electron')];
    return require('electron');
  } catch {
    return null;
  }
}

let bin = electronPath();
if (!bin) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'install-electron.js')], { stdio: 'inherit' });
  bin = r.status === 0 ? electronPath() : null;
  if (!bin) {
    console.error('\nElectron 下载失败。可以先用浏览器版：npm run server ，然后打开 http://127.0.0.1:3780');
    process.exit(1);
  }
}
const child = spawn(bin, [path.join(__dirname, '..')], { stdio: 'inherit', windowsHide: false });
child.on('close', (code) => process.exit(code ?? 0));
