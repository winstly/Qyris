import { useSyncExternalStore } from 'react'

/**
 * 响应式断点钩子：< 1024px 时左右布局切换为上下布局。
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(query).matches,
  )
}

export function useIsWide(): boolean {
  return useMediaQuery('(min-width: 1024px)')
}
