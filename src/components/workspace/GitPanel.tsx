/**
 * Git commit 工作区：改动文件列表（暂存 / 取消暂存 / 丢弃）+ 提交。
 * 点击改动文件 → diff 以覆盖层铺满编辑器区域（useGitStore + DiffView）。
 * 支持一个工程下多个 Git 仓库：自动发现（项目根 + 一级子目录），面板内选择目标仓库。
 * 操作反馈走面板内状态条（运行中/完成/失败），成功不再弹窗，消除感知割裂。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, onFsChanged } from '@/services/desktop'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { useGitStore } from '@/store/useGitStore'
import type { GitFileEntry, GitStatus } from '@/types'
import { basename, relativePath } from '@/utils/path'
import { Select } from '@/components/common/Select'
import { BranchSwitchDialog } from './FileTree'
import { IconChevron, IconCheck, IconPlus, IconTrash, IconRefresh } from '@/components/common/icons'

const STATUS_LABEL: Record<GitFileEntry['status'], string> = {
  staged: '已暂存', modified: '修改', added: '新增', deleted: '删除',
  renamed: '重命名', untracked: '未跟踪', conflicted: '冲突',
}

/** 子仓库扫描上限：一级子目录逐个 rev-parse，防超多目录工程拖慢面板 */
const MAX_REPO_SCAN = 50

/** 文件树「提交」按钮聚焦用：GitPanel mount 时注册，unmount 时清除 */
let focusCommitInput: (() => void) | null = null
export function focusGitCommit(): void { focusCommitInput?.() }

