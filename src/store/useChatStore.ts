/**
 * 对话状态 + Agent 工具循环。
 *
 * 流程：send → 主进程流式补全（ai-delta 事件打字机）→ 返回 AiCompletion
 *   ├─ 无 tool_calls → 结束
 *   └─ 有 tool_calls → 逐个执行（askUserQuestion 会暂停等用户点击卡片）
 *        → 结果回填 history → 再次请求（轮数不设限，「停止生成」兜底）
 *
 * 取消：cancel() 通知主进程 abort 当前 SSE 请求（fetch 层网络硬中断），
 * aiChatStream 随即以「已取消」reject，循环按取消路径收尾。
 *
 * 多工程常驻：状态按工程（projectPath）隔离。切到别的工程时，本工程的流式循环照常跑，
 * ai-delta/ai-reasoning/cli-tool-event 事件按 requestId → 工程路由回对应切片，切回即最新。
 */
import { create } from 'zustand'
import { api } from '@/services/desktop'
import { buildSystemPrompt, TOOL_DEFS } from '@/services/ai'
import { executeTool } from '@/services/tools'
import { useAppStore } from './useAppStore'
import { uid, safeParseObject } from '@/utils/id'
import { estimateTokens } from '@/utils/tokens'
import type {
  AiCompletion, ChatMessage, OAIMessage, ToolCall,
} from '@/types'

export type ChatStatus = 'idle' | 'streaming' | 'tools' | 'awaiting-user' | 'error' | 'retrying'

export interface PendingAsk {
  id: string
  question: string
  options: string[] | null
}

/** 预览页选取的元素（带到下轮对话的上下文） */
export interface PickedElement {
  selector: string
  tag: string
  id: string
  text: string
}

/** 单个工程的对话切片 */
export interface ChatSlice {
  messages: ChatMessage[]
  status: ChatStatus
  activeRequestId: string | null
  pendingAsk: PendingAsk | null
  /** askId → 用户选择（卡片回显已答状态） */
  answers: Record<string, string>
  cancelled: boolean
  /** 会话代次：清空对话时 +1，用于让在途的旧循环丢弃过期写入 */
  epoch: number
  /** 预览页选中的元素（发送下一条消息时附带进上下文） */
  pendingElement: PickedElement | null
  /** token 用量：input=最近一次 prompt 大小；output=累计生成；agents=子 agent 累计（汇总展示） */
  usage: { input: number; output: number; agents?: { input: number; output: number } }
  /** 当前对话会话 id：AI 写文件的快照按会话分组，重置对话时换新 */
  sessionId: string
  /** CLI 模式：上一轮模型为下一轮指定的模型（null=用主模型；白名单校验后写入） */
  cliModel: string | null
  /** CLI 模式：模型请求下一轮附带的 Skill id（按已扫描索引校验后写入） */
  cliSkills: string[]
}

function emptyChatSlice(): ChatSlice {
  return {
    messages: [],
    status: 'idle',
    activeRequestId: null,
    pendingAsk: null,
    answers: {},
    cancelled: false,
    epoch: 0,
    pendingElement: null,
    usage: { input: 0, output: 0 },
    sessionId: uid(),
    cliModel: null,
    cliSkills: [],
  }
}

interface ChatState {
  /** 当前工程（useAppStore.projectPath 的镜像） */
  current: string | null
  byProject: Record<string, ChatSlice>

  send: (text: string, meta?: import('@/types').MessageMeta) => Promise<void>
  setPendingElement: (el: PickedElement | null) => void
  appendDelta: (requestId: string, delta: string) => void
  appendReasoning: (requestId: string, delta: string) => void
  handleCliToolEvent: (requestId: string, id: string, name: string, phase: 'start' | 'stop', argumentsStr: string) => void
  answerAsk: (answer: string) => void
  cancelProject: (project: string) => void
  cancel: () => void
  clear: () => void
  editAndResend: (messageId: string, newContent: string, meta?: import('@/types').MessageMeta) => Promise<void>
  restore: (messages: ChatMessage[]) => void
  ensureProject: (path: string) => void
  closeProject: (path: string) => void
}

/** 读某工程的切片 */
function getSlice(project: string): ChatSlice | undefined {
  return useChatStore.getState().byProject[project]
}

