import { useAppStore } from '@/store/useAppStore'
import { PreviewTab } from './PreviewTab'
import { FilesTab } from './FilesTab'
import { CreateProjectDialog } from './CreateProjectDialog'
import { MemoryPanel } from '@/components/memory/MemoryPanel'
import { IconEye, IconFile, IconLayers } from '@/components/common/icons'

/** 工作区：「文件 / 预览 / 记忆（项目记忆）」三个 Tab（项目列表已移至左侧折叠面板） */
export function Workspace() {
  const activeTab = useAppStore((s) => s.activeTab)
  const setTab = useAppStore((s) => s.setTab)
  const projectPath = useAppStore((s) => s.projectPath)
  const createProjectOpen = useAppStore((s) => s.createProjectOpen)
  const setCreateProjectOpen = useAppStore((s) => s.setCreateProjectOpen)

  return (
    <div className="workspace">
      <div className="workspace__tabs" role="tablist" aria-label="工作区视图">
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
          aria-selected={activeTab === 'preview'}
          className={`workspace__tab ${activeTab === 'preview' ? 'workspace__tab--active' : ''}`}
          onClick={() => setTab('preview')}
        >
          <IconEye size={13} /> 预览
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'memory'}
          className={`workspace__tab ${activeTab === 'memory' ? 'workspace__tab--active' : ''}`}
          onClick={() => setTab('memory')}
        >
          <IconLayers size={13} /> 记忆
        </button>
      </div>

      <CreateProjectDialog open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} />

      <div className="workspace__panes" key={projectPath ?? 'none'}>
        <div className={`pane ${activeTab === 'files' ? 'pane--active' : ''}`}>
          <FilesTab />
        </div>
        <div className={`pane ${activeTab === 'preview' ? 'pane--active' : ''}`}>
          <PreviewTab />
        </div>
        <div className={`pane ${activeTab === 'memory' ? 'pane--active' : ''}`}>
          <MemoryPanel />
        </div>
      </div>
    </div>
  )
}
