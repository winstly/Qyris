import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { useGitStore } from '@/store/useGitStore'
import { api } from '@/services/desktop'
import { basename, joinPath } from '@/utils/path'
import type { TreeNode } from '@/types'
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu'
import { Select } from '@/components/common/Select'
import { IconChevron, IconFolder, IconFolderOpen, IconFile, IconPlus, IconFolderPlus, IconPencil, IconTrash, IconRefresh, IconSearch, IconClose, IconBranch, IconUndo, IconCopy, IconScissors, IconCheck, IconSend } from '@/components/common/icons'
import { focusGitCommit } from '@/components/workspace/GitPanel'

/** 右键「切换分支」对话框的目标目录与其仓库信息 */
interface BranchTarget {
  dir: string
  currentBranch: string | null
  branches: string[]
}

/** 搜索框 ref，供全局快捷键 Ctrl+F 聚焦 */
let searchInputRef: HTMLInputElement | null = null
/** 聚焦文件树搜索框 */
export function focusFileSearch(): void {
  searchInputRef?.focus()
  searchInputRef?.select()
}

/**
 * 文件树：目录懒加载（展开时才 list_dir），顶部文件名搜索（主进程递归匹配），
 * 右键菜单（新建文件 / 新建文件夹 / 重命名 / 删除 / 刷新 / 切换分支）。
 */
export function FileTree() {
  const rootPath = useFileStore((s) => s.rootPath)
  const openProjectDialog = useAppStore((s) => s.openProjectDialog)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ files: string[]; truncated: boolean } | null>(null)
  const [searching, setSearching] = useState(false)
  const seqRef = useRef(0)
  const [branchTarget, setBranchTarget] = useState<BranchTarget | null>(null)

  /** 右键「切换分支」：目录必须是 Git 仓库（有本地分支）才弹选择框 */
  const openBranchSwitch = useCallback(async (dir: string) => {
    const alert = useAppStore.getState().showAlert
    try {
      const info = await api.gitRepoInfo(dir)
      if (!info.isRepo) {
        void alert('切换分支', '该目录不是 Git 仓库（未找到 .git）。')
        return
      }
      if (info.branches.length === 0) {
        void alert('切换分支', '该仓库没有任何本地分支。')
        return
      }
      setBranchTarget({ dir, currentBranch: info.currentBranch, branches: info.branches })
    } catch (e) {
      void alert('切换分支', String(e))
    }
  }, [])

  // 防抖 200ms；seq 防竞态（连续输入时旧请求晚到覆盖新结果）
  useEffect(() => {
    if (!rootPath) return
    const q = query.trim()
    if (!q) {
      setResults(null)
      setSearching(false)
      return
    }
    const seq = ++seqRef.current
    setSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const r = await api.searchFiles(rootPath, q)
        if (seqRef.current === seq) {
          setResults(r)
          setSearching(false)
        }
      } catch {
        if (seqRef.current === seq) {
          setResults({ files: [], truncated: false })
          setSearching(false)
        }
      }
    }, 200)
    return () => window.clearTimeout(timer)
  }, [query, rootPath])

  if (!rootPath) {
    return (
      <div className="filetree-wrap filetree-wrap--empty">
        <IconFolder size={20} />
        <p>未打开项目</p>
        <button className="btn btn--primary btn--sm" onClick={() => void openProjectDialog()}>
          打开项目
        </button>
      </div>
    )
  }

  const rootNode: TreeNode = { name: basename(rootPath), path: rootPath, kind: 'folder' }
  return (
    <div className="filetree-wrap" aria-label="项目文件">
      <div className="filetree__search">
        <IconSearch size={13} />
        <input
          className="filetree__search-input"
          ref={(el) => { searchInputRef = el }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件…"
          aria-label="搜索文件名"
          spellCheck={false}
        />
        {query && (
          <button className="filetree__search-clear" onClick={() => setQuery('')} aria-label="清除搜索">
            <IconClose size={11} />
          </button>
        )}
      </div>
      <div className="filetree" onKeyDown={(e) => {
        if (!e.ctrlKey && !e.metaKey) return
        const fs = useFileStore.getState()
        const active = fs.activePath
        if (!active) return
        if (e.key === 'x') { e.preventDefault(); fs.cut(active) }
        else if (e.key === 'c') { e.preventDefault(); fs.copy(active) }
        else if (e.key === 'v') {
          const dest = fs.childrenMap[active] ? active : fs.parentOf(active) ?? fs.rootPath
          if (dest) { e.preventDefault(); void fs.paste(dest) }
        }
      }}>
        {results !== null ? (
          <SearchResults results={results} searching={searching} query={query.trim()} />
        ) : (
          <div role="tree">
            <NodeRow node={rootNode} depth={0} onSwitchBranch={openBranchSwitch} />
          </div>
        )}
      </div>
      {branchTarget && (
        <BranchSwitchDialog target={branchTarget} onClose={() => setBranchTarget(null)} />
      )}
    </div>
  )
}