/** 写某工程的切片（函数式，不可变更新） */
export function patchSlice(project: string, patch: Partial<ChatSlice>): void {
  useChatStore.setState((s) => {
    const cur = s.byProject[project]
    if (!cur) return s
    return { byProject: { ...s.byProject, [project]: { ...cur, ...patch } } }
  })
}

/** 按 requestId 反查工程（事件只带 requestId，据此路由回发起请求的工程切片） */
function findProjectByRequest(requestId: string): string | undefined {
  const s = useChatStore.getState()
  for (const [project, slice] of Object.entries(s.byProject)) {
    if (slice.activeRequestId === requestId) return project
  }
  return undefined
}

export const useChatStore = create<ChatState>()((set, get) => ({
  current: null,
  byProject: {},

  ensureProject: (path) => {
    set((s) => ({
      byProject: s.byProject[path] ? s.byProject : { ...s.byProject, [path]: emptyChatSlice() },
      current: path,
    }))
  },

  closeProject: (path) => {
    set((s) => {
      const byProject = { ...s.byProject }
      delete byProject[path]
      return { byProject, current: s.current === path ? null : s.current }
    })
  },

  send: async (text, meta) => {
    const project = get().current
    if (!project) return
    const cur = getSlice(project)
    if (!cur || (cur.status !== 'idle' && cur.status !== 'error')) return
    const trimmed = text.trim()
    if (!trimmed) return
    const el = cur.pendingElement
    const content = el
      ? `[已选中预览元素]\n选择器: ${el.selector}\n标签: ${el.tag}${el.id ? `\nID: ${el.id}` : ''}${el.text ? `\n文本: ${el.text}` : ''}\n\n${trimmed}`
      : trimmed
    const userMsg: ChatMessage = { id: uid(), role: 'user', content, meta }
    patchSlice(project, { messages: [...cur.messages, userMsg], status: 'streaming', cancelled: false, pendingElement: null })
    await runAgentLoop(project)
  },

  setPendingElement: (el) => {
    const project = get().current
    if (project) patchSlice(project, { pendingElement: el })
  },

  appendDelta: (requestId, delta) => {
    const project = findProjectByRequest(requestId)
    if (!project) return
    const s = getSlice(project)
    if (!s || s.cancelled) return
    const msgs = [...s.messages]
    const last = msgs[msgs.length - 1] as ChatMessage | undefined
    const kind = assistantTailKind(last)
    if (kind === 'draft') {
      msgs[msgs.length - 1] = { ...last!, content: last!.content + delta }
    } else {
      if (!delta.trim()) return
      if (kind === 'thinking') {
        msgs[msgs.length - 1] = { ...last!, content: delta, pending: true }
      } else {
        msgs.push({ id: uid(), role: 'assistant', content: delta, pending: true })
      }
    }
    patchSlice(project, {
      messages: msgs,
      usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
    })
  },

  appendReasoning: (requestId, delta) => {
    const project = findProjectByRequest(requestId)
    if (!project) return
    const s = getSlice(project)
    if (!s || s.cancelled) return
    const msgs = [...s.messages]
    const last = msgs[msgs.length - 1] as ChatMessage | undefined
    const kind = assistantTailKind(last)
    if (kind === 'thinking' || kind === 'draft') {
      msgs[msgs.length - 1] = { ...last!, reasoning: (last!.reasoning ?? '') + delta }
    } else {
      if (!delta.trim()) return
      const collapsed = msgs.map((m) => (m.role === 'assistant' && m.pending ? { ...m, pending: false } : m))
      collapsed.push({ id: uid(), role: 'assistant', content: '', reasoning: delta })
      patchSlice(project, {
        messages: collapsed,
        usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
      })
      return
    }
    patchSlice(project, {
      messages: msgs,
      usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
    })
  },

  handleCliToolEvent: (requestId, id, name, phase, argumentsStr) => {
    const project = findProjectByRequest(requestId)
    if (!project) return
    useChatStore.setState((s) => {
      const cur = s.byProject[project]
      if (!cur || cur.cancelled) return s
      let messages: ChatMessage[]
      if (phase === 'start') {
        const tc: ToolCall = { id, name, args: safeParseObject(argumentsStr), status: 'running' }
        messages = [...cur.messages, { id: uid(), role: 'assistant', content: '', toolCalls: [tc] }]
      } else {
        messages = [...cur.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          const tcs = messages[i].toolCalls
          if (tcs?.some((tc) => tc.id === id)) {
            messages[i] = { ...messages[i], toolCalls: tcs.map((tc) => tc.id === id ? { ...tc, status: 'done' as const, args: safeParseObject(argumentsStr) } : tc) }
            break
          }
        }
      }
      return { byProject: { ...s.byProject, [project]: { ...cur, messages } } }
    })
  },

  answerAsk: (answer) => {
    const project = get().current
    if (!project) return
    const s = getSlice(project)
    if (!s || !s.pendingAsk) return
    const askId = s.pendingAsk.id
    patchSlice(project, {
      answers: { ...s.answers, [askId]: answer },
      pendingAsk: null,
      status: 'tools',
    })
    askResolvers.get(project)?.(answer)
    askResolvers.delete(project)
  },

  cancelProject: (project) => {
    const cur = getSlice(project)
    if (!cur) return
    patchSlice(project, { cancelled: true })
    // 硬取消：通知主进程 abort 该请求的流（网络层中断，不再消耗响应）
    if (cur.status === 'streaming' && cur.activeRequestId) {
      void api.aiCancel(cur.activeRequestId).catch(() => {})
    }
    // 子 agent 在途请求 + 在途一次性命令硬中断
    void import('@/services/subagent')
      .then((m) => m.cancelActiveAgentRequests())
      .catch(() => {})
    void api.runOnceCancel().catch(() => {})
    // 若正卡在 askUserQuestion，解除挂起
    const s = getSlice(project)
    if (s && s.status === 'awaiting-user' && s.pendingAsk) {
      const askId = s.pendingAsk.id
      patchSlice(project, {
        answers: { ...s.answers, [askId]: '（已取消）' },
        pendingAsk: null,
        status: 'tools',
      })
      askResolvers.get(project)?.('（用户取消了本次提问）')
      askResolvers.delete(project)
    }
  },

  cancel: () => {
    const project = get().current
    if (project) get().cancelProject(project)
  },

  clear: () => {
    const project = get().current
    if (!project) return
    const cur = getSlice(project)
    if (!cur) return
    if (cur.status !== 'idle') get().cancel()
    patchSlice(project, {
      messages: [], status: 'idle', pendingAsk: null, activeRequestId: null,
      answers: {}, pendingElement: null, usage: { input: 0, output: 0 }, sessionId: uid(), cliModel: null, cliSkills: [], epoch: cur.epoch + 1,
    })
  },

  editAndResend: async (messageId, newContent, meta) => {
    const project = get().current
    if (!project) return
    const cur = getSlice(project)
    if (!cur || (cur.status !== 'idle' && cur.status !== 'error')) return
    const trimmed = newContent.trim()
    if (!trimmed) return
    const idx = cur.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    const finalMeta = meta ?? cur.messages[idx].meta
    const messages = [
      ...cur.messages.slice(0, idx),
      { ...cur.messages[idx], content: trimmed, meta: finalMeta },
    ]
    patchSlice(project, {
      messages,
      status: 'streaming',
      cancelled: false,
      pendingAsk: null,
      activeRequestId: null,
      answers: {},
      cliModel: null,
      cliSkills: [],
      epoch: cur.epoch + 1,
    })
    await runAgentLoop(project)
  },

  restore: (messages) => {
    const project = get().current
    if (!project) return
    patchSlice(project, {
      messages,
      status: 'idle',
      pendingAsk: null,
      activeRequestId: null,
      cancelled: false,
      pendingElement: null,
      usage: { input: 0, output: 0 },
      cliModel: null,
      cliSkills: [],
    })
  },
}))

