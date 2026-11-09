'use strict';
/**
 * 下载并解压 Electron 运行文件（桌面窗口所需）。
 * 用法：npm run setup:electron（npm start 在缺少 Electron 时也会自动调用）
 *
 * 为什么不用 Electron 自带的安装脚本：
 * - npm 11 起默认不执行依赖包的安装脚本；
 * - Electron 40+ 用原生插件解压，可能被 Windows 安全策略（如“智能应用控制”）拦截，
 *   报 “Cannot find native binding”（electron/electron#52481）；
 * - 自带下载器在网络抖动时可能直接崩溃。
 * 因此这里自行下载（用 Electron 包内的 checksums.json 做 SHA-256 校验，失败自动重试），
 * 再用操作系统自带的工具解压（Windows 10 1803+ 的 tar.exe、macOS 的 ditto）。
 *
 * 默认使用 npmmirror 镜像，失败后自动改用 GitHub 官方源；
 * 也可以用环境变量 ELECTRON_MIRROR 指定下载地址。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const electronDir = path.dirname(require.resolve('electron/package.json'));
const { version } = require(path.join(electronDir, 'package.json'));
const checksums = require(path.join(electronDir, 'checksums.json'));
const distDir = path.join(electronDir, 'dist');
const exeRel = { win32: 'electron.exe', darwin: 'Electron.app/Contents/MacOS/Electron' }[process.platform] || 'electron';
const fileName = `electron-v${version}-${process.platform}-${process.arch}.zip`;
const cacheDir = path.join(os.tmpdir(), 'aokemeng-electron-cache');
const cachedZip = path.join(cacheDir, fileName);

function candidateUrls() {
  const mirrors = process.env.ELECTRON_MIRROR
    ? [process.env.ELECTRON_MIRROR]
    : ['https://npmmirror.com/mirrors/electron/', 'https://github.com/electron/electron/releases/download/'];
  const urls = [];
  for (const m of mirrors) {
    const base = m.endsWith('/') ? m : m + '/';
    urls.push(`${base}v${version}/${fileName}`);
    if (!base.includes('github.com')) urls.push(`${base}${version}/${fileName}`);
  }
  return urls;
}

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60e3) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0, lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      process.stdout.write(`\r  ${pct}%  ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB   `);
    }
  });
  await pipeline(body, fs.createWriteStream(dest));
  process.stdout.write('\n');
}

async function fetchZip() {
  const expected = checksums[fileName];
  if (!expected) throw new Error(`Electron 不支持此平台：${fileName}`);
  if (fs.existsSync(cachedZip) && sha256File(cachedZip) === expected) return cachedZip;
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = cachedZip + '.part';
  const errors = [];
  for (const url of candidateUrls()) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`下载 ${url}${attempt > 1 ? `（第 ${attempt} 次）` : ''}`);
        await download(url, tmp);
        if (sha256File(tmp) !== expected) throw new Error('文件校验失败（SHA-256 不匹配）');
        fs.renameSync(tmp, cachedZip);
        return cachedZip;
      } catch (e) {
        process.stdout.write('\n');
        errors.push(`${url}: ${e.cause?.code || e.message}`);
        console.log(`  失败：${e.cause?.code || e.message}`);
        if (/HTTP 404/.test(e.message)) break;
      }
    }
  }
  throw new Error('下载失败：\n  ' + errors.join('\n  '));
}

function extract(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tries = process.platform === 'linux'
    ? [['unzip', ['-q', '-o', zip, '-d', dest]], ['bsdtar', ['-xf', zip, '-C', dest]]]
    : process.platform === 'darwin'
      ? [['ditto', ['-x', '-k', zip, dest]], ['tar', ['-xf', zip, '-C', dest]]]
      : [[path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]]];
  const errors = [];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (r.status === 0) return;
    errors.push(`${cmd}: ${r.error ? r.error.message : (r.stderr || '').trim() || 'exit ' + r.status}`);
  }
  throw new Error('解压失败：\n  ' + errors.join('\n  '));
}

async function main() {
  console.log(`安装 Electron v${version}（${process.platform}-${process.arch}）`);
  const zip = await fetchZip();
  console.log('下载完成，校验通过，正在解压……');
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.rmSync(path.join(electronDir, 'path.txt'), { force: true });
  extract(zip, distDir);
  if (!fs.existsSync(path.join(distDir, exeRel))) throw new Error(`解压后找不到 ${exeRel}`);
  const typeDefs = path.join(distDir, 'electron.d.ts');
  if (fs.existsSync(typeDefs)) fs.renameSync(typeDefs, path.join(electronDir, 'electron.d.ts'));
  fs.writeFileSync(path.join(electronDir, 'path.txt'), exeRel);
  console.log('Electron 安装完成。');
}

if (process.argv.includes('--worker')) {
  main().catch((e) => {
    console.error('\n' + e.message);
    process.exit(1);
  });
} else {
  // 个别网络环境下 HTTP 库会在下载中途直接崩溃进程，因此在子进程中执行，失败自动重试
  let ok = false;
  for (let i = 1; i <= 3 && !ok; i++) {
    if (i > 1) console.log(`\n—— 第 ${i} 轮重试 ——`);
    ok = spawnSync(process.execPath, [__filename, '--worker'], { stdio: 'inherit' }).status === 0;
  }
  if (!ok) {
    console.error('\nElectron 安装失败。可以先用浏览器版：npm run server ，然后打开 http://127.0.0.1:3780');
    process.exit(1);
  }
}