// ---------- 文件名搜索结果 ----------

function SearchResults({ results, searching, query }: {
  results: { files: string[]; truncated: boolean }
  searching: boolean
  query: string
}) {
  const rootPath = useFileStore((s) => s.rootPath)
  const activePath = useFileStore((s) => s.activePath)
  const openFile = useFileStore((s) => s.openFile)

  if (results.files.length === 0) {
    return (
      <div className="filetree__search-empty">
        {searching ? '搜索中…' : `无匹配「${query}」的文件`}
      </div>
    )
  }

  return (
    <div role="listbox" aria-label="搜索结果">
      {results.files.map((rel) => {
        const name = basename(rel)
        const dir = rel.slice(0, rel.length - name.length - 1)
        const abs = rootPath ? joinPath(rootPath, rel) : rel
        return (
          <div
            key={rel}
            role="option"
            aria-selected={activePath === abs}
            className={`tree-row search-row ${activePath === abs ? 'tree-row--active' : ''}`}
            onClick={() => void openFile(abs)}
          >
            <span className="tree-icon tree-icon--file"><IconFile size={14} /></span>
            <span className="search-row__text">
              <span className="search-row__name">{name}</span>
              {dir && <span className="search-row__dir">{dir}</span>}
            </span>
          </div>
        )
      })}
      {results.truncated && (
        <div className="filetree__search-empty">已达 200 条上限，请用更具体的关键字</div>
      )}
    </div>
  )
}

