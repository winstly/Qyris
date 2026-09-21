import { useAppStore } from '@/store/useAppStore'
import { useGitStore } from '@/store/useGitStore'
import { SplitPane } from '@/components/common/SplitPane'
import { FileTree } from './FileTree'
import { SearchPanel } from './SearchPanel'
import { EditorPane } from './EditorPane'
import { GitPanel } from './GitPanel'
import { DiffView } from './DiffView'
import { GitOpDialog } from './GitOpDialog'
import { IconChevron } from '@/components/common/icons'

/** 文件 Tab：左文件树 + 搜索面板（可折叠） + Git 工作区 + 右代码编辑器。 */
export function FilesTab() {
  const filesSplitRatio = useAppStore((s) => s.filesSplitRatio)
  const setFilesSplitRatio = useAppStore((s) => s.setFilesSplitRatio)
  const hasDiff = useGitStore((s) => s.diff !== null)
  const fileTreeCollapsed = useAppStore((s) => s.fileTreeCollapsed)

  return (
    // 折叠走 CSS 类而非卸载 SplitPane：EditorPane（Monaco）与滚动状态保持挂载，展开零重初始化
    <div className={`files-tab ${fileTreeCollapsed ? 'files-tab--tree-collapsed' : ''}`}>
      <GitOpDialog />
      <SplitPane
        orientation="vertical"
        ratio={filesSplitRatio}
        onRatioChange={setFilesSplitRatio}
        minFirst={180}
        minSecond={320}
        first={
          <div className="files-first">
            <div className="files-first__tree">
              <FileTree />
            </div>
            <SearchPanel />
            <GitPanel />
          </div>
        }
        second={
          <div className="files-second">
            <EditorPane />
            {hasDiff && <DiffView />}
          </div>
        }
      />
      {/* 文件树折叠后的展开把手：贴左缘竖条，点击恢复 */}
      {fileTreeCollapsed && (
        <button
          className="edge-grip edge-grip--tree"
          onClick={() => useAppStore.getState().toggleFileTree()}
          aria-label="展开文件树"
          title="展开文件树"
        >
          <IconChevron size={14} />
        </button>
      )}
    </div>
  )
}
