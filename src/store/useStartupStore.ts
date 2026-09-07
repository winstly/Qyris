/**
 * 启动命令存档：AI 编译产出的启动命令按工程路径持久化。
 * useAppStore 编排写入，tools.ts 直接读写——不再绕 useAppStore。
 */
import { create } from 'zustand'
import type { StartCommand } from '@/types'
import { api, isDesktop } from '@/services/desktop'

interface StartupState {
  /** 当前工程的启动命令（从 startupCommandsMap[projectPath] 投影） */
  startupCommands: StartCommand[]
  /** 全部工程的启动命令存档（内存缓存，落盘走 config.json） */
  startupCommandsMap: Record<string, StartCommand[]>
  /** 当前工程路径（内部，用于投影 startupCommands） */
  _currentProject: string | null

  /** 覆盖某项目的启动命令存档，同步落盘 */
  setStartupCommands: (cmds: StartCommand[], projectPath: string) => Promise<void>
  /** 清空某项目的启动命令 */
  clearStartupCommands: (projectPath: string) => Promise<void>
  /** 设置当前工程（投影 startupCommands） */
  setCurrentProject: (projectPath: string | null) => void
  /** 从 config 恢复 */
  loadFromMap: (map: Record<string, StartCommand[]>) => void
}

async function persistMap(map: Record<string, StartCommand[]>): Promise<void> {
  if (!isDesktop) return
  try { await api.mergeConfig({ startupCommands: map }) } catch { /* 静默 */ }
}

export const useStartupStore = create<StartupState>()((set, get) => ({
  startupCommands: [],
  startupCommandsMap: {},
  _currentProject: null,

  setStartupCommands: async (cmds, projectPath) => {
    const map = { ...get().startupCommandsMap, [projectPath]: cmds }
    const patch: Partial<StartupState> = { startupCommandsMap: map }
    if (get()._currentProject === projectPath) patch.startupCommands = cmds
    set(patch)
    await persistMap(map)
  },

  clearStartupCommands: async (projectPath) => {
    const map = { ...get().startupCommandsMap }
    delete map[projectPath]
    const patch: Partial<StartupState> = { startupCommandsMap: map }
    if (get()._currentProject === projectPath) patch.startupCommands = []
    set(patch)
    await persistMap(map)
  },

  setCurrentProject: (projectPath) => {
    const cmds = projectPath ? get().startupCommandsMap[projectPath] ?? [] : []
    set({ startupCommands: cmds, _currentProject: projectPath })
  },

  loadFromMap: (map) => set({ startupCommandsMap: map }),
}))