export function GitPanel() {
  const rootPath = useFileStore((s) => s.rootPath)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [hidden, setHidden] = useState(false) // 没发现任何 Git 仓库：整体不渲染
  const [busy, setBusy] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  // 多仓库：发现的仓库列表 + 当前选中（绝对路径）
  const [repos, setRepos] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  useEffect(() => { selectedRef.current = selected }, [selected])
  // 操作状态条（共享 store：文件树右键的拉取/获取也走这里，成功就地反馈不弹窗）
  const opState = useGitStore((s) => s.opState)
  const runningOp = useGitStore((s) => s.runningOp)
  const seqRef = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const commitRef = useRef<HTMLTextAreaElement>(null)
  const pendingFocus = useRef(false)
  // 注册 focusCommitInput：文件树「提交」按钮可聚焦此输入框
  useEffect(() => {
    focusCommitInput = () => {
      pendingFocus.current = true
      setOpen(true)
    }
    return () => { focusCommitInput = null }
  }, [])
  // 面板展开后，如果有待聚焦请求，聚焦 textarea
  useEffect(() => {
    if (open && pendingFocus.current && commitRef.current) {
      pendingFocus.current = false
      commitRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      commitRef.current.focus()
    }
  }, [open])
  const diffPath = useGitStore((s) => s.diff?.path ?? null)
  const gitPanelRatio = useAppStore((s) => s.gitPanelRatio)
  // 分支切换对话框（复用文件树的 BranchSwitchDialog）
  const [branchTarget, setBranchTarget] = useState<{ dir: string; currentBranch: string | null; branches: string[] } | null>(null)

  /** 顶部 grip 拖拽调高：实时写 store（localStorage 持久化），钳制在 useAppStore 里 */
  const onGripDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const parent = rootRef.current?.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    const onMove = (ev: MouseEvent) => {
      useAppStore.getState().setGitPanelRatio((rect.bottom - ev.clientY) / rect.height)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** 拉取指定仓库的状态 */
  const loadStatus = useCallback(async (dir: string | null) => {
    if (!dir) {
      setStatus(null)
      return
    }
    const seq = ++seqRef.current
    try {
      const st = await api.gitStatus(dir)
      if (seqRef.current !== seq) return
      setHidden(false)
      setStatus(st)
    } catch {
      if (seqRef.current === seq) setHidden(true)
    }
  }, [])

  /** 仓库发现：项目根（若为仓库）+ 一级子目录中的仓库；随后加载选中仓库的状态 */
  const discover = useCallback(async () => {
    if (!rootPath) {
      setRepos([])
      setSelected(null)
      setStatus(null)
      return
    }
    const seq = ++seqRef.current
    try {
      const cands: string[] = []
      const rootInfo = await api.gitRepoInfo(rootPath).catch(() => null)
      if (rootInfo?.isRepo) cands.push(rootPath)
      const children = await api.listDir(rootPath, rootPath)
      const dirs = children.filter((n) => n.kind === 'folder').slice(0, MAX_REPO_SCAN)
      // 严格判定「目录自身是仓库根」（toplevel == 目录）
      const infos = await Promise.all(dirs.map((d) => api.gitIsRepoRoot(d.path).catch(() => false)))
      infos.forEach((isRoot, i) => {
        if (isRoot && !cands.includes(dirs[i].path)) cands.push(dirs[i].path)
      })
      if (seqRef.current !== seq) return
      setRepos(cands)
      const next = cands.includes(selectedRef.current ?? '') ? selectedRef.current : cands[0] ?? null
      setSelected(next)
      if (!next) {
        setHidden(true)
        setStatus(null)
        return
      }
      setHidden(false)
      const st = await api.gitStatus(next)
      if (seqRef.current !== seq) return
      setStatus(st)
    } catch {
      if (seqRef.current === seq) setHidden(true)
    }
  }, [rootPath])

  useEffect(() => { void discover() }, [discover])

  // watcher 推送文件变更 → 防抖刷新当前仓库状态（不重新发现，避免频繁扫描）
  useEffect(() => {
    if (!rootPath) return
    let timer: number | undefined
    const off = onFsChanged(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void loadStatus(selectedRef.current), 500)
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [rootPath, loadStatus])

  // 兜底：直接订阅文件 store——watcher 事件链路有时断裂（preload/主进程/HMR 边界），
  // 保存的 store 变更（清 dirty、清 contents）100% 能捕捉到，600ms 防抖保证不会高频触发
  useEffect(() => {
    if (!rootPath) return
    let timer: number | undefined
    const unsub = (useFileStore as unknown as { subscribe: (listener: () => void) => () => void }).subscribe(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void loadStatus(selectedRef.current), 600)
    })
    return () => {
      window.clearTimeout(timer)
      unsub()
    }
  }, [rootPath, loadStatus])

  const runOp = useCallback((label: string, fn: () => Promise<string | void>) => {
    setBusy(true)
    return useGitStore.getState().runOp(label, fn).finally(() => setBusy(false))
  }, [])

  // git 操作完成（含文件树右键发起的）→ 刷新当前仓库状态
  useEffect(() => {
    if (opState && opState.state !== 'running') void loadStatus(selectedRef.current)
  }, [opState, loadStatus])

  /** 点击改动文件：diff 在编辑器区域全面板展示（暂存区无工作区改动的文件看暂存 diff） */
  const openDiff = useCallback((entry: GitFileEntry) => {
    const stagedOnly = entry.staged && !entry.unstaged
    void useGitStore.getState().open(selectedRef.current!, entry.path, stagedOnly)
  }, [])

  /** 打开分支切换对话框（针对当前选中仓库） */
  const openBranchSwitch = async () => {
    if (!selected) return
    try {
      const info = await api.gitRepoInfo(selected)
      if (!info.isRepo) {
        void useAppStore.getState().showAlert('切换分支', '该目录不是 Git 仓库（未找到 .git）。')
        return
      }
      setBranchTarget({ dir: selected, currentBranch: info.currentBranch, branches: info.branches })
    } catch (e) {
      void useAppStore.getState().showAlert('切换分支', String(e))
    }
  }

  if (!rootPath || hidden) return null

  const files = status?.files ?? []
  const stagedCount = files.filter((f) => f.staged).length
  const dirtyCount = files.length
  const canCommit = stagedCount > 0 && commitMsg.trim().length > 0 && !busy
  const git = useGitStore.getState()
  // 注意参数顺序：relativePath(root, p)——传反会把所有仓库标签都算成项目根的绝对路径
  const repoLabel = (dir: string): string =>
    dir === rootPath ? '项目根目录' : relativePath(rootPath, dir) || basename(dir)

  return (
    <div
      ref={rootRef}
      className={`gitpanel ${open ? '' : 'gitpanel--collapsed'}`}
      style={open ? { height: `${Math.round(gitPanelRatio * 100)}%` } : undefined}
    >
      {/* 顶部拖拽手柄：调面板高度（store 持久化）；折叠态无高度可调，隐藏 */}
      <div
        className="gitpanel__grip"
        onMouseDown={onGripDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖拽调整 Git 面板高度"
        title="拖拽调整高度"
      />
      {/* 头部：分支 + 改动数 + 折叠 */}
      <button
        type="button"
        className="gitpanel__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? '收起 Git 工作区' : '展开 Git 工作区'}
      >
        <IconChevron size={11} className={`gitpanel__chevron ${open ? 'gitpanel__chevron--open' : ''}`} />
        <span className="gitpanel__title">Git</span>
        {status?.branch && <span className="gitpanel__branch mono">{status.branch}</span>}
        {status && status.ahead > 0 && <span className="gitpanel__ab" title="领先远端">↑{status.ahead}</span>}
        {status && status.behind > 0 && <span className="gitpanel__ab" title="落后远端">↓{status.behind}</span>}
        <span className={`gitpanel__count ${dirtyCount > 0 ? 'gitpanel__count--dirty' : ''}`}>
          {dirtyCount > 0 ? `${dirtyCount} 处改动` : '工作区干净'}
        </span>
      </button>

      {open && (
        <div className="gitpanel__body">
          {/* 多仓库：仓库选择器 */}
          {repos.length > 1 && selected && (
            <div className="gitpanel__repo-row">
              <span className="gitpanel__repo-label">仓库</span>
              <Select
                size="sm"
                value={selected}
                onChange={(v) => { setSelected(v); useGitStore.getState().close(); void loadStatus(v) }}
                options={repos.map((r) => ({ value: r, label: repoLabel(r) }))}
                ariaLabel="选择 Git 仓库"
              />
            </div>
          )}

          {/* 同步操作条 */}
          <div className="gitpanel__sync">
            <button className="btn btn--ghost btn--sm" disabled={busy || !selected} onClick={() => void openBranchSwitch()} title="切换当前仓库分支">
              分支
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy || !selected} onClick={() => void runOp('拉取', () => api.gitPull(selected!))} title="git pull --no-edit">
              {runningOp === '拉取' ? '拉取中…' : '拉取'}
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy || !selected} onClick={() => void runOp('获取', () => api.gitFetch(selected!))} title="git fetch --prune">
              {runningOp === '获取' ? '获取中…' : '获取'}
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy || !selected} onClick={() => void runOp('推送', () => api.gitPush(selected!))} title="git push（无上游时自动建立跟踪）">
              {runningOp === '推送' ? '推送中…' : '推送'}
            </button>
            <div className="gitpanel__spacer" />
            <button className="icon-btn" disabled={busy} onClick={() => void discover()} aria-label="刷新状态" title="刷新状态与仓库列表">
              <IconRefresh size={12} />
            </button>
          </div>

          {/* 改动文件列表 */}
          <div className="gitpanel__files" role="list" aria-label="改动文件">
            {files.length === 0 ? (
              <div className="gitpanel__empty">没有待提交的改动</div>
            ) : (
              files.map((f) => (
                <FileRow
                  key={f.path}
                  entry={f}
                  busy={busy}
                  active={diffPath === f.path}
                  onOpen={() => openDiff(f)}
                  onStage={() => void runOp('暂存', () => api.gitAdd(selected!, [f.path]))}
                  onUnstage={() => void runOp('取消暂存', async () => {
                    await api.gitUnstage(selected!, [f.path])
                    // 正看着该文件的暂存 diff → 取消后切到工作区视图（暂存区已无内容）
                    const d = useGitStore.getState().diff
                    if (d?.path === f.path && d.staged) void useGitStore.getState().open(selected!, f.path, false)
                  })}
                  onDiscard={() => void runOp('丢弃改动', async () => {
                    const ok = await useAppStore.getState().showConfirm(
                      '丢弃改动',
                      `将「${f.path}」的全部改动还原为 HEAD 版本（含已暂存部分），不可撤销。确定继续吗？`,
                    )
                    if (!ok) return
                    await api.gitDiscard(selected!, [f.path])
                    if (useGitStore.getState().diff?.path === f.path) useGitStore.getState().close()
                  })}
                />
              ))
            )}
          </div>

          {/* 提交区 */}
          <div className="gitpanel__commit">
            <textarea
              ref={commitRef}
              className="gitpanel__msg"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder={stagedCount > 0 ? '提交信息（提交已暂存的改动）…' : '先暂存要提交的文件…'}
              rows={2}
              aria-label="提交信息"
            />
            <div className="gitpanel__commit-actions">
              <button
                className="btn btn--ghost btn--sm"
                disabled={busy || files.length === 0}
                onClick={() => void runOp('暂存全部', () => api.gitAdd(selected!))}
                title="git add -A：暂存全部改动"
              >
                <IconPlus size={11} /> 暂存全部
              </button>
              <div className="gitpanel__spacer" />
              <span className="gitpanel__staged-hint">已暂存 {stagedCount} / {files.length}</span>
              <button className="btn btn--primary btn--sm" disabled={!canCommit} onClick={() => void runOp('提交', async () => {
                const out = await api.gitCommit(selected!, commitMsg)
                setCommitMsg('')
                git.close()
                return out
              })} title={stagedCount === 0 ? '没有已暂存的文件' : 'git commit'}>
                <IconCheck size={11} /> 提交
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 分支切换对话框（针对当前选中仓库） */}
      {branchTarget && (
        <BranchSwitchDialog
          target={branchTarget}
          onClose={() => setBranchTarget(null)}
          onSwitched={() => {
            void loadStatus(selectedRef.current)
            useGitStore.getState().close()
          }}
        />
      )}
    </div>
  )
}

