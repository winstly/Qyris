/**
 * 打包产物验收守卫：npm run dist 末尾自动运行。
 *
 * 背景：electron-builder 只打包磁盘上现存的 out/，如果构建机代码陈旧或
 * 没跑 electron-vite build，产物会静默缺失新资源（案例：桌宠 MP4 未进 mac 包，
 * 桌宠窗口加载失败 → 透明窗口无内容 → "安装包里没有桌宠"）。
 * 本脚本在每次打包后断言关键资产存在，让这类失败在 CI/本机构建时立刻炸出来。
 *
 * 退出码：0 = 全部关键资产在位；1 = 有缺失（并打印缺失清单）。
 */
import { listPackage } from '@electron/asar'
import { readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

const distDir = path.resolve(process.argv[2] || 'dist')

// 找 dist 产物目录：
//   win/linux: <name>-unpacked（win-unpacked / linux-unpacked），resources 直接在其下
//   mac:       mac[-arm64|-x64] —— electron-builder 26 的 mac 产物没有 *-unpacked 目录，
//              asar 嵌在 app 包内：<平台目录>/<App>.app/Contents/Resources（大写 R）
const MAC_DIR_RE = /^mac(-arm64|-x64)?$/
let productDirs = []
try {
  productDirs = readdirSync(distDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name.endsWith('-unpacked') || MAC_DIR_RE.test(e.name)))
    .map((e) => ({ name: e.name, mac: MAC_DIR_RE.test(e.name) }))
} catch {
  console.error(`[verify-dist] ❌ dist 目录不存在或不可读: ${distDir}（先跑 electron-builder）`)
  process.exit(1)
}

if (productDirs.length === 0) {
  console.error(`[verify-dist] ❌ ${distDir} 下没有 *-unpacked / mac* 产物目录，打包疑似未执行`)
  process.exit(1)
}

let failed = false
for (const { name, mac } of productDirs) {
  let resources
  if (mac) {
    const appDirs = readdirSync(path.join(distDir, name)).filter((f) => f.endsWith('.app'))
    if (appDirs.length === 0) {
      console.error(`[verify-dist] ❌ ${name}: mac 平台目录下没有 .app 产物`)
      failed = true
      continue
    }
    resources = path.join(distDir, name, appDirs[0], 'Contents', 'Resources')
  } else {
    resources = path.join(distDir, name, 'resources')
  }
  const asar = path.join(resources, 'app.asar')

  // 1) asar 内必须有桌宠窗口入口（缺失 → 桌宠窗口 did-fail-load → 透明空白）
  //    listPackage 返回带平台分隔符且带前导分隔符的路径（"\out\renderer\pet\index.html"），
  //    归一化为无前导分隔符的正斜杠相对路径再比对
  let entries = []
  if (existsSync(asar)) {
    entries = listPackage(asar).map((p) => p.replaceAll('\\', '/').replace(/^\//, ''))
  } else {
    console.error(`[verify-dist] ❌ ${name}: app.asar 不存在`)
    failed = true
  }

  // 2) 无法从 asar dlopen / 必须走真实文件系统的资产必须解包存在
  const unpackedRequired = [
    'out/renderer/pet/slackoff.mp4',
    'out/renderer/pet/working.mp4',
    'out/renderer/pet/error.mp4',
    'node_modules/better-sqlite3/package.json',
  ]

  const asarRequired = [
    'out/renderer/pet/index.html',
    'out/renderer/pet/panel.html',
  ]

  for (const rel of asarRequired) {
    if (!entries.includes(rel)) {
      console.error(`[verify-dist] ❌ ${name}: app.asar 缺少 ${rel}`)
      failed = true
    }
  }

  for (const rel of unpackedRequired) {
    const p = path.join(resources, 'app.asar.unpacked', rel)
    if (!existsSync(p) || statSync(p).size === 0) {
      console.error(`[verify-dist] ❌ ${name}: app.asar.unpacked 缺少 ${rel}`)
      failed = true
    }
  }

  if (!failed) console.log(`[verify-dist] ✅ ${name}: 桌宠入口 + 动画 MP4 + native 运行时全部在位`)
}

process.exit(failed ? 1 : 0)
