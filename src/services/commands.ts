/**
 * 中央命令注册表（vscode CommandsRegistry 精简版）。
 * 核心思想：快捷键 / 菜单 / 功能按钮共用同一执行入口与 enabled 谓词——
 * UI 可点性与命令执行条件同源，不会出现「按钮能点但命令拒绝」。
 * 既有命令先入表（快捷键已迁移）；右键菜单/斜杠命令按需渐进迁移。
 */
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { getEditorInstance } from '@/components/workspace/EditorPane'
import { focusFileSearch } from '@/components/workspace/FileTree'

export interface CommandDef {
  id: string
  /** 展示名（菜单/命令面板用） */
  label: string
  run: () => unknown
  /** 执行条件谓词（缺省恒可执行） */
  when?: () => boolean
}

const registry = new Map<string, CommandDef>()

/** 注册命令；返回注销函数 */
export function registerCommand(def: CommandDef): () => void {
  registry.set(def.id, def)
  return () => {
    registry.delete(def.id)
  }
}

export function getCommand(id: string): CommandDef | undefined {
  return registry.get(id)
}

/** 可执行判定（when 谓词）——UI disabled 态与执行入口共用 */
export function canRunCommand(id: string): boolean {
  const def = registry.get(id)
  if (!def) return false
  try {
    return def.when ? def.when() : true
  } catch {
    return false
  }
}

/** 单一执行入口 */
export function executeCommand(id: string): unknown {
  if (!canRunCommand(id)) return undefined
  return registry.get(id)!.run()
}

// ---------- 内置命令表 ----------

registerCommand({
  id: 'workbench.action.openProject',
  label: '打开项目…',
  run: () => void useAppStore.getState().openProjectDialog(),
})

registerCommand({
  id: 'file.save',
  label: '保存当前文件',
  run: () => void useFileStore.getState().saveFile(),
  when: () => useFileStore.getState().activePath !== null,
})

registerCommand({
  id: 'view.toggleMemorySidebar',
  label: '切换记忆侧边栏',
  run: () => useAppStore.getState().toggleMemorySidebar(),
})

registerCommand({
  id: 'file.find',
  label: '搜索',
  /** 有活动文本文件 → 编辑器内搜索；否则 → 聚焦文件树搜索框 */
  run: () => {
    const fs = useFileStore.getState()
    if (fs.activePath && !fs.binaryFiles[fs.activePath]) {
      const editor = getEditorInstance()
      if (editor) {
        editor.getAction('actions.find')?.run()
        return
      }
    }
    focusFileSearch()
  },
})

/** 聚焦全局搜索面板搜索框 */
let globalSearchFocusRef: (() => void) | null = null
export function setGlobalSearchFocus(fn: (() => void) | null): void {
  globalSearchFocusRef = fn
}

registerCommand({
  id: 'workbench.action.globalSearch',
  label: '全局搜索…',
  run: () => {
    // 切到文件 Tab 并展开搜索面板
    const app = useAppStore.getState()
    app.setTab('files')
    if (!app.searchOpen) app.toggleSearch()
    // 下一帧聚焦输入框（React 渲染后 ref 才就绪）
    requestAnimationFrame(() => globalSearchFocusRef?.())
  },
})

registerCommand({
  id: 'view.toggleFileTree',
  label: '切换文件树折叠',
  run: () => useAppStore.getState().toggleFileTree(),
})

registerCommand({
  id: 'view.toggleChatPanel',
  label: '切换对话栏折叠',
  run: () => useAppStore.getState().toggleChatPanel(),
})
