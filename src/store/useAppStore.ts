/**
 * 全局应用状态：Tab、面板比例、当前项目、设置、内联对话框（prompt/confirm）。
 * UI 偏好经 localStorage 持久化；业务配置经后端 config.json 持久化。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, isDesktop } from '@/services/desktop'
import { SECRET_KEY } from '@/services/ai'
import { basename } from '@/utils/path'
import { useFileStore } from './useFileStore'
import { useBuildStore } from './useBuildStore'
import { useChatStore } from './useChatStore'
import { useAgentStore } from './useAgentStore'
import type { AiSettings, ChatMessage, RecentProject, SkillMeta, StartCommand, TreeNode } from '@/types'

// ---------- 文件 store 快照（多工程常驻：切换时 checkpoint/restore 当前工程的打开文件/展开态） ----------

interface FileSnapshot {
  childrenMap: Record<string, TreeNode[]>
  expanded: Record<string, true>
  openTabs: string[]
  activePath: string | null
  contents: Record<string, string>
  dirty: Record<string, true>
  binaryFiles: Record<string, true>
  truncatedFiles: Record<string, true>
  cursor: { line: number; col: number }
  snapshots: Record<string, { ts: number; sessionId: string }>
  clipboard: { srcPath: string; mode: 'cut' | 'copy' } | null
}

const fileSnapshots = new Map<string, FileSnapshot>()

function checkpointFileStore(projectPath: string): void {
  const fs = useFileStore.getState()
  fileSnapshots.set(projectPath, {
    childrenMap: fs.childrenMap,
    expanded: fs.expanded,
    openTabs: fs.openTabs,
    activePath: fs.activePath,
    contents: fs.contents,
    dirty: fs.dirty,
    binaryFiles: fs.binaryFiles,
    truncatedFiles: fs.truncatedFiles,
    cursor: fs.cursor,
    snapshots: fs.snapshots,
    clipboard: fs.clipboard,
  })
}

export interface DialogCheck {
  id: string
  label: string
  checked?: boolean
}

export interface DialogChoice {
  id: string
  label: string
  variant?: 'primary' | 'ghost' | 'danger'
}

export interface DialogRequest {
  kind: 'prompt' | 'confirm' | 'alert' | 'choice'
  title: string
  message?: string
  value?: string
  checks?: DialogCheck[]
  /** 多选项模式（kind='choice' 时渲染为多个按钮） */
  choices?: DialogChoice[]
  /** true = 点确定后不立即关闭：进入 loading 态，等调用方 closeDialog()（异步任务完成后再关） */
  holdOpen?: boolean
  /** holdOpen 期间确定按钮的文案（如「删除中…」） */
  confirmingText?: string
  resolve: (v: string | boolean | null | { confirmed: boolean; checks: Record<string, boolean> }) => void
}

export const DEFAULT_SETTINGS: AiSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  provider: 'openai',
  dispatchMode: 'api',
  cliPermission: 'auto',
}

export type Theme = 'system' | 'light' | 'dark'

interface AppState {
  booted: boolean
  activeTab: 'preview' | 'files' | 'projects'
  /** 工作区占宽比例（拖拽分割线调节，工作区 ≥ 500px / 对话栏 ≥ 300px 由组件层钳制） */
  splitRatio: number
  /** 文件 Tab 内文件树占比 */
  filesSplitRatio: number
  /** 文件 Tab 内 Git 工作区面板高度占左栏比例 */
  gitPanelRatio: number

  projectPath: string | null
  projectName: string
  settingsOpen: boolean
  createProjectOpen: boolean
  settings: AiSettings
  hasApiKey: boolean
  dialog: DialogRequest | null
  /** 主题偏好：system 跟随系统（白天浅/晚上深）、light、dark */
  theme: Theme
  /** 历史工程列表 */
  recentProjects: RecentProject[]
  /** 当前打开工程工作集（本次会话常驻） */
  openProjects: string[]
  /** Skills 目录列表（按序扫描，同名取首个） */
  skillsDirs: string[]
  /** 已扫描的 skill 摘要列表 */
  skillMetas: SkillMeta[]
  /** 当前项目已识别的启动命令（AI 编译产出，「全部运行」直接执行，零模型） */
  startupCommands: StartCommand[]
  /** 全部项目的启动命令存档（内存缓存，落盘走 config.json） */
  startupCommandsMap: Record<string, StartCommand[]>

