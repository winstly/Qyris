import { useEffect } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { getEditorInstance } from '@/components/workspace/EditorPane'
import { focusFileSearch } from '@/components/workspace/FileTree'

/**
 * 全局快捷键：
 * - Cmd/Ctrl + O  打开项目
 * - Cmd/Ctrl + S  保存当前文件
 * - Cmd/Ctrl + F  搜索：有活动文本文件时在编辑器内搜索，否则聚焦文件树搜索框
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
        // 有活动文本文件 → 编辑器内搜索
        if (fs.activePath && !fs.binaryFiles[fs.activePath]) {
          const editor = getEditorInstance()
          if (editor) {
            e.preventDefault()
            editor.getAction('actions.find')?.run()
            return
          }
        }
        // 其他情况 → 聚焦文件树搜索框
        e.preventDefault()
        focusFileSearch()
      }
    }
    // capture：在编辑器内部 keymap 处理之前截获
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
