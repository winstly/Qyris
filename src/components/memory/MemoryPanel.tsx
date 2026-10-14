/**
 * 记忆面板（工作区「记忆」Tab）：严格单一面板模式——
 * 顶部工具条（搜索 + 层级/分类筛选 + 导出/导入/清空/整理）→ 主体唯一滚动列表
 * （行式条目，行上按钮：编辑/转换/删除；编辑走 MemoryEditModal 弹窗）→ 底部状态条。
 * 数据按当前工程加载（useAppStore.projectPath），无工程时显示全局记忆。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, onMemoryChanged, onMemoryExtractState } from '@/services/desktop'
import { useAppStore } from '@/store/useAppStore'
import { useMemoryStore, type MemoryCategoryFilter, type MemoryTierFilter } from '@/store/useMemoryStore'
import { MemoryItemRow, MEMORY_CATEGORY_LABELS, memoryDetailRows, archivedText } from './MemoryItemRow'
import { DetailDialog } from '@/components/common/DetailDialog'
import { MemoryEditModal } from './MemoryEditModal'
import { EmptyState } from '@/components/common/EmptyState'
import { Notice, useNotice } from '@/components/common/Notice'
import { Select } from '@/components/common/Select'
import { IconAlert, IconClose, IconLayers, IconSearch } from '@/components/common/icons'
import { timeAgo } from '@/utils/time'
import type { MemoryItem, MemoryLastTidy } from '@/types'
import type { MemoryUpdatePatch } from '@/store/useMemoryStore'

export function MemoryPanel() {
  const projectPath = useAppStore((s) => s.projectPath)
  const projectName = useAppStore((s) => s.projectName)
  const showConfirm = useAppStore((s) => s.showConfirm)
  const showAlert = useAppStore((s) => s.showAlert)
  const activeTab = useAppStore((s) => s.activeTab)

  const items = useMemoryStore((s) => s.items)
  const hits = useMemoryStore((s) => s.hits)
  const archivedSuggest = useMemoryStore((s) => s.archivedSuggest)
  const tierFilter = useMemoryStore((s) => s.tierFilter)
  const categoryFilter = useMemoryStore((s) => s.categoryFilter)
  const statusFilter = useMemoryStore((s) => s.statusFilter)
  const loading = useMemoryStore((s) => s.loading)
  const degraded = useMemoryStore((s) => s.degraded)
  const error = useMemoryStore((s) => s.error)
  const stats = useMemoryStore((s) => s.stats)
  const load = useMemoryStore((s) => s.load)
  const search = useMemoryStore((s) => s.search)
  const setQuery = useMemoryStore((s) => s.setQuery)
  const setTierFilter = useMemoryStore((s) => s.setTierFilter)
  const setCategoryFilter = useMemoryStore((s) => s.setCategoryFilter)
  const setStatusFilter = useMemoryStore((s) => s.setStatusFilter)
  const update = useMemoryStore((s) => s.update)
  const remove = useMemoryStore((s) => s.remove)
  const restore = useMemoryStore((s) => s.restore)
  const moveScope = useMemoryStore((s) => s.moveScope)
  const clear = useMemoryStore((s) => s.clear)
  const extractingProjects = useMemoryStore((s) => s.extractingProjects)
  const setExtracting = useMemoryStore((s) => s.setExtracting)

  /** 输入框实时值；防抖 300ms 后才提交为检索词 */
  const [input, setInput] = useState('')
  /** 编辑弹窗目标（打开时以该条目快照初始化草稿，弹窗自持） */
  const [editingItem, setEditingItem] = useState<MemoryItem | null>(null)
  const [viewingItem, setViewingItem] = useState<MemoryItem | null>(null)
  /** 「立即整理」运行态与结果提示（ok/err，6s 自清） */
  const [tidying, setTidying] = useState(false)
  const [runNotice, setRunNotice] = useNotice()
  /** 「上次整理」摘要条（有变化才出现；点「知道了」后同批不再出现——已读游标落 localStorage）。
   *  localStorage 读写带守卫：非浏览器环境（测试渲染）无此全局 */
  const [tidy, setTidy] = useState<MemoryLastTidy | null>(null)
  const [tidyDismissedTs, setTidyDismissedTs] = useState(() => {
    try {
      return Number(globalThis.localStorage?.getItem('mem_tidy_dismissed_ts') ?? 0)
    } catch {
      return 0
    }
  })
  /** 导出/导入运行态（导入含嵌入可能秒级；二者互斥防并发弹框） */
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)

  /** 后台整理中（主进程事件驱动）；busy = 手动 tidying 或后台 extracting，非查询操作禁用 */
  const extracting = !!projectPath && extractingProjects.has(projectPath)
  const busy = tidying || extracting

  /** 用户在主进程弹框点了取消：静默回 ok=false + 取消文案，不打扰 */
  const isCancelled = (err?: string): boolean => !!err && err.includes('取消')

  // 搜索防抖：有词 300ms 后提交 memorySearch，清空立即回退 memoryList；
  // 切工程（重挂/projectPath 变化）走同一入口
  useEffect(() => {
    const q = input.trim()
    const timer = window.setTimeout(() => {
      setQuery(q)
      if (q) void search(q, projectPath)
      else void load(projectPath)
    }, q ? 300 : 0)
    return () => window.clearTimeout(timer)
  }, [input, projectPath, load, search, setQuery])

  // 订阅主进程整理状态事件：后台/手动整理开始 → 禁用操作，结束 → 恢复
  useEffect(() => {
    return onMemoryExtractState(({ projectRoot, extracting: on }) => {
      setExtracting(projectRoot, on)
    })
  }, [setExtracting])

  // 「上次整理」快照：挂载/切工程拉一次（摘要条数据源）
  useEffect(() => {
    void api.memoryLastTidy().then(setTidy).catch(() => {})
  }, [projectPath])

  // 订阅记忆数据变更广播（R6）：任意工程/窗口写完记忆后重放当前视图入口（与刷新按钮同路，
  // store 内 reqSeq 防串工程）。500ms 防抖合并突发；搜索输入非空时跳过，不打掉检索时点结果。
  const inputRef = useRef('')
  inputRef.current = input
  useEffect(() => {
    let timer: number | undefined
    const off = onMemoryChanged(() => {
      if (inputRef.current.trim()) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const p = useAppStore.getState().projectPath
        const q = useMemoryStore.getState().query
        if (q) void search(q, p)
        else void load(p)
      }, 500)
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [load, search])

  // 切到记忆 Tab 自动刷新（并同步当前整理状态）
  useEffect(() => {
    if (activeTab !== 'memory') return
    const p = useAppStore.getState().projectPath
    const q = useMemoryStore.getState().query
    if (q) void search(q, p)
    else void load(p)
    if (p) void api.memoryExtracting(p).then((on) => setExtracting(p, on)).catch(() => {})
  }, [activeTab, load, search, setExtracting])

  // 搜索态（hits 非 null）以命中为准，筛选仍在渲染层叠加
  // 项目记忆 Tab：过滤掉 global 条目（用户记忆在左侧面板）。
  // 归档档含 merged（被折叠条目也是历史痕迹，不许在两档之间隐形）
  const visible = useMemo(() => {
    const source = (hits ?? items).filter((it) => it.projectKey !== 'global')
    return source.filter((it) =>
      (statusFilter === 'active' ? it.status === 'active' : it.status !== 'active') &&
      (tierFilter === 'all' || it.tier === tierFilter) &&
      (categoryFilter === 'all' || it.category === categoryFilter),
    )
  }, [hits, items, statusFilter, tierFilter, categoryFilter])

  const searching = hits !== null

  // 状态分段计数（按当前工程口径，排除 global）：归档数本身就是信任信号——系统不藏
  const statusCounts = useMemo(() => {
    const proj = items.filter((it) => it.projectKey !== 'global')
    return {
      active: proj.filter((it) => it.status === 'active').length,
      archived: proj.filter((it) => it.status !== 'active').length,
    }
  }, [items])

  /** 弹窗保存：成功返回 true（弹窗自关），失败弹错误条返回 false（弹窗保留草稿） */
  const onSave = async (id: string, patch: MemoryUpdatePatch): Promise<boolean> => {
    try {
      await update(id, patch)
      return true
    } catch (e) {
      void showAlert('保存记忆失败', String(e))
      return false
    }
  }

  const onDelete = async (id: string, title: string) => {
    if ((await showConfirm('删除记忆', `确定删除「${title}」？删除后不可恢复。`)) !== true) return
    try {
      await remove(id)
    } catch (e) {
      void showAlert('删除记忆失败', String(e))
    }
  }

  /** 升级为用户记忆（项目 → 跨工程）：confirm 后走 store.moveScope */
  const onMoveScope = async (id: string, title: string) => {
    if (!projectPath) return
    const ok = await showConfirm('升级为用户记忆', `将「${title}」升级为跨工程用户记忆？之后在所有工程都能检索到。`)
    if (ok !== true) return
    try {
      await moveScope(id, 'user', projectPath)
    } catch (e) {
      void showAlert('转换失败', String(e))
    }
  }

  /** 恢复归档条目：失败（同题已有活跃条目撞唯一索引）弹窗告知，不静默 */
  const onRestore = async (id: string, title: string) => {
    try {
      await restore(id)
      setRunNotice({ kind: 'ok', text: `已恢复「${title}」，重新参与检索。` })
    } catch (e) {
      void showAlert('恢复失败', String(e))
    }
  }

  /** 重新整理：确认后执行，全量重扫会消耗较多 token */
  const onRunNow = async () => {
    if (!projectPath || busy) return
    const ok = await showConfirm(
      '重新整理记忆',
      '将基于当前会话重新提取记忆，可能消耗较多 token。确定继续？',
    )
    if (ok !== true) return
    setTidying(true)
    setRunNotice({ kind: 'ok', text: '正在整理记忆，请稍候…' })
    try {
      const r = await api.memoryRunNow(projectPath)
      if (r.ok) {
        const ops = r.ops ?? 0
        const t = r.tidy
        const breakdown = t ? tidyBreakdown(t) : ''
        setRunNotice({
          kind: 'ok',
          text: ops > 0
            ? `整理完成：${breakdown || `新增/更新了 ${ops} 条记忆`}。`
            : '整理完成：最近对话暂无值得沉淀的新记忆。',
        })
        void api.memoryLastTidy().then(setTidy).catch(() => {})
        // 自动刷新列表
        if (input.trim()) await search(input.trim(), projectPath)
        else await load(projectPath)
      } else {
        setRunNotice({ kind: 'err', text: r.error || '整理失败，请稍后重试。' })
      }
    } catch (e) {
      setRunNotice({ kind: 'err', text: String(e) })
    } finally {
      setTidying(false)
    }
  }

  /** 记忆导出：当前面板范围（有工程=该工程，无工程=全局；不做 all 入口），主进程弹保存框 */
  const onExport = async () => {
    if (exporting || importing) return
    setExporting(true)
    setRunNotice(null)
    try {
      const r = await api.memoryExport(projectPath ? 'project' : 'global', projectPath ?? undefined)
      if (r.ok) setRunNotice({ kind: 'ok', text: `已导出 ${r.count ?? 0} 条记忆：${r.path ?? ''}` })
      else if (isCancelled(r.error)) setRunNotice(null)
      else setRunNotice({ kind: 'err', text: r.error || '导出失败，请稍后重试。' })
    } catch (e) {
      setRunNotice({ kind: 'err', text: String(e) })
    } finally {
      setExporting(false)
    }
  }

  /** 记忆导入：主进程弹打开框读 JSON 备份（同 id 跳过），完成后刷新当前范围列表与统计 */
  const onImport = async () => {
    if (exporting || importing) return
    setImporting(true)
    setRunNotice(null)
    try {
      const r = await api.memoryImport()
      if (r.ok) {
        setRunNotice({ kind: 'ok', text: `导入完成：新增 ${r.imported ?? 0} 条，跳过 ${r.skipped ?? 0} 条。` })
        if (input.trim()) await search(input.trim(), projectPath)
        else await load(projectPath)
      } else if (isCancelled(r.error)) setRunNotice(null)
      else setRunNotice({ kind: 'err', text: r.error || '导入失败，请稍后重试。' })
    } catch (e) {
      setRunNotice({ kind: 'err', text: String(e) })
    } finally {
      setImporting(false)
    }
  }

  const onClear = async () => {
    if (!projectPath) return
    const ok = await showConfirm('清空记忆', `确定清空工程「${projectName}」的全部记忆吗？此操作不可撤销。`)
    if (ok !== true) return
    try {
      await clear('project', projectPath)
      setInput('')
    } catch (e) {
      void showAlert('清空记忆失败', String(e))
    }
  }

  return (
    <div className="memory">
      <div className="memory__bar">
        <div className="memory__search">
          <IconSearch size={12} />
          <input
            className="memory__search-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="搜索…"
            aria-label="搜索记忆"
          />
          {input && (
            <button className="memory__search-clear" onClick={() => setInput('')} aria-label="清空搜索" title="清空搜索">
              <IconClose size={11} />
            </button>
          )}
        </div>
        <div className="memory__status-seg" role="tablist" aria-label="状态筛选">
          <button
            role="tab"
            aria-selected={statusFilter === 'active'}
            className={`memory__status-seg-btn ${statusFilter === 'active' ? 'is-active' : ''}`}
            onClick={() => setStatusFilter('active')}
          >
            进行中 {statusCounts.active}
          </button>
          <button
            role="tab"
            aria-selected={statusFilter === 'archived'}
            className={`memory__status-seg-btn ${statusFilter === 'archived' ? 'is-active' : ''}`}
            onClick={() => setStatusFilter('archived')}
          >
            已归档 {statusCounts.archived}
          </button>
        </div>
        <Select
          size="sm"
          value={tierFilter}
          onChange={(v) => setTierFilter(v as MemoryTierFilter)}
          ariaLabel="层级筛选"
          options={[
            { value: 'all', label: '全部层级' },
            { value: 'long', label: '长期' },
            { value: 'short', label: '短期' },
          ]}
        />
        <Select
          size="sm"
          value={categoryFilter}
          onChange={(v) => setCategoryFilter(v as MemoryCategoryFilter)}
          ariaLabel="分类筛选"
          options={[
            { value: 'all', label: '全部分类' },
            ...Object.entries(MEMORY_CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
          ]}
        />
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => { if (projectPath) void load(projectPath) }}
          title="刷新列表"
        >
          刷新
        </button>
        <div className="memory__spacer" />
        <button
          className="btn btn--ghost btn--sm"
          disabled={!projectPath || busy}
          title={!projectPath ? '需先打开工程' : busy ? '整理中…' : '立即整理'}
          onClick={() => void onRunNow()}
        >
          {busy ? (<><span className="memory__spinner" />整理中…</>) : '重新整理'}
        </button>
        <button className="btn btn--ghost btn--sm" disabled={exporting || importing || busy} onClick={() => void onExport()}>
          {exporting ? '⏳' : '导出'}
        </button>
        <button className="btn btn--ghost btn--sm" disabled={exporting || importing || busy} onClick={() => void onImport()}>
          {importing ? '⏳' : '导入'}
        </button>
        <button className="btn btn--danger-ghost btn--sm" disabled={!projectPath || busy} onClick={() => void onClear()}>
          清空
        </button>
      </div>

      <Notice notice={runNotice} />

      {/* 「上次整理」摘要条：有变化且未读才出现——被动面收口，永不主动 toast 打扰 */}
      {tidy && tidy.ts > tidyDismissedTs && (tidy.saved + tidy.updated + tidy.archived > 0) && (
        <div className="memory__tidy-bar">
          <span>
            上次整理（{timeAgo(tidy.ts)}）：{tidyBreakdown(tidy)}
          </span>
          <button
            className="icon-btn"
            aria-label="知道了"
            title="知道了"
            onClick={() => {
              try {
                globalThis.localStorage?.setItem('mem_tidy_dismissed_ts', String(tidy.ts))
              } catch { /* 非浏览器环境 */ }
              setTidyDismissedTs(tidy.ts)
            }}
          >
            <IconClose size={11} />
          </button>
        </div>
      )}

      {searching && degraded && (
        <div className="memory__degraded">
          <IconAlert size={13} />
          <span>语义检索降级中，当前为关键词匹配结果</span>
        </div>
      )}

      <div className="memory__list" role="list" aria-label="记忆列表">
        {loading ? (
          <div className="memory__loading"><span className="memory__spinner" />加载中…</div>
        ) : error ? (
          <Notice notice={{ kind: 'err', text: `记忆加载失败：${error}` }} />
        ) : visible.length === 0 ? (
          searching || input.trim() ? (
            <div className="memory__empty-inline">
              没有匹配的记忆
              {/* 归档召回：「想起以前记过、被收起来了」——把「丢失」反转成「回忆」 */}
              {archivedSuggest.length > 0 && (
                <div className="memory__recall">
                  {archivedSuggest.map((h) => (
                    <div key={h.id} className="memory__recall-row">
                      <span>归档里有相近记忆：「{h.title}」（{archivedText(h) || '已收起'}）</span>
                      <button className="btn btn--ghost btn--sm" onClick={() => void onRestore(h.id, h.title)}>恢复</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              icon={<IconLayers size={22} />}
              title="暂无记忆"
              text="对话中会自动沉淀记忆，也可点「重新整理」立即归纳"
            />
          )
        ) : (
          visible.map((it) => (
            <MemoryItemRow
              key={it.id}
              item={it}
              onDetail={() => setViewingItem(it)}
              onEdit={() => setEditingItem(it)}
              onDelete={() => void onDelete(it.id, it.title)}
              onRestore={() => void onRestore(it.id, it.title)}
              onMoveScope={it.category === 'summary' ? undefined : () => void onMoveScope(it.id, it.title)}
              moveScopeTitle="升级为用户记忆"
              readOnly={busy}
            />
          ))
        )}
      </div>

      {viewingItem && (
        <DetailDialog
          title={viewingItem.title}
          rows={memoryDetailRows(viewingItem)}
          onClose={() => setViewingItem(null)}
          footer={
            <button className="btn btn--primary" onClick={() => { const s = viewingItem; setViewingItem(null); setEditingItem(s) }}>
              编辑
            </button>
          }
        />
      )}
      {editingItem && (
        <MemoryEditModal
          item={editingItem}
          onSave={(patch) => onSave(editingItem.id, patch)}
          onClose={() => setEditingItem(null)}
          readOnly={busy}
        />
      )}

      <div className="memory__status">
        <span className="memory__scope">{projectPath ? `工程「${projectName}」` : '全局'}</span>
        <span className="memory__status-sep">·</span>
        <span>{stats ? `共 ${stats.activeCount} 条` : '—'}</span>
        <span className="memory__status-sep">·</span>
        <span>{stats ? fmtBytes(stats.dbBytes) : '—'}</span>
        {stats?.distillTokens && (stats.distillTokens.input + stats.distillTokens.output) > 0 && (
          <>
            <span className="memory__status-sep">·</span>
            <span title="蒸馏消耗 token（近似）">蒸馏 {fmtTokens(stats.distillTokens.input + stats.distillTokens.output)}</span>
          </>
        )}
        <span className={`memory__status-dot ${stats?.embedReady ? 'memory__status-dot--ok' : ''}`} />
      </div>
    </div>
  )
}

/** 「上次整理」拆账文案：新增/更新/归档分说（合说「更新 N 条」对不上用户词汇表） */
function tidyBreakdown(t: MemoryLastTidy): string {
  return [
    t.saved ? `新增 ${t.saved}` : '',
    t.updated ? `更新 ${t.updated}` : '',
    t.archived ? `归档 ${t.archived}` : '',
  ].filter(Boolean).join(' · ')
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(1)}M`
}
