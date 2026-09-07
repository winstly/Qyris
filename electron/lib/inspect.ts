/**
 * 预览元素选取器：向预览 WebContentsView 注入 overlay 脚本，
 * 悬停高亮、点击选中，选中后经 Promise（executeJavaScript 返回值）带回主进程。
 * WebContentsView 是独立进程，不走 postMessage——picker 返回 Promise，
 * 主进程 await 后直接 emitToRenderer 转发渲染层。
 */
import type { WebContents } from 'electron'
import { emitToRenderer } from './emitter'

export interface PickedElement {
  selector: string
  tag: string
  id: string
  text: string
}

/** 注入到预览页的选取器脚本（无外部依赖，跑在预览应用自己的上下文里）。
 *  返回 Promise<string|null>：选中返回 JSON.stringify(info)，Esc 返回 null。
 *  executeJavaScript 会 await 该 Promise 直到用户操作完成。 */
const PICKER_SCRIPT = String.raw`(function () {
  if (window.__wbPicker) return Promise.resolve(null)
  window.__wbPicker = true

  var box = document.createElement('div')
  box.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646;border:2px solid #7c9aff;background:rgba(124,154,255,0.12);border-radius:3px;transition:left 80ms linear,top 80ms linear,width 80ms linear,height 80ms linear;'
  document.body.appendChild(box)

  var hint = document.createElement('div')
  hint.textContent = '点选要带入 AI 对话的元素 · Esc 取消'
  hint.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483647;padding:6px 12px;background:#1f6feb;color:#fff;border-radius:6px;font:12px/1.5 -apple-system,Segoe UI,sans-serif;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.25);'
  document.body.appendChild(hint)

  var prevCursor = document.body.style.cursor

  return new Promise(function (resolve) {
    function describe(el) {
      var tag = (el.tagName || '').toLowerCase()
      var id = el.id ? '#' + el.id : ''
      var cls = ''
      if (typeof el.className === 'string' && el.className.trim()) {
        cls = '.' + el.className.trim().split(/\s+/).filter(Boolean).slice(0, 6).join('.')
      }
      var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120)
      return { selector: tag + id + cls, tag: tag, id: el.id || '', text: text }
    }

    function move(e) {
      var el = e.target
      if (el === box || el === hint) return
      var r = el.getBoundingClientRect()
      box.style.left = r.left + 'px'
      box.style.top = r.top + 'px'
      box.style.width = r.width + 'px'
      box.style.height = r.height + 'px'
    }

    function done(info) {
      window.__wbPicker = false
      box.remove()
      hint.remove()
      document.removeEventListener('mousemove', move, true)
      document.removeEventListener('click', pick, true)
      document.removeEventListener('keydown', esc, true)
      document.body.style.cursor = prevCursor
      resolve(info ? JSON.stringify(info) : null)
    }

    function pick(e) {
      e.preventDefault()
      e.stopPropagation()
      var el = e.target
      if (el === box || el === hint) return
      done(describe(el))
    }

    function esc(e) {
      if (e.key === 'Escape') done(null)
    }

    document.body.style.cursor = 'crosshair'
    document.addEventListener('mousemove', move, true)
    document.addEventListener('click', pick, true)
    document.addEventListener('keydown', esc, true)
  })
})()`

/** 在预览 webContents 里注入选取器；完成后把结果 emitToRenderer 给渲染层。
 *  30s 超时保底：页面导航/SPA 路由跳转可能销毁注入上下文致 Promise 永不 resolve。 */
export async function startElementPick(previewWc: WebContents | null): Promise<void> {
  if (!previewWc || previewWc.isDestroyed()) return
  try {
    const result = await Promise.race([
      previewWc.executeJavaScript(PICKER_SCRIPT) as Promise<string | null>,
      new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
    ])
    if (result) {
      const picked = JSON.parse(result) as PickedElement
      emitToRenderer('element-picked', picked)
    }
  } catch { /* 页面导航/销毁时静默 */ }
}