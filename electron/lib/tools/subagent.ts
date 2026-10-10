/**
 * 产品工具（子 agent 域）：dispatch_subtasks —— 派发子任务给独立上下文的子 agent 执行。
 *
 * 实现在主进程：每个子任务一个独立 ConversationStore + runAgent（工具集 = 全量减
 * askUserQuestion/dispatch_subtasks，禁止嵌套派发与子任务内提问），事件按渲染层
 * AgentPanel 的既有形状下发（不改渲染层）：
 *   · cli-tool-event  { id: 子任务卡 id, name: 'Agent', phase: 'start', arguments: {description, subagent_type} }
 *       → handleCliToolEvent 建线程（threads.cardId = 子任务卡 id）+ 聊天区派发卡
 *   · cli-agent-event { parentId: 子任务卡 id, kind: 'text' | 'tool' | 'tool-result', … }
 *       → 转录入卡（handleCliAgentEvent 按 cardId 找线程）
 *   · cli-tool-result { id: 子任务卡 id, content, isError, tokens }
 *       → 线程收口 + 派发卡收口（同步完成语义，不走 async 派发确认）
 *
 * 为什么「每个子任务一张派发卡」而不是「一张总卡 + parentId 指向它」：
 *   handleCliAgentEvent 找线程是 `threads.find(t => t.cardId === p.parentId)`（首个命中），
 *   渲染层 createBatch 又是 N 个线程共用一个 cardId——总卡方案会把 N 路转录全串进第一条线程。
 *   一卡一线程是唯一能精确路由的形状（CLI 路径的 Agent/Task 就是这个形状）。
 *
 * 子 agent 的模型来源：config（aiDispatchMode / aiBaseUrl / aiModel / aiProvider / aiTiers）
 * ——与 memory/agent.resolveModelProvider 同口径；档位模型取 aiTiers[tier]，缺省回退主模型。
 */
import { getConfig, type AppConfig } from '../config'
import { resolveChatProvider } from '../model/provider-resolve'
import { ConversationStore } from '../model/store'
import { runAgent, type RunnerEvent } from '../model/runner'
import { getAgentRunContext } from '../model/run-context'
import { errorMessage } from '../util'
import type { ContentPart, Message, ModelProvider, Tool, ToolCtx, Usage } from '../model/types'

// ---------- 入参校验 ----------

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('工具入参必须是 JSON 对象')
  }
  return input as Record<string, unknown>
}

// ---------- 常量（与渲染层 services/tools.ts 的 dispatch_subtasks 展示口径对齐） ----------

const TIERS: readonly string[] = ['main', 'thinking', 'fast', 'middle', 'heavy']
/** 单条子任务结果进主上下文的截断上限（全文留在 agent 线程可查） */
const RESULT_CAP = 1500
/** cli-agent-event 单条文本上限（ai-cli 的 CLI_EVENT_TEXT_CAP 同值） */
const EVENT_TEXT_CAP = 4000
/** 单条工具参数展示上限（write_file 的 arguments 可能含整文件） */
const TOOL_ARG_CAP = 300
/** 子 agent 单任务工具循环轮数缺省：设置 aiSubagentMaxTurns 可调（子任务聚焦语义，缺省保守） */
const SUBAGENT_MAX_TURNS = 20

function clip(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + '…' : s
}

function normTier(v: unknown): string {
  const t = typeof v === 'string' && v.trim() ? v.trim() : 'main'
  return TIERS.includes(t) ? t : 'main'
}

// ---------- 模型来源（config 驱动，同 memory/agent.resolveModelProvider 口径） ----------

/** 档位 → 模型名：未配置的档位回退主模型 */
function tierModel(tiers: Record<string, string | undefined> | undefined, tier: string): string | null {
  if (tier === 'main') return null
  const m = tiers?.[tier]
  return m && m.trim() ? m.trim() : null
}

/**
 * 子 agent 的 ModelProvider 与主对话同一构造（model/provider-resolve）：子 agent 只是
 * 独立 session（自己的 ConversationStore / 工具面 / 事件出口），不是另一种模型通道。
 * 自建降级通道（CLI 纯补全形态）会让系统提示承诺的工具在通道里不存在——模型一调用就
 * error_max_turns（线上实测形态）。CLI 档同样挂 MCP（真工具 + 完整 agentic loop），
 * 仅剔除 dispatch_subtasks 防嵌套派发；代行通道复用本次 run 的，主进程单例工具照常可用。
 */
