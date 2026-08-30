import { useEffect } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'

/**
 * 全局快捷键：
 * - Cmd/Ctrl + O  打开项目
 * - Cmd/Ctrl + S  保存当前文件
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
      }
    }
    // capture：在 CodeMirror 等内部 keymap 处理之前截获
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
