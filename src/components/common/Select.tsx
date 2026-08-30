import { useEffect, useRef, useState } from 'react'
import { IconChevron, IconCheck } from './icons'

export interface SelectOption {
  value: string
  label: string
}

/** 自绘下拉（替代原生 <select>）：样式完全受控，深/浅主题一致；点击外部关闭 */
export function Select({ value, options, onChange, ariaLabel }: {
  value: string
  options: SelectOption[]
  onChange: (v: string) => void
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div className="select" ref={ref}>
      <button
        type="button"
        className="select__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="select__value">{current?.label ?? value}</span>
        <IconChevron size={14} className={`select__chevron ${open ? 'select__chevron--open' : ''}`} />
      </button>
      {open && (
        <div className="select__menu" role="listbox">
          {options.map((o) => (
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
          ))}
        </div>
      )}
    </div>
  )
}