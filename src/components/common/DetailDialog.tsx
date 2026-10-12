/**
 * 只读详情弹窗（卡片点击 → 查看）：标签/值两列展开，无输入、无保存动作。
 * 需要改动走各卡片的「编辑」入口（编辑弹窗各自保持原样）；footer 可放跳编辑的过渡动作。
 * 结构沿用全仓弹窗惯例：mask + modal + head/body/actions + 焦点陷阱 + 点遮罩关闭。
 * 值区分三型排版：正文（默认）/ mono 代码面（命令·路径·环境）/ chip 胶囊（状态类短值）。
 */
import type { ReactNode } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { IconClose } from './icons'

export interface DetailRow {
  label: string
  /** 值：字符串自动 pre-wrap 展开（长 token 可断行）；需要富渲染时传 ReactNode */
  value: string | ReactNode
  /** 值排型：text（默认）/ mono（命令·路径·环境变量）/ chip（状态·权限·分类等短值胶囊） */
  kind?: 'text' | 'mono' | 'chip'
}

/** 多值胶囊（标签类）：换行展示不裁剪 */
export function DetailChips({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null
  return (
    <span className="detail-chips">
      {items.map((t) => <span key={t} className="detail-chip">{t}</span>)}
    </span>
  )
}

export function DetailDialog({ title, rows, onClose, footer }: {
  title: string
  /** 展示行：空值行（''/null/undefined）自动省略 */
  rows: DetailRow[]
  onClose: () => void
  /** 尾部动作区（如「编辑」跳编辑态）；缺省不出动作条 */
  footer?: ReactNode
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  const shown = rows.filter((r) => r.value !== '' && r.value != null)
  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={trapRef} className="modal modal--wide" role="dialog" aria-modal="true" aria-label={`${title} 详情`}>
        <div className="modal__head">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><IconClose size={14} /></button>
        </div>
        <div className="modal__body">
          {shown.map((r) => (
            <div key={r.label} className="detail-row">
              <span className="detail-row__label">{r.label}</span>
              <div className={`detail-row__value${r.kind && r.kind !== 'text' ? ` detail-row__value--${r.kind}` : ''}`}>
                {r.value}
              </div>
            </div>
          ))}
        </div>
        {footer ? <div className="modal__actions">{footer}</div> : null}
      </div>
    </div>
  )
}
