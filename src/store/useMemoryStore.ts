/**
 * 记忆面板状态：当前工程（无工程时仅全局）的记忆列表 / 检索命中 / 筛选 / 统计。
 * 数据面刻意保持薄：items 与 hits 二选一渲染（hits 非 null = 搜索态）；
 * 层级/分类筛选在渲染层做——主进程 memoryList/memorySearch 只认 includeArchived，
 * 筛选不进 IPC 契约；query 为已提交（防抖后）的搜索词，面板输入框本地态才是实时值。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'
import type { MemoryCategory, MemoryHit, MemoryItem, MemoryStats, MemoryTier } from '@/types'

export type MemoryTierFilter = 'all' | MemoryTier
export type MemoryCategoryFilter = 'all' | MemoryCategory

export interface MemoryUpdatePatch {
  title?: string
  content?: string
  category?: string
  importance?: number
}

interface MemoryState {
  /** 全量列表（memoryList 结果；非搜索态的数据源） */
  items: MemoryItem[]
  /** 检索命中（非 null = 搜索态，列表以它为准） */
  hits: MemoryHit[] | null
  /** 已提交的搜索词（'' = 非搜索态） */
  query: string
  tierFilter: MemoryTierFilter
  categoryFilter: MemoryCategoryFilter
  loading: boolean
  /** embedding 不可用，检索降级为仅关键词（随最近一次 search 结果刷新） */
  degraded: boolean
  /** 列表加载失败文案（主进程记忆模块未就绪等） */
  error: string | null
  stats: MemoryStats | null
  /** 当前列表对应的工程（null = 仅全局），用于排查串工程 */
  scopeRoot: string | null
  /** 后台整理中的工程集合（projectRoot → 正在整理） */
  extractingProjects: Set<string>
  /** 更新某工程的整理状态（主进程 memory-extract-state 事件驱动） */
  setExtracting: (projectRoot: string, extracting: boolean) => void

  /** 按工程加载全量列表（projectRoot=null 仅全局），并刷新统计 */
  load: (projectRoot: string | null) => Promise<void>
  /** 提交搜索：空词回退到 load */
  search: (query: string, projectRoot: string | null) => Promise<void>
  setQuery: (q: string) => void
  setTierFilter: (t: MemoryTierFilter) => void
  setCategoryFilter: (c: MemoryCategoryFilter) => void
  /** 行内编辑保存（失败抛给调用方展示） */
  update: (id: string, patch: MemoryUpdatePatch) => Promise<void>
  /** 删除单条（confirm 由调用方负责） */
  remove: (id: string) => Promise<void>
  /** scope 转换（项目↔用户）：成功后从当前列表移除，另一列表下次加载可见 */
  moveScope: (id: string, target: 'project' | 'user', projectRoot: string | null) => Promise<void>
  /** 清空（危险操作，confirm 由调用方负责），完成后重载当前范围 */
  clear: (scope: 'project' | 'global' | 'all', projectRoot: string | null) => Promise<void>
  refreshStats: () => Promise<void>
}

/** 请求序号：慢请求返回时若已切换工程/发起新请求，丢弃过期结果（防止串工程） */
let reqSeq = 0

export const useMemoryStore = create<MemoryState>()((set, get) => ({
  items: [],
  hits: null,
  query: '',
  tierFilter: 'all',
  categoryFilter: 'all',
  loading: false,
  degraded: false,
  error: null,
  stats: null,
  scopeRoot: null,
  extractingProjects: new Set<string>(),

  load: async (projectRoot) => {
    const seq = ++reqSeq
    set({ loading: true, error: null, degraded: false })
    try {
      const { items } = await api.memoryList(projectRoot)
      if (seq !== reqSeq) return
      set({ items, hits: null, query: '', scopeRoot: projectRoot })
    } catch (e) {
      if (seq !== reqSeq) return
      set({ items: [], hits: null, scopeRoot: projectRoot, error: String(e) })
    } finally {
      if (seq === reqSeq) set({ loading: false })
    }
    void get().refreshStats()
  },

  search: async (query, projectRoot) => {
    const q = query.trim()
    if (!q) {
      await get().load(projectRoot)
      return
    }
    const seq = ++reqSeq
    set({ loading: true, error: null })
    try {
      const { hits, degraded } = await api.memorySearch(q, projectRoot)
      if (seq !== reqSeq) return
      set({ hits, query: q, degraded, scopeRoot: projectRoot })
    } catch (e) {
      if (seq !== reqSeq) return
      set({ hits: [], degraded: false, error: String(e) })
    } finally {
      if (seq === reqSeq) set({ loading: false })
    }
  },

  setQuery: (q) => set({ query: q }),
  setTierFilter: (tierFilter) => set({ tierFilter }),
  setCategoryFilter: (categoryFilter) => set({ categoryFilter }),

  update: async (id, patch) => {
    const updated = await api.memoryUpdate(id, patch)
    set((s) => ({
      items: s.items.map((it) => (it.id === updated.id ? updated : it)),
      hits: s.hits ? s.hits.map((h) => (h.id === updated.id ? { ...h, ...updated } : h)) : null,
    }))
    void get().refreshStats()
  },

  remove: async (id) => {
    await api.memoryDelete(id)
    set((s) => ({
      items: s.items.filter((it) => it.id !== id),
      hits: s.hits ? s.hits.filter((h) => h.id !== id) : null,
    }))
    void get().refreshStats()
  },

  moveScope: async (id, target, projectRoot) => {
    await api.memoryMoveScope(id, target, projectRoot ?? undefined)
    set((s) => ({
      items: s.items.filter((it) => it.id !== id),
      hits: s.hits ? s.hits.filter((h) => h.id !== id) : null,
    }))
    void get().refreshStats()
  },

  clear: async (scope, projectRoot) => {
    await api.memoryClear(scope, projectRoot ?? undefined)
    await get().load(projectRoot)
  },

  refreshStats: async () => {
    try {
      set({ stats: await api.memoryStats() })
    } catch { /* 记忆模块未就绪：状态条保持空值占位 */ }
  },

  setExtracting: (projectRoot, extracting) =>
    set((s) => {
      const next = new Set(s.extractingProjects)
      if (extracting) next.add(projectRoot)
      else next.delete(projectRoot)
      return { extractingProjects: next }
    }),
}))
