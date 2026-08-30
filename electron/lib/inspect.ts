/**
 * 预览 iframe 元素选取器：向预览应用（不同源的 localhost 前端）注入 overlay 脚本，
 * 悬停高亮、点击选中，选中后经 window.parent.postMessage 把元素信息带回工作台主窗口。
 * 跨域 DOM 无法从渲染层访问，故由主进程对 iframe frame 执行 executeJavaScript 绕开。
 */
import type { WebContents } from 'electron'

/** 注入到预览 iframe 的一段独立自脚脚本（无外部依赖，跑在预览应用自己的上下文里） */
const PICKER_SCRIPT = String.raw`(function () {
  if (window.__wbPicker) return
  window.__wbPicker = true

  var box = document.createElement('div')
  box.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646;border:2px solid #7c9aff;background:rgba(124,154,255,0.12);border-radius:3px;transition:left 80ms linear,top 80ms linear,width 80ms linear,height 80ms linear;'
  document.body.appendChild(box)

  var hint = document.createElement('div')
  hint.textContent = '点选要带入 AI 对话的元素 · Esc 取消'
  hint.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483647;padding:6px 12px;background:#1f6feb;color:#fff;border-radius:6px;font:12px/1.5 -apple-system,Segoe UI,sans-serif;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.25);'
  document.body.appendChild(hint)

  var prevCursor = document.body.style.cursor

  function describe(el) {
    var tag = (el.tagName || '').toLowerCase()
    var id = el.id ? '#' + el.id : ''
    var cls = ''
    if (typeof el.className === 'string' && el.className.trim()) {
      cls = '.' + el.className.trim().split(/\s+/).filter(Boolean).slice(0, 6).join('.')
    }
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300)
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
    if (info) window.parent.postMessage({ type: 'workbench-element-picked', payload: info }, '*')
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
})()`

/** 在预览 iframe 的 frame 里注入选取器；找不到匹配 frame（如未加载）时静默返回 */
export async function startElementPick(wc: WebContents, previewUrl: string): Promise<void> {
  let origin = ''
  try {
    origin = new URL(previewUrl).origin
  } catch {
    return
  }
  const frame = wc.mainFrame.frames.find((f) => {
    if (f === wc.mainFrame) return false
    try {
      return new URL(f.url).origin === origin
    } catch {
      return false
    }
  })
  if (!frame) return
  await frame.executeJavaScript(PICKER_SCRIPT)
}