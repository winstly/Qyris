import { useAppStore } from '@/store/useAppStore'
import { useBuildStore } from '@/store/useBuildStore'
import { useFileStore } from '@/store/useFileStore'
import { basename, languageLabel, extOf } from '@/utils/path'

export function StatusBar() {
  const projectPath = useAppStore((s) => s.projectPath)
  const activeTab = useAppStore((s) => s.activeTab)
  const slots = useBuildStore((s) => s.slots)
  const slotOrder = useBuildStore((s) => s.slotOrder)
  const activePath = useFileStore((s) => s.activePath)
  const isDirty = useFileStore((s) => (activePath ? !!s.dirty[activePath] : false))
  const cursor = useFileStore((s) => s.cursor)
  const lastSavedAt = useFileStore((s) => s.lastSavedAt)

  // 多槽汇总：运行中 / 异常计数 → 一个总览状态点 + 文案
  const live = slotOrder.map((k) => slots[k]).filter(Boolean)
  const errorCount = live.filter((st) => st.phase === 'error').length
  const runningCount = live.filter((st) => st.processAlive).length
  let dot: string
  let summary: string
  if (live.length === 0) {
    dot = 'idle'
    summary = '未运行'
  } else if (errorCount > 0) {
    dot = 'error'
    summary = `${errorCount} 个服务异常`
  } else if (runningCount > 0) {
    dot = 'running'
    summary = runningCount === 1 ? '1 个服务运行中' : `${runningCount} 个服务运行中`
  } else {
    dot = 'idle'
    summary = `${live.length} 个服务未运行`
  }

  return (
    <footer className="statusbar">
      <div className="statusbar__group">
        <span className={`status-dot status-dot--${dot}`} />
        <span className="statusbar__phase">{summary}</span>
        <span className="statusbar__sep" />
        <span className="statusbar__path" title={projectPath ?? undefined}>
          {projectPath ?? '未打开项目'}
        </span>
      </div>

      <div className="statusbar__group statusbar__group--center">
        {activeTab === 'files' && activePath && projectPath && (
          <>
            <span className="statusbar__file" title={activePath}>
              {basename(activePath)}{isDirty ? ' •' : ''}
            </span>
            <span className="statusbar__meta">{languageLabel(activePath)}</span>
          </>
        )}
      </div>

      <div className="statusbar__group">
        {lastSavedAt && (
          <span className="statusbar__meta statusbar__saved">
            已保存 {new Date(lastSavedAt).toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
        )}
        {activePath && <span className="statusbar__meta">Ln {cursor.line}, Col {cursor.col}</span>}
        {activePath && <span className="statusbar__meta">{extOf(basename(activePath)).toUpperCase() || 'TXT'}</span>}
        <span className="statusbar__meta">UTF-8</span>
      </div>
    </footer>
  )
}