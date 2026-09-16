/**
 * 主进程文件日志：按天落盘 userData/logs/main-YYYYMMDD.log，保留最近 7 份。
 * 写入走 appendFileSync（单行低频，主进程日志量级安全）+ 错误静默（日志不可拖垮业务）。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { AbstractMessageLogger, BufferLogger, ConsoleLogger, LogLevel, MultiplexLogger, format } from '../../shared/base/log'

const MAX_AGE_DAYS = 7

const LEVEL_LABEL: Record<LogLevel, string> = {
  [LogLevel.Off]: 'off',
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warn]: 'warn',
  [LogLevel.Error]: 'error',
}

function logsDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

function logFileFor(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return path.join(logsDir(), `main-${y}${m}${d}.log`)
}

/** 清理超过保留期的旧日志 */
function pruneOldLogs(): void {
  try {
    const dir = logsDir()
    if (!existsSync(dir)) return
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('main-') || !f.endsWith('.log')) continue
      const full = path.join(dir, f)
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
      } catch { /* 单文件失败跳过 */ }
    }
  } catch { /* 清理失败不影响启动 */ }
}

export class FileLogger extends AbstractMessageLogger {
  override log(level: LogLevel, message: string): void {
    if (level === LogLevel.Off) return
    try {
      mkdirSync(logsDir(), { recursive: true })
      const line = `[${new Date().toISOString()}] [${LEVEL_LABEL[level]}] ${message}\n`
      appendFileSync(logFileFor(new Date()), line, 'utf8')
    } catch { /* 日志写失败静默（磁盘满/权限等） */ }
  }
}

/** 主进程全局日志单例：BufferLogger 先缓冲，app ready 后接入控制台+文件双写 */
export const mainLog = new BufferLogger()

/** app ready 后调用（app.getPath 可用之前 FileLogger 无法定位目录） */
export function attachFileLogging(): void {
  pruneOldLogs()
  mainLog.setLogger(new MultiplexLogger([new ConsoleLogger(), new FileLogger()]))
}

export { format }
