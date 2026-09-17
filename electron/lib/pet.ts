/**
 * 桌宠窗口管理：透明置顶小窗口（动画角色）+ 面板窗口（项目/对话）。
 *
 * 窗口模型：
 *   petWin（64×64 透明置顶）──左键──→ panelWin（400×600 项目/对话）
 *
 * 状态聚合：监听 build/AI 事件 → 维护 petState → 推送给桌宠窗口切换动画。
 * 面板窗口复用主窗口的 preload + IPC 事件，Zustand store 各自独立。
 */
import { BrowserWindow, Menu, screen, ipcMain } from 'electron'
import path from 'node:path'
import { emitToWindow, registerWindow } from './emitter'
import { mainLog } from './log-file'

export type PetState = 'idle' | 'working' | 'waiting'

let petWin: BrowserWindow | null = null
let panelWin: BrowserWindow | null = null
let currentState: PetState = 'idle'

// ---------- 状态聚合 ----------

/** 外部模块（proc/AI/对话状态聚合）调用此函数推送状态变化 */
export function updatePetState(state: PetState): void {
  if (currentState === state) return
  currentState = state
  if (petWin && !petWin.isDestroyed()) {
    emitToWindow(petWin.id, 'pet:state', state)
  }
}

// ---------- 对话状态聚合（桌宠动画跟随任一窗口的 AI 活动） ----------

/** 各窗口上报的对话状态（sender.id → 桌宠态） */
const windowChatStates = new Map<number, PetState>()

/** 渲染层对话状态 → 桌宠态：等你回答 > 生成中/工具执行/重试 > 待命 */
function chatStatusToPetState(status: string): PetState {
  if (status === 'awaiting-user') return 'waiting'
  if (status === 'streaming' || status === 'tools' || status === 'retrying') return 'working'
  return 'idle'
}

/** 聚合所有窗口：waiting > working > idle */
function recomputePetChatState(): void {
  let next: PetState = 'idle'
  for (const st of windowChatStates.values()) {
    if (st === 'waiting') { next = 'waiting'; break }
    if (st === 'working') next = 'working'
  }
  updatePetState(next)
}

/** 渲染层上报某窗口的当前对话状态（pet:chat-state IPC） */
export function setWindowChatState(windowId: number, status: string): void {
  const mapped = chatStatusToPetState(status)
  if (windowChatStates.get(windowId) === mapped) return
  windowChatStates.set(windowId, mapped)
  recomputePetChatState()
}

/** 窗口关闭时清除其上报位（panelWin/主窗口 closed 路径调用），防幽灵状态钉死动画 */
export function clearWindowChatState(windowId: number): void {
  if (windowChatStates.delete(windowId)) recomputePetChatState()
}

// ---------- 桌宠窗口 ----------

const PET_SIZE = 64

function getRendererUrl(page: string): string {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) return `${rendererUrl}/${page}`
  return path.join(__dirname, `../renderer/${page}`)
}

