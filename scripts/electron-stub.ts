/** 冒烟测试用 electron 桩：proc.ts / migrate.ts 传递依赖 electron（smoke 不触达对话框路径） */
export const app = {}
export const net = {}
export const safeStorage = {} // secrets.ts 具名导入（smoke 走 llmHook，不解密真实凭据）
export const BrowserWindow = Object.assign(function BrowserWindow(): void {}, {
  /** emitter.broadcastToWindows 遍历真实窗口；桩环境无窗口可广播（假窗口走 registerWindow 捕获） */
  getAllWindows: (): unknown[] => [],
})
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) }
/** pet.ts 传递依赖（smoke 只触达 computePanelPosition 纯函数，不触达窗口/菜单路径） */
export const Menu = { buildFromTemplate: (): unknown => ({ popup: (): void => {} }) }
export const screen = { getDisplayMatching: (): unknown => ({ workArea: { x: 0, y: 0, width: 0, height: 0 } }) }
export const ipcMain = { on: (): void => {}, handle: (): void => {} }
