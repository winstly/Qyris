import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  run: () => void
}

/** 右键菜单：portal 渲染 + 视口内钳制 + 外点/失焦关闭（文件树与编辑器页签共用） */
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
    // 菜单内的 pointerdown（点击菜单项）不能触发关闭，否则 click 永远不会落在按钮上
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
        <button
          key={item.label}
          className={`ctxmenu__item ${item.danger ? 'ctxmenu__item--danger' : ''}`}
          role="menuitem"
          disabled={item.disabled}
          onClick={() => { onClose(); item.run() }}
        >
          {item.icon} {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
