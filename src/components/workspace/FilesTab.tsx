import { useAppStore } from '@/store/useAppStore'
import { useGitStore } from '@/store/useGitStore'
import { SplitPane } from '@/components/common/SplitPane'
import { FileTree } from './FileTree'
import { SearchPanel } from './SearchPanel'
import { EditorPane } from './EditorPane'
import { GitPanel } from './GitPanel'
import { DiffView } from './DiffView'
import { GitOpDialog } from './GitOpDialog'

/** 文件 Tab：左文件树 + 搜索面板（可折叠） + Git 工作区 + 右代码编辑器。 */
export function FilesTab() {
  const filesSplitRatio = useAppStore((s) => s.filesSplitRatio)
  const setFilesSplitRatio = useAppStore((s) => s.setFilesSplitRatio)
  const hasDiff = useGitStore((s) => s.diff !== null)

  return (
    <div className="files-tab">
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
    </div>
  )
}
