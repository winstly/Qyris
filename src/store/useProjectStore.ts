/**
 * 工程路径单一事实源：所有 store 读 projectPath 从这里取，打破 useAppStore ↔ useChatStore/BuildStore 循环依赖。
 * useAppStore 是唯一写入方（openProject / closeProject / setCurrent），其他 store 只读。
 */
import { create } from 'zustand'

interface ProjectState {
  /** 当前活跃工程的绝对路径 */
  projectPath: string | null
  setProjectPath: (path: string | null) => void
}

export const useProjectStore = create<ProjectState>()((set) => ({
  projectPath: null,
  setProjectPath: (path) => set({ projectPath: path }),
}))
