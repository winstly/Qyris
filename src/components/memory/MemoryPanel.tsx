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
import { MemoryItemRow, MEMORY_CATEGORY_LABELS } from './MemoryItemRow'
import { MemoryEditModal } from './MemoryEditModal'
import { EmptyState } from '@/components/common/EmptyState'
import { Select } from '@/components/common/Select'
import { IconAlert, IconCheck, IconClose, IconLayers, IconSearch } from '@/components/common/icons'
import type { MemoryItem } from '@/types'
import type { MemoryUpdatePatch } from '@/store/useMemoryStore'

export function MemoryPanel() {
  const projectPath = useAppStore((s) => s.projectPath)
  const projectName = useAppStore((s) => s.projectName)
  const showConfirm = useAppStore((s) => s.showConfirm)
  const showAlert = useAppStore((s) => s.showAlert)
  const activeTab = useAppStore((s) => s.activeTab)

  const items = useMemoryStore((s) => s.items)
  const hits = useMemoryStore((s) => s.hits)
  const tierFilter = useMemoryStore((s) => s.tierFilter)
  const categoryFilter = useMemoryStore((s) => s.categoryFilter)
  const loading = useMemoryStore((s) => s.loading)
  const degraded = useMemoryStore((s) => s.degraded)
  const error = useMemoryStore((s) => s.error)
  const stats = useMemoryStore((s) => s.stats)
  const load = useMemoryStore((s) => s.load)
  const search = useMemoryStore((s) => s.search)
  const setQuery = useMemoryStore((s) => s.setQuery)
  const setTierFilter = useMemoryStore((s) => s.setTierFilter)
  const setCategoryFilter = useMemoryStore((s) => s.setCategoryFilter)
  const update = useMemoryStore((s) => s.update)
  const remove = useMemoryStore((s) => s.remove)
  const moveScope = useMemoryStore((s) => s.moveScope)
  const clear = useMemoryStore((s) => s.clear)
  const extractingProjects = useMemoryStore((s) => s.extractingProjects)
  const setExtracting = useMemoryStore((s) => s.setExtracting)

  /** 输入框实时值；防抖 300ms 后才提交为检索词 */
  const [input, setInput] = useState('')
  /** 编辑弹窗目标（打开时以该条目快照初始化草稿，弹窗自持） */
  const [editingItem, setEditingItem] = useState<MemoryItem | null>(null)
  /** 「立即整理」运行态与结果提示（ok/err，保留到下次操作） */
  const [tidying, setTidying] = useState(false)
  const [runNotice, setRunNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
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

  // 提示语自动消失（成功/失败统一 6s）
  useEffect(() => {
    if (!runNotice) return
    const timer = window.setTimeout(() => setRunNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [runNotice])

  // 搜索态（hits 非 null）以命中为准，筛选仍在渲染层叠加
  // 项目记忆 Tab：过滤掉 global 条目（用户记忆在左侧面板）
  const visible = useMemo(() => {
    const source = (hits ?? items).filter((it) => it.projectKey !== 'global')
    return source.filter((it) =>
      (tierFilter === 'all' || it.tier === tierFilter) &&
      (categoryFilter === 'all' || it.category === categoryFilter),
    )
  }, [hits, items, tierFilter, categoryFilter])

  const searching = hits !== null

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
        const ops = (r as { ops?: number }).ops ?? 0
        setRunNotice({
          kind: 'ok',
          text: ops > 0
            ? `整理完成：新增/更新了 ${ops} 条记忆。`
            : '整理完成：最近对话暂无值得沉淀的新记忆。',
        })
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

      {runNotice && (
        <div className={`notice ${runNotice.kind === 'ok' ? 'notice--ok' : 'notice--err'}`}>
          {runNotice.kind === 'ok' ? <IconCheck size={14} /> : <IconAlert size={14} />}
          <span>{runNotice.text}</span>
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
          <div className="notice notice--err">
            <IconAlert size={14} />
            <span>记忆加载失败：{error}</span>
          </div>
        ) : visible.length === 0 ? (
          searching || input.trim() ? (
            <div className="memory__empty-inline">没有匹配的记忆</div>
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
              onEdit={() => setEditingItem(it)}
              onDelete={() => void onDelete(it.id, it.title)}
              onMoveScope={it.category === 'summary' ? undefined : () => void onMoveScope(it.id, it.title)}
              moveScopeTitle="升级为用户记忆"
              readOnly={busy}
            />
          ))
        )}
      </div>

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
        <span>{stats ? `共 ${stats.total} 条` : '—'}</span>
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
