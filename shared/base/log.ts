/**
 * 日志核心 —— 移植自 vscode src/vs/platform/log/common/log.ts（MIT，精简版）。
 * 设计：5 个级别方法收敛到单个 log(level, message)；MultiplexLogger 一份日志多目的地；
 * BufferLogger 在真 logger 就绪前缓冲、就绪后回放（启动早期日志不丢）。
 * 文件落盘的 FileLogger 在 electron/lib/log-file.ts（依赖 node:fs）。
 */

export enum LogLevel {
  Off = 0,
  Trace = 1,
  Debug = 2,
  Info = 3,
  Warn = 4,
  Error = 5,
}

export interface ILogger {
  log(level: LogLevel, message: string): void
  trace(message: string): void
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  [LogLevel.Off]: 'off',
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warn]: 'warn',
  [LogLevel.Error]: 'error',
}

/** 统一格式化：Error → 堆栈、对象 → JSON（失败降级 String） */
export function format(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 抽象基类：子类只实现 log(level, message) 一个方法 */
export abstract class AbstractMessageLogger implements ILogger {
  abstract log(level: LogLevel, message: string): void

  trace(message: unknown): void { this.log(LogLevel.Trace, format(message)) }
  debug(message: unknown): void { this.log(LogLevel.Debug, format(message)) }
  info(message: unknown): void { this.log(LogLevel.Info, format(message)) }
  warn(message: unknown): void { this.log(LogLevel.Warn, format(message)) }
  error(message: unknown): void { this.log(LogLevel.Error, format(message)) }
}

export class ConsoleLogger extends AbstractMessageLogger {
  constructor(private readonly levelThreshold: LogLevel = LogLevel.Trace) {
    super()
  }

  override log(level: LogLevel, message: string): void {
    if (level < this.levelThreshold || level === LogLevel.Off) return
    const line = `[${new Date().toISOString()}] [${LEVEL_LABEL[level]}] ${message}`
    switch (level) {
      case LogLevel.Trace:
      case LogLevel.Debug:
      case LogLevel.Info:
        console.log(line)
        break
      case LogLevel.Warn:
        console.warn(line)
        break
      case LogLevel.Error:
        console.error(line)
        break
    }
  }
}

/** 多目的地透传：同一份日志同时进控制台与文件 */
export class MultiplexLogger extends AbstractMessageLogger {
  constructor(private readonly loggers: ILogger[]) {
    super()
  }

  override log(level: LogLevel, message: string): void {
    for (const l of this.loggers) {
      try {
        l.log(level, message)
      } catch {
        /* 单目的地失败不影响其余 */
      }
    }
  }
}

/** 启动早期缓冲，真 logger 就绪后回放清空 */
export class BufferLogger extends AbstractMessageLogger {
  private buffer: Array<{ level: LogLevel; message: string }> = []
  private logger: ILogger | null = null

  override log(level: LogLevel, message: string): void {
    if (this.logger) {
      this.logger.log(level, message)
    } else {
      this.buffer.push({ level, message })
    }
  }

  /** 接入真 logger（如 FileLogger 就绪后）：回放缓冲 */
  setLogger(logger: ILogger): void {
    this.logger = logger
    for (const b of this.buffer) logger.log(b.level, b.message)
    this.buffer = []
  }
}
