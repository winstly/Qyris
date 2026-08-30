/**
 * Electron preload 暴露面（window.desktopAPI）的类型化封装层。
 * 前端所有文件操作都经由这里走主进程，绝不在渲染层直接碰文件系统。
 */
import type { AppConfig } from '@/types'

/** 是否运行在 Electron 桌面壳内（浏览器直接跑 vite 时为 false，界面会给出提示） */
export const isDesktop = typeof window !== 'undefined' && !!window.desktopAPI

/**
 * Electron 把 ipcMain.handle 抛出的错误包装成
 * "Error invoking remote method 'x': Error: 原始消息"；这里剥掉前缀，
 * 保持与旧版一致的裸字符串语义（消费方均为 String(e)）。
 */
function stripIpcPrefix(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const m = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?/)
  const stripped = m ? raw.slice(m[0].length) : raw
  return stripped
}

/** 统一入口：桌面壳未就绪时走拒绝路径，主进程错误剥前缀后以裸字符串抛出 */
function wrap<T>(fn: (d: DesktopAPI) => Promise<T>): Promise<T> {
  const d = window.desktopAPI
  if (!d) return Promise.reject(new Error('未在桌面应用内运行（请使用 npm run dev 启动）'))
  return fn(d).catch((e: unknown) => {
    throw stripIpcPrefix(e)
  })
}

export const api = {
  // 文件系统
  listDir: (projectRoot: string, dir: string) => wrap((d) => d.listDir(projectRoot, dir)),
  searchFiles: (projectRoot: string, query: string) => wrap((d) => d.searchFiles(projectRoot, query)),
  readTextFile: (projectRoot: string, path: string) => wrap((d) => d.readTextFile(projectRoot, path)),
  writeTextFile: (projectRoot: string, path: string, content: string) =>
    wrap((d) => d.writeTextFile(projectRoot, path, content)),
  snapshotFile: (projectRoot: string, sessionId: string, path: string) =>
    wrap((d) => d.snapshotFile(projectRoot, sessionId, path)),
  listSnapshots: (projectRoot: string) => wrap((d) => d.listSnapshots(projectRoot)),
  restoreFile: (projectRoot: string, path: string) => wrap((d) => d.restoreFile(projectRoot, path)),
  restoreSession: (projectRoot: string, sessionId: string) => wrap((d) => d.restoreSession(projectRoot, sessionId)),
  loadSession: (projectRoot: string) => wrap((d) => d.loadSession(projectRoot)),
  saveSession: (projectRoot: string, messages: unknown[]) => wrap((d) => d.saveSession(projectRoot, messages)),
  createEntry: (projectRoot: string, parentDir: string, name: string, isDir: boolean) =>
    wrap((d) => d.createEntry(projectRoot, parentDir, name, isDir)),
  renameEntry: (projectRoot: string, path: string, newName: string) =>
    wrap((d) => d.renameEntry(projectRoot, path, newName)),
  deleteEntry: (projectRoot: string, path: string) => wrap((d) => d.deleteEntry(projectRoot, path)),
  deleteProjectFiles: (projectRoot: string) => wrap((d) => d.deleteProjectFiles(projectRoot)),

  // 子进程 / watcher
  runProject: (projectRoot: string, name: string, command: string) =>
    wrap((d) => d.runProject(projectRoot, name, command)),
  stopProject: (name?: string) => wrap((d) => d.stopProject(name)),
  startWatching: (projectRoot: string) => wrap((d) => d.startWatching(projectRoot)),
  stopWatching: () => wrap((d) => d.stopWatching()),

  // 配置与密钥（无 getSecret：明文 Key 不出主进程）
  getConfig: () => wrap((d) => d.getConfig()),
  setConfig: (config: AppConfig) => wrap((d) => d.setConfig(config)),
  setSecret: (key: string, value: string) => wrap((d) => d.setSecret(key, value)),
  hasSecret: (key: string) => wrap((d) => d.hasSecret(key)),
  deleteSecret: (key: string) => wrap((d) => d.deleteSecret(key)),

  // AI（主进程流式代理）
  aiChatStream: (
    requestId: string, provider: string, baseUrl: string, model: string,
    messages: unknown, tools: unknown,
  ) => wrap((d) => d.aiChatStream(requestId, provider, baseUrl, model, messages, tools)),
  aiTestConnection: (provider: string, baseUrl: string, model: string) =>
    wrap((d) => d.aiTestConnection(provider, baseUrl, model)),
  aiCancel: (requestId: string) => wrap((d) => d.aiCancel(requestId)),

  // Skills 目录
  scanSkills: (dir: string) => wrap((d) => d.scanSkills(dir)),
  readSkill: (dir: string, skillId: string) => wrap((d) => d.readSkill(dir, skillId)),
  pickSkillsDir: () => wrap((d) => d.pickSkillsDir()),

  // 创建项目
  createEmptyProject: (parentDir: string, name: string) => wrap((d) => d.createEmptyProject(parentDir, name)),
  cloneRepos: (parentDir: string, urls: string[]) => wrap((d) => d.cloneRepos(parentDir, urls)),
  pickParentDir: () => wrap((d) => d.pickParentDir()),

  // 窗口
  pickDirectory: () => wrap((d) => d.pickDirectory()),
  setWindowTitle: (title: string) => wrap((d) => d.setWindowTitle(title)),
  startElementPick: (url: string) => wrap((d) => d.startElementPick(url)),
}

// ---------- 事件订阅（main → renderer，同步返回取消函数） ----------

export function onBuildOutput(cb: (payload: { name: string; stream: 'stdout' | 'stderr'; line: string }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onBuildOutput(cb)
}

export function onBuildExit(cb: (payload: { name: string; code: number }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onBuildExit(cb)
}

export function onAiDelta(cb: (payload: { requestId: string; delta: string }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onAiDelta(cb)
}

export function onAiReasoning(cb: (payload: { requestId: string; delta: string }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onAiReasoning(cb)
}

export function onFsChanged(cb: (payload: { paths: string[] }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onFsChanged(cb)
}
