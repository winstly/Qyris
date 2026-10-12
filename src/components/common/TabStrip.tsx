/**
 * 面板内切页 tab（下划线语言）：设置弹窗 / 创建弹窗 / 扩展切片共用一份结构与样式。
 * 只做切页导航——工作区文档 tab 条（带图标/关闭/尾部动作）是另一种控件，不归这里。
 */
import type { ReactNode } from 'react'

interface TabItem<T extends string> {
  id: T
  label: string
  icon?: ReactNode
}

export function TabStrip<T extends string>({ items, active, onChange, label }: {
  items: readonly TabItem<T>[]
  active: T
  onChange: (id: T) => void
  /** tablist 的 aria-label */
  label: string
}) {
  return (
    <div className="tab-strip" role="tablist" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={active === it.id}
          className={`tab-underline tab-strip__btn ${active === it.id ? 'tab-underline--active' : ''}`}
          onClick={() => onChange(it.id)}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  )
}
