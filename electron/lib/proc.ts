/** 子进程管理 —— 多槽版本：每个命名服务一个槽，互不干扰；同名槽重启 = 先杀旧再启 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promises as fsp } from 'node:fs'
import type { Readable } from 'node:stream'
import { emitToRenderer } from './emitter'
import { errorMessage } from './util'

interface ProcSlot {
  name: string
  proc: ChildProcess
}

/** 服务名 → 槽。名字统一 trim + 小写归一，避免 'Web' 与 'web' 出现两个槽 */
const slots = new Map<string, ProcSlot>()

function normName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : ''
  return n || 'default'
}

/** 去掉 ANSI 颜色/控制序列：vite/npm 等即便在管道下也可能强制带色，会污染 URL 解析与日志 */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
}

/** Windows spawn taskkill 同步等结果（与 Rust Command::output 一致），结果忽略 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* 进程已不在 */
    }
  } else {
    try {
      // unix 侧 spawn 时 detached:true → 子进程为进程组长，负 PID 杀整组
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* 进程已不在 */
    }
  }
}

/** 杀指定槽（存在才杀）；不杀其他槽 */
function takeAndKillOne(key: string): void {
  const slot = slots.get(key)
  if (!slot) return
  slots.delete(key)
  if (slot.proc.pid) killTree(slot.proc.pid)
}

/** 停止单个服务；name 省略 = 停止全部槽 */
export async function stopProject(name?: unknown): Promise<void> {
  if (typeof name === 'string' && name.trim()) {
    takeAndKillOne(normName(name))
    return
  }
  for (const key of [...slots.keys()]) takeAndKillOne(key)
}

/** 退出/切项目清理入口（幂等）：杀全部子进程，watcher 由 index.ts 另行停止 */
export function killRunningForCleanup(): void {
  for (const key of [...slots.keys()]) takeAndKillOne(key)
}

export async function runProject(projectRoot: string, name: unknown, command: string): Promise<number> {
  try {
    const st = await fsp.stat(projectRoot)
    if (!st.isDirectory()) throw new Error(`项目目录不存在：${projectRoot}`)
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('项目目录不存在')) throw e
    throw new Error(`项目目录不存在：${projectRoot}`)
  }

  const key = normName(name)
  // 同名槽 = 重启语义：先杀旧再启动；其他槽不受影响
  takeAndKillOne(key)

  const isWin = process.platform === 'win32'
  let proc: ChildProcess
  try {
    proc = spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/C', command] : ['-c', command], {
      cwd: projectRoot,
      // stdin null + 双管 piped：Windows 下不分配控制台（与 Rust 行为一致），windowsHide 双保险
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin, // unix 进程组，便于整组 SIGKILL
      env: {
        ...process.env,
        // 源头禁色：掐掉 ANSI 码，保证 URL 解析与日志干净
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    })
  } catch (e) {
    throw new Error(`命令启动失败：${errorMessage(e)}`)
  }

  const emit = (channel: string, payload: Record<string, unknown>): void => {
    emitToRenderer(channel, { name: key, ...payload })
  }

  const pipe = (stream: Readable | null, streamName: 'stdout' | 'stderr'): void => {
    if (!stream) return
    const rl = createInterface({ input: stream }) // readline 自动剥 \n 与 \r\n
    rl.on('line', (line) => emit('build-output', { stream: streamName, line: stripAnsi(line) }))
  }
  pipe(proc.stdout, 'stdout')
  pipe(proc.stderr, 'stderr')

  // spawn 本身失败（如 shell 不存在，极罕见）：Node 异步抛 error 事件而非同步 throw；
  // 以 build-exit{code:-1} 收口，避免前端永远停在"运行中"
  const isCurrent = (): boolean => slots.get(key)?.proc === proc
  proc.on('error', () => {
    if (isCurrent()) {
      slots.delete(key)
      emit('build-exit', { code: -1 })
    }
  })
  proc.on('exit', (code) => {
    // 已被同名槽重启替换的旧进程，其退出不再下发——否则旧 exit 会把新槽从 building 打回 error
    if (!isCurrent()) return
    slots.delete(key)
    emit('build-exit', { code: code ?? -1 })
  })

  slots.set(key, { name: key, proc })
  return proc.pid ?? -1
}
