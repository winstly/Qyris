/**
 * Git commit 工作区：改动文件列表（暂存 / 取消暂存 / 丢弃）+ 提交。
 * 点击改动文件 → diff 以覆盖层铺满编辑器区域（useGitStore + DiffView）。
 * 支持一个工程下多个 Git 仓库：自动发现（项目根 + 一级子目录），面板内选择目标仓库。
 * 操作反馈走面板内状态条（运行中/完成/失败），成功不再弹窗，消除感知割裂。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, onFsChanged } from '@/services/desktop'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { useGitStore } from '@/store/useGitStore'
import type { GitFileEntry, GitStatus } from '@/types'
import { basename, joinPath, relativePath } from '@/utils/path'
import { buildGitTree, type GitTreeNode } from '@/utils/gitTree'
import { beginPanelGripDrag } from '@/utils/panelGrip'
import { Select } from '@/components/common/Select'
import { BranchSwitchDialog, prepareBranchTarget, type BranchTarget } from './FileTree'
import { IconChevron, IconCheck, IconMinus, IconPlus, IconTrash, IconRefresh, IconBranch, IconMerge, IconArrowDown, IconArrowUp, IconDownload } from '@/components/common/icons'

const STATUS_LABEL: Record<GitFileEntry['status'], string> = {
  staged: '已暂存', modified: '修改', added: '新增', deleted: '删除',
  renamed: '重命名', untracked: '未跟踪', conflicted: '冲突',
}

/** 无状态时的稳定空数组：内联 [] 字面量每次渲染新身份，会把 buildGitTree 的 useMemo 打穿 */
const NO_FILES: GitFileEntry[] = []

/** 子仓库扫描上限：一级子目录逐个 rev-parse，防超多目录工程拖慢面板 */
const MAX_REPO_SCAN = 50

/** 文件树「提交」按钮聚焦用：GitPanel mount 时注册，unmount 时清除 */
let focusCommitInput: (() => void) | null = null
export function focusGitCommit(): void { focusCommitInput?.() }

