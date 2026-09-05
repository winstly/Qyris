/**
 * AI Adapter · Claude CLI —— 经本机 claude 命令（Claude Code）调度自主 agent。
 * CLI 自带文件/命令工具与执行循环：本适配器不传轻驭工具集，也不解析 tool_use 交渲染层执行，
 * 只消费 stream-json（stdout NDJSON，非 SSE）的 text/thinking 增量与最终 result。
 * 会话为无状态重放：每轮把轻驭历史序列化进 prompt（编辑重发/分叉天然正确）。
 * Windows：claude 通常是 .cmd，直连 spawn 会被 Node ≥18 的 EINVAL 拦截 —— 与 proc.ts 同惯性走 cmd.exe /C。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { homedir } from 'node:os'
import { emitToRenderer, emitToWindow, registerRequestWindow, unregisterRequestWindow } from './emitter'
import { getConfig, type AppConfig } from './config'
import { readSkillFromDirs, scanSkillsDirs } from './skills'
import { buildChildEnv, cancelRunOnce, detectCommand, registerOnceProc } from './proc'
import { errorMessage } from './util'
import type { AiCompletion, AiToolCall } from './ai'

type Json = Record<string, any>

const CLI_MAX_TURNS = 60
const CLI_TIMEOUT_MS = 30 * 60_000
const CLI_HEARTBEAT_MS = 30_000
/** stream-json 必配：verbose 才有完整事件；include-partial-messages 才有逐 token 增量 */
const CLI_ARGS_BASE = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
/** 受限只读档白名单（--allowedTools，逗号拼接单参数） */
const READONLY_TOOLS = 'Read,Glob,Grep,LS,TodoWrite,WebSearch,WebFetch'

const NOT_INSTALLED_MSG = '未找到 claude 命令：请先安装 Claude Code CLI（npm install -g @anthropic-ai/claude-code）并在终端完成登录后重试'

/** CLI 解析名：默认 'claude'（Windows 经 cmd 自查 PATH → claude.cmd，unix 经 PATH 直启） */
let cliCommand = 'claude'

/** 冒烟测试用：注入假 CLI 路径 */
export function setCliCommandForTest(cmd: string): void {
  cliCommand = cmd
}

/** 请求级取消：CLI 子进程登记在 onceProcs（token=requestId），复用统一取消链 */
export function cliCancel(requestId: string): void {
  cancelRunOnce(requestId)
}

// ---------------- prompt 组装（无状态重放核心） ----------------

const TOOL_ARG_CAP = 300 // 单条工具参数展示上限（write_file 的 arguments 可能含整文件内容）
const TOOL_RESULT_CAP = 1500 // 单条工具结果展示上限
const PROMPT_TOTAL_CAP = 160_000 // 整段对话序列化总上限，超限掐头留尾

function clip(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + '…' : s
}

/** 工具名回查：tool 消息只有 tool_call_id，从历史 assistant.tool_calls 里补回工具名 */
function toolNameOf(callId: string, namesById: Map<string, string>): string {
  return namesById.get(callId) ?? callId.slice(0, 8)
}

/** 把轻驭历史（OpenAI 格式）扁平成 CLI 友好的对话文本。
 *  system 全部丢弃（CLI 系统提示由 adapter 注入，CLI 还会自动加载 cwd 下 CLAUDE.md）；
 *  轻驭工具痕迹以「本环境不存在」声明 + 截断参数保留，供 CLI 理解此前轮次发生了什么 */
