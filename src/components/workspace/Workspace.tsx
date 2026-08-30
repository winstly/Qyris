import { useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { PreviewTab } from './PreviewTab'
import { FilesTab } from './FilesTab'
import { HistoryTab } from './HistoryTab'
import { CreateProjectDialog } from './CreateProjectDialog'
import { IconEye, IconFolder, IconFile, IconClock, IconPlus } from '@/components/common/icons'

/** 左侧工作区：「预览 / 文件 / 历史」三个 Tab。窗格常驻挂载（切换只做过渡动画，
 *  避免 iframe 与编辑器状态因重挂载而丢失）。 */
export function Workspace() {
  const activeTab = useAppStore((s) => s.activeTab)
  const setTab = useAppStore((s) => s.setTab)
  const openProjectDialog = useAppStore((s) => s.openProjectDialog)
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="workspace">
      <div className="workspace__tabs" role="tablist" aria-label="工作区视图">
        <button
          role="tab"
          aria-selected={activeTab === 'preview'}
          className={`workspace__tab ${activeTab === 'preview' ? 'workspace__tab--active' : ''}`}
          onClick={() => setTab('preview')}
        >
          <IconEye size={13} /> 预览
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'files'}
          className={`workspace__tab ${activeTab === 'files' ? 'workspace__tab--active' : ''}`}
          onClick={() => setTab('files')}
        >
          <IconFile size={13} /> 文件
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'history'}
          className={`workspace__tab ${activeTab === 'history' ? 'workspace__tab--active' : ''}`}
          onClick={() => setTab('history')}
        >
          <IconClock size={13} /> 历史
        </button>

        <div className="workspace__spacer" />

        <button className="btn btn--ghost btn--sm" onClick={() => setCreateOpen(true)}>
          <IconPlus size={13} /> 创建项目
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => void openProjectDialog()}>
          <IconFolder size={13} /> 打开项目
        </button>
      </div>

      <CreateProjectDialog open={createOpen} onClose={() => setCreateOpen(false)} />

      <div className="workspace__panes">
        <div className={`pane ${activeTab === 'preview' ? 'pane--active' : ''}`}>
          <PreviewTab />
        </div>
        <div className={`pane ${activeTab === 'files' ? 'pane--active' : ''}`}>
          <FilesTab />
        </div>
        <div className={`pane ${activeTab === 'history' ? 'pane--active' : ''}`}>
          <HistoryTab />
        </div>
      </div>
    </div>
  )
}
