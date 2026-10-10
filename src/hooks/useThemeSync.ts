import { useEffect } from 'react'
import type { Theme } from '@/store/useAppStore'

/** 主题应用：解析 system/light/dark 并写到 documentElement。
 *  两个来源：① 本窗口 store 的 theme；② 其它窗口广播的 theme:changed（桌宠面板/桌宠跟随）。
 *  单独成文件是为了桌宠入口也能用——它只有 React，不能经 useDesktopEvents 把
 *  useChatStore 等主窗依赖拖进这个 128px 透明小窗的包里。 */
export function useThemeSync(theme: Theme): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    // 远端广播覆盖本窗口值（任一窗口切主题全局跟手）；再切回本地时以 theme 为准
    let remote: Theme | null = null
    const apply = () => {
      const t = remote ?? theme
      const resolved = t === 'system' ? (mq.matches ? 'dark' : 'light') : t
      document.documentElement.dataset.theme = resolved
    }
    const onSchemeChange = () => { remote = null; apply() }
    apply()
    mq.addEventListener('change', onSchemeChange)
    const off = window.desktopAPI?.onThemeChanged?.((t) => {
      remote = t as Theme
      apply()
    })
    return () => {
      mq.removeEventListener('change', onSchemeChange)
      off?.()
    }
  }, [theme])
}
