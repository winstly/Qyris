import { useEffect } from 'react'
import { executeCommand, canRunCommand } from '@/services/commands'

/**
 * 全局快捷键 → 中央命令注册表（键位 → 命令 id 的唯一映射表）：
 * - Cmd/Ctrl + O  workbench.action.openProject
 * - Cmd/Ctrl + S  file.save（有活动文件时可执行）
 * - Cmd/Ctrl + M  view.toggleMemorySidebar
 * - Cmd/Ctrl + F  file.find（编辑器内搜索或聚焦文件树搜索框）
 * 新命令在 services/commands.ts 注册，键位绑定只认 id。
 * 注意：已绑定的键一律 preventDefault（漏给 Chromium 会触发默认行为，如 Ctrl+S 存网页），
 * when 谓词只决定命令是否执行。
 */
const KEY_BINDINGS: Record<string, string> = {
  o: 'workbench.action.openProject',
  s: 'file.save',
  m: 'view.toggleMemorySidebar',
  f: 'file.find',
}

/** 需要同时按 Shift 的快捷键（Ctrl+Shift+X） */
const SHIFT_BINDINGS: Record<string, string> = {
  f: 'workbench.action.globalSearch',
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      // Shift 组合键优先匹配（Ctrl+Shift+F 不应落入 Ctrl+F）
      if (e.shiftKey) {
        const commandId = SHIFT_BINDINGS[key]
        if (commandId) {
          e.preventDefault()
          if (canRunCommand(commandId)) executeCommand(commandId)
          return
        }
      }
      const commandId = KEY_BINDINGS[key]
      if (!commandId) return
      e.preventDefault()
      if (canRunCommand(commandId)) executeCommand(commandId)
    }
    // capture：在编辑器内部 keymap 处理之前截获
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
