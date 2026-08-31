/**
 * 文件树 + 编辑器状态。
 * 树采用「目录按需懒加载」：childrenMap 缓存每个已展开目录的直接子项，
 * 万级文件项目也不会一次性全量扫描。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'
import type { TreeNode } from '@/types'

const MAX_REFRESH_DIRS = 40

interface FileState {
  rootPath: string | null
  /** 目录路径 → 直接子项 */
  childrenMap: Record<string, TreeNode[]>
  loadingDirs: Record<string, true>
  /** 展开的目录集合（对象形式便于不可变更新） */
  expanded: Record<string, true>
  openTabs: string[]
  activePath: string | null
  contents: Record<string, string>
  dirty: Record<string, true>
  binaryFiles: Record<string, true>
  truncatedFiles: Record<string, true>
  cursor: { line: number; col: number }
  savingPath: string | null
  lastSavedAt: number | null
  /** 文件快照：绝对路径 → { ts, sessionId }（AI 写文件前的回退点，按会话分组） */
  snapshots: Record<string, { ts: number; sessionId: string }>

  openProject: (root: string) => Promise<void>
  /** 清空全部状态回到未打开项目（删除当前项目文件后调用） */
  reset: () => void
  loadSnapshots: () => Promise<void>
  addSnapshot: (path: string, sessionId: string) => void
  restoreSnapshot: (path: string) => Promise<void>
  restoreSession: (sessionId: string) => Promise<number>
  loadChildren: (dir: string) => Promise<void>
  toggleDir: (dir: string) => Promise<void>
  refreshExpanded: () => Promise<void>
  openFile: (path: string) => Promise<void>
  closeTab: (path: string) => void
  /** 批量关闭原语：页签右键菜单（关闭其他/左侧/右侧/全部）共用 */
  closeTabs: (paths: string[]) => void
  closeOthers: (path: string) => void
  closeToLeft: (path: string) => void
  closeToRight: (path: string) => void
  closeAll: () => void
  setContent: (path: string, content: string) => void
  saveFile: (path?: string) => Promise<boolean>
  /** AI 写文件 / watcher 事件 共用的外部变更入口 */
  notifyExternalChange: (paths: string[]) => Promise<void>
  parentOf: (path: string) => string | null
}

