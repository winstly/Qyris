/**
 * PTY 终端注册表（终端 tab 后端）——node-pty 直连，照 proc.ts 薄封装风格。
 *
 * 方案要点（term-research）：
 *   · N-API + prebuilds：无 electron-rebuild 需求（风险低于 better-sqlite3）
 *   · 5ms 合并缓冲：高频输出不打爆 IPC（TerminalDataBufferer 思路）
 *   · ConPTY kill 节流 250ms：防 Windows conhost 挂死（VSCode terminalProcess 同款）
 *   · cwd 只取项目目录，不暴露任意启动路径；termId 绑定 owner windowId，窗口关闭即回收
 */
import * as pty from 'node-pty'
import { emitToWindow } from './emitter'

const FLUSH_INTERVAL_MS = 5
const KILL_THROTTLE_MS = 250

interface PtyEntry {
  term: pty.IPty
  winId: number
  buffer: string
  flushTimer: ReturnType<typeof setTimeout> | null
  lastKill: number
}

const registry = new Map<string, PtyEntry>()

/** 默认 shell：Win 优先 pwsh 回退 cmd；其余平台取 $SHELL */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: [] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] }
}

/** 创建终端：绑定 owner 窗口，数据 5ms 合并后定向推送 */
export function createPty(termId: string, winId: number, opts: {
  cols: number
  rows: number
  cwd?: string
}): { ok: boolean; shell: string; pid: number } {
  if (registry.has(termId)) killPty(termId) // 同 id 重建：先回收旧进程
  const { file, args } = defaultShell()
  const term = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: Math.max(20, opts.cols || 80),
    rows: Math.max(5, opts.rows || 24),
    cwd: opts.cwd || process.env.HOME || process.env.USERPROFILE || '/',
    env: process.env as Record<string, string>,
  })
  const entry: PtyEntry = { term, winId, buffer: '', flushTimer: null, lastKill: 0 }
  registry.set(termId, entry)

  term.onData((data) => {
    entry.buffer += data
    if (entry.flushTimer) return
    // 5ms 合并缓冲：一次 IPC 带走积压，避免逐字节轰炸
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null
      if (entry.buffer) {
        emitToWindow(winId, 'pty:data', { termId, data: entry.buffer })
        entry.buffer = ''
      }
    }, FLUSH_INTERVAL_MS)
  })
  term.onExit(({ exitCode }) => {
    if (entry.flushTimer) clearTimeout(entry.flushTimer)
    // 同 id 立刻重建（StrictMode 双挂载 / kill+create）时，旧进程的 onExit 会晚到。
    // 只认自己那条登记：否则会把新终端的入口抹掉 → inputPty 静默白写（终端不能操作），
    // 并把旧进程的退出码当新终端的退出报出来。
    if (registry.get(termId) !== entry) return
    registry.delete(termId)
    emitToWindow(winId, 'pty:exit', { termId, code: exitCode })
  })
  emitToWindow(winId, 'pty:ready', { termId, shell: file, pid: term.pid })
  return { ok: true, shell: file, pid: term.pid }
}

export function inputPty(termId: string, data: string): void {
  registry.get(termId)?.term.write(data)
}

export function resizePty(termId: string, cols: number, rows: number): void {
  const e = registry.get(termId)
  if (!e) return
  // ConPTY resize 限速（VSCode terminalProcess 同款防挂死）
  try {
    e.term.resize(Math.max(20, cols), Math.max(5, rows))
  } catch { /* resize 竞态静默 */ }
}

/** 回收终端（kill 节流：ConPTY 快速 kill-spawn 会挂死 conhost） */
export function killPty(termId: string): void {
  const e = registry.get(termId)
  if (!e) return
  // 先摘登记再 kill：同 id 立刻重建时旧条目不会占着 termId
  registry.delete(termId)
  if (e.flushTimer) clearTimeout(e.flushTimer)
  const wait = KILL_THROTTLE_MS - (Date.now() - e.lastKill)
  const doKill = () => {
    e.lastKill = Date.now()
    try {
      e.term.kill()
    } catch { /* 已退出 */ }
  }
  // 节流窗口内推迟 kill，不能整个跳过——进程会漏成孤儿
  if (wait > 0) setTimeout(doKill, wait)
  else doKill()
}

/** 窗口关闭回收：该窗口持有的全部终端 */
export function killAllForWindow(winId: number): void {
  for (const [id, e] of registry) {
    if (e.winId === winId) killPty(id)
  }
}

export function listPtys(): string[] {
  return [...registry.keys()]
}
