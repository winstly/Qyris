/**
 * 编译流水线状态机（多槽）：每个命名服务独立一份
 * idle → building(编译中) → deploying(部署中) → running(运行中) 状态。
 * 阶段由各槽的进程输出启发式解析；退出码非 0 或编译期致命 stderr → error(异常) + 错误详情。
 *
 * 多工程常驻：状态按工程（projectRoot）隔离。build-output/build-exit 事件携带 projectRoot，
 * 后台工程（非当前）的输出也照常写入对应切片，切回时状态已是最新。
 *
 * TODO(适配): 以下正则是针对 vite / next / webpack / create-react-app 的常见输出总结的，
 * 换其他构建工具时请在 READY_HINTS / FATAL_HINTS 中补充关键词。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'
import { useAppStore } from './useAppStore'
import type { BuildPhase } from '@/types'

const MAX_LOG_LINES = 500

// 编译/构建完成 → 部署中（尚未确认监听端口）
const DEPLOY_HINTS: RegExp[] = [
  /compiled successfully/i, /webpack compiled/i, /built in/i, /transformed/i,
]

// 服务已启动/监听 → 运行中（即便无可预览 URL，如 Java / Go 后端）
const RUN_HINTS: RegExp[] = [
  /ready in/i, /listening/i, /running on/i, /serving on/i,
  /started .* in \d/i, /started .* on port/i,
  /started (server|development|worker)/i, /server (is )?running/i,
  /accepting connections/i, /listen on/i,
]

const FATAL_HINTS: RegExp[] = [
  /failed to compile/i, /error TS\d+/i, /SyntaxError/i, /\bEADDRINUSE\b/,
  /Cannot find module/i, /Module not found/i, /^error:/im,
]

const URL_RE = /https?:\/\/[^\s"'<>）】]+/i

function normalizeUrl(raw: string): string | null {
  try {
    // 剥掉 ANSI 控制字符
    const cleaned = raw
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    const parsed = new URL(cleaned.replace(/\*+/g, 'localhost'))
    const okHost =
      ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname) ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname)
    if (!okHost || !parsed.port) return null
    parsed.hostname = 'localhost'
    parsed.protocol = 'http:'
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname)
  } catch {
    return null
  }
}

/** 单个服务槽的状态 */
export interface SlotState {
  name: string
  phase: BuildPhase
  errorText: string
  logs: { stream: 'stdout' | 'stderr'; line: string }[]
  command: string
  /** 从输出解析到的全部服务地址（去重，按出现顺序）；detectedUrl 为当前选中项 */
  detectedUrls: string[]
  detectedUrl: string | null
  processAlive: boolean
  lastExitCode: number | null
}

function newSlot(name: string, command: string): SlotState {
  return {
    name, phase: 'building', errorText: '', logs: [], command,
    detectedUrls: [], detectedUrl: null, processAlive: true, lastExitCode: null,
  }
}

function normName(name: string): string {
  return name.trim().toLowerCase() || 'default'
}

/** 单个工程的构建切片 */
interface BuildSlice {
  slots: Record<string, SlotState>
  /** 插槽顺序（保持插入序，供列表渲染） */
  slotOrder: string[]
  /** 预览面板正在查看的槽 */
  activeSlot: string | null
}

function emptyBuildSlice(): BuildSlice {
  return { slots: {}, slotOrder: [], activeSlot: null }
}

function patchSliceSlot(slice: BuildSlice, key: string, patch: Partial<SlotState>): Record<string, SlotState> {
  const cur = slice.slots[key]
  if (!cur) return slice.slots
  return { ...slice.slots, [key]: { ...cur, ...patch } }
}

interface BuildState {
  /** 当前工程（useAppStore.projectPath 的镜像，供选择器用） */
  current: string | null
  /** 工程路径 → 构建切片 */
  byProject: Record<string, BuildSlice>

  selectSlot: (name: string) => void
  selectUrl: (name: string, u: string) => void
  /** 启动（或同名重启）一个服务槽；projectPath 缺省取当前工程（子 agent 必须显式传入所属工程） */
  start: (name: string, command: string, projectPath?: string) => Promise<void>
  stop: (name: string, projectPath?: string) => Promise<void>
  stopAll: (projectPath?: string) => Promise<void>
  /** 打开项目 / 切换项目时清空当前工程全部槽（主进程侧已全停） */
  reset: () => void
  /** 确保某工程的切片存在（不改变 current；打开工程时初始化） */
  ensureProject: (path: string) => void
  /** 设置当前工程（切换工程时由 useAppStore 调用） */
  setCurrent: (path: string) => void
  /** 关闭工程时移除其切片 */
  closeProject: (path: string) => void
  onOutput: (projectRoot: string, name: string, stream: 'stdout' | 'stderr', line: string) => void
  onExit: (projectRoot: string, name: string, code: number) => void
  /** 当前工程的槽表（供 tools.ts 等 getState 直读） */
  currentSlots: () => Record<string, SlotState>
}

