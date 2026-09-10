/**
 * Electron preload 暴露面（window.desktopAPI）的类型化封装层。
 * 前端所有文件操作都经由这里走主进程，绝不在渲染层直接碰文件系统。
 */
import type { AppConfig, ChatMessage, ChatMessagePatch, CliAgentEventPayload, GitStatus, MemoryHit, MemoryItem, MemoryStats, PreviewConsoleEntry } from '@/types'

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
  editTextFile: (projectRoot: string, path: string, oldString: string, newString: string) =>
    wrap((d) => d.editTextFile(projectRoot, path, oldString, newString)),
  snapshotFile: (projectRoot: string, sessionId: string, path: string) =>
    wrap((d) => d.snapshotFile(projectRoot, sessionId, path)),
  listSnapshots: (projectRoot: string) => wrap((d) => d.listSnapshots(projectRoot)),
  restoreFile: (projectRoot: string, path: string) => wrap((d) => d.restoreFile(projectRoot, path)),
  restoreSession: (projectRoot: string, sessionId: string) => wrap((d) => d.restoreSession(projectRoot, sessionId)),
  clearProjectSnapshots: (projectRoot: string) => wrap((d) => d.clearProjectSnapshots(projectRoot)),
  // 消息持久化（稳定点 write-through + keyset 分页）
  messagesRecent: (projectRoot: string, limit?: number) => wrap((d) => d.messagesRecent(projectRoot, limit)),
  saveCurrentSession: (projectRoot: string, sessionId: string) => wrap((d) => d.saveCurrentSession(projectRoot, sessionId)),
  messagesBefore: (projectRoot: string, sessionId: string, beforeSeq: number, limit?: number) =>
    wrap((d) => d.messagesBefore(projectRoot, sessionId, beforeSeq, limit)),
  messageAppend: (projectRoot: string, sessionId: string, message: ChatMessage) =>
    wrap((d) => d.messageAppend(projectRoot, sessionId, message)),
  messagePatch: (projectRoot: string, sessionId: string, id: string, patch: ChatMessagePatch) =>
    wrap((d) => d.messagePatch(projectRoot, sessionId, id, patch)),
  messagesTruncate: (projectRoot: string, sessionId: string, afterSeq: number) =>
    wrap((d) => d.messagesTruncate(projectRoot, sessionId, afterSeq)),
  projectDataDelete: (projectRoot: string) => wrap((d) => d.projectDataDelete(projectRoot)),
  saveSessionTokens: (projectRoot: string, sessionId: string, tokens: { input: number; output: number }) =>
    wrap((d) => d.saveSessionTokens(projectRoot, sessionId, tokens)),
  loadSessionTokens: (projectRoot: string, sessionId: string) =>
    wrap((d) => d.loadSessionTokens(projectRoot, sessionId)) as Promise<{ input: number; output: number }>,
  createEntry: (projectRoot: string, parentDir: string, name: string, isDir: boolean) =>
    wrap((d) => d.createEntry(projectRoot, parentDir, name, isDir)),
  renameEntry: (projectRoot: string, path: string, newName: string) =>
    wrap((d) => d.renameEntry(projectRoot, path, newName)),
  deleteEntry: (projectRoot: string, path: string) => wrap((d) => d.deleteEntry(projectRoot, path)),
  copyEntry: (projectRoot: string, srcPath: string, destDir: string) =>
    wrap((d) => d.copyEntry(projectRoot, srcPath, destDir)),
  moveEntry: (projectRoot: string, srcPath: string, destDir: string) =>
    wrap((d) => d.moveEntry(projectRoot, srcPath, destDir)),
  deleteProjectFiles: (projectRoot: string) => wrap((d) => d.deleteProjectFiles(projectRoot)),

  // 子进程 / watcher
  runProject: (projectRoot: string, name: string, command: string) =>
    wrap((d) => d.runProject(projectRoot, name, command)),
  runOnce: (projectRoot: string, command: string, token?: string) =>
    wrap((d) => d.runOnce(projectRoot, command, token)),
  runOnceCancel: (token?: string) => wrap((d) => d.runOnceCancel(token)),
  checkUrl: (url: string) => wrap((d) => d.checkUrl(url)),
  portOwner: (port: number) => wrap((d) => d.portOwner(port)) as Promise<{ pid: number; name: string } | null>,
  previewConsoleAttach: (url: string | null) => wrap((d) => d.previewConsoleAttach(url)),
  previewConsoleHistory: () => wrap((d) => d.previewConsoleHistory()) as Promise<PreviewConsoleEntry[]>,
  stopProject: (projectRoot?: string | null, name?: string | null) => wrap((d) => d.stopProject(projectRoot, name)),
  startWatching: (projectRoot: string) => wrap((d) => d.startWatching(projectRoot)),
  stopWatching: () => wrap((d) => d.stopWatching()),
  stopWatchingProject: (projectRoot: string) => wrap((d) => d.stopWatchingProject(projectRoot)),

  // 配置与密钥（无 getSecret：明文 Key 不出主进程）
  getConfig: () => wrap((d) => d.getConfig()),
  mergeConfig: (patch: Partial<AppConfig>) => wrap((d) => d.mergeConfig(patch)),
  setSecret: (key: string, value: string) => wrap((d) => d.setSecret(key, value)),
  hasSecret: (key: string) => wrap((d) => d.hasSecret(key)),
  deleteSecret: (key: string) => wrap((d) => d.deleteSecret(key)),

  // AI（主进程流式代理；dispatchMode='claude-cli' 时走本机 Claude Code CLI）
  aiChatStream: (
    requestId: string, provider: string, baseUrl: string, model: string,
    messages: unknown, tools: unknown, dispatchMode?: string, projectRoot?: string | null,
    opts?: { sessionSummary?: string | null; memoryBlock?: string | null; systemPrompt?: string; outputFormat?: string },
  ) => wrap((d) => d.aiChatStream(requestId, provider, baseUrl, model, messages, tools, dispatchMode, projectRoot, opts)),
  aiTestConnection: (provider: string, baseUrl: string, model: string, dispatchMode?: string) =>
    wrap((d) => d.aiTestConnection(provider, baseUrl, model, dispatchMode)),
  aiCancel: (requestId: string) => wrap((d) => d.aiCancel(requestId)),

  // Skills 目录
  scanSkills: (dirs: string[]) => wrap((d) => d.scanSkills(dirs)),
  readSkill: (dirs: string[], skillId: string) => wrap((d) => d.readSkill(dirs, skillId)),
  pickSkillsDir: () => wrap((d) => d.pickSkillsDir()),
  projectSkillImportZip: (dir: string, zipPath: string) => wrap((d) => d.projectSkillImportZip(dir, zipPath)),
  projectSkillImportDir: (dir: string, srcDir: string) => wrap((d) => d.projectSkillImportDir(dir, srcDir)) as Promise<{ ok: boolean; name?: string; count?: number; error?: string }>,
  projectSkillDelete: (dir: string, skillId: string) => wrap((d) => d.projectSkillDelete(dir, skillId)),
  projectSkillPickZip: () => wrap((d) => d.projectSkillPickZip()),
  projectSkillPickDir: () => wrap((d) => d.projectSkillPickDir()),

  // 创建项目 / Git
  createEmptyProject: (parentDir: string, name: string) => wrap((d) => d.createEmptyProject(parentDir, name)),
  cloneRepos: (parentDir: string, repos: { url: string; branch?: string }[]) =>
    wrap((d) => d.cloneRepos(parentDir, repos)),
  testRepo: (url: string) => wrap((d) => d.testRepo(url)),
  gitRepoInfo: (dir: string) => wrap((d) => d.gitRepoInfo(dir)),
  gitCheckout: (dir: string, branch: string) => wrap((d) => d.gitCheckout(dir, branch)),
  // Git 工作区
  gitStatus: (dir: string) => wrap((d) => d.gitStatus(dir)) as Promise<GitStatus>,
  gitIsRepoRoot: (dir: string) => wrap((d) => d.gitIsRepoRoot(dir)),
  gitDiff: (dir: string, path?: string, staged?: boolean) => wrap((d) => d.gitDiff(dir, path, staged)),
  gitAdd: (dir: string, paths?: string[]) => wrap((d) => d.gitAdd(dir, paths)),
  gitUnstage: (dir: string, paths: string[]) => wrap((d) => d.gitUnstage(dir, paths)),
  gitCommit: (dir: string, message: string) => wrap((d) => d.gitCommit(dir, message)),
  gitPull: (dir: string) => wrap((d) => d.gitPull(dir)),
  gitFetch: (dir: string) => wrap((d) => d.gitFetch(dir)),
  gitPush: (dir: string) => wrap((d) => d.gitPush(dir)),
  gitDiscard: (dir: string, paths: string[]) => wrap((d) => d.gitDiscard(dir, paths)),
  pickParentDir: () => wrap((d) => d.pickParentDir()),

  // 记忆（分层记忆系统 P1）
  memoryList: (projectRoot: string | null, includeArchived?: boolean) =>
    wrap((d) => d.memoryList(projectRoot, includeArchived)) as Promise<{ items: MemoryItem[] }>,
  memorySearch: (query: string, projectRoot: string | null, topK?: number, includeArchived?: boolean) =>
    wrap((d) => d.memorySearch(query, projectRoot, topK, includeArchived)) as Promise<{ hits: MemoryHit[]; degraded: boolean }>,
  memoryUpdate: (id: string, patch: { title?: string; content?: string; category?: string; importance?: number }) =>
    wrap((d) => d.memoryUpdate(id, patch)) as Promise<MemoryItem>,
  memoryDelete: (id: string) => wrap((d) => d.memoryDelete(id)),
  memoryMoveScope: (id: string, target: 'project' | 'user', projectRoot?: string) =>
    wrap((d) => d.memoryMoveScope(id, target, projectRoot)) as Promise<MemoryItem>,
  memoryClear: (scope: 'project' | 'global' | 'all', projectRoot?: string) =>
    wrap((d) => d.memoryClear(scope, projectRoot)),
  memoryStats: () => wrap((d) => d.memoryStats()) as Promise<MemoryStats>,
  // 记忆管线 P2
  memorySessionContext: (projectRoot: string, sessionId: string) =>
    wrap((d) => d.memorySessionContext(projectRoot, sessionId)) as Promise<{ summary: string | null }>,
  memoryMaybeExtract: (projectRoot: string, sessionId: string) =>
    wrap((d) => d.memoryMaybeExtract(projectRoot, sessionId)) as Promise<void>,
  sessionEnded: (projectRoot: string, sessionId: string) =>
    wrap((d) => d.sessionEnded(projectRoot, sessionId)) as Promise<void>,
  memoryRunNow: (projectRoot: string) =>
    wrap((d) => d.memoryRunNow(projectRoot)) as Promise<{ ok: boolean; error?: string }>,
  memoryExtracting: (projectRoot: string) =>
    wrap((d) => d.memoryExtracting(projectRoot)) as Promise<boolean>,
  noteLesson: (projectRoot: string, sessionId: string, lesson: { title: string; content: string }) =>
    wrap((d) => d.noteLesson(projectRoot, sessionId, lesson)) as Promise<void>,
  // 记忆备份（P3）：导出/导入主进程弹框，取消以 ok=false + 取消文案表达
  memoryExport: (scope: 'project' | 'global' | 'all', projectRoot?: string) =>
    wrap((d) => d.memoryExport(scope, projectRoot)) as Promise<{ ok: boolean; path?: string; count?: number; error?: string }>,
  memoryImport: () =>
    wrap((d) => d.memoryImport()) as Promise<{ ok: boolean; imported?: number; skipped?: number; error?: string }>,

  // 数据存储位置
  getDataDir: () => wrap((d) => d.getDataDir()),
  selectDataDir: () => wrap((d) => d.selectDataDir()),
  migrateDataDir: (targetDir: string) => wrap((d) => d.migrateDataDir(targetDir)),

  // 窗口
  pickDirectory: () => wrap((d) => d.pickDirectory()),
  setWindowTitle: (title: string) => wrap((d) => d.setWindowTitle(title)),
  startElementPick: (url: string) => wrap((d) => d.startElementPick(url)),
  openExternal: (url: string) => wrap((d) => d.openExternal(url)),
}

