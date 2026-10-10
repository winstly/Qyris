/**
 * 产品工具（运行域）：run_project / stop_project / get_build_status / verify_start
 *                    + report_start_commands / update_start_command（启动命令存档）。
 *
 * 复用主进程既有实现，本层只做参数校验、结果格式化与状态镜像：
 *   · 进程启停 = proc.runProject / proc.stopProject（同名槽先杀后启、树杀、OEM 解码都在那边）；
 *   · 启动命令存档 = config.mergeConfig({ startupCommands })（与渲染层 useStartupStore.persistMap 同一落盘点）；
 *   · HTTP 探测 = proc.checkUrlHealthy。
 *
 * 状态镜像（get_build_status 的数据源）——为什么在本层另起一份：
 *   权威的三阶段状态机在渲染层 useBuildStore（由 build-output/build-exit 事件驱动，
 *   含 URL 冲突检测、phase 提示词），主进程读不到那份 store。工具要给模型看状态，
 *   只能在 proc.runProject 的输出回调上挂一个轻量镜像（logs 尾部 / URL 探测 / 退出码 / 存活）。
 *   两份状态看的是同一个进程（proc.runProject 仍把 build-output 发给窗口，预览面板不受影响），
 *   本镜像只服务工具汇报，不参与 UI。
 */
import { getConfig, mergeConfig, type StartCommand } from '../config'
import { checkUrlHealthy, runProject, stopProject } from '../proc'
import { errorMessage } from '../util'
import type { Tool, ToolCtx } from '../model/types'

// ---------- 入参校验（与 tools/fs.ts 同款小助手） ----------

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('工具入参必须是 JSON 对象')
  }
  return input as Record<string, unknown>
}

function text(rec: Record<string, unknown>, key: string): string {
  const v = rec[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v
}

function optText(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  return text(rec, key)
}

function root(ctx: ToolCtx): string {
  if (!ctx.projectRoot) throw new Error('当前未打开工程，服务类工具不可用')
  return ctx.projectRoot
}

function normName(name: string): string {
  return name.trim().toLowerCase() || 'default'
}

/** 服务名归一：大小写不敏感 + trim（与渲染层槽位键一致） */
function slotKey(projectRoot: string, name: string): string {
  return `${projectRoot.replace(/[\\/]+$/, '')}\x00${normName(name)}`
}

// ---------- 槽位状态镜像（工具侧轻量版） ----------

const LOG_TAIL_CAP = 40
const RESULT_LOG_TAIL = 20
const RESULT_URL_CAP = 5

interface SlotMirror {
  name: string
  command: string
  startedAt: number
  logs: string[]
  urls: string[]
  lastExitCode: number | null
  alive: boolean
}

const mirror = new Map<string, SlotMirror>()

/** 输出里的服务地址：本地优先（与 useBuildStore 的 URL_RE 同族，工具侧够用即可） */
const URL_RE = /https?:\/\/[^\s"'<>）】]+/i

function noteLine(slot: SlotMirror, line: string): void {
  slot.logs.push(line)
  if (slot.logs.length > LOG_TAIL_CAP) slot.logs.splice(0, slot.logs.length - LOG_TAIL_CAP)
  const m = line.match(URL_RE)
  if (m && !slot.urls.includes(m[0])) slot.urls.push(m[0])
}

function getSlot(projectRoot: string, name: string): SlotMirror | undefined {
  return mirror.get(slotKey(projectRoot, name))
}

function listSlots(projectRoot: string): SlotMirror[] {
  const prefix = `${projectRoot.replace(/[\\/]+$/, '')}\x00`
  return [...mirror.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)
}

// ---------- 启动命令存档（config.startupCommands，与渲染层持久化同源） ----------

/** 单条 upsert（名称比较与渲染层 updateStartCommand 对齐：大小写不敏感 + trim） */
function upsertStartCommand(name: string, command: string, url: string | undefined, projectRoot: string): Promise<void> {
  return getConfig().then((cfg) => {
    const map = { ...(cfg.startupCommands ?? {}) }
    const cur = map[projectRoot] ?? []
    const key = normName(name)
    const next = cur.some((c) => normName(c.name) === key)
      ? cur.map((c) => (normName(c.name) === key ? { ...c, run: command, ...(url ? { url } : c.url ? { url: c.url } : {}) } : c))
      : [...cur, { name: name.trim(), run: command, ...(url ? { url } : {}) }]
    map[projectRoot] = next
    return mergeConfig({ startupCommands: map })
  })
}

/** 整表覆盖（report_start_commands 的收尾语义：清单即最终识别结果） */
function replaceStartCommands(services: StartCommand[], projectRoot: string): Promise<void> {
  return getConfig().then((cfg) => {
    const map = { ...(cfg.startupCommands ?? {}), [projectRoot]: services }
    return mergeConfig({ startupCommands: map })
  })
}

// ---------- 工具实现 ----------

const runProjectTool: Tool = {
  name: 'run_project',
  description:
    '在项目根目录以指定服务名启动（或重启）一个长期运行的开发/构建命令。' +
    '每个服务名独立成槽，同名重启只替换该服务，不影响其他已运行的服务。' +
    '多服务项目应逐个启动、各取不同 name。启动后用 get_build_status 跟踪状态；长驻服务以外的一次性命令用 run_command。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '服务名（简短英文，如 web / api / admin），用于区分多个同时运行的服务' },
      command: { type: 'string', description: '启动命令，如 "npm run dev"、"cargo run"、"mvn spring-boot:run"' },
    },
    required: ['name', 'command'],
  },
  permission: 'exec',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const name = text(rec, 'name')
    const command = text(rec, 'command')
    const key = slotKey(projectRoot, name)

    const slot: SlotMirror = {
      name: normName(name), command, startedAt: Date.now(),
      logs: [], urls: [], lastExitCode: null, alive: true,
    }
    mirror.set(key, slot)

    try {
      const pid = await runProject(projectRoot, name, command, null, {
        onLine: (stream, line) => {
          // 当前槽（同名重启会换代：只记本代的输出）
          if (mirror.get(key) === slot) noteLine(slot, stream === 'stderr' ? `[err] ${line}` : line)
        },
        onExit: (code) => {
          if (mirror.get(key) !== slot) return
          slot.alive = false
          slot.lastExitCode = code
        },
      })
      // 启动命令沉淀进存档（与渲染层 persistStartCommand 同语义）：AI 启动的服务也能被「全部运行」记住
      await upsertStartCommand(name, command, undefined, projectRoot).catch(() => {})
      return {
        content:
          `[run_project] 已启动服务「${name}」：${command}（pid ${pid}）。\n` +
          `输出实时流入预览面板；稍等片刻后用 get_build_status 查看「${name}」的状态（首次编译可能需要几秒到几十秒）。` +
          `启动命令已沉淀进启动清单。`,
      }
    } catch (e) {
      mirror.delete(key)
      return { content: `[run_project] 启动失败：${errorMessage(e)}`, isError: true }
    }
  },
}

