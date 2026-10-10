/**
 * 文件监听 —— 按项目多实例。
 * 每个项目目录独立 watcher，多个窗口可同时 watch 同一项目。
 * 窗口关闭时自动摘除订阅，无订阅者后销毁 watcher。
 *
 * 实现走 node:fs 的 watch({recursive:true})，换掉 chokidar：
 *  - mac/win 单 fd 监听整棵树（chokidar 每目录一 fd，1.8 万目录 = 1.8 万 fd，
 *    直接把系统 fd 打爆并引发事件风暴）；
 *  - Linux 的 fs.watch 不支持 recursive（ERR_FEATURE_UNAVAILABLE_ON_PLATFORM）
 *    → 退化单层（只监听根目录一层），换取 1 个 fd 的稳定性；
 *  - node:fs 不做 ignore 过滤（chokidar 的 ignored 回调没了），在事件入口按段过滤。
 */
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { emitToWindow } from './emitter'

/** 监听过滤：跳过依赖与构建产物目录（与 fsops 的 list_dir 过滤口径对齐） */
const WATCH_IGNORED = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', 'target', '.next', '.nuxt',
  '.cache', 'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  '.gradle', 'bin', 'mvn',
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

/** 批内合并的等待上限：超过即刻 flush，不等定时器（事件风暴时不让 pending 无界增长） */
const PENDING_FLUSH_AT = 2000

/**
 * 批内事件合并（vscode EventCoalescer 思想的路径版）：
 * 1. 去重 —— 同一文件的 rename+change 只报一次
 * 2. 父目录折叠 —— 目录被删时其子孙路径折叠进目录本身（rm -rf 不再产生海量事件）
 * 3. 前缀包含去重 —— 子路径已被父路径覆盖时丢弃
 * 排序折叠 O(n log n)：字典序下祖先恒在子孙之前，只需与「最后一个保留项」比前缀，
 * 替代旧实现的两两比对 O(n²)（1.8 万路径的风暴下 O(n²) 是 3 亿次比较）。
 */
function coalescePaths(paths: string[]): string[] {
  if (paths.length <= 1) return paths
  const norm = [...new Set(paths.map((p) => p.replace(/\\/g, '/')))].sort()
  const out: string[] = []
  for (const p of norm) {
    const last = out[out.length - 1]
    // 注意比 last + '/'：「ab」不是「a」的子孙（裸 startsWith 会误折叠）
    if (last && p.startsWith(last + '/')) continue
    out.push(p)
  }
  return out
}

function flush(pw: ProjectWatcher): void {
  pw.timer = null
  const paths = coalescePaths(pw.pending)
  pw.pending = []
  if (paths.length === 0) return
  for (const winId of pw.windowIds) {
    emitToWindow(winId, 'fs-changed', { paths, projectRoot: pw.root })
  }
}

function onEvent(pw: ProjectWatcher, p: string): void {
  pw.pending.push(p)
  if (pw.pending.length >= PENDING_FLUSH_AT) {
    if (pw.timer !== null) clearTimeout(pw.timer)
    flush(pw)
    return
  }
  if (pw.timer !== null) return
  pw.timer = setTimeout(() => flush(pw), 100)
}

/** 容错销毁：close 可能在已关/进程退出时抛，不能阻塞清理链 */
function destroyWatcher(key: string, pw: ProjectWatcher): void {
  watchers.delete(key)
  if (pw.timer !== null) clearTimeout(pw.timer)
  pw.pending = []
  try {
    pw.watcher.close()
  } catch { /* 已关闭/已销毁 */ }
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
  /** filename 是相对 watch 根的路径（recursive 模式下含子目录），先拼回绝对再过滤 */
  const toAbs = (filename: string | null): string | null => {
    if (!filename) return null
    const abs = join(projectRoot, filename)
    const norm = abs.replace(/\\/g, '/')
    const rel = norm.startsWith(normRoot) ? norm.slice(normRoot.length) : norm
    return isIgnoredPath(rel) ? null : abs
  }

  // mac/win：recursive 单 fd 听整树；Linux 不支持 recursive → 退化单层（只听根目录）
  let w: FSWatcher
  try {
    w = watch(projectRoot, { persistent: true, recursive: true })
  } catch {
    w = watch(projectRoot, { persistent: true })
  }
  const pw: ProjectWatcher = {
    watcher: w,
    windowIds: new Set([windowId]),
    pending: [],
    timer: null,
    normRoot: key,
    root: projectRoot,
  }
  // node:fs 的 fs.watch 统一走 'change'（eventType 只有 rename/change 语义，不区分增删）
  w.on('change', (_eventType, filename) => {
    const abs = toAbs(typeof filename === 'string' ? filename : null)
    if (abs) onEvent(pw, abs)
  })
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
  if (pw.windowIds.size === 0) destroyWatcher(key, pw)
}

/**
 * 窗口关闭时调用：摘除该窗口的所有 watcher 订阅。
 */
export async function stopWatchingForWindow(windowId: number): Promise<void> {
  const toRemove: string[] = []
  for (const [key, pw] of watchers) {
    pw.windowIds.delete(windowId)
    if (pw.windowIds.size === 0) toRemove.push(key)
  }
  for (const key of toRemove) {
    const pw = watchers.get(key)
    if (!pw) continue
    destroyWatcher(key, pw)
  }
}

/**
 * @deprecated 单窗口兼容：停止全局 watcher。新代码用 stopProjectWatching / stopWatchingForWindow。
 */
export async function stopWatching(): Promise<void> {
  for (const key of [...watchers.keys()]) {
    const pw = watchers.get(key)
    if (!pw) continue
    destroyWatcher(key, pw)
  }
}

/**
 * @deprecated 单窗口兼容。新代码用 stopWatchingForWindow。
 */
export async function stopWatchingInternal(): Promise<void> {
  await stopWatching()
}
