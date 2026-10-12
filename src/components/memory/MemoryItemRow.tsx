/**
 * 记忆条目行：标题行（行上按钮：编辑/转换/删除）+ 两行截断正文 + meta 徽标。
 * 正文恒定两行截断、无展开态——全文查看与编辑统一走 MemoryEditModal（弹窗即详情视图）。
 */
import type { MemoryCategory, MemoryItem } from '@/types'
import { IconExternal, IconPencil, IconTrash } from '@/components/common/icons'
import { timeAgo } from '@/utils/time'
import type { DetailRow } from '@/components/common/DetailDialog'

/** 只读详情行（DetailDialog 用）：两个记忆面板共用一套展示口径 */
export function memoryDetailRows(item: MemoryItem): DetailRow[] {
  return [
    { label: '分类', value: MEMORY_CATEGORY_LABELS[item.category] ?? item.category, kind: 'chip' },
    { label: '层级', value: item.tier === 'long' ? '长期记忆' : `短期记忆（会话 ${item.sessionId ?? '—'}）`, kind: 'chip' },
    { label: '重要度', value: String(item.importance) },
    { label: '正文', value: item.content },
    { label: '状态', value: item.status === 'active' ? '' : STATUS_LABELS[item.status] ?? item.status, kind: 'chip' },
    { label: '更新', value: timeAgo(item.updatedAt) },
    { label: '创建', value: timeAgo(item.createdAt) },
    { label: '来源', value: item.sourceJson ?? '', kind: 'mono' },
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

export function MemoryItemRow({ item, onDetail, onEdit, onDelete, compact, onMoveScope, moveScopeTitle, readOnly }: {
  item: MemoryItem
  /** 整卡点击 → 只读详情弹窗（查看不受 readOnly 门控） */
  onDetail: () => void
  /** 打开编辑弹窗（父级持有 editingItem 状态） */
  onEdit: () => void
  onDelete: () => void
  /** 紧凑模式（左侧侧边栏用）：缩小间距、隐藏部分 meta */
  compact?: boolean
  /** scope 转换（项目↔用户）：提供则显示转换按钮 */
  onMoveScope?: () => void
  /** 转换按钮的提示文案（aria-label/title） */
  moveScopeTitle?: string
  /** 整理中只读：禁用编辑/删除/转换等写操作 */
  readOnly?: boolean
}) {
  return (
    <div className={`card memory__item ${compact ? 'memory__item--compact' : ''}`} data-tier={item.tier} role="listitem"
      onClick={onDetail}>
      <div className="memory__item-head">
        <span className="memory__item-title" title={item.title}>{item.title}</span>
        <div className="memory__item-actions">
          <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onEdit() }} aria-label="编辑" title="编辑" disabled={readOnly}>
            <IconPencil size={13} />
          </button>
          {onMoveScope && (
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
        {item.status !== 'active' && (
          <span className="memory__badge memory__badge--muted">{STATUS_LABELS[item.status] ?? item.status}</span>
        )}
        <span>重要度 {item.importance.toFixed(1)}</span>
        <span>命中 {item.accessCount} 次</span>
        <span>更新于 {timeAgo(item.updatedAt)}</span>
      </div>
    </div>
  )
}
