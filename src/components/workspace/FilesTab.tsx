import { useAppStore } from '@/store/useAppStore'
import { useGitStore } from '@/store/useGitStore'
import { SplitPane } from '@/components/common/SplitPane'
import { FileTree } from './FileTree'
import { EditorPane } from './EditorPane'
import { GitPanel } from './GitPanel'
import { DiffView } from './DiffView'
import { GitOpDialog } from './GitOpDialog'

/** 文件 Tab：左文件树 + Git commit 工作区（可拖拽分割） + 右代码编辑器（可被 diff 覆盖层接管）。 */
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
            <GitPanel />
          </div>
        }
        second={
          <div className="files-second">
            <EditorPane />
            {/* diff 覆盖层：铺满编辑器区域；编辑器保持挂载，关闭后状态不丢 */}
            {hasDiff && <DiffView />}
          </div>
        }
      />
    </div>
  )
}
