/**
 * 统一错误处理 —— 移植自 vscode src/vs/base/common/errors.ts（MIT）。
 * 纪律：所有"意料之外"的 catch 都调 onUnexpectedError，由全局 handler 决定去向
 * （日志/弹窗）；取消不是错误（isCancellationError 一律静默不上报）。
 */

export interface IErrorOptions {
  /** 预期内错误（用户输入错/文件不存在等），不上报 */
  errors?: { noTelemetry?: boolean }
}

/** 预期内错误：进日志但不进错误统计 */
export class ErrorNoTelemetry extends Error {
  override get name(): string {
    return `${super.name} (无需上报)`
  }
  constructor(msg?: string) {
    super(msg)
  }
}

/** 标记"不该发生"的错误（不变量被破坏） */
export class BugIndicatingError extends Error {
  constructor(message?: string) {
    super(message ?? '触发了不该发生的状态（BugIndicatingError）')
  }
}

/** 取消语义的统一载体 */
export class CancellationError extends Error {
  constructor() {
    super('已取消')
    this.name = 'Canceled'
  }
}

const CANCELLATION_NAME = 'Canceled'

export function isCancellationError(e: unknown): boolean {
  if (e instanceof CancellationError) return true
  return e instanceof Error && e.name === CANCELLATION_NAME
}

export interface IErrorHandler {
  (error: unknown): void
}

let unexpectedErrorHandler: IErrorHandler = (e) => {
  // 默认兜底：setTimeout 抛出，避免吞错；应用启动时应 setUnexpectedErrorHandler 替换
  setTimeout(() => {
    throw e
  })
}

export function setUnexpectedErrorHandler(handler: IErrorHandler): void {
  unexpectedErrorHandler = handler
}

/**
 * 意料之外错误的唯一入口：
 * - 取消一律静默（取消不是错误）
 * - 其余交给全局 handler（日志/上报/用户提示）
 */
export function onUnexpectedError(e: unknown): void {
  if (isCancellationError(e)) return
  unexpectedErrorHandler(e)
}

/** 外部输入引起的错误（如用户回调抛错）：与 onUnexpectedError 现阶段同语义，留名区分调用面 */
export function onUnexpectedExternalError(e: unknown): void {
  onUnexpectedError(e)
}

/** 把任意 unknown 归一为 Error（保留非 Error 的原始信息） */
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}
