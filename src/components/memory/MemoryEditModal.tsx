/**
 * 记忆编辑弹窗：卡片行内编辑的替代形态（侧边栏 260px 塞不下表单，卡片正文恒定两行截断，
 * 全文查看与编辑都收敛在这里——弹窗即详情视图）。结构沿用 SettingsDialog 的 mask+modal 惯例。
 * 草稿在打开时以 item 快照初始化，此后不随 item prop 重同步——后台重载（memory-changed 刷新列表）
 * 不得打断进行中的编辑。保存失败时 onSave 返回 false，弹窗保持开启可重试。
 */
import { useState } from 'react'
import type { MemoryCategory, MemoryItem } from '@/types'
import { IconClose } from '@/components/common/icons'
import { Select } from '@/components/common/Select'
import { MEMORY_CATEGORY_LABELS } from './MemoryItemRow'
import type { MemoryUpdatePatch } from '@/store/useMemoryStore'

interface MemoryRowDraft {
  title: string
  content: string
  category: MemoryCategory
  importance: string
}

function draftOf(item: MemoryItem): MemoryRowDraft {
  return {
    title: item.title,
    content: item.content,
    category: item.category,
    importance: String(item.importance),
  }
}

export function MemoryEditModal({ item, onSave, onClose, readOnly }: {
  item: MemoryItem
  /** 保存由父级执行（store.update / IPC），返回是否成功：失败时弹窗不关、草稿保留 */
  onSave: (patch: MemoryUpdatePatch) => Promise<boolean>
  onClose: () => void
  /** 整理中只读：禁用保存 */
  readOnly?: boolean
}) {
  const [draft, setDraft] = useState<MemoryRowDraft>(() => draftOf(item))
  const [saving, setSaving] = useState(false)

  const close = () => { if (!saving) onClose() }

  const submit = async () => {
    if (saving || readOnly || !draft.title.trim()) return
    setSaving(true)
    try {
      const importance = Math.min(1, Math.max(0, Number(draft.importance) || 0))
      const ok = await onSave({
        title: draft.title.trim(),
        content: draft.content,
        category: draft.category,
        importance,
      })
      if (ok) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    // Esc 取消（keydown 落在输入框上也会冒泡到 mask）；saving 中不响应关闭，防丢草稿
    <div
      className="modal-mask"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
      onKeyDown={(e) => { if (e.key === 'Escape') close() }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="编辑记忆">
        <div className="modal__head">
          <span>编辑记忆</span>
          <button className="icon-btn" onClick={close} aria-label="关闭" disabled={saving}>
            <IconClose size={14} />
          </button>
        </div>

        <div className="modal__body">
          <label className="field">
            <span className="field__label">标题</span>
            <input
              className="field__input"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="标题"
              aria-label="记忆标题"
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field__label">内容</span>
            <textarea
              className="field__input memory-modal__content"
              rows={10}
              value={draft.content}
              onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
              placeholder="内容"
              aria-label="记忆内容"
            />
          </label>
          <div className="memory-modal__row">
            <label className="field">
              <span className="field__label">分类</span>
              <Select
                value={draft.category}
                onChange={(v) => setDraft((d) => ({ ...d, category: v as MemoryCategory }))}
                options={Object.entries(MEMORY_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
                ariaLabel="分类"
                size="sm"
              />
            </label>
            <label className="field memory-modal__field-importance">
              <span className="field__label">重要度</span>
              <input
                className="field__input memory-modal__importance"
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={draft.importance}
                onChange={(e) => setDraft((d) => ({ ...d, importance: e.target.value }))}
              />
            </label>
          </div>
        </div>

        <div className="modal__actions">
          <button className="btn btn--ghost btn--sm" onClick={close} disabled={saving}>取消</button>
          <button
            className="btn btn--primary btn--sm"
            onClick={() => void submit()}
            disabled={saving || readOnly || !draft.title.trim()}
            title={readOnly ? '整理中，暂不可保存' : undefined}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
