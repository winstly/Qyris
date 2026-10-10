/**
 * AI 代理 —— 聊天链路统一入口（模型生态收口层）。
 *
 * 一次 aiChatStream = model/ 生态的完整编排（旧 ai-api / ai-cli 双轨在这里收口）：
 *   1. resolveChatProvider：按 dispatchMode / provider 解析 ModelProvider。
 *      口径对齐 memory/agent.ts 的 resolveModelProvider，但**不共用一个函数**：
 *      那边是后台任务从 config 自取 + 未启用返回 null 静默跳过；这边是请求参数驱动
 *      （provider/baseUrl/model 由渲染层设置面板带下来）+ 配置缺失硬报错。政策不同，
 *      强行合并会把「静默跳过」漏进聊天主链路（用户会看到一句话没回）。共同点只有一条：
 *      最终都走 providers/registry.resolveProvider。
 *   2. ConversationStore 承载本次上下文（渲染层 wire 消息 → 统一 Message），provider 不碰会话。
 *   3. runAgent 跑工具循环：工具实现一律取 tools/index.ts（ToolRegistry）并按权限档过滤。
 *      调用方传 tools=null / [] 表示「纯补全、不开工具」（上下文压缩等 headless 调用）——
 *      「要不要工具」由调用方声明，「工具是哪些」由 ToolRegistry 决定，两件事分开。
 *   4. RunnerEvent → IPC 事件桥（见下）。
 *   5. 返回 AiCompletion（形态不变）。
 *
 * 事件桥（通道名与 payload 形状与 useDesktopEvents / useChatStore 消费面一字不改）：
 *   text-delta      → ai-delta        { requestId, projectRoot, delta }
 *   reasoning-delta → ai-reasoning    { requestId, projectRoot, delta }
 *                     （capabilities.thinking 目前全 false，事件暂时不来；通道保留，
 *                       provider 开 thinking 后无需再动本层）
 *   tool-start      → cli-tool-event  { requestId, id, name, phase:'start'|'stop', arguments }
 *                     start 建卡 + stop 回填参数成对下发：渲染层「stop 只代表参数组装完、
 *                     状态由 cli-tool-result 收口」的语义由此保持（RunnerEvent 里输入是齐的，
 *                     所以两帧紧跟在一起发）。
 *   tool-executed   → 同上两通道（MCP 模式专用：工具已执行完，start/stop/result 三帧连发建卡收口，
 *                     事件形状与 tool-start/tool-end 映射逐字一致，渲染层零改动）
 *   tool-end        → cli-tool-result { requestId, id, content, isError }
 *   turn-end        → 不进 IPC（usage 累进收尾元信息，随 ai-reasoning 透明展示）
 *   done            → 不进 IPC（终值走 AiCompletion 返回，与旧链路一致）
 *   error           → 不进 IPC（同一条 Error 由 reject 上抛、渲染层 finalizeDraft 显示；不双报）
 *   cli-agent-event → 通道与语义保留（parentId=派发卡 id，kind=text/tool/tool-result），
 *                     但 runAgent 是主进程单层工具循环，没有子 agent 事件源；子 agent 工具接入后
 *                     由它按既有形状 emit。preload 订阅面不动。
 *
 * 中止：aiCancel(requestId) → AbortController.abort('已取消')。signal 传给 provider
 *      （CLI 子进程经 onceProcs 树杀）与每个工具 ctx（工具自管 killTree），runAgent 保证
 *      「立刻停」并给已建卡未收口的调用补 tool-end(isError)，不给 UI 留永久转圈。
 * 多窗口：windowId 定向发起窗口 + broadcastToWindows 镜像其余窗口（与旧 ai-cli 的 emit
 *      逐字一致，含 windowId 为空时退回 emitToRenderer 全注册窗口的旧语义）。
 *
 * 终值口径：toolCalls **只含交互型调用**（当前 = askUserQuestion，见 tools/ask.ts 的延迟语义）。
 *      常规工具已在主进程执行完并经 cli-tool-event/cli-tool-result 建卡收口，再把它们回填进
 *      AiCompletion.toolCalls 会让渲染层工具循环**二次执行**同一批调用（read_file/write_file/edit_file
 *      两套工具同名，双跑是真事故）——所以只交回「主进程不执行」的那一类。这与旧 CLI 链路
 *      「常规工具不进 completion、活动走 cli-tool-event」的口径一致；交互型走的是旧 API 链路
 *      「completion.toolCalls → 渲染层 askUser 挂起 → 答案作 tool 消息回喂」的原形状。
 */
