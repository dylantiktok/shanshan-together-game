'use strict';
/**
 * 下载 Electron 运行文件（桌面窗口所需）。
 * 用法：npm run setup:electron
 *
 * - 默认使用 npmmirror 镜像（国内/东南亚网络更快）；如需官方源，先设置环境变量
 *   ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/
 * - npm 11 起默认不执行依赖包的安装脚本，因此 Electron 不会在 npm install 时自动下载，
 *   需要运行一次本脚本。
 */
const path = require('path');
const fs = require('fs');

if (!process.env.ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
}
const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const installer = path.join(electronDir, 'install.js');
if (!fs.existsSync(installer)) {
  console.error('找不到 node_modules/electron，请先运行 npm install');
  process.exit(1);
}
// 清理上次下载失败留下的残缺文件
fs.rmSync(path.join(electronDir, 'dist'), { recursive: true, force: true });
fs.rmSync(path.join(electronDir, 'path.txt'), { force: true });
console.log(`正在下载 Electron（镜像：${process.env.ELECTRON_MIRROR}）……`);
process.chdir(electronDir);
require(installer);
process.on('exit', (code) => {
  if (code === 0 && fs.existsSync(path.join(electronDir, 'path.txt'))) {
    console.log('Electron 下载完成，现在可以运行 npm start');
  }
});
