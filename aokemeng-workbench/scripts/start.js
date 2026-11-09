'use strict';
/** npm start：若 Electron 尚未安装则先下载，再启动桌面窗口 */
const path = require('path');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');

const electronDir = path.dirname(require.resolve('electron/package.json'));

/** 不 require('electron')：新版在缺文件时会自动走自带的下载流程（可能被系统拦截） */
function electronBin() {
  try {
    const rel = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim();
    const bin = path.join(electronDir, 'dist', rel);
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

let bin = electronBin();
if (!bin) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'install-electron.js')], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(1);
  bin = electronBin();
  if (!bin) process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(bin, [path.join(__dirname, '..')], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