export function GitPanel() {
  const rootPath = useFileStore((s) => s.rootPath)
  // 展开态放 store（ratio 联合钳制需要知道本面板是否占预算）
  const open = useAppStore((s) => s.gitPanelOpen)
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
  const seqRef = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const commitRef = useRef<HTMLTextAreaElement>(null)
  const pendingFocus = useRef(false)
  // 注册 focusCommitInput：文件树「提交」按钮可聚焦此输入框
  useEffect(() => {
    focusCommitInput = () => {
      pendingFocus.current = true
      useAppStore.getState().setGitPanelOpen(true)
    }
    return () => { focusCommitInput = null }
  }, [])
  // 面板窄态（左栏被拖窄 <260px）：行内图标钮与目录批量钮整体隐藏——行内信息让位
  const [narrow, setNarrow] = useState(false)
  // 本组件在工程未打开/未发现仓库时渲染 null（rootRef 无节点）——观察器必须跟渲染态
  // 重挂：mount-once 版本会在空 ref 上空转一次后永久失效（应用启动即挂载、后开工程的常规
  // 流程里 narrow 恒为 false，窄面板样式永不生效）
  const rendered = !!(rootPath && !hidden)
  useEffect(() => {
    const el = rootRef.current
    if (!rendered || !el) return
    const ro = new ResizeObserver((entries) => {
      setNarrow((entries[0]?.contentRect.width ?? 999) < 260)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [rendered])
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
  // 分支切换/合并对话框（复用文件树的 BranchSwitchDialog，mode 分派动作）
  const [branchTarget, setBranchTarget] = useState<BranchTarget | null>(null)

  /** 顶部 grip 拖拽调高：实时写 store（localStorage 持久化），钳制在 useAppStore 里（共享实现见 utils/panelGrip） */
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    beginPanelGripDrag(e, rootRef.current, (r) => useAppStore.getState().setGitPanelRatio(r))
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

  /** 点击改动文件：diff 在编辑器区域全面板展示（暂存区无工作区改动的文件看暂存 diff；
   *  未跟踪文件工作区 diff 走 no-index 展示为新增） */
  const openDiff = useCallback((entry: GitFileEntry) => {
    const stagedOnly = entry.staged && !entry.unstaged
    void useGitStore.getState().open(selectedRef.current!, entry.path, stagedOnly, entry.status === 'untracked')
  }, [])

  /** 目录树递归渲染：目录行（折叠头）+ 文件行（FileRow），depth 控制缩进 */
  const renderTreeNodes = (nodes: GitTreeNode[], depth: number): ReactNode[] =>
    nodes.flatMap((n) => {
      if (n.kind === 'dir') {
        const collapsed = collapsedDirs.has(n.path)
        return [
          <div
            key={`dir:${n.path}`}
            className="gitpanel__dirrow"
            style={{ paddingLeft: 6 + depth * 12 }}
          >
            {/* 折叠头与批量操作拆开：button 里不能嵌 button；操作钮 hover 才显（主交互是折叠） */}
            <button
              type="button"
              className="gitpanel__dirhead"
              onClick={() => toggleDir(n.path)}
              aria-expanded={!collapsed}
              title={collapsed ? `展开 ${n.label}（${n.fileCount} 个文件）` : `折叠 ${n.label}`}
            >
              <IconChevron size={11} className={`gitpanel__chevron ${collapsed ? '' : 'gitpanel__chevron--open'}`} />
              <span className="gitpanel__dirname">{n.label}/</span>
              <span className="gitpanel__dircount">{n.fileCount}</span>
            </button>
            <div className="gitpanel__dirops">
              <button
                type="button"
                className="icon-btn"
                disabled={busy}
                onClick={() => void runOp('暂存目录', () => api.gitAdd(selected!, [n.path]))}
                aria-label="暂存目录"
                title="暂存目录下全部改动（git add，含未跟踪文件）"
              >
                <IconPlus size={11} />
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={busy}
                onClick={() => void runOp('取消暂存目录', () => api.gitUnstage(selected!, [n.path]))}
                aria-label="取消暂存目录"
                title="取消暂存目录下全部文件的暂存"
              >
                <IconMinus size={11} />
              </button>
              {/* 确认弹窗在 runOp 外：取消不能被记成功（与行级丢弃同规） */}
              <button
                type="button"
                className="icon-btn gitpanel__discard"
                disabled={busy}
                onClick={() => void (async () => {
                  const ok = await useAppStore.getState().showConfirm(
                    '丢弃目录改动',
                    `将「${n.label}/」下全部已跟踪文件的改动还原为 HEAD 版本（含已暂存部分），不可撤销。确定继续吗？`,
                  )
                  if (!ok) return
                  await runOp('丢弃目录改动', async () => {
                    await api.gitDiscard(selected!, [n.path])
                    const d = useGitStore.getState().diff
                    // dir 也要对上：多仓库工程下别的仓库可能有同前缀相对路径的 diff 在看
                    if (d && d.dir === selected && d.path.startsWith(`${n.path}/`)) useGitStore.getState().close()
                    return `已将「${n.label}/」还原为 HEAD 版本`
                  })
                })()}
                aria-label="丢弃目录改动"
                title="丢弃目录改动（已跟踪文件还原为 HEAD，未跟踪文件不受影响）"
              >
                <IconTrash size={11} />
              </button>
            </div>
          </div>,
          ...(collapsed ? [] : renderTreeNodes(n.children, depth + 1)),
        ]
      }
      const f = n.entry
      return [
        <FileRow
          key={f.path}
          entry={f}
          name={n.name}
          depth={depth}
          busy={busy}
          active={diffPath === f.path}
          onOpen={() => openDiff(f)}
          onStage={() => void runOp('暂存', () => api.gitAdd(selected!, [f.path]))}
          onUnstage={() => void runOp('取消暂存', async () => {
            await api.gitUnstage(selected!, [f.path])
            // 正看着该文件的暂存 diff → 取消后切到工作区视图（暂存区已无内容）；
            // dir 也要对上：多仓库工程下别的仓库可能有同相对路径的 diff 在看（与 onDiscard 同规）
            const d = useGitStore.getState().diff
            if (d?.dir === selected && d.path === f.path && d.staged) {
              void useGitStore.getState().open(selected!, f.path, false, f.status === 'untracked')
            }
          })}
          // 未跟踪文件的删除：确认在 runOp 外（取消不能被记成功）
          onDelete={() => void (async () => {
            const ok = await useAppStore.getState().showConfirm(
              '删除文件',
              `「${f.path}」是未跟踪文件，将从磁盘直接删除，不可撤销。确定删除吗？`,
            )
            if (!ok) return
            await runOp('删除文件', async () => {
              await api.deleteEntry(rootPath!, joinPath(selected!, f.path))
              const d = useGitStore.getState().diff
              if (d?.dir === selected && d.path === f.path) useGitStore.getState().close()
            })
          })()}
          // 确认弹窗在 runOp 之外：取消 = 什么都不发生；进了 runOp 才记账（运行中/成功/失败），
          // 否则取消路径 fn 正常 resolve 会被记成「丢弃成功」（假成功反馈）
          onDiscard={() => void (async () => {
            const ok = await useAppStore.getState().showConfirm(
              '丢弃改动',
              `将「${f.path}」的全部改动还原为 HEAD 版本（含已暂存部分），不可撤销。确定继续吗？`,
            )
            if (!ok) return
            await runOp('丢弃改动', async () => {
              await api.gitDiscard(selected!, [f.path])
              const d = useGitStore.getState().diff
              // dir 也要对上：多仓库工程下别的仓库可能有同相对路径的 diff 在看（与 onDelete 同规）
              if (d?.dir === selected && d.path === f.path) useGitStore.getState().close()
              return `已将「${f.path}」还原为 HEAD 版本`
            })
          })()}
        />,
      ]
    })

  /** 打开分支切换/合并对话框（针对当前选中仓库） */
  const openBranchSwitch = async (mode: 'switch' | 'merge' = 'switch') => {
    if (!selected) return
    const target = await prepareBranchTarget(selected, mode)
    if (target) setBranchTarget(target)
  }

  // 改动文件派生与目录树（hooks 纪律：必须在下方 early-return 之前）
  const files = status?.files ?? NO_FILES
  const fileTree = useMemo(() => buildGitTree(files), [files])
  // 折叠的目录（相对路径键；跨仓库保留视图偏好）
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set())
  const toggleDir = useCallback((p: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }, [])

  if (!rootPath || hidden) return null

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
      className={`gitpanel ${open ? '' : 'gitpanel--collapsed'} ${narrow ? 'gitpanel--narrow' : ''}`}
      style={open ? { height: `${Math.round(gitPanelRatio * 100)}%` } : undefined}
    >
      {/* 顶部拖拽手柄：调面板高度（store 持久化）；折叠态无高度可调，隐藏 */}
      <div
        className="gitpanel__grip"
        onPointerDown={onGripDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖拽调整 Git 面板高度"
        title="拖拽调整高度"
      />
      {/* 头部（VS Code Changes 头模式）：折叠开关 + 全局批量钮（hover/focus 显现，不占独立行） */}
      <div className="gitpanel__head">
        <button
          type="button"
          className="gitpanel__head-toggle"
          onClick={() => useAppStore.getState().setGitPanelOpen(!open)}
          aria-expanded={open}
          title={open ? '收起 Git 工作区' : '展开 Git 工作区'}
        >
          <IconChevron size={11} className={`gitpanel__chevron ${open ? 'gitpanel__chevron--open' : ''}`} />
          <span className="gitpanel__title">Git</span>
          {status?.branch && <span className="gitpanel__branch mono" title={status.branch}>{status.branch}</span>}
          {status && status.ahead > 0 && <span className="gitpanel__ab" title="领先远端">↑{status.ahead}</span>}
          {status && status.behind > 0 && <span className="gitpanel__ab" title="落后远端">↓{status.behind}</span>}
          <span className={`gitpanel__count ${dirtyCount > 0 ? 'gitpanel__count--dirty' : ''}`}>
            {dirtyCount > 0 ? `${dirtyCount} 处改动` : '工作区干净'}
          </span>
        </button>
        {/* 全局批量：展开且有改动才有操作对象；丢弃全部不可逆，窄面板隐藏 */}
        {open && files.length > 0 && (
          <div className="gitpanel__head-ops">
            <button
              type="button"
              className="icon-btn"
              disabled={busy}
              onClick={() => void runOp('暂存全部', () => api.gitAdd(selected!))}
              aria-label="暂存全部"
              title="暂存全部改动（git add -A）"
            >
              <IconPlus size={11} />
            </button>
            {/* 确认在 runOp 外（取消不能被记成功） */}
            <button
              type="button"
              className="icon-btn gitpanel__discard gitpanel__discard-all"
              disabled={busy}
              onClick={() => void (async () => {
                const ok = await useAppStore.getState().showConfirm(
                  '丢弃全部改动',
                  '将当前仓库全部已跟踪文件的改动还原为 HEAD 版本（含已暂存部分，未跟踪文件不受影响），不可撤销。确定继续吗？',
                )
                if (!ok) return
                await runOp('丢弃全部', async () => {
                  await api.gitDiscard(selected!)
                  const d = useGitStore.getState().diff
                  if (d?.dir === selected) useGitStore.getState().close()
                  return '已将全部改动还原为 HEAD 版本'
                })
              })()}
              aria-label="丢弃全部改动"
              title="丢弃全部改动（还原为 HEAD，未跟踪文件不受影响）"
            >
              <IconTrash size={11} />
            </button>
          </div>
        )}
      </div>

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

          {/* 同步操作条：纯图标（语义 hover title 兜底；运行反馈走状态条/过场弹窗，busy 期间全钮禁用） */}
          <div className="gitpanel__sync">
            <button className="btn btn--ghost btn--sm" disabled={busy || !selected} onClick={() => void openBranchSwitch('switch')} aria-label="切换分支" title="切换当前仓库分支">
              <IconBranch size={12} />
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy || !selected} onClick={() => void openBranchSwitch('merge')} aria-label="合并分支" title="将其他分支合并进当前分支（git merge）">
              <IconMerge size={12} />
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy || !selected} onClick={() => void runOp('拉取', () => api.gitPull(selected!))} aria-label="拉取" title="拉取（git pull --no-edit）">
              <IconArrowDown size={12} />
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy || !selected} onClick={() => void runOp('获取', () => api.gitFetch(selected!))} aria-label="获取" title="获取（git fetch --prune）">
              <IconDownload size={12} />
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy || !selected} onClick={() => void runOp('推送', () => api.gitPush(selected!))} aria-label="推送" title="推送（git push，无上游时自动建立跟踪）">
              <IconArrowUp size={12} />
            </button>
            <div className="gitpanel__spacer" />
            <button className="icon-btn" disabled={busy} onClick={() => void discover()} aria-label="刷新状态" title="刷新状态与仓库列表">
              <IconRefresh size={12} />
            </button>
          </div>

          {/* 改动文件列表：目录树分组（单孩子目录链压缩，行内只显示文件名）；全局批量在面板头部 */}
          <div className="gitpanel__files" role="list" aria-label="改动文件">
            {files.length === 0 ? (
              <div className="gitpanel__empty">没有待提交的改动</div>
            ) : (
              renderTreeNodes(fileTree, 0)
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
            {/* 提交区单一职责：写信息 → 提交。全宽主 CTA，括号自带暂存数（原「已暂存 N/M」hint 取消） */}
            <div className="gitpanel__commit-actions">
              <button
                className="btn btn--primary btn--sm gitpanel__commit-btn"
                disabled={!canCommit}
                onClick={() => void runOp('提交', async () => {
                  const out = await api.gitCommit(selected!, commitMsg)
                  setCommitMsg('')
                  git.close()
                  return out
                })}
                title={stagedCount === 0 ? '没有已暂存的文件' : `提交 ${stagedCount} 个已暂存文件（git commit）`}
              >
                <IconCheck size={11} /> {stagedCount > 0 ? `提交 (${stagedCount})` : '提交'}
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
          onMerge={(b) => runOp('合并', () => api.gitMerge(branchTarget.dir, b))}
        />
      )}
    </div>
  )
}

