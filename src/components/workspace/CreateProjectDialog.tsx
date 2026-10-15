import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useAppStore } from '@/store/useAppStore'
import { api, onCloneProgress } from '@/services/desktop'
import { IconClose, IconFolder, IconPlus, IconTrash } from '@/components/common/icons'
import { Select } from '@/components/common/Select'
import { TabStrip } from '@/components/common/TabStrip'
import { toast } from '@/components/common/Toast'

type Tab = 'empty' | 'clone'

/** 单个仓库地址行的「测试连接」状态机 */
interface UrlRowState {
  status: 'idle' | 'testing' | 'ok' | 'fail'
  branches: string[]
  branch: string
  error: string
}

const IDLE_ROW: UrlRowState = { status: 'idle', branches: [], branch: '', error: '' }

/** 单个仓库的克隆进度（主进程按仓库广播，done/error 为终态） */
interface CloneRowState {
  state: 'queued' | 'cloning' | 'done' | 'error'
  stage: string
  pct: number | null
  error?: string
}

/**
 * 创建项目对话框：两种模式 —— 创建空项目 / 从远端仓库克隆（支持多仓库、连接测试、分支选择）。
 * 自订阅全局 overlay（同 SettingsDialog / Dialogs 模式）：开关状态直接读 store，
 * 挂载方写 <CreateProjectDialog /> 即可，无需逐窗口手工接线 open/onClose。
 */
