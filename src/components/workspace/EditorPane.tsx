/**
 * 代码编辑器：Monaco Editor（手写薄 wrapper，editor 实例 mount 创建一次，切换文件只换 model）。
 * 语法高亮 + 行号 + 基本编辑 + Ctrl/Cmd+F 搜索（Monaco 内置 FindWidget，见 useKeyboardShortcuts）；
 * Ctrl/Cmd+S 由全局快捷键保存。Markdown 文件支持侧栏预览。
 */
import { useEffect, useRef, useState } from 'react'

// Monaco no-op worker
;(self as any).MonacoEnvironment = {
  getWorker() {
    return new Worker(URL.createObjectURL(new Blob([''], { type: 'application/javascript' })))
  },
}

import * as monaco from 'monaco-editor'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useFileStore } from '@/store/useFileStore'
import { basename, extOf, relativePath } from '@/utils/path'
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu'
import { IconAlert, IconClose, IconFile, IconFolder } from '@/components/common/icons'
import { EmptyState } from '@/components/common/EmptyState'

// ---------- 编辑器实例全局访问（Ctrl+F 全局转发用） ----------

let activeEditor: monaco.editor.IStandaloneCodeEditor | null = null

/** 当前挂载的编辑器实例；无挂载（未打开文件）时为 null */
export function getEditorInstance(): monaco.editor.IStandaloneCodeEditor | null {
  return activeEditor
}

// ---------- 语言映射 ----------

function detectLang(filePath: string): string {
  const ext = extOf(filePath)
  switch (ext) {
    case 'ts': case 'tsx': return 'typescript'
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'javascript'
    case 'json': return 'json'
    case 'html': case 'htm': case 'vue': case 'svelte': case 'xml': case 'svg': return 'html'
    case 'css': case 'scss': case 'less': return 'css'
    case 'md': case 'markdown': return 'markdown'
    case 'py': return 'python'
    case 'rs': return 'rust'
    case 'java': return 'java'
    case 'go': return 'go'
    case 'c': case 'h': return 'cpp'
    case 'cpp': case 'cc': case 'cxx': case 'hpp': return 'cpp'
    case 'yml': case 'yaml': return 'yaml'
    case 'sql': return 'sql'
    case 'sh': case 'bash': return 'shell'
    case 'toml': return 'ini'
    default: return 'plaintext'
  }
}

// ---------- 主题：从 tokens.css CSS 变量构建 Monaco 主题 ----------

/** 读取根元素上的 CSS 变量（含当前 data-theme 解析后的值） */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 给 6 位 hex 追加 2 位 alpha */
function withAlpha(hex: string, alpha: string): string {
  return hex.startsWith('#') && hex.length === 7 ? hex + alpha : hex
}