// ---------- Agent 循环 ----------

/** 稳定空切片，选择器兜底 */
const EMPTY_CHAT: ChatSlice = emptyChatSlice()

/** 取当前工程的对话切片（组件选择器用，返回稳定引用） */
export function selectCurrentChat(s: ChatState): ChatSlice {
  return (s.current && s.byProject[s.current]) || EMPTY_CHAT
}

/** 可重试的错误：网络类；业务类错误（鉴权、参数）不重试 */
function isRetryableError(msg: string): boolean {
  return /无法连接|连接中断|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|econnreset|fetch failed|网络|超时/i.test(msg)
}

/** 分片 sleep：每 500ms 检查一次取消，返回 true 表示被「停止」中断 */
function sleepInterruptible(project: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const step = 500
    let elapsed = 0
    const tick = (): void => {
      if (getSlice(project)?.cancelled) {
        resolve(true)
        return
      }
      elapsed += step
      if (elapsed >= ms) resolve(false)
      else setTimeout(tick, step)
    }
    setTimeout(tick, step)
  })
}

/** project → ask 的挂起 resolver（多工程并存时各自独立） */
const askResolvers = new Map<string, (v: string) => void>()

async function runAgentLoop(project: string) {
  const epoch = getSlice(project)?.epoch ?? 0
  const messages = getSlice(project)?.messages ?? []
  const history = buildHistory(messages)

  // CLI 模式：把上一轮模型请求附带的 Skill 以标记注入本轮首条 user 历史
  const slice0 = getSlice(project)
  if (useAppStore.getState().settings.dispatchMode === 'claude-cli' && slice0 && slice0.cliSkills.length > 0) {
    const pending = slice0.cliSkills
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user') {
        history[i] = { ...history[i], content: `${history[i].content ?? ''}\n[附带 Skill：${pending.join(', ')}]` }
        break
      }
    }
  }

  // 工具调用不设轮数上限：由「停止生成」取消（cancelled 每轮检查）兜底
  for (;;) {
    if (getSlice(project)?.cancelled) {
      finalizeDraft(project, '（已取消）', false, epoch)
      patchSlice(project, { status: 'idle', activeRequestId: null })
      return
    }
    let inputTok = 0
    for (const m of history) {
      if (typeof m.content === 'string') inputTok += estimateTokens(m.content)
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) inputTok += estimateTokens(tc.function.arguments ?? '')
      }
    }
    patchSlice(project, { usage: { input: inputTok, output: getSlice(project)?.usage.output ?? 0 } })

    let completion: AiCompletion
    let attempt = 0
    for (;;) {
      if (getSlice(project)?.cancelled) {
        finalizeDraft(project, '（已取消）', false, epoch)
        patchSlice(project, { status: 'idle', activeRequestId: null })
        return
      }
      const requestId = uid()
      patchSlice(project, { status: 'streaming', activeRequestId: requestId })
      try {
        const { settings, skillMetas } = useAppStore.getState()
        const payload: OAIMessage[] = [
          { role: 'system', content: buildSystemPrompt(project, skillMetas) },
          ...history,
        ]
        const prevCliModel = getSlice(project)?.cliModel
        const requestModel =
          settings.dispatchMode === 'claude-cli' && prevCliModel && cliAllowedModels(settings).has(prevCliModel)
            ? prevCliModel
            : settings.model
        completion = await api.aiChatStream(
          requestId, settings.provider, settings.baseUrl, requestModel, payload, TOOL_DEFS,
          settings.dispatchMode, project,
        )
        break
      } catch (e) {
        const msg = String(e)
        if (getSlice(project)?.cancelled) {
          finalizeDraft(project, '（已取消）', false, epoch)
          patchSlice(project, { status: 'idle', activeRequestId: null })
          return
        }
        if (!isRetryableError(msg) || attempt >= 10) {
          finalizeDraft(project, msg, true, epoch)
          patchSlice(project, { status: 'error', activeRequestId: null })
          return
        }
        attempt++
        patchSlice(project, { status: 'retrying', activeRequestId: null })
        const interrupted = await sleepInterruptible(project, 15000)
        if (interrupted || getSlice(project)?.cancelled) {
          finalizeDraft(project, '（已取消）', false, epoch)
          patchSlice(project, { status: 'idle', activeRequestId: null })
          return
        }
      }
    }

    const assistantId = finalizeAssistant(project, completion, epoch)
    history.push(toHistoryEntry(completion))

    if (useAppStore.getState().settings.dispatchMode === 'claude-cli') {
      const s2 = useAppStore.getState().settings
      const allowed = cliAllowedModels(s2)
      const pick = completion.nextModel?.trim()
      const next = pick && allowed.has(pick) ? pick : null
      const knownSkills = new Set(useAppStore.getState().skillMetas.map((m) => m.id))
      const skillReq = (completion.nextSkill ?? []).map((s) => s.trim()).filter((s) => s && knownSkills.has(s))
      const cmds = (completion.startCommands ?? [])
        .map((s) => ({ name: String(s?.name ?? '').trim(), run: String(s?.run ?? '').trim() }))
        .filter((s) => s.name && s.run)
      const lastUserMeta = [...(getSlice(project)?.messages ?? [])].reverse().find((m) => m.role === 'user')?.meta
      if (cmds.length > 0 && lastUserMeta?.projectStart) {
        void useAppStore.getState().setStartupCommands(cmds, project)
      }
      if (getSlice(project)?.epoch === epoch) patchSlice(project, { cliModel: next, cliSkills: skillReq })
    }

    if (completion.toolCalls.length === 0) {
      patchSlice(project, { status: 'idle', activeRequestId: null })
      return
    }

    patchSlice(project, { status: 'tools' })
    for (const tc of completion.toolCalls) {
      patchToolCard(project, tc.id, { status: 'running' }, epoch)
      let result: string
      let summary: string
      try {
        const args = safeParseObject(tc.arguments)
        if (tc.name === 'askUserQuestion') {
          const answer = await askUser(project, tc.id, String(args.question ?? '请回答'), parseOptions(args.options))
          result = `用户回答：${answer}`
          summary = answer
        } else {
          const out = await executeTool(tc.name, args, tc.id, project)
          result = out.result
          summary = out.summary
        }
      } catch (e) {
        result = `工具执行失败：${String(e)}`
        summary = '执行失败'
      }
      const ok = !result.startsWith('错误') && !result.startsWith('工具执行失败')
      patchToolCard(project, tc.id, {
        status: ok ? 'done' : 'error',
        resultSummary: summary,
        result: result.length > 2000 ? result.slice(0, 2000) + '…' : result,
      }, epoch)
      appendToolResult(project, assistantId, { toolCallId: tc.id, content: result }, epoch)
      history.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
  }
}

