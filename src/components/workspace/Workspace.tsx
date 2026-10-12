import { useAppStore } from '@/store/useAppStore'
import { PreviewTab } from './PreviewTab'
import { FilesTab } from './FilesTab'
import { CreateProjectDialog } from './CreateProjectDialog'
import { MemoryPanel } from '@/components/memory/MemoryPanel'
import { ExtensionsTab } from './ExtensionsTab'
import { TerminalTab } from './TerminalTab'
import { IconEye, IconFile, IconLayers, IconTerminal } from '@/components/common/icons'

/** 工作区：「文件 / 预览 / 记忆（项目记忆） / 扩展（技能+MCP 两切片） / 终端」五个 Tab */
const TAB_ORDER = ['files', 'preview', 'memory', 'extensions', 'terminal'] as const

export function Workspace() {
  const activeTab = useAppStore((s) => s.activeTab)
  const setTab = useAppStore((s) => s.setTab)
  const projectPath = useAppStore((s) => s.projectPath)

  /** tablist 键盘循环：←/→ 在 Tab 间移动（WAI-ARIA tabs 模式） */
  const onTabsKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const idx = TAB_ORDER.indexOf(activeTab)
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const next = (idx + dir + TAB_ORDER.length) % TAB_ORDER.length
    setTab(TAB_ORDER[next])
    // 焦点跟到新激活 tab（roving）
    const tabs = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs[next]?.focus()
  }

  return (
    <div className="workspace">
      <div className="workspace__tabs" role="tablist" aria-label="工作区视图" onKeyDown={onTabsKeyDown}>
        <button
          role="tab"
          aria-selected={activeTab === 'files'}
          className={`tab-underline workspace__tab ${activeTab === 'files' ? 'tab-underline--active' : ''}`}
          onClick={() => setTab('files')}
        >
          <IconFile size={13} /> 文件
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'preview'}
          className={`tab-underline workspace__tab ${activeTab === 'preview' ? 'tab-underline--active' : ''}`}
          onClick={() => setTab('preview')}
        >
          <IconEye size={13} /> 预览
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'memory'}
          className={`tab-underline workspace__tab ${activeTab === 'memory' ? 'tab-underline--active' : ''}`}
          onClick={() => setTab('memory')}
        >
          <IconLayers size={13} /> 记忆
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'extensions'}
          className={`tab-underline workspace__tab ${activeTab === 'extensions' ? 'tab-underline--active' : ''}`}
          onClick={() => setTab('extensions')}
        >
          <IconTerminal size={13} /> 扩展
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'terminal'}
          className={`tab-underline workspace__tab ${activeTab === 'terminal' ? 'tab-underline--active' : ''}`}
          onClick={() => setTab('terminal')}
        >
          <IconTerminal size={13} /> 终端
        </button>
      </div>

      <CreateProjectDialog />

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
        <div className={`pane ${activeTab === 'extensions' ? 'pane--active' : ''}`}>
          <ExtensionsTab />
        </div>
        <div className={`pane ${activeTab === 'terminal' ? 'pane--active' : ''}`}>
          <TerminalTab />
        </div>
      </div>
    </div>
  )
}
