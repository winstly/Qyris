import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevron, IconCheck, IconSearch } from './icons'

export interface SelectOption {
  value: string
  label: string
}

/** 自绘下拉（替代原生 <select>）：样式完全受控，深/浅主题一致；点击外部关闭。
 *  菜单 portal 到 body + fixed 定位：摆脱弹窗滚动容器（.modal__body 的 overflow）的几何裁剪，
 *  打开时按触发按钮矩形定位、视口内钳制、下方放不下自动上翻、容器滚动时关闭。
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
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; width: number } | null>(null)

  /** 打开：以触发按钮矩形为锚点计算初始位置（挂在下方），钳制在 useLayoutEffect 里做 */
  const openMenu = () => {
    if (disabled) return
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setMenuPos({ left: rect.left, top: rect.bottom + 4, width: rect.width })
    setOpen(true)
  }

  // 挂载后实测菜单尺寸：水平钳制在视口内，下方放不下翻到触发按钮上方
  useLayoutEffect(() => {
    if (!open || !menuPos) return
    const el = menuRef.current
    const trigger = ref.current?.getBoundingClientRect()
    if (!el || !trigger) return
    const r = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(menuPos.left, window.innerWidth - r.width - 8))
    let top = menuPos.top
    if (top + r.height > window.innerHeight - 8) {
      const upTop = trigger.top - r.height - 4
      top = upTop >= 8 ? upTop : Math.max(8, window.innerHeight - r.height - 8)
    }
    if (left !== menuPos.left || top !== menuPos.top) setMenuPos({ ...menuPos, left, top })
  }, [open, menuPos])

  // 点击外部关闭：触发按钮与 portal 菜单都不算外部
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // 容器滚动/窗口缩放时关闭：fixed 菜单不随滚动容器移动，留着只会错位
  useEffect(() => {
    if (!open) return
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      setOpen(false)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
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
        onClick={openMenu}
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
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="select__menu"
          role="listbox"
          style={{ left: menuPos.left, top: menuPos.top, width: menuPos.width }}
        >
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
        </div>,
        document.body,
      )}
    </div>
  )
}