import { getConfig, type AppConfig } from './config'
import { mainLog } from './log-file'
import { testApiConnection } from './ai-api'
import {
  buildSkillIndex,
  cliCancel,
  extractSkillIds,
  extractNextSkill,
  extractStartCommands,
  resolveSkillBlock,
  testCliConnection,
} from './ai-cli'
import { collectSkillDirs as collectSkillDirsShared } from './skills'
import {
  broadcastToWindows,
  emitToRenderer,
  emitToWindow,
  registerRequestWindow,
  unregisterRequestWindow,
} from './emitter'
import { ConversationStore } from './model/store'
import { runAgent, type RunnerEvent } from './model/runner'
import { setAgentRunContext } from './model/run-context'
import { resolveChatProvider } from './model/provider-resolve'
import { HOST_ONLY_TOOLS, openHostToolProxy, type HostToolProxyEndpoint } from './mcp/proxy'
import { executeTool, isDeferredTool, toolsForPermission } from './tools'
import type { ContentPart, Message, ModelProvider, Tool, ToolPermission, Usage } from './model/types'

export interface AiToolCall {
  id: string
  name: string
  arguments: string
}

export interface AiCompletion {
  content: string | null
  /** 模型的思考过程 / CLI 工具活动进度，有则下发 */
  reasoning: string | null
  toolCalls: AiToolCall[]
  finishReason: string | null
  /** 仅 CLI 模式：模型请求下一轮附带的 Skill id 列表（渲染层按已扫描索引校验后采用） */
  nextSkill?: string[]
  /** 仅 CLI 模式：模型提交的启动命令清单（AI 编译场景，已按 name/run 归一；渲染层负责落盘） */
  startCommands?: { name: string; run: string }[] | null
}

// ---------- 执行参数 ----------

/** 主对话工具循环轮数缺省：API/CLI 通用（CLI 落为 --max-turns、API 为 runner 轮界）；设置 aiMaxTurns 可调 */
const MAX_TURNS = 60

/** CLI 通道上下文预算（token）：旧 serializeConversation 的 160k 字符硬截断折算（4 字符/token）。
 *  语义升级：超预算走 runner 的「窗口 + 摘要（失败降级纯切片）」，不再静默掐头留尾。
 *  API 通道不设预算——旧路径就是全量透传，模型上下文由所选模型自己兜（超限报错可见）。 */
const CLI_CONTEXT_TOKENS = 40_000

/** 在途请求 → 取消句柄（aiCancel 按 requestId 精确打断，不误伤并发请求） */
const inflight = new Map<string, AbortController>()

/** 请求级取消：AbortController → provider（CLI 子进程树杀）+ 工具 ctx（工具自杀）+ runAgent 轮界检查 */
export function aiCancel(requestId: string): void {
  inflight.get(requestId)?.abort('已取消')
  // CLI 子进程按 requestId 登记在 onceProcs（model/providers/claude-cli.ts 的树杀口径），cliCancel 是同一取消口
  cliCancel(requestId)
}

export async function aiTestConnection(
  provider: string, baseUrl: string, model: string, dispatchMode: string = 'api',
  cliCommand?: string,
): Promise<string> {
  if (dispatchMode === 'claude-cli') return testCliConnection(cliCommand)
  return testApiConnection(provider, baseUrl, model)
}

// ---------------- 主入口 ----------------

