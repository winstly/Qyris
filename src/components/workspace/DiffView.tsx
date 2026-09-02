/**
 * Git diff 全面板视图：以覆盖层铺满编辑器区域（FilesTab 第二窗格内 absolute）。
 * 头部：文件路径 + 工作区/暂存区视图切换 + 关闭；正文：统一 diff 着色渲染。
 */
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

export function DiffView() {
  const rootPath = useFileStore((s) => s.rootPath)
  const diff = useGitStore((s) => s.diff)
  const switchMode = useGitStore((s) => s.switchMode)
  const close = useGitStore((s) => s.close)
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
        <button className="icon-btn" onClick={close} aria-label="关闭 diff" title="关闭 diff">
          <IconClose size={13} />
        </button>
      </div>
      <div className="files-diff__body mono">
        {diff.text === null ? (
          <div className="files-diff__empty">加载 diff…</div>
        ) : diff.text === '' ? (
          <div className="files-diff__empty">（无差异）</div>
        ) : (
          diff.text.split('\n').map((line, i) => (
            <div key={i} className={lineClass(line)}>{line || ' '}</div>
          ))
        )}
      </div>
    </div>
  )
}
