/**
 * 左栏纵向面板（搜索 / Git）顶部 grip 的拖拽调高：把指针纵向位移换算成高度占比回调。
 * 比例基准 = 父容器（左栏）高，跟手锚点 = 本面板【自身】底边快照——拖动中文件树（flex:1）
 * 吸收高度变化，本面板底边不动，位移 1:1 映射到比例（Git 面板同理：它底边贴左栏底）。
 * 事件模型必须用 setPointerCapture + target 级 pointermove：window mousemove 在 pointerdown
 * 被 preventDefault 后会被 Chromium 吞掉/延迟合并（按住不动、松开才跳变）。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'

/** 发起一次拖拽：applyRatio 在每次 pointermove 收到新比例（钳制由 store setter 负责） */
export function beginPanelGripDrag(
  e: ReactPointerEvent<HTMLDivElement>,
  self: HTMLElement | null,
  applyRatio: (ratio: number) => void,
): void {
  const parent = self?.parentElement
  const target = e.currentTarget
  if (!self || !parent) return
  e.preventDefault()
  const selfRect = self.getBoundingClientRect()
  const parentRect = parent.getBoundingClientRect()
  target.setPointerCapture(e.pointerId)
  const onMove = (ev: PointerEvent): void => {
    applyRatio((selfRect.bottom - ev.clientY) / parentRect.height)
  }
  const onUp = (ev: PointerEvent): void => {
    target.releasePointerCapture(ev.pointerId)
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', onUp)
    target.removeEventListener('pointercancel', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = 'ns-resize'
  document.body.style.userSelect = 'none'
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
  // pointercancel（触摸打断/系统手势接管）不发 pointerup：不挂清理会留下孤儿监听 + 卡死的 ns-resize 光标
  target.addEventListener('pointercancel', onUp)
}
