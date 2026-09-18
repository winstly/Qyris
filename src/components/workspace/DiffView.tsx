/**
 * Git diff 全面板视图：以覆盖层铺满编辑器区域（FilesTab 第二窗格内 absolute）。
 * 头部：文件路径 + 工作区/暂存区视图切换 + 分栏/统一切换 + 关闭。
 * 正文：分栏（默认，左旧右新逐行对齐）/ 统一 diff 两种渲染。
 */
import { useMemo, useState } from 'react'
import { useFileStore } from '@/store/useFileStore'
import { useGitStore } from '@/store/useGitStore'
import { IconClose } from '@/components/common/icons'

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
    return 'files-diff__line files-diff__line--meta'
  }
  if (line.startsWith('@@')) return 'files-diff__line files-diff__line--hunk'
  if (line.startsWith('+')) return 'files-diff__line files-diff__line--add'
  if (line.startsWith('-')) return 'files-diff__line files-diff__line--del'
  return 'files-diff__line'
}

// ---------- 分栏解析：unified diff → 左右逐行对齐的行矩阵 ----------

type SideCell = { num: number | null; type: 'ctx' | 'add' | 'del' | 'hunk'; text: string }
type SplitRow = { left: SideCell | null; right: SideCell | null }

/** 把 unified diff 解析为左右行矩阵：上下文左右同行，删/加按块内序号配对，落单侧补空 */
export function parseSplitRows(text: string): SplitRow[] {
  const lines = text.split('\n')
  const rows: SplitRow[] = []
  let oldNo = 0
  let newNo = 0
  // 待配对的删/加缓冲（同一段连续 -/+ 块内按序配对）
  let dels: string[] = []
  let adds: string[] = []
  let oldStart = 0
  let newStart = 0

  const flushPairs = (): void => {
    const n = Math.max(dels.length, adds.length)
    for (let k = 0; k < n; k++) {
      const d = dels[k]
      const a = adds[k]
      rows.push({
        left: d !== undefined ? { num: oldStart + k, type: 'del', text: d.slice(1) } : null,
        right: a !== undefined ? { num: newStart + k, type: 'add', text: a.slice(1) } : null,
      })
    }
    oldStart += dels.length
    newStart += adds.length
    dels = []
    adds = []
  }

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flushPairs()
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        oldStart = parseInt(m[1], 10)
        newStart = parseInt(m[2], 10)
      }
      rows.push({
        left: { num: null, type: 'hunk', text: line },
        right: null,
      })
      oldNo = oldStart
      newNo = newStart
      continue
    }
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue
    if (line.startsWith('-')) {
      dels.push(line)
      continue
    }
    if (line.startsWith('+')) {
      adds.push(line)
      continue
    }
    // 上下文行：先冲刷配对缓冲，再左右同行
    flushPairs()
    const text = line.startsWith(' ') ? line.slice(1) : line
    rows.push({
      left: { num: oldNo++, type: 'ctx', text },
      right: { num: newNo++, type: 'ctx', text },
    })
  }
  flushPairs()
  return rows
}

function cellClass(cell: SideCell | null, side: 'left' | 'right'): string {
  if (!cell) return 'files-diff__cell files-diff__cell--blank'
  if (cell.type === 'hunk') return 'files-diff__cell files-diff__cell--hunk'
  if (cell.type === 'ctx') return 'files-diff__cell'
  return `files-diff__cell files-diff__cell--${side === 'left' ? 'del' : 'add'}`
}

export function DiffView() {
  const rootPath = useFileStore((s) => s.rootPath)
  const diff = useGitStore((s) => s.diff)
  const switchMode = useGitStore((s) => s.switchMode)
  const close = useGitStore((s) => s.close)
  const [splitView, setSplitView] = useState(true)
  const splitRows = useMemo(
    () => (diff?.text ? parseSplitRows(diff.text) : []),
    [diff?.text],
  )
  if (!diff || !rootPath) return null

  return (
    <div className="files-diff" role="region" aria-label={`diff 查看：${diff.path}`}>
      <div className="files-diff__head">
        <span className="files-diff__tag">diff</span>
        <span className="files-diff__path mono" title={diff.path}>{diff.path}</span>
        <div className="files-diff__mode" role="radiogroup" aria-label="diff 视图">
          <button
            className={`files-diff__mode-btn ${!diff.staged ? 'files-diff__mode-btn--active' : ''}`}
            onClick={() => void switchMode(rootPath, false)}
            title="工作区 vs 暂存区"
          >
            工作区
          </button>
          <button
            className={`files-diff__mode-btn ${diff.staged ? 'files-diff__mode-btn--active' : ''}`}
            onClick={() => void switchMode(rootPath, true)}
            title="暂存区 vs HEAD"
          >
            暂存区
          </button>
        </div>
        <div className="files-diff__mode" role="radiogroup" aria-label="diff 布局">
          <button
            className={`files-diff__mode-btn ${splitView ? 'files-diff__mode-btn--active' : ''}`}
            onClick={() => setSplitView(true)}
            title="左右分栏对比"
          >
            分栏
          </button>
          <button
            className={`files-diff__mode-btn ${!splitView ? 'files-diff__mode-btn--active' : ''}`}
            onClick={() => setSplitView(false)}
            title="统一视图"
          >
            统一
          </button>
        </div>
        <button className="icon-btn" onClick={close} aria-label="关闭 diff" title="关闭 diff">
          <IconClose size={13} />
        </button>
      </div>
      <div className="files-diff__body mono">
        {diff.text === null ? (
          <div className="files-diff__empty">加载 diff…</div>
        ) : diff.text === '' ? (
          <div className="files-diff__empty">（无差异）</div>
        ) : splitView ? (
          <div className="files-diff__split">
            {splitRows.map((row, i) => {
              const isHunk = row.left?.type === 'hunk'
              return (
                <div key={i} className={`files-diff__row ${isHunk ? 'files-diff__row--hunk' : ''}`}>
                  <div className={cellClass(row.left, 'left')}>
                    <span className="files-diff__num">{row.left?.num ?? ''}</span>
                    <span className="files-diff__cell-text">{row.left?.text ?? ''}</span>
                  </div>
                  <div className={cellClass(row.right, 'right')}>
                    <span className="files-diff__num">{row.right?.num ?? ''}</span>
                    <span className="files-diff__cell-text">{row.right?.text ?? ''}</span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          diff.text.split('\n').map((line, i) => (
            <div key={i} className={lineClass(line)}>{line || ' '}</div>
          ))
        )}
      </div>
    </div>
  )
}