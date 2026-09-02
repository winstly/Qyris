/**
 * 代码编辑器：Monaco Editor（手写薄 wrapper，editor 实例 mount 创建一次，切换文件只换 model）。
 * 语法高亮 + 行号 + 基本编辑 + Ctrl/Cmd+F 搜索（Monaco 内置 FindWidget，见 useKeyboardShortcuts）；
 * Ctrl/Cmd+S 由全局快捷键保存。Markdown 文件支持侧栏预览。
 */
import { useEffect, useRef, useState } from 'react'

// Monaco 无 worker 时默认尝试 CDN（Electron 下必然失败）。
// 提供一个 no-op worker 避免控制台报错；语法高亮在主线程，不依赖 worker。
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

// ---------- 自定义主题（与 tokens.css 暖灰体系对齐） ----------

monaco.editor.defineTheme('qyris-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // Atom One Dark 配色
    { token: 'comment', foreground: '5c6370', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c678dd' },
    { token: 'keyword.control', foreground: 'c678dd' },
    { token: 'string', foreground: '98c379' },
    { token: 'string.escape', foreground: '56b6c2' },
    { token: 'number', foreground: 'd19a66' },
    { token: 'number.hex', foreground: 'd19a66' },
    { token: 'type', foreground: 'e5c07b' },
    { token: 'type.identifier', foreground: 'e5c07b' },
    { token: 'entity.name.function', foreground: '61afef' },
    { token: 'support.function', foreground: '61afef' },
    { token: 'variable', foreground: 'e06c75' },
    { token: 'variable.predefined', foreground: '56b6c2' },
    { token: 'delimiter', foreground: 'abb2bf' },
    { token: 'operator', foreground: '56b6c2' },
    { token: 'regexp', foreground: '98c379' },
    // HTML/XML
    { token: 'tag', foreground: 'e06c75' },
    { token: 'tag.tag-name', foreground: 'e06c75' },
    { token: 'tag.punctuation', foreground: 'abb2bf' },
    { token: 'metatag', foreground: 'e06c75' },
    { token: 'metatag.content', foreground: '98c379' },
    { token: 'metatag.html', foreground: 'e06c75' },
    { token: 'metatag.xml', foreground: 'e06c75' },
    { token: 'attribute.name', foreground: 'd19a66' },
    { token: 'attribute.name.html', foreground: 'd19a66' },
    { token: 'attribute.value', foreground: '98c379' },
    { token: 'attribute.value.html', foreground: '98c379' },
    { token: 'attribute.value.html.css', foreground: '98c379' },
    { token: 'tag.doctype', foreground: '5c6370' },
    { token: 'constant', foreground: 'd19a66' },
    { token: 'predefined', foreground: '56b6c2' },
    // Markdown
    { token: 'markup.heading', foreground: 'e5c07b', fontStyle: 'bold' },
    { token: 'markup.bold', foreground: 'e06c75', fontStyle: 'bold' },
    { token: 'markup.italic', foreground: 'c678dd', fontStyle: 'italic' },
    { token: 'markup.raw', foreground: '98c379' },
    { token: 'markup.raw.inline', foreground: '98c379' },
    { token: 'markup.raw.block', foreground: '98c379' },
    { token: 'string.link', foreground: '61afef' },
    { token: 'string.other', foreground: '98c379' },
    { token: 'meta.separator', foreground: '5c6370' },
    // JSON
    { token: 'string.key.json', foreground: 'e06c75' },
    { token: 'string.value.json', foreground: '98c379' },
    { token: 'number.json', foreground: 'd19a66' },
    { token: 'keyword.json', foreground: 'c678dd' },
    // CSS
    { token: 'tag.css', foreground: 'e06c75' },
    { token: 'attribute.name.css', foreground: 'd19a66' },
    { token: 'attribute.value.css', foreground: '98c379' },
    { token: 'number.css', foreground: 'd19a66' },
    { token: 'constant.css', foreground: '56b6c2' },
  ],
  colors: {
    /* 表面：与 tokens.css 五档暖灰一致 */
    'editor.background': '#1f1f22',                    // --s2
    'editorGutter.background': '#1a1a1c',              // --s1
    'editorGutter.border': '#28282e',                  // --edge-hair
    /* 文字 */
    'editor.foreground': '#e8e4df',                    // --fg
    /* 光标 */
    'editorCursor.foreground': '#7c8da4',              // --accent
    /* 行 */
    'editor.lineHighlightBackground': '#26262a',       // --s3
    'editor.lineHighlightBorder': '#00000000',         // 无边框
    /* 行号 */
    'editorLineNumber.foreground': '#6b6560',          // --muted
    'editorLineNumber.activeForeground': '#a8a29e',    // --fg-2
    /* 选区 */
    'editor.selectionBackground': '#7c8da433',
    'editor.inactiveSelectionBackground': '#7c8da41a',
    'editor.selectionHighlightBackground': '#7c8da41a',
    /* 匹配括号 */
    'editorBracketMatch.background': '#7c8da430',
    'editorBracketMatch.border': '#7c8da460',
    /* 缩进指南 */
    'editorIndentGuide.background': '#28282e',         // --edge-hair
    'editorIndentGuide.activeBackground': '#34343a',   // --edge
    /* 搜索高亮 */
    'editor.findMatchBackground': '#c4a26540',
    'editor.findMatchHighlightBackground': '#c4a26520',
    /* 边框 */
    'editorWidget.border': '#34343a',                  // --edge
    'editorWidget.background': '#26262a',              // --s3
    /* 滚动条 */
    'scrollbar.shadow': '#00000030',
    'scrollbarSlider.background': '#6b656030',
    'scrollbarSlider.hoverBackground': '#6b656050',
    'scrollbarSlider.activeBackground': '#6b656070',
    /* 悬浮提示 */
    'editorHoverWidget.background': '#26262a',
    'editorHoverWidget.border': '#34343a',
    /* 自动补全 */
    'editorSuggestWidget.background': '#26262a',
    'editorSuggestWidget.border': '#34343a',
    'editorSuggestWidget.selectedBackground': '#7c8da425',
    /* diff 编辑器 */
    'diffEditor.insertedTextBackground': '#6bba7a15',
    'diffEditor.removedTextBackground': '#c4707015',
    /* 边缘（minimap 等） */
    'minimap.background': '#1a1a1c',
  },
})