export async function aiChatStream(
  requestId: string, provider: string, baseUrl: string, model: string, messages: unknown, tools: unknown,
  dispatchMode: string = 'api',
  projectRoot: string | null = null,
  windowId: number | null = null,
  /** 记忆反哺通道（渲染层同时把摘要/记忆块写进 system 消息，二者互为兜底）：
   *  sessionSummary=工作记忆滚动摘要；memoryBlock=长期记忆检索块（预格式化含节标题，原样透传）；
   *  contextSummary=早期对话压缩摘要；systemPrompt=覆盖系统提示（蒸馏类单轮调用用）；
   *  outputFormat=旧 CLI 输出格式开关（mem agent 用 json）——统一后无对应物，保留签名不读值。 */
  opts?: { sessionSummary?: string | null; memoryBlock?: string | null; contextSummary?: string | null; systemPrompt?: string; outputFormat?: string },
): Promise<AiCompletion> {
  const cfg = await getConfig().catch(() => null)
  const permission: ToolPermission = cfg?.aiCliPermission === 'readonly' ? 'readonly' : 'exec'
  // 「要不要工具」是调用方的意图（纯补全类调用传空）；工具实现一律出自 ToolRegistry
  const wantTools = Array.isArray(tools) ? tools.length > 0 : Boolean(tools)
  const controller = new AbortController()
  inflight.set(requestId, controller)
  if (windowId != null) registerRequestWindow(requestId, windowId)

  // 编排工具（dispatch_subtasks）的事件出口挂在本 run 上，CLI 通道只能经 MCP 调工具——
  // 拉起主进程代行通道让 MCP 子进程把编排调用送回本进程执行（见 mcp/proxy.ts）
  let hostProxy: HostToolProxyEndpoint | null = null
  if (dispatchMode === 'claude-cli' && wantTools) {
    hostProxy = await openHostToolProxy((name, input) =>
      executeTool(name, input, { projectRoot, signal: controller.signal, permission }),
    )
  }

  // provider 句柄留到 finally 释放（try 块内别名 modelProvider 供正文使用）
  let providerHandle: ModelProvider | null = null
  try {
    providerHandle = await resolveChatProvider({
      dispatchMode, provider, baseUrl, model, projectRoot, cfg, permission, wantTools, hostProxy,
    })
    const modelProvider = providerHandle
    // 提示词工具面 = 通道实际可达面（与 MCP 暴露面 / runner 执行面同源，不许提示词多说一个字）
    const surfaceTools = wantTools
      ? toolsForPermission(permission).filter(
          (t) => dispatchMode !== 'claude-cli' || (!isDeferredTool(t.name) && (hostProxy != null || !HOST_ONLY_TOOLS.includes(t.name))),
        )
      : []
    const store = new ConversationStore({ provider: modelProvider.id })
    const input = await seedConversation(store, messages, opts, projectRoot, cfg, surfaceTools)

    // 事件桥状态：正文增量 / 思考增量 / 轮次与用量（收尾元信息用）
    const streamed: string[] = []
    const reasoningParts: string[] = []
    let turns = 0
    let toolEvents = 0
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

    const emit = (event: string, payload: Record<string, unknown>): void => {
      const enriched = { projectRoot, ...payload }
      if (windowId != null) {
        emitToWindow(windowId, event, enriched)
        broadcastToWindows(event, enriched, windowId)
      } else {
        emitToRenderer(event, enriched)
      }
    }
    // 编排工具（dispatch_subtasks）要发 cli-agent-event 等定向事件：把 requestId + emit 出口
    // 旁挂在本次 run 的 signal 上（ToolCtx 契约冻结，见 model/run-context.ts）
    setAgentRunContext(controller.signal, { requestId, emit, hostProxy })
    const onEvent = (e: RunnerEvent): void => {
      switch (e.type) {
        case 'text-delta':
          streamed.push(e.text)
          emit('ai-delta', { requestId, delta: e.text })
          break
        case 'reasoning-delta':
          reasoningParts.push(e.text)
          emit('ai-reasoning', { requestId, delta: e.text })
          break
        case 'tool-progress':
          // MCP 模式：工具发起（CLI 吐出 tool_use，MCP 往返执行中）——立即出「执行中」卡片。
          // 这是长命令执行期（npm install 数分钟）唯一的活体反馈，没有它聊天窗体感假死
          toolEvents++
          emit('cli-tool-event', {
            requestId, id: e.id, name: e.name, phase: 'start',
            arguments: typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? {}),
          })
          break
        case 'tool-executed':
          // MCP 模式（executesOwnTools）：工具已执行完。start 已由 tool-progress 出过——
          // 此处只补 stop（参数回填）+ result 收口，不再重复 start
          toolEvents++
          emit('cli-tool-event', {
            requestId, id: e.id, name: e.name, phase: 'stop',
            arguments: typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? {}),
          })
          emit('cli-tool-result', {
            requestId, id: e.id, content: e.result.content, isError: e.result.isError === true,
          })
          break
        case 'tool-start':
          toolEvents++
          emit('cli-tool-event', { requestId, id: e.id, name: e.name, phase: 'start', arguments: '' })
          emit('cli-tool-event', {
            requestId, id: e.id, name: e.name, phase: 'stop',
            arguments: typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? {}),
          })
          break
        case 'tool-output':
          // 工具执行期实时输出 → 子 agent 转录通道（parentId=工具卡 id）。
          // 渲染层无线程命中时落到工具卡的 output（useChatStore 的兜底分支）
          emit('cli-agent-event', {
            requestId, parentId: e.id, kind: 'text', id: e.id, text: e.line, stream: e.stream,
          })
          break
        case 'tool-end':
          emit('cli-tool-result', {
            requestId, id: e.id, content: e.result.content, isError: e.result.isError === true,
          })
          break
        case 'turn-end':
          turns++
          usage.inputTokens += e.usage.inputTokens || 0
          usage.outputTokens += e.usage.outputTokens || 0
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (e.usage.cacheReadTokens || 0)
          usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (e.usage.cacheWriteTokens || 0)
          break
        case 'done':
        case 'error':
          // done 终值走返回值；error 由 runAgent 同一条 Error reject 上抛，这里不双报
          break
      }
    }

    const finalMessage = await runAgent(input, {
      provider: modelProvider,
      tools: wantTools ? toolsForPermission(permission) : [],
      store,
      permission,
      maxTurns: cfg?.aiMaxTurns ?? MAX_TURNS,
      ...(dispatchMode === 'claude-cli' ? { maxContextTokens: CLI_CONTEXT_TOKENS } : {}),
      signal: controller.signal,
      projectRoot,
      onEvent,
    })

    // 终值：正文优先取落库消息（增量已由事件桥实时下发，这里只是权威收口）
    const rawText = textOfMessage(finalMessage) || streamed.join('')
    // 交互型调用延迟给渲染层（tools/ask.ts）：只把这些 toolUse 交回 toolCalls，常规工具不进
    //（否则渲染层工具循环会二次执行主进程已跑过的同名工具）
    const deferredCalls: AiToolCall[] = finalMessage.content
      .filter((p): p is Extract<ContentPart, { type: 'toolUse' }> => p.type === 'toolUse')
      .filter((p) => isDeferredTool(p.name))
      .map((p) => ({
        id: p.id,
        name: p.name,
        arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {}),
      }))
    const skill = extractNextSkill(rawText)
    const cmds = extractStartCommands(skill.text)
    let reasoning = reasoningParts.join('')
    const notes: string[] = []
    if (skill.ids.length > 0) notes.push(`下一轮将附带 Skill：${skill.ids.join('、')}`)
    if (cmds.commands.length > 0) {
      notes.push(`启动命令清单已提交（${cmds.commands.length} 项：${cmds.commands.map((c) => c.name).join('、')}）`)
    }
    if (toolEvents > 0) {
      notes.push(`本轮 ${turns} 轮工具循环 · ${toolEvents} 次工具调用 · 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} tokens`)
    }
    if (notes.length > 0) {
      const note = `\n（${notes.join('；')}）\n`
      reasoning += note
      emit('ai-reasoning', { requestId, delta: note })
    }

    return {
      content: cmds.text.length > 0 ? cmds.text : null,
      reasoning: reasoning.length > 0 ? reasoning : null,
      // 只含交互型调用（askUserQuestion）：渲染层按既有 askUser 流程挂起等回答；常规工具恒为空
      toolCalls: deferredCalls,
      finishReason: 'stop',
      nextSkill: skill.ids,
      // 原样透传（含可选 url：AI 编译的预览地址，渲染层会读）——与旧 CLI 链路同口径
      startCommands: cmds.commands,
    }
  } catch (e) {
    // 中止统一按旧口径回「已取消」：渲染层把 reject 文案直接当用户可见错误展示，
    // 带 AbortError 前缀会把「用户主动停」伪装成故障（旧链路抛的就是 new Error('已取消')）
    if (controller.signal.aborted) throw new Error('已取消')
    throw e
  } finally {
    inflight.delete(requestId)
    if (windowId != null) unregisterRequestWindow(requestId)
    hostProxy?.close()
    void providerHandle?.dispose?.()
  }
}

