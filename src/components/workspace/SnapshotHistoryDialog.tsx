/**
 * 快照历史弹层：单文件的全部可回退版本（会话基线 + 各次 AI 写入前的版本快照）。
 * 行内操作：对比（unified diff 预览，回退前先看差异）/ 回退到该版本。
 * 样式复用 modal-* 与 files-diff__line 着色，不新增 CSS。
 */
import { useState } from 'react'
import { api } from '@/services/desktop'
import { useFileStore } from '@/store/useFileStore'
import { basename } from '@/utils/path'
import type { SnapshotVersion } from '../../../shared/types'
import { IconClose } from '@/components/common/icons'

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('@@')) {
    return 'files-diff__line files-diff__line--meta'
  }
  if (line.startsWith('+')) return 'files-diff__line files-diff__line--add'
  if (line.startsWith('-')) return 'files-diff__line files-diff__line--del'
  return 'files-diff__line'
}

const versionKey = (v: SnapshotVersion): string => `${v.sessionId}:${v.versionKey ?? 'base'}`

export function SnapshotHistoryDialog() {
  const history = useFileStore((s) => s.snapshotHistory)
  const rootPath = useFileStore((s) => s.rootPath)
  const close = useFileStore((s) => s.closeSnapshotHistory)
  const restore = useFileStore((s) => s.restoreSnapshotVersion)
  const [diff, setDiff] = useState<{ key: string; text: string | null } | null>(null)

  if (!history || !rootPath) return null

  const toggleDiff = async (v: SnapshotVersion): Promise<void> => {
    const key = versionKey(v)
    if (diff?.key === key) {
      setDiff(null)
      return
    }
    setDiff({ key, text: null })
    try {
      setDiff({ key, text: (await api.snapshotDiff(rootPath, v.sessionId, history.path, v.versionKey)) || '' })
    } catch (e) {
      setDiff({ key, text: `加载差异失败：${String(e)}` })
    }
  }

  return (
    <div className="modal-mask" onClick={close} role="presentation">
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="快照历史">
        <div className="modal__head">
          <span>快照历史 · {basename(history.path)}</span>
          <button className="icon-btn" onClick={close} aria-label="关闭快照历史" title="关闭">
            <IconClose size={13} />
          </button>
        </div>
        <div className="modal__body">
          {history.versions.map((v) => {
            const key = versionKey(v)
            return (
              <div key={key} style={{ marginBottom: 'var(--space-3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <span style={{ flex: 1 }}>
                    <strong>{v.versionKey === null ? '会话基线' : 'AI 写入前'}</strong>
                    <span style={{ color: 'var(--fg-2)', marginLeft: 'var(--space-2)' }}>
                      {new Date(v.ts).toLocaleString()} · 会话 {v.sessionId.slice(0, 8)}
                    </span>
                  </span>
                  <button className="btn btn--sm" onClick={() => void toggleDiff(v)}>
                    {diff?.key === key ? '收起对比' : '对比当前'}
                  </button>
                  <button className="btn btn--sm" onClick={() => void restore(v)}>
                    回退到此版本
                  </button>
                </div>
                {diff?.key === key && (
                  <div
                    className="mono"
                    style={{
                      marginTop: 'var(--space-2)',
                      maxHeight: 260,
                      overflowY: 'auto',
                      background: 'var(--panel)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 'var(--space-2)',
                    }}
                  >
                    {diff.text === null ? (
                      '加载差异…'
                    ) : diff.text === '' ? (
                      '（与当前内容无差异）'
                    ) : (
                      diff.text.split('\n').map((line, i) => (
                        <div key={i} className={lineClass(line)}>{line || ' '}</div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