// ---------- 浅色主题 ----------

monaco.editor.defineTheme('qyris-light', {
  base: 'vs',
  inherit: true,
  rules: [
    // Atom One Light 配色
    { token: 'comment', foreground: 'a0a1a7', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'a626a4' },
    { token: 'keyword.control', foreground: 'a626a4' },
    { token: 'string', foreground: '50a14f' },
    { token: 'string.escape', foreground: '0184bc' },
    { token: 'number', foreground: '986801' },
    { token: 'number.hex', foreground: '986801' },
    { token: 'type', foreground: 'c18401' },
    { token: 'type.identifier', foreground: 'c18401' },
    { token: 'entity.name.function', foreground: '4078f2' },
    { token: 'support.function', foreground: '4078f2' },
    { token: 'variable', foreground: 'e45649' },
    { token: 'variable.predefined', foreground: '0184bc' },
    { token: 'delimiter', foreground: '383a42' },
    { token: 'operator', foreground: '0184bc' },
    { token: 'regexp', foreground: '50a14f' },
    // HTML/XML
    { token: 'tag', foreground: 'e45649' },
    { token: 'tag.tag-name', foreground: 'e45649' },
    { token: 'tag.punctuation', foreground: '383a42' },
    { token: 'metatag', foreground: 'e45649' },
    { token: 'metatag.content', foreground: '50a14f' },
    { token: 'metatag.html', foreground: 'e45649' },
    { token: 'metatag.xml', foreground: 'e45649' },
    { token: 'attribute.name', foreground: '986801' },
    { token: 'attribute.name.html', foreground: '986801' },
    { token: 'attribute.value', foreground: '50a14f' },
    { token: 'attribute.value.html', foreground: '50a14f' },
    { token: 'attribute.value.html.css', foreground: '50a14f' },
    { token: 'tag.doctype', foreground: 'a0a1a7' },
    { token: 'constant', foreground: '986801' },
    { token: 'predefined', foreground: '0184bc' },
    // Markdown
    { token: 'markup.heading', foreground: 'c18401', fontStyle: 'bold' },
    { token: 'markup.bold', foreground: 'e45649', fontStyle: 'bold' },
    { token: 'markup.italic', foreground: 'a626a4', fontStyle: 'italic' },
    { token: 'markup.raw', foreground: '50a14f' },
    { token: 'markup.raw.inline', foreground: '50a14f' },
    { token: 'markup.raw.block', foreground: '50a14f' },
    { token: 'string.link', foreground: '4078f2' },
    { token: 'string.other', foreground: '50a14f' },
    { token: 'meta.separator', foreground: 'a0a1a7' },
    // JSON
    { token: 'string.key.json', foreground: 'e45649' },
    { token: 'string.value.json', foreground: '50a14f' },
    { token: 'number.json', foreground: '986801' },
    { token: 'keyword.json', foreground: 'a626a4' },
    // CSS
    { token: 'tag.css', foreground: 'e45649' },
    { token: 'attribute.name.css', foreground: '986801' },
    { token: 'attribute.value.css', foreground: '50a14f' },
    { token: 'number.css', foreground: '986801' },
    { token: 'constant.css', foreground: '0184bc' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#f8f7f5',
    'editorGutter.border': '#e8e5e0',
    'editor.foreground': '#1a1816',
    'editorCursor.foreground': '#5a6e84',
    'editor.lineHighlightBackground': '#f8f7f5',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#8a8478',
    'editorLineNumber.activeForeground': '#5a5650',
    'editor.selectionBackground': '#5a6e8433',
    'editor.inactiveSelectionBackground': '#5a6e841a',
    'editor.selectionHighlightBackground': '#5a6e841a',
    'editorBracketMatch.background': '#5a6e8430',
    'editorBracketMatch.border': '#5a6e8460',
    'editorIndentGuide.background': '#e8e5e0',
    'editorIndentGuide.activeBackground': '#dcd8d2',
    'editor.findMatchBackground': '#9a7a2840',
    'editor.findMatchHighlightBackground': '#9a7a2820',
    'editorWidget.border': '#dcd8d2',
    'editorWidget.background': '#ffffff',
    'scrollbarSlider.background': '#8a847830',
    'scrollbarSlider.hoverBackground': '#8a847850',
    'scrollbarSlider.activeBackground': '#8a847870',
    'editorHoverWidget.background': '#ffffff',
    'editorHoverWidget.border': '#dcd8d2',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.border': '#dcd8d2',
    'editorSuggestWidget.selectedBackground': '#5a6e8415',
    'diffEditor.insertedTextBackground': '#2e7d5215',
    'diffEditor.removedTextBackground': '#b0404015',
    'minimap.background': '#f8f7f5',
  },
})

// ---------- 主题检测 ----------

function currentTheme(): 'qyris-dark' | 'qyris-light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'qyris-light' : 'qyris-dark'
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

    const editor = monaco.editor.create(host, {
      value: '',
      language: 'plaintext',
      theme: currentTheme(),
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
    // 首次创建强制 layout（防止 automaticLayout 延迟导致白屏）
    requestAnimationFrame(() => editor.layout())

    // 如果创建时已有 activePath，立即加载对应文件
    const { activePath: initPath, contents } = useFileStore.getState()
    if (initPath) {
      const content = contents[initPath] ?? ''
      const lang = detectLang(initPath)
      const uri = monaco.Uri.parse(`file:///${initPath}`)
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

    // 监听 data-theme 变化，同步切换 Monaco 主题
    const observer = new MutationObserver(() => {
      monaco.editor.setTheme(currentTheme())
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      observer.disconnect()
      // 清理当前 model（防止 Monaco 全局 registry 泄漏）
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
    const uri = monaco.Uri.parse(`file:///${activePath}`)

    // 复用已有 model 或创建新 model（Monaco 全局 registry 按 URI 去重）
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

  // ---- 关闭页签时释放对应的 Monaco model，防止 registry 泄漏 ----
  const prevTabsRef = useRef<string[]>([])
  useEffect(() => {
    const prev = prevTabsRef.current
    const curr = useFileStore.getState().openTabs
    if (prev.length > curr.length) {
      const closed = prev.filter((p) => !curr.includes(p))
      for (const p of closed) {
        const uri = monaco.Uri.parse(`file:///${p}`)
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
