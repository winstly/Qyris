/**
 * window.desktopAPI 全局声明：接口唯一定义在 shared/desktop-api.ts（preload 按它受检实现），
 * 此处只做 Window 挂载与渲染层再导出。
 */
import type { DesktopAPI } from '../../shared/desktop-api'

declare global {
  interface Window {
    desktopAPI?: DesktopAPI
  }
}

export {}