export function serializeConversation(messages: unknown): string {
  const msgs = (Array.isArray(messages) ? messages : []) as Json[]
  const namesById = new Map<string, string>()
  for (const m of msgs) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const tc of m.tool_calls as Json[]) {
      const id = typeof tc?.id === 'string' ? tc.id : ''
      const name = typeof tc?.function?.name === 'string' ? tc.function.name : ''
      if (id && name) namesById.set(id, name)
    }
  }

  const out: string[] = []
  for (const m of msgs) {
    const role = m?.role
    if (role === 'system') continue
    const text = typeof m?.content === 'string' ? m.content : ''
    if (role === 'user') {
      out.push(`用户：${text}`)
    } else if (role === 'assistant') {
      const tcs = Array.isArray(m.tool_calls) ? (m.tool_calls as Json[]) : []
      if (tcs.length === 0) {
        out.push(`助手：${text}`)
      } else {
        const lines = [
          `助手：${text}`.trimEnd(),
          '（助手此前轮次调用过轻驭工作台工具，这些工具不存在于本环境，仅作上下文参考）',
        ]
        for (const tc of tcs) {
          const name = typeof tc?.function?.name === 'string' ? tc.function.name : 'unknown'
          const args = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : ''
          lines.push(`- ${name} 参数：${clip(args || '{}', TOOL_ARG_CAP)}`)
        }
        out.push(lines.join('\n'))
      }
    } else if (role === 'tool') {
      const callId = typeof m?.tool_call_id === 'string' ? m.tool_call_id : ''
      out.push(`（工具 ${toolNameOf(callId, namesById)} 返回：${clip(text, TOOL_RESULT_CAP)}）`)
    }
  }

  let joined = out.join('\n\n')
  if (joined.length > PROMPT_TOTAL_CAP) {
    const half = PROMPT_TOTAL_CAP / 2
    joined = `${joined.slice(0, half)}\n（…更早对话已省略…）\n${joined.slice(-half)}`
  }
  return joined
}

/** 下一轮模型指令：回复末行 [[NEXT_MODEL: <模型名>]] */
const NEXT_MODEL_RE = /\[\[NEXT_MODEL:\s*([A-Za-z0-9._:/-]+)\s*\]\]\s*$/i

/** 从回复尾部提取下一轮模型指令并剥离；无指令/不在末尾/含非法字符时原样返回 */
export function extractNextModel(text: string): { text: string; nextModel: string | null } {
  if (!text) return { text, nextModel: null }
  const m = text.match(NEXT_MODEL_RE)
  if (!m || m.index === undefined) return { text, nextModel: null }
  return { text: text.slice(0, m.index).trimEnd(), nextModel: m[1] }
}

/** 下一轮 Skill 请求指令（与 NEXT_MODEL 同款尾行协议；id 允许中文目录名） */
const NEXT_SKILL_RE = /\[\[NEXT_SKILL:\s*([^\]\n]+?)\s*\]\]\s*$/i

/** 从回复尾部提取 [[NEXT_SKILL: id1, id2]] 并剥离 */
export function extractNextSkill(text: string): { text: string; ids: string[] } {
  if (!text) return { text, ids: [] }
  const m = text.match(NEXT_SKILL_RE)
  if (!m || m.index === undefined) return { text, ids: [] }
  const ids = m[1].split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  return { text: text.slice(0, m.index).trimEnd(), ids }
}

/** 从回复尾部提取 [[START_COMMANDS: ...]] 并剥离 */
export function extractStartCommands(text: string): { text: string; commands: { name: string; run: string }[] } {
  if (!text) return { text, commands: [] }
  const m = text.match(/\[\[START_COMMANDS:\s*(\[.*\])\s*\]\]\s*$/is)
  if (!m || m.index === undefined) return { text, commands: [] }
  let commands: { name: string; run: string }[] = []
  try {
    const parsed = JSON.parse(m[1]) as unknown
    if (Array.isArray(parsed)) {
      commands = (parsed as Record<string, unknown>[])
        .map((s) => ({ name: String(s?.name ?? '').trim(), run: String(s?.run ?? '').trim() }))
        .filter((s) => s.name && s.run)
        .slice(0, 8)
    }
  } catch {
    /* 剥离但不采纳 */
  }
  return { text: text.slice(0, m.index).trimEnd(), commands }
}

