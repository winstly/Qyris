import { useAppStore } from '@/store/useAppStore'
import { useBuildStore, selectCurrentBuild } from '@/store/useBuildStore'
import { useFileStore } from '@/store/useFileStore'
import { basename, languageLabel, extOf } from '@/utils/path'
import { IconFile, IconSend } from '@/components/common/icons'

export function StatusBar() {
  const projectPath = useAppStore((s) => s.projectPath)
  const activeTab = useAppStore((s) => s.activeTab)
  const chatPanelCollapsed = useAppStore((s) => s.chatPanelCollapsed)
  const fileTreeCollapsed = useAppStore((s) => s.fileTreeCollapsed)
  const toggleChatPanel = useAppStore((s) => s.toggleChatPanel)
  const toggleFileTree = useAppStore((s) => s.toggleFileTree)
  const { slots, slotOrder } = useBuildStore(selectCurrentBuild)
  const activePath = useFileStore((s) => s.activePath)
  const isDirty = useFileStore((s) => (activePath ? !!s.dirty[activePath] : false))
  const cursor = useFileStore((s) => s.cursor)
  const lastSavedAt = useFileStore((s) => s.lastSavedAt)

  const live = slotOrder.map((k) => slots[k]).filter(Boolean)
  const errors = live.filter((st) => st.phase === 'error').length
  const running = live.filter((st) => st.processAlive).length
  const dot = errors > 0 ? 'error' : running > 0 ? 'running' : 'idle'
  const summary = errors > 0 ? `${errors} 个服务异常`
    : running > 0 ? `${running} 个服务运行中`
    : live.length > 0 ? `${live.length} 个服务未运行` : '未运行'

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
        {/* 栏开关：折叠时高亮提示「这里有点东西被藏起来了」，点击或快捷键恢复 */}
        <button
          type="button"
          className={`statusbar__toggle ${fileTreeCollapsed ? 'statusbar__toggle--off' : ''}`}
          aria-pressed={!fileTreeCollapsed}
          title={fileTreeCollapsed ? '展开文件树 (Ctrl+B)' : '折叠文件树 (Ctrl+B)'}
          onClick={toggleFileTree}
        >
          <IconFile size={13} />
        </button>
        <button
          type="button"
          className={`statusbar__toggle ${chatPanelCollapsed ? 'statusbar__toggle--off' : ''}`}
          aria-pressed={!chatPanelCollapsed}
          title={chatPanelCollapsed ? '展开对话栏 (Ctrl+J)' : '折叠对话栏 (Ctrl+J)'}
          onClick={toggleChatPanel}
        >
          <IconSend size={13} />
        </button>
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