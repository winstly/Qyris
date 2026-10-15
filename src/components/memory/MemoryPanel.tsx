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
import { Notice } from '@/components/common/Notice'
import { Pager, usePaged, PAGE_SIZE } from '@/components/common/Pager'
import { Select } from '@/components/common/Select'
import { toast } from '@/components/common/Toast'
import { IconAlert, IconClose, IconLayers, IconSearch } from '@/components/common/icons'
import { timeAgo } from '@/utils/time'
import type { MemoryItem, MemoryLastTidy } from '@/types'
import type { MemoryUpdatePatch } from '@/store/useMemoryStore'

export function MemoryPanel() {
  const projectPath = useAppStore((s) => s.projectPath)
  const projectName = useAppStore((s) => s.projectName)
  const showConfirm = useAppStore((s) => s.showConfirm)
  const activeTab = useAppStore((s) => s.activeTab)

  const items = useMemoryStore((s) => s.items)
  const hits = useMemoryStore((s) => s.hits)
  const query = useMemoryStore((s) => s.query)
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
  const create = useMemoryStore((s) => s.create)
  const refreshStats = useMemoryStore((s) => s.refreshStats)
  const extractingProjects = useMemoryStore((s) => s.extractingProjects)
  const setExtracting = useMemoryStore((s) => s.setExtracting)

  /** 输入框实时值；防抖 300ms 后才提交为检索词 */
  const [input, setInput] = useState('')
  /** 编辑弹窗目标（打开时以该条目快照初始化草稿，弹窗自持）；null+creating=true = 新增 */
  const [editingItem, setEditingItem] = useState<MemoryItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [viewingItem, setViewingItem] = useState<MemoryItem | null>(null)
  /** 「立即整理」运行态（结果走 toast 反馈） */
  const [tidying, setTidying] = useState(false)
  /** 「上次整理」摘要条（有变化才出现；点「知道了」后同批不再出现——已读游标按工程落
   *  localStorage，快照本身也按工程分键，互不串账）。localStorage 读写带守卫：非浏览器
   *  环境（测试渲染）无此全局 */
  const [tidy, setTidy] = useState<MemoryLastTidy | null>(null)
  const tidyDismissKey = `mem_tidy_dismissed_ts:${projectPath ?? 'global'}`
  const [tidyDismissedTs, setTidyDismissedTs] = useState(0)
  // 挂载/切工程：拉本工程的「上次整理」快照 + 已读游标（快照与游标同键空间，跨项目不串）
  useEffect(() => {
    void api.memoryLastTidy(projectPath).then(setTidy).catch(() => {})
    try {
      setTidyDismissedTs(Number(globalThis.localStorage?.getItem(tidyDismissKey) ?? 0))
    } catch {
      setTidyDismissedTs(0)
    }
  }, [projectPath, tidyDismissKey])
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

  // 分页：切工程/换搜索词/换筛选回第一页；数据量收缩由 safePage 钳制
  const paged = usePaged(
    visible,
    PAGE_SIZE,
    `${projectPath ?? ''}|${query}|${statusFilter}|${tierFilter}|${categoryFilter}`,
  )

  // 状态分段计数（按当前工程口径，排除 global）：归档数本身就是信任信号——系统不藏
  const statusCounts = useMemo(() => {
    const proj = items.filter((it) => it.projectKey !== 'global')
    return {
      active: proj.filter((it) => it.status === 'active').length,
      archived: proj.filter((it) => it.status !== 'active').length,
    }
  }, [items])

  /** 弹窗保存：成功 toast + 返回 true（弹窗自关），失败 toast 返回 false（弹窗保留草稿） */
  const onSave = async (id: string, patch: MemoryUpdatePatch): Promise<boolean> => {
    try {
      await update(id, patch)
      toast.ok('已保存记忆', `「${patch.title}」已更新。`)
      return true
    } catch (e) {
      toast.err('保存记忆失败', String(e))
      return false
    }
  }

  const onDelete = async (id: string, title: string) => {
    if ((await showConfirm('删除记忆', `确定删除「${title}」？删除后不可恢复。`)) !== true) return
    try {
      await remove(id)
      toast.ok('已删除记忆', `「${title}」已删除。`)
    } catch (e) {
      toast.err('删除记忆失败', String(e))
    }
  }

  /** 升级为用户记忆（项目 → 跨工程）：confirm 后走 store.moveScope */
  const onMoveScope = async (id: string, title: string) => {
    if (!projectPath) return
    const ok = await showConfirm('升级为用户记忆', `将「${title}」升级为跨工程用户记忆？之后在所有工程都能检索到。`)
    if (ok !== true) return
    try {
      await moveScope(id, 'user', projectPath)
      toast.ok('已升级为用户记忆', `「${title}」现在所有工程都能检索到。`)
    } catch (e) {
      toast.err('转换失败', String(e))
    }
  }

  /** 恢复归档条目：失败（同题已有活跃条目撞唯一索引）toast 告知，不静默 */
  const onRestore = async (id: string, title: string) => {
    try {
      await restore(id)
      toast.ok('已恢复记忆', `「${title}」已恢复，重新参与检索。`)
    } catch (e) {
      toast.err('恢复失败', String(e))
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
    try {
      const r = await api.memoryRunNow(projectPath)
      if (r.ok) {
        const ops = r.ops ?? 0
        const t = r.tidy
        const breakdown = t ? tidyBreakdown(t) : ''
        toast.ok(
          '整理完成',
          ops > 0
            ? `${breakdown || `新增/更新了 ${ops} 条记忆`}。`
            : '最近对话暂无值得沉淀的新记忆。',
        )
        void api.memoryLastTidy(projectPath).then(setTidy).catch(() => {})
        // 自动刷新列表
        if (input.trim()) await search(input.trim(), projectPath)
        else await load(projectPath)
      } else {
        toast.err('整理失败', r.error || '整理失败，请稍后重试。')
      }
    } catch (e) {
      toast.err('整理失败', String(e))
    } finally {
      setTidying(false)
    }
  }

  /** 记忆导出：当前面板范围（有工程=该工程，无工程=全局；不做 all 入口），主进程弹保存框 */
  const onExport = async () => {
    if (exporting || importing) return
    setExporting(true)
    try {
      const r = await api.memoryExport(projectPath ? 'project' : 'global', projectPath ?? undefined)
      if (r.ok) toast.ok('导出完成', `已导出 ${r.count ?? 0} 条记忆：\n${r.path ?? ''}`)
      else if (!isCancelled(r.error)) toast.err('导出失败', r.error || '导出失败，请稍后重试。')
    } catch (e) {
      toast.err('导出失败', String(e))
    } finally {
      setExporting(false)
    }
  }

  /** 记忆导入：主进程弹打开框读 JSON 备份（同 id 跳过），完成后刷新当前范围列表与统计 */
  const onImport = async () => {
    if (exporting || importing) return
    setImporting(true)
    try {
      const r = await api.memoryImport()
      if (r.ok) {
        toast.ok('导入完成', `新增 ${r.imported ?? 0} 条，跳过 ${r.skipped ?? 0} 条。`)
        if (input.trim()) await search(input.trim(), projectPath)
        else await load(projectPath)
      } else if (!isCancelled(r.error)) toast.err('导入失败', r.error || '导入失败，请稍后重试。')
    } catch (e) {
      toast.err('导入失败', String(e))
    } finally {
      setImporting(false)
    }
  }

  /** 手动新增一条工程记忆：弹 create 模式编辑弹窗，保存走 store.create（origin 主进程钉 user_explicit）。
   *  同题活跃条目已存在时主进程折叠/取代（folded=true）——列表条数不涨，toast 说明避免「像失败」 */
  const onCreateSave = async (patch: MemoryUpdatePatch): Promise<boolean> => {
    if (!projectPath) return false
    try {
      const { folded } = await create({
        projectRoot: projectPath,
        tier: 'long',
        category: patch.category ?? 'fact',
        title: patch.title ?? '',
        content: patch.content ?? '',
        importance: patch.importance,
      })
      if (input.trim()) await search(input.trim(), projectPath)
      else await load(projectPath)
      if (folded) toast.info('已合并到既有记忆', `已有同分类同标题的活跃记忆「${patch.title}」，内容已更新进去（旧版本归档留痕）。`)
      else toast.ok('已新增记忆', `「${patch.title}」已保存为工程记忆。`)
      return true
    } catch (e) {
      toast.err('新增记忆失败', String(e))
      return false
    }
  }

  /** 蒸馏 token 计数重置：只清统计数字，不动记忆数据 */
  const onResetDistill = async () => {
    const ok = await showConfirm('重置蒸馏计数', '将把「蒸馏」token 统计清零（仅统计数字，不影响任何记忆数据）。确定重置？')
    if (ok !== true) return
    try {
      await api.memoryResetDistillTokens()
      void refreshStats(projectPath)
      toast.ok('已重置蒸馏计数')
    } catch (e) {
      toast.err('重置失败', String(e))
    }
  }

  const onClear = async () => {
    if (!projectPath) return
    const ok = await showConfirm('清空记忆', `确定清空工程「${projectName}」的全部记忆吗？此操作不可撤销。`)
    if (ok !== true) return
    try {
      await clear('project', projectPath)
      setInput('')
      toast.ok('已清空工程记忆', `工程「${projectName}」的全部记忆已删除。`)
    } catch (e) {
      toast.err('清空记忆失败', String(e))
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
          title={projectPath ? '手动新增一条工程记忆' : '需先打开工程'}
          onClick={() => setCreating(true)}
        >
          新增
        </button>
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
                globalThis.localStorage?.setItem(tidyDismissKey, String(tidy.ts))
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
          paged.slice.map((it) => (
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

      <Pager page={paged.page} pageCount={paged.pageCount} total={paged.total} onPage={paged.setPage} />

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
      {creating && (
        <MemoryEditModal
          item={null}
          scopeHint={projectPath ? `保存为工程「${projectName}」的记忆（长期档，手动添加不会被自动归档打穿）` : undefined}
          onSave={onCreateSave}
          onClose={() => setCreating(false)}
          readOnly={busy}
        />
      )}

      <div className="memory__status">
        <span className="memory__scope">{projectPath ? `工程「${projectName}」` : '全局'}</span>
        <span className="memory__status-sep">·</span>
        {/* 计数与列表同范围出账（工程档只数本工程；global 档只数跨工程）——对不上即 bug */}
        <span>{stats ? `共 ${stats.activeCount} 条` : '—'}</span>
        <span className="memory__status-sep">·</span>
        <span>{stats ? fmtBytes(stats.dbBytes) : '—'}</span>
        {stats?.distillTokens && (stats.distillTokens.input + stats.distillTokens.output) > 0 && (
          <>
            <span className="memory__status-sep">·</span>
            <button
              className="memory__status-reset"
              title="蒸馏消耗 token（全局累计近似值）。点击重置为 0（仅统计数字，不影响记忆数据）"
              onClick={() => void onResetDistill()}
            >
              蒸馏 {fmtTokens(stats.distillTokens.input + stats.distillTokens.output)}
            </button>
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
