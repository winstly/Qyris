/** 文件监听 —— watcher.rs 的语义移植（chokidar 替代 notify） */
import { watch, type FSWatcher } from 'chokidar'
import { emitToRenderer } from './emitter'

/**
 * 监听过滤：跳过依赖与构建产物目录。
 * 差异说明：Rust notify 在 Windows 用 ReadDirectoryChangesW 原生递归监听（零遍历成本），
 * chokidar 则靠逐文件遍历建监听——不排除 node_modules 时主进程事件循环会被打饱和，
 * 所有 IPC 全线变慢。此处为必要差异而非行为偏离。
 */
const WATCH_IGNORED = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', 'target', '.next', '.nuxt',
  '.cache', 'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
])

function isIgnoredPath(p: string): boolean {
  for (const seg of p.split(/[\\/]/)) {
    if (WATCH_IGNORED.has(seg)) return true
  }
  return false
}

let watcher: FSWatcher | null = null
let pending: string[] = []
let timer: NodeJS.Timeout | null = null

/** 100ms 微批：收集事件路径，空数组不 emit（400ms 前端节流仍留在 App.tsx） */
function flush(): void {
  timer = null
  const paths = pending
  pending = []
  if (paths.length > 0) emitToRenderer('fs-changed', { paths })
}

function onEvent(p: string): void {
  pending.push(p)
  if (timer !== null) return
  timer = setTimeout(flush, 100)
}

/** 全局单 watcher：start 先停旧（与 watcher.rs 单槽语义一致） */
export async function startWatching(projectRoot: string): Promise<void> {
  await stopWatchingInternal()
  // 归一化后剥掉项目根前缀再判忽略，避免项目根自身恰名为 build/dist 等时整棵监听被误杀
  const normRoot = projectRoot.replace(/\\/g, '/')
  const ignored = (p: string): boolean => {
    const norm = p.replace(/\\/g, '/')
    const rel = norm.startsWith(normRoot) ? norm.slice(normRoot.length) : norm
    return isIgnoredPath(rel)
  }
  watcher = watch(projectRoot, { ignoreInitial: true, ignored })
  watcher.on('add', onEvent)
  watcher.on('change', onEvent)
  watcher.on('unlink', onEvent)
  watcher.on('addDir', onEvent)
  watcher.on('unlinkDir', onEvent)
  // notify 版对单个监听错误采取忽略策略，这里保持一致
  watcher.on('error', () => {})
}

export async function stopWatching(): Promise<void> {
  await stopWatchingInternal()
}

export async function stopWatchingInternal(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  pending = []
  const w = watcher
  watcher = null
  if (w) await w.close()
}
