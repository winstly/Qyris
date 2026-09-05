/**
 * 预览控制台桥：捕获被预览页面（主窗口 webContents 的子 frame）的 console 输出，
 * 按预览 origin 过滤后转发渲染层「控制台」面板。
 *
 * 过滤机制：console-message 的 sourceId 是产生消息的脚本 URL，取其是否以预览 origin
 * 开头判定归属（Qyris 自身是 file:// 或独立 dev 端口，不会误入）。
 * 已知局限：无 sourceId（eval 等）的消息不采集——宁可漏不可错。
 * 签名兼容：Electron 各版本 console-message 有「位置参数」与「事件对象」两种签名，均归一化处理。
 */
import type { BrowserWindow } from 'electron'
import { emitToRenderer } from './emitter'

export interface PreviewConsoleEntry {
  /** 归一化级别：log / info / warning / error / debug */
  level: 'log' | 'info' | 'warning' | 'error' | 'debug'
  message: string
  sourceId: string
  ts: number
}

const BUFFER_CAP = 500
const MESSAGE_CAP = 2000

let filterOrigin: string | null = null
let buffer: PreviewConsoleEntry[] = []
let attached = false

const NUM_LEVELS: Record<number, PreviewConsoleEntry['level']> = {
  0: 'debug',
  1: 'info',
  2: 'warning',
  3: 'error',
}

function normalize(rawLevel: unknown, rawMessage: unknown, rawSourceId: unknown): PreviewConsoleEntry | null {
  let level: PreviewConsoleEntry['level']
  let message: string
  let sourceId: string
  if (typeof rawLevel === 'number') {
    level = NUM_LEVELS[rawLevel] ?? 'log'
    message = String(rawMessage ?? '')
    sourceId = String(rawSourceId ?? '')
  } else if (typeof rawLevel === 'string') {
    level = (['log', 'info', 'warning', 'error', 'debug'] as const).includes(rawLevel as never)
      ? (rawLevel as PreviewConsoleEntry['level'])
      : 'log'
    message = String(rawMessage ?? '')
    sourceId = String(rawSourceId ?? '')
  } else if (rawLevel && typeof rawLevel === 'object') {
    const ev = rawLevel as { level?: unknown; message?: unknown; sourceId?: unknown }
    const l = ev.level
    level = typeof l === 'number'
      ? (NUM_LEVELS[l] ?? 'log')
      : typeof l === 'string' && (['log', 'info', 'warning', 'error', 'debug'] as const).includes(l as never)
        ? (l as PreviewConsoleEntry['level'])
        : 'log'
    message = String(ev.message ?? '')
    sourceId = String(ev.sourceId ?? '')
  } else {
    return null
  }
  if (!message) return null
  return {
    level,
    message: message.length > MESSAGE_CAP ? message.slice(0, MESSAGE_CAP) + '…' : message,
    sourceId,
    ts: Date.now(),
  }
}

function onConsoleMessage(...args: unknown[]): void {
  if (!filterOrigin) return
  const entry = normalize(args[1] ?? args[0], args[2] ?? (args[0] as { message?: unknown })?.message, args[4] ?? (args[0] as { sourceId?: unknown })?.sourceId)
  if (!entry) return
  if (!entry.sourceId.startsWith(filterOrigin)) return
  buffer.push(entry)
  if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP)
  emitToRenderer('preview-console', entry)
}

/** 挂到主窗口 webContents（幂等）；应用启动时调用一次 */
export function attachConsoleCapture(win: BrowserWindow): void {
  if (attached) return
  win.webContents.on('console-message' as never, (...args: unknown[]) => onConsoleMessage(...args))
  attached = true
}

/** 设置预览过滤 origin。url=null 解除过滤 */
export function setConsoleFilter(url: string | null): void {
  buffer = []
  if (!url) {
    filterOrigin = null
    return
  }
  try {
    filterOrigin = new URL(url).origin
  } catch {
    filterOrigin = null
  }
}

/** 渲染层打开控制台面板时拉取已缓冲的历史 */
export function consoleHistory(): PreviewConsoleEntry[] {
  return [...buffer]
}
