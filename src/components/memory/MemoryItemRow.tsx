/**
 * 记忆条目行：标题行（行上按钮：恢复/编辑/转换/删除）+ 两行截断正文 + meta 徽标。
 * 正文恒定两行截断、无展开态——全文查看与编辑统一走 MemoryEditModal（弹窗即详情视图）。
 * 来源与归档痕迹一等展示：用户须能一眼分辨「你保存的」与「系统沉淀」，归档须可解释可恢复。
 */
import type { MemoryCategory, MemoryItem } from '@/types'
import { IconExternal, IconPencil, IconTrash, IconUndo } from '@/components/common/icons'
import { timeAgo } from '@/utils/time'
import { memoryActivation, memoryDisplayImportance } from '../../../shared/memory-scoring'
import type { DetailRow } from '@/components/common/DetailDialog'

/** 来源徽标口径（行上 + 详情共用）：显式条目亮明「你保存的」——保护契约要被说出来 */
const ORIGIN_LABELS: Record<string, string> = {
  user_explicit: '你保存的',
  agent_suggest: '沉淀',
  distill: '蒸馏',
}

/** 来源行人话化：蒸馏溯源 JSON → 「蒸馏自会话（对话 #12）」；解析不了原样落 mono */
function sourceText(item: MemoryItem): { value: string; mono: boolean } {
  if (item.origin === 'user_explicit') return { value: '你在对话中明确要求保存', mono: false }
  try {
    const parsed = item.sourceJson ? (JSON.parse(item.sourceJson) as { messageSeqs?: unknown }) : null
    const seqs = Array.isArray(parsed?.messageSeqs) ? parsed.messageSeqs.filter((s) => typeof s === 'string') : []
    if (seqs.length > 0) return { value: `蒸馏自会话（对话 ${seqs.join('、')}）`, mono: false }
  } catch { /* 非溯源 JSON 形态 */ }
  return { value: item.sourceJson ?? '', mono: true }
}

/** 归档痕迹一句话：「32 天前收起 · 30 天未使用，自动收起」 */
export function archivedText(item: MemoryItem): string {
  if (item.status !== 'archived' || !item.archivedAt) return ''
  return `${timeAgo(item.archivedAt)}${item.archivedReason ? ` · ${item.archivedReason}` : ''}`
}

/** 展示用重要度（派生值：语义价值 × 热度观感——「看得见的衰减」，库内 importance 不动） */
function displayImportance(item: MemoryItem): number {
  const act = memoryActivation(item.accessCount, item.lastAccessedAt, item.createdAt, item.category, Date.now())
  return memoryDisplayImportance(item.importance, act)
}

/** 只读详情行（DetailDialog 用）：两个记忆面板共用一套展示口径 */
export function memoryDetailRows(item: MemoryItem): DetailRow[] {
  const src = sourceText(item)
  return [
    { label: '分类', value: MEMORY_CATEGORY_LABELS[item.category] ?? item.category, kind: 'chip' },
    { label: '层级', value: item.tier === 'long' ? '长期记忆' : `短期记忆（会话 ${item.sessionId ?? '—'}）`, kind: 'chip' },
    { label: '来源', value: ORIGIN_LABELS[item.origin] ?? item.origin, kind: 'chip' },
    { label: '重要度', value: `${displayImportance(item).toFixed(1)}（基础 ${item.importance.toFixed(1)} × 热度衰减）` },
    { label: '正文', value: item.content },
    { label: '状态', value: item.status === 'active' ? '' : STATUS_LABELS[item.status] ?? item.status, kind: 'chip' },
    ...(item.status === 'archived' && item.archivedReason
      ? [{ label: '归档理由', value: archivedText(item) }]
      : []),
    { label: '更新', value: timeAgo(item.updatedAt) },
    { label: '创建', value: timeAgo(item.createdAt) },
    { label: '出处', value: src.value, ...(src.mono ? { kind: 'mono' as const } : {}) },
  ]
}

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: '偏好',
  fact: '事实',
  event: '事件',
  lesson: '教训',
  skill: '技能',
  summary: '摘要',
}

const STATUS_LABELS: Record<string, string> = { merged: '已合并', archived: '已归档' }

export function MemoryItemRow({ item, onDetail, onEdit, onDelete, onRestore, compact, onMoveScope, moveScopeTitle, readOnly }: {
  item: MemoryItem
  /** 整卡点击 → 只读详情弹窗（查看不受 readOnly 门控） */
  onDetail: () => void
  /** 打开编辑弹窗（父级持有 editingItem 状态） */
  onEdit: () => void
  onDelete: () => void
  /** 恢复归档条目（归档态主按钮——用户来归档区的意图大概率是「找回」） */
  onRestore?: () => void
  /** 紧凑模式（左侧侧边栏用）：缩小间距、隐藏部分 meta */
  compact?: boolean
  /** scope 转换（项目↔用户）：提供则显示转换按钮 */
  onMoveScope?: () => void
  /** 转换按钮的提示文案（aria-label/title） */
  moveScopeTitle?: string
  /** 整理中只读：禁用编辑/删除/转换等写操作 */
  readOnly?: boolean
}) {
  const archived = item.status === 'archived'
  return (
    <div className={`card memory__item ${compact ? 'memory__item--compact' : ''}`} data-tier={item.tier} role="listitem"
      onClick={onDetail}>
      <div className="memory__item-head">
        <span className="memory__item-title" title={item.title}>{item.title}</span>
        <div className="memory__item-actions">
          {archived && onRestore && (
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onRestore() }} aria-label="恢复" title="恢复到进行中" disabled={readOnly}>
              <IconUndo size={13} />
            </button>
          )}
          {!archived && (
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onEdit() }} aria-label="编辑" title="编辑" disabled={readOnly}>
              <IconPencil size={13} />
            </button>
          )}
          {onMoveScope && !archived && (
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onMoveScope?.() }} aria-label={moveScopeTitle} title={moveScopeTitle} disabled={readOnly}>
              <IconExternal size={13} />
            </button>
          )}
          <button className="icon-btn memory__item-delete" onClick={(e) => { e.stopPropagation(); onDelete() }} aria-label="删除" title="删除" disabled={readOnly}>
            <IconTrash size={13} />
          </button>
        </div>
      </div>

      <div className="memory__item-content">{item.content}</div>
      <div className="memory__item-meta">
        <span className={`memory__badge memory__badge--${item.tier}`}>{item.tier === 'long' ? '长期' : '短期'}</span>
        <span className="memory__badge">{MEMORY_CATEGORY_LABELS[item.category] ?? item.category}</span>
        <span className={`memory__badge ${item.origin === 'user_explicit' ? 'memory__badge--accent' : 'memory__badge--muted'}`}>
          {ORIGIN_LABELS[item.origin] ?? item.origin}
        </span>
        {archived && (
          <span className="memory__badge memory__badge--muted">{archivedText(item) || (STATUS_LABELS[item.status] ?? item.status)}</span>
        )}
        {!archived && <span title="基础重要度 × 使用热度衰减">当前重要度 {displayImportance(item).toFixed(1)}</span>}
        {!archived && <span>命中 {item.accessCount} 次</span>}
        <span>更新于 {timeAgo(item.updatedAt)}</span>
      </div>
    </div>
  )
}
