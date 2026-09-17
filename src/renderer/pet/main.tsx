/**
 * 桌宠窗口渲染入口：CSS/SVG 动画角色 + 左键开面板 + 右键菜单 + 拖拽移动。
 * 状态由主进程通过 pet:state 事件推送，三种动画：idle / working / waiting。
 */
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './pet.css'

type PetState = 'idle' | 'working' | 'waiting'

function Pet() {
  const [state, setState] = useState<PetState>('idle')
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0 })

  // 监听主进程推送的状态
  useEffect(() => {
    const off = window.desktopAPI?.onPetState?.((s) => setState(s))
    // 请求当前状态
    window.desktopAPI?.requestPetState?.()
    return () => { off?.() }
  }, [])

  // 左键：开/关面板
  const handleClick = (e: React.MouseEvent) => {
    if (dragRef.current.dragging) return
    e.preventDefault()
    window.desktopAPI?.togglePetPanel?.()
  }

  // 右键：原生菜单（打开工作台 / 退出应用），由主进程 popup
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    window.desktopAPI?.petContextMenu?.()
  }

  // 拖拽：通过 IPC 通知主进程移动窗口（渲染层无法直接移动 BrowserWindow）
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragRef.current = { dragging: false, startX: e.screenX, startY: e.screenY }
    const onMove = (ev: MouseEvent) => {
      const dx = ev.screenX - dragRef.current.startX
      const dy = ev.screenY - dragRef.current.startY
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        dragRef.current.dragging = true
        window.desktopAPI?.petMoveBy?.(dx, dy)
        dragRef.current.startX = ev.screenX
        dragRef.current.startY = ev.screenY
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // 延迟重置，避免 click 事件误判
      setTimeout(() => { dragRef.current.dragging = false }, 50)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`pet pet--${state}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseDown={handleMouseDown}
      title={state === 'idle' ? '待命' : state === 'working' ? '执行中…' : '等待确认'}
    >
      <svg className="pet__body" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        {/* 身体：圆形 */}
        <circle cx="32" cy="34" r="22" fill="var(--pet-body, #6C63FF)" />
        {/* 眼睛 */}
        <circle className="pet__eye pet__eye--left" cx="24" cy="30" r="3.5" fill="white" />
        <circle className="pet__eye pet__eye--right" cx="40" cy="30" r="3.5" fill="white" />
        <circle className="pet__pupil pet__pupil--left" cx="24" cy="30" r="2" fill="#1a1a2e" />
        <circle className="pet__pupil pet__pupil--right" cx="40" cy="30" r="2" fill="#1a1a2e" />
        {/* 嘴巴 */}
        <path className="pet__mouth" d="M 26 40 Q 32 46 38 40" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" />
        {/* 耳朵 */}
        <ellipse cx="16" cy="16" rx="6" ry="8" fill="var(--pet-body, #6C63FF)" transform="rotate(-15 16 16)" />
        <ellipse cx="48" cy="16" rx="6" ry="8" fill="var(--pet-body, #6C63FF)" transform="rotate(15 48 16)" />
      </svg>
      {/* 状态指示灯 */}
      <div className="pet__indicator" />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><Pet /></StrictMode>,
)