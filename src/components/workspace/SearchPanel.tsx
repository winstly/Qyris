/**
 * 全项目内容搜索面板（参考 VSCode Ctrl+Shift+F）。
 * 折叠面板形式，放在 FilesTab 左栏文件树下方、Git 面板上方。
 * 使用主进程 grepFiles IPC 做正则搜索，结果按文件分组显示。
 * 点击匹配项 → 展开文件树到目标目录 + 打开文件 + Monaco 定位到行。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/services/desktop'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { basename, joinPath } from '@/utils/path'
import { beginPanelGripDrag } from '@/utils/panelGrip'
import { setGlobalSearchFocus } from '@/services/commands'
import { getEditorInstance } from '@/components/workspace/EditorPane'
import { IconSearch, IconClose, IconChevron } from '@/components/common/icons'

// ---------- 类型 ----------

interface FileMatch {
  path: string       // 相对路径
  matches: { line: number; text: string }[]
  open: boolean      // 文件级折叠/展开
}

// ---------- 高亮工具 ----------

function highlightText(text: string, query: string, caseSensitive: boolean, literal: boolean): React.ReactNode {
  if (!query) return text
  try {
    const flags = caseSensitive ? 'g' : 'gi'
    const re = new RegExp(literal ? query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : query, flags)
    const parts: React.ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null
    re.lastIndex = 0
    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
      parts.push(<mark key={match.index} className="search-highlight">{match[0]}</mark>)
      lastIndex = re.lastIndex
      if (match[0].length === 0) { re.lastIndex++; lastIndex = re.lastIndex }
      if (parts.length > 50) break
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex))
    return parts.length > 0 ? parts : text
  } catch {
    return text
  }
}

// ---------- 组件 ----------

export function SearchPanel() {
  const rootPath = useFileStore((s) => s.rootPath)
  const openFile = useFileStore((s) => s.openFile)
  const revealPath = useFileStore((s) => s.revealPath)
  const searchOpen = useAppStore((s) => s.searchOpen)
  const toggleSearch = useAppStore((s) => s.toggleSearch)
  const searchPanelRatio = useAppStore((s) => s.searchPanelRatio)
  const searchExclude = useAppStore((s) => s.searchExclude)
  const setSearchExclude = useAppStore((s) => s.setSearchExclude)

  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [showExclude, setShowExclude] = useState(false)
  const [exclDraft, setExclDraft] = useState('')
  const [searching, setSearching] = useState(false)
  const [fileMatches, setFileMatches] = useState<FileMatch[]>([])
  const [totalMatches, setTotalMatches] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [searched, setSearched] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)

  /** 顶部 grip 拖拽调高（与 GitPanel 共享实现，见 utils/panelGrip）：实时写 store，钳制在 useAppStore 里 */
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    beginPanelGripDrag(e, rootRef.current, (r) => useAppStore.getState().setSearchPanelRatio(r))
  }

  // Ctrl+Shift+F 聚焦回调
  useEffect(() => {
    setGlobalSearchFocus(() => inputRef.current?.focus())
    return () => setGlobalSearchFocus(null)
  }, [])

  // 展开后自动聚焦输入框
  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => inputRef.current?.focus())
  }, [searchOpen])

  // 执行搜索
  const doSearch = useCallback(async () => {
    const q = query.trim()
    if (!q || !rootPath) {
      setFileMatches([])
      setTotalMatches(0)
      setTruncated(false)
      setSearched(false)
      return
    }
    const seq = ++seqRef.current
    setSearching(true)
    setSearched(true)
    try {
      const result = await api.grepFiles(rootPath, q, {
        caseSensitive,
        excludeGlobs: searchExclude,
        literal: !useRegex,
        maxResults: 500,
      })
      if (seq !== seqRef.current) return
      const groups = new Map<string, { line: number; text: string }[]>()
      for (const m of result.matches) {
        const arr = groups.get(m.path) ?? []
        arr.push({ line: m.line, text: m.text })
        groups.set(m.path, arr)
      }
      const files: FileMatch[] = []
      for (const [path, matches] of groups) files.push({ path, matches, open: true })
      setFileMatches(files)
      setTotalMatches(result.matches.length)
      setTruncated(result.truncated)
    } catch (e) {
      console.error('搜索失败：', e)
      setFileMatches([])
      setTotalMatches(0)
    } finally {
      if (seq === seqRef.current) setSearching(false)
    }
  }, [query, caseSensitive, useRegex, searchExclude, rootPath])

  /** 排除后缀提交：与后端同口径归一化（剥 *. 前缀、补点、小写）+ 去重；逗号分隔可批量 */
  const commitExclude = () => {
    const parts = exclDraft.split(/[,，]/).map((g) => g.trim().toLowerCase().replace(/^\*\./, '').replace(/^\*/, '')).filter(Boolean)
    setExclDraft('')
    if (parts.length === 0) return
    const next = [...searchExclude]
    for (const g of parts) {
      const ext = g.startsWith('.') ? g : `.${g}`
      if (!next.includes(ext)) next.push(ext)
    }
    setSearchExclude(next)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); void doSearch() }
  }

  const toggleFile = (path: string) => {
    setFileMatches((prev) => prev.map((f) => (f.path === path ? { ...f, open: !f.open } : f)))
  }

  const gotoMatch = async (filePath: string, line: number) => {
    // filePath 是 grepFiles 返回的相对路径，转为绝对路径
    const absPath = rootPath ? joinPath(rootPath, filePath) : filePath
    await revealPath(absPath)
    await openFile(absPath)
    requestAnimationFrame(() => {
      const editor = getEditorInstance()
      if (!editor) return
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column: 1 })
      editor.focus()
    })
  }

  const clearSearch = () => {
    setQuery(''); setFileMatches([]); setTotalMatches(0)
    setTruncated(false); setSearched(false)
    inputRef.current?.focus()
  }

  return (
    <div
      ref={rootRef}
      className={`search-panel ${searchOpen ? '' : 'search-panel--collapsed'}`}
      style={searchOpen ? { height: `${Math.round(searchPanelRatio * 100)}%` } : undefined}
    >
      {/* 顶部拖拽手柄：调面板高度（store 持久化）；折叠态无高度可调，隐藏 */}
      {searchOpen && (
        <div
          className="search-panel__grip"
          onPointerDown={onGripDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整搜索面板高度"
        />
      )}
      {/* 标题栏：点击折叠/展开 */}
      <button className="search-panel__head" onClick={toggleSearch}>
        <IconChevron
          size={12}
          className={`search-panel__chevron ${searchOpen ? 'search-panel__chevron--open' : ''}`}
        />
        <IconSearch size={12} />
        <span className="search-panel__title">全局搜索</span>
        {totalMatches > 0 && (
          <span className="search-panel__count">{totalMatches}</span>
        )}
      </button>

      {/* 面板内容：仅展开时渲染 */}
      {searchOpen && (
        <div className="search-panel__body">
          {/* 搜索输入 */}
          <div className="search-panel__input-row">
            <IconSearch size={13} className="search-panel__input-icon" />
            <input
              ref={inputRef}
              className="search-panel__input"
              type="text"
              placeholder="搜索内容…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoComplete="off"
            />
            {query && (
              <button className="search-panel__clear-btn" onClick={clearSearch} title="清空">
                <IconClose size={11} />
              </button>
            )}
            <button
              className={`search-panel__opt-btn ${caseSensitive ? 'search-panel__opt-btn--active' : ''}`}
              onClick={() => setCaseSensitive((v) => !v)}
              aria-pressed={caseSensitive}
              title="区分大小写"
            >Aa</button>
            <button
              className={`search-panel__opt-btn ${useRegex ? 'search-panel__opt-btn--active' : ''}`}
              onClick={() => setUseRegex((v) => !v)}
              aria-pressed={useRegex}
              title="正则表达式"
            >.*</button>
            <button
              className={`search-panel__opt-btn search-panel__opt-btn--wide ${showExclude ? 'search-panel__opt-btn--active' : ''}`}
              onClick={() => setShowExclude((v) => !v)}
              aria-pressed={showExclude}
              aria-expanded={showExclude}
              title={searchExclude.length > 0 ? `已生效排除：${searchExclude.join(' ')}` : '排除指定后缀的文件（如 log、tmp）'}
            >{searchExclude.length > 0 ? `排除·${searchExclude.length}` : '排除'}</button>
          </div>

          {/* 排除后缀标签：pill 展示已生效后缀（× 移除），行尾内联输入回车成标签；
              Backspace 空值删尾标签（标签编辑器惯例）。store 持久化 */}
          {showExclude && (
            <div className="search-panel__excl-row">
              {searchExclude.map((ext) => (
                <span key={ext} className="search-panel__chip">
                  {ext}
                  <button
                    className="search-panel__chip-x"
                    onClick={() => setSearchExclude(searchExclude.filter((e) => e !== ext))}
                    aria-label={`移除排除后缀 ${ext}`}
                    title="移除"
                  >
                    <IconClose size={9} />
                  </button>
                </span>
              ))}
              <input
                className="search-panel__excl-input"
                type="text"
                placeholder={searchExclude.length > 0 ? '添加…' : '如 log, tmp'}
                value={exclDraft}
                onChange={(e) => setExclDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitExclude() }
                  if (e.key === 'Backspace' && exclDraft === '' && searchExclude.length > 0) {
                    setSearchExclude(searchExclude.slice(0, -1))
                  }
                  if (e.key === 'Escape') setShowExclude(false)
                }}
                onBlur={commitExclude}
                spellCheck={false}
                autoComplete="off"
                aria-label="添加排除的文件后缀"
              />
            </div>
          )}

          {/* 结果统计 */}
          {searched && (
            <div className="search-panel__status">
              {searching
                ? '搜索中…'
                : totalMatches > 0
                  ? `${totalMatches} 个结果，${fileMatches.length} 个文件${truncated ? '（截断）' : ''}`
                  : '未找到结果'}
            </div>
          )}

          {/* 结果列表（面板内滚动） */}
          <div className="search-panel__results">
            {fileMatches.map((file) => (
              <div key={file.path} className="search-file-group">
                <button className="search-file-group__header" onClick={() => toggleFile(file.path)}>
                  <IconChevron size={12}
                    className={`search-file-group__chevron ${file.open ? 'search-file-group__chevron--open' : ''}`}
                  />
                  <span className="search-file-group__name">{basename(file.path)}</span>
                  <span className="search-file-group__path" title={file.path}>{file.path}</span>
                  <span className="search-file-group__count">{file.matches.length}</span>
                </button>
                {file.open && file.matches.map((m, i) => (
                  <button
                    key={`${file.path}:${m.line}:${i}`}
                    className="search-match"
                    onClick={() => void gotoMatch(file.path, m.line)}
                    title={`${file.path}:${m.line}`}
                  >
                    <span className="search-match__line">{m.line}</span>
                    <span className="search-match__text">
                      {highlightText(m.text, query, caseSensitive, !useRegex)}
                    </span>
                  </button>
                ))}
              </div>
            ))}

            {searched && !searching && totalMatches === 0 && (
              <div className="search-panel__no-results">
                <IconSearch size={14} /><p>未找到匹配内容</p>
              </div>
            )}
            {!searched && (
              <div className="search-panel__no-results">
                <IconSearch size={14} /><p>输入关键词按 Enter 搜索</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}