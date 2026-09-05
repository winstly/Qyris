/**
 * 子任务 agent 状态中心：dispatch_subtasks 派发的每个子 agent 一个线程，
 * 实时记录转录（文本轮次 + 工具调用入账）。对话面板可切换查看任意 agent 的执行进度。
 * 线程数据不持久化（仅当次会话内存态），随应用退出消亡。
 *
 * 多工程常驻：状态按工程（projectPath）隔离。子 agent 的写操作显式传入所属工程，
 * 后台工程的子任务照常推进、切回时进度仍在，不会串到别的工程。
 */
import { create } from 'zustand'

export type AgentStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export interface AgentEntryText {
  kind: 'text'
  content: string
}

export interface AgentEntryTool {
  kind: 'tool'
  id: string
  name: string
  summary: string
  status: 'running' | 'done' | 'error'
}

export type AgentEntry = AgentEntryText | AgentEntryTool

export interface AgentThread {
  id: string
  /** 所属 dispatch_subtasks 工具卡片 id（用于在卡片内渲染面板） */
  cardId: string
  title: string
  tier: string
  model: string
  status: AgentStatus
  entries: AgentEntry[]
  result?: string
  startedAt: number
  finishedAt?: number
  /** 本 agent 独立消耗的 token（各轮 input/output 累计） */
  tokens: { input: number; output: number }
}

/** 单个工程的 agent 切片 */
interface AgentSlice {
  threads: Record<string, AgentThread>
  /** 创建顺序（渲染用） */
  order: string[]
  /** 对话面板当前查看的 agent 线程（null = 主对话） */
  activeThreadId: string | null
}

function emptyAgentSlice(): AgentSlice {
  return { threads: {}, order: [], activeThreadId: null }
}

interface AgentState {
  /** 当前工程（useAppStore.projectPath 的镜像） */
  current: string | null
  byProject: Record<string, AgentSlice>

  ensureProject: (path: string) => void
  setCurrent: (path: string) => void
  closeProject: (path: string) => void

  /** 一次派发创建一批线程（pending 态），返回线程 id 列表（与任务顺序对应）；project 必传（所属工程） */
  createBatch: (cardId: string, tasks: { title: string; tier: string; model: string }[], project: string) => string[]
  beginThread: (id: string, project?: string) => void
  appendText: (id: string, content: string, project?: string) => void
  appendTool: (id: string, entry: Omit<AgentEntryTool, 'kind'>, project?: string) => void
  patchTool: (id: string, toolId: string, patch: Partial<Omit<AgentEntryTool, 'kind' | 'id'>>, project?: string) => void
  finishThread: (id: string, status: 'done' | 'error' | 'cancelled', result: string, tokens?: { input: number; output: number }, project?: string) => void
  selectThread: (id: string | null) => void
  /** 清空当前工程的 agent 线程 */
  clear: () => void
}

function patchThread(slice: AgentSlice, id: string, patch: Partial<AgentThread>): Record<string, AgentThread> {
  const cur = slice.threads[id]
  if (!cur) return slice.threads
  return { ...slice.threads, [id]: { ...cur, ...patch } }
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  current: null,
  byProject: {},

  ensureProject: (path) => {
    if (get().byProject[path]) return
    set((s) => ({ byProject: { ...s.byProject, [path]: emptyAgentSlice() } }))
  },

  setCurrent: (path) => set({ current: path }),

  closeProject: (path) => {
    set((s) => {
      const byProject = { ...s.byProject }
      delete byProject[path]
      return { byProject, current: s.current === path ? null : s.current }
    })
  },

  createBatch: (cardId, tasks, project) => {
    const ids: string[] = []
    const now = Date.now()
    set((s) => {
      const slice = s.byProject[project] ?? emptyAgentSlice()
      const threads = { ...slice.threads }
      const order = [...slice.order]
      for (const t of tasks) {
        const id = `agt-${now}-${order.length}`
        ids.push(id)
        threads[id] = {
          id, cardId,
          title: t.title, tier: t.tier, model: t.model,
          status: 'pending', entries: [], startedAt: now,
          tokens: { input: 0, output: 0 },
        }
        order.push(id)
      }
      return { byProject: { ...s.byProject, [project]: { ...slice, threads, order } } }
    })
    return ids
  },

  beginThread: (id, project) => {
    const p = project ?? get().current
    if (!p) return
    set((s) => {
      const slice = s.byProject[p]
      if (!slice) return s
      return { byProject: { ...s.byProject, [p]: { ...slice, threads: patchThread(slice, id, { status: 'running', startedAt: Date.now() }) } } }
    })
  },

  appendText: (id, content, project) => {
    const p = project ?? get().current
    if (!p) return
    set((s) => {
      const slice = s.byProject[p]
      if (!slice) return s
      const cur = slice.threads[id]
      if (!cur) return s
      return { byProject: { ...s.byProject, [p]: { ...slice, threads: patchThread(slice, id, { entries: [...cur.entries, { kind: 'text', content }] }) } } }
    })
  },

  appendTool: (id, entry, project) => {
    const p = project ?? get().current
    if (!p) return
    set((s) => {
      const slice = s.byProject[p]
      if (!slice) return s
      const cur = slice.threads[id]
      if (!cur) return s
      return { byProject: { ...s.byProject, [p]: { ...slice, threads: patchThread(slice, id, { entries: [...cur.entries, { kind: 'tool', ...entry }] }) } } }
    })
  },

  patchTool: (id, toolId, patch, project) => {
    const p = project ?? get().current
    if (!p) return
    set((s) => {
      const slice = s.byProject[p]
      if (!slice) return s
      const cur = slice.threads[id]
      if (!cur) return s
      const entries = cur.entries.map((e) =>
        e.kind === 'tool' && e.id === toolId ? { ...e, ...patch } : e,
      )
      return { byProject: { ...s.byProject, [p]: { ...slice, threads: patchThread(slice, id, { entries }) } } }
    })
  },

  finishThread: (id, status, result, tokens, project) => {
    const p = project ?? get().current
    if (!p) return
    set((s) => {
      const slice = s.byProject[p]
      if (!slice) return s
      return { byProject: { ...s.byProject, [p]: { ...slice, threads: patchThread(slice, id, { status, result, finishedAt: Date.now(), ...(tokens ? { tokens } : {}) }) } } }
    })
  },

  selectThread: (id) => {
    const p = get().current
    if (!p) return
    set((s) => {
      const slice = s.byProject[p]
      if (!slice) return s
      return { byProject: { ...s.byProject, [p]: { ...slice, activeThreadId: id } } }
    })
  },

  clear: () => {
    const p = get().current
    if (!p) return
    set((s) => ({ byProject: { ...s.byProject, [p]: emptyAgentSlice() } }))
  },
}))

/** 稳定空切片（选择器兜底） */
const EMPTY_AGENT: AgentSlice = { threads: {}, order: [], activeThreadId: null }

/** 取当前工程的 agent 切片（组件选择器用，返回稳定引用） */
export function selectCurrentAgent(s: AgentState): AgentSlice {
  return (s.current && s.byProject[s.current]) || EMPTY_AGENT
}