const stopProjectTool: Tool = {
  name: 'stop_project',
  description: '停止服务进程。传 name 停单个服务；不传则停止全部服务（各自结束整棵进程树）。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '可选：服务名；不传则停止全部' },
    },
  },
  permission: 'exec',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const name = optText(rec, 'name')
    await stopProject(projectRoot, name ?? null)
    if (name) {
      const slot = getSlot(projectRoot, name)
      // 树杀不回流退出码（proc.on('exit') 在槽被摘后不回调）：alive 置假即可，展示面区分「已停止」
      if (slot) slot.alive = false
      return { content: `[stop_project] 已停止服务「${name}」。` }
    }
    for (const slot of listSlots(projectRoot)) slot.alive = false
    return { content: '[stop_project] 已停止该工程全部服务进程。' }
  },
}

const getBuildStatusTool: Tool = {
  name: 'get_build_status',
  description:
    '查看服务进程的状态。不传 name 时返回全部服务的总览（每服务一行：存活/命令/地址）；' +
    '传 name 时返回单个服务的详情、退出码与最近输出。如果服务处于异常且问题出在启动命令本身' +
    '（路径不对、端口冲突等），需用 update_start_command 更新命令后再重启。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '可选：服务名。不传则汇总所有服务' },
    },
  },
  permission: 'readonly',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const name = optText(rec, 'name')

    if (name) {
      const slot = getSlot(projectRoot, name)
      if (!slot) {
        const known = listSlots(projectRoot).map((s) => s.name).join('、') || '（无）'
        return { content: `[get_build_status] 服务「${name}」不存在。当前服务：${known}`, isError: true }
      }
      return { content: formatSlotDetail(slot) }
    }

    const slots = listSlots(projectRoot)
    if (slots.length === 0) return { content: '[get_build_status] 当前没有任何服务启动记录（用 run_project 启动后再查）。' }
    const lines = slots.map((s) => {
      const url = s.urls[0] ?? '（未解析）'
      const exit = s.lastExitCode !== null ? ` · exit ${s.lastExitCode}` : ''
      const state = s.alive ? '运行中' : s.lastExitCode !== null ? '已退出' : '已停止'
      return `- ${s.name}：${state} · 命令 ${s.command || '（未知）'} · 地址 ${url}${exit}`
    })
    return {
      content:
        `共 ${slots.length} 个服务：\n${lines.join('\n')}\n（用 get_build_status 传 name 查看单个服务的详情与日志尾部）`,
    }
  },
}

