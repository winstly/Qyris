import { useEffect, useRef, useState } from 'react'
import { IconChevron, IconCheck, IconSearch } from './icons'

export interface SelectOption {
  value: string
  label: string
}

/** 自绘下拉（替代原生 <select>）：样式完全受控，深/浅主题一致；点击外部关闭。
 *  - searchable：菜单顶部显示搜索框过滤选项（分支列表等大量选项场景）
 *  - size='sm'：紧凑规格（预览地址栏等窄空间）
 *  - placeholder：value 无匹配时的占位文案（如分支未选择）
 *  - disabled：禁用触发按钮（如分支加载中） */
export function Select({ value, options, onChange, ariaLabel, searchable, size, placeholder, disabled }: {
  value: string
  options: SelectOption[]
  onChange: (v: string) => void
  ariaLabel?: string
  searchable?: boolean
  size?: 'sm'
  placeholder?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // 每次打开重置搜索；可搜索时聚焦搜索框
  useEffect(() => {
    if (open) {
      setQuery('')
      if (searchable) searchRef.current?.focus()
    }
  }, [open, searchable])

  const current = options.find((o) => o.value === value)
  const q = query.trim().toLowerCase()
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options

  return (
    <div className={`select ${size === 'sm' ? 'select--sm' : ''}`} ref={ref}>
      <button
        type="button"
        className="select__trigger"
        onClick={() => { if (!disabled) setOpen((v) => !v) }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <span className={`select__value ${!current && placeholder ? 'select__value--placeholder' : ''}`}>
          {current?.label ?? placeholder ?? value}
        </span>
        <IconChevron size={14} className={`select__chevron ${open ? 'select__chevron--open' : ''}`} />
      </button>
      {open && (
        <div className="select__menu" role="listbox">
          {searchable && (
            <div className="select__search">
              <IconSearch size={12} className="select__search-icon" />
              <input
                ref={searchRef}
                className="select__search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索…"
                aria-label={ariaLabel ? `${ariaLabel}搜索` : '搜索选项'}
              />
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="select__empty">无匹配项</div>
          ) : (
            filtered.map((o) => (
              <button
                type="button"
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`select__option ${o.value === value ? 'select__option--active' : ''}`}
                onClick={() => { onChange(o.value); setOpen(false) }}
              >
                <span className="select__option-label">{o.label}</span>
                {o.value === value && <IconCheck size={13} className="select__option-check" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
