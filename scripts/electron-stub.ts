/** 冒烟测试用 electron 桩：proc.ts / migrate.ts 传递依赖 electron（smoke 不触达对话框路径） */
export const app = {}
export const net = {}
export const safeStorage = {} // secrets.ts 具名导入（smoke 走 llmHook，不解密真实凭据）
export const BrowserWindow = function BrowserWindow(): void {}
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) }
