import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 模态焦点陷阱（WCAG 对话框语义）：active 期间
 * · 焦点移入容器内第一个可聚焦元素（没有则容器自身）
 * · Tab/Shift+Tab 在容器首尾循环，不逃逸到背后内容
 * · 卸载时焦点还给打开前的元素（回到触发上下文）
 * 用法：const ref = useFocusTrap(!!open); <div ref={ref} className="modal-mask">
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    const focusables = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((n) => n.offsetParent !== null || n === document.activeElement)

    // 焦点入陷阱（ autofocus 的元素优先，否则第一个可聚焦元素 ）
    const initial = el.querySelector<HTMLElement>('[autofocus]') ?? focusables()[0] ?? el
    initial.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (!el.contains(document.activeElement)) {
        // 焦点意外落在外部（如程序化 focus）时拉回
        e.preventDefault()
        first.focus()
      }
    }

    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [active])

  return ref
}
