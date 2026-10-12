/**
 * 编译流水线状态机（多槽）：每个命名服务独立一份
 * idle → building(编译中) → deploying(部署中) → running(运行中) 状态。
 * 阶段由各槽的进程输出启发式解析；退出码非 0 或编译期致命 stderr → error(异常) + 错误详情。
 *
 * 多工程常驻：状态按工程（projectRoot）隔离。build-output/build-exit 事件携带 projectRoot，
 * 后台工程（非当前）的输出也照常写入对应切片，切回时状态已是最新。
 *
 * 行级启发式（提示词表/URL/端口短语）在 utils/buildHints（纯函数 + smoke 覆盖）；
 * 本 store 只持相位策略与探测。未识别的构建工具不误判：行信号为空时由 HTTP 探测 + 退出码兜底。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'
import { useProjectStore } from './useProjectStore'
import { useChatStore } from './useChatStore'
import type { BuildPhase } from '@/types'
import {
  extractCommandPort, extractLineUrl, extractLineUrlFromPort, isDeployLine, isFatalLine, isRunLine, localUrl, normalizeUrl,
} from '@/utils/buildHints'

const MAX_LOG_LINES = 500

// ==================== 主动 HTTP 探测（根治 stdout 块缓冲卡 building） ====================
// slot 已知地址（AI seed 或命令解析端口）时，spawn 后轮询该地址，探通即 running。
// 与 stdout 启发式并存：stdout 能及时 flush 时是更快的快路径，探测兜底缓冲语言。

type ProbeKey = string // `${projectRoot}::${normName(name)}`
const probeCancellers = new Map<ProbeKey, () => void>()

function slotProbeKey(p: string, name: string): string {
  return `${p}::${normName(name)}`
}

function cancelProbe(p: string, name: string): void {
  const key = slotProbeKey(p, name)
  const cancel = probeCancellers.get(key)
  if (cancel) {
    cancel()
    probeCancellers.delete(key)
  }
}

/** 取消某工程下所有槽的探测（stopAll/reset/closeProject 共用） */
function cancelAllProbes(projectRoot: string, slots: Record<string, unknown>): void {
  for (const k of Object.keys(slots)) cancelProbe(projectRoot, k)
}

const PROBE_POLL_MS = 500
const PROBE_INTERVAL_MS = 2000
const PROBE_TIMEOUT_MS = 90_000