  setTab: (t: 'preview' | 'files' | 'projects') => void
  setSplitRatio: (r: number) => void
  setFilesSplitRatio: (r: number) => void
  setGitPanelRatio: (r: number) => void
  setSettingsOpen: (open: boolean) => void
  setCreateProjectOpen: (open: boolean) => void
  setTheme: (theme: Theme) => void
  saveSettings: (s: AiSettings) => Promise<void>
  refreshHasApiKey: () => Promise<void>
  boot: () => Promise<void>
  openProjectDialog: () => Promise<void>
  openProject: (path: string) => Promise<void>
  removeRecentProject: (path: string) => void
  setSkillsDirs: (dirs: string[]) => void
  loadSkills: () => Promise<void>
  /** 覆盖某项目的启动命令存档（AI 编译结果 / run_project 沉淀），projectPath 缺省取当前工程；同步落盘 */
  setStartupCommands: (cmds: StartCommand[], projectPath?: string) => Promise<void>
  /** 切换到指定工程（驻留：不杀其他工程的进程/文件态） */
  openProjectWithChoice: (projectPath: string) => Promise<void>
  /** 关闭工程：停其服务/watcher，从工作集移除 */
  closeProject: (projectPath: string) => Promise<void>
  /** 项目文件删除后清空该路径的启动命令存档（防止同路径重建项目时旧命令复活） */
  clearStartupCommands: (projectPath: string) => Promise<void>
  showPrompt: (title: string, value?: string) => Promise<string | null>
  showConfirm: (title: string, message?: string, checks?: DialogCheck[], opts?: { holdOpen?: boolean; confirmingText?: string }) => Promise<boolean | { confirmed: boolean; checks: Record<string, boolean> }>
  showAlert: (title: string, message?: string) => Promise<void>
  /** 多选项对话框：返回被选中的 choice id，取消返回 null */
  showChoices: (title: string, message: string, choices: DialogChoice[]) => Promise<string | null>
  resolveDialog: (v: string | boolean | null | { confirmed: boolean; checks: Record<string, boolean> }) => void
  /** 直接关闭当前对话框（不触发 resolve）。holdOpen 异步任务完成后由调用方调用 */
  closeDialog: () => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      booted: false,
      activeTab: 'preview',
      splitRatio: 0.74,
      filesSplitRatio: 0.26,
      gitPanelRatio: 0.45,
      projectPath: null,
      projectName: '',
      settingsOpen: false,
      createProjectOpen: false,
      settings: DEFAULT_SETTINGS,
      hasApiKey: false,
      dialog: null,
      theme: 'system',
      recentProjects: [],
      openProjects: [],
      skillsDirs: [],
      skillMetas: [],
      startupCommands: [],
      startupCommandsMap: {},

