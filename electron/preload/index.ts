/**
 * 渲染层唯一暴露面：逐方法白名单（无通用 invoke 透传、无 shell/fs 原生能力），
 * 能力边界与原 Tauri capabilities/default.json 对齐。
 * 沙箱兼容：仅使用 ipcRenderer / contextBridge（沙箱白名单 API），不引第三方。
 * 注意：不暴露 getSecret —— API Key 明文不出主进程。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

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
  loadSession: (projectRoot: string) =>
    ipcRenderer.invoke('load_session', { projectRoot }) as Promise<unknown[] | null>,
  saveSession: (projectRoot: string, messages: unknown[]) =>
    ipcRenderer.invoke('save_session', { projectRoot, messages }),
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
  previewConsoleHistory: () =>
    ipcRenderer.invoke('preview_console_history') as Promise<{ level: string; message: string; sourceId: string; ts: number }[]>,
  stopProject: (name?: string) => ipcRenderer.invoke('stop_project', { name: name ?? null }),
  startWatching: (projectRoot: string) => ipcRenderer.invoke('start_watching', { projectRoot }),
  stopWatching: () => ipcRenderer.invoke('stop_watching'),

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
  aiChatStream: (requestId: string, provider: string, baseUrl: string, model: string, messages: unknown, tools: unknown, dispatchMode?: string, projectRoot?: string | null) =>
    ipcRenderer.invoke('ai_chat_stream', { requestId, provider, baseUrl, model, messages, tools, dispatchMode: dispatchMode ?? 'api', projectRoot: projectRoot ?? null }),
  aiTestConnection: (provider: string, baseUrl: string, model: string, dispatchMode?: string) =>
    ipcRenderer.invoke('ai_test_connection', { provider, baseUrl, model, dispatchMode: dispatchMode ?? 'api' }),
  aiCancel: (requestId: string) => ipcRenderer.invoke('ai_cancel', { requestId }),

  // 窗口
  pickDirectory: () => ipcRenderer.invoke('pick_directory'),
  setWindowTitle: (title: string) => ipcRenderer.invoke('set_window_title', { title }),
  startElementPick: (url: string) => ipcRenderer.invoke('start_element_pick', { url }),
  openExternal: (url: string) => ipcRenderer.invoke('open_external', { url }),

  // 事件（main → renderer），返回取消订阅函数
  onBuildOutput: (cb: (payload: { name: string; stream: 'stdout' | 'stderr'; line: string }) => void): Unsubscribe =>
    subscribe('build-output', cb),
  onBuildExit: (cb: (payload: { name: string; code: number }) => void): Unsubscribe => subscribe('build-exit', cb),
  onAiDelta: (cb: (payload: { requestId: string; delta: string }) => void): Unsubscribe =>
    subscribe('ai-delta', cb),
  onAiReasoning: (cb: (payload: { requestId: string; delta: string }) => void): Unsubscribe =>
    subscribe('ai-reasoning', cb),
  onCliToolEvent: (cb: (payload: { requestId: string; id: string; name: string; phase: 'start' | 'stop'; arguments: string }) => void): Unsubscribe =>
    subscribe('cli-tool-event', cb),
  onFsChanged: (cb: (payload: { paths: string[] }) => void): Unsubscribe => subscribe('fs-changed', cb),
  onPreviewConsole: (cb: (payload: { level: string; message: string; sourceId: string; ts: number }) => void): Unsubscribe =>
    subscribe('preview-console', cb),
}

contextBridge.exposeInMainWorld('desktopAPI', desktopAPI)

export type DesktopAPI = typeof desktopAPI
