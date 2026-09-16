/**
 * 文件树 + 编辑器状态。
 * 树采用「目录按需懒加载」：childrenMap 缓存每个已展开目录的直接子项，
 * 万级文件项目也不会一次性全量扫描。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'
import { basename } from '@/utils/path'
import type { TreeNode } from '@/types'
import type { SnapshotVersion } from '../../shared/types'

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
  /** 打开/保存时的磁盘 mtime 基线：保存前回传主进程比对，外部改动不再被静默覆盖 */
  mtimes: Record<string, number>
  binaryFiles: Record<string, true>
  truncatedFiles: Record<string, true>
  cursor: { line: number; col: number }
  savingPath: string | null
  lastSavedAt: number | null
  /** 文件快照：绝对路径 → { ts, sessionId }（AI 写文件前的回退点，按会话分组） */
  snapshots: Record<string, { ts: number; sessionId: string }>
  /** 快照历史弹层：当前查看的文件 + 其全部版本（null = 关闭） */
  snapshotHistory: { path: string; versions: SnapshotVersion[] } | null
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
  /** 展开文件树到目标文件所在目录（从根到文件的每一级目录都展开 + 懒加载） */
  revealPath: (path: string) => Promise<void>
  closeTab: (path: string) => Promise<void>
  /** 批量关闭原语：页签右键菜单（关闭其他/左侧/右侧/全部）共用 */
  closeTabs: (paths: string[]) => Promise<void>
  closeOthers: (path: string) => Promise<void>
  closeToLeft: (path: string) => void
  closeToRight: (path: string) => void
  closeAll: () => Promise<void>
  setContent: (path: string, content: string) => void
  saveFile: (path?: string) => Promise<boolean>
  /** 丢弃本地未保存编辑，强制从磁盘重读（保存冲突对话框的「重新加载」动作） */
  reloadFile: (path: string) => Promise<void>
  /** 打开快照历史弹层（拉取该文件全部版本） */
  openSnapshotHistory: (path: string) => Promise<void>
  closeSnapshotHistory: () => void
  /** 回退到指定版本（版本 key 为 null = 会话基线） */
  restoreSnapshotVersion: (version: SnapshotVersion) => Promise<void>
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
  mtimes: {},
  binaryFiles: {},
  truncatedFiles: {},
  cursor: { line: 1, col: 1 },
  savingPath: null,
  lastSavedAt: null,
  snapshots: {},
  snapshotHistory: null,
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
      mtimes: {},
      clipboard: null,
      binaryFiles: {},
      truncatedFiles: {},
      cursor: { line: 1, col: 1 },
      snapshots: {},
      snapshotHistory: null,
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
      mtimes: {},
      binaryFiles: {},
      truncatedFiles: {},
      cursor: { line: 1, col: 1 },
      snapshots: {},
      snapshotHistory: null,
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
    const expanded: Record<string, true> = { ...get().expanded, [dir]: true }
    // 第一层：直接加载
    let first: TreeNode[]
    try {
      first = await api.listDir(rootPath, dir)
    } catch {
      first = []
    }
    set((s) => ({ childrenMap: { ...s.childrenMap, [dir]: first }, expanded: { ...expanded } }))
    const queue: TreeNode[] = first.filter((n) => n.kind === 'folder')
    let visited = 1
    // 逐层 BFS，每批 20 个目录用批量 IPC 并发取，每批后 yield 让出主线程
    const BATCH_SIZE = 20
    while (queue.length && visited < MAX_EXPAND_DIRS) {
      const batch = queue.splice(0, Math.min(BATCH_SIZE, MAX_EXPAND_DIRS - visited))
      visited += batch.length
      for (const n of batch) expanded[n.path] = true
      // 批量 IPC：一次取多个目录内容
      let results: Record<string, TreeNode[]>
      try {
        results = await api.listDirBatch(rootPath, batch.map((n) => n.path))
      } catch {
        // fallback: 逐个加载
        results = {}
        for (const n of batch) {
          try { results[n.path] = await api.listDir(rootPath, n.path) } catch { results[n.path] = [] }
        }
      }
      // 更新状态
      set((s) => {
        const childrenMap = { ...s.childrenMap }
        for (const [d, kids] of Object.entries(results)) {
          childrenMap[d] = kids
          for (const n of kids) if (n.kind === 'folder') queue.push(n)
        }
        return { childrenMap, expanded: { ...expanded } }
      })
      // yield：让出主线程让 React 渲染
      await new Promise<void>((r) => setTimeout(r, 0))
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
          mtimes: { ...s.mtimes, [path]: fc.mtimeMs },
        }))
      } else {
        set((s) => ({
          contents: { ...s.contents, [path]: fc.content },
          mtimes: { ...s.mtimes, [path]: fc.mtimeMs },
          truncatedFiles: fc.truncated ? { ...s.truncatedFiles, [path]: true } : s.truncatedFiles,
        }))
      }
    } catch (e) {
      console.error('读取文件失败：', e)
    }
  },

  revealPath: async (path) => {
    const { rootPath } = get()
    if (!rootPath) return
    // 收集从文件父目录到根的每一级目录
    const dirs: string[] = []
    let dir = get().parentOf(path)
    while (dir && dir !== rootPath && dir.length > rootPath.length) {
      dirs.push(dir)
      dir = get().parentOf(dir)
    }
    if (dirs.length === 0) return
    dirs.reverse()

    // 需要加载的目录（子项未缓存且未展开）
    const toLoad = dirs.filter((d) => !get().childrenMap[d] && !get().expanded[d])
    // 一次 IPC 批量加载，避免逐层串行等待
    if (toLoad.length > 0) {
      try {
        const results = await api.listDirBatch(rootPath, toLoad)
        set((s) => {
          const childrenMap = { ...s.childrenMap }
          for (const [d, kids] of Object.entries(results)) childrenMap[d] = kids
          return { childrenMap }
        })
      } catch { /* 加载失败不阻塞展开 */ }
    }

    // 一次性展开所有层级
    set((s) => {
      const expanded = { ...s.expanded }
      for (const d of dirs) expanded[d] = true
      return { expanded }
    })
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

    const doSave = async (force: boolean): Promise<boolean> => {
      const res = await api.writeTextFile(rootPath, target, content, {
        expectedMtimeMs: get().mtimes[target] ?? null,
        force,
      })
      set((s) => {
        const dirty = { ...s.dirty }
        delete dirty[target]
        // 保存后清掉非当前文件的缓存条目：切回该文件时 openFile 会重新读盘，
        // 外部进程（git checkout/pull、其他编辑器）改了该文件也不会因缓存在而绕过磁盘。
        // 当前文件不能清：contentForEditor 会变 undefined 导致编辑器变空白；
        // 当前文件的兜底由 notifyExternalChange（watcher）在切文件时触发。
        const nextContents = { ...s.contents }
        if (target !== activePath) delete nextContents[target]
        return { dirty, contents: nextContents, mtimes: { ...s.mtimes, [target]: res.mtimeMs }, lastSavedAt: Date.now() }
      })
      return true
    }

    try {
      return await doSave(false)
    } catch (e) {
      const msg = String(e)
      if (!msg.startsWith('FILE_CONFLICT')) {
        console.error('保存失败：', e)
        return false
      }
      // 冲突：磁盘版本比打开/上次保存时的基线新（AI 写入或外部程序改动）——交还用户决策
      const { useAppStore } = await import('./useAppStore')
      const choice = await useAppStore.getState().showChoices(
        '文件已被外部修改',
        `${basename(target)} 在你编辑期间被外部修改（AI 写入或其他程序）。请选择如何处理：`,
        [
          { id: 'overwrite', label: '覆盖保存（保留我的编辑，丢弃外部修改）' },
          { id: 'reload', label: '重新加载（保留外部修改，丢弃我的编辑）' },
          { id: 'cancel', label: '取消（稍后手动处理）' },
        ],
      )
      try {
        if (choice === 'overwrite') return await doSave(true)
        if (choice === 'reload') {
          await get().reloadFile(target)
          return false
        }
      } catch (e2) {
        console.error('冲突处理失败：', e2)
        return false
      }
      return false
    } finally {
      set({ savingPath: null })
    }
  },

  reloadFile: async (path) => {
    const { rootPath } = get()
    if (!rootPath) return
    try {
      const fc = await api.readTextFile(rootPath, path)
      set((s) => {
        const dirty = { ...s.dirty }
        delete dirty[path]
        return {
          contents: { ...s.contents, [path]: fc.content },
          dirty,
          mtimes: { ...s.mtimes, [path]: fc.mtimeMs },
        }
      })
    } catch (e) {
      console.error('重新加载失败：', e)
    }
  },

  openSnapshotHistory: async (path) => {
    const { rootPath } = get()
    if (!rootPath) return
    try {
      const versions = await api.snapshotVersions(rootPath, path)
      if (versions.length === 0) {
        const { useAppStore } = await import('./useAppStore')
        void useAppStore.getState().showAlert('快照历史', '该文件没有可回退的快照。')
        return
      }
      set({ snapshotHistory: { path, versions } })
    } catch (e) {
      console.error('读取快照历史失败：', e)
    }
  },

  closeSnapshotHistory: () => set({ snapshotHistory: null }),

  restoreSnapshotVersion: async (version) => {
    const { rootPath, snapshotHistory } = get()
    if (!rootPath || !snapshotHistory) return
    try {
      await api.snapshotRestoreAt(rootPath, version.sessionId, snapshotHistory.path, version.versionKey)
      await get().notifyExternalChange([snapshotHistory.path])
      await get().loadSnapshots()
      set({ snapshotHistory: null })
    } catch (e) {
      const { useAppStore } = await import('./useAppStore')
      void useAppStore.getState().showAlert('回退失败', String(e))
    }
  },

  notifyExternalChange: async (paths) => {
    await get().refreshExpanded()
    const { rootPath, contents, dirty } = get()
    if (!rootPath) return
    // 未 dirty 的已打开文件自动重载；dirty 的保留用户编辑
    //（mtime 基线刻意不更新：dirty 文件被 AI 改过后，保存时会触发冲突对话框兜底）
    for (const p of paths) {
      if (!(p in contents) || dirty[p]) continue
      try {
        const fc = await api.readTextFile(rootPath, p)
        if (!fc.isBinary) {
          set((s) => ({
            contents: { ...s.contents, [p]: fc.content },
            mtimes: { ...s.mtimes, [p]: fc.mtimeMs },
          }))
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