/** 可用模型菜单（config 主模型 + 已配置档位）：注入系统提示，供 CLI 逐轮指定下一轮模型 */
export function buildModelMenu(cfg: AppConfig | null): string {
  if (!cfg) return ''
  const main = (cfg.aiModel ?? '').trim()
  const tiers: string[] = []
  for (const [k, v] of Object.entries(cfg.aiTiers ?? {})) {
    const m = typeof v === 'string' ? v.trim() : ''
    if (m) tiers.push(`${k}：${m}`)
  }
  if (!main && tiers.length === 0) return ''
  const lines = ['可用模型清单（你可为下一轮对话指定模型）：']
  if (main) lines.push(`- 主模型（默认）：${main}`)
  for (const t of tiers) lines.push(`- 档位 ${t}`)
  lines.push(
    '逐轮选模规则：预期下一轮任务较轻（问答/小改动）就在回复最后一行输出 [[NEXT_MODEL: <模型名>]] 选用更轻的模型，'
    + '任务较重或不确定时省略该行（下一轮用主模型）。该行由系统消费、不会展示给用户；除该行外不要输出任何机器指令。',
  )
  return lines.join('\n')
}

// ---------------- Skill 内联（CLI 没有 load_skill 工具，内容必须直接注入） ----------------

/** buildHistory 注入的两种加载指令形态 + 渲染层 NEXT_SKILL 附带标记（均为同仓代码，格式钉死） */
const SKILL_MULTI_RE = /请先用 load_skill 依次加载以下 \d+ 个 Skill，全部加载后再执行：([^\n]+)/g
const SKILL_SINGLE_RE = /请先用 load_skill 加载 Skill「([^」]+)」/g
const SKILL_ATTACH_RE = /\[附带 Skill：([^\]\n]+)\]/g

/** 从历史消息中提取被引用的 Skill id（子目录名，去重保序） */
export function extractSkillIds(messages: unknown): string[] {
  const msgs = (Array.isArray(messages) ? messages : []) as Json[]
  const found: string[] = []
  const pushIds = (raw: string): void => {
    for (const id of raw.split(/[,，、]/)) {
      const t = id.trim()
      if (t && !found.includes(t)) found.push(t)
    }
  }
  for (const m of msgs) {
    if (typeof m?.content !== 'string') continue
    for (const re of [SKILL_MULTI_RE, SKILL_SINGLE_RE, SKILL_ATTACH_RE]) {
      const rx = new RegExp(re.source, 'g')
      for (let x = rx.exec(m.content); x; x = rx.exec(m.content)) pushIds(x[1])
    }
  }
  return found
}

const SKILL_CONTENT_CAP = 20_000 // 单个 Skill 内容上限（指令文件通常远小于此）

/** 读取被引用 Skill 的完整内容，组装注入块；目录未配置/全部读取失败返回空串。
 *  多目录按序查找首个命中（skills.ts 统一入口）；readSkill 自带路径穿越守卫，id 为子目录名 */
export async function resolveSkillBlock(dirs: string[], ids: string[]): Promise<string> {
  if (dirs.length === 0 || ids.length === 0) return ''
  const parts: string[] = []
  for (const id of ids) {
    const content = await readSkillFromDirs(dirs, id)
    if (content && content.trim()) parts.push(`<skill id="${id}">\n${clip(content, SKILL_CONTENT_CAP)}\n</skill>`)
  }
  if (parts.length === 0) return ''
  return [
    '本任务的历史引用了以下「轻驭 Skill」，完整内容附下——请直接遵循其中与当前任务相关的指令，无需执行任何加载动作：',
    ...parts,
  ].join('\n\n')
}

/** 可用 Skill 索引（名称+描述，排除已内联全文的）：CLI 无按需加载工具，
 *  索引让它感知可用域，并给出 [[NEXT_SKILL]] 请求通道（下一轮附带全文） */
