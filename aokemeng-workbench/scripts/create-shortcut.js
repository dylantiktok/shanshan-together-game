'use strict';
/**
 * 在 Windows 桌面和开始菜单创建“AOKEMENG 运营工作台”快捷方式。
 * 用法：npm run shortcut
 *
 * 快捷方式直接启动 Electron 并打开本项目，不会弹出命令行窗口。
 * 如果之后移动或重新下载了项目文件夹，请在新位置重新运行一次本命令。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.error('快捷方式脚本目前只支持 Windows。macOS 请使用 npm run dist:mac 生成安装包。');
  process.exit(1);
}

const projectDir = path.resolve(__dirname, '..');
const electronDir = path.dirname(require.resolve('electron/package.json'));
let exe;
try {
  exe = path.join(electronDir, 'dist', fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim());
} catch {
  exe = null;
}
if (!exe || !fs.existsSync(exe)) {
  console.error('Electron 尚未安装，请先运行一次 npm start（会自动下载），然后再运行 npm run shortcut');
  process.exit(1);
}

const NAME = 'AOKEMENG 运营工作台';
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ps = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($dir in $targets) {
  $lnk = $shell.CreateShortcut((Join-Path $dir ${psQuote(NAME + '.lnk')}))
  $lnk.TargetPath = ${psQuote(exe)}
  $lnk.Arguments = '"' + ${psQuote(projectDir)} + '"'
  $lnk.WorkingDirectory = ${psQuote(projectDir)}
  $lnk.IconLocation = ${psQuote(exe + ',0')}
  $lnk.Description = 'AOKEMENG TikTok 智能运营工作台'
  $lnk.Save()
  Write-Output ("已创建: " + (Join-Path $dir ${psQuote(NAME + '.lnk')}))
}
`;
// 用 -EncodedCommand（UTF-16LE）传递脚本，避免中文路径在不同代码页下乱码
const encoded = Buffer.from(ps, 'utf16le').toString('base64');
const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error('创建快捷方式失败：', (r.stderr || r.error?.message || '').trim());
  process.exit(1);
}
process.stdout.write(r.stdout);
console.log('完成。以后双击桌面上的“' + NAME + '”即可打开工作台。');
