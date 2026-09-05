/**
 * 文件监听 —— 按项目多实例。
 * 每个项目目录独立 watcher，多个窗口可同时 watch 同一项目。
 * 窗口关闭时自动摘除订阅，无订阅者后销毁 watcher。
 */
import { watch, type FSWatcher } from 'chokidar'
import { emitToWindow } from './emitter'

/** 监听过滤：跳过依赖与构建产物目录 */
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

interface ProjectWatcher {
  watcher: FSWatcher
  /** 订阅该项目文件变更的窗口 ID 集合 */
  windowIds: Set<number>
  pending: string[]
  timer: NodeJS.Timeout | null
  /** 归一化的项目根（正斜杠；Windows/macOS 折叠大小写） */
  normRoot: string
  /** 原始项目根（fs-changed 事件回传渲染层按工程路由） */
  root: string
}

/** normalized projectRoot → ProjectWatcher */
const watchers = new Map<string, ProjectWatcher>()

/** Windows / macOS 默认大小写不敏感，归一化时折叠大小写；Linux 大小写敏感，保留原样 */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

function normPath(p: string): string {
  const n = p.replace(/\\/g, '/')
  return CASE_INSENSITIVE ? n.toLowerCase() : n
}

function flush(pw: ProjectWatcher): void {
  pw.timer = null
  const paths = pw.pending
  pw.pending = []
  if (paths.length === 0) return
  for (const winId of pw.windowIds) {
    emitToWindow(winId, 'fs-changed', { paths, projectRoot: pw.root })
  }
}

function onEvent(pw: ProjectWatcher, p: string): void {
  pw.pending.push(p)
  if (pw.timer !== null) return
  pw.timer = setTimeout(() => flush(pw), 100)
}

/**
 * 启动/追加项目监听。
 * 同一项目已有 watcher 时只追加 windowId，不重复创建。
 */
export async function startWatching(projectRoot: string, windowId: number): Promise<void> {
  const key = normPath(projectRoot)
  const existing = watchers.get(key)
  if (existing) {
    existing.windowIds.add(windowId)
    return
  }

  const normRoot = projectRoot.replace(/\\/g, '/')
  const ignored = (p: string): boolean => {
    const norm = p.replace(/\\/g, '/')
    const rel = norm.startsWith(normRoot) ? norm.slice(normRoot.length) : norm
    return isIgnoredPath(rel)
  }
  const w = watch(projectRoot, { ignoreInitial: true, ignored })
  const pw: ProjectWatcher = {
    watcher: w,
    windowIds: new Set([windowId]),
    pending: [],
    timer: null,
    normRoot: key,
    root: projectRoot,
  }
  w.on('add', (p) => onEvent(pw, p))
  w.on('change', (p) => onEvent(pw, p))
  w.on('unlink', (p) => onEvent(pw, p))
  w.on('addDir', (p) => onEvent(pw, p))
  w.on('unlinkDir', (p) => onEvent(pw, p))
  w.on('error', () => {})
  watchers.set(key, pw)
}

/**
 * 停止某个窗口对某个项目的监听。
 * 如果该项目无其他窗口订阅，销毁 watcher。
 */
export async function stopProjectWatching(projectRoot: string, windowId: number): Promise<void> {
  const key = normPath(projectRoot)
  const pw = watchers.get(key)
  if (!pw) return
  pw.windowIds.delete(windowId)
  if (pw.windowIds.size === 0) {
    watchers.delete(key)
    if (pw.timer !== null) clearTimeout(pw.timer)
    pw.pending = []
    await pw.watcher.close()
  }
}

/**
 * 窗口关闭时调用：摘除该窗口的所有 watcher 订阅。
 */
export async function stopWatchingForWindow(windowId: number): Promise<void> {
  const toRemove: string[] = []
  for (const [key, pw] of watchers) {
    pw.windowIds.delete(windowId)
    if (pw.windowIds.size === 0) {
      toRemove.push(key)
    }
  }
  for (const key of toRemove) {
    const pw = watchers.get(key)
    if (!pw) continue
    watchers.delete(key)
    if (pw.timer !== null) clearTimeout(pw.timer)
    pw.pending = []
    await pw.watcher.close()
  }
}

/**
 * @deprecated 单窗口兼容：停止全局 watcher。新代码用 stopProjectWatching / stopWatchingForWindow。
 */
export async function stopWatching(): Promise<void> {
  for (const key of [...watchers.keys()]) {
    const pw = watchers.get(key)
    if (!pw) continue
    watchers.delete(key)
    if (pw.timer !== null) clearTimeout(pw.timer)
    pw.pending = []
    await pw.watcher.close()
  }
}

/**
 * @deprecated 单窗口兼容。新代码用 stopWatchingForWindow。
 */
export async function stopWatchingInternal(): Promise<void> {
  await stopWatching()
}