export const useBuildStore = create<BuildState>()((set, get) => ({
  current: null,
  byProject: {},

  selectSlot: (name) => {
    const cur = get().current
    if (!cur) return
    set((s) => {
      const slice = s.byProject[cur]
      if (!slice) return s
      return { byProject: { ...s.byProject, [cur]: { ...slice, activeSlot: normName(name) } } }
    })
  },

  selectUrl: (name, u) => {
    const cur = get().current
    if (!cur) return
    set((s) => {
      const slice = s.byProject[cur]
      if (!slice) return s
      return { byProject: { ...s.byProject, [cur]: { ...slice, slots: patchSliceSlot(slice, normName(name), { detectedUrl: u }) } } }
    })
  },

  start: async (name, command, projectPath) => {
    const p = projectPath ?? useAppStore.getState().projectPath
    if (!p) return
    const cmd = command.trim()
    if (!cmd) return
    const key = normName(name)
    get().ensureProject(p)
    set((s) => {
      const slice = s.byProject[p]
      return {
        byProject: {
          ...s.byProject,
          [p]: {
            ...slice,
            slots: { ...slice.slots, [key]: newSlot(key, cmd) },
            slotOrder: slice.slotOrder.includes(key) ? slice.slotOrder : [...slice.slotOrder, key],
            activeSlot: key,
          },
        },
      }
    })
    try {
      await api.runProject(p, key, cmd)
    } catch (e) {
      set((s) => {
        const slice = s.byProject[p]
        if (!slice) return s
        return { byProject: { ...s.byProject, [p]: { ...slice, slots: patchSliceSlot(slice, key, { phase: 'error', errorText: String(e), processAlive: false }) } } }
      })
    }
  },

  stop: async (name, projectPath) => {
    const p = projectPath ?? get().current ?? useAppStore.getState().projectPath
    if (!p) return
    const key = normName(name)
    try {
      await api.stopProject(p, key)
    } catch { /* 进程可能已退出 */ }
    set((s) => {
      const slice = s.byProject[p]
      if (!slice) return s
      return { byProject: { ...s.byProject, [p]: { ...slice, slots: patchSliceSlot(slice, key, { phase: 'idle', processAlive: false }) } } }
    })
  },

  stopAll: async (projectPath) => {
    const p = projectPath ?? get().current ?? useAppStore.getState().projectPath
    if (!p) return
    try {
      await api.stopProject(p)
    } catch { /* 进程可能已退出 */ }
    set((s) => {
      const slice = s.byProject[p]
      if (!slice) return s
      const slots: Record<string, SlotState> = {}
      for (const [key, slot] of Object.entries(slice.slots)) {
        slots[key] = { ...slot, phase: 'idle', processAlive: false }
      }
      return { byProject: { ...s.byProject, [p]: { ...slice, slots } } }
    })
  },

  reset: () => {
    const cur = get().current
    if (!cur) return
    set((s) => ({ byProject: { ...s.byProject, [cur]: emptyBuildSlice() } }))
  },

  ensureProject: (path) => {
    if (get().byProject[path]) return
    set((s) => ({ byProject: { ...s.byProject, [path]: emptyBuildSlice() } }))
  },

  setCurrent: (path) => set({ current: path }),

  closeProject: (path) => {
    set((s) => {
      const byProject = { ...s.byProject }
      delete byProject[path]
      return { byProject, current: s.current === path ? null : s.current }
    })
  },

  // slot 不存在时自动创建
  onOutput: (projectRoot, name, stream, line) => {
    const lineUrl = line.match(URL_RE)
    const normUrl = lineUrl ? normalizeUrl(lineUrl[0]) : null
    if (normUrl) {
      const conflict = findUrlConflict(get().byProject, projectRoot, normUrl)
      if (conflict) {
        set((s) => {
          const slice = s.byProject[projectRoot]
          if (!slice) return s
          return { byProject: { ...s.byProject, [projectRoot]: { ...slice, slots: patchSliceSlot(slice, normName(name), { phase: 'error', errorText: `端口冲突：地址 ${normUrl} 已被项目「${conflict.project}」的服务「${conflict.slot}」占用。请修改本项目端口配置后重试。` }) } } }
        })
        return
      }
    }

    const key = normName(name)
    set((s) => {
      const slice = s.byProject[projectRoot] ?? emptyBuildSlice()
      let slots = slice.slots
      let slotOrder = slice.slotOrder
      if (!slots[key]) {
        slots = { ...slots, [key]: { ...newSlot(key, ''), processAlive: true } }
        slotOrder = slotOrder.includes(key) ? slotOrder : [...slotOrder, key]
      }
      const cur = slots[key]
      const logs = [...cur.logs, { stream, line }]
      if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES)

      let patch: Partial<SlotState> = {}
      let autoSelect: string | undefined
      const phase = cur.phase

      if ((phase === 'building' || phase === 'deploying') && stream === 'stderr' && FATAL_HINTS.some((re) => re.test(line))) {
        const tail = logs.filter((l) => l.stream === 'stderr').slice(-20).map((l) => l.line).join('\n')
        patch = { phase: 'error', errorText: tail || line }
      } else {
        const m = line.match(URL_RE)
        const norm = m ? normalizeUrl(m[0]) : null
        if (norm) {
          const urls = cur.detectedUrls.includes(norm) ? cur.detectedUrls : [...cur.detectedUrls, norm]
          patch = { detectedUrls: urls, detectedUrl: cur.detectedUrl ?? norm, phase: 'running' }
          const activeSt = slice.activeSlot ? slots[slice.activeSlot] : undefined
          if (!(activeSt && activeSt.phase === 'running' && activeSt.detectedUrl)) autoSelect = key
        } else if (phase === 'building' || phase === 'deploying') {
          if (RUN_HINTS.some((re) => re.test(line))) patch = { phase: 'running' }
          else if (phase === 'building' && DEPLOY_HINTS.some((re) => re.test(line))) patch = { phase: 'deploying' }
        }
      }

      const patchedSlots = patchSliceSlot({ ...slice, slots }, key, { logs, ...patch })
      return {
        byProject: {
          ...s.byProject,
          [projectRoot]: { ...slice, slots: patchedSlots, slotOrder, activeSlot: autoSelect ?? slice.activeSlot },
        },
      }
    })
  },

  onExit: (projectRoot, name, code) => {
    const key = normName(name)
    set((s) => {
      const slice = s.byProject[projectRoot]
      if (!slice) return s
      const cur = slice.slots[key]
      if (!cur) return s
      const patch: Partial<SlotState> = { processAlive: false, lastExitCode: code }
      if (cur.phase !== 'idle') {
        if (code !== 0) {
          const tail = cur.logs.filter((l) => l.stream === 'stderr').slice(-30).map((l) => l.line).join('\n')
          patch.phase = 'error'
          patch.errorText = tail || `进程异常退出，退出码 ${code}`
        } else {
          patch.phase = 'idle'
        }
      }
      return { byProject: { ...s.byProject, [projectRoot]: { ...slice, slots: patchSliceSlot(slice, key, patch) } } }
    })
  },

  currentSlots: () => {
    const cur = get().current
    return cur ? (get().byProject[cur]?.slots ?? {}) : {}
  },
}))

/** 便捷选择器：取某个槽（不存在返回 undefined） */
export function selectSlotState(s: BuildState, name: string | null): SlotState | undefined {
  const slice = s.current ? s.byProject[s.current] : undefined
  if (!slice || !name) return undefined
  return slice.slots[normName(name)]
}

/** 稳定空切片：选择器兜底，避免每次返回新对象引发重渲染 */
const EMPTY_BUILD: BuildSlice = { slots: {}, slotOrder: [], activeSlot: null }

/** 取当前工程的构建切片 */
export function selectCurrentBuild(s: BuildState): BuildSlice {
  return (s.current && s.byProject[s.current]) || EMPTY_BUILD
}

/** 跨项目 URL 冲突检测 */
function findUrlConflict(
  byProject: Record<string, BuildSlice>, selfProject: string, url: string,
): { project: string; slot: string } | null {
  for (const [project, slice] of Object.entries(byProject)) {
    if (project === selfProject) continue
    for (const [key, slot] of Object.entries(slice.slots)) {
      if (slot.processAlive && (slot.detectedUrl === url || slot.detectedUrls.includes(url))) {
        return { project: project.split(/[\\/]/).pop() ?? project, slot: key }
      }
    }
  }
  return null
}
