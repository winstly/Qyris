// 确保 Electron 二进制就位（postinstall 兜底）。
//
// 背景：electron 自带的 postinstall 在下载失败时可能只留下警告，
// 导致 `npm run dev` 时报 "Error: Electron uninstall"。
// 本脚本在 `npm i` 后强制校验/补装：
//   1. 默认走 npmmirror 镜像（可用 ELECTRON_MIRROR 环境变量覆盖）；
//   2. 已安装则秒退（install.js 自带 isInstalled 检查，幂等）；
//   3. 结束后校验二进制确实存在，缺失即报错退出，绝不静默。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const installJs = path.join(electronDir, 'install.js');
if (!fs.existsSync(installJs)) {
  console.error('[ensure-electron] 未找到 node_modules/electron，请先运行 npm i');
  process.exit(1);
}

console.log('[ensure-electron] 检查 Electron 二进制 …');
execFileSync(process.execPath, [installJs], { stdio: 'inherit' });

const binary = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(path.join(electronDir, 'path.txt')) || !fs.existsSync(binary)) {
  console.error(
    '[ensure-electron] Electron 二进制缺失。请检查网络后重新运行 `npm i`，' +
      '或在 CI 中设置 ELECTRON_MIRROR 环境变量。'
  );
  process.exit(1);
}
console.log('[ensure-electron] Electron 二进制就绪 ✓');
