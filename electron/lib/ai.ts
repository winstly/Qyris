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
 *      CLI 档的 askUserQuestion 另有一条活路：经 HOST_ONLY 代行通道回主进程，emit cli-ask
 *      让渲染层挂起、cli_ask_answer 回填（tools/ask-bridge.ts），claude-cli 的 MCP 往返原地等答案。
 */
import { activeMcpServers, getConfig, isMcpEnabled, type AppConfig } from './config'
import { CONTEXT_SUMMARY_HEADING, CONTEXT_SUMMARY_PREFIX, MEMORY_BLOCK_PREFIX, SESSION_SUMMARY_HEADING } from '../../shared/prompt-contract'
import type { MemoryOrigin } from '../../shared/ipc-types'
import { isCliAgentMode } from '../../shared/ai-mode'
import { mainLog } from './log-file'
import { testApiConnection } from './ai-api'
import {
  cliCancel,
  extractSkillIds,
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
import { isHostRoutedTool, openHostToolProxy, type HostToolProxyEndpoint } from './mcp/proxy'
import { parseMcpToolName } from './mcp/server'
import { executeTool, isDeferredTool, toolsForPermission } from './tools'
import { cancelAsksOf, registerCliAsk } from './tools/ask-bridge'
import { ensureExternalTools, externalPoolStatus } from './mcp/external'
import type { ContentPart, Message, ModelProvider, Tool, ToolPermission, ToolResult, Usage } from './model/types'
import { randomUUID } from 'node:crypto'

/** 补全结果 / 工具调用载荷（唯一定义在 shared/ipc-types，此处再导出供主进程消费） */
import type { AiCompletion, AiToolCall } from '../../shared/ipc-types'
export type { AiCompletion}
// ---------- 执行参数 ----------

/** CLI 通道上下文预算（token，4 字符/token 折算）：超预算走 runner 的「窗口 + 摘要（失败降级纯切片）」，
 *  不静默掐头留尾。API 通道不设预算（全量透传，模型上下文由所选模型自己兜，超限报错可见）。 */
const CLI_CONTEXT_TOKENS = 40_000

/** 外部 MCP 握手预算（ms）：超预算带现有工具面先开流，不许最慢的 server 拖住整个对话开流 */
const MCP_CONNECT_BUDGET_MS = 8_000

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
  cliCommand?: string, codexCommand?: string,
): Promise<string> {
  if (dispatchMode === 'claude-cli') return testCliConnection(cliCommand)
  if (dispatchMode === 'codex-cli') return testCliConnection(codexCommand, 'codex')
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
   *  contextSummary=早期对话压缩摘要；systemPrompt=覆盖系统提示（蒸馏类单轮调用用）。 */
  opts?: { sessionSummary?: string | null; memoryBlock?: string | null; contextSummary?: string | null; systemPrompt?: string },
): Promise<AiCompletion> {
  const cfg = await getConfig().catch(() => null)
  const permission: ToolPermission = cfg?.aiCliPermission === 'readonly' ? 'readonly' : 'exec'
  // 「要不要工具」是调用方的意图（纯补全类调用传空）；工具实现一律出自 ToolRegistry
  const wantTools = Array.isArray(tools) ? tools.length > 0 : Boolean(tools)
  const controller = new AbortController()
  inflight.set(requestId, controller)
  if (windowId != null) registerRequestWindow(requestId, windowId)

  // 工具调用来源（记忆写入打标）：用户明说「记住」类意图 → user_explicit（终身保护契约）；
  // 否则 agent_suggest。蒸馏档由 memory/agent 自带 distill，不走这里
  const toolOrigin: MemoryOrigin = inferToolOrigin(messages)

  // 工具名 → askUserQuestion 判别：claude 侧经 MCP 调用时带 mcp__qyris-tools__ 前缀
  const isAskToolCall = (name: string): boolean => name === 'askUserQuestion' || parseMcpToolName(name) === 'askUserQuestion'
  // 交互提问对应的工具卡 id（claude tool_use）：tool-progress 建卡时捕获，cli-ask 事件带它回渲染层对卡
  let pendingAskCallId: string | null = null

  // 编排工具（dispatch_subtasks）的事件出口挂在本 run 上，CLI 通道只能经 MCP 调工具——
  // 拉起主进程代行通道让 MCP 子进程把编排调用送回本进程执行（见 mcp/proxy.ts）
  let hostProxy: HostToolProxyEndpoint | null = null

  // 外部 MCP 工具：两档都接入。连接池按工程分域（幂等）——API 档 runner 直调；
  // CLI 档经 hostProxy 代行回来执行（mcp-server 子进程每次补全新拉起，不能在那边建连）。
  // 单 server 失败只丢该 server 工具，不阻断对话；握手另设预算，不许最慢的 server 拖住开流
  // ——超预算带现有工具面先开流，晚到的 server 下一轮自然进面
  if (wantTools) {
    await Promise.race([
      ensureExternalTools(projectRoot),
      new Promise<void>((resolve) => setTimeout(resolve, MCP_CONNECT_BUDGET_MS)),
    ])
  }

  // provider 句柄留到 finally 释放（try 块内别名 modelProvider 供正文使用）
  let providerHandle: ModelProvider | null = null
  try {
    // 代行通道在 try 内建：executor 闭包要引用下方 try 块内的 emit（cli-ask 事件出口）
    if (isCliAgentMode(dispatchMode) && wantTools) {
      hostProxy = await openHostToolProxy((name, input) => {
        // 交互提问：主进程挂起等渲染层回填（tools/ask-bridge.ts），MCP 往返原地等答案；
        // 不走 executeTool——ask.ts 的 execute 是延迟语义的响亮报错哨兵
        if (isAskToolCall(name)) {
          const askId = randomUUID()
          const rec = (input ?? {}) as { question?: unknown; options?: unknown }
          const question = typeof rec.question === 'string' && rec.question.trim() ? rec.question : '请回答'
          const options = Array.isArray(rec.options)
            ? rec.options.map((o) => String(o)).filter((s) => s.length > 0)
            : null
          return new Promise<ToolResult>((resolve) => {
            // settle 统一出口：注销挂起登记 + 摘除 abort 监听（正常回答路径不留孤儿监听）
            const onAbort = (): void => settle({ content: '已取消', isError: true })
            const settle = (r: ToolResult): void => {
              controller.signal.removeEventListener('abort', onAbort)
              unregister()
              resolve(r)
            }
            const unregister = registerCliAsk(askId, requestId, settle)
            if (controller.signal.aborted) {
              onAbort()
              return
            }
            controller.signal.addEventListener('abort', onAbort, { once: true })
            emit('cli-ask', {
              requestId,
              callId: pendingAskCallId,
              askId,
              question,
              options: options && options.length > 0 ? options : null,
            })
          })
        }
        return executeTool(name, input, { projectRoot, signal: controller.signal, permission, origin: toolOrigin })
      })
    }
    providerHandle = await resolveChatProvider({
      dispatchMode, provider, baseUrl, model, projectRoot, cfg, permission, wantTools, hostProxy, toolOrigin,
    })
    const modelProvider = providerHandle
    // 提示词工具面 = 通道实际可达面（与 MCP 暴露面 / runner 执行面同源，不许提示词多说一个字）
    // isHostRoutedTool（HOST_ONLY ∪ 外部 mcp__*）在 CLI 档依赖代行通道，通道缺席就不进面；
    // askUserQuestion 已入 HOST_ONLY（交互回填走代行桥），同样随通道门控——有通道即进面
    const surfaceTools = wantTools
      ? toolsForPermission(permission, projectRoot).filter(
          (t) =>
            dispatchMode !== 'claude-cli' ||
            (hostProxy != null || (!isDeferredTool(t.name) && !isHostRoutedTool(t.name))),
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
          // 交互提问：记下工具卡 id，cli-ask 事件按它让渲染层把 AskUserCard 置为可交互
          if (isAskToolCall(e.name)) pendingAskCallId = e.id
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
      tools: wantTools ? toolsForPermission(permission, projectRoot) : [],
      store,
      permission,
      maxTurns: cfg?.aiMaxTurns ?? null,
      ...(isCliAgentMode(dispatchMode) ? { maxContextTokens: CLI_CONTEXT_TOKENS } : {}),
      signal: controller.signal,
      projectRoot,
      toolOrigin,
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
    const cmds = extractStartCommands(rawText)
    let reasoning = reasoningParts.join('')
    const notes: string[] = []
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
      // 原样透传（含可选 url：AI 编译的预览地址，渲染层会读）
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
    // run 收尾：仍未被回答的交互提问按取消结案（渲染层已关闭时防 MCP 往返永久悬挂）
    cancelAsksOf(requestId)
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
      'askUserQuestion 的实际调用名是 mcp__qyris-tools__askUserQuestion（经 MCP 代行通道）：需要用户做选择或补充信息时优先调用它，不要在正文里文字提问。' +
      '上表是唯一可用清单：不在上表的工具名（含历史提示里的其他旧名）一律不可用，不要请求。',
    '声明工具调用时只用本通道原生的工具调用通道（工具协议说明会随请求注入）；不要在正文里写围栏块/自创标签/裸 JSON 冒充调用——正文里的调用语法不会被执行。',
  ]
  // 交互型工具被通道裁掉时（如无代行通道的窄面场景）必须给出替代行为，
  // 否则渲染层人格还在教它「调用 askUserQuestion」——又一个提示词越权的坑
  // （CLI 档有代行通道时 askUserQuestion 在面上，不走此分支，由 ask-bridge 回填）
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

/** 工具调用来源推断（v1 启发式）：本轮用户话语含「记住」类显式意图 → user_explicit（记忆终身保护
 *  契约的触发点）；否则 agent_suggest（agent 主动沉淀）。打标在执行侧，模型不可自填。 */
function inferToolOrigin(messages: unknown): MemoryOrigin {
  const arr = Array.isArray(messages) ? messages : []
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i] as { role?: unknown; content?: unknown } | null
    if (m && m.role === 'user' && typeof m.content === 'string') {
      return /记住|记一下|别忘了|帮我记|存下来|remember/i.test(m.content) ? 'user_explicit' : 'agent_suggest'
    }
  }
  return 'agent_suggest'
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
    // Skill 内联（历史引用的全文）+ 可用索引（统一教 load_skill 工具，本轮生效——
    // API 档原生 tool-call、CLI 档经 MCP 工具面，两档都可达）。
    // 引用提取看**全量 wire**（含本轮 user）：skillInstruction.ts 的加载指令是拼在用户消息上的，
    // 只扫 history 会漏掉「本轮刚触发的 Skill」——那正是最需要内联的一次
    const skillDirs = collectSkillDirs(projectRoot, cfg)
    const referenced = extractSkillIds(wire)
    // 只内联历史引用的 skill 全文；可用索引不再在此注入——渲染层 system 清单已带
    // （含触发词，信息更全），双份索引曾把 system 撑到 11 万字
    const skillBlock = await resolveSkillBlock(skillDirs, referenced)
    if (skillBlock) parts.push(skillBlock)
    // 外部 MCP 现状兜底：本域配了启用 server 但工具面暂无 mcp__ 工具时，按连接池真实状态
    // 分两态说明——「知晓」不冒充「可用」，不编造工具（可达面原则不破）
    {
      const mcpCfg = activeMcpServers(cfg, projectRoot)
      const names = Object.keys(mcpCfg).filter((n) => isMcpEnabled(mcpCfg[n]))
      if (names.length > 0 && !surfaceTools.some((t) => t.name.startsWith('mcp__'))) {
        const st = externalPoolStatus(projectRoot)
        if (st.connecting) {
          parts.push(
            `【外部 MCP 现状】本工程配置了 ${names.length} 个 MCP server（${names.join('、')}），` +
            '连接正在建立中，当前工具面暂无其工具。用户要用它们时，如实说明并建议稍后重试（连接完成后的下一轮即可用）。',
          )
        } else if (Object.keys(st.errors).length > 0) {
          const detail = Object.entries(st.errors)
            .map(([n, e]) => `- ${n}：${e}`)
            .join('\n')
          parts.push(
            `【外部 MCP 现状】本工程配置了 ${names.length} 个 MCP server，但当前均未连接成功：\n${detail}\n` +
            '用户要用它们时，如实说明失败原因，不要尝试调用不存在的工具；用户修复配置或恢复 server 后再试。',
          )
        } else {
          parts.push(
            `【外部 MCP 现状】本工程配置了 ${names.length} 个 MCP server（${names.join('、')}），` +
            '当前工具面暂无其工具。用户要用它们时，如实说明现状并可稍后重试。',
          )
        }
      }
    }
    if (systemTexts.length > 0) {
      parts.push(...systemTexts)
    } else {
      // CLI 记忆反哺契约：调用方把摘要/记忆放在 opts 里（CLI 路径丢 system），这里补进正文头
      const head = [
        opts?.sessionSummary ? `${SESSION_SUMMARY_HEADING}\n${opts.sessionSummary}` : '',
        opts?.memoryBlock ?? '',
        opts?.contextSummary ? `${CONTEXT_SUMMARY_HEADING}\n${opts.contextSummary}` : '',
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
    [SESSION_SUMMARY_HEADING]: opts?.sessionSummary,
    [CONTEXT_SUMMARY_PREFIX]: opts?.contextSummary,
    [MEMORY_BLOCK_PREFIX]: opts?.memoryBlock,
  }
  const leakBlocks = Object.keys(expected).filter((m) => system.includes(m) && !expected[m])
  if (history.length > 6 || leakBlocks.length > 0) {
    mainLog.info(
      `[seed] 泄漏诊断：history=${history.length}条 system=${system.length}字 命中=${leakBlocks.join('/') || '无'}（正常清空后不出现此行）`,
    )
  }
  return input
}