export async function buildSkillIndex(dirs: string[], excludeIds: string[]): Promise<string> {
  if (dirs.length === 0) return ''
  const excluded = new Set(excludeIds)
  const rows: string[] = []
  for (const m of await scanSkillsDirs(dirs)) {
    if (excluded.has(m.id)) continue
    rows.push(`- ${m.id}：${m.name}${m.description ? `（${m.description}）` : ''}`)
  }
  if (rows.length === 0) return ''
  return [
    '可用 Skill 索引（仅有摘要；若某个 Skill 与任务相关，在回复最后一行输出 [[NEXT_SKILL: <id>]] 请求下一轮附带其完整内容，多个用逗号分隔。该行由系统消费、不会展示给用户）：',
    ...rows,
  ].join('\n')
}

export function buildCliSystemPrompt(projectRoot: string | null, modelMenu = '', skillBlock = '', skillIndex = ''): string {
  const lines = [
    '你是「轻驭」工作台调度的编码 agent，通过本机 Claude Code CLI 在项目目录内自主工作。',
    '你拥有自己的文件读写与命令执行工具——直接使用它们完成任务，不要把操作写成建议。',
    '若任务要求登记启动命令（如 AI 编译）：在回复最后一行输出 [[START_COMMANDS: [{"name":"portal","run":"npm run dev"}]]]（紧凑单行 JSON 数组，name 为简短英文服务名）。该行由系统消费登记、不会展示给用户。',
    skillBlock
      ? '对话历史里出现的 list_files / write_file / run_once 等「轻驭工具」调用痕迹来自此前轮次，那些工具不存在于你这里，请使用你的等价工具。唯一的例外是 load_skill：被引用 Skill 的完整内容已直接附在本提示之后，直接遵循即可，不要再尝试加载。'
      : '对话历史里出现的 list_files / write_file / run_once / load_skill 等「轻驭工具」调用痕迹来自此前轮次，那些工具不存在于你这里，请使用你的等价工具；load_skill 的加载要求若未附内容，忽略它并按任务字面继续。',
    '用简体中文回复；代码、命令、标识符保持原样。',
    '你的最终回复会完整展示给用户：给出结论、关键文件路径与遗留风险，不要输出过程碎片。',
  ]
  lines.push(projectRoot ? `当前项目目录：${projectRoot}，请在该目录内工作。` : '当前未打开项目。')
  if (skillBlock) lines.push('', skillBlock)
  if (modelMenu) lines.push('', modelMenu)
  if (skillIndex) lines.push('', skillIndex)
  return lines.join('\n')
}

/** CLI 启动参数（prompt 走 stdin） */
export function buildCliArgs(model: string, permissionMode: 'auto' | 'readonly'): string[] {
  const args = [...CLI_ARGS_BASE, '--max-turns', String(CLI_MAX_TURNS)]
  const m = model.replace(/[^A-Za-z0-9._\-/:]/g, '')
  if (m && !m.startsWith('-')) args.push('--model', m)
  if (permissionMode === 'readonly') args.push('--allowedTools', READONLY_TOOLS)
  else args.push('--dangerously-skip-permissions')
  return args
}

// ---------------- 流式主流程 ----------------

