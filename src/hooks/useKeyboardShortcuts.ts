import { useEffect } from 'react'
import { openSearchPanel } from '@codemirror/search'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { getEditorView } from '@/components/workspace/EditorPane'

/**
 * 全局快捷键：
 * - Cmd/Ctrl + O  打开项目
 * - Cmd/Ctrl + S  保存当前文件
 * - Cmd/Ctrl + F  在编辑器中搜索（有活动文本文件时呼出搜索面板并聚焦，编辑器未聚焦也生效）
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()

      if (key === 'o') {
        e.preventDefault()
        void useAppStore.getState().openProjectDialog()
      } else if (key === 's') {
        e.preventDefault()
        void useFileStore.getState().saveFile()
      } else if (key === 'f') {
        const fs = useFileStore.getState()
        // 无活动文件 / 二进制文件时不接管，保持默认行为
        if (!fs.activePath || fs.binaryFiles[fs.activePath]) return
        const view = getEditorView()
        if (!view) return
        e.preventDefault()
        openSearchPanel(view)
        view.focus()
      }
    }
    // capture：在 CodeMirror 等内部 keymap 处理之前截获
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