/** 从 tokens.css 读取当前配色并（重新）定义 Monaco 主题 */
function applyMonacoTheme(): void {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light'

  const s1 = cssVar('--s1')
  const s2 = cssVar('--s2')
  const s3 = cssVar('--s3')
  const edge = cssVar('--edge')
  const edgeHair = cssVar('--edge-hair')
  const fg = cssVar('--fg')
  const fg2 = cssVar('--fg-2')
  const muted = cssVar('--muted')
  const accent = cssVar('--accent')
  const warn = cssVar('--warn')
  const success = cssVar('--success')
  const danger = cssVar('--danger')

  const syn = {
    comment: cssVar('--syn-comment'),
    keyword: cssVar('--syn-keyword'),
    string: cssVar('--syn-string'),
    number: cssVar('--syn-number'),
    type: cssVar('--syn-type'),
    func: cssVar('--syn-function'),
    variable: cssVar('--syn-variable'),
    operator: cssVar('--syn-operator'),
    punct: cssVar('--syn-punct'),
  }

  monaco.editor.defineTheme('qyris', {
    base: isLight ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: syn.comment, fontStyle: 'italic' },
      { token: 'keyword', foreground: syn.keyword },
      { token: 'keyword.control', foreground: syn.keyword },
      { token: 'string', foreground: syn.string },
      { token: 'string.escape', foreground: syn.operator },
      { token: 'number', foreground: syn.number },
      { token: 'number.hex', foreground: syn.number },
      { token: 'type', foreground: syn.type },
      { token: 'type.identifier', foreground: syn.type },
      { token: 'entity.name.function', foreground: syn.func },
      { token: 'support.function', foreground: syn.func },
      { token: 'variable', foreground: syn.variable },
      { token: 'variable.predefined', foreground: syn.operator },
      { token: 'delimiter', foreground: syn.punct },
      { token: 'operator', foreground: syn.operator },
      { token: 'regexp', foreground: syn.string },
      // HTML/XML
      { token: 'tag', foreground: syn.variable },
      { token: 'tag.tag-name', foreground: syn.variable },
      { token: 'tag.punctuation', foreground: syn.punct },
      { token: 'metatag', foreground: syn.variable },
      { token: 'metatag.content', foreground: syn.string },
      { token: 'metatag.html', foreground: syn.variable },
      { token: 'metatag.xml', foreground: syn.variable },
      { token: 'attribute.name', foreground: syn.number },
      { token: 'attribute.name.html', foreground: syn.number },
      { token: 'attribute.value', foreground: syn.string },
      { token: 'attribute.value.html', foreground: syn.string },
      { token: 'attribute.value.html.css', foreground: syn.string },
      { token: 'tag.doctype', foreground: syn.comment },
      { token: 'constant', foreground: syn.number },
      { token: 'predefined', foreground: syn.operator },
      // Markdown
      { token: 'markup.heading', foreground: syn.type, fontStyle: 'bold' },
      { token: 'markup.bold', foreground: syn.variable, fontStyle: 'bold' },
      { token: 'markup.italic', foreground: syn.keyword, fontStyle: 'italic' },
      { token: 'markup.raw', foreground: syn.string },
      { token: 'markup.raw.inline', foreground: syn.string },
      { token: 'markup.raw.block', foreground: syn.string },
      { token: 'string.link', foreground: syn.func },
      { token: 'string.other', foreground: syn.string },
      { token: 'meta.separator', foreground: syn.comment },
      // JSON
      { token: 'string.key.json', foreground: syn.variable },
      { token: 'string.value.json', foreground: syn.string },
      { token: 'number.json', foreground: syn.number },
      { token: 'keyword.json', foreground: syn.keyword },
      // CSS
      { token: 'tag.css', foreground: syn.variable },
      { token: 'attribute.name.css', foreground: syn.number },
      { token: 'attribute.value.css', foreground: syn.string },
      { token: 'number.css', foreground: syn.number },
      { token: 'constant.css', foreground: syn.operator },
    ],
    colors: {
      /* 表面：与 tokens.css 五档暖灰一致 */
      'editor.background': s2,
      'editorGutter.background': s1,
      'editorGutter.border': edgeHair,
      'editor.foreground': fg,
      'editorCursor.foreground': accent,
      'editor.lineHighlightBackground': s3,
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': muted,
      'editorLineNumber.activeForeground': fg2,
      'editor.selectionBackground': withAlpha(accent, '33'),
      'editor.inactiveSelectionBackground': withAlpha(accent, '1a'),
      'editor.selectionHighlightBackground': withAlpha(accent, '1a'),
      'editorBracketMatch.background': withAlpha(accent, '30'),
      'editorBracketMatch.border': withAlpha(accent, '60'),
      'editorIndentGuide.background': edgeHair,
      'editorIndentGuide.activeBackground': edge,
      'editor.findMatchBackground': withAlpha(warn, '40'),
      'editor.findMatchHighlightBackground': withAlpha(warn, '20'),
      'editorWidget.border': edge,
      'editorWidget.background': s3,
      'scrollbar.shadow': '#00000030',
      'scrollbarSlider.background': withAlpha(muted, '30'),
      'scrollbarSlider.hoverBackground': withAlpha(muted, '50'),
      'scrollbarSlider.activeBackground': withAlpha(muted, '70'),
      'editorHoverWidget.background': s3,
      'editorHoverWidget.border': edge,
      'editorSuggestWidget.background': s3,
      'editorSuggestWidget.border': edge,
      'editorSuggestWidget.selectedBackground': withAlpha(accent, '25'),
      'diffEditor.insertedTextBackground': withAlpha(success, '15'),
      'diffEditor.removedTextBackground': withAlpha(danger, '15'),
      'minimap.background': s1,
    },
  })
  monaco.editor.setTheme('qyris')
}