// ---------- 组装 OpenAI 历史 ----------

function cliAllowedModels(settings: import('@/types').AiSettings): Set<string> {
  return new Set(
    [settings.model, ...Object.values(settings.tiers ?? {})]
      .filter((v): v is string => typeof v === 'string' && !!v.trim())
      .map((v) => v.trim()),
  )
}

function buildHistory(messages: ChatMessage[]): OAIMessage[] {
  const out: OAIMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      let content = m.content
      if (m.meta?.skills?.length && !content.includes('load_skill')) {
        const ids = m.meta.skills.map((s) => s.id).join(', ')
        const instr = m.meta.skills.length > 1
          ? `请先用 load_skill 依次加载以下 ${m.meta.skills.length} 个 Skill，全部加载后再执行：${ids}`
          : `请先用 load_skill 加载 Skill「${ids}」，再执行。`
        content = content ? `${instr}\n\n${content}` : instr
      }
      out.push({ role: 'user', content })
      continue
    }
    if (m.pending) continue
    if (m.toolCalls?.length) {
      const results = m.toolResults ?? []
      if (results.length >= m.toolCalls.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((t) => ({
            id: t.id,
            type: 'function' as const,
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          })),
        })
        for (const tr of results) {
          out.push({ role: 'tool', tool_call_id: tr.toolCallId, content: tr.content })
        }
      } else {
        const lines = m.toolCalls.map((t) => {
          const tr = results.find((r) => r.toolCallId === t.id)
          return `- ${t.name}：${tr ? tr.content.slice(0, 200) : t.status === 'done' ? '（已执行）' : '（未执行，被中断）'}`
        })
        const text = [m.content, '（此前调用过工具，结果如下：）', ...lines].filter(Boolean).join('\n')
        out.push({ role: 'assistant', content: text })
      }
    } else if (m.content) {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}

