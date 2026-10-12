/**
 * smoke:ui 的 DOM 环境前奏（必须在 react/react-dom 之前 import——ESM 引入序保证先于它们初始化）。
 * jsdom 全局注入 + React act 环境标记；组件测试本体在 smoke-ui.tsx。
 */
import { JSDOM } from 'jsdom'
import type { DesktopAPI } from '../shared/desktop-api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.HTMLElement = dom.window.HTMLElement
g.Element = dom.window.Element
g.Node = dom.window.Node
g.MouseEvent = dom.window.MouseEvent
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0)
g.cancelAnimationFrame = (id: number) => clearTimeout(id)
g.IS_REACT_ACT_ENVIRONMENT = true
// isDesktop 在模块加载期求值：占位先行置真，测试用例再按需换具体假实现
dom.window.desktopAPI = {} as unknown as DesktopAPI

export const domWindow = dom.window
