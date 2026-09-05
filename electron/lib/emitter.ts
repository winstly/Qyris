/**
 * 多窗口事件路由层。
 * 每个 BrowserWindow 注册后，按 windowId（webContents.id）定向发送事件。
 * AI 请求通过 requestId → windowId 映射路由到发起窗口。
 */
import type { BrowserWindow } from 'electron'

/** windowId → BrowserWindow */
const windows = new Map<number, BrowserWindow>()

/** requestId → windowId：AI/build 事件定向到发起窗口 */
const requestWindowMap = new Map<string, number>()

export function registerWindow(win: BrowserWindow): void {
  windows.set(win.id, win)
  win.on('closed', () => windows.delete(win.id))
}

export function removeWindow(win: BrowserWindow): void {
  windows.delete(win.id)
}

export function getAllWindows(): BrowserWindow[] {
  return [...windows.values()]
}

/** 向指定窗口发送事件（窗口已销毁时静默丢弃） */
export function emitToWindow(winId: number, event: string, payload: unknown): void {
  const win = windows.get(winId)
  if (win && !win.isDestroyed()) {
    win.webContents.send(event, payload)
  }
}

/** 向所有注册窗口广播事件 */
export function emitToAllWindows(event: string, payload: unknown): void {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) {
      win.webContents.send(event, payload)
    }
  }
}

// ---------- 请求级窗口绑定 ----------

export function registerRequestWindow(requestId: string, windowId: number): void {
  requestWindowMap.set(requestId, windowId)
}

export function unregisterRequestWindow(requestId: string): void {
  requestWindowMap.delete(requestId)
}

/**
 * 向渲染进程广播事件。@deprecated 新代码用 emitToAllWindows
 */
export function emitToRenderer(event: string, payload: unknown): void {
  emitToAllWindows(event, payload)
}