export const useFileStore = create<FileState>()((set, get) => ({
  rootPath: null,
  childrenMap: {},
  loadingDirs: {},
  expanded: {},
  openTabs: [],
  activePath: null,
  contents: {},
  dirty: {},
  binaryFiles: {},
  truncatedFiles: {},
  cursor: { line: 1, col: 1 },
  savingPath: null,
  lastSavedAt: null,
  snapshots: {},

  openProject: async (root) => {
    set({
      rootPath: root,
      childrenMap: {},
      loadingDirs: {},
      expanded: { [root]: true },
      openTabs: [],
      activePath: null,
      contents: {},
      dirty: {},
      binaryFiles: {},
      truncatedFiles: {},
      cursor: { line: 1, col: 1 },
      snapshots: {},
    })
    await get().loadChildren(root)
    void get().loadSnapshots()
  },

  reset: () => {
    set({
      rootPath: null,
      childrenMap: {},
      loadingDirs: {},
      expanded: {},
      openTabs: [],
      activePath: null,
      contents: {},
      dirty: {},
      binaryFiles: {},
      truncatedFiles: {},
      cursor: { line: 1, col: 1 },
      snapshots: {},
    })
  },

  loadSnapshots: async () => {
    const { rootPath } = get()
    if (!rootPath) return
    try {
      set({ snapshots: await api.listSnapshots(rootPath) })
    } catch { /* 无快照或目录不存在 */ }
  },

  addSnapshot: (path, sessionId) =>
    set((s) => ({ snapshots: { ...s.snapshots, [path]: { ts: Date.now(), sessionId } } })),

  restoreSnapshot: async (path) => {
    const { rootPath } = get()
    if (!rootPath) return
    await api.restoreFile(rootPath, path)
    set((s) => {
      const snapshots = { ...s.snapshots }
      delete snapshots[path]
      return { snapshots }
    })
    await get().notifyExternalChange([path])
  },

  restoreSession: async (sessionId) => {
    const { rootPath } = get()
    if (!rootPath) return 0
    const before = Object.keys(get().snapshots).filter((p) => get().snapshots[p].sessionId === sessionId)
    const count = await api.restoreSession(rootPath, sessionId)
    await get().notifyExternalChange(before)
    await get().loadSnapshots()
    return count
  },

  loadChildren: async (dir) => {
    const { rootPath } = get()
    if (!rootPath) return
    set((s) => ({ loadingDirs: { ...s.loadingDirs, [dir]: true } }))
    try {
      const nodes = await api.listDir(rootPath, dir)
      set((s) => ({ childrenMap: { ...s.childrenMap, [dir]: nodes } }))
    } catch (e) {
      console.error('读取目录失败：', e)
    } finally {
      set((s) => {
        const loadingDirs = { ...s.loadingDirs }
        delete loadingDirs[dir]
        return { loadingDirs }
      })
    }
  },

  toggleDir: async (dir) => {
    const { expanded } = get()
    if (expanded[dir]) {
      const next = { ...expanded }
      delete next[dir]
      set({ expanded: next })
    } else {
      set((s) => ({ expanded: { ...s.expanded, [dir]: true } }))
      // 每次展开都重新拉取，保证与磁盘一致（缓存只做渲染兜底）
      await get().loadChildren(dir)
    }
  },

  refreshExpanded: async () => {
    const dirs = Object.keys(get().expanded).slice(0, MAX_REFRESH_DIRS)
    await Promise.all(dirs.map((d) => get().loadChildren(d)))
  },

  openFile: async (path) => {
    const { rootPath } = get()
    if (!rootPath) return
    set((s) => ({
      openTabs: s.openTabs.includes(path) ? s.openTabs : [...s.openTabs, path],
      activePath: path,
    }))
    if (get().contents[path] !== undefined) return
    try {
      const fc = await api.readTextFile(rootPath, path)
      if (fc.isBinary) {
        set((s) => ({
          binaryFiles: { ...s.binaryFiles, [path]: true },
          contents: { ...s.contents, [path]: '' },
        }))
      } else {
        set((s) => ({
          contents: { ...s.contents, [path]: fc.content },
          truncatedFiles: fc.truncated ? { ...s.truncatedFiles, [path]: true } : s.truncatedFiles,
        }))
      }
    } catch (e) {
      console.error('读取文件失败：', e)
    }
  },

  closeTabs: (paths) => {
    const closing = new Set(paths)
    set((s) => {
      const openTabs = s.openTabs.filter((t) => !closing.has(t))
      const contents = { ...s.contents }
      const dirty = { ...s.dirty }
      for (const p of paths) {
        delete contents[p]
        delete dirty[p]
      }
      // 关闭的页签含当前签时，激活落到剩余最后一签（与单签关闭语义一致）
      const activePath = s.activePath !== null && closing.has(s.activePath)
        ? (openTabs[openTabs.length - 1] ?? null)
        : s.activePath
      return { openTabs, contents, dirty, activePath }
    })
  },

  closeTab: (path) => get().closeTabs([path]),

  closeOthers: (path) => get().closeTabs(get().openTabs.filter((t) => t !== path)),

  closeToLeft: (path) => {
    const i = get().openTabs.indexOf(path)
    if (i > 0) get().closeTabs(get().openTabs.slice(0, i))
  },

  closeToRight: (path) => {
    const i = get().openTabs.indexOf(path)
    if (i >= 0 && i < get().openTabs.length - 1) get().closeTabs(get().openTabs.slice(i + 1))
  },

  closeAll: () => get().closeTabs(get().openTabs),

  setContent: (path, content) =>
    set((s) => ({
      contents: { ...s.contents, [path]: content },
      dirty: { ...s.dirty, [path]: true },
    })),

  saveFile: async (path) => {
    const target = path ?? get().activePath
    const { rootPath, contents } = get()
    if (!target || !rootPath || contents[target] === undefined) return false
    set({ savingPath: target })
    try {
      await api.writeTextFile(rootPath, target, contents[target])
      set((s) => {
        const dirty = { ...s.dirty }
        delete dirty[target]
        return { dirty, lastSavedAt: Date.now() }
      })
      return true
    } catch (e) {
      console.error('保存失败：', e)
      return false
    } finally {
      set({ savingPath: null })
    }
  },

  notifyExternalChange: async (paths) => {
    await get().refreshExpanded()
    const { rootPath, contents, dirty } = get()
    if (!rootPath) return
    // 未 dirty 的已打开文件自动重载；dirty 的保留用户编辑
    for (const p of paths) {
      if (!(p in contents) || dirty[p]) continue
      try {
        const fc = await api.readTextFile(rootPath, p)
        if (!fc.isBinary) {
          set((s) => ({ contents: { ...s.contents, [p]: fc.content } }))
        }
      } catch { /* 文件可能刚被删除 */ }
    }
  },

  parentOf: (path) => {
    const norm = path.replace(/[\\/]+$/, '')
    const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
    return i === -1 ? null : norm.slice(0, i)
  },
}))
