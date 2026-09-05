import { useAppStore } from '@/store/useAppStore'
import { PreviewTab } from './PreviewTab'
import { FilesTab } from './FilesTab'
import { ProjectsTab } from './ProjectsTab'
import { CreateProjectDialog } from './CreateProjectDialog'
import { ProjectSwitcher } from './ProjectSwitcher'
import { IconEye, IconFolder, IconFile } from '@/components/common/icons'

/** 工作区：「项目 / 文件 / 预览」三个 Tab */
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
          aria-selected={activeTab === 'projects'}
          className={`workspace__tab ${activeTab === 'projects' ? 'workspace__tab--active' : ''}`}
          onClick={() => setTab('projects')}
        >
          <IconFolder size={13} /> 项目
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
          aria-selected={activeTab === 'preview'}
          className={`workspace__tab ${activeTab === 'preview' ? 'workspace__tab--active' : ''}`}
          onClick={() => setTab('preview')}
        >
          <IconEye size={13} /> 预览
        </button>

        <div className="workspace__spacer" />
        <ProjectSwitcher />
      </div>

      <CreateProjectDialog open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} />

      <div className="workspace__panes" key={projectPath ?? 'none'}>
        <div className={`pane ${activeTab === 'projects' ? 'pane--active' : ''}`}>
          <ProjectsTab />
        </div>
        <div className={`pane ${activeTab === 'files' ? 'pane--active' : ''}`}>
          <FilesTab />
        </div>
        <div className={`pane ${activeTab === 'preview' ? 'pane--active' : ''}`}>
          <PreviewTab />
        </div>
      </div>
    </div>
  )
}