async function resolveSubProvider(tier: string, ctx: ToolCtx): Promise<{ provider: ModelProvider; cfg: AppConfig }> {
  const cfg = await getConfig()
  const provider = await resolveChatProvider({
    dispatchMode: cfg.aiDispatchMode ?? 'api',
    provider: cfg.aiProvider ?? 'openai',
    baseUrl: cfg.aiBaseUrl ?? '',
    model: tierModel(cfg.aiTiers, tier) ?? cfg.aiModel ?? '',
    projectRoot: ctx.projectRoot,
    cfg,
    permission: ctx.permission,
    wantTools: true,
    hostProxy: getAgentRunContext(ctx)?.hostProxy ?? null,
    excludeTools: ['dispatch_subtasks'],
    // 子 agent 轮界独立于主对话：CLI 落为 --max-turns，API 落为 runner 轮界
    maxTurns: cfg.aiSubagentMaxTurns ?? SUBAGENT_MAX_TURNS,
  })
  return { provider, cfg }
}

// ---------- 子 agent 提示词（对齐渲染层 subagentSystemPrompt 的职责边界） ----------

function subAgentSystemPrompt(projectRoot: string | null, toolNames: string): string {
  return [
    '你是「轻驭」工作台的子任务执行 agent，在独立上下文中完成主 agent 派发的单个任务。',
    '',
    '# 执行纪律',
    `- 你拥有以下项目工具：${toolNames}。优先用专用工具而不是 shell 命令（读文件用 read_file，检索文件用 search_files/glob，检索内容用 grep）。`,
    '- 修改文件前必须先 read_file 获取真实内容，禁止凭空臆造。',
    '- 只做派发的任务本身：不顺手重构、不添加任务外的内容；认为派发本身有误时如实说明，不要自行扩大范围。',
    '- 失败时先读报错原文、换本质不同的打法；不要盲目重试同一条命令，也不要一次失败就放弃。',
    '- 不要派发子任务、不要向用户提问——无法完成时在最终回复中说明原因与已尝试的步骤。',
    '- 用简体中文；代码、命令、标识符保持原样。过程简洁直接，不写客套话。',
    '',
    '# 工作目录',
    projectRoot
      ? `当前项目目录：${projectRoot}。工具的 path/dir 参数传项目内相对路径。`
      : '当前未打开项目，仅能做与文件无关的分析。',
    '',
    '# 交付要求',
    '最终回复必须给出：做了什么、关键结果/文件路径、遗留风险；没验证的明说没验证。这段总结会回传给主 agent。',
  ].join('\n')
}

// ---------- 子任务执行 ----------

interface SubTask {
  title: string
  instruction: string
  tier: string
}