export async function claudeCliChatStream(
  requestId: string, model: string, messages: unknown,
  projectRoot: string | null, permissionMode: 'auto' | 'readonly',
  /** 调用方透传的 config */
  cfgIn?: AppConfig | null,
  /** 发起请求的窗口 ID（多窗口事件定向路由） */
  windowId: number | null = null,
): Promise<AiCompletion> {
  if (windowId != null) registerRequestWindow(requestId, windowId)
  const emit = (event: string, payload: unknown): void => {
    if (windowId != null) emitToWindow(windowId, event, payload)
    else emitToRenderer(event, payload)
  }
  if (cliCommand === 'claude' && detectCommand('claude') === false) {
    throw new Error(NOT_INSTALLED_MSG)
  }

  const cfg = cfgIn ?? await getConfig().catch(() => null)
  const skillDirs = cfg?.skillsDirs ?? []
  const modelMenu = buildModelMenu(cfg)
  const referencedIds = extractSkillIds(messages)
  const [skillBlock, skillIndex] = await Promise.all([
    resolveSkillBlock(skillDirs, referencedIds),
    buildSkillIndex(skillDirs, referencedIds),
  ])
  const prompt = `${buildCliSystemPrompt(projectRoot, modelMenu, skillBlock, skillIndex)}\n\n<conversation>\n${serializeConversation(messages)}\n</conversation>`
  const args = buildCliArgs(model, permissionMode)
  const isWin = process.platform === 'win32'

  return new Promise<AiCompletion>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(isWin ? 'cmd.exe' : cliCommand, isWin ? ['/C', cliCommand, ...args] : args, {
        cwd: projectRoot ?? homedir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
        env: { ...buildChildEnv(), NO_COLOR: '1', FORCE_COLOR: '0' },
      })
    } catch (e) {
      reject(new Error(`Claude CLI 启动失败：${errorMessage(e)}`))
      return
    }
    const unregister = registerOnceProc(requestId, child)

    child.stdin?.on('error', () => {})
    child.stdin?.write(prompt)
    child.stdin?.end()

    let content = '' // text_delta 累积（result 缺席时的回退）
    let reasoning = '' // thinking 增量（工具活动走 tool_use 流式组装，不进 reasoning）
    const toolCalls: AiToolCall[] = []
    let currentTool: AiToolCall | null = null
    let finalText: string | null = null // result 事件的权威全文
    let finishReason: string | null = null
    let interrupted = false // 超时/取消主动击杀（Windows taskkill 不产生 signal，需自记）
    let settled = false
    let stderrTail = ''

    const timer = setTimeout(() => {
      interrupted = true
      cancelRunOnce(requestId)
    }, CLI_TIMEOUT_MS)

    const startedAt = Date.now()
    let lastActiveAt = startedAt
    let lastActivity = ''
    const touch = (desc?: string): void => {
      lastActiveAt = Date.now()
      if (desc) lastActivity = desc
    }
    const heartbeat = setInterval(() => {
      if (settled) return
      const total = Math.round((Date.now() - startedAt) / 1000)
      const idle = Math.round((Date.now() - lastActiveAt) / 1000)
      const line =
        `（运行中 · 累计 ${Math.floor(total / 60)}m${total % 60}s · 距上次活动 ${idle}s` +
        `${lastActivity ? ` · 最近：${lastActivity}` : ''}）`
      emit('ai-reasoning', { requestId, delta: `\n${line}\n` })
    }, CLI_HEARTBEAT_MS)

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(heartbeat)
      unregister()
      unregisterRequestWindow(requestId)
      fn()
    }

    const onLine = (raw: string): void => {
      const line = raw.trim()
      if (!line) return
      touch()
      let json: Json
      try {
        json = JSON.parse(line) as Json
      } catch {
        return // 坏行静默跳过
      }
      const type = json.type as string | undefined

      if (type === 'system' && json.subtype === 'init') {
        // 无状态重放：session_id 仅留痕日志，不做 --resume
        console.log(`[ai-cli] session ${String(json.session_id ?? '')}`)
        return
      }

      if (type === 'stream_event') {
        const evt = json.event as Json | undefined
        const delta = evt?.delta as Json | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          touch('生成正文')
          content += delta.text
          emit('ai-delta', { requestId, delta: delta.text })
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          touch('思考中')
          reasoning += delta.thinking
          emit('ai-reasoning', { requestId, delta: delta.thinking })
        } else if (evt?.type === 'content_block_start') {
          const block = evt.content_block as Json | undefined
          if (block?.type === 'tool_use') {
            currentTool = { id: String(block.id ?? `cli-${toolCalls.length}`), name: String(block.name ?? 'tool'), arguments: '' }
            touch(`[cli] ${currentTool.name}`)
            emit('cli-tool-event', { requestId, id: currentTool.id, name: currentTool.name, phase: 'start', arguments: '' })
          }
        } else if (delta?.type === 'input_json_delta' && currentTool && typeof delta.partial_json === 'string') {
          currentTool.arguments += delta.partial_json
        } else if (evt?.type === 'content_block_stop' && currentTool) {
          toolCalls.push(currentTool)
          emit('cli-tool-event', { requestId, id: currentTool.id, name: currentTool.name, phase: 'stop', arguments: currentTool.arguments })
          currentTool = null
        }
        return
      }

      // result 事件没有 type 字段：用 subtype 或 result 字段检测
      if (type === 'result' || json.subtype === 'success' || json.subtype === 'error_max_turns' || (json.result !== undefined && json.num_turns !== undefined)) {
        if (json.subtype === 'success' || json.stop_reason === 'end_turn') {
          finalText = typeof json.result === 'string' && json.result ? json.result : null
          finishReason = 'stop'
          const turns = Number(json.num_turns)
          const cost = Number(json.total_cost_usd)
          const meta: string[] = []
          if (Number.isFinite(turns) && turns > 0) meta.push(`${turns} 轮`)
          if (Number.isFinite(cost) && cost > 0) meta.push(`费用 $${cost.toFixed(4)}`)
          if (meta.length) {
            const metaLine = `\n（CLI 完成：${meta.join(' · ')}）\n`
            reasoning += metaLine
            emit('ai-reasoning', { requestId, delta: metaLine })
          }
        } else if (json.subtype === 'error_max_turns') {
          finalText = typeof json.result === 'string' && json.result ? json.result : null
          finishReason = 'max_turns'
          const note = '\n（CLI 已达到 60 轮上限，任务可能未完成——请检查中间结果，必要时拆分任务后继续）\n'
          reasoning += note
          emit('ai-reasoning', { requestId, delta: note })
        } else {
          finalText = null
          stderrTail = `${stderrTail}\n${typeof json.result === 'string' ? json.result : 'CLI 报告执行失败'}`.slice(-2000)
        }
      }
    }

    const pipe = (stream: Readable | null, onLineFn: ((line: string) => void) | null): void => {
      if (!stream) return
      const rl = createInterface({ input: stream })
      if (onLineFn) rl.on('line', onLineFn)
      else rl.on('line', (l) => { stderrTail = `${stderrTail}\n${l}`.slice(-2000) })
    }
    pipe(child.stdout, onLine)
    pipe(child.stderr, null)

    child.on('error', (e) => {
      settle(() => reject(new Error(`Claude CLI 启动失败：${errorMessage(e)}`)))
    })

    // 等 close 而非 exit：确保 stdio 冲刷完毕
    child.on('close', (code, signal) => {
      settle(() => {
        const finalizeContent = (): {
          content: string | null
          nextModel: string | null
          nextSkill: string[]
          startCommands: { name: string; run: string }[]
        } => {
          const raw = finalText ?? (content.length > 0 ? content : null)
          if (!raw) return { content: null, nextModel: null, nextSkill: [], startCommands: [] }
          let work = raw
          let nextModel: string | null = null
          let nextSkill: string[] = []
          let startCommands: { name: string; run: string }[] = []
          const notes: string[] = []
          for (let i = 0; i < 4; i++) {
            const m = extractNextModel(work)
            const s = extractNextSkill(m.text)
            const c = extractStartCommands(s.text)
            if (!m.nextModel && s.ids.length === 0 && c.commands.length === 0) break
            if (m.nextModel) nextModel = m.nextModel
            if (s.ids.length > 0) nextSkill = s.ids
            if (c.commands.length > 0) startCommands = c.commands
            work = c.text
          }
          if (nextModel) notes.push(`下一轮对话将使用模型：${nextModel}`)
          if (nextSkill.length > 0) notes.push(`下一轮将附带 Skill：${nextSkill.join('、')}`)
          if (startCommands.length > 0) notes.push(`启动命令清单已提交（${startCommands.length} 项：${startCommands.map((c) => c.name).join('、')}）`)
          if (notes.length > 0) {
            const note = `\n（${notes.join('；')}）\n`
            reasoning += note
            emit('ai-reasoning', { requestId, delta: note })
          }
          return { content: work.length > 0 ? work : null, nextModel, nextSkill, startCommands }
        }
        if (finalText !== null || finishReason === 'max_turns') {
          const { content: clean, nextModel, nextSkill, startCommands } = finalizeContent()
          resolve({
            content: clean,
            reasoning: reasoning.length > 0 ? reasoning : null,
            toolCalls: [],
            finishReason,
            nextModel,
            nextSkill,
            startCommands,
          })
          return
        }
        // 超时中止（文案避开 isRetryableError 关键词防误重试）
        if (interrupted) {
          reject(new Error('Claude CLI 连续运行超过 30 分钟，已被强制中止（任务过长请拆分步骤后重试）'))
          return
        }
        if (signal) {
          reject(new Error('已取消'))
          return
        }
        if (code === 0) {
          const { content: clean, nextModel, nextSkill, startCommands } = finalizeContent()
          resolve({
            content: clean,
            reasoning: reasoning.length > 0 ? reasoning : null,
            toolCalls: [],
            finishReason: 'stop',
            nextModel,
            nextSkill,
            startCommands,
          })
          return
        }
        const detail = translateCliError(stderrTail) ?? clip(stderrTail.trim(), 400)
        reject(new Error(`Claude CLI 异常退出（exit ${code ?? -1}）：${detail || '无错误输出'}`))
      })
    })
  })
}

