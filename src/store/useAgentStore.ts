/**
 * 子任务 agent 状态中心：dispatch_subtasks 派发的每个子 agent 一个线程，
 * 实时记录转录（文本轮次 + 工具调用入账）。对话面板可切换查看任意 agent 的执行进度。
 * 线程数据不持久化（仅当次会话内存态），随应用退出消亡。
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

interface AgentState {
  threads: Record<string, AgentThread>
  /** 创建顺序（渲染用） */
  order: string[]
  /** 对话面板当前查看的 agent 线程（null = 主对话） */
  activeThreadId: string | null

  /** 一次派发创建一批线程（pending 态），返回线程 id 列表（与任务顺序对应） */
  createBatch: (cardId: string, tasks: { title: string; tier: string; model: string }[]) => string[]
  /** 线程开始执行 */
  beginThread: (id: string) => void
  appendText: (id: string, content: string) => void
  appendTool: (id: string, entry: Omit<AgentEntryTool, 'kind'>) => void
  patchTool: (id: string, toolId: string, patch: Partial<Omit<AgentEntryTool, 'kind' | 'id'>>) => void
  finishThread: (id: string, status: 'done' | 'error' | 'cancelled', result: string, tokens?: { input: number; output: number }) => void
  selectThread: (id: string | null) => void
  /** 清空对话时一并清空 agent 线程 */
  clear: () => void
}

function patchThread(s: AgentState, id: string, patch: Partial<AgentThread>): Pick<AgentState, 'threads'> {
  const cur = s.threads[id]
  if (!cur) return { threads: s.threads }
  return { threads: { ...s.threads, [id]: { ...cur, ...patch } } }
}

export const useAgentStore = create<AgentState>()((set) => ({
  threads: {},
  order: [],
  activeThreadId: null,

  createBatch: (cardId, tasks) => {
    const ids: string[] = []
    const now = Date.now()
    set((s) => {
      const threads = { ...s.threads }
      const order = [...s.order]
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
      return { threads, order }
    })
    return ids
  },

  beginThread: (id) => set((s) => patchThread(s, id, { status: 'running', startedAt: Date.now() })),

  appendText: (id, content) =>
    set((s) => {
      const cur = s.threads[id]
      if (!cur) return s
      return patchThread(s, id, { entries: [...cur.entries, { kind: 'text', content }] })
    }),

  appendTool: (id, entry) =>
    set((s) => {
      const cur = s.threads[id]
      if (!cur) return s
      return patchThread(s, id, { entries: [...cur.entries, { kind: 'tool', ...entry }] })
    }),

  patchTool: (id, toolId, patch) =>
    set((s) => {
      const cur = s.threads[id]
      if (!cur) return s
      const entries = cur.entries.map((e) =>
        e.kind === 'tool' && e.id === toolId ? { ...e, ...patch } : e,
      )
      return patchThread(s, id, { entries })
    }),

  finishThread: (id, status, result, tokens) =>
    set((s) => patchThread(s, id, { status, result, finishedAt: Date.now(), ...(tokens ? { tokens } : {}) })),

  selectThread: (id) => set({ activeThreadId: id }),

  clear: () => set({ threads: {}, order: [], activeThreadId: null }),
}))
