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
import type { AiSettings, ChatMessage, RecentProject, SkillMeta, StartCommand } from '@/types'

export interface DialogCheck {
  id: string
  label: string
  checked?: boolean
}

export interface DialogRequest {
  kind: 'prompt' | 'confirm' | 'alert'
  title: string
  message?: string
  value?: string
  checks?: DialogCheck[]
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
  activeTab: 'preview' | 'files' | 'history'
  /** 工作区占宽比例（拖拽分割线调节，工作区 ≥ 500px / 对话栏 ≥ 300px 由组件层钳制） */
  splitRatio: number
  /** 文件 Tab 内文件树占比 */
  filesSplitRatio: number
  /** 文件 Tab 内 Git 工作区面板高度占左栏比例 */
  gitPanelRatio: number

  projectPath: string | null
  projectName: string
  settingsOpen: boolean
  settings: AiSettings
  hasApiKey: boolean
  dialog: DialogRequest | null
  /** 主题偏好：system 跟随系统（白天浅/晚上深）、light、dark */
  theme: Theme
  /** 历史工程列表 */
  recentProjects: RecentProject[]
  /** Skills 目录列表（按序扫描，同名取首个） */
  skillsDirs: string[]
  /** 已扫描的 skill 摘要列表 */
  skillMetas: SkillMeta[]
  /** 当前项目已识别的启动命令（AI 编译产出，「全部运行」直接执行，零模型） */
  startupCommands: StartCommand[]
  /** 全部项目的启动命令存档（内存缓存，落盘走 config.json） */
  startupCommandsMap: Record<string, StartCommand[]>

  setTab: (t: 'preview' | 'files' | 'history') => void
  setSplitRatio: (r: number) => void
  setFilesSplitRatio: (r: number) => void
  setGitPanelRatio: (r: number) => void
  setSettingsOpen: (open: boolean) => void
  setTheme: (theme: Theme) => void
  saveSettings: (s: AiSettings) => Promise<void>
  refreshHasApiKey: () => Promise<void>
  boot: () => Promise<void>
  openProjectDialog: () => Promise<void>
  openProject: (path: string) => Promise<void>
  removeRecentProject: (path: string) => void
  setSkillsDirs: (dirs: string[]) => void
  loadSkills: () => Promise<void>
  /** 覆盖当前项目的启动命令存档（AI 编译结果 / run_project 沉淀），同步落盘 */
  setStartupCommands: (cmds: StartCommand[]) => Promise<void>
  /** 项目文件删除后清空该路径的启动命令存档（防止同路径重建项目时旧命令复活） */
  clearStartupCommands: (projectPath: string) => Promise<void>
  showPrompt: (title: string, value?: string) => Promise<string | null>
  showConfirm: (title: string, message?: string, checks?: DialogCheck[], opts?: { holdOpen?: boolean; confirmingText?: string }) => Promise<boolean | { confirmed: boolean; checks: Record<string, boolean> }>
  showAlert: (title: string, message?: string) => Promise<void>
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
      settings: DEFAULT_SETTINGS,
      hasApiKey: false,
      dialog: null,
      theme: 'system',
      recentProjects: [],
      skillsDirs: [],
      skillMetas: [],
      startupCommands: [],
      startupCommandsMap: {},

      setTab: (t) => set({ activeTab: t }),
      setSplitRatio: (r) => set({ splitRatio: Math.min(0.85, Math.max(0.5, r)) }),
      setFilesSplitRatio: (r) => set({ filesSplitRatio: Math.min(0.5, Math.max(0.15, r)) }),
      setGitPanelRatio: (r) => set({ gitPanelRatio: Math.min(0.75, Math.max(0.2, r)) }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
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
          // 旧单目录字段一次性迁移：并入 skillsDirs 后清空 skillsDir。
          // 不迁移的话读取侧合并会让「删除旧目录」在下次启动时复活（浅合并永远保留该字段）
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
            await get().openProject(picked)
          } catch (e) {
            console.error('打开项目失败：', e)
            void get().showAlert('无法打开项目', String(e))
          }
        }
      },

      openProject: async (projectPath) => {
        // 先校验目录可读（失败则抛错给调用方）
        await api.listDir(projectPath, projectPath)
        // 切换项目前必须清理：杀掉全部服务子进程 + 停止 watcher + 清空进程槽
        await api.stopProject().catch(() => {})
        await api.stopWatching().catch(() => {})
        useBuildStore.getState().reset()
        useAgentStore.getState().clear()

        set({ projectPath: projectPath, projectName: basename(projectPath) })
        await useFileStore.getState().openProject(projectPath)
        await api.startWatching(projectPath)
        // 换档：载入该项目的启动命令存档（无则空）
        set({ startupCommands: get().startupCommandsMap[projectPath] ?? [] })

        // 加载该项目的会话历史（有则恢复，无则清空）
        try {
          const history = await api.loadSession(projectPath)
          if (history && history.length) {
            useChatStore.getState().restore(history as ChatMessage[])
          } else {
            useChatStore.getState().clear()
          }
        } catch { /* 会话加载失败忽略 */ }

        // 更新历史工程列表：插入头部、去重、截断 20 条
        const now = Date.now()
        const prev = get().recentProjects.filter((p) => p.path !== projectPath)
        const updated: RecentProject[] = [
          { path: projectPath, name: basename(projectPath), lastOpened: now },
          ...prev,
        ].slice(0, 20)
        set({ recentProjects: updated })

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

      setSkillsDirs: (dirs) => {
        // 归一化唯一入口（trim + 去空 + 去重保序）：设置面板草稿提交与此处的规则保持一致
        const clean = [...new Set(dirs.map((d) => d.trim()).filter(Boolean))]
        set({ skillsDirs: clean })
        // 异步持久化 + 重新扫描
        void api.mergeConfig({ skillsDirs: clean }).catch(() => {})
        void get().loadSkills()
      },

      setStartupCommands: async (cmds) => {
        const projectPath = get().projectPath
        if (!projectPath) return
        const map = { ...get().startupCommandsMap, [projectPath]: cmds }
        set({ startupCommands: cmds, startupCommandsMap: map })
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