interface SubTaskOutcome {
  title: string
  status: 'done' | 'error' | 'cancelled'
  text: string
  model: string
  usage: Usage
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function textOfMessage(m: Message): string {
  return m.content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

async function runOne(task: SubTask, cardId: string, ctx: ToolCtx): Promise<SubTaskOutcome> {
  const runCtx = getAgentRunContext(ctx)
  const emit = (event: string, payload: Record<string, unknown>): void => {
    runCtx?.emit(event, payload)
  }
  const usage = zeroUsage()
  let modelLabel = task.tier

  const fail = (status: 'error' | 'cancelled', text: string): SubTaskOutcome => {
    emit('cli-tool-result', {
      requestId: runCtx?.requestId ?? '', id: cardId, content: text, isError: status === 'error',
    })
    return { title: task.title, status, text, model: modelLabel, usage }
  }

  let provider: ModelProvider
  let cfg: AppConfig
  try {
    ;({ provider, cfg } = await resolveSubProvider(task.tier, ctx))
    modelLabel = (provider as { id?: string }).id === 'claude-cli' ? 'claude-cli' : task.tier
  } catch (e) {
    return fail('error', `子任务启动失败（模型解析）：${errorMessage(e)}`)
  }

  // 动态 import：本模块被 tools/index 静态引入，回查全量工具表会成静态环（同 services/tools.ts 的处理）
  const { toolsForPermission } = await import('./index')
  const tools = toolsForPermission(ctx.permission).filter(
    (t) => t.name !== 'askUserQuestion' && t.name !== 'dispatch_subtasks',
  )
  const store = new ConversationStore({ provider: provider.id })
  store.append({
    role: 'system',
    content: [{ type: 'text', text: subAgentSystemPrompt(ctx.projectRoot, tools.map((t) => t.name).join(' / ')) }],
    meta: { ts: Date.now() },
  })

  // 文本按轮攒批（逐 delta 发会把 Agent 面板打成几百条 entry），工具边界/收尾时冲刷
  let textBuf = ''
  // 已建条目的工具调用 id（selfContained 的 tool-executed 与 tool-start 可能不配对，防重复建条）
  const startedTools = new Set<string>()
  const flushText = (): void => {
    const t = textBuf.trim()
    textBuf = ''
    if (!t) return
    emit('cli-agent-event', {
      requestId: runCtx?.requestId ?? '', parentId: cardId, kind: 'text', text: clip(t, EVENT_TEXT_CAP),
    })
  }

  try {
    const finalMsg = await runAgent(task.instruction, {
      provider,
      tools,
      store,
      permission: ctx.permission,
      maxTurns: cfg.aiSubagentMaxTurns ?? SUBAGENT_MAX_TURNS,
      signal: ctx.signal,
      projectRoot: ctx.projectRoot,
      onEvent: (e: RunnerEvent) => {
        switch (e.type) {
          case 'text-delta':
            textBuf += e.text
            break
          case 'tool-start': {
            flushText()
            startedTools.add(e.id)
            const args = typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? {})
            emit('cli-agent-event', {
              requestId: runCtx?.requestId ?? '', parentId: cardId, kind: 'tool',
              id: e.id, name: e.name, arguments: clip(args, TOOL_ARG_CAP),
            })
            break
          }
          case 'tool-progress': {
            // MCP 自持循环（executesOwnTools）：工具发起帧 = 转录里的工具条目起点
            flushText()
            startedTools.add(e.id)
            const args = typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? {})
            emit('cli-agent-event', {
              requestId: runCtx?.requestId ?? '', parentId: cardId, kind: 'tool',
              id: e.id, name: e.name, arguments: clip(args, TOOL_ARG_CAP),
            })
            break
          }
          case 'tool-executed': {
            // MCP 自持循环：执行完一帧收口（发起帧缺失时补建条目，patchTool 按 id 对账）
            flushText()
            if (!startedTools.has(e.id)) {
              startedTools.add(e.id)
              const args = typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? {})
              emit('cli-agent-event', {
                requestId: runCtx?.requestId ?? '', parentId: cardId, kind: 'tool',
                id: e.id, name: e.name, arguments: clip(args, TOOL_ARG_CAP),
              })
            }
            emit('cli-agent-event', {
              requestId: runCtx?.requestId ?? '', parentId: cardId, kind: 'tool-result',
              id: e.id, content: clip(e.result.content, EVENT_TEXT_CAP), isError: e.result.isError === true,
            })
            break
          }
          case 'tool-end':
            emit('cli-agent-event', {
              requestId: runCtx?.requestId ?? '', parentId: cardId, kind: 'tool-result',
              id: e.id, content: clip(e.result.content, EVENT_TEXT_CAP), isError: e.result.isError === true,
            })
            break
          case 'turn-end':
            usage.inputTokens += e.usage.inputTokens || 0
            usage.outputTokens += e.usage.outputTokens || 0
            usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (e.usage.cacheReadTokens || 0)
            usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (e.usage.cacheWriteTokens || 0)
            break
          default:
            break
        }
      },
    })
    flushText()
    const text = textOfMessage(finalMsg).trim() || '（子任务完成，无文本返回）'
    emit('cli-tool-result', {
      requestId: runCtx?.requestId ?? '', id: cardId, content: clip(text, EVENT_TEXT_CAP), isError: false,
      tokens: { input: usage.inputTokens, output: usage.outputTokens },
    })
    return { title: task.title, status: 'done', text, model: modelLabel, usage }
  } catch (e) {
    flushText()
    if (ctx.signal?.aborted) return fail('cancelled', '（已取消）')
    return fail('error', `子任务执行失败：${errorMessage(e)}`)
  } finally {
    void provider.dispose?.()
  }
}