export function CreateProjectDialog() {
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  const open = useAppStore((s) => s.createProjectOpen)
  const openProjectWithChoice = useAppStore((s) => s.openProjectWithChoice)
  const setCreateProjectOpen = useAppStore((s) => s.setCreateProjectOpen)

  const [tab, setTab] = useState<Tab>('empty')

  // 空项目
  const [emptyName, setEmptyName] = useState('')
  const [emptyParent, setEmptyParent] = useState('')

  // 克隆
  const [cloneUrls, setCloneUrls] = useState<string[]>([''])
  const [rowStates, setRowStates] = useState<Record<number, UrlRowState>>({})
  const [cloneParent, setCloneParent] = useState('')

  const [creating, setCreating] = useState(false)
  /** 每行克隆进度（主进程按仓库广播，index 为本次入参序，经 sentRowsRef 映射回行号） */
  const [cloneRows, setCloneRows] = useState<Record<number, CloneRowState>>({})
  /** 本次入参序 → 地址行号（并行克隆事件按入参序回传） */
  const sentRowsRef = useRef<number[]>([])

  // 克隆进度事件接线（主进程 git --progress 逐行解析后广播）
  useEffect(() => {
    return onCloneProgress((p) => {
      const row = sentRowsRef.current[p.index]
      if (row === undefined) return
      setCloneRows((prev) => ({
        ...prev,
        [row]: { state: p.state, stage: p.stage, pct: p.pct, error: p.error },
      }))
    })
  }, [])

  // 最新仓库地址列表（异步「测试连接」回包时校验该行仍未变，防过期结果写错行）
  const cloneUrlsRef = useRef(cloneUrls)
  cloneUrlsRef.current = cloneUrls

  if (!open) return null

  const reset = () => {
    setEmptyName('')
    setEmptyParent('')
    setCloneUrls([''])
    setRowStates({})
    setCloneRows({})
    setCloneParent('')
    setCreating(false)
    // 进度映射随会话清空：事件是全局广播，残留映射会把别的窗口/别的批次进度画到本对话框的行上
    sentRowsRef.current = []
  }

  const handleClose = () => {
    reset()
    setCreateProjectOpen(false)
  }

  const pickEmptyParent = async () => {
    try {
      const dir = await api.pickParentDir()
      if (dir) setEmptyParent(dir)
    } catch (e) {
      console.error('pickParentDir 失败：', e)
    }
  }

  const pickCloneParent = async () => {
    try {
      const dir = await api.pickParentDir()
      if (dir) setCloneParent(dir)
    } catch (e) {
      console.error('pickParentDir 失败：', e)
    }
  }

  const handleCreateEmpty = async () => {
    if (creating || !emptyName.trim() || !emptyParent.trim()) return
    setCreating(true)
    try {
      const projectPath = await api.createEmptyProject(emptyParent.trim(), emptyName.trim())
      await openProjectWithChoice(projectPath)
      handleClose()
    } catch (e) {
      toast.err('创建失败', String(e))
    } finally {
      setCreating(false)
    }
  }

  const handleClone = async () => {
    if (creating) return
    // 只发未完成的行：部分失败后重试不必把已成功的仓库再克隆一遍
    const sentRows: number[] = []
    const repos: { url: string; branch?: string }[] = []
    cloneUrls.forEach((u, i) => {
      const url = u.trim()
      if (!url || cloneRows[i]?.state === 'done') return
      sentRows.push(i)
      repos.push({ url, branch: rowStates[i]?.branch || undefined })
    })
    if (!repos.length || !cloneParent.trim()) return
    sentRowsRef.current = sentRows
    setCloneRows((prev) => ({
      ...prev,
      ...Object.fromEntries(sentRows.map((r) => [r, { state: 'queued' as const, stage: '排队中', pct: null }])) as Record<number, CloneRowState>,
    }))
    setCreating(true)
    try {
      const res = await api.cloneRepos(cloneParent.trim(), repos)
      // 终态兜底：事件与收包存在竞态窗口，按结果把未收场的行对齐
      setCloneRows((prev) => {
        const next = { ...prev }
        sentRows.forEach((row, k) => {
          const cur = next[row]
          if (!cur || cur.state === 'done' || cur.state === 'error') return
          const fail = res.failed.find((f) => f.index === k)
          next[row] = fail
            ? { state: 'error', stage: '失败', pct: null, error: fail.error }
            : { state: 'done', stage: '完成', pct: 100 }
        })
        return next
      })
      if (res.failed.length === 0) {
        const openPath = res.cloned.length === 1 ? res.cloned[0] : cloneParent.trim()
        await openProjectWithChoice(openPath)
        handleClose()
      } else {
        toast.err('部分克隆失败', `成功 ${res.cloned.length} 个、失败 ${res.failed.length} 个。失败原因已标在对应行，修正后再次克隆会跳过已成功的。`)
      }
    } catch (e) {
      const msg = String(e)
      if (/取消/.test(msg)) {
        toast.info('克隆已取消', '克隆过程已中止，已完成的仓库保留在目标目录。')
        // 未收场的行清掉进度，回到可重试态（已成功的保留 ✓）
        setCloneRows((prev) => {
          const next: Record<number, CloneRowState> = {}
          for (const [k, v] of Object.entries(prev)) {
            if (v.state === 'done' || v.state === 'error') next[Number(k)] = v
          }
          return next
        })
      } else {
        toast.err('克隆失败', msg)
        setCloneRows({})
      }
    } finally {
      setCreating(false)
      sentRowsRef.current = []
    }
  }

  const addCloneUrl = () => {
    setCloneUrls((prev) => [...prev, ''])
    setRowStates((prev) => ({ ...prev, [cloneUrls.length]: IDLE_ROW }))
  }
  const removeCloneUrl = (i: number) => {
    setCloneUrls((prev) => prev.filter((_, idx) => idx !== i))
    setRowStates((prev) => {
      const next: Record<number, UrlRowState> = {}
      for (const [k, v] of Object.entries(prev)) {
        const idx = Number(k)
        if (idx < i) next[idx] = v
        else if (idx > i) next[idx - 1] = v
      }
      return next
    })
    // 克隆进度同键重排：done/error 状态不许滑到别的行（handleClone 按它跳过已成功行）
    setCloneRows((prev) => {
      const next: Record<number, CloneRowState> = {}
      for (const [k, v] of Object.entries(prev)) {
        const idx = Number(k)
        if (idx < i) next[idx] = v
        else if (idx > i) next[idx - 1] = v
      }
      return next
    })
  }
  const updateCloneUrl = (i: number, val: string) => {
    setCloneUrls((prev) => prev.map((u, idx) => idx === i ? val : u))
    // 地址变动后旧测试结果与克隆终态一并作废（否则 done 行改址后会被 handleClone 永久跳过）
    setRowStates((prev) => (prev[i]?.status === 'idle' ? prev : { ...prev, [i]: IDLE_ROW }))
    setCloneRows((prev) => (prev[i] ? (({ [i]: _drop, ...rest }) => rest)(prev) : prev))
  }

  const testCloneUrl = async (i: number) => {
    const url = cloneUrls[i]?.trim()
    if (!url) return
    setRowStates((prev) => ({ ...prev, [i]: { ...IDLE_ROW, status: 'testing' } }))
    try {
      const res = await api.testRepo(url)
      // 回包前该行可能已被删除（行重排）或地址已改——过期结果写回会张冠李戴，直接丢弃
      if (cloneUrlsRef.current[i]?.trim() !== url) return
      if (res.valid) {
        setRowStates((prev) => ({
          ...prev,
          [i]: { status: 'ok', branches: res.branches, branch: res.branches[0] ?? '', error: '' },
        }))
      } else {
        setRowStates((prev) => ({
          ...prev,
          [i]: { status: 'fail', branches: [], branch: '', error: res.error ?? '未知错误' },
        }))
      }
    } catch (e) {
      setRowStates((prev) => ({
        ...prev,
        [i]: { status: 'fail', branches: [], branch: '', error: String(e) },
      }))
    }
  }

  return (
    <div ref={trapRef} className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget && !creating) handleClose() }}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="创建项目">
        <div className="modal__head">
          <span>创建项目</span>
          <button className="icon-btn" onClick={handleClose} disabled={creating} aria-label="关闭">
            <IconClose size={14} />
          </button>
        </div>

        <TabStrip
          label="创建方式"
          active={tab}
          onChange={setTab}
          items={[
            { id: 'empty', label: '创建空项目' },
            { id: 'clone', label: '从远端克隆' },
          ]}
        />

        {tab === 'empty' ? (
          <>
            <div className="modal__body">
              <label className="field">
                <span className="field__label">父目录</span>
                <div className="create-project__dir-row">
                  <input
                    className="field__input mono"
                    value={emptyParent}
                    onChange={(e) => setEmptyParent(e.target.value)}
                    placeholder="选择一个目录作为父目录"
                  />
                  <button className="btn btn--ghost btn--sm" onClick={pickEmptyParent} title="浏览选择">
                    <IconFolder size={13} />
                  </button>
                </div>
                <span className="field__hint">新项目将创建在此目录下</span>
              </label>
              <label className="field">
                <span className="field__label">项目名称</span>
                <input
                  className="field__input mono"
                  value={emptyName}
                  onChange={(e) => setEmptyName(e.target.value)}
                  placeholder="my-project"
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateEmpty() }}
                />
              </label>
            </div>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={handleClose} disabled={creating}>取消</button>
              <button
                className="btn btn--primary"
                onClick={handleCreateEmpty}
                disabled={!emptyName.trim() || !emptyParent.trim() || creating}
              >
                {creating ? '创建中…' : '创建'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal__body">
              <label className="field">
                <span className="field__label">父目录</span>
                <div className="create-project__dir-row">
                  <input
                    className="field__input mono"
                    value={cloneParent}
                    onChange={(e) => setCloneParent(e.target.value)}
                    placeholder="选择一个目录存放克隆的仓库"
                  />
                  <button className="btn btn--ghost btn--sm" onClick={pickCloneParent} title="浏览选择">
                    <IconFolder size={13} />
                  </button>
                </div>
                <span className="field__hint">每个仓库克隆为子目录；单仓库直接打开该子目录</span>
              </label>

              <div className="field">
                <span className="field__label">仓库地址</span>
                <div className="create-project__urls">
                  {cloneUrls.map((url, i) => {
                    const row = rowStates[i] ?? IDLE_ROW
                    const cl = cloneRows[i]
                    return (
                      <div key={i} className="create-project__url-block">
                        <div className="create-project__url-row">
                          <input
                            className="field__input mono"
                            value={url}
                            onChange={(e) => updateCloneUrl(i, e.target.value)}
                            placeholder="https://github.com/user/repo.git"
                            disabled={creating}
                          />
                          <button
                            className="btn btn--ghost btn--sm create-project__test-btn"
                            onClick={() => void testCloneUrl(i)}
                            disabled={!url.trim() || row.status === 'testing' || creating}
                            title="验证远端仓库是否有效并列出分支"
                          >
                            {row.status === 'testing' ? '测试中…' : '测试连接'}
                          </button>
                          {row.status === 'ok' && row.branches.length > 0 && (
                            <div className="create-project__branch">
                              <Select
                                value={row.branch}
                                onChange={(v) => setRowStates((prev) => ({ ...prev, [i]: { ...prev[i], branch: v } }))}
                                options={row.branches.map((b) => ({ value: b, label: b }))}
                                searchable
                                ariaLabel="选择分支"
                                placeholder="选择分支"
                              />
                            </div>
                          )}
                          {cloneUrls.length > 1 && (
                            <button className="icon-btn" onClick={() => removeCloneUrl(i)} disabled={creating} aria-label="移除" title="移除此地址">
                              <IconTrash size={12} />
                            </button>
                          )}
                        </div>
                        {row.status === 'ok' && (
                          <div className="notice notice--ok create-project__row-notice">
                            仓库有效 · {row.branches.length} 个分支{row.branch ? `，将克隆「${row.branch}」` : ''}
                          </div>
                        )}
                        {row.status === 'fail' && (
                          <div className="notice notice--err create-project__row-notice">{row.error}</div>
                        )}
                        {cl && (
                          <div className={`create-project__clone create-project__clone--${cl.state}`}>
                            <span className="create-project__clone-text">
                              {cl.state === 'done' ? '✓ 已克隆'
                                : cl.state === 'error' ? `✗ ${cl.error || '克隆失败'}`
                                : `${cl.stage}${cl.state === 'cloning' && cl.pct != null ? ` ${cl.pct}%` : ''}`}
                            </span>
                            {(cl.state === 'queued' || cl.state === 'cloning') && (
                              <div
                                className={`create-project__progress ${cl.pct == null ? 'create-project__progress--indeterminate' : ''}`}
                                role="progressbar"
                                aria-label={`${url || '仓库'} 克隆进度`}
                                aria-valuenow={cl.pct ?? undefined}
                                aria-valuemin={cl.pct == null ? undefined : 0}
                                aria-valuemax={cl.pct == null ? undefined : 100}
                              >
                                <div className="create-project__progress-fill" style={cl.pct == null ? undefined : { width: `${cl.pct}%` }} />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <button className="btn btn--ghost btn--sm" onClick={addCloneUrl} disabled={creating} style={{ marginTop: 6 }}>
                  <IconPlus size={12} /> 添加仓库
                </button>
              </div>
            </div>

            <div className="modal__actions">
              {/* 汇总只报完成数/进行数（不带 pct）：状态变化才有意义，避免逐百分比刷屏读屏 */}
              <span className="create-project__clone-summary" role="status" aria-atomic="true">
                {creating
                  ? `克隆中 · 已完成 ${Object.values(cloneRows).filter((c) => c.state === 'done').length} / ${Object.values(cloneRows).length}`
                  : ''}
              </span>
              <button className="btn btn--ghost" onClick={handleClose} disabled={creating}>关闭</button>
              {creating && (
                <button className="btn btn--ghost" onClick={() => void api.cloneCancel()}>取消克隆</button>
              )}
              <button
                className="btn btn--primary"
                onClick={handleClone}
                disabled={!cloneUrls.some((u) => u.trim()) || !cloneParent.trim() || creating}
                aria-busy={creating}
              >
                {creating ? '克隆中…' : '克隆'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