      setTab: (t) => set({ activeTab: t }),
      setSplitRatio: (r) => set({ splitRatio: Math.min(0.85, Math.max(0.5, r)) }),
      setFilesSplitRatio: (r) => set({ filesSplitRatio: Math.min(0.5, Math.max(0.15, r)) }),
      setGitPanelRatio: (r) => set({ gitPanelRatio: Math.min(0.75, Math.max(0.2, r)) }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setCreateProjectOpen: (open) => set({ createProjectOpen: open }),
      setTheme: (theme) => set({ theme }),

      saveSettings: async (s) => {
        set({ settings: s })
        if (!isDesktop) return
        try {
          await api.mergeConfig({
            aiBaseUrl: s.baseUrl, aiModel: s.model, aiProvider: s.provider, aiTiers: s.tiers,
            aiDispatchMode: s.dispatchMode, aiCliPermission: s.cliPermission,
          })
        } catch { /* 配置盘写失败不阻塞界面 */ }
      },

      refreshHasApiKey: async () => {
        if (!isDesktop) return
        try {
          set({ hasApiKey: await api.hasSecret(SECRET_KEY) })
        } catch { /* keychain 不可用时不阻塞 */ }
      },

      boot: async () => {
        if (!isDesktop) {
          set({ booted: true })
          return
        }
        try {
          const cfg = await api.getConfig()
          set({
            settings: {
              baseUrl: cfg.aiBaseUrl || DEFAULT_SETTINGS.baseUrl,
              model: cfg.aiModel || DEFAULT_SETTINGS.model,
              provider: cfg.aiProvider || DEFAULT_SETTINGS.provider,
              dispatchMode: cfg.aiDispatchMode ?? DEFAULT_SETTINGS.dispatchMode,
              cliPermission: cfg.aiCliPermission ?? DEFAULT_SETTINGS.cliPermission,
              tiers: cfg.aiTiers,
            },
            recentProjects: cfg.recentProjects ?? [],
            skillsDirs: cfg.skillsDirs ?? [],
            startupCommandsMap: cfg.startupCommands ?? {},
          })
          // 扫描 skills 目录（异步，不阻塞启动）
          if ((cfg.skillsDirs ?? []).length > 0) {
            void get().loadSkills()
          }
          // 旧单目录字段一次性迁移
          if (cfg.skillsDir) {
            void api.mergeConfig({ skillsDirs: cfg.skillsDirs ?? [], skillsDir: null }).catch(() => {})
          }
          // 记住上次打开的项目目录：启动时自动恢复
          if (cfg.lastProjectPath) {
            try {
              await get().openProject(cfg.lastProjectPath)
            } catch { /* 目录已失效，静默跳过 */ }
          }
        } finally {
          await get().refreshHasApiKey()
          set({ booted: true })
        }
      },

      openProjectDialog: async () => {
        if (!isDesktop) return
        const picked = await api.pickDirectory()
        if (typeof picked === 'string') {
          try {
            await get().openProjectWithChoice(picked)
          } catch (e) {
            console.error('打开项目失败：', e)
            void get().showAlert('无法打开项目', String(e))
          }
        }
      },

      openProject: async (projectPath) => {
        // 校验目录可读（失败抛错给调用方）
        await api.listDir(projectPath, projectPath)

        const prevPath = get().projectPath
        // 切走前：快照当前工程的文件态（打开文件/展开/内容），下次切回秒恢复
        if (prevPath && prevPath !== projectPath) {
          checkpointFileStore(prevPath)
        }

        // 先同步切 current 镜像（build/chat/agent）+ projectPath，再 await 文件树加载——
        // 避免「projectPath 已变、current 未变」的窗口期里预览/启动读到旧工程（串工程事故源）
        const chatNeedsRestore = !useChatStore.getState().byProject[projectPath]
        useBuildStore.getState().ensureProject(projectPath)
        useBuildStore.getState().setCurrent(projectPath)
        useChatStore.getState().ensureProject(projectPath)
        useAgentStore.getState().ensureProject(projectPath)
        useAgentStore.getState().setCurrent(projectPath)
        set({ projectPath: projectPath, projectName: basename(projectPath), startupCommands: get().startupCommandsMap[projectPath] ?? [] })

        // 文件态：有快照则恢复，否则全新初始化
        const snap = fileSnapshots.get(projectPath)
        if (snap) {
          useFileStore.setState({
            rootPath: projectPath, loadingDirs: {}, savingPath: null, lastSavedAt: null, ...snap,
          })
          // 恢复后刷新已展开目录，同步离开期间的后台变更
          void useFileStore.getState().refreshExpanded()
        } else {
          await useFileStore.getState().openProject(projectPath)
          checkpointFileStore(projectPath)
        }

        // 构建态：进程由主进程按工程隔离，切走不停；订阅该工程文件变更
        await api.startWatching(projectPath)

        // 对话：已驻留（含在途流）不覆盖、从磁盘恢复仅首次
        if (chatNeedsRestore) {
          try {
            const history = await api.loadSession(projectPath)
            if (history && history.length) {
              useChatStore.getState().restore(history as ChatMessage[])
            } else {
              useChatStore.getState().clear()
            }
          } catch { /* 会话加载失败忽略 */ }
        }

        // 更新历史工程列表：插入头部、去重、截断 20 条
        const now = Date.now()
        const prev = get().recentProjects.filter((p) => p.path !== projectPath)
        const updated: RecentProject[] = [
          { path: projectPath, name: basename(projectPath), lastOpened: now },
          ...prev,
        ].slice(0, 20)
        const openProjects = get().openProjects.includes(projectPath)
          ? get().openProjects
          : [...get().openProjects, projectPath]
        set({ recentProjects: updated, openProjects })

        try {
          await api.mergeConfig({ lastProjectPath: projectPath, recentProjects: updated })
        } catch { /* 忽略配置写失败 */ }

        // 窗口标题显示当前项目名
        api.setWindowTitle(`${basename(projectPath)} — 轻驭`).catch(() => {})
      },

      removeRecentProject: (projectPath) => {
        const updated = get().recentProjects.filter((p) => p.path !== projectPath)
        set({ recentProjects: updated })
        // 异步写盘，不阻塞
        void api.mergeConfig({ recentProjects: updated }).catch(() => {})
      },

      openProjectWithChoice: async (projectPath) => {
        // 单窗口模型：切换就是打开，无「新窗口」分支
        await get().openProject(projectPath)
      },

      closeProject: async (projectPath) => {
        // 任务状态确认：有运行中的服务 或 在途对话 → 提示关闭会取消/停止
        const buildSlice = useBuildStore.getState().byProject[projectPath]
        const hasRunning = buildSlice ? Object.values(buildSlice.slots).some((s) => s.processAlive) : false
        const chatSlice = useChatStore.getState().byProject[projectPath]
        const hasActiveChat = chatSlice ? (chatSlice.status !== 'idle' && chatSlice.status !== 'error') : false
        if (hasRunning || hasActiveChat) {
          const parts: string[] = []
          if (hasRunning) parts.push('有服务正在运行')
          if (hasActiveChat) parts.push('有对话正在进行')
          const confirmed = await get().showConfirm(
            '关闭项目',
            `「${basename(projectPath)}」${parts.join('、')}。关闭将取消对话并停止服务，确定继续？`,
          )
          if (!confirmed) return
        }

        // 取消该工程在途对话（避免后台流继续消耗），再停服务/摘 watcher
        if (hasActiveChat) useChatStore.getState().cancelProject(projectPath)
        await api.stopProject(projectPath).catch(() => {})
        await api.stopWatchingProject(projectPath).catch(() => {})
        useBuildStore.getState().closeProject(projectPath)
        useChatStore.getState().closeProject(projectPath)
        useAgentStore.getState().closeProject(projectPath)
        fileSnapshots.delete(projectPath)

        const openProjects = get().openProjects.filter((p) => p !== projectPath)
        set({ openProjects })

        if (get().projectPath === projectPath) {
          const next = openProjects[openProjects.length - 1]
          if (next) {
            await get().openProject(next)
          } else {
            useFileStore.getState().reset()
            useAgentStore.getState().clear()
            set({ projectPath: null, projectName: '', startupCommands: [] })
            api.setWindowTitle('轻驭').catch(() => {})
          }
        }
      },

      setSkillsDirs: (dirs) => {
        // 归一化唯一入口（trim + 去空 + 去重保序）：设置面板草稿提交与此处的规则保持一致
        const clean = [...new Set(dirs.map((d) => d.trim()).filter(Boolean))]
        set({ skillsDirs: clean })
        // 异步持久化 + 重新扫描
        void api.mergeConfig({ skillsDirs: clean }).catch(() => {})
        void get().loadSkills()
      },

      setStartupCommands: async (cmds, projectPath) => {
        const p = projectPath ?? get().projectPath
        if (!p) return
        const map = { ...get().startupCommandsMap, [p]: cmds }
        const isCurrent = get().projectPath === p
        set(isCurrent ? { startupCommands: cmds, startupCommandsMap: map } : { startupCommandsMap: map })
        try {
          await api.mergeConfig({ startupCommands: map })
        } catch { /* 落盘失败不阻塞界面（内存态已更新，下次操作会再写） */ }
      },

      clearStartupCommands: async (projectPath) => {
        const map = { ...get().startupCommandsMap }
        delete map[projectPath]
        const isActive = get().projectPath === projectPath
        set(isActive ? { startupCommandsMap: map, startupCommands: [] } : { startupCommandsMap: map })
        try {
          await api.mergeConfig({ startupCommands: map })
        } catch { /* 落盘失败不阻塞界面 */ }
      },

      loadSkills: async () => {
        const dirs = get().skillsDirs
        if (!isDesktop || dirs.length === 0) {
          set({ skillMetas: [] })
          return
        }
        try {
          // 多目录按序扫描：同名 id 首个命中者优先（去重规则统一在主进程 skills.ts）
          set({ skillMetas: await api.scanSkills(dirs) })
        } catch {
          set({ skillMetas: [] })
        }
      },

      showPrompt: (title, value = '') =>
        new Promise<string | null>((resolve) => {
          set({ dialog: { kind: 'prompt', title, value, resolve: (v) => resolve(typeof v === 'string' ? v : null) } })
        }),

      showConfirm: (title, message, checks, opts) =>
        new Promise<boolean | { confirmed: boolean; checks: Record<string, boolean> }>((resolve) => {
          if (checks?.length) {
            set({
              dialog: {
                kind: 'confirm', title, message, checks,
                holdOpen: opts?.holdOpen, confirmingText: opts?.confirmingText,
                resolve: (v) => resolve(v as { confirmed: boolean; checks: Record<string, boolean> }),
              },
            })
          } else {
            set({ dialog: { kind: 'confirm', title, message, resolve: (v) => resolve(v === true) } })
          }
        }),

      showAlert: (title, message) =>
        new Promise<void>((resolve) => {
          set({ dialog: { kind: 'alert', title, message, resolve: () => resolve() } })
        }),

      showChoices: (title, message, choices) =>
        new Promise<string | null>((resolve) => {
          set({ dialog: { kind: 'choice', title, message, choices, resolve: (v) => resolve(typeof v === 'string' ? v : null) } })
        }),

      resolveDialog: (v) => {
        const d = get().dialog
        set({ dialog: null })
        d?.resolve(v)
      },

      closeDialog: () => set({ dialog: null }),
    }),
    {
      name: 'fw-ui',
      partialize: (s) => ({
        activeTab: s.activeTab,
        splitRatio: s.splitRatio,
        filesSplitRatio: s.filesSplitRatio,
        gitPanelRatio: s.gitPanelRatio,
        theme: s.theme,
      }),
    },
  ),
)
