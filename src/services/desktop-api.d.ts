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
    // 消息持久化（SQLite write-through + keyset 分页，见 useChatStore 头注释）
    messagesRecent: (projectRoot: string, limit?: number) => Promise<{ sessionId: string | null; messages: ChatMessage[]; hasMore: boolean; oldestSeq: number | null; total: number }>
    messagesBefore: (projectRoot: string, sessionId: string, beforeSeq: number, limit?: number) => Promise<{ messages: ChatMessage[]; hasMore: boolean; oldestSeq: number | null }>
    messageAppend: (projectRoot: string, sessionId: string, message: ChatMessage) => Promise<{ seq: number }>
    messagePatch: (projectRoot: string, sessionId: string, id: string, patch: { content?: string; reasoning?: string | null; tool?: { toolCalls?: ToolCall[]; toolResults?: ToolResultEntry[] }; meta?: MessageMeta | null }) => Promise<void>
    messagesTruncate: (projectRoot: string, sessionId: string, afterSeq: number) => Promise<void>
    projectDataDelete: (projectRoot: string) => Promise<void>
    saveSessionTokens: (projectRoot: string, sessionId: string, tokens: { input: number; output: number }) => Promise<void>
    loadSessionTokens: (projectRoot: string, sessionId: string) => Promise<{ input: number; output: number }>
    createEntry: (projectRoot: string, parentDir: string, name: string, isDir: boolean) => Promise<TreeNode>
    renameEntry: (projectRoot: string, filePath: string, newName: string) => Promise<string>
    deleteEntry: (projectRoot: string, filePath: string) => Promise<void>
    copyEntry: (projectRoot: string, srcPath: string, destDir: string) => Promise<TreeNode>
    moveEntry: (projectRoot: string, srcPath: string, destDir: string) => Promise<TreeNode>
    deleteProjectFiles: (projectRoot: string) => Promise<void>

    // 子进程 / watcher
    runProject: (projectRoot: string, name: string, command: string) => Promise<number>
    runOnce: (projectRoot: string, command: string, token?: string) => Promise<{ code: number | null; output: string }>
    runOnceCancel: (token?: string) => Promise<number>
    checkUrl: (url: string) => Promise<boolean>
    portOwner: (port: number) => Promise<{ pid: number; name: string } | null>
    previewConsoleAttach: (url: string | null) => Promise<void>
    previewSetUrl: (url: string) => Promise<void>
    previewBounds: (rect: { x: number; y: number; width: number; height: number }) => Promise<void>
    previewReload: () => Promise<void>
    previewClearCache: () => Promise<void>
    previewDevtools: () => Promise<void>
    previewExecuteJs: (code: string) => Promise<unknown>
    previewSetVisible: (visible: boolean) => Promise<void>
    previewConsoleHistory: () => Promise<PreviewConsoleEntry[]>
    stopProject: (projectRoot?: string | null, name?: string | null) => Promise<void>
    startWatching: (projectRoot: string) => Promise<void>
    stopWatching: () => Promise<void>
    stopWatchingProject: (projectRoot: string) => Promise<void>

    // 配置与密钥（无 getSecret）
    getConfig: () => Promise<AppConfig>
    mergeConfig: (patch: unknown) => Promise<void>
    setSecret: (key: string, value: string) => Promise<void>
    hasSecret: (key: string) => Promise<boolean>
    deleteSecret: (key: string) => Promise<void>

    // Skills 目录
    scanSkills: (dirs: string[]) => Promise<SkillMeta[]>
    readSkill: (dirs: string[], skillId: string) => Promise<string | null>
    pickSkillsDir: () => Promise<string | null>

    // 创建项目 / Git
    createEmptyProject: (parentDir: string, name: string) => Promise<string>
    cloneRepos: (parentDir: string, repos: { url: string; branch?: string }[]) => Promise<string[]>
    testRepo: (url: string) => Promise<{ valid: boolean; branches: string[]; error: string | null }>
    gitRepoInfo: (dir: string) => Promise<{ isRepo: boolean; currentBranch: string | null; branches: string[] }>
    gitCheckout: (dir: string, branch: string) => Promise<void>
    gitStatus: (dir: string) => Promise<GitStatus>
    gitIsRepoRoot: (dir: string) => Promise<boolean>
    gitDiff: (dir: string, path?: string, staged?: boolean) => Promise<string>
    gitAdd: (dir: string, paths?: string[]) => Promise<void>
    gitUnstage: (dir: string, paths: string[]) => Promise<void>
    gitCommit: (dir: string, message: string) => Promise<string>
    gitPull: (dir: string) => Promise<string>
    gitFetch: (dir: string) => Promise<string>
    gitPush: (dir: string) => Promise<string>
    gitDiscard: (dir: string, paths: string[]) => Promise<void>
    pickParentDir: () => Promise<string | null>

    // AI
    aiChatStream: (requestId: string, provider: string, baseUrl: string, model: string, messages: unknown, tools: unknown, dispatchMode?: string, projectRoot?: string | null, opts?: { sessionSummary?: string | null; memoryBlock?: string | null; systemPrompt?: string; outputFormat?: string }) => Promise<AiCompletion>
    aiTestConnection: (provider: string, baseUrl: string, model: string, dispatchMode?: string) => Promise<string>
    aiCancel: (requestId: string) => Promise<void>

    // 记忆（分层记忆系统 P1；projectRoot=null 表示仅全局）
    memoryList: (projectRoot: string | null, includeArchived?: boolean) => Promise<{ items: MemoryItem[] }>
    memorySearch: (query: string, projectRoot: string | null, topK?: number, includeArchived?: boolean) => Promise<{ hits: MemoryHit[]; degraded: boolean }>
    memoryUpdate: (id: string, patch: { title?: string; content?: string; category?: string; importance?: number }) => Promise<MemoryItem>
    memoryDelete: (id: string) => Promise<void>
    memoryMoveScope: (id: string, target: 'project' | 'user', projectRoot?: string) => Promise<MemoryItem>
    memoryClear: (scope: 'project' | 'global' | 'all', projectRoot?: string) => Promise<void>
    memoryStats: () => Promise<MemoryStats>
    // 记忆管线 P2（渲染层消费面；electron 侧由 memory 管线提供）
    /** 工作记忆会话滚动摘要（category='summary' 的 active 条目；无则 null） */
    memorySessionContext: (projectRoot: string, sessionId: string) => Promise<{ summary: string | null }>
    /** 滚动提取触发（fire-and-forget：主进程按轮数/频控决定是否真的跑） */
    memoryMaybeExtract: (projectRoot: string, sessionId: string) => Promise<void>
    /** 会话收尾提取 + 短期记忆晋升判断（clear/关工程前调用，旧 sessionId 还在手时） */
    sessionEnded: (projectRoot: string, sessionId: string) => Promise<void>
    /** 手动触发一次 mem agent 整理（记忆面板「立即整理」） */
    memoryRunNow: (projectRoot: string) => Promise<{ ok: boolean; error?: string; ops?: number }>
    /** 该工程是否正在整理记忆（主进程排队/执行中） */
    memoryExtracting: (projectRoot: string) => Promise<boolean>
    /** 教训采集：命令失败 / 服务启动失败（fire-and-forget，同会话重复由主进程去重） */
    noteLesson: (projectRoot: string, sessionId: string, lesson: { title: string; content: string }) => Promise<void>
    /** 导出记忆为 JSON 备份（主进程弹保存框；用户取消回 ok=false + 取消文案） */
    memoryExport: (scope: 'project' | 'global' | 'all', projectRoot?: string) =>
      Promise<{ ok: boolean; path?: string; count?: number; error?: string }>
    /** 从 JSON 备份导入记忆（主进程弹打开框；同 id 跳过，嵌入可能耗时秒级） */
    memoryImport: () =>
      Promise<{ ok: boolean; imported?: number; skipped?: number; error?: string }>

    // 数据存储位置（对话历史 / 记忆 / 快照所在目录）
    getDataDir: () => Promise<string>
    selectDataDir: () => Promise<string | null>
    migrateDataDir: (targetDir: string) => Promise<{ ok: boolean; error?: string }>

    // 窗口
    pickDirectory: () => Promise<string | null>
    setWindowTitle: (title: string) => Promise<void>
    startElementPick: (url: string) => Promise<void>
    openExternal: (url: string) => Promise<void>

    // 事件订阅（返回取消函数）
    onBuildOutput: DesktopEventSub<{ name: string; stream: 'stdout' | 'stderr'; line: string; projectRoot?: string }>
    onBuildExit: DesktopEventSub<{ name: string; code: number; projectRoot?: string }>
    onAiDelta: DesktopEventSub<{ requestId: string; delta: string }>
    onAiReasoning: DesktopEventSub<{ requestId: string; delta: string }>
    onCliToolEvent: DesktopEventSub<{ requestId: string; id: string; name: string; phase: 'start' | 'stop'; arguments: string }>
    onCliToolResult: DesktopEventSub<{ requestId: string; id: string; content: string; isError: boolean; tokens?: { input: number; output: number } }>
    onCliAgentEvent: DesktopEventSub<CliAgentEventPayload>
    onMemoryExtractState: DesktopEventSub<{ projectRoot: string; extracting: boolean }>
    /** 记忆数据变更广播（any 写路径完成后主进程发，all=true 表示 clear('all') 等全库变更） */
    onMemoryChanged: DesktopEventSub<{ all: boolean; projectKeys: string[] }>
    onFsChanged: DesktopEventSub<{ paths: string[]; projectRoot?: string }>
    onElementPicked: DesktopEventSub<{ selector: string; tag: string; id: string; text: string }>
    onPreviewConsole: DesktopEventSub<PreviewConsoleEntry>
  }

  interface Window {
    desktopAPI?: DesktopAPI
  }
}

export {}