// ---------- 工具本体 ----------

const dispatchSubtasks: Tool = {
  name: 'dispatch_subtasks',
  description:
    '将拆分好的子任务派发给独立子 agent 并行执行。每个子任务拥有独立上下文与相同的项目工具；' +
    '按 tier 选择档位模型：fast=轻量快速、middle=常规修改、heavy=最重、thinking=深度推理、main=主模型' +
    '（未配置的档位回退主模型）。子任务间并行执行，必须相互独立——不要派发会写同一文件或相互依赖执行顺序的任务。' +
    '适合边界清晰、可独立描述的子任务；琐碎小事不要派发。',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: '子任务列表（按执行顺序）',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '子任务标题（简短）' },
            instruction: { type: 'string', description: '给子 agent 的完整指令：目标、涉及文件/约束、期望产出' },
            tier: {
              type: 'string',
              description: '模型档位，默认 main',
              enum: ['main', 'thinking', 'fast', 'middle', 'heavy'],
            },
          },
          required: ['title', 'instruction'],
        },
      },
    },
    required: ['tasks'],
  },
  permission: 'exec',
  async execute(input, ctx) {
    const rec = asRecord(input)
    const arr = rec.tasks
    if (!Array.isArray(arr)) throw new Error('参数 tasks 必须是数组')
    const tasks: SubTask[] = (arr as Record<string, unknown>[])
      .map((t) => ({
        title: String(t?.title ?? '').trim(),
        instruction: String(t?.instruction ?? '').trim(),
        tier: normTier(t?.tier),
      }))
      .filter((t) => t.title && t.instruction)
    if (tasks.length === 0) {
      return {
        content: '[dispatch_subtasks] tasks 不能为空，每项需包含 title（标题）与 instruction（完整指令）。',
        isError: true,
      }
    }

    const runCtx = getAgentRunContext(ctx)
    // 建卡：每任务一张派发卡（name='Agent'），渲染层按 cardId 建线程（见文件头注释）
    const cardIds = tasks.map((_, i) => `subtask-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 8)}`)
    tasks.forEach((t, i) => {
      const args = JSON.stringify({ description: t.title, subagent_type: t.tier })
      runCtx?.emit('cli-tool-event', {
        requestId: runCtx.requestId, id: cardIds[i], name: 'Agent', phase: 'start', arguments: args,
      })
      runCtx?.emit('cli-tool-event', {
        requestId: runCtx.requestId, id: cardIds[i], name: 'Agent', phase: 'stop', arguments: args,
      })
    })

    // 并行执行（每个子 agent 自己的工具批串行；run_command 类在 proc 层按工程排队）
    const outcomes = await Promise.all(tasks.map((t, i) => runOne(t, cardIds[i], ctx)))

    const total = outcomes.reduce(
      (acc, o) => ({ input: acc.input + o.usage.inputTokens, output: acc.output + o.usage.outputTokens }),
      { input: 0, output: 0 },
    )
    const body = outcomes
      .map((o, i) => {
        const text = o.text.length > RESULT_CAP
          ? `${o.text.slice(0, RESULT_CAP)}\n…（已截断，全文见对应 agent 视图）`
          : o.text
        const tag = o.status === 'done' ? '完成' : o.status === 'cancelled' ? '已取消' : '异常'
        return `## 子任务 ${i + 1}：${o.title} [${tag}]（模型：${o.model}）\n${text}`
      })
      .join('\n\n')
    const anyError = outcomes.some((o) => o.status !== 'done')
    return {
      content:
        `[dispatch_subtasks] 共 ${outcomes.length} 个子任务已执行（完整过程与结果全文存于各 agent 线程，` +
        `可在对话面板切换查看；子 agent 合计消耗 输入 ${total.input} / 输出 ${total.output} tokens）。\n结果摘要：\n\n${body}`,
      isError: anyError,
    }
  },
}

/** 子 agent 工具集 */
export const subagentTools: Tool[] = [dispatchSubtasks]