// ---------- 事件订阅（main → renderer，同步返回取消函数） ----------

export function onBuildOutput(cb: (payload: { name: string; stream: 'stdout' | 'stderr'; line: string; projectRoot?: string }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onBuildOutput(cb)
}

export function onBuildExit(cb: (payload: { name: string; code: number; projectRoot?: string }) => void): () => void {
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

export function onCliToolEvent(cb: (payload: { requestId: string; id: string; name: string; phase: 'start' | 'stop'; arguments: string }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onCliToolEvent(cb)
}

export function onCliToolResult(cb: (payload: { requestId: string; id: string; content: string; isError: boolean; tokens?: { input: number; output: number } }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onCliToolResult(cb)
}

export function onCliAgentEvent(cb: (payload: CliAgentEventPayload) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onCliAgentEvent(cb)
}

export function onCliRetry(cb: (payload: { requestId: string; attempt: number; maxRetries: number; retryDelayMs: number; error: string; errorStatus: number | null }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onCliRetry(cb)
}

export function onMemoryExtractState(cb: (payload: { projectRoot: string; extracting: boolean }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onMemoryExtractState(cb)
}

/** 记忆数据变更广播：写完成后各窗口自刷新列表（渲染层单点防抖） */
export function onMemoryChanged(cb: (payload: { all: boolean; projectKeys: string[] }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onMemoryChanged(cb)
}


export function onElementPicked(cb: (payload: { selector: string; tag: string; id: string; text: string }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onElementPicked(cb)
}

export function onFsChanged(cb: (payload: { paths: string[]; projectRoot?: string }) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onFsChanged(cb)
}

export function previewSetUrl(url: string): Promise<void> {
  if (!isDesktop || !window.desktopAPI) return Promise.resolve()
  return window.desktopAPI.previewSetUrl(url)
}

export function previewBounds(rect: { x: number; y: number; width: number; height: number }): Promise<void> {
  if (!isDesktop || !window.desktopAPI) return Promise.resolve()
  return window.desktopAPI.previewBounds(rect)
}

export function previewReload(): Promise<void> {
  if (!isDesktop || !window.desktopAPI) return Promise.resolve()
  return window.desktopAPI.previewReload()
}

export function previewClearCache(): Promise<void> {
  if (!isDesktop || !window.desktopAPI) return Promise.resolve()
  return window.desktopAPI.previewClearCache()
}

export function previewDevtools(): Promise<void> {
  if (!isDesktop || !window.desktopAPI) return Promise.resolve()
  return window.desktopAPI.previewDevtools()
}

export function previewExecuteJs(code: string): Promise<unknown> {
  if (!isDesktop || !window.desktopAPI) return Promise.resolve(undefined)
  return window.desktopAPI.previewExecuteJs(code)
}

export function previewSetVisible(visible: boolean): Promise<void> {
  if (!isDesktop || !window.desktopAPI) return Promise.resolve()
  return window.desktopAPI.previewSetVisible(visible)
}

export function onPreviewConsole(cb: (payload: PreviewConsoleEntry) => void): () => void {
  if (!isDesktop || !window.desktopAPI) return () => {}
  return window.desktopAPI.onPreviewConsole(cb)
}