export function createPetWindow(): void {
  if (petWin && !petWin.isDestroyed()) return

  // 默认位置：主显示器工作区右下角（以 workArea 原点为基准，任务栏在左/上时不会跑偏）
  const workArea = screen.getPrimaryDisplay().workArea
  const screenW = workArea.width
  const screenH = workArea.height
  mainLog.info(`[pet] 创建桌宠窗口，工作区: ${screenW}x${screenH}@${workArea.x},${workArea.y}`)
  const defaultX = workArea.x + screenW - PET_SIZE - 40
  const defaultY = workArea.y + screenH - PET_SIZE - 40

  petWin = new BrowserWindow({
    x: defaultX,
    y: defaultY,
    width: PET_SIZE,
    height: PET_SIZE,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  petWin.setIgnoreMouseEvents(false)
  // 注册进 emitter 的窗口表：pet:state 等定向事件走 emitToWindow（按 windowId 查表），
  // 不注册的话查不到此窗口，所有状态推送被静默丢弃，桌宠动画永远停在 idle
  registerWindow(petWin)

  const url = getRendererUrl('pet/index.html')
  mainLog.info(`[pet] 加载 URL: ${url}`)
  petWin.once('ready-to-show', () => {
    mainLog.info('[pet] ready-to-show，显示桌宠窗口')
    petWin?.show()
  })
  petWin.webContents.on('did-fail-load', (_e, code, desc) => {
    mainLog.error(`[pet] 加载失败: ${code} ${desc}`)
  })
  void petWin.loadURL(url)

  petWin.on('closed', () => {
    petWin = null
    // 桌宠关闭时也关闭面板
    if (panelWin && !panelWin.isDestroyed()) panelWin.close()
  })

  mainLog.info('[pet] 桌宠窗口已创建')
}

export function destroyPetWindow(): void {
  if (petWin && !petWin.isDestroyed()) petWin.close()
  petWin = null
}

export function getPetWindowId(): number | null {
  return petWin && !petWin.isDestroyed() ? petWin.id : null
}

/** 该 windowId 是否桌宠家族窗口（桌宠/面板）：主窗口的布局计算（偏移、最大化恢复）
 *  只应参考主窗口序列，需把这两个小窗口排除 */
export function isPetFamilyWindowId(id: number): boolean {
  if (getPetWindowId() === id) return true
  return panelWin != null && !panelWin.isDestroyed() && panelWin.id === id
}

// ---------- 面板窗口 ----------

export function togglePanelWindow(): void {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.close()
    return
  }
  if (!petWin || petWin.isDestroyed()) return

  const petBounds = petWin.getBounds()
  // 钳制基准是桌宠所在显示器的工作区（桌宠可被拖到副屏）——按主屏钳制会让面板
  // 弹到离桌宠很远的另一块屏上
  const { x: waX, y: waY, width: screenW, height: screenH } = screen.getDisplayMatching(petBounds).workArea
  const panelW = 400
  const panelH = 600

  // 面板在桌宠上方弹出；如果上方空间不够则放下方
  let panelX = petBounds.x + PET_SIZE / 2 - panelW / 2
  let panelY = petBounds.y - panelH - 8
  if (panelY < waY) panelY = petBounds.y + PET_SIZE + 8
  // 钳制在桌宠所在屏的工作区内
  panelX = Math.max(waX, Math.min(panelX, waX + screenW - panelW))
  panelY = Math.max(waY, Math.min(panelY, waY + screenH - panelH))

  panelWin = new BrowserWindow({
    x: panelX,
    y: panelY,
    width: panelW,
    height: panelH,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#131315',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // 面板同主窗口一样注册进 emitter：build-output / fs-changed 按 sender windowId 定向、
  // config:changed 走 emitToAllWindows——不注册则面板里这些事件全部静默丢失
  registerWindow(panelWin)

  void panelWin.loadURL(getRendererUrl('pet/panel.html'))
  panelWin.once('ready-to-show', () => panelWin?.show())

  const panelWinId = panelWin.id
  panelWin.on('closed', () => {
    clearWindowChatState(panelWinId)
    panelWin = null
  })

  mainLog.info('[pet] 桌宠面板已打开')
}

// ---------- IPC ----------

/** 注册桌宠 IPC。handlers 由 main/index.ts 注入（打开主窗口 / 退出应用），
 *  避免 pet.ts ↔ index.ts 循环依赖。 */
export function registerPetIpc(handlers: { openMain: () => void; quitApp: () => void }): void {
  ipcMain.on('pet:toggle-panel', () => togglePanelWindow())
  ipcMain.on('pet:request-state', (e) => {
    emitToWindow(e.sender.id, 'pet:state', currentState)
  })
  // 对话状态上报：桌宠动画跟随任一窗口的 AI 活动（生成中/等你回答）
  ipcMain.on('pet:chat-state', (e, p: { status?: string }) => {
    setWindowChatState(e.sender.id, String(p?.status ?? 'idle'))
  })
  // 右键菜单：原生 popup（64px 透明小窗口画 DOM 菜单会被裁剪）
  ipcMain.on('pet:context-menu', () => {
    if (!petWin || petWin.isDestroyed()) return
    Menu.buildFromTemplate([
      { label: '打开工作台', click: () => handlers.openMain() },
      { label: '退出应用', click: () => handlers.quitApp() },
    ]).popup({ window: petWin })
  })
}