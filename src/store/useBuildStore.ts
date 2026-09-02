/**
 * 编译流水线状态机（多槽）：每个命名服务独立一份
 * idle → building(编译中) → deploying(部署中) → running(运行中) 状态。
 * 阶段由各槽的进程输出启发式解析；退出码非 0 或编译期致命 stderr → error(异常) + 错误详情。
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

interface BuildState {
  slots: Record<string, SlotState>
  /** 插槽顺序（保持插入序，供列表渲染） */
  slotOrder: string[]
  /** 预览面板正在查看的槽 */
  activeSlot: string | null

  selectSlot: (name: string) => void
  selectUrl: (name: string, u: string) => void
  /** 启动（或同名重启）一个服务槽；命令回填到槽状态 */
  start: (name: string, command: string) => Promise<void>
  stop: (name: string) => Promise<void>
  stopAll: () => Promise<void>
  /** 打开项目 / 切换项目时清空全部槽（主进程侧已全停） */
  reset: () => void
  onOutput: (name: string, stream: 'stdout' | 'stderr', line: string) => void
  onExit: (name: string, code: number) => void
}

function patchSlot(s: BuildState, key: string, patch: Partial<SlotState>): Record<string, SlotState> {
  const cur = s.slots[key]
  if (!cur) return s.slots
  return { ...s.slots, [key]: { ...cur, ...patch } }
}

export const useBuildStore = create<BuildState>()((set, get) => ({
  slots: {},
  slotOrder: [],
  activeSlot: null,

  selectSlot: (name) => set({ activeSlot: normName(name) }),

  selectUrl: (name, u) =>
    set((s) => {
      const key = normName(name)
      return { slots: patchSlot(s, key, { detectedUrl: u }) }
    }),

  start: async (name, command) => {
    const { projectPath } = useAppStore.getState()
    if (!projectPath) return
    const cmd = command.trim()
    if (!cmd) return
    const key = normName(name)
    set((s) => ({
      slots: { ...s.slots, [key]: newSlot(key, cmd) },
      slotOrder: s.slotOrder.includes(key) ? s.slotOrder : [...s.slotOrder, key],
      activeSlot: key,
    }))
    try {
      await api.runProject(projectPath, key, cmd)
    } catch (e) {
      set((s) => ({
        slots: patchSlot(s, key, { phase: 'error', errorText: String(e), processAlive: false }),
      }))
    }
  },

  stop: async (name) => {
    const key = normName(name)
    try {
      await api.stopProject(key)
    } catch { /* 进程可能已退出 */ }
    set((s) => ({ slots: patchSlot(s, key, { phase: 'idle', processAlive: false }) }))
  },

  stopAll: async () => {
    try {
      await api.stopProject()
    } catch { /* 进程可能已退出 */ }
    set((s) => {
      const slots: Record<string, SlotState> = {}
      for (const [key, slot] of Object.entries(s.slots)) {
        slots[key] = { ...slot, phase: 'idle', processAlive: false }
      }
      return { slots }
    })
  },

  reset: () => set({ slots: {}, slotOrder: [], activeSlot: null }),

  // 事件兜底：slot 尚不存在（事件先于 start resolve 到达的极端时序）时创建再追加
  onOutput: (name, stream, line) => {
    const key = normName(name)
    const state = get()
    if (!state.slots[key]) {
      set((s) => ({
        slots: { ...s.slots, [key]: { ...newSlot(key, ''), processAlive: true } },
        slotOrder: s.slotOrder.includes(key) ? s.slotOrder : [...s.slotOrder, key],
      }))
    }
    const cur = get().slots[key]
    const logs = [...cur.logs, { stream, line }]
    if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES)

    let patch: Partial<SlotState> = { logs }
    const phase = cur.phase
    // 首次解析出可预览地址时，是否自动选中本槽（默认把跑起来的前端页面直接展示出来）
    let autoSelect: string | null = null

    // 致命 stderr（编译期）→ 异常态
    if ((phase === 'building' || phase === 'deploying') && stream === 'stderr' && FATAL_HINTS.some((re) => re.test(line))) {
      const tail = logs.filter((l) => l.stream === 'stderr').slice(-20).map((l) => l.line).join('\n')
      patch = { ...patch, phase: 'error', errorText: tail || line }
    } else {
      // URL 提取不受阶段限制：running 中后续输出地址也能补上（如 vite 先 ready 再印 Local）
      const m = line.match(URL_RE)
      const norm = m ? normalizeUrl(m[0]) : null
      if (norm) {
        const urls = cur.detectedUrls.includes(norm) ? cur.detectedUrls : [...cur.detectedUrls, norm]
        patch = {
          ...patch,
          detectedUrls: urls,
          detectedUrl: cur.detectedUrl ?? norm,
          phase: 'running',
        }
        // 当前选中槽不可预览（空 / 无地址 / 未 running）时，自动切到这个刚跑起来、有地址的服务
        const activeKey = get().activeSlot
        const activeSt = activeKey ? get().slots[activeKey] : undefined
        if (!(activeSt && activeSt.phase === 'running' && activeSt.detectedUrl)) {
          autoSelect = key
        }
      } else if (phase === 'building' || phase === 'deploying') {
        // 启动成功信号（可能无 URL，如 Java 后端）→ 运行中
        if (RUN_HINTS.some((re) => re.test(line))) {
          patch = { ...patch, phase: 'running' }
        } else if (phase === 'building' && DEPLOY_HINTS.some((re) => re.test(line))) {
          patch = { ...patch, phase: 'deploying' }
        }
      }
    }
    set((s) => {
      const slots = patchSlot(s, key, patch)
      return autoSelect ? { slots, activeSlot: autoSelect } : { slots }
    })
  },

  onExit: (name, code) => {
    const key = normName(name)
    set((s) => {
      const cur = s.slots[key]
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
      return { slots: patchSlot(s, key, patch) }
    })
  },
}))

/** 便捷选择器：取某个槽（不存在返回 undefined） */
export function selectSlotState(s: BuildState, name: string | null): SlotState | undefined {
  return name ? s.slots[normName(name)] : undefined
}