function FileRow({ entry, busy, active, onOpen, onStage, onUnstage, onDiscard }: {
  entry: GitFileEntry
  busy: boolean
  active: boolean
  onOpen: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
}) {
  return (
    <div role="listitem" className={`gitpanel__row ${active ? 'gitpanel__row--active' : ''}`}>
      <span className={`gitpanel__badge gitpanel__badge--${entry.status}`} title={STATUS_LABEL[entry.status]}>
        {STATUS_LABEL[entry.status]}
      </span>
      <span className="gitpanel__path mono" onClick={onOpen} title={`查看 diff：${entry.path}`}>
        {entry.path}
        {entry.renamedFrom && <span className="gitpanel__renamed"> ← {entry.renamedFrom}</span>}
      </span>
      {entry.staged ? (
        <button className="icon-btn" disabled={busy} onClick={onUnstage} aria-label="取消暂存" title="取消暂存">
          <IconChevron size={11} className="gitpanel__unstage-icon" />
        </button>
      ) : (
        <button className="icon-btn" disabled={busy} onClick={onStage} aria-label="暂存" title="暂存（git add）">
          <IconPlus size={11} />
        </button>
      )}
      {entry.status !== 'untracked' && (
        <button className="icon-btn gitpanel__discard" disabled={busy} onClick={onDiscard} aria-label="丢弃改动" title="丢弃改动（还原为 HEAD）">
          <IconTrash size={11} />
        </button>
      )}
    </div>
  )
}
