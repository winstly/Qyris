/**
 * 记忆面板状态：当前工程（无工程时仅全局）的记忆列表 / 检索命中 / 筛选 / 统计。
 * 数据面刻意保持薄：items 与 hits 二选一渲染（hits 非 null = 搜索态）；
 * 层级/分类筛选在渲染层做——主进程 memoryList/memorySearch 只认 includeArchived，
 * 筛选不进 IPC 契约；query 为已提交（防抖后）的搜索词，面板输入框本地态才是实时值。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'
import type { MemoryCategory, MemoryHit, MemoryItem, MemoryPatch, MemoryStats, MemoryTier } from '@/types'

export type MemoryTierFilter = 'all' | MemoryTier
export type MemoryCategoryFilter = 'all' | MemoryCategory
/** 状态分段（进行中 | 已归档）：列表按此过滤；数据面恒拉含归档全量，切换零往返 */
export type MemoryStatusFilter = 'active' | 'archived'

/** 字段更新载荷（唯一定义在 shared/ipc-types 的 MemoryPatch，此为历史名别名） */
export type MemoryUpdatePatch = MemoryPatch

interface MemoryState {
  /** 全量列表（memoryList 结果；非搜索态的数据源） */
  items: MemoryItem[]
  /** 检索命中（非 null = 搜索态，列表以它为准） */
  hits: MemoryHit[] | null
  /** 搜索零命中时的归档相近条目（「想起」而非「丢失」——归档召回） */
  archivedSuggest: MemoryHit[]
  /** 已提交的搜索词（'' = 非搜索态） */
  query: string
  tierFilter: MemoryTierFilter
  categoryFilter: MemoryCategoryFilter
  statusFilter: MemoryStatusFilter
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
  setStatusFilter: (s: MemoryStatusFilter) => void
  /** 行内编辑保存（失败抛给调用方展示） */
  update: (id: string, patch: MemoryUpdatePatch) => Promise<void>
  /** 删除单条（confirm 由调用方负责） */
  remove: (id: string) => Promise<void>
  /** 恢复归档条目（un-archive：清归档痕迹回活跃面，失败抛给调用方展示） */
  restore: (id: string) => Promise<void>
  /** scope 转换（项目↔用户）：成功后从当前列表移除，另一列表下次加载可见 */
  moveScope: (id: string, target: 'project' | 'user', projectRoot: string | null) => Promise<void>
  /** 清空（危险操作，confirm 由调用方负责），完成后重载当前范围 */
  clear: (scope: 'project' | 'global' | 'all', projectRoot: string | null) => Promise<void>
  /** 手动新增（面板「新增」入口；origin 主进程钉死 user_explicit）。列表刷新由调用方负责。
   *  folded=true = 同题活跃条目已存在，内容被折叠/取代（列表条数不变） */
  create: (input: { projectRoot?: string | null; global?: boolean; tier: 'long' | 'short'; category: string; title: string; content: string; importance?: number }) => Promise<{ folded: boolean; id: string }>
  refreshStats: (projectRoot?: string | null) => Promise<void>
}

/** 请求序号：慢请求返回时若已切换工程/发起新请求，丢弃过期结果（防止串工程） */
let reqSeq = 0

export const useMemoryStore = create<MemoryState>()((set, get) => ({
  items: [],
  hits: null,
  archivedSuggest: [],
  query: '',
  tierFilter: 'all',
  categoryFilter: 'all',
  statusFilter: 'active',
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
      const { items } = await api.memoryList(projectRoot, true) // 含归档：状态分段本地过滤，切换零往返
      if (seq !== reqSeq) return
      set({ items, hits: null, query: '', archivedSuggest: [], scopeRoot: projectRoot })
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
      // 归档档直搜归档面（includeArchived）：只搜活跃面再按状态过滤会让归档搜索恒空
      const searchingArchived = get().statusFilter !== 'active'
      const { hits, degraded } = await api.memorySearch(q, projectRoot, undefined, searchingArchived)
      if (seq !== reqSeq) return
      // 零命中 → 归档召回（仅活跃档）：「想起以前记过、被收起来了」比「没有」更接近用户期望
      let archivedSuggest: MemoryHit[] = []
      if (hits.length === 0 && !searchingArchived) {
        const r2 = await api.memorySearch(q, projectRoot, 3, true).catch(() => ({ hits: [] as MemoryHit[], degraded: false }))
        archivedSuggest = r2.hits.filter((h) => h.status === 'archived').slice(0, 3)
      }
      if (seq !== reqSeq) return
      set({ hits, query: q, degraded, archivedSuggest, scopeRoot: projectRoot })
    } catch (e) {
      if (seq !== reqSeq) return
      set({ hits: [], degraded: false, archivedSuggest: [], error: String(e) })
    } finally {
      if (seq === reqSeq) set({ loading: false })
    }
  },

  setQuery: (q) => set({ query: q }),
  setTierFilter: (tierFilter) => set({ tierFilter }),
  setCategoryFilter: (categoryFilter) => set({ categoryFilter }),
  setStatusFilter: (statusFilter) => {
    set({ statusFilter })
    // 搜索态切换状态分段：命中面随分段变（归档档要搜归档面），否则旧命中被过滤成空列表
    const { query, scopeRoot, search } = get()
    if (query.trim() && scopeRoot) void search(query, scopeRoot)
  },

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

  restore: async (id) => {
    const restored = await api.memoryUnarchive(id)
    set((s) => ({
      items: s.items.map((it) => (it.id === restored.id ? restored : it)),
      hits: s.hits ? s.hits.map((h) => (h.id === restored.id ? { ...h, ...restored } : h)) : null,
      // 归档召回行随恢复消失（已回活跃面，不许留着「恢复」按钮）
      archivedSuggest: s.archivedSuggest.filter((h) => h.id !== restored.id),
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

  create: async (input) => {
    const r = await api.memoryCreate(input)
    // 统计与本列表范围一致；列表刷新由调用方走 load/search（口径可能带搜索词）
    void get().refreshStats(input.global ? null : input.projectRoot ?? null)
    return r
  },

  refreshStats: async (projectRoot) => {
    try {
      // 缺省跟当前列表范围走（update/remove 等就地改写后调用不带参）
      const p = projectRoot !== undefined ? projectRoot : get().scopeRoot
      set({ stats: await api.memoryStats(p) })
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