const verifyStartTool: Tool = {
  name: 'verify_start',
  description:
    '启动验证：以给定命令启动服务，等待其真正可服务（解析到地址并 HTTP 探测通过；无地址时按存活+输出信号判定），' +
    '验证完成自动停止进程。用于编译成功后确认「能启动」，失败会返回日志尾部供修复。' +
    '验证进程不会保留——验证通过后再用 report_start_commands 提交命令清单。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '服务名（简短英文，如 web / api），与后续 report_start_commands / run_project 保持一致' },
      command: { type: 'string', description: '启动命令，如 "npm run dev"、"mvn spring-boot:run"' },
    },
    required: ['name', 'command'],
  },
  permission: 'exec',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const name = text(rec, 'name')
    const command = text(rec, 'command')
    const key = slotKey(projectRoot, name)

    const slot: SlotMirror = {
      name: normName(name), command, startedAt: Date.now(),
      logs: [], urls: [], lastExitCode: null, alive: true,
    }
    mirror.set(key, slot)

    const stop = async (): Promise<void> => {
      await stopProject(projectRoot, name).catch(() => {})
      if (mirror.get(key) === slot) slot.alive = false
    }

    try {
      await runProject(projectRoot, name, command, null, {
        onLine: (_s, line) => {
          if (mirror.get(key) === slot) noteLine(slot, line)
        },
        onExit: (code) => {
          if (mirror.get(key) !== slot) return
          slot.alive = false
          slot.lastExitCode = code
        },
      })
    } catch (e) {
      mirror.delete(key)
      return { content: `[verify_start] 启动失败：${errorMessage(e)}`, isError: true }
    }

    // 轮询：异常退出即失败；解析到地址后 HTTP 探测确认（2s 限频）；无地址时按「启动信号 + 存活」判定
    const deadline = Date.now() + VERIFY_TIMEOUT_MS
    let lastProbeAt = 0
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) {
        await stop()
        return { content: '[verify_start] 启动验证已取消（用户停止生成），验证进程已停止。' }
      }
      await sleep(VERIFY_POLL_MS)
      if (mirror.get(key) !== slot) {
        // 同名槽被新运行实例替换（run_project 抢名会杀旧启新）：验证对象已不是本进程。
        // 不 stop()——stop 按名杀槽，会误杀接替的新进程；也不算验证通过
        return {
          content: '[verify_start] 启动验证中止：同名服务槽已被新的运行实例替换，验证进程已不在，请重新验证。',
          isError: true,
        }
      }
      if (!slot.alive) {
        // 跑完即退（含 exit 0）都不是长驻服务：命令形态不对，如实报
        await stop()
        return {
          content:
            `[verify_start] 启动验证失败：进程在验证期内退出（exit ${slot.lastExitCode}）。` +
            `长驻服务应保持运行——确认这是启动命令而非一次性命令。\n输出尾部：\n${tailText(slot)}`,
          isError: true,
        }
      }
      const url = slot.urls[0]
      if (url) {
        if (Date.now() - lastProbeAt >= VERIFY_PROBE_INTERVAL_MS) {
          lastProbeAt = Date.now()
          const ok = await checkUrlHealthy(url).catch(() => false)
          if (ok) {
            await stop()
            await upsertStartCommand(name, command, url, projectRoot).catch(() => {})
            return {
              content:
                `[verify_start] 启动验证通过：服务已监听 ${url}，HTTP 探测成功。` +
                `验证进程已自动停止，启动命令已沉淀进启动清单（可直接 report_start_commands / run_project 复用）`,
            }
          }
        }
      } else if (slot.logs.some((l) => READY_HINTS.some((re) => re.test(l)))) {
        // 无可探测地址但输出出现启动信号（Java 后端等）：按信号判通过，如实标注探测限制
        await stop()
        return {
          content:
            '[verify_start] 启动验证通过（按输出中的启动信号判定）：服务已进入运行但未解析到 HTTP 地址，未能做探测确认。' +
            '验证进程已自动停止。',
        }
      }
    }
    await stop()
    // 到点仍未收口：进程一直活着但地址没探到（活着到达终点 = 循环里没走「退出即失败」分支）。
    // 按存活判过，但把「未探测」如实标注（对齐渲染层 verifyStartup 的无地址分支）
    return {
      content:
        `[verify_start] 启动验证通过（按存活判定，未能探测）：${VERIFY_TIMEOUT_MS / 1000}s 内进程持续存活但未解析到` +
        `可探测的服务地址。验证进程已自动停止。\n输出尾部：\n${tailText(slot)}`,
    }
  },
}

