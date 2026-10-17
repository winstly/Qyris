/**
 * Git 共享状态：diff 视图（GitPanel 打开 → 编辑器区域覆盖层展示）
 * + git 操作反馈（GitPanel / 文件树右键共用同一状态条，成功就地反馈不弹窗）。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'

interface GitDiffView {
  /** diff 所属仓库目录：多仓库工程下可能是子仓库，切视图必须沿用，不能退回工程根 */
  dir: string
  path: string
  /** true=暂存区 vs HEAD；false=工作区 vs 暂存区 */
  staged: boolean
  /** 未跟踪文件：工作区 diff 走 no-index 展示为新增（git diff 天然不渲染 untracked） */
  untracked?: boolean
  /** null=加载中；''=无差异；其余为 diff 正文 */
  text: string | null
}

interface GitOpState {
  label: string
  state: 'running' | 'ok' | 'fail'
  detail?: string
}

interface GitStore {
  diff: GitDiffView | null
  open: (dir: string, path: string, staged: boolean, untracked?: boolean) => Promise<void>
  /** 已打开时切换 工作区/暂存区 视图（沿用打开时记录的仓库目录） */
  switchMode: (staged: boolean) => Promise<void>
  close: () => void

  opState: GitOpState | null
  /** 操作过场弹窗：运行中不可关 → 成功/失败后用户手动关闭 */
  opDialog: GitOpState | null
  closeOpDialog: () => void
  /** git 操作统一入口：弹窗过场 + 状态条反馈 + 失败弹窗详情；调用方在 fn 内自行业务刷新 */
  runOp: (label: string, fn: () => Promise<string | void>) => Promise<void>
}

export const useGitStore = create<GitStore>()((set, get) => ({
  diff: null,

  open: async (dir, path, staged, untracked) => {
    // 同一视图形状在挂载/成功/失败三处复用，收敛成一个构造器（untracked 展开只写一次）
    const view = (text: string | null): GitDiffView =>
      ({ dir, path, staged, ...(untracked ? { untracked: true } : {}), text })
    set({ diff: view(null) })
    try {
      const text = await api.gitDiff(dir, path, staged, untracked)
      // 竞态防护：请求期间用户已切换目标/模式时丢弃过期结果
      set((s) =>
        s.diff && s.diff.dir === dir && s.diff.path === path && s.diff.staged === staged
          ? { diff: view(text) }
          : s,
      )
    } catch (e) {
      set((s) =>
        s.diff && s.diff.dir === dir && s.diff.path === path
          ? { diff: view(`加载 diff 失败：${String(e)}`) }
          : s,
      )
    }
  },

  switchMode: async (staged) => {
    const cur = get().diff
    if (!cur) return
    await get().open(cur.dir, cur.path, staged, cur.untracked)
  },

  close: () => set({ diff: null }),

  opState: null,
  opDialog: null,
  closeOpDialog: () => set({ opDialog: null }),

  runOp: async (label, fn) => {
    set({ opState: { label, state: 'running' }, opDialog: { label, state: 'running' } })
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
    }
  },
}))
