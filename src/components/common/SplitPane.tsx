import { useCallback, useRef, useState, type ReactNode } from 'react'

interface SplitPaneProps {
  orientation: 'vertical' | 'horizontal'
  /** 左（上）侧内容 */
  first: ReactNode
  /** 右（下）侧内容 */
  second: ReactNode
  /** 第一侧占比 0~1 */
  ratio: number
  onRatioChange: (r: number) => void
  /** 第一侧最小像素 */
  minFirst?: number
  /** 第二侧最小像素 */
  minSecond?: number
  className?: string
}

/**
 * 可拖拽分割面板：按指针增量计算 ratio，钳制两侧最小像素。
 * 拖拽期间给 body 挂 .dragging-* 类，禁用 iframe 等对指针事件的吞并。
 */
export function SplitPane({
  orientation, first, second, ratio, onRatioChange,
  minFirst = 0, minSecond = 0, className,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const vertical = orientation === 'vertical'

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    setDragging(true)
    document.body.classList.add(vertical ? 'dragging-col' : 'dragging-row')

    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const total = vertical ? rect.width : rect.height
    const origin = vertical ? rect.left : rect.top
    const move = (clientPos: number) => {
      let next = (clientPos - origin) / total
      if (minFirst > 0) next = Math.max(minFirst / total, next)
      if (minSecond > 0) next = Math.min(1 - minSecond / total, next)
      onRatioChange(Math.min(0.95, Math.max(0.05, next)))
    }

    const onMove = (ev: PointerEvent) => move(vertical ? ev.clientX : ev.clientY)
    const onUp = () => {
      setDragging(false)
      document.body.classList.remove(vertical ? 'dragging-col' : 'dragging-row')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [vertical, minFirst, minSecond, onRatioChange])

  /** 键盘替代：←/→（横）或 ↑/↓（纵）以 2% 步进（WAI-ARIA separator 模式） */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const forward = vertical
      ? e.key === 'ArrowRight'
      : e.key === 'ArrowDown'
    const back = vertical
      ? e.key === 'ArrowLeft'
      : e.key === 'ArrowUp'
    if (!forward && !back) return
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const total = vertical ? rect.width : rect.height
    let next = ratio + (forward ? 0.02 : -0.02)
    if (minFirst > 0) next = Math.max(minFirst / total, next)
    if (minSecond > 0) next = Math.min(1 - minSecond / total, next)
    onRatioChange(Math.min(0.95, Math.max(0.05, next)))
  }, [vertical, minFirst, minSecond, onRatioChange, ratio])

  return (
    <div ref={containerRef} className={`split ${vertical ? 'split--v' : 'split--h'} ${className ?? ''}`}>
      <div className="split__first" style={{ flexBasis: `${ratio * 100}%` }}>{first}</div>
      <div
        className="split__handle"
        role="separator"
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        aria-label="调整分栏比例（方向键调整）"
        tabIndex={0}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        data-dragging={dragging || undefined}
      />
      <div className="split__second">{second}</div>
    </div>
  )
}
