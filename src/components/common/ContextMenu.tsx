import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  /** 子菜单项 */
  children?: ContextMenuItem[]
  run?: () => void
}

/** 右键菜单：portal 渲染 + 视口内钳制 + 外点/失焦关闭 + 子菜单（文件树与编辑器页签共用） */
export function ContextMenu({ pos, items, onClose }: {
  pos: { x: number; y: number }
  items: ContextMenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({ left: pos.x, top: pos.y })

  useEffect(() => {
    const el = ref.current
    if (el) {
      const rect = el.getBoundingClientRect()
      setStyle({
        left: Math.min(pos.x, window.innerWidth - rect.width - 8),
        top: Math.min(pos.y, window.innerHeight - rect.height - 8),
      })
    }
    // pointerdown 时菜单项不能触发关闭，否则后续 click 永远不会落在按钮上
    const close = (e: Event) => {
      const target = e.target
      if (ref.current && target instanceof Node && ref.current.contains(target)) return
      onClose()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [pos, onClose])

  return createPortal(
    <div ref={ref} className="ctxmenu" style={style} role="menu">
      {items.map((item) => (
        item.children
          ? <SubMenuItem key={item.label} item={item} onClose={onClose} />
          : <MenuItem key={item.label} item={item} onClose={onClose} />
      ))}
    </div>,
    document.body,
  )
}

function MenuItem({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  return (
    <button
      className={`ctxmenu__item ${item.danger ? 'ctxmenu__item--danger' : ''}`}
      role="menuitem"
      disabled={item.disabled}
      onClick={() => { onClose(); item.run?.() }}
    >
      {item.icon} {item.label}
    </button>
  )
}

function SubMenuItem({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const [open, setOpen] = useState(false)
  const [flip, setFlip] = useState(false)
  const timerRef = useRef<number>(0)
  const subRef = useRef<HTMLDivElement>(null)

  const openSub = () => { window.clearTimeout(timerRef.current); setOpen(true) }
  const closeSub = () => { timerRef.current = window.setTimeout(() => setOpen(false), 120) }

  // 子菜单打开后检测是否溢出视口，溢出则翻转到左侧
  useEffect(() => {
    if (!open || !subRef.current) return
    const rect = subRef.current.getBoundingClientRect()
    if (rect.right > window.innerWidth - 8) setFlip(true)
    else if (rect.left < 8) setFlip(false)
  }, [open])

  return (
    <div
      className="ctxmenu__sub"
      onMouseEnter={openSub}
      onMouseLeave={closeSub}
    >
      <button className="ctxmenu__item ctxmenu__item--sub" role="menuitem" disabled={item.disabled}>
        {item.icon} {item.label} <span className="ctxmenu__arrow">▸</span>
      </button>
      {open && (
        <div ref={subRef} className={`ctxmenu ctxmenu--child${flip ? ' ctxmenu--flip' : ''}`} role="menu">
          {item.children!.map((child) => (
            child.children
              ? <SubMenuItem key={child.label} item={child} onClose={onClose} />
              : <MenuItem key={child.label} item={child} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  )
}
