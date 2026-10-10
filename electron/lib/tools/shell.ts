/**
 * 命令执行工具：run_command（权限档 exec）。
 *
 * 执行复用 proc.runOnce（detectCommand 预检、尾部 200 行收集、同工程串行排队）；
 * 超时/取消在工具层补：到点调 proc.cancelRunOnce(token) → killTree 进程树强杀。
 *
 * 关键点：runOnce 是排队执行的，超时定时器可能在子进程尚未 spawn 时就触发，
 * 那次 cancelRunOnce 是打空的。所以「强制杀」标志一旦立起来，就以 1s 间隔持续补刀
 * 直到 runOnce 收口——迟到 spawn 的进程也会在 1s 内被树杀，不会漏跑。
 */
import { cancelRunOnce, runOnce } from '../proc'
import { ensureInside } from '../pathsafety'
import type { Tool } from '../model/types'

const DEFAULT_TIMEOUT_MS = 60_000
const MIN_TIMEOUT_MS = 1_000
/** 上限对齐 proc.runOnce 的兜底树杀（10 分钟）：工具侧不会比底层活得更久 */
const MAX_TIMEOUT_MS = 600_000
/** 输出展示上限（字符）：proc 已只留尾部 200 行，这里再截一道防单条结果吃爆上下文 */
const MAX_OUTPUT_CHARS = 40_000
const OUTPUT_TRUNCATION_MARK = '\n…（输出过长，已截断）'
/** 尾部行数上限（proc.collectLines 的 cap）：打满即视为被截断过 */
const TAIL_LINES_CAP = 200

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('工具入参必须是 JSON 对象')
  }
  return input as Record<string, unknown>
}

function text(rec: Record<string, unknown>, key: string): string {
  const v = rec[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v
}

function optInt(rec: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须是数字`)
  const n = Math.trunc(v)
  if (n < min || n > max) throw new Error(`参数 ${key} 需在 ${min}~${max} 之间`)
  return n
}

const runCommand: Tool = {
  name: 'run_command',
  description:
    '在工程内执行一条 shell 命令（跑完即退），返回退出码与输出尾部。' +
    'cwd 省略为工程根，必须在工程内。timeoutMs 默认 60000（1s~600000），超时会强杀整棵进程树。' +
    '⚠️ 无 TTY 非交互执行（stdin 已关、CI=1）：交互式向导（npm create / init 类）读不到输入会取消或采用默认值，' +
    '请改用非交互参数（如 `npm create vite@latest my-app -- --template react-ts`）。' +
    '长驻服务不要用本工具（会一直等到超时）。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令行' },
      cwd: { type: 'string', description: '工作目录（相对工程根），省略为工程根' },
      timeoutMs: { type: 'integer', description: '超时毫秒，默认 60000，上限 600000', minimum: 1, maximum: 600000 },
    },
    required: ['command'],
  },
  permission: 'exec',
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot
    if (!projectRoot) throw new Error('当前未打开工程，run_command 不可用')
    const rec = asRecord(input)
    const command = text(rec, 'command')

    // 工作目录越界防护：cwd 必须在工程内（省略 = 工程根）
    const cwdRel = rec.cwd
    let cwd = projectRoot
    if (cwdRel !== undefined && cwdRel !== null) {
      if (typeof cwdRel !== 'string' || !cwdRel.trim()) throw new Error('参数 cwd 必须是非空字符串')
      cwd = await ensureInside(projectRoot, cwdRel)
    }

    const timeoutMs =
      optInt(rec, 'timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS

    if (ctx.signal?.aborted) throw new Error('命令已被取消')

    // 取消链：超时 / AbortSignal → cancelRunOnce（proc 内部 killTree 树杀）
    const token = `tool-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    let timedOut = false
    let aborted = false

    const timer = setTimeout(() => {
      timedOut = true
      cancelRunOnce(token)
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      cancelRunOnce(token)
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    // 补刀：排队期间 cancelRunOnce 打空；标志立起后每秒补一次，迟到 spawn 的进程 1s 内也会被树杀
    const linger = setInterval(() => {
      if (timedOut || aborted) cancelRunOnce(token)
    }, 1000)

    try {
      const r = await runOnce(cwd, command, token, { onLine: (stream, line) => ctx.onOutput?.(line, stream) })
      const stopReason = aborted ? '已取消' : timedOut ? `超时（>${timeoutMs}ms，进程树已强杀）` : null
      const codeLine = stopReason
        ? `exit: ${stopReason}`
        : `exit: ${r.code ?? -1}${r.code === 0 ? '' : '（非 0）'}`
      let output = r.output
      const capped = output.split('\n').length >= TAIL_LINES_CAP
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + OUTPUT_TRUNCATION_MARK
      } else if (capped) {
        output += OUTPUT_TRUNCATION_MARK.replace('输出过长', '仅保留尾部')
      }
      // isError 语义：仅「命令没有正常跑完」（超时/取消）为 true；
      // 非 0 退出码是命令的合法结果（如 grep 没命中），如实写进 content 但不算工具失败
      return {
        content: `[run_command] ${command}\n${codeLine}${capped ? ' · 仅保留末 200 行' : ''}\n---\n${output || '（无输出）'}`,
        isError: stopReason !== null,
      }
    } finally {
      clearTimeout(timer)
      clearInterval(linger)
      ctx.signal?.removeEventListener('abort', onAbort)
    }
  },
}

/** Shell 工具集 */
export const shellTools: Tool[] = [runCommand]
