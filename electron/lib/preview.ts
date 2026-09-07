/**
 * 预览 WebContentsView 管理器：用独立 webContents 渲染预览应用（替代 iframe），
 * 获得原生缓存清理、DevTools、进程隔离能力。view 作为 BrowserWindow.contentView 的子视图
 * 叠在渲染层 placeholder div 上方（两者坐标由渲染层 ResizeObserver 同步）。
 *
 * console-message：preview webContents 的 console 输出挂载独立监听器，
 * 归一化后转发到同一个 consolebridge 的缓冲/广播通道。
 */
import { WebContentsView, type BrowserWindow } from 'electron'
import * as consolebridge from './consolebridge'

let hostWin: BrowserWindow | null = null
let view: WebContentsView | null = null
let currentUrl: string | null = null
let lastBounds: { x: number; y: number; width: number; height: number } | null = null

export function setPreviewHost(win: BrowserWindow): void {
  hostWin = win
  win.on('closed', () => {
    view?.webContents.close()
    view = null
    hostWin = null
    currentUrl = null
  })
}

export function getPreviewUrl(): string | null {
  return currentUrl
}

export async function setPreviewBounds(rect: { x: number; y: number; width: number; height: number }): Promise<void> {
  if (!view || !hostWin) return
  lastBounds = rect
  view.setBounds(rect)
}

/** 弹窗打开时隐藏预览（native overlay 遮不住 DOM 弹窗），关闭后恢复 */
export function setPreviewVisible(visible: boolean): void {
  if (!view || !hostWin || hostWin.isDestroyed()) return
  if (visible) {
    // lastBounds 可能为 null（ResizeObserver 尚未触发），此时保持当前 bounds 不动
    if (lastBounds) view.setBounds(lastBounds)
  } else {
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  }
}

export async function setPreviewUrl(url: string): Promise<void> {
  if (!hostWin) return
  currentUrl = url || null
  consolebridge.setConsoleFilter(currentUrl)
  if (!url) {
    if (view) {
      hostWin.contentView.removeChildView(view)
      view.webContents.close()
      view = null
    }
    return
  }
  if (!view) {
    view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    view.setBackgroundColor('#00000000')
    hostWin.contentView.addChildView(view)
    // console-message：preview webContents 的输出转发到 consolebridge（复用同一归一化逻辑）
    view.webContents.on('console-message' as never, (...args: unknown[]) => {
      const entry = consolebridge.normalizeConsoleMessage(...args)
      if (entry) consolebridge.pushConsoleEntry(entry)
    })
  }
  view.webContents.loadURL(url).catch((e) => {
    // URL 格式错误或网络不可达时在预览区显示错误页
    const msg = String(e instanceof Error ? e.message : e).replace(/[<>&]/g, '').slice(0, 500)
    view?.webContents.loadURL(`data:text/html,<html><body style="font-family:system-ui;padding:24px;color:#999"><h3>预览加载失败</h3><pre>${msg}</pre></body></html>`).catch(() => {})
  })
}

export async function reloadPreview(): Promise<void> {
  if (!view) return
  try {
    await view.webContents.session.clearStorageData({ origin: currentUrl ? new URL(currentUrl).origin : '' })
    await view.webContents.session.clearCache()
  } catch { /* URL 解析失败或 session 不可用时静默 */ }
  view.webContents.reload()
}

export async function clearPreviewCache(): Promise<void> {
  if (!view) return
  try {
    await view.webContents.session.clearStorageData({ origin: currentUrl ? new URL(currentUrl).origin : '' })
    await view.webContents.session.clearCache()
  } catch { /* 静默 */ }
}

export function previewExecuteJs(code: string): Promise<unknown> {
  if (!view) return Promise.resolve(undefined)
  return view.webContents.executeJavaScript(code)
}

export function previewOpenDevTools(): void {
  view?.webContents.openDevTools({ mode: 'detach' })
}

export function getPreviewWebContents(): import('electron').WebContents | null {
  return view?.webContents ?? null
}