/** 从 AI seed URL 或启动命令解析出探测目标地址；两者皆无返回 null（退回纯 stdout 启发式） */
function deriveProbeTarget(urlHint: string | undefined, command: string): string | null {
  const seed = urlHint ? normalizeUrl(urlHint) : null
  if (seed) return seed
  const port = extractCommandPort(command)
  return port ? localUrl(port) : null
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

function newSlot(name: string, command: string, urlHint?: string): SlotState {
  // urlHint = AI 编译时上报的预览地址（StartCommand.url）：作为初始检测地址，
  // 后续输出若解析出真实地址则由 selectUrl/检测逻辑正常补入，两者共存不冲突
  const seed = urlHint ? normalizeUrl(urlHint) : null
  return {
    name, phase: 'building', errorText: '', logs: [], command,
    detectedUrls: seed ? [seed] : [], detectedUrl: seed, processAlive: true, lastExitCode: null,
  }
}

function normName(name: string): string {
  return name.trim().toLowerCase() || 'default'
}

/** 教训采集（P2）：服务启动失败（致命 stderr / 端口冲突）→ noteLesson（fire-and-forget；
 *  会话切片不在或刚 clear 则跳过，同会话同服务重复失败由主进程去重） */
function noteStartupFailure(projectRoot: string, name: string, errorText: string): void {
  const sessionId = useChatStore.getState().byProject[projectRoot]?.sessionId
  if (!sessionId) return
  void api.noteLesson(projectRoot, sessionId, {
    title: `${name} 启动失败`,
    content: errorText.slice(-500),
  }).catch(() => {})
}

/** EADDRINUSE 增强：查端口占用者 → 更新 errorText，让 AI 拿到完整冲突信息和解决建议 */
async function enrichPortConflict(projectRoot: string, slotKey: string, rawError: string): Promise<void> {
  // 从 EADDRINUSE 信息中提取端口号
  const portMatch = rawError.match(/:(\d{2,5})\b/) ?? rawError.match(/port\s+(\d{2,5})\b/i)
  const port = portMatch ? Number(portMatch[1]) : 0
  if (!port) return

  const owner = await api.portOwner(port).catch(() => null)
  let hint: string
  if (owner) {
    hint = `\n端口 ${port} 被占用，占用进程：${owner.name}（PID ${owner.pid}）。` +
      `\n解决方式：` +
      `\n① 若是本项目已运行的服务，用 stop_project 停止后重试；` +
      `\n② 若是其他进程，在启动命令中换端口（如 set PORT=${port + 1} && <原命令> 或 PORT=${port + 1} <原命令>）。`
  } else {
    hint = `\n端口 ${port} 被占用（未能查询到占用进程信息）。` +
      `\n解决方式：` +
      `\n① 若是本项目已运行的服务，用 stop_project 停止后重试；` +
      `\n② 若是其他进程，在启动命令中换端口（如 set PORT=${port + 1} && <原命令> 或 PORT=${port + 1} <原命令>）。`
  }

  // 更新 slot 的 errorText（追加端口占用信息）
  useBuildStore.setState((s) => {
    const slice = s.byProject[projectRoot]
    if (!slice) return s
    const slot = slice.slots[slotKey]
    if (!slot || slot.phase !== 'error') return s
    return {
      byProject: {
        ...s.byProject,
        [projectRoot]: {
          ...slice,
          slots: patchSliceSlot(slice, slotKey, { errorText: slot.errorText + hint }),
        },
      },
    }
  })
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
  /** urlHint：AI 编译上报的预览地址（StartCommand.url），作为初始检测地址 */
  start: (name: string, command: string, projectPath?: string, urlHint?: string) => Promise<void>
  stop: (name: string, projectPath?: string) => Promise<void>
  /** 移除服务槽（仅限进程已停止）：从 slots+slotOrder 删除，activeSlot 指向它则回退首槽 */
  removeSlot: (name: string, projectPath?: string) => void
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

export const useBuildStore = create<BuildState>()((set, get) => {
  /** 启动 HTTP 探测循环：每 500ms tick，每 2s 真正发起 HTTP GET，探通即转 running。
   *  定义在 create 闭包内以访问 get/set；模块级 cancelProbe/startProbeKey 管理生命周期。 */
  const startProbe = (projectRoot: string, key: string, target: string): void => {
    let cancelled = false
    const pk = slotProbeKey(projectRoot, key)
    probeCancellers.set(pk, () => { cancelled = true })

    const deadline = Date.now() + PROBE_TIMEOUT_MS
    let lastProbeAt = 0

    const tick = async (): Promise<void> => {
      if (cancelled) return
      const slice = get().byProject[projectRoot]
      const cur = slice?.slots[key]
      // 终止条件：slot 消失 / 进程已死 / 已到终态 / 超时
      if (!cur || !cur.processAlive || cur.phase === 'running' || cur.phase === 'error' || cur.phase === 'idle' || Date.now() >= deadline) {
        probeCancellers.delete(pk)
        return
      }
      // 节流：距上次探测 < 2s 则跳过，直接安排下一轮
      if (Date.now() - lastProbeAt < PROBE_INTERVAL_MS) {
        if (!cancelled) setTimeout(tick, PROBE_POLL_MS)
        return
      }
      lastProbeAt = Date.now()
      try {
        const ok = await api.checkUrl(target)
        if (cancelled) return
        // await 期间进程可能已停
        const st = get().byProject[projectRoot]?.slots[key]
        if (!st || !st.processAlive) { probeCancellers.delete(pk); return }

        if (ok) {
          // set() updater 内部做权威复核（liveness + phase），消除 getState 快照缝隙
          const conflictRef: { current: { project: string; slot: string } | null } = { current: null }
          set((s) => {
            const sl = s.byProject[projectRoot]
            if (!sl) return s
            const c = sl.slots[key]
            if (!c || !c.processAlive || c.phase === 'running' || c.phase === 'error' || c.phase === 'idle') return s
            // URL 冲突检测（与 onOutput 同款逻辑）
            const conflict = findUrlConflict(s.byProject, projectRoot, target)
            if (conflict) {
              conflictRef.current = conflict
              const conflictText = `端口冲突：地址 ${target} 已被项目「${conflict.project}」的服务「${conflict.slot}」占用。请修改本项目端口配置后重试。`
              return { byProject: { ...s.byProject, [projectRoot]: { ...sl, slots: patchSliceSlot(sl, key, { phase: 'error', errorText: conflictText }) } } }
            }
            // 无冲突 → running；补 detectedUrl（若当前无）
            const urlPatch: Partial<SlotState> = { phase: 'running' }
            if (!c.detectedUrl) {
              urlPatch.detectedUrls = c.detectedUrls.includes(target) ? c.detectedUrls : [...c.detectedUrls, target]
              urlPatch.detectedUrl = target
            }
            // auto-select：当前 activeSlot 非 running-with-url 则选中本槽
            const activeSt = sl.activeSlot ? sl.slots[sl.activeSlot] : undefined
            const autoSelect = !(activeSt && activeSt.phase === 'running' && activeSt.detectedUrl) ? key : undefined
            return {
              byProject: {
                ...s.byProject,
                [projectRoot]: { ...sl, slots: patchSliceSlot(sl, key, urlPatch), activeSlot: autoSelect ?? sl.activeSlot },
              },
            }
          })
          // updater 外调 noteStartupFailure（仿 onOutput:309）
          if (conflictRef.current) {
            noteStartupFailure(projectRoot, key, `端口冲突：地址 ${target} 已被项目「${conflictRef.current.project}」的服务「${conflictRef.current.slot}」占用。`)
          }
          probeCancellers.delete(pk)
          return
        }
      } catch {
        /* 网络错误 / checkUrl 异常 → 继续轮询 */
      }
      if (!cancelled) setTimeout(tick, PROBE_POLL_MS)
    }
    setTimeout(tick, PROBE_POLL_MS)
  }

  return {
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

  start: async (name, command, projectPath, urlHint) => {
    const p = projectPath ?? useProjectStore.getState().projectPath
    if (!p) return
    const cmd = command.trim()
    if (!cmd) return
    const key = normName(name)
    // 必须在 set(newSlot) 之前取消旧探测——否则旧探测的 await checkUrl 可能在 set 之后
    // resolve，看到新 slot（phase=building、processAlive=true）误判 running。
    cancelProbe(p, key)
    get().ensureProject(p)
    set((s) => {
      const slice = s.byProject[p]
      return {
        byProject: {
          ...s.byProject,
          [p]: {
            ...slice,
            slots: { ...slice.slots, [key]: newSlot(key, cmd, urlHint) },
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
      return
    }
    // spawn 成功 → 启动主动 HTTP 探测（地址已知时）
    const target = deriveProbeTarget(urlHint, cmd)
    if (target) startProbe(p, key, target)
  },

  stop: async (name, projectPath) => {
    const p = projectPath ?? get().current ?? useProjectStore.getState().projectPath
    if (!p) return
    const key = normName(name)
    cancelProbe(p, key)
    try {
      await api.stopProject(p, key)
    } catch { /* 进程可能已退出 */ }
    set((s) => {
      const slice = s.byProject[p]
      if (!slice) return s
      return { byProject: { ...s.byProject, [p]: { ...slice, slots: patchSliceSlot(slice, key, { phase: 'idle', processAlive: false }) } } }
    })
  },

  removeSlot: (name, projectPath) => {
    const p = projectPath ?? get().current ?? useProjectStore.getState().projectPath
    if (!p) return
    const key = normName(name)
    cancelProbe(p, key)
    set((s) => {
      const slice = s.byProject[p]
      if (!slice) return s
      const cur = slice.slots[key]
      // 进程存活时不允许删（UI 也只在未运行时露出删除按钮）
      if (!cur || cur.processAlive) return s
      const slots = { ...slice.slots }
      delete slots[key]
      const slotOrder = slice.slotOrder.filter((k) => k !== key)
      const activeSlot = slice.activeSlot === key ? (slotOrder[0] ?? null) : slice.activeSlot
      return { byProject: { ...s.byProject, [p]: { ...slice, slots, slotOrder, activeSlot } } }
    })
  },

  stopAll: async (projectPath) => {
    const p = projectPath ?? get().current ?? useProjectStore.getState().projectPath
    if (!p) return
    // 取消该项目所有槽的探测
    const slice = get().byProject[p]
    if (slice) cancelAllProbes(p, slice.slots)
    try {
      await api.stopProject(p)
    } catch { /* 进程可能已退出 */ }
    set((s) => {
      const sl = s.byProject[p]
      if (!sl) return s
      const slots: Record<string, SlotState> = {}
      for (const [key, slot] of Object.entries(sl.slots)) {
        slots[key] = { ...slot, phase: 'idle', processAlive: false }
      }
      return { byProject: { ...s.byProject, [p]: { ...sl, slots } } }
    })
  },

  reset: () => {
    const cur = get().current
    if (!cur) return
    // 先取消该工程所有槽的探测，再置空 slice
    const slice = get().byProject[cur]
    if (slice) cancelAllProbes(cur, slice.slots)
    set((s) => ({ byProject: { ...s.byProject, [cur]: emptyBuildSlice() } }))
  },

  ensureProject: (path) => {
    if (get().byProject[path]) return
    set((s) => ({ byProject: { ...s.byProject, [path]: emptyBuildSlice() } }))
  },

  setCurrent: (path) => set({ current: path }),

  closeProject: (path) => {
    // 先取消该工程所有槽的探测（兜底 IPC 延迟漏网的）
    const slice = get().byProject[path]
    if (slice) cancelAllProbes(path, slice.slots)
    set((s) => {
      const byProject = { ...s.byProject }
      delete byProject[path]
      return { byProject, current: s.current === path ? null : s.current }
    })
  },

  // slot 不存在时自动创建
  onOutput: (projectRoot, name, stream, line) => {
    const normUrl = extractLineUrl(line)
    if (normUrl) {
      const conflict = findUrlConflict(get().byProject, projectRoot, normUrl)
      if (conflict) {
        const conflictText = `端口冲突：地址 ${normUrl} 已被项目「${conflict.project}」的服务「${conflict.slot}」占用。请修改本项目端口配置后重试。`
        set((s) => {
          const slice = s.byProject[projectRoot]
          if (!slice) return s
          return { byProject: { ...s.byProject, [projectRoot]: { ...slice, slots: patchSliceSlot(slice, normName(name), { phase: 'error', errorText: conflictText }) } } }
        })
        noteStartupFailure(projectRoot, name, conflictText)
        return
      }
    }

    const key = normName(name)
    let fatalTransition: string | null = null
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

      // EADDRINUSE 在 running 阶段也应转 error（探测可能已判 running，但 stderr 的端口占用才到——
      // 探测探到的可能是占用同端口的旁路进程）。其余 FATAL 仍维持 building/deploying 守卫。
      if (stream === 'stderr' && (
        ((phase === 'building' || phase === 'deploying') && isFatalLine(line)) ||
        (phase === 'running' && /\bEADDRINUSE\b/.test(line))
      )) {
        const tail = logs.filter((l) => l.stream === 'stderr').slice(-20).map((l) => l.line).join('\n')
        patch = { phase: 'error', errorText: tail || line }
        // 相位跃迁（building/deploying → error）才采集，避免 error 后每一行输出重复触发
        fatalTransition = patch.errorText ?? null
      } else {
        const norm = extractLineUrl(line)
        // 兜底①：无 URL 行的高置信端口短语（python http.server 旧格式 / 中文输出 / host:port 无协议）；
        // 报错/占用行不出地址（isNoiseLine 护栏在 buildHints）
        const synth = !norm && (phase === 'building' || phase === 'deploying' || phase === 'running')
          ? extractLineUrlFromPort(line)
          : null
        const found = norm ?? synth
        if (found) {
          const urls = cur.detectedUrls.includes(found) ? cur.detectedUrls : [...cur.detectedUrls, found]
          patch = { detectedUrls: urls, detectedUrl: cur.detectedUrl ?? found, phase: 'running' }
          const activeSt = slice.activeSlot ? slots[slice.activeSlot] : undefined
          if (!(activeSt && activeSt.phase === 'running' && activeSt.detectedUrl)) autoSelect = key
        } else if (phase === 'building' || phase === 'deploying') {
          if (isRunLine(line)) {
            patch = { phase: 'running' }
            // 兜底②：进程已判定运行但自始至终没有地址 → 用启动命令里的端口合成预览地址
            if (!cur.detectedUrl) {
              const port = extractCommandPort(cur.command)
              if (port) {
                const synthUrl = localUrl(port)
                patch.detectedUrls = [synthUrl]
                patch.detectedUrl = synthUrl
              }
            }
          }
          else if (phase === 'building' && isDeployLine(line)) patch = { phase: 'deploying' }
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
    // 教训采集（P2）：编译期致命错误进 error 相位 → noteLesson（fire-and-forget，重复失败由主进程去重）
    if (fatalTransition !== null) noteStartupFailure(projectRoot, name, fatalTransition)

    // 端口冲突增强：EADDRINUSE → 查端口占用者 → 注入解决建议
    if (fatalTransition && /\bEADDRINUSE\b/.test(fatalTransition)) {
      enrichPortConflict(projectRoot, key, fatalTransition).catch(() => {})
    }
  },

  onExit: (projectRoot, name, code) => {
    const key = normName(name)
    // 进程已死，探测无意义
    cancelProbe(projectRoot, name)
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
}})

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