/** stderr 转译 */
function translateCliError(stderrTail: string): string | null {
  if (/not logged in|please (run )?\/login|Invalid API key|authentication|unauthorized/i.test(stderrTail)) {
    return 'Claude CLI 未登录或凭据失效：请在终端运行 claude 完成登录（或设置 ANTHROPIC_API_KEY 环境变量）'
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|timed out|fetch failed/i.test(stderrTail)) {
    return 'Claude CLI 网络错误：无法连接 Anthropic 服务（网络类错误将自动重试）'
  }
  if (/Unknown model|invalid model|not found.*model/i.test(stderrTail)) {
    return 'Claude CLI 不认识当前主模型名：请在设置中把主模型改为 sonnet / opus / haiku 或完整模型 ID'
  }
  return null
}

// ---------------- 连接测试（二进制 + 版本 + 登录态） ----------------

/** 异步执行 CLI 探测命令 */
async function runCli(args: string[], timeoutMs = 10_000): Promise<{ status: number | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    let child: ChildProcess
    try {
      child = spawn(isWin ? 'cmd.exe' : cliCommand, isWin ? ['/C', cliCommand, ...args] : args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: buildChildEnv(),
      })
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: '', error: errorMessage(e) })
      return
    }
    let stdout = ''
    let stderr = ''
    const collect = (stream: Readable | null, on: (chunk: string) => void): void => {
      if (!stream) return
      stream.setEncoding('utf8')
      stream.on('data', on)
    }
    collect(child.stdout, (d) => { stdout += d })
    collect(child.stderr, (d) => { stderr += d })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 进程已不在 */ }
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ status: null, stdout: '', stderr: '', error: errorMessage(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr, error: null })
    })
  })
}

export async function testCliConnection(): Promise<string> {
  if (cliCommand === 'claude' && detectCommand('claude') === false) {
    throw new Error(NOT_INSTALLED_MSG)
  }
  const version = await runCli(['--version'])
  if (version.error) throw new Error(`claude 命令执行失败：${version.error}`)
  const versionText = version.stdout.trim().split('\n')[0] || '版本未知'

  const auth = await runCli(['auth', 'status'])
  if (auth.status === 0) return `Claude CLI 就绪 · ${versionText} · 已登录`
  const combined = `${auth.stderr}\n${auth.stdout}`
  if (/unknown|unrecognized|invalid/i.test(combined)) {
    return `Claude CLI 已安装 · ${versionText}（登录状态未知，直接对话验证）`
  }
  return `Claude CLI 已安装 · ${versionText}，但未检测到登录：请在终端运行 claude 完成登录`
}
