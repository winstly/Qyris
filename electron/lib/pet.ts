/**
 * 桌宠窗口管理：透明置顶小窗口（动画角色）+ 面板窗口（项目/对话）。
 *
 * 窗口模型：
 *   petWin（128×128 透明置顶）──左键──→ panelWin（400×600 项目/对话）
 *
 * 状态聚合：监听 build/AI 事件 → 维护 petState → 推送给桌宠窗口切换动画。
 * 面板窗口复用主窗口的 preload + IPC 事件，Zustand store 各自独立。
 */
import { BrowserWindow, Menu, screen, ipcMain } from 'electron'
import path from 'node:path'
import { emitToWindow, registerWindow } from './emitter'
import { mainLog } from './log-file'

export type PetState = 'idle' | 'working' | 'waiting' | 'error'

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

/** 渲染层对话状态 → 桌宠态：error > 等你回答 > 生成中/工具执行/重试 > 待命 */
function chatStatusToPetState(status: string): PetState {
  if (status === 'error') return 'error'
  if (status === 'awaiting-user') return 'waiting'
  if (status === 'streaming' || status === 'tools' || status === 'retrying') return 'working'
  return 'idle'
}

/** 聚合所有窗口：error > waiting > working > idle */
function recomputePetChatState(): void {
  let next: PetState = 'idle'
  for (const st of windowChatStates.values()) {
    if (st === 'error') { next = 'error'; break }
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

const PET_SIZE = 128

/** 按环境加载桌宠家族页面：dev 走 Vite dev server（loadURL），打包走本地文件（loadFile），
 *  与主窗口加载分支完全对齐。禁止用 loadURL 喂裸文件路径——Electron 会把
 *  "E:\...\pet\index.html" 当 URL 解析 → ERR_INVALID_URL(-300) → did-fail-load →
 *  透明空白窗口（打包后"桌宠消失"的根因；dev 有 ELECTRON_RENDERER_URL 走 http 分支，
 *  恰好掩盖了打包分支是坏的）。 */
function loadPetPage(win: BrowserWindow, page: string): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    const url = `${rendererUrl}/${page}`
    mainLog.info(`[pet] 加载(dev) ${page}: ${url}`)
    void win.loadURL(url)
  } else {
    mainLog.info(`[pet] 加载(packaged) ${page}`)
    void win.loadFile(path.join(__dirname, '../renderer/', page))
  }
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

  petWin.once('ready-to-show', () => {
    mainLog.info('[pet] ready-to-show，显示桌宠窗口')
    petWin?.show()
  })
  petWin.webContents.on('did-fail-load', (_e, code, desc) => {
    mainLog.error(`[pet] 加载失败: ${code} ${desc}`)
  })
  loadPetPage(petWin, 'pet/index.html')

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

/** 面板与桌宠图标间的间距 */
const PANEL_GAP = 8

/** 面板定位纯函数（导出供 smoke 矩阵测试）：以桌宠 bounds 为基准决定面板 x/y。
 *  垂直：上方优先（不遮桌宠），不足放下方；下方也放不下时贴工作区底缘——
 *  此时面板会盖住桌宠，但保证自身完整可见可交互（极矮屏下无第三种选择）。
 *  水平：面板中线对齐桌宠中线。
 *  X/Y 最终钳制在给定工作区内；极窄工作区（竖屏侧屏）下保左/上缘完整、
 *  对侧可溢出，不自动缩窗（面板可手动 resize）。 */
export function computePanelPosition(
  petBounds: { x: number; y: number; width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
  panelSize: { width: number; height: number },
): { x: number; y: number } {
  const { x: waX, y: waY, width: waW, height: waH } = workArea
  const { width: panelW, height: panelH } = panelSize

  let x = petBounds.x + petBounds.width / 2 - panelW / 2
  const spaceAbove = petBounds.y - waY
  let y: number
  if (spaceAbove >= panelH + PANEL_GAP) {
    y = petBounds.y - panelH - PANEL_GAP
  } else {
    const yBelow = petBounds.y + petBounds.height + PANEL_GAP
    y = yBelow + panelH <= waY + waH ? yBelow : waY + waH - panelH
  }
  x = Math.max(waX, Math.min(x, waX + waW - panelW))
  y = Math.max(waY, Math.min(y, waY + waH - panelH))
  return { x: Math.round(x), y: Math.round(y) }
}

/** 以桌宠当前图标位置为基准给面板定位：创建与每次重新显示共用，
 *  保证面板始终贴着被拖动的桌宠。钳制基准是桌宠所在显示器的工作区
 *  （桌宠可被拖到副屏）——按主屏钳制会让面板弹到离桌宠很远的另一块屏上。 */
function positionPanelNearPet(win: BrowserWindow): void {
  if (!petWin || petWin.isDestroyed()) return
  const petBounds = petWin.getBounds()
  const workArea = screen.getDisplayMatching(petBounds).workArea
  // 用面板实际尺寸（用户可能手动 resize 过），不用创建时常量
  const { x, y } = computePanelPosition(petBounds, workArea, win.getBounds())
  win.setPosition(x, y)
}

/** 面板可见时跟随桌宠重定位（拖拽实时跟随路径调用；面板隐藏/不存在时静默跳过） */
export function repositionPanelIfVisible(): void {
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) {
    positionPanelNearPet(panelWin)
  }
}

export function togglePanelWindow(): void {
  if (panelWin && !panelWin.isDestroyed()) {
    if (panelWin.isVisible()) {
      // 隐藏而非销毁：保留 Zustand store 状态，重开时无需从 DB 重新加载
      panelWin.hide()
      mainLog.info('[pet] 面板隐藏（store 状态保留，未销毁）')
      if (process.platform === 'darwin' && petWin && !petWin.isDestroyed()) petWin.setFocusable(true)
    } else {
      // 复用窗口也要按桌宠当前位置重新定位——否则面板停在旧位置，不跟随被拖动的桌宠
      positionPanelNearPet(panelWin)
      panelWin.show()
      panelWin.focus()
      mainLog.info('[pet] 面板重新显示（复用既有窗口，状态应完整）')
      if (process.platform === 'darwin' && petWin && !petWin.isDestroyed()) petWin.setFocusable(false)
    }
    return
  }
  if (!petWin || petWin.isDestroyed()) return
  mainLog.info('[pet] 面板不存在，创建新窗口（此前若曾打开，说明发生了销毁——需排查）')

  // macOS IMK 兼容：禁止桌宠窗口抢焦点，防止 toolbar 窗口与面板竞争 IMK match port
  // （导致 "error messaging the match port for IMKCFRunLoopWakeUpReliable" + 文本输入阻塞）
  // 桌宠保持可见但不接受键盘焦点，面板正常接收文本输入
  if (process.platform === 'darwin') petWin.setFocusable(false)

  panelWin = new BrowserWindow({
    width: 400,
    height: 600,
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

  // 创建后、显示前按桌宠当前位置定位（show: false，不会闪现中间位置）
  positionPanelNearPet(panelWin)

  loadPetPage(panelWin, 'pet/panel.html')
  panelWin.once('ready-to-show', () => panelWin?.show())

  const panelWinId = panelWin.id
  panelWin.on('closed', () => {
    // 正常运行中此事件不应触发（hide ≠ closed）——触发即说明面板被销毁，运行中数据全丢
    mainLog.warn('[pet] 面板窗口被销毁（closed 事件）——若非应用退出，运行中的对话数据将丢失')
    clearWindowChatState(panelWinId)
    panelWin = null
    // 面板关闭后恢复桌宠可交互（可点击开面板、右键菜单）
    if (petWin && !petWin.isDestroyed()) {
      if (process.platform === 'darwin') petWin.setFocusable(true)
    }
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
  // 面板窗口控制：隐藏（保留 store 状态），非销毁
  ipcMain.on('pet:panel-close', () => {
    if (panelWin && !panelWin.isDestroyed()) {
      panelWin.hide()
      mainLog.info('[pet] 面板隐藏（标题栏关闭按钮，store 状态保留）')
      if (process.platform === 'darwin' && petWin && !petWin.isDestroyed()) petWin.setFocusable(true)
    }
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