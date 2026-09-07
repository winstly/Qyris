/**
 * 设置 + Skill 元数据只读镜像：供 useChatStore / subagent 等需要读配置的 store 使用，
 * 打破 useAppStore ↔ useChatStore 循环依赖。useAppStore 是唯一写入方。
 */
import { create } from 'zustand'
import type { AiSettings, SkillMeta } from '@/types'
import { DEFAULT_SETTINGS } from './defaults'

interface SettingsState {
  settings: AiSettings
  skillMetas: SkillMeta[]
  skillsDirs: string[]
  setSettings: (s: AiSettings) => void
  setSkillMetas: (m: SkillMeta[]) => void
  setSkillsDirs: (d: string[]) => void
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  settings: DEFAULT_SETTINGS,
  skillMetas: [],
  skillsDirs: [],
  setSettings: (settings) => set({ settings }),
  setSkillMetas: (skillMetas) => set({ skillMetas }),
  setSkillsDirs: (skillsDirs) => set({ skillsDirs }),
}))
