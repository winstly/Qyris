// 确保 Electron 二进制就位（postinstall 兜底）。
//
// 背景：electron 自带的 postinstall 在下载失败时可能只留下警告，
// 导致 `npm run dev` 时报 "Error: Electron uninstall"。
// 本脚本在 `npm i` 后强制校验/补装，支持多镜像自动切换 + 重试。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 镜像列表：按优先级排序，依次尝试
// npmmirror 国内镜像 → 官方 GitHub Releases（全球可用）
const MIRRORS = [
  'https://registry.npmmirror.com/-/binary/electron/',
  'https://npmmirror.com/mirrors/electron/',
  'https://github.com/electron/electron/releases/download/',
];

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const installJs = path.join(electronDir, 'install.js');

if (!fs.existsSync(installJs)) {
  console.error('[ensure-electron] 未找到 node_modules/electron，请先运行 npm i');
  process.exit(1);
}

// 检查是否已安装
// Windows: dist/electron.exe
// macOS: dist/Electron.app
// Linux: dist/electron
function isInstalled() {
  try {
    const pathTxt = path.join(electronDir, 'path.txt');
    if (!fs.existsSync(pathTxt)) return false;
    const content = fs.readFileSync(pathTxt, 'utf8').trim();
    if (!content) return false;
    // path.txt 记录的是相对 dist/ 的路径（electron/index.js 同款解析）：
    // win=electron.exe、mac=Electron.app/Contents/MacOS/Electron、linux=electron
    return fs.existsSync(path.join(electronDir, 'dist', content));
  } catch {
    return false;
  }
}

if (isInstalled()) {
  console.log('[ensure-electron] Electron 二进制已存在，跳过安装');
  process.exit(0);
}

console.log('[ensure-electron] 检查 Electron 二进制 …');

// 尝试从指定镜像安装
function tryInstall(mirror) {
  console.log(`[ensure-electron] 尝试镜像: ${mirror}`);
  process.env.ELECTRON_MIRROR = mirror;
  try {
    execFileSync(process.execPath, [installJs], { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.warn(`[ensure-electron] 镜像失败: ${mirror} - ${e.message}`);
    return false;
  }
}

// 依次尝试所有镜像
let installed = false;
for (const mirror of MIRRORS) {
  if (tryInstall(mirror)) {
    installed = true;
    break;
  }
}

if (!installed) {
  console.error('[ensure-electron] 所有镜像均失败');
  console.error('[ensure-electron] 请尝试以下方法:');
  console.error('  1. 检查网络连接');
  console.error('  2. 设置环境变量 ELECTRON_MIRROR 指向可用的镜像');
  console.error('  3. 手动下载 Electron: https://github.com/electron/electron/releases');
  console.error('  4. 将下载的文件解压到 node_modules/electron/dist/ 目录');
  process.exit(1);
}

if (!isInstalled()) {
  console.error('[ensure-electron] Electron 二进制安装失败');
  process.exit(1);
}

console.log('[ensure-electron] Electron 二进制就绪 ✓');