function toHistoryEntry(c: AiCompletion): OAIMessage {
  return {
    role: 'assistant',
    content: c.content ?? null,
    tool_calls: c.toolCalls.length
      ? c.toolCalls.map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: t.arguments },
        }))
      : undefined,
  }
}

// ---------- 消息收尾辅助 ----------

function assistantTailKind(m: ChatMessage | undefined): 'draft' | 'thinking' | 'none' {
  if (!m || m.role !== 'assistant' || (m.toolCalls?.length ?? 0) > 0) return 'none'
  if (m.pending) return 'draft'
  return (m.reasoning ?? '') !== '' ? 'thinking' : 'none'
}

function stripStreamedPrefix(msgs: ChatMessage[], pendingIdx: number, content: string): string {
  let prefix = ''
  for (let i = pendingIdx - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'assistant') break
    if (m.toolCalls?.length || !m.content) continue
    prefix = m.content + prefix
  }
  return prefix && content.startsWith(prefix) ? content.slice(prefix.length) : content
}

function collapseStreamingMessages(
  msgs: ChatMessage[], toolStatus: 'done' | 'error', exceptId?: string,
): ChatMessage[] {
  let changed = false
  const out = msgs.map((m) => {
    if (m.role !== 'assistant') return m
    const sweepTools = m.id !== exceptId && (m.toolCalls?.some((tc) => tc.status === 'running') ?? false)
    if (!m.pending && !sweepTools) return m
    changed = true
    return {
      ...m,
      pending: false,
      toolCalls: sweepTools
        ? m.toolCalls!.map((tc) => tc.status === 'running'
            ? {
                ...tc,
                status: toolStatus,
                ...(toolStatus === 'error' && !tc.resultSummary ? { resultSummary: '已中断' } : {}),
              }
            : tc)
        : m.toolCalls,
    }
  })
  return changed ? out : msgs
}