const NodeRow = React.memo(function NodeRow({ node, depth, onSwitchBranch }: {
  node: TreeNode
  depth: number
  onSwitchBranch: (dir: string) => void
}) {
  const isFolder = node.kind === 'folder'
  const expanded = useFileStore((s) => !!s.expanded[node.path])
  const loading = useFileStore((s) => !!s.loadingDirs[node.path])
  const children = useFileStore((s) => s.childrenMap[node.path])
  const activePath = useFileStore((s) => s.activePath)
  const rootPath = useFileStore((s) => s.rootPath)
  const toggleDir = useFileStore((s) => s.toggleDir)
  const openFile = useFileStore((s) => s.openFile)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const hasSnapshot = useFileStore((s) => !!s.snapshots[node.path])
  const isActive = activePath === node.path

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={isFolder ? expanded : undefined}
        aria-selected={activePath === node.path}
        tabIndex={-1}
        className={`tree-row ${isActive ? 'tree-row--active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          if (isFolder) void toggleDir(node.path)
          else void openFile(node.path)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuPos({ x: e.clientX, y: e.clientY })
        }}
      >
        <span className={`tree-caret ${expanded ? 'tree-caret--open' : ''}`}>
          {isFolder && <IconChevron size={11} />}
        </span>
        <span className={`tree-icon tree-icon--${node.kind}`}>
          {isFolder
            ? (expanded ? <IconFolderOpen size={14} /> : <IconFolder size={14} />)
            : <IconFile size={14} />}
        </span>
        <span className="tree-name">{node.name}</span>
        {hasSnapshot && <span className="tree-snapshot-dot" title="有可回退的快照（AI 修改前）" aria-label="有快照" />}
        {loading && <span className="tree-loading" aria-label="加载中" />}
      </div>

      {isFolder && expanded && (
        <div role="group">
          {(children ?? []).map((c) => (
            <NodeRow key={c.path} node={c} depth={depth + 1} onSwitchBranch={onSwitchBranch} />
          ))}
          {children && children.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: 8 + (depth + 1) * 14 + 22 }}>
              空目录
            </div>
          )}
        </div>
      )}

      {menuPos && (
        <ContextMenu
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          items={buildTreeMenuItems(node, rootPath, onSwitchBranch)}
        />
      )}
    </>
  )
})

// ---------- 右键菜单 ----------

/** 文件树节点菜单项（逻辑与旧 TreeContextMenu 一致，渲染交给通用 ContextMenu） */
function buildTreeMenuItems(
  target: TreeNode,
  rootPath: string | null,
  onSwitchBranch: (dir: string) => void,
): ContextMenuItem[] {
  if (!rootPath) return []
  const isRoot = target.path === rootPath
  const dirForNew = target.kind === 'folder' ? target.path : (useFileStore.getState().parentOf(target.path) ?? rootPath)

  const afterFsChange = async (parentDir: string) => {
    await useFileStore.getState().loadChildren(parentDir)
    await useFileStore.getState().refreshExpanded()
  }

  const newEntry = async (isDir: boolean) => {
    const name = await useAppStore.getState().showPrompt(isDir ? '新建文件夹' : '新建文件', isDir ? 'new-folder' : 'untitled.ts')
    if (!name) return
    try {
      const created = await api.createEntry(rootPath, dirForNew, name, isDir)
      await afterFsChange(dirForNew)
      if (!isDir) await useFileStore.getState().openFile(created.path)
    } catch (e) {
      void useAppStore.getState().showAlert('操作失败', String(e))
    }
  }

  const rename = async () => {
    if (isRoot) return
    const newName = await useAppStore.getState().showPrompt('重命名', target.name)
    if (!newName || newName === target.name) return
    const parentDir = useFileStore.getState().parentOf(target.path) ?? rootPath
    try {
      const newPath = await api.renameEntry(rootPath, target.path, newName)
      // 打开中的旧路径页签迁移到新路径
      const fs = useFileStore.getState()
      if (target.kind === 'file' && fs.openTabs.includes(target.path)) {
        fs.closeTab(target.path)
        await fs.openFile(newPath)
      }
      await afterFsChange(parentDir)
    } catch (e) {
      void useAppStore.getState().showAlert('操作失败', String(e))
    }
  }

  const remove = async () => {
    if (isRoot) return
    const ok = await useAppStore.getState().showConfirm(`删除 ${target.name}`, target.kind === 'folder'
      ? '文件夹及其全部内容将被删除，此操作不可撤销。'
      : '此操作不可撤销。')
    if (!ok) return
    const parentDir = useFileStore.getState().parentOf(target.path) ?? rootPath
    try {
      await api.deleteEntry(rootPath, target.path)
      const fs = useFileStore.getState()
      if (target.kind === 'file' && fs.openTabs.includes(target.path)) fs.closeTab(target.path)
      await afterFsChange(parentDir)
    } catch (e) {
      void useAppStore.getState().showAlert('操作失败', String(e))
    }
  }

  const refresh = async () => {
    const dir = target.kind === 'folder' ? target.path : (useFileStore.getState().parentOf(target.path) ?? rootPath)
    await useFileStore.getState().loadChildren(dir)
  }

  const hasSnapshot = target.kind === 'file' && !!useFileStore.getState().snapshots[target.path]
  const restore = async () => {
    const ok = await useAppStore.getState().showConfirm(
      `回退 ${target.name}`,
      '将恢复为 AI 修改前的快照内容，文件当前内容会被覆盖。确定继续吗？',
    )
    if (!ok) return
    try {
      await useFileStore.getState().restoreSnapshot(target.path)
    } catch (e) {
      void useAppStore.getState().showAlert('回退失败', String(e))
    }
  }

  /** Git 操作：走共享操作反馈（GitPanel 状态条就地反馈，成功不弹窗）；完成后刷新树 */
  const gitSync = (op: 'pull' | 'fetch' | 'push') => {
    const label = op === 'pull' ? '拉取' : op === 'push' ? '推送' : '获取'
    void useGitStore.getState().runOp(label, async () => {
      const info = await api.gitRepoInfo(target.path).catch(() => null)
      if (!info?.isRepo) throw new Error('该目录不是 Git 仓库（未找到 .git）。')
      const out = op === 'pull' ? await api.gitPull(target.path)
        : op === 'push' ? await api.gitPush(target.path)
        : await api.gitFetch(target.path)
      await afterFsChange(target.kind === 'folder' ? target.path : rootPath)
      return out
    })
  }

  return [
    { label: '新建文件', icon: <IconPlus size={13} />, run: () => void newEntry(false) },
    { label: '新建文件夹', icon: <IconFolderPlus size={13} />, run: () => void newEntry(true) },
    { label: '重命名', icon: <IconPencil size={13} />, run: () => void rename(), disabled: isRoot },
    { label: '剪切', icon: <IconScissors size={13} />, run: () => useFileStore.getState().cut(target.path), disabled: isRoot },
    { label: '复制', icon: <IconCopy size={13} />, run: () => useFileStore.getState().copy(target.path) },
    ...(target.kind === 'folder' && useFileStore.getState().clipboard
      ? [{ label: '粘贴', icon: <IconFile size={13} />, run: () => void useFileStore.getState().paste(target.path) }]
      : []),
    ...(hasSnapshot
      ? [{ label: '回退到修改前', icon: <IconRefresh size={13} />, run: () => void restore() }]
      : []),
    ...(target.kind === 'folder'
      ? [
          {
            label: 'Git',
            icon: <IconBranch size={13} />,
            children: [
              { label: '新建分支…', icon: <IconPlus size={13} />, run: () => {
                void useAppStore.getState().showPrompt('新建分支', '').then(async (name) => {
                  if (!name) return
                  void useGitStore.getState().runOp('新建分支', async () => {
                    await api.gitCheckout(target.path, name)
                    await afterFsChange(target.kind === 'folder' ? target.path : rootPath)
                    return `已创建并切换到 ${name}`
                  })
                })
              }},
              { label: '切换分支…', icon: <IconBranch size={13} />, run: () => onSwitchBranch(target.path) },
              { label: '提交', icon: <IconCheck size={13} />, run: () => focusGitCommit() },
              { label: '推送', icon: <IconSend size={13} />, run: () => void gitSync('push') },
              { label: '拉取', icon: <IconUndo size={13} />, run: () => void gitSync('pull') },
              { label: '获取', icon: <IconRefresh size={13} />, run: () => void gitSync('fetch') },
            ],
          },
          {
            label: '全部展开',
            icon: <IconFolderOpen size={13} />,
            run: () => void useFileStore.getState().expandAll(target.path),
          },
          {
            label: '全部收起',
            icon: <IconFolder size={13} />,
            run: () => useFileStore.getState().collapseAll(target.path),
          },
        ]
      : []),
    { label: '删除', icon: <IconTrash size={13} />, run: () => void remove(), disabled: isRoot, danger: true },
    { label: '刷新', icon: <IconRefresh size={13} />, run: () => void refresh() },
  ]
}

// ---------- 切换分支对话框 ----------

/** 目录级 Git 分支切换：可搜索选择分支 → checkout → 刷新文件树（watcher 亦会兜底推送变更）。
 *  导出供 GitPanel 复用；onSwitched 在 checkout 成功后回调（调用方刷新自己的状态） */
export function BranchSwitchDialog({ target, onClose, onSwitched }: {
  target: BranchTarget
  onClose: () => void
  onSwitched?: () => void
}) {
  const [branch, setBranch] = useState(target.currentBranch ?? target.branches[0] ?? '')
  const [switching, setSwitching] = useState(false)

  const confirm = async () => {
    if (!branch || branch === target.currentBranch) {
      onClose()
      return
    }
    setSwitching(true)
    try {
      await api.gitCheckout(target.dir, branch)
      // 分支切换会改变文件内容：刷新已展开目录 + 重新加载该目录，保证树与编辑器内容同步
      const fs = useFileStore.getState()
      await fs.loadChildren(target.dir)
      await fs.refreshExpanded()
      onSwitched?.()
      onClose()
    } catch (e) {
      void useAppStore.getState().showAlert('切换分支失败', String(e))
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget && !switching) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="切换分支">
        <div className="modal__head">
          <span>切换分支 · {target.dir === useFileStore.getState().rootPath ? '项目根目录' : basename(target.dir)}</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" disabled={switching}>
            <IconClose size={14} />
          </button>
        </div>
        <label className="field">
          <span className="field__label">分支{target.currentBranch ? `（当前：${target.currentBranch}）` : '（游离 HEAD）'}</span>
          <Select
            value={branch}
            onChange={setBranch}
            options={target.branches.map((b) => ({ value: b, label: b }))}
            searchable
            ariaLabel="选择要切换的分支"
          />
          <span className="field__hint">未提交的修改可能与切换冲突，失败原因会在错误弹窗中展示</span>
        </label>
        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose} disabled={switching}>取消</button>
          <button className="btn btn--primary" onClick={() => void confirm()} disabled={!branch || switching || branch === target.currentBranch}>
            {switching ? '切换中…' : '切换'}
          </button>
        </div>
      </div>
    </div>
  )
}
