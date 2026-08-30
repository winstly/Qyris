/**
 * 代码编辑器：CodeMirror 6（随 Vite 完整离线打包，无 CDN / Worker 依赖）。
 * 语法高亮 + 行号 + 基本编辑；Ctrl/Cmd+S 由全局快捷键保存。
 * TODO(备选): 如需换成 Monaco Editor，仅需替换本文件（store 接口不变）。
 */
import { useEffect, useRef, useState } from 'react'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { java } from '@codemirror/lang-java'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { useFileStore } from '@/store/useFileStore'
import { basename, relativePath } from '@/utils/path'
import { extOf } from '@/utils/path'
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu'
import { IconAlert, IconClose, IconFile, IconFolder } from '@/components/common/icons'

export function EditorPane() {
  const rootPath = useFileStore((s) => s.rootPath)
  const activePath = useFileStore((s) => s.activePath)
  const openTabs = useFileStore((s) => s.openTabs)
  const dirty = useFileStore((s) => s.dirty)
  const isBinary = useFileStore((s) => (activePath ? !!s.binaryFiles[activePath] : false))
  const truncated = useFileStore((s) => (activePath ? !!s.truncatedFiles[activePath] : false))
  const openFile = useFileStore((s) => s.openFile)
  const closeTab = useFileStore((s) => s.closeTab)
  const closeOthers = useFileStore((s) => s.closeOthers)
  const closeToLeft = useFileStore((s) => s.closeToLeft)
  const closeToRight = useFileStore((s) => s.closeToRight)
  const closeAll = useFileStore((s) => s.closeAll)

  // 页签右键菜单：目标路径 + 弹出位置
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null)

  const menuItems: ContextMenuItem[] = menu
    ? (() => {
        const idx = openTabs.indexOf(menu.path)
        return [
          { label: '关闭', run: () => closeTab(menu.path) },
          { label: '关闭其他', run: () => closeOthers(menu.path), disabled: openTabs.length === 1 },
          { label: '关闭左侧', run: () => closeToLeft(menu.path), disabled: idx <= 0 },
          { label: '关闭右侧', run: () => closeToRight(menu.path), disabled: idx === -1 || idx >= openTabs.length - 1 },
          { label: '全部关闭', run: () => closeAll(), danger: true, disabled: openTabs.length === 0 },
        ]
      })()
    : []

  const viewRef = useRef<EditorView | null>(null)
  const langComp = useRef(new Compartment())
  const applyingRef = useRef(false)
  // 回调 ref 追踪 host：首次挂载时 activePath 为空、host div 尚不存在，
  // 一次性（[] 依赖）effect 会永久错过创建时机 → 必须等 host 真实挂载后再建 EditorView
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null)

  // host 挂载/卸载时创建/销毁编辑器视图
  useEffect(() => {
    if (!hostEl || viewRef.current) return

    const view = new EditorView({
      parent: hostEl,
      state: EditorState.create({ doc: '' }),
      extensions: [
        basicSetup,
        oneDark,
        langComp.current.of([]),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) {
            const { activePath: path } = useFileStore.getState()
            if (path) {
              const head = u.state.selection.main.head
              const line = u.state.doc.lineAt(head)
              useFileStore.setState({ cursor: { line: line.number, col: head - line.from + 1 } })
            }
          }
          if (applyingRef.current || !u.docChanged) return
          const { activePath: path, setContent } = useFileStore.getState()
          if (!path) return
          setContent(path, u.state.doc.toString())
        }),
      ],
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [hostEl])

  // 切换文件：同步语言
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: langComp.current.reconfigure(activePath ? langExtensionFor(activePath) : []),
    })
    view.focus()
  }, [activePath])

  // 文档内容同步：外部加载 / watcher 重载时替换 doc；
  // 用户输入引起的 contents 变化与 doc 一致，不触发 dispatch（避免光标跳动）。
  const contentForEditor = useFileStore((s) => (s.activePath ? s.contents[s.activePath] : undefined))
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const docText = contentForEditor ?? ''
    if (view.state.doc.toString() === docText) return
    applyingRef.current = true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: docText } })
    applyingRef.current = false
  }, [contentForEditor])

  if (!rootPath) {
    return (
      <div className="editor editor--empty">
        <EmptyHint icon={<IconFolder size={22} />} title="未打开项目" text="打开项目后即可浏览与编辑文件。" />
      </div>
    )
  }

  return (
    <div className="editor">
      {/* 打开文件页签 */}
      {openTabs.length > 0 && (
        <div className="editor__tabs" role="tablist" aria-label="打开的文件">
          {openTabs.map((p) => (
            <div
              key={p}
              role="tab"
              aria-selected={p === activePath}
              className={`editor__tab ${p === activePath ? 'editor__tab--active' : ''}`}
              onClick={() => void openFile(p)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ path: p, x: e.clientX, y: e.clientY })
              }}
              title={relativePath(rootPath, p)}
            >
              <span className="editor__tab-name">{basename(p)}</span>
              {dirty[p] && <span className="editor__dirty-dot" aria-label="未保存" />}
              <button
                className="editor__tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(p) }}
                aria-label={`关闭 ${basename(p)}`}
              >
                <IconClose size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {menu && (
        <ContextMenu pos={{ x: menu.x, y: menu.y }} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {activePath && isBinary ? (
        <div className="editor editor--empty">
          <EmptyHint
            icon={<IconAlert size={22} />}
            title="二进制文件"
            text="该文件无法以文本形式查看与编辑。"
          />
        </div>
      ) : activePath ? (
        <>
          {truncated && (
            <div className="editor__warn">
              <IconAlert size={12} /> 文件超过 2MB，仅加载前 2MB；保存将覆盖完整文件，请注意。
            </div>
          )}
          <div className="editor__host" ref={setHostEl} />
        </>
      ) : (
        <div className="editor editor--empty">
          <EmptyHint
            icon={<IconFile size={22} />}
            title="未打开文件"
            text="从左侧文件树点击任意文件开始查看与编辑，Ctrl/Cmd+S 保存。"
          />
        </div>
      )}
    </div>
  )
}

function EmptyHint({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="emptystate">
      <div className="emptystate__icon">{icon}</div>
      <div className="emptystate__title">{title}</div>
      <div className="emptystate__text">{text}</div>
    </div>
  )
}

function langExtensionFor(path: string): Extension {
  switch (extOf(path)) {
    case 'ts': return javascript({ typescript: true })
    case 'tsx': return javascript({ typescript: true, jsx: true })
    case 'js': case 'mjs': case 'cjs': return javascript()
    case 'jsx': return javascript({ jsx: true })
    case 'json': return json()
    case 'html': case 'htm': case 'vue': case 'svelte': case 'xml': case 'svg': return html()
    case 'css': case 'scss': case 'less': return css()
    case 'md': case 'markdown': return markdown()
    case 'py': return python()
    case 'rs': return rust()
    case 'java': return java()
    case 'yml': case 'yaml': return yaml()
    case 'sql': return sql()
    default: return []
  }
}