function finalizeDraft(project: string, text: string, isError: boolean, epoch: number) {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return
  const msgs = [...s.messages]
  let pendingIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].pending) { pendingIdx = i; break }
  }
  if (pendingIdx !== -1) {
    msgs[pendingIdx] = { ...msgs[pendingIdx], content: text || msgs[pendingIdx].content || '（无内容）', pending: false, error: isError }
  } else if (text) {
    msgs.push({ id: uid(), role: 'assistant', content: text, error: isError })
  }
  const collapsed = collapseStreamingMessages(msgs, 'error')
  if (pendingIdx !== -1 || text || collapsed !== msgs) {
    patchSlice(project, { messages: collapsed })
  }
}

function finalizeAssistant(project: string, completion: AiCompletion, epoch: number): string {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return ''

  const toolCalls: ToolCall[] = completion.toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    args: safeParseObject(tc.arguments),
    status: 'running',
  }))

  let pendingIdx = -1
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === 'assistant' && s.messages[i].pending) { pendingIdx = i; break }
  }
  const draftOpen = pendingIdx !== -1
  const last = draftOpen ? s.messages[pendingIdx] : s.messages[s.messages.length - 1]

  let content = completion.content ?? ''
  if (draftOpen) content = stripStreamedPrefix(s.messages, pendingIdx, content)
  if (!content.trim() && !toolCalls.length) {
    content = (draftOpen ? last.content.trim() : '') || '（模型未返回内容）'
  }

  const reasoning = draftOpen ? (last.reasoning ?? undefined) : undefined

  if (draftOpen) {
    const updated: ChatMessage = { ...last, content, pending: false, toolCalls: [...(last.toolCalls ?? []), ...toolCalls] }
    const msgs = [...s.messages]
    msgs[pendingIdx] = updated
    patchSlice(project, { messages: collapseStreamingMessages(msgs, 'done', updated.id) })
    return updated.id
  }
  const msg: ChatMessage = { id: uid(), role: 'assistant', content, pending: false, toolCalls }
  if (reasoning) msg.reasoning = reasoning
  patchSlice(project, { messages: collapseStreamingMessages([...s.messages, msg], 'done', msg.id) })
  return msg.id
}

function patchToolCard(project: string, toolCallId: string, patch: Partial<ToolCall>, epoch: number) {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return
  patchSlice(project, {
    messages: s.messages.map((m) =>
      m.toolCalls?.some((t) => t.id === toolCallId)
        ? { ...m, toolCalls: m.toolCalls!.map((t) => (t.id === toolCallId ? { ...t, ...patch } : t)) }
        : m,
    ),
  })
}

function appendToolResult(project: string, messageId: string, entry: { toolCallId: string; content: string }, epoch: number) {
  const s = getSlice(project)
  if (!s || s.epoch !== epoch) return
  patchSlice(project, {
    messages: s.messages.map((m) =>
      m.id === messageId ? { ...m, toolResults: [...(m.toolResults ?? []), entry] } : m,
    ),
  })
}

// ---------- askUserQuestion ----------

function askUser(project: string, toolCallId: string, question: string, options: string[] | null): Promise<string> {
  return new Promise<string>((resolve) => {
    patchSlice(project, {
      status: 'awaiting-user',
      pendingAsk: { id: toolCallId, question, options },
    })
    askResolvers.set(project, resolve)
  })
}

function parseOptions(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const list = v.map(String).filter((s) => s.length > 0)
  return list.length ? list : null
}
