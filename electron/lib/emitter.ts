/**
 * 多窗口事件路由层。
 * 每个 BrowserWindow 注册后，按 windowId（webContents.id）定向发送事件。
 * AI 请求通过 requestId → windowId 映射路由到发起窗口。
 */
import { BrowserWindow } from 'electron'

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

/** 向所有 Electron 窗口广播（含未注册的桌宠/面板窗口）。
 *  exceptWinId 用于跳过发起窗口（避免主对话流在发起窗口双份投递）。
 *  镜像管道用：AI 流事件 / 对话镜像 relay 由此到达每一个窗口。 */
export function broadcastToWindows(event: string, payload: unknown, exceptWinId?: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.id !== exceptWinId) {
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

/** 请求定向事件：按 requestId 路由到发起窗口；未登记（旧路径/异常）回退全窗口广播 */
export function emitToRequestWindow(requestId: string, event: string, payload: unknown): void {
  const winId = requestWindowMap.get(requestId)
  if (winId != null) {
    emitToWindow(winId, event, payload)
  } else {
    emitToAllWindows(event, payload)
  }
}

/**
 * 向渲染进程广播事件。@deprecated 新代码按窗口定向（emitToWindow / emitToRequestWindow）
 */
export function emitToRenderer(event: string, payload: unknown): void {
  emitToAllWindows(event, payload)
}