// ---------- 组件 ----------

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

  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const applyingRef = useRef(false)
  // 当前 model 对应的文件路径，用于判断是否需要切换
  const modelPathRef = useRef<string | null>(null)
  // 回调 ref：host 真实挂载后再建 editor
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null)
  // Markdown 预览模式：默认预览态，点击「编辑」切到编辑器
  const [showPreview, setShowPreview] = useState(() => activePath ? ['md', 'markdown'].includes(extOf(activePath)) : false)
  const isMarkdown = activePath ? ['md', 'markdown'].includes(extOf(activePath)) : false

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

  // ---- hostEl 变化时创建 editor 实例（host 挂载后触发） ----
  useEffect(() => {
    const host = hostEl
    if (!host) return

    applyMonacoTheme()
    const editor = monaco.editor.create(host, {
      value: '',
      language: 'plaintext',
      theme: 'qyris',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      cursorBlinking: 'solid',
      cursorWidth: 2,
      smoothScrolling: true,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true },
      find: { addExtraSpaceOnTop: false },
      padding: { top: 8, bottom: 8 },
    })
    editorRef.current = editor
    activeEditor = editor
    requestAnimationFrame(() => editor.layout())

    // 如果创建时已有 activePath，立即加载对应文件
    const { activePath: initPath, contents } = useFileStore.getState()
    if (initPath) {
      const content = contents[initPath] ?? ''
      const lang = detectLang(initPath)
      const uri = monaco.Uri.file(initPath)
      let model = monaco.editor.getModel(uri)
      if (model) {
        model.setValue(content)
        monaco.editor.setModelLanguage(model, lang)
      } else {
        model = monaco.editor.createModel(content, lang, uri)
      }
      editor.setModel(model)
      modelPathRef.current = initPath
    }

    // 内容变更 → store
    editor.onDidChangeModelContent(() => {
      if (applyingRef.current) return
      const { activePath: path, setContent } = useFileStore.getState()
      if (!path) return
      setContent(path, editor.getValue())
    })

    // 光标变更 → store
    editor.onDidChangeCursorPosition((e) => {
      const { activePath: path } = useFileStore.getState()
      if (!path) return
      useFileStore.setState({ cursor: { line: e.position.lineNumber, col: e.position.column } })
    })

    // 监听 data-theme 变化，重新读 token 并重建 Monaco 主题
    const observer = new MutationObserver(() => {
      applyMonacoTheme()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      observer.disconnect()
      const model = editor.getModel()
      if (model) model.dispose()
      editor.dispose()
      editorRef.current = null
      if (activeEditor === editor) activeEditor = null
    }
  }, [hostEl])

  // ---- 切换文件：换 model，不重建 editor ----
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !activePath) return
    // 同一文件不重复切换
    if (modelPathRef.current === activePath) {
      editor.focus()
      return
    }

    const content = useFileStore.getState().contents[activePath] ?? ''
    const lang = detectLang(activePath)
    const uri = monaco.Uri.file(activePath)

    let model = monaco.editor.getModel(uri)
    if (model) {
      model.setValue(content)
      monaco.editor.setModelLanguage(model, lang)
    } else {
      model = monaco.editor.createModel(content, lang, uri)
    }
    editor.setModel(model)
    modelPathRef.current = activePath
    editor.focus()
  }, [activePath])

  const prevTabsRef = useRef<string[]>([])
  useEffect(() => {
    const prev = prevTabsRef.current
    const curr = useFileStore.getState().openTabs
    if (prev.length > curr.length) {
      const closed = prev.filter((p) => !curr.includes(p))
      for (const p of closed) {
        const uri = monaco.Uri.file(p)
        const model = monaco.editor.getModel(uri)
        if (model) model.dispose()
      }
    }
    prevTabsRef.current = curr
  }, [useFileStore((s) => s.openTabs)])

  // ---- 切换文件时：md 默认预览态，其他文件关闭预览 ----
  useEffect(() => {
    setShowPreview(isMarkdown)
  }, [isMarkdown])

  // ---- 预览切换 / 文件切换后，Monaco 必须重算布局 ----
  useEffect(() => {
    const editor = editorRef.current
    if (editor) {
      requestAnimationFrame(() => editor.layout())
    }
  }, [showPreview, activePath])

  // ---- 外部变更（AI 写文件 / watcher 重载）：替换内容但保留光标 ----
  const contentForEditor = useFileStore((s) => (s.activePath ? s.contents[s.activePath] : undefined))
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const currentValue = editor.getValue()
    const newValue = contentForEditor ?? ''
    if (currentValue === newValue) return
    applyingRef.current = true
    try {
      const model = editor.getModel()
      if (model) {
        editor.executeEdits('external', [{
          range: model.getFullModelRange(),
          text: newValue,
        }])
      }
    } finally {
      applyingRef.current = false
    }
  }, [contentForEditor])

  // ---- 空项目 / 未打开文件 ----
  if (!rootPath) {
    return (
      <div className="editor editor--empty">
        <EmptyState icon={<IconFolder size={22} />} title="未打开项目" text="打开项目后即可浏览与编辑文件。" />
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
          {/* Markdown 预览切换 */}
          {isMarkdown && (
            <button
              className={`editor__preview-btn ${showPreview ? 'editor__preview-btn--active' : ''}`}
              onClick={() => setShowPreview((v) => !v)}
              title={showPreview ? '关闭预览' : '预览 Markdown'}
            >
              {showPreview ? '编辑' : '预览'}
            </button>
          )}
        </div>
      )}

      {menu && (
        <ContextMenu pos={{ x: menu.x, y: menu.y }} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {activePath && isBinary ? (
        <div className="editor editor--empty">
          <EmptyState
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
          <div className="editor__body">
            <div className="editor__host" ref={setHostEl} />
            {isMarkdown && showPreview && (
              <div className="editor__preview md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {contentForEditor ?? ''}
                </ReactMarkdown>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="editor editor--empty">
          <EmptyState
            icon={<IconFile size={22} />}
            title="未打开文件"
            text="从左侧文件树点击任意文件开始查看与编辑，Ctrl/Cmd+S 保存。"
          />
        </div>
      )}
    </div>
  )
}