function FileRow({ entry, name, depth, busy, active, onOpen, onStage, onUnstage, onDiscard, onDelete }: {
  entry: GitFileEntry
  /** 文件名（目录信息由树分组头承担，行内不再显示路径） */
  name: string
  /** 树深度：目录行缩进对齐用 */
  depth: number
  busy: boolean
  active: boolean
  onOpen: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
  onDelete: () => void
}) {
  return (
    <div
      role="listitem"
      className={`gitpanel__row ${active ? 'gitpanel__row--active' : ''}`}
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className={`gitpanel__badge gitpanel__badge--${entry.status}`} title={STATUS_LABEL[entry.status]}>
        {STATUS_LABEL[entry.status]}
      </span>
      <span className="gitpanel__path mono" onClick={onOpen} title={`查看 diff：${entry.path}`}>
        {name}
        {entry.renamedFrom && <span className="gitpanel__renamed"> ← {entry.renamedFrom}</span>}
      </span>
      {entry.staged ? (
        <button className="icon-btn" disabled={busy} onClick={onUnstage} aria-label="取消暂存" title="取消暂存（移出暂存区）">
          <IconMinus size={11} />
        </button>
      ) : (
        <button className="icon-btn" disabled={busy} onClick={onStage} aria-label="暂存" title="暂存（git add）">
          <IconPlus size={11} />
        </button>
      )}
      {entry.status === 'untracked' ? (
        <button
          className="icon-btn gitpanel__discard"
          disabled={busy}
          onClick={onDelete}
          aria-label="删除文件"
          title="删除文件（未跟踪文件直接从磁盘删除）"
        >
          <IconTrash size={11} />
        </button>
      ) : (
        <button className="icon-btn gitpanel__discard" disabled={busy} onClick={onDiscard} aria-label="丢弃改动" title="丢弃改动（还原为 HEAD）">
          <IconTrash size={11} />
        </button>
      )}
    </div>
  )
}
