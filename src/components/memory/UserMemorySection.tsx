/**
 * 用户记忆（跨工程全局记忆）：左侧面板的「🧠 记忆」区域。
 * 只显示 project_key='global' 的条目，与项目记忆（工作区 Tab）互不干扰。
 * 功能：搜索 + 列表（编辑走 MemoryEditModal）+ ⋯ 菜单（导出全部/导入/清空，IPC 复用主进程原生对话框）+ 统计。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, onMemoryChanged } from '@/services/desktop'
import { useAppStore } from '@/store/useAppStore'
import { useMemoryStore } from '@/store/useMemoryStore'
import { MemoryItemRow } from './MemoryItemRow'
import { MemoryEditModal } from './MemoryEditModal'
import { EmptyState } from '@/components/common/EmptyState'
import { IconAlert, IconCheck, IconLayers, IconSearch, IconClose } from '@/components/common/icons'
import type { MemoryItem, MemoryHit } from '@/types'
import type { MemoryUpdatePatch } from '@/store/useMemoryStore'

const MENU_WIDTH = 140

export function UserMemorySection() {
  const update = useMemoryStore((s) => s.update)
  const remove = useMemoryStore((s) => s.remove)
  const clear = useMemoryStore((s) => s.clear)
  const showConfirm = useAppStore((s) => s.showConfirm)
  const showAlert = useAppStore((s) => s.showAlert)
  const projectPath = useAppStore((s) => s.projectPath)
  const projectName = useAppStore((s) => s.projectName)
  const extractingProjects = useMemoryStore((s) => s.extractingProjects)

  const [items, setItems] = useState<MemoryItem[]>([])
  const [hits, setHits] = useState<MemoryHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  /** 编辑弹窗目标（打开时以该条目快照初始化草稿，弹窗自持） */
  const [editingItem, setEditingItem] = useState<MemoryItem | null>(null)

  /** ⋯ 菜单：portal + fixed 定位（照 Select 惯例，摆脱滚动容器 overflow 裁剪） */
  const moreRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  /** 导出/导入运行态（导入含嵌入可能秒级；二者互斥防并发弹框） */
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  /** 操作结果提示（ok/err，6s 自清） */
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  /** 整理中（任意工程在蒸馏）→ 禁用写操作：用户记忆是跨工程全局，任何工程蒸馏都可能写它 */
  const busy = extractingProjects.size > 0

  /** 用户在主进程弹框点了取消：静默回 ok=false + 取消文案，不打扰 */
  const isCancelled = (err?: string): boolean => !!err && err.includes('取消')

  // 加载全局记忆
  const loadGlobal = async () => {
    setLoading(true)
    setError(null)
    try {
      const { items: list } = await api.memoryList(null) // null = 仅全局
      setItems(list)
      setHits(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadGlobal() }, [])

  // 订阅主进程记忆变更广播（R6）：任意工程/窗口写完用户记忆后这里自刷新。
  // 500ms 防抖合并突发；搜索输入非空时跳过（hits 是检索时点结果，不被列表重载打掉）。
  // 订阅仅挂载时建立一次，最新输入值经 ref 读取（闭包会过期）。
  const inputRef = useRef('')
  inputRef.current = input
  useEffect(() => {
    let timer: number | undefined
    const off = onMemoryChanged(({ all, projectKeys }) => {
      if (!all && !projectKeys.includes('global')) return
      if (inputRef.current.trim()) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void loadGlobal(), 500)
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 搜索防抖
  useEffect(() => {
    const q = input.trim()
    const timer = window.setTimeout(async () => {
      if (!q) { setHits(null); return }
      setLoading(true)
      try {
        const { hits: h } = await api.memorySearch(q, null)
        setHits(h)
      } catch (e) {
        setError(String(e))
      } finally {
        setLoading(false)
      }
    }, q ? 300 : 0)
    return () => window.clearTimeout(timer)
  }, [input])

  // 提示语自动消失（成功/失败统一 6s）
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  /** 导入/清空后刷新：有搜索词则重放搜索（保持 hits 视图），否则回全量列表 */
  const refreshAfterWrite = async () => {
    const q = input.trim()
    if (q) {
      const { hits: h } = await api.memorySearch(q, null)
      setHits(h)
    } else {
      await loadGlobal()
    }
  }

  // ── ⋯ 菜单定位与关闭 ──
  const openMenu = () => {
    const rect = moreRef.current?.getBoundingClientRect()
    if (!rect) return
    // 右对齐展开：左缘 = 按钮右缘 - 菜单宽（实际宽度挂载后在 layout effect 里钳制）
    setMenuPos({ left: rect.right - MENU_WIDTH, top: rect.bottom + 4 })
    setMenuOpen(true)
  }

  useLayoutEffect(() => {
    if (!menuOpen || !menuPos) return
    const el = menuRef.current
    const trigger = moreRef.current?.getBoundingClientRect()
    if (!el || !trigger) return
    const r = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(menuPos.left, window.innerWidth - r.width - 8))
    let top = menuPos.top
    if (top + r.height > window.innerHeight - 8) {
      const upTop = trigger.top - r.height - 4
      top = upTop >= 8 ? upTop : Math.max(8, window.innerHeight - r.height - 8)
    }
    if (left !== menuPos.left || top !== menuPos.top) setMenuPos({ left, top })
  }, [menuOpen, menuPos])

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      const t = e.target as Node
      if (moreRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  // 容器滚动/窗口缩放时关闭：fixed 菜单不随滚动容器移动，留着只会错位
  useEffect(() => {
    if (!menuOpen) return
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      setMenuOpen(false)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [menuOpen])

  // ── ⋯ 菜单动作 ──

  /** 导出全部用户记忆（global 档）：读操作，蒸馏 busy 中也放行 */
  const onExport = async () => {
    if (exporting || importing) return
    setExporting(true)
    setNotice(null)
    try {
      const r = await api.memoryExport('global')
      if (r.ok) setNotice({ kind: 'ok', text: `已导出 ${r.count ?? 0} 条用户记忆：${r.path ?? ''}` })
      else if (isCancelled(r.error)) setNotice(null)
      else setNotice({ kind: 'err', text: r.error || '导出失败，请稍后重试。' })
    } catch (e) {
      setNotice({ kind: 'err', text: String(e) })
    } finally {
      setExporting(false)
    }
  }

  /** 导入记忆备份：同 id/同 (档,分类,标题) 的 active 条目跳过，完成后刷新视图 */
  const onImport = async () => {
    if (exporting || importing || busy) return
    setImporting(true)
    setNotice(null)
    try {
      const r = await api.memoryImport()
      if (r.ok) {
        setNotice({ kind: 'ok', text: `导入完成：新增 ${r.imported ?? 0} 条，跳过 ${r.skipped ?? 0} 条。` })
        await refreshAfterWrite()
      } else if (isCancelled(r.error)) setNotice(null)
      else setNotice({ kind: 'err', text: r.error || '导入失败，请稍后重试。' })
    } catch (e) {
      setNotice({ kind: 'err', text: String(e) })
    } finally {
      setImporting(false)
    }
  }

  /** 清空用户记忆（危险操作）：确认后走 store.clear（同步刷新统计），再回全量视图 */
  const onClear = async () => {
    if (busy) return
    const ok = await showConfirm('清空用户记忆', `确定清空全部 ${items.length} 条跨工程用户记忆吗？此操作不可撤销。`)
    if (ok !== true) return
    try {
      await clear('global', null)
      setInput('')
      await loadGlobal()
    } catch (e) {
      void showAlert('清空用户记忆失败', String(e))
    }
  }

  const visible = useMemo(() => hits ?? items, [hits, items])

  /** 弹窗保存：成功刷新列表并返回 true（弹窗自关），失败静默返回 false（弹窗保留草稿） */
  const onSave = async (id: string, patch: MemoryUpdatePatch): Promise<boolean> => {
    try {
      await update(id, patch)
      await loadGlobal()
      return true
    } catch { /* 静默 */ }
    return false
  }

  /** 删除：确认 + 失败落错误条（与工作区记忆 Tab 同口径，删除是危险操作不能免确认） */
  const onDelete = async (id: string, title: string) => {
    if ((await showConfirm('删除记忆', `确定删除「${title}」？删除后不可恢复。`)) !== true) return
    try {
      await remove(id)
      await loadGlobal()
    } catch (e) {
      setError(String(e))
    }
  }

  /** 转为项目记忆（用户 → 当前工程）：需已打开工程，confirm 后直调 IPC + 重载全局列表 */
  const onMoveScope = async (id: string, title: string) => {
    if (!projectPath) return
    const ok = await showConfirm('转为项目记忆', `将「${title}」转为工程「${projectName}」的项目记忆？`)
    if (ok !== true) return
    try {
      await api.memoryMoveScope(id, 'project', projectPath)
      await loadGlobal()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="user-mem">
      {/* 搜索 + ⋯ 菜单（导出/导入/清空） */}
      <div className="user-mem__top">
        <div className="user-mem__search">
          <IconSearch size={12} />
          <input
            className="user-mem__search-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="搜索…"
          />
          {input && (
            <button className="user-mem__search-clear" onClick={() => setInput('')}>
              <IconClose size={11} />
            </button>
          )}
        </div>
        <div className="user-mem__menu-wrap" ref={moreRef}>
          <button
            className="icon-btn user-mem__more"
            onClick={openMenu}
            aria-label="更多操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="导出 / 导入 / 清空"
            disabled={importing}
          >
            ⋯
          </button>
          {menuOpen && menuPos && createPortal(
            <div ref={menuRef} className="user-mem__menu" role="menu" style={{ left: menuPos.left, top: menuPos.top }}>
              <button
                className="user-mem__menu-item"
                role="menuitem"
                disabled={exporting || importing}
                onClick={() => { setMenuOpen(false); void onExport() }}
              >
                {exporting ? '导出中…' : '导出全部'}
              </button>
              <button
                className="user-mem__menu-item"
                role="menuitem"
                disabled={exporting || importing || busy}
                title={busy ? '整理中，暂不可导入' : undefined}
                onClick={() => { setMenuOpen(false); void onImport() }}
              >
                {importing ? '导入中…' : '导入…'}
              </button>
              <div className="user-mem__menu-sep" />
              <button
                className="user-mem__menu-item user-mem__menu-item--danger"
                role="menuitem"
                disabled={busy}
                title={busy ? '整理中，暂不可清空' : undefined}
                onClick={() => { setMenuOpen(false); void onClear() }}
              >
                清空…
              </button>
            </div>,
            document.body,
          )}
        </div>
      </div>

      {/* 操作结果提示 */}
      {notice && (
        <div className={`notice ${notice.kind === 'ok' ? 'notice--ok' : 'notice--err'}`}>
          {notice.kind === 'ok' ? <IconCheck size={14} /> : <IconAlert size={14} />}
          <span>{notice.text}</span>
        </div>
      )}

      {/* 列表 */}
      <div className="user-mem__list">
        {loading ? (
          <div className="user-mem__loading">加载中…</div>
        ) : error ? (
          <div className="user-mem__error">
            <IconAlert size={12} /> {error}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<IconLayers size={18} />}
            title="暂无用户记忆"
            text="跨工程的偏好和知识会自动沉淀在这里"
          />
        ) : (
          visible.map((it) => (
            <MemoryItemRow
              key={it.id}
              item={it}
              onEdit={() => setEditingItem(it)}
              onDelete={() => void onDelete(it.id, it.title)}
              onMoveScope={projectPath ? () => void onMoveScope(it.id, it.title) : undefined}
              moveScopeTitle={projectPath ? '转为项目记忆' : '需先打开工程'}
              readOnly={busy}
              compact
            />
          ))
        )}
      </div>

      {/* 统计 */}
      <div className="user-mem__status">
        {items.length} 条用户记忆
      </div>

      {editingItem && (
        <MemoryEditModal
          item={editingItem}
          onSave={(patch) => onSave(editingItem.id, patch)}
          onClose={() => setEditingItem(null)}
          readOnly={busy}
        />
      )}
    </div>
  )
}
