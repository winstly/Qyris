import { useAppStore } from '@/store/useAppStore'
import { SplitPane } from '@/components/common/SplitPane'
import { FileTree } from './FileTree'
import { EditorPane } from './EditorPane'

/** 文件 Tab：左文件树（可拖拽分割） + 右代码编辑器。 */
export function FilesTab() {
  const filesSplitRatio = useAppStore((s) => s.filesSplitRatio)
  const setFilesSplitRatio = useAppStore((s) => s.setFilesSplitRatio)

  return (
    <div className="files-tab">
      <SplitPane
        orientation="vertical"
        ratio={filesSplitRatio}
        onRatioChange={setFilesSplitRatio}
        minFirst={180}
        minSecond={320}
        first={<FileTree />}
        second={<EditorPane />}
      />
    </div>
  )
}
