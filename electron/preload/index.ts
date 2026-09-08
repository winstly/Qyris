/**
 * 渲染层唯一暴露面：逐方法白名单（无通用 invoke 透传、无 shell/fs 原生能力），
 * 能力边界与原 Tauri capabilities/default.json 对齐。
 * 沙箱兼容：仅使用 ipcRenderer / contextBridge（沙箱白名单 API），不引第三方。
 * 注意：不暴露 getSecret —— API Key 明文不出主进程。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
// 仅类型引入（构建时擦除，不违反沙箱不引第三方约束）
import type { MessagesPage, MessagesRecentPage } from '../lib/messages'
import type { MemoryItem, MemoryPatch, MemorySearchResult, MemoryStats } from '../lib/memory/service'

type Unsubscribe = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

const desktopAPI = {
  // 文件系统
  listDir: (projectRoot: string, dir: string) => ipcRenderer.invoke('list_dir', { projectRoot, dir }),
  searchFiles: (projectRoot: string, query: string) =>
    ipcRenderer.invoke('search_files', { projectRoot, query }) as Promise<{ files: string[]; truncated: boolean }>,
  readTextFile: (projectRoot: string, filePath: string) => ipcRenderer.invoke('read_text_file', { projectRoot, path: filePath }),
  writeTextFile: (projectRoot: string, filePath: string, content: string) => ipcRenderer.invoke('write_text_file', { projectRoot, path: filePath, content }),
  snapshotFile: (projectRoot: string, sessionId: string, path: string) => ipcRenderer.invoke('snapshot_file', { projectRoot, sessionId, path }),
  listSnapshots: (projectRoot: string) =>
    ipcRenderer.invoke('list_snapshots', { projectRoot }) as Promise<Record<string, { ts: number; sessionId: string }>>,
  restoreFile: (projectRoot: string, path: string) => ipcRenderer.invoke('restore_file', { projectRoot, path }),
  restoreSession: (projectRoot: string, sessionId: string) =>
    ipcRenderer.invoke('restore_session', { projectRoot, sessionId }) as Promise<number>,
  clearProjectSnapshots: (projectRoot: string) => ipcRenderer.invoke('clear_project_snapshots', { projectRoot }),
  // 会话消息持久化（SQLite；载荷类型与 electron/lib/messages 对齐）
  messagesRecent: (projectRoot: string, limit?: number) =>
    ipcRenderer.invoke('messages_recent', { projectRoot, limit: limit ?? null }) as Promise<MessagesRecentPage>,
  messagesBefore: (projectRoot: string, sessionId: string, beforeSeq: number, limit?: number) =>
    ipcRenderer.invoke('messages_before', { projectRoot, sessionId, beforeSeq, limit: limit ?? null }) as Promise<MessagesPage>,
  messageAppend: (projectRoot: string, sessionId: string, message: unknown) =>
    ipcRenderer.invoke('message_append', { projectRoot, sessionId, message }) as Promise<{ seq: number }>,
  messagePatch: (projectRoot: string, sessionId: string, id: string, patch: unknown) =>
    ipcRenderer.invoke('message_patch', { projectRoot, sessionId, id, patch }) as Promise<void>,
  messagesTruncate: (projectRoot: string, sessionId: string, afterSeq: number) =>
    ipcRenderer.invoke('messages_truncate', { projectRoot, sessionId, afterSeq }) as Promise<void>,
  projectDataDelete: (projectRoot: string) =>
    ipcRenderer.invoke('project_data_delete', { projectRoot }) as Promise<void>,
  saveSessionTokens: (projectRoot: string, sessionId: string, tokens: { input: number; output: number }) =>
    ipcRenderer.invoke('save_session_tokens', { projectRoot, sessionId, tokens }) as Promise<void>,
  loadSessionTokens: (projectRoot: string, sessionId: string) =>
    ipcRenderer.invoke('load_session_tokens', { projectRoot, sessionId }) as Promise<{ input: number; output: number }>,
  // 记忆（检索底座；载荷类型与 electron/lib/memory/service 对齐）
  memoryList: (projectRoot: string, includeArchived?: boolean) =>
    ipcRenderer.invoke('memory_list', { projectRoot, includeArchived: includeArchived === true }) as Promise<{ items: MemoryItem[] }>,
  memorySearch: (query: string, projectRoot: string, topK?: number, includeArchived?: boolean) =>
    ipcRenderer.invoke('memory_search', { query, projectRoot, topK: topK ?? null, includeArchived: includeArchived === true }) as Promise<MemorySearchResult>,
  memoryUpdate: (id: string, patch: MemoryPatch) =>
    ipcRenderer.invoke('memory_update', { id, patch }) as Promise<MemoryItem>,
  memoryDelete: (id: string) => ipcRenderer.invoke('memory_delete', { id }) as Promise<void>,
  memoryMoveScope: (id: string, target: 'project' | 'user', projectRoot?: string) =>
    ipcRenderer.invoke('memory_move_scope', { id, target, projectRoot: projectRoot ?? null }) as Promise<MemoryItem>,
  memoryClear: (scope: 'project' | 'global' | 'all', projectRoot?: string) =>
    ipcRenderer.invoke('memory_clear', { scope, projectRoot: projectRoot ?? null }) as Promise<void>,
  memoryStats: () => ipcRenderer.invoke('memory_stats') as Promise<MemoryStats>,
  // mem agent（P2 记忆蒸馏管线；载荷类型与 electron/lib/memory/agent + service 对齐）
  memorySessionContext: (projectRoot: string, sessionId: string) =>
    ipcRenderer.invoke('memory_session_context', { projectRoot, sessionId }) as Promise<{ summary: string | null }>,
  /** 每轮 assistant 收尾后调用；阈值/冷却不满足时主进程空返回（fire-and-forget 语义） */
  memoryMaybeExtract: (projectRoot: string, sessionId: string) =>
    ipcRenderer.invoke('memory_maybe_extract', { projectRoot, sessionId }) as Promise<void>,
  /** clear() 开新会话时调用：收尾提取 + 晋升判断 */
  sessionEnded: (projectRoot: string, sessionId: string) =>
    ipcRenderer.invoke('session_ended', { projectRoot, sessionId }) as Promise<void>,
  /** 记忆面板「立即整理」：无视冷却的增量提取（仍防并发） */
  memoryRunNow: (projectRoot: string) =>
    ipcRenderer.invoke('memory_run_now', { projectRoot }) as Promise<{ ok: boolean; error?: string }>,
  /** 该工程是否正在整理记忆（主进程 mem agent 排队/执行中） */
  memoryExtracting: (projectRoot: string) =>
    ipcRenderer.invoke('memory_extracting', { projectRoot }) as Promise<boolean>,
  /** build 状态机 / run_once 等落教训：同工程同 title 去重强化 */
  noteLesson: (projectRoot: string, sessionId: string, lesson: { title: string; content: string }) =>
    ipcRenderer.invoke('note_lesson', { projectRoot, sessionId, lesson }) as Promise<void>,
  // 记忆备份（P3）：导出/导入的弹框与文件 IO 都在主进程
  memoryExport: (scope: 'project' | 'global' | 'all', projectRoot?: string) =>
    ipcRenderer.invoke('memory_export', { scope, projectRoot: projectRoot ?? null }) as Promise<{ ok: boolean; path?: string; count?: number; error?: string }>,
  memoryImport: () =>
    ipcRenderer.invoke('memory_import') as Promise<{ ok: boolean; imported?: number; skipped?: number; error?: string }>,
  // 存储位置（设置项：当前路径显示 / 选择目录 + 迁移）
  getDataDir: () => ipcRenderer.invoke('get_data_dir') as Promise<string>,
  selectDataDir: () => ipcRenderer.invoke('select_data_dir') as Promise<string | null>,
  migrateDataDir: (dir: string) =>
    ipcRenderer.invoke('migrate_data_dir', { dir }) as Promise<{ ok: boolean; error?: string }>,
  createEntry: (projectRoot: string, parentDir: string, name: string, isDir: boolean) => ipcRenderer.invoke('create_entry', { projectRoot, parentDir, name, isDir }),
  renameEntry: (projectRoot: string, filePath: string, newName: string) => ipcRenderer.invoke('rename_entry', { projectRoot, path: filePath, newName }),
  deleteEntry: (projectRoot: string, filePath: string) => ipcRenderer.invoke('delete_entry', { projectRoot, path: filePath }),
  copyEntry: (projectRoot: string, srcPath: string, destDir: string) => ipcRenderer.invoke('copy_entry', { projectRoot, srcPath, destDir }),
  moveEntry: (projectRoot: string, srcPath: string, destDir: string) => ipcRenderer.invoke('move_entry', { projectRoot, srcPath, destDir }),
  deleteProjectFiles: (projectRoot: string) => ipcRenderer.invoke('delete_project_files', { projectRoot }),

  // 子进程 / watcher
  runProject: (projectRoot: string, name: string, command: string) =>
    ipcRenderer.invoke('run_project', { projectRoot, name, command }),
  runOnce: (projectRoot: string, command: string, token?: string) =>
    ipcRenderer.invoke('run_once', { projectRoot, command, token: token ?? null }) as Promise<{ code: number | null; output: string }>,
  runOnceCancel: (token?: string) =>
    ipcRenderer.invoke('run_once_cancel', { token: token ?? null }) as Promise<number>,
  checkUrl: (url: string) => ipcRenderer.invoke('check_url', { url }) as Promise<boolean>,
  portOwner: (port: number) =>
    ipcRenderer.invoke('port_owner', { port }) as Promise<{ pid: number; name: string } | null>,
  previewConsoleAttach: (url: string | null) => ipcRenderer.invoke('preview_console_attach', { url: url ?? null }),
  previewSetUrl: (url: string) => ipcRenderer.invoke('preview_set_url', { url }) as Promise<void>,
  previewBounds: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('preview_bounds', rect) as Promise<void>,
  previewReload: () => ipcRenderer.invoke('preview_reload') as Promise<void>,
  previewClearCache: () => ipcRenderer.invoke('preview_clear_cache') as Promise<void>,
  previewDevtools: () => ipcRenderer.invoke('preview_devtools') as Promise<void>,
  previewExecuteJs: (code: string) => ipcRenderer.invoke('preview_execute_js', { code }) as Promise<unknown>,
  previewSetVisible: (visible: boolean) => ipcRenderer.invoke('preview_visible', { visible }) as Promise<void>,
  previewConsoleHistory: () =>
    ipcRenderer.invoke('preview_console_history') as Promise<{ level: string; message: string; sourceId: string; ts: number }[]>,
  stopProject: (projectRoot?: string | null, name?: string | null) => ipcRenderer.invoke('stop_project', { projectRoot: projectRoot ?? null, name: name ?? null }),
  startWatching: (projectRoot: string) => ipcRenderer.invoke('start_watching', { projectRoot }),
  stopWatching: () => ipcRenderer.invoke('stop_watching'),
  stopWatchingProject: (projectRoot: string) => ipcRenderer.invoke('stop_watching_project', { projectRoot }),

  // 配置与密钥
  getConfig: () => ipcRenderer.invoke('get_config'),
  mergeConfig: (patch: unknown) => ipcRenderer.invoke('merge_config', { patch }),
  setSecret: (key: string, value: string) => ipcRenderer.invoke('set_secret', { key, value }),
  hasSecret: (key: string) => ipcRenderer.invoke('has_secret', { key }),
  deleteSecret: (key: string) => ipcRenderer.invoke('delete_secret', { key }),

  // Skills 目录
  scanSkills: (dirs: string[]) => ipcRenderer.invoke('scan_skills', { dirs }) as Promise<{ id: string; name: string; description: string; triggers: string[] }[]>,
  readSkill: (dirs: string[], skillId: string) => ipcRenderer.invoke('read_skill', { dirs, skillId }) as Promise<string | null>,
  pickSkillsDir: () => ipcRenderer.invoke('pick_skills_dir') as Promise<string | null>,

  // 创建项目 / Git
  createEmptyProject: (parentDir: string, name: string) => ipcRenderer.invoke('create_empty_project', { parentDir, name }) as Promise<string>,
  cloneRepos: (parentDir: string, repos: { url: string; branch?: string }[]) => ipcRenderer.invoke('clone_repos', { parentDir, repos }) as Promise<string[]>,
  testRepo: (url: string) =>
    ipcRenderer.invoke('test_repo', { url }) as Promise<{ valid: boolean; branches: string[]; error: string | null }>,
  gitRepoInfo: (dir: string) =>
    ipcRenderer.invoke('git_repo_info', { dir }) as Promise<{ isRepo: boolean; currentBranch: string | null; branches: string[] }>,
  gitCheckout: (dir: string, branch: string) => ipcRenderer.invoke('git_checkout', { dir, branch }),
  gitStatus: (dir: string) => ipcRenderer.invoke('git_status', { dir }),
  gitIsRepoRoot: (dir: string) => ipcRenderer.invoke('git_is_repo_root', { dir }) as Promise<boolean>,
  gitDiff: (dir: string, path?: string, staged?: boolean) =>
    ipcRenderer.invoke('git_diff', { dir, path: path ?? null, staged: staged === true }) as Promise<string>,
  gitAdd: (dir: string, paths?: string[]) => ipcRenderer.invoke('git_add', { dir, paths: paths ?? null }),
  gitUnstage: (dir: string, paths: string[]) => ipcRenderer.invoke('git_unstage', { dir, paths }),
  gitCommit: (dir: string, message: string) => ipcRenderer.invoke('git_commit', { dir, message }) as Promise<string>,
  gitPull: (dir: string) => ipcRenderer.invoke('git_pull', { dir }) as Promise<string>,
  gitFetch: (dir: string) => ipcRenderer.invoke('git_fetch', { dir }) as Promise<string>,
  gitPush: (dir: string) => ipcRenderer.invoke('git_push', { dir }) as Promise<string>,
  gitDiscard: (dir: string, paths: string[]) => ipcRenderer.invoke('git_discard', { dir, paths }),
  pickParentDir: () => ipcRenderer.invoke('pick_parent_dir') as Promise<string | null>,

  // AI
  aiChatStream: (requestId: string, provider: string, baseUrl: string, model: string, messages: unknown, tools: unknown, dispatchMode?: string, projectRoot?: string | null, opts?: { sessionSummary?: string | null; memoryBlock?: string | null; systemPrompt?: string; outputFormat?: string }) =>
    ipcRenderer.invoke('ai_chat_stream', { requestId, provider, baseUrl, model, messages, tools, dispatchMode: dispatchMode ?? 'api', projectRoot: projectRoot ?? null, opts: opts ?? null }),
  aiTestConnection: (provider: string, baseUrl: string, model: string, dispatchMode?: string) =>
    ipcRenderer.invoke('ai_test_connection', { provider, baseUrl, model, dispatchMode: dispatchMode ?? 'api' }),
  aiCancel: (requestId: string) => ipcRenderer.invoke('ai_cancel', { requestId }),

  // 窗口
  pickDirectory: () => ipcRenderer.invoke('pick_directory'),
  setWindowTitle: (title: string) => ipcRenderer.invoke('set_window_title', { title }),
  startElementPick: (url: string) => ipcRenderer.invoke('start_element_pick', { url }),
  openExternal: (url: string) => ipcRenderer.invoke('open_external', { url }),

  // 事件（main → renderer），返回取消订阅函数
  onBuildOutput: (cb: (payload: { name: string; stream: 'stdout' | 'stderr'; line: string; projectRoot?: string }) => void): Unsubscribe =>
    subscribe('build-output', cb),
  onBuildExit: (cb: (payload: { name: string; code: number; projectRoot?: string }) => void): Unsubscribe => subscribe('build-exit', cb),
  onAiDelta: (cb: (payload: { requestId: string; delta: string }) => void): Unsubscribe =>
    subscribe('ai-delta', cb),
  onAiReasoning: (cb: (payload: { requestId: string; delta: string }) => void): Unsubscribe =>
    subscribe('ai-reasoning', cb),
  onCliToolEvent: (cb: (payload: { requestId: string; id: string; name: string; phase: 'start' | 'stop'; arguments: string }) => void): Unsubscribe =>
    subscribe('cli-tool-event', cb),
  onCliToolResult: (cb: (payload: { requestId: string; id: string; content: string; isError: boolean; tokens?: { input: number; output: number } }) => void): Unsubscribe =>
    subscribe('cli-tool-result', cb),
  // 载荷结构与 src/types 的 CliAgentEventPayload 保持一致（electron tsconfig 不含 src，故此处内联）
  onCliAgentEvent: (cb: (payload: { requestId: string; parentId: string; kind: 'text' | 'tool' | 'tool-result'; id?: string; name?: string; arguments?: string; text?: string; content?: string; isError?: boolean }) => void): Unsubscribe =>
    subscribe('cli-agent-event', cb),
  onMemoryExtractState: (cb: (payload: { projectRoot: string; extracting: boolean }) => void): Unsubscribe =>
    subscribe('memory-extract-state', cb),
  onMemoryChanged: (cb: (payload: { all: boolean; projectKeys: string[] }) => void): Unsubscribe =>
    subscribe('memory-changed', cb),
  onFsChanged: (cb: (payload: { paths: string[]; projectRoot?: string }) => void): Unsubscribe => subscribe('fs-changed', cb),
  onElementPicked: (cb: (payload: { selector: string; tag: string; id: string; text: string }) => void): Unsubscribe => subscribe('element-picked', cb),
  onPreviewConsole: (cb: (payload: { level: string; message: string; sourceId: string; ts: number }) => void): Unsubscribe =>
    subscribe('preview-console', cb),
}

contextBridge.exposeInMainWorld('desktopAPI', desktopAPI)

export type DesktopAPI = typeof desktopAPI
