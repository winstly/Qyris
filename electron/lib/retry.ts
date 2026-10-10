/**
 * 工具层通用重试：指数退避 + 随机抖动 + 中止传播。
 *
 * 纪律（比实现更重要）：
 *   1. 只重试「暂态错误」（isTransientError：网络抖动/超时/SQLite busy）——确定性错误
 *      （参数错、权限不足、凭据缺失）重试 N 次还是同一个错，纯浪费与噪音；
 *   2. 非幂等操作禁止整体包 retry——「远程命令已跑、结果未知」的操作重试 = 双倍破坏。
 *      要重试就把「连接建立/纯读」这类幂等单元包进操作内部，副作用段绝不进重试圈
 *      （remote_exec 就是这个模式的实现范本：仅连接失败阶段重试，命令已跑绝不重发）。
 */
let warn: (msg: string) => void = (m) => console.warn(m)
/** 测试注入口（smoke 静音告警） */
export function setRetryWarn(fn: (msg: string) => void): void {
  warn = fn
}

const TRANSIENT_CODE_RE =
  /^(ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|UND_ERR|SQLITE_BUSY|SQLITE_LOCKED)$/
const TRANSIENT_MSG_RE =
  /timed? ?out|timeout|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR|socket hang up|SQLITE_BUSY|SQLITE_LOCKED|database is locked|connection closed|handshake|Connection lost/i

/** 暂态错误判定：错误码或消息命中网络/锁类模式 */
export function isTransientError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : ''
  if (TRANSIENT_CODE_RE.test(code)) return true
  return TRANSIENT_MSG_RE.test(String(e?.message ?? err))
}

export interface RetryOptions {
  /** 首次失败后的额外重试次数（总尝试 = 1 + retries），缺省 1 */
  retries?: number
  /** 首次退避毫秒，缺省 300 */
  baseDelayMs?: number
  /** 退避上限毫秒，缺省 2000 */
  maxDelayMs?: number
  /** 中止信号：等待退避期间中止立即抛「操作已取消」 */
  signal?: AbortSignal
  /** 日志标签（每次重试带它，可溯源） */
  label?: string
  /** 可重试判定，缺省 isTransientError；返回 false 的错误立即原样抛出 */
  retryOn?: (err: unknown) => boolean
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 1)
  const base = Math.max(50, opts.baseDelayMs ?? 300)
  const max = Math.max(base, opts.maxDelayMs ?? 2000)
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new Error('操作已取消')
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (attempt >= retries) break
      if (!(opts.retryOn ?? isTransientError)(e)) break
      const delay = Math.min(max, base * 2 ** attempt) + Math.floor(Math.random() * 120)
      warn(`[retry] ${opts.label ?? 'op'} 第 ${attempt + 1} 次失败（暂态），${delay}ms 后重试：${String((e as Error)?.message ?? e)}`)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay)
        opts.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            reject(new Error('操作已取消'))
          },
          { once: true },
        )
      })
    }
  }
  throw lastErr
}
