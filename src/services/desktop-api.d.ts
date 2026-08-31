/**
 * window.desktopAPI 全局类型声明（与 electron/preload/index.ts 的暴露面一一对应）。
 * 接口整体放在 declare global 内，使 DesktopAPI 与 Window.desktopAPI 均为全局可见；
 * 刻意内联声明而非跨包 import，保持渲染层类型不依赖 electron 命名空间。
 */
declare global {
  interface DesktopEventSub<T> {
    (cb: (payload: T) => void): () => void
  }

  interface DesktopAPI {
    // 文件系统
    listDir: (projectRoot: string, dir: string) => Promise<TreeNode[]>
    searchFiles: (projectRoot: string, query: string) => Promise<{ files: string[]; truncated: boolean }>
    readTextFile: (projectRoot: string, filePath: string) => Promise<FileContent>
    writeTextFile: (projectRoot: string, filePath: string, content: string) => Promise<void>
    snapshotFile: (projectRoot: string, sessionId: string, path: string) => Promise<void>
    listSnapshots: (projectRoot: string) => Promise<Record<string, { ts: number; sessionId: string }>>
    restoreFile: (projectRoot: string, path: string) => Promise<void>
    restoreSession: (projectRoot: string, sessionId: string) => Promise<number>
    clearProjectSnapshots: (projectRoot: string) => Promise<void>
    loadSession: (projectRoot: string) => Promise<unknown[] | null>
    saveSession: (projectRoot: string, messages: unknown[]) => Promise<void>
    createEntry: (projectRoot: string, parentDir: string, name: string, isDir: boolean) => Promise<TreeNode>
    renameEntry: (projectRoot: string, filePath: string, newName: string) => Promise<string>
    deleteEntry: (projectRoot: string, filePath: string) => Promise<void>
    deleteProjectFiles: (projectRoot: string) => Promise<void>

    // 子进程 / watcher
    runProject: (projectRoot: string, name: string, command: string) => Promise<number>
    runOnce: (projectRoot: string, command: string) => Promise<{ code: number | null; output: string }>
    stopProject: (name?: string) => Promise<void>
    startWatching: (projectRoot: string) => Promise<void>
    stopWatching: () => Promise<void>

    // 配置与密钥（无 getSecret）
    getConfig: () => Promise<AppConfig>
    mergeConfig: (patch: unknown) => Promise<void>
    setSecret: (key: string, value: string) => Promise<void>
    hasSecret: (key: string) => Promise<boolean>
    deleteSecret: (key: string) => Promise<void>

    // Skills 目录
    scanSkills: (dir: string) => Promise<SkillMeta[]>
    readSkill: (dir: string, skillId: string) => Promise<string | null>
    pickSkillsDir: () => Promise<string | null>

    // 创建项目 / Git
    createEmptyProject: (parentDir: string, name: string) => Promise<string>
    cloneRepos: (parentDir: string, repos: { url: string; branch?: string }[]) => Promise<string[]>
    testRepo: (url: string) => Promise<{ valid: boolean; branches: string[]; error: string | null }>
    gitRepoInfo: (dir: string) => Promise<{ isRepo: boolean; currentBranch: string | null; branches: string[] }>
    gitCheckout: (dir: string, branch: string) => Promise<void>
    pickParentDir: () => Promise<string | null>

    // AI
    aiChatStream: (requestId: string, provider: string, baseUrl: string, model: string, messages: unknown, tools: unknown) => Promise<AiCompletion>
    aiTestConnection: (provider: string, baseUrl: string, model: string) => Promise<string>
    aiCancel: (requestId: string) => Promise<void>

    // 窗口
    pickDirectory: () => Promise<string | null>
    setWindowTitle: (title: string) => Promise<void>
    startElementPick: (url: string) => Promise<void>
    openExternal: (url: string) => Promise<void>

    // 事件订阅（返回取消函数）
    onBuildOutput: DesktopEventSub<{ name: string; stream: 'stdout' | 'stderr'; line: string }>
    onBuildExit: DesktopEventSub<{ name: string; code: number }>
    onAiDelta: DesktopEventSub<{ requestId: string; delta: string }>
    onAiReasoning: DesktopEventSub<{ requestId: string; delta: string }>
    onFsChanged: DesktopEventSub<{ paths: string[] }>
  }

  interface Window {
    desktopAPI?: DesktopAPI
  }
}

export {}
