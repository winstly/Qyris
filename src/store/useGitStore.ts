/**
 * Git 共享状态：diff 视图（GitPanel 打开 → 编辑器区域覆盖层展示）
 * + git 操作反馈（GitPanel / 文件树右键共用同一状态条，成功就地反馈不弹窗）。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'

export interface GitDiffView {
  path: string
  /** true=暂存区 vs HEAD；false=工作区 vs 暂存区 */
  staged: boolean
  /** null=加载中；''=无差异；其余为 diff 正文 */
  text: string | null
}

export interface GitOpState {
  label: string
  state: 'running' | 'ok' | 'fail'
  detail?: string
}

interface GitStore {
  diff: GitDiffView | null
  open: (rootPath: string, path: string, staged: boolean) => Promise<void>
  /** 已打开时切换 工作区/暂存区 视图 */
  switchMode: (rootPath: string, staged: boolean) => Promise<void>
  close: () => void

  opState: GitOpState | null
  runningOp: string | null
  /** 操作过场弹窗：运行中不可关 → 成功/失败后用户手动关闭 */
  opDialog: GitOpState | null
  closeOpDialog: () => void
  /** git 操作统一入口：弹窗过场 + 状态条反馈 + 失败弹窗详情；调用方在 fn 内自行业务刷新 */
  runOp: (label: string, fn: () => Promise<string | void>) => Promise<void>
}

export const useGitStore = create<GitStore>()((set, get) => ({
  diff: null,

  open: async (rootPath, path, staged) => {
    set({ diff: { path, staged, text: null } })
    try {
      const text = await api.gitDiff(rootPath, path, staged)
      // 竞态防护：请求期间用户已切换目标/模式时丢弃过期结果
      set((s) => (s.diff && s.diff.path === path && s.diff.staged === staged ? { diff: { path, staged, text } } : s))
    } catch (e) {
      set((s) => (s.diff && s.diff.path === path ? { diff: { path, staged, text: `加载 diff 失败：${String(e)}` } } : s))
    }
  },

  switchMode: async (rootPath, staged) => {
    const cur = get().diff
    if (!cur) return
    await get().open(rootPath, cur.path, staged)
  },

  close: () => set({ diff: null }),

  opState: null,
  runningOp: null,
  opDialog: null,
  closeOpDialog: () => set({ opDialog: null }),

  runOp: async (label, fn) => {
    set({ runningOp: label, opState: { label, state: 'running' }, opDialog: { label, state: 'running' } })
    try {
      const out = await fn()
      const detail = typeof out === 'string' ? out.trim() || undefined : undefined
      // 成功就地反馈（输出首行进状态条，全文悬停可见），失败弹窗展示详情
      set({ opState: { label, state: 'ok', detail }, opDialog: { label, state: 'ok', detail } })
    } catch (e) {
      set({
        opState: { label, state: 'fail', detail: String(e) },
        opDialog: { label, state: 'fail', detail: String(e) },
      })
    } finally {
      set({ runningOp: null })
    }
  },
}))