// provider 解析收口到 model/provider-resolve.ts（主对话与子 agent 同一入口，见该文件头）

// ---------------- 装载会话（wire → ConversationStore） ----------------

type Wire = Record<string, any>

function textOfMessage(m: Message): string {
  return m.content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** 渲染层 wire（OpenAI 形）→ 统一 Message。
 *  tool_calls → toolUse 块、tool 消息 → toolResult 块（types.ts 的归一口径）；
 *  空文本不产块（providers 的 wire 层同样丢空块，两边一致），未知字段不透传。 */
function toModelMessage(m: Wire): Message {
  const role = m?.role === 'system' || m?.role === 'assistant' || m?.role === 'tool' ? m.role : 'user'
  const text = typeof m?.content === 'string' ? m.content : ''
  const content: ContentPart[] = []

  if (role === 'tool') {
    content.push({
      type: 'toolResult',
      toolUseId: typeof m?.tool_call_id === 'string' ? m.tool_call_id : '',
      content: text,
    })
    return { role, content, meta: { ts: Date.now() } }
  }

  if (text) content.push({ type: 'text', text })
  if (role === 'assistant' && Array.isArray(m?.tool_calls)) {
    for (const tc of m.tool_calls as Wire[]) {
      const name = typeof tc?.function?.name === 'string' ? tc.function.name : ''
      if (!name) continue
      let input: unknown = {}
      const raw = tc?.function?.arguments
      if (typeof raw === 'string' && raw.trim()) {
        try {
          input = JSON.parse(raw)
        } catch {
          // 参数 JSON 写坏：原样留证交给模型/排障，不当空对象吞掉
          input = { _raw: raw }
        }
      }
      content.push({
        type: 'toolUse',
        id: typeof tc?.id === 'string' && tc.id ? tc.id : '',
        name,
        input,
      })
    }
  }
  return { role, content, meta: { ts: Date.now() } }
}

/**
 * 通道现实块：执行面是 ToolRegistry（产品工具已并入，见 tools/），渲染层 system 描述的工具名
 * 有个别是旧名（list_files / grep_files / run_once）。不覆盖渲染层人格，只补一块
 * 「工具以本清单为准 + 旧名映射」，压住模型去调不存在的工具（runAgent 的未知工具反馈虽能自纠，但白烧一轮）。
 *
 * **清单必须是通道实际可达面**（调用方按 MCP 暴露面 / runner 执行面裁好传入）：多说一个名字，
 * 模型就会去找不存在的工具——线上「load_skill 误调 dispatch_subtasks」就是提示词越权宣称的后果。
 */
function buildToolRealityBlock(tools: readonly Tool[]): string {
  const names = new Set(tools.map((t) => t.name))
  const lines = [
    '【工具环境（系统注入，优先于任何历史提示中的工具名）】',
    '本环境可用工具如下（入参见工具定义；调用方式以系统注入的工具协议说明为准）：',
    ...tools.map((t) => `- ${t.name}：${t.description}`),
    '旧名映射（历史提示里的这些名字已改名，请直接用新名）：list_files → list_dir（单层目录列表）；' +
      'grep_files → grep（按内容搜索）；run_once → run_command（一次性命令）。' +
      '上表是唯一可用清单：不在上表的工具名（含历史提示里的其他旧名）一律不可用，不要请求。',
    '声明工具调用时只用本通道原生的工具调用通道（工具协议说明会随请求注入）；不要在正文里写围栏块/自创标签/裸 JSON 冒充调用——正文里的调用语法不会被执行。',
  ]
  // 交互型工具被通道裁掉时（CLI/MCP 通道不暴露 askUserQuestion）必须给出替代行为，
  // 否则渲染层人格还在教它「调用 askUserQuestion」——又一个提示词越权的坑
  if (!names.has('askUserQuestion')) {
    lines.push(
      'askUserQuestion 在本通道不可用：需要用户做选择或补充信息时，直接在回复中向用户提问并结束本轮，等用户回复后再继续；不要臆测用户意图硬做决定。',
    )
  }
  return lines.join('\n')
}

/** Skill 目录三源合并：项目默认（<project>/.qyris/skills）+ 项目自定义 + 全局（skills.collectSkillDirs 同一入口） */
function collectSkillDirs(projectRoot: string | null, cfg: AppConfig | null): string[] {
  return collectSkillDirsShared(projectRoot, cfg ?? { skillsDirs: [] })
}

/**
 * 装载：渲染层消息 → store；本轮用户输入从尾部拆出交给 runAgent（runAgent 负责落这条 user）。
 *
 * 系统提示组装：
 *   · opts.systemPrompt 存在 → 整体覆盖（蒸馏类调用的自含提示，不掺通道块）；
 *   · 否则 = 通道现实块 + Skill 内联/索引 + 渲染层 system 原文（人格 + 记忆块）；
 *   · 渲染层没有 system 而 opts 带摘要/记忆块 → 用 opts 补头（旧 CLI「system 被丢弃、记忆走正文」
 *     契约的兜底）；两边都有时只信 system，避免同一段记忆注两遍。
 */
async function seedConversation(
  store: ConversationStore,
  messages: unknown,
  opts: { sessionSummary?: string | null; memoryBlock?: string | null; contextSummary?: string | null; systemPrompt?: string } | undefined,
  projectRoot: string | null,
  cfg: AppConfig | null,
  surfaceTools: readonly Tool[],
): Promise<string> {
  const wire: Wire[] = Array.isArray(messages)
    ? (messages as Wire[]).filter((m) => m && typeof m === 'object')
    : []

  // 尾部 user = 本轮输入（runAgent 会落它）；没有就整段进 store，input 留空由 wire 层丢空 user
  let input = ''
  let history = wire
  const last = wire[wire.length - 1]
  if (last?.role === 'user' && typeof last.content === 'string' && last.content.trim()) {
    input = last.content
    history = wire.slice(0, -1)
  }

  const systemTexts = history
    .filter((m) => m?.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)

  let system: string
  if (opts?.systemPrompt) {
    system = opts.systemPrompt
  } else {
    const parts: string[] = [buildToolRealityBlock(surfaceTools)]
    // Skill 内联（历史引用的全文）+ 可用索引（[[NEXT_SKILL]] 请求通道），与旧 CLI 同一套协议。
    // 引用提取看**全量 wire**（含本轮 user）：skillInstruction.ts 的加载指令是拼在用户消息上的，
    // 只扫 history 会漏掉「本轮刚触发的 Skill」——那正是最需要内联的一次
    const skillDirs = collectSkillDirs(projectRoot, cfg)
    const referenced = extractSkillIds(wire)
    const [skillBlock, skillIndex] = await Promise.all([
      resolveSkillBlock(skillDirs, referenced),
      buildSkillIndex(skillDirs, referenced),
    ])
    if (skillBlock) parts.push(skillBlock)
    if (skillIndex) parts.push(skillIndex)
    if (systemTexts.length > 0) {
      parts.push(...systemTexts)
    } else {
      // 旧 CLI 记忆反哺契约：调用方只把摘要/记忆塞在 opts 里（system 被丢弃时代），这里补头
      const head = [
        opts?.sessionSummary ? `【此前会话进展】\n${opts.sessionSummary}` : '',
        opts?.memoryBlock ?? '',
        opts?.contextSummary ? `【早期对话摘要（原始历史已压缩）】\n${opts.contextSummary}` : '',
      ].filter((s) => s && s.trim())
      parts.push(...head)
    }
    system = parts.join('\n\n')
  }

  // system 归一成一条：OpenAI 兼容端点对多条 system 容忍度不一，合并最稳
  if (system.trim()) store.append({ role: 'system', content: [{ type: 'text', text: system }], meta: { ts: Date.now() } })
  for (const m of history) {
    if (m?.role === 'system') continue
    store.append(toModelMessage(m))
  }
  // 泄漏诊断：thinking「复用旧内容」的两路来源要能一眼分开——
  //   ① history 没清（clear 换代竞态整表覆盖回旧 slice）→ seed 历史远超本轮输入
  //   ② system 混入旧块 → 块标记出现在 system，但本轮 opts 并没注入这个块（= 旧块从别处钻进来）
  // 判定口径保证「正常清空不触发」：clear() 后 lastSummary=null、压缩缓存已清，摘要类标记必不出现；
  // 长期记忆块跨会话是设计内注入，只要它来自本轮 opts 就不算泄漏。
  const expected: Record<string, string | null | undefined> = {
    '【此前会话进展】': opts?.sessionSummary,
    '【早期对话摘要': opts?.contextSummary,
    '【长期记忆': opts?.memoryBlock,
  }
  const leakBlocks = Object.keys(expected).filter((m) => system.includes(m) && !expected[m])
  if (history.length > 6 || leakBlocks.length > 0) {
    mainLog.info(
      `[seed] 泄漏诊断：history=${history.length}条 system=${system.length}字 命中=${leakBlocks.join('/') || '无'}（正常清空后不出现此行）`,
    )
  }
  return input
}