const reportStartCommandsTool: Tool = {
  name: 'report_start_commands',
  description:
    'AI 编译阶段的收尾动作：提交识别出的启动命令清单（每个需要长期运行的服务一项）。' +
    '保存后用户可在预览面板一键「全部运行」。提交即代表识别完成，之后不要再 run_project 启动服务。',
  inputSchema: {
    type: 'object',
    properties: {
      services: {
        type: 'array',
        description: '服务列表',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '服务名（简短英文，如 web / api / admin）' },
            run: { type: 'string', description: '启动命令，如 "npm run dev"、"uvicorn main:app --reload"' },
            url: {
              type: 'string',
              description: '该服务的本地预览地址（含端口，如 http://localhost:8000）。能确定时必须提供，不确定则省略',
            },
          },
          required: ['name', 'run'],
        },
      },
    },
    required: ['services'],
  },
  permission: 'write',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const arr = rec.services
    if (!Array.isArray(arr)) throw new Error('参数 services 必须是数组')
    const services: StartCommand[] = (arr as Record<string, unknown>[])
      .map((s) => ({
        name: String(s?.name ?? '').trim(),
        run: String(s?.run ?? '').trim(),
        ...(typeof s?.url === 'string' && s.url.trim() ? { url: s.url.trim() } : {}),
      }))
      .filter((s) => s.name && s.run)
    if (services.length === 0) {
      return {
        content: '[report_start_commands] services 不能为空，每项需包含 name（服务名）与 run（启动命令）。',
        isError: true,
      }
    }
    await replaceStartCommands(services, projectRoot)
    const list = services.map((s) => `- ${s.name}：${s.run}${s.url ? `（预览地址 ${s.url}）` : ''}`).join('\n')
    return {
      content:
        `[report_start_commands] 已保存 ${services.length} 个服务的启动命令：\n${list}\n` +
        '用户可在预览面板点击「全部运行」直接启动（无需再次识别）。',
    }
  },
}

const updateStartCommandTool: Tool = {
  name: 'update_start_command',
  description:
    '更新某个服务的启动命令（不重新运行）。用于诊断出命令本身有误（路径不对、端口冲突、缺少子目录等）后修正存档命令，' +
    '修正后用户点「全部运行」即可用新命令启动。服务不存在时会新增一条。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '服务名（与已存档的服务名一致）' },
      command: { type: 'string', description: '修正后的启动命令' },
    },
    required: ['name', 'command'],
  },
  permission: 'write',
  async execute(input, ctx) {
    const projectRoot = root(ctx)
    const rec = asRecord(input)
    const name = text(rec, 'name')
    const command = text(rec, 'command')
    const cur = (await getConfig()).startupCommands?.[projectRoot] ?? []
    const exists = cur.some((c) => normName(c.name) === normName(name))
    await upsertStartCommand(name, command, undefined, projectRoot)
    return {
      content: exists
        ? `[update_start_command] 已更新服务「${name}」的启动命令为：${command}。用户下次点「全部运行」或「运行」时将使用新命令。`
        : `[update_start_command] 已添加新服务「${name}」：${command}。用户可在预览面板点击「全部运行」启动。`,
    }
  },
}

// ---------- verify_start 轮询常量与小工具 ----------

const VERIFY_TIMEOUT_MS = 90_000
const VERIFY_POLL_MS = 500
const VERIFY_PROBE_INTERVAL_MS = 2_000
/** 启动信号（无可探测地址的服务靠它判过，如 Java 后端）：与渲染层 READY_HINTS 同族 */
const READY_HINTS: RegExp[] = [
  /\blistening on\b/i,
  /\bstarted on\b/i,
  /\bnow listening\b/i,
  /\bapplication started\b/i,
  /\btomcat started\b/i,
  /\bserver running\b/i,
  /\bserve at\b/i,
  /(?:^|\s)listening at\b/i,
]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function tailText(slot: SlotMirror): string {
  const tail = slot.logs.slice(-RESULT_LOG_TAIL)
  return tail.length > 0 ? tail.join('\n') : '（无输出）'
}

function formatSlotDetail(slot: SlotMirror): string {
  // 已停但无退出码 = 被 stop_project 树杀（proc 的 exit 回调在「槽已被摘」时按既有语义不回流）
  const state = slot.alive
    ? '运行中'
    : slot.lastExitCode !== null
      ? `已退出（exit ${slot.lastExitCode}）`
      : '已停止'
  const lines = [
    `服务：${slot.name}`,
    `状态：${state}`,
    `命令：${slot.command || '（未设置）'}`,
    slot.urls.length > 0
      ? `服务地址（${slot.urls.length} 个）：\n${slot.urls.slice(0, RESULT_URL_CAP).map((u) => `- ${u}`).join('\n')}`
      : '服务地址：（未解析）',
    `最近输出（尾部）：\n${tailText(slot)}`,
  ]
  return lines.join('\n')
}

/** 运行域工具集 */
export const projectTools: Tool[] = [
  runProjectTool,
  stopProjectTool,
  getBuildStatusTool,
  verifyStartTool,
  reportStartCommandsTool,
  updateStartCommandTool,
]
