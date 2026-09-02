/**
 * 文件树 + 编辑器状态。
 * 树采用「目录按需懒加载」：childrenMap 缓存每个已展开目录的直接子项，
 * 万级文件项目也不会一次性全量扫描。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'
import { basename } from '@/utils/path'
import type { TreeNode } from '@/types'

const MAX_REFRESH_DIRS = 40
/** expandAll 的目录数上限：深/宽树防失控（node_modules 等已被主进程过滤，正常项目远达不到） */
const MAX_EXPAND_DIRS = 300

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
  /** 剪贴板：文件树剪切/复制操作 */
  clipboard: { srcPath: string; mode: 'cut' | 'copy' } | null

  openProject: (root: string) => Promise<void>
  /** 清空全部状态回到未打开项目（删除当前项目文件后调用） */
  reset: () => void
  loadSnapshots: () => Promise<void>
  addSnapshot: (path: string, sessionId: string) => void
  restoreSnapshot: (path: string) => Promise<void>
  restoreSession: (sessionId: string) => Promise<number>
  loadChildren: (dir: string) => Promise<void>
  toggleDir: (dir: string) => Promise<void>
  /** 递归展开目录及全部后代目录（懒加载逐层拉取，带目录数上限防护） */
  expandAll: (dir: string) => Promise<void>
  /** 收起目录及全部后代（删除 expanded 里以其为前缀的键，避免后代幽灵展开） */
  collapseAll: (dir: string) => void
  refreshExpanded: () => Promise<void>
  openFile: (path: string) => Promise<void>
  closeTab: (path: string) => Promise<void>
  /** 批量关闭原语：页签右键菜单（关闭其他/左侧/右侧/全部）共用 */
  closeTabs: (paths: string[]) => Promise<void>
  closeOthers: (path: string) => Promise<void>
  closeToLeft: (path: string) => void
  closeToRight: (path: string) => void
  closeAll: () => Promise<void>
  setContent: (path: string, content: string) => void
  saveFile: (path?: string) => Promise<boolean>
  /** AI 写文件 / watcher 事件 共用的外部变更入口 */
  notifyExternalChange: (paths: string[]) => Promise<void>
  parentOf: (path: string) => string | null
  cut: (path: string) => void
  copy: (path: string) => void
  paste: (destDir: string) => Promise<void>
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
  clipboard: null,

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
      clipboard: null,
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
      clipboard: null,
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

  expandAll: async (dir) => {
    const { rootPath } = get()
    if (!rootPath) return
    const load = async (d: string): Promise<TreeNode[]> => {
      try {
        return await api.listDir(rootPath, d)
      } catch {
        return []
      }
    }
    // 逐层 BFS：每层先落一次 expanded/childrenMap，用户能看到渐进展开而不是长时间白等
    const expanded: Record<string, true> = { ...get().expanded, [dir]: true }
    const queue: TreeNode[] = []
    const first = await load(dir)
    set((s) => ({ childrenMap: { ...s.childrenMap, [dir]: first }, expanded: { ...expanded } }))
    for (const n of first) if (n.kind === 'folder') queue.push(n)
    let visited = 1
    while (queue.length && visited < MAX_EXPAND_DIRS) {
      const cur = queue.shift()!
      visited++
      expanded[cur.path] = true
      const kids = await load(cur.path)
      set((s) => ({ childrenMap: { ...s.childrenMap, [cur.path]: kids }, expanded: { ...expanded } }))
      for (const n of kids) if (n.kind === 'folder') queue.push(n)
    }
  },

  collapseAll: (dir) => {
    set((s) => {
      const next: Record<string, true> = {}
      for (const key of Object.keys(s.expanded)) {
        // 精确匹配 + 路径分隔符边界的前缀匹配：'/a/b' 不能误杀 '/a/bc'
        if (key === dir || key.startsWith(`${dir}/`) || key.startsWith(`${dir}\\`)) continue
        next[key] = true
      }
      return { expanded: next }
    })
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

  closeTabs: async (paths) => {
    // 检查是否有未保存的文件
    const dirtyPaths = paths.filter((p) => get().dirty[p])
    if (dirtyPaths.length > 0) {
      // 动态导入避免循环依赖
      const { useAppStore } = await import('./useAppStore')
      const names = dirtyPaths.map((p) => basename(p)).join('、')
      const confirmed = await useAppStore.getState().showConfirm(
        '未保存的更改',
        `${names} 有未保存的更改，确定关闭？`,
      )
      if (!confirmed) return
    }

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
    if (i > 0) void get().closeTabs(get().openTabs.slice(0, i))
  },

  closeToRight: (path) => {
    const i = get().openTabs.indexOf(path)
    if (i >= 0 && i < get().openTabs.length - 1) void get().closeTabs(get().openTabs.slice(i + 1))
  },

  closeAll: () => get().closeTabs(get().openTabs),

  setContent: (path, content) =>
    set((s) => ({
      contents: { ...s.contents, [path]: content },
      dirty: { ...s.dirty, [path]: true },
    })),

  saveFile: async (path) => {
    const target = path ?? get().activePath
    const { rootPath, contents, activePath } = get()
    if (!target || !rootPath || contents[target] === undefined) return false
    const content = contents[target]
    set({ savingPath: target })
    try {
      await api.writeTextFile(rootPath, target, content)
      set((s) => {
        const dirty = { ...s.dirty }
        delete dirty[target]
        // 保存后清掉非当前文件的缓存条目：切回该文件时 openFile 会重新读盘，
        // 外部进程（git checkout/pull、其他编辑器）改了该文件也不会因缓存在而绕过磁盘。
        // 当前文件不能清：contentForEditor 会变 undefined 导致编辑器变空白；
        // 当前文件的兜底由 notifyExternalChange（watcher）在切文件时触发。
        const nextContents = { ...s.contents }
        if (target !== activePath) delete nextContents[target]
        return { dirty, contents: nextContents, lastSavedAt: Date.now() }
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

  cut: (path) => set({ clipboard: { srcPath: path, mode: 'cut' } }),
  copy: (path) => set({ clipboard: { srcPath: path, mode: 'copy' } }),

  paste: async (destDir) => {
    const { rootPath, clipboard } = get()
    if (!rootPath || !clipboard) return
    try {
      if (clipboard.mode === 'cut') {
        await api.moveEntry(rootPath, clipboard.srcPath, destDir)
        const fs = get()
        if (fs.openTabs.includes(clipboard.srcPath)) fs.closeTab(clipboard.srcPath)
        set({ clipboard: null })
      } else {
        await api.copyEntry(rootPath, clipboard.srcPath, destDir)
      }
      const srcDir = get().parentOf(clipboard.srcPath) ?? rootPath
      await get().loadChildren(srcDir)
      if (srcDir !== destDir) await get().loadChildren(destDir)
      await get().refreshExpanded()
    } catch (e) {
      const { useAppStore } = await import('./useAppStore')
      void useAppStore.getState().showAlert('粘贴失败', String(e))
    }
  },
}))
