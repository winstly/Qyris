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

interface ChatState {
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
  /** CLI 模式：模型请求下一轮附带的 Skill id（按已扫描索引校验后写入；发送时以 [附带 Skill：…] 标记注入历史） */
  cliSkills: string[]

  send: (text: string, meta?: import('@/types').MessageMeta) => Promise<void>
  setPendingElement: (el: PickedElement | null) => void
  appendDelta: (requestId: string, delta: string) => void
  appendReasoning: (requestId: string, delta: string) => void
  handleCliToolEvent: (requestId: string, id: string, name: string, phase: 'start' | 'stop', argumentsStr: string) => void
  answerAsk: (answer: string) => void
  cancel: () => void
  clear: () => void
  /** 编辑某条用户消息并重发：截断其后所有内容，重新跑 Agent 循环 */
  editAndResend: (messageId: string, newContent: string, meta?: import('@/types').MessageMeta) => Promise<void>
  /** 恢复历史会话（打开项目时从磁盘加载） */
  restore: (messages: ChatMessage[]) => void
}

export const useChatStore = create<ChatState>()((set, get) => ({
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

  send: async (text, meta) => {
    const { status } = get()
    if (status !== 'idle' && status !== 'error') return
    const trimmed = text.trim()
    if (!trimmed) return
    const el = get().pendingElement
    const content = el
      ? `[已选中预览元素]\n选择器: ${el.selector}\n标签: ${el.tag}${el.id ? `\nID: ${el.id}` : ''}${el.text ? `\n文本: ${el.text}` : ''}\n\n${trimmed}`
      : trimmed
    const userMsg: ChatMessage = { id: uid(), role: 'user', content, meta }
    set((s) => ({ messages: [...s.messages, userMsg], status: 'streaming', cancelled: false, pendingElement: null }))
    await runAgentLoop()
  },

  appendDelta: (requestId, delta) => {
    const s = get()
    if (s.cancelled || requestId !== s.activeRequestId) return
    const msgs = [...s.messages]
    const last = msgs[msgs.length - 1] as ChatMessage | undefined
    const kind = assistantTailKind(last)
    if (kind === 'draft') {
      // 追加到已有 pending 消息（正文阶段，光标已出现）
      msgs[msgs.length - 1] = { ...last!, content: last!.content + delta }
    } else {
      // 纯空白增量不建气泡（避免模型开头输出空行产生空白气泡）
      if (!delta.trim()) return
      if (kind === 'thinking') {
        // 正文开始：落在思考块所在消息上并转为 pending（光标此时出现）
        msgs[msgs.length - 1] = { ...last!, content: delta, pending: true }
      } else {
        msgs.push({ id: uid(), role: 'assistant', content: delta, pending: true })
      }
    }
    set({
      messages: msgs,
      usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
    })
  },

  appendReasoning: (requestId, delta) => {
    const s = get()
    if (s.cancelled || requestId !== s.activeRequestId) return
    const msgs = [...s.messages]
    const last = msgs[msgs.length - 1] as ChatMessage | undefined
    const kind = assistantTailKind(last)
    if (kind === 'thinking' || kind === 'draft') {
      // 思考增量挂到当前 assistant 消息（纯思考块或正文草稿皆可）
      msgs[msgs.length - 1] = { ...last!, reasoning: (last!.reasoning ?? '') + delta }
    } else {
      // 新思考阶段：先收口残留的 pending 正文（CLI 多消息块场景），再新建思考块。
      // 只关 pending，不动在途工具卡状态——CLI 心跳在本进程也会走这里，若在此把
      // running 卡打成 done，长命令执行中卡片会中途假完成（终态由 stop 事件/收尾兜底负责）
      if (!delta.trim()) return
      const collapsed = msgs.map((m) => (m.role === 'assistant' && m.pending ? { ...m, pending: false } : m))
      collapsed.push({ id: uid(), role: 'assistant', content: '', reasoning: delta })
      set({
        messages: collapsed,
        usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
      })
      return
    }
    set({
      messages: msgs,
      usage: { ...s.usage, output: s.usage.output + estimateTokens(delta) },
    })
  },

  handleCliToolEvent: (requestId, id, name, phase, argumentsStr) => {
    // 用函数式 set 基于最新状态更新（避免 get() 快照被 finalizeAssistant 覆盖）
    set((s) => {
      if (s.cancelled || requestId !== s.activeRequestId) return s
      if (phase === 'start') {
        const tc: ToolCall = { id, name, args: safeParseObject(argumentsStr), status: 'running' }
        return { messages: [...s.messages, { id: uid(), role: 'assistant', content: '', toolCalls: [tc] }] }
      }
      // phase === 'stop'：找到对应工具卡片，更新为 done
      const msgs = [...s.messages]
      for (let i = msgs.length - 1; i >= 0; i--) {
        const tcs = msgs[i].toolCalls
        if (tcs?.some((tc) => tc.id === id)) {
          msgs[i] = { ...msgs[i], toolCalls: tcs.map((tc) => tc.id === id ? { ...tc, status: 'done' as const, args: safeParseObject(argumentsStr) } : tc) }
          break
        }
      }
      return { messages: msgs }
    })
  },

  answerAsk: (answer) => {
    const s = get()
    if (!s.pendingAsk) return
    const askId = s.pendingAsk.id
    set((s2) => ({
      answers: { ...s2.answers, [askId]: answer },
      pendingAsk: null,
      status: 'tools',
    }))
    askResolver?.(answer)
    askResolver = null
  },

  cancel: () => {
    set({ cancelled: true })
    // 硬取消：通知主进程 abort 当前流式请求（网络层中断，不再消耗响应）
    const cur = get()
    if (cur.status === 'streaming' && cur.activeRequestId) {
      void api.aiCancel(cur.activeRequestId).catch(() => {})
    }
    // 子 agent 的在途模型请求一并取消（dispatch_subtasks 执行期间主状态是 tools，上面那条够不到）
    void import('@/services/subagent')
      .then((m) => m.cancelActiveAgentRequests())
      .catch(() => {})
    // 在途一次性命令（run_once）硬中断：命令挂死时「停止生成」要能立即杀掉进程树，
    // runOnce 的 Promise 随进程退出收口，循环在下一检查点按取消路径退出
    void api.runOnceCancel().catch(() => {})
    // 若正卡在 askUserQuestion，解除挂起让循环走到下一轮的取消检查
    const s = get()
    if (s.status === 'awaiting-user' && s.pendingAsk) {
      const askId = s.pendingAsk.id
      set((s2) => ({
        answers: { ...s2.answers, [askId]: '（已取消）' },
        pendingAsk: null,
        status: 'tools',
      }))
      askResolver?.('（用户取消了本次提问）')
      askResolver = null
    }
  },

  clear: () => {
    // 若正在运行：先触发取消（cancelled 置 true + 硬中断主进程请求，让在途循环在下一检查点退出）；
    // 不在此复位 cancelled——运行中清空需保留 true 以终止旧循环，idle 时它本就是 false（下次 send 会重置）
    if (get().status !== 'idle') get().cancel()
    set((s) => ({
      messages: [], status: 'idle', pendingAsk: null, activeRequestId: null,
      answers: {}, pendingElement: null, usage: { input: 0, output: 0 }, sessionId: uid(), cliModel: null, cliSkills: [], epoch: s.epoch + 1,
    }))
  },

  setPendingElement: (el) => set({ pendingElement: el }),

  editAndResend: async (messageId, newContent, meta) => {
    const s = get()
    if (s.status !== 'idle' && s.status !== 'error') return
    const trimmed = newContent.trim()
    if (!trimmed) return
    const idx = s.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    // 截断到该消息（更新内容），丢弃其后所有对话；epoch 自增让旧循环过期
    // 使用新 meta（如有），否则保留原 meta，让 buildHistory 能重建系统指令
    const finalMeta = meta ?? s.messages[idx].meta
    const messages = [
      ...s.messages.slice(0, idx),
      { ...s.messages[idx], content: trimmed, meta: finalMeta },
    ]
    set({
      messages,
      status: 'streaming',
      cancelled: false,
      pendingAsk: null,
      activeRequestId: null,
      answers: {},
      cliModel: null, // 历史分叉：模型上轮的选模/选 Skill 依据已失效，回退主模型重新决策
      cliSkills: [],
      epoch: s.epoch + 1,
    })
    await runAgentLoop()
  },

  restore: (messages) =>
    set({
      messages,
      status: 'idle',
      pendingAsk: null,
      activeRequestId: null,
      cancelled: false,
      pendingElement: null,
      usage: { input: 0, output: 0 },
      cliModel: null,
      cliSkills: [],
    }),
}))

// ---------- Agent 循环 ----------

/** 可重试的错误：网络类（连接不通/中断/超时/DNS 等）；业务类错误（鉴权、参数）不重试 */
function isRetryableError(msg: string): boolean {
  return /无法连接|连接中断|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|econnreset|fetch failed|网络|超时/i.test(msg)
}

/** 分片 sleep：每 500ms 检查一次取消，返回 true 表示被「停止」中断 */
function sleepInterruptible(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const step = 500
    let elapsed = 0
    const tick = (): void => {
      if (useChatStore.getState().cancelled) {
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

let askResolver: ((v: string) => void) | null = null

async function runAgentLoop() {
  const store = useChatStore
  const epoch = store.getState().epoch
  const { messages } = store.getState()
  const history = buildHistory(messages)

  // CLI 模式：把上一轮模型请求附带的 Skill 以标记注入本轮首条 user 历史（adapter 从历史提取并内联全文）
  if (useAppStore.getState().settings.dispatchMode === 'claude-cli' && store.getState().cliSkills.length > 0) {
    const pending = store.getState().cliSkills
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user') {
        history[i] = { ...history[i], content: `${history[i].content ?? ''}\n[附带 Skill：${pending.join(', ')}]` }
        break
      }
    }
  }

  // 工具调用不设轮数上限（用户拍板）：由「停止生成」取消（cancelled 每轮检查）兜底
  for (;;) {
    // 已取消：不再发起下一轮请求
    if (store.getState().cancelled) {
      finalizeDraft('（已取消）', false, epoch)
      store.setState({ status: 'idle', activeRequestId: null })
      return
    }
    // 估算本轮输入 token（当前上下文的文本量）
    let inputTok = 0
    for (const m of history) {
      if (typeof m.content === 'string') inputTok += estimateTokens(m.content)
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) inputTok += estimateTokens(tc.function.arguments ?? '')
      }
    }
    store.setState((s) => ({ usage: { input: inputTok, output: s.usage.output } }))
    // 请求 + 失败重试：可重试错误（网络类）每 15s 重试一次，最多 10 次；全程可被「停止」打断
    let completion: AiCompletion
    let attempt = 0
    for (;;) {
      if (store.getState().cancelled) {
        finalizeDraft('（已取消）', false, epoch)
        store.setState({ status: 'idle', activeRequestId: null })
        return
      }
      const requestId = uid()
      store.setState({ status: 'streaming', activeRequestId: requestId })
      try {
        const { settings, projectPath, skillMetas } = useAppStore.getState()
        const payload: OAIMessage[] = [
          { role: 'system', content: buildSystemPrompt(projectPath, skillMetas) },
          ...history,
        ]
        // CLI 模式逐轮选模：首轮/未指定用主模型，之后用上一轮模型指定的模型。
        // 采用时再过一次白名单：设置里的主模型/档位可能在 cliModel 写入后被用户改掉
        const prevCliModel = store.getState().cliModel
        const requestModel =
          settings.dispatchMode === 'claude-cli' && prevCliModel && cliAllowedModels(settings).has(prevCliModel)
            ? prevCliModel
            : settings.model
        completion = await api.aiChatStream(
          requestId, settings.provider, settings.baseUrl, requestModel, payload, TOOL_DEFS,
          settings.dispatchMode, projectPath,
        )
        break
      } catch (e) {
        const msg = String(e)
        // 用户取消 → 不重试、不进异常态
        if (store.getState().cancelled) {
          finalizeDraft('（已取消）', false, epoch)
          store.setState({ status: 'idle', activeRequestId: null })
          return
        }
        // 不可重试错误 或 重试次数用尽 → 异常态
        if (!isRetryableError(msg) || attempt >= 10) {
          finalizeDraft(msg, true, epoch)
          store.setState({ status: 'error', activeRequestId: null })
          return
        }
        attempt++
        store.setState({ status: 'retrying', activeRequestId: null })
        const interrupted = await sleepInterruptible(15000)
        if (interrupted || store.getState().cancelled) {
          finalizeDraft('（已取消）', false, epoch)
          store.setState({ status: 'idle', activeRequestId: null })
          return
        }
      }
    }

    const assistantId = finalizeAssistant(completion, epoch)
    history.push(toHistoryEntry(completion))

    // CLI 模式：白名单校验模型指定的下一轮模型（只认主模型+已配档位，胡说就回退主模型）；
    // Skill 请求只认已扫描到的 id
    if (useAppStore.getState().settings.dispatchMode === 'claude-cli') {
      const s2 = useAppStore.getState().settings
      const allowed = cliAllowedModels(s2)
      const pick = completion.nextModel?.trim()
      const next = pick && allowed.has(pick) ? pick : null
      const knownSkills = new Set(useAppStore.getState().skillMetas.map((m) => m.id))
      const skillReq = (completion.nextSkill ?? []).map((s) => s.trim()).filter((s) => s && knownSkills.has(s))
      // AI 编译场景：CLI 以 [[START_COMMANDS]] 提交的启动命令清单 → 落盘存档（同 report_start_commands 语义）。
      // 仅认本轮确为 AI 编译任务（末条 user 消息带 projectStart 标记）：该协议行在每轮系统提示都有教学，
      // 普通对话里模型回显示例行时不能覆盖已验证的启动命令存档
      const cmds = (completion.startCommands ?? [])
        .map((s) => ({ name: String(s?.name ?? '').trim(), run: String(s?.run ?? '').trim() }))
        .filter((s) => s.name && s.run)
      const lastUserMeta = [...store.getState().messages].reverse().find((m) => m.role === 'user')?.meta
      if (cmds.length > 0 && lastUserMeta?.projectStart && useAppStore.getState().projectPath) {
        void useAppStore.getState().setStartupCommands(cmds)
      }
      if (useChatStore.getState().epoch === epoch) store.setState({ cliModel: next, cliSkills: skillReq })
    }

    if (completion.toolCalls.length === 0) {
      store.setState({ status: 'idle', activeRequestId: null })
      return
    }

    // 逐个执行工具，结果回填到 assistant 消息与 history
    store.setState({ status: 'tools' })
    for (const tc of completion.toolCalls) {
      patchToolCard(tc.id, { status: 'running' }, epoch)
      let result: string
      let summary: string
      try {
        const args = safeParseObject(tc.arguments)
        if (tc.name === 'askUserQuestion') {
          const answer = await askUser(tc.id, String(args.question ?? '请回答'), parseOptions(args.options))
          result = `用户回答：${answer}`
          summary = answer
        } else {
          const out = await executeTool(tc.name, args, tc.id)
          result = out.result
          summary = out.summary
        }
      } catch (e) {
        result = `工具执行失败：${String(e)}`
        summary = '执行失败'
      }
      const ok = !result.startsWith('错误') && !result.startsWith('工具执行失败')
      patchToolCard(tc.id, {
        status: ok ? 'done' : 'error',
        resultSummary: summary,
        result: result.length > 2000 ? result.slice(0, 2000) + '…' : result,
      }, epoch)
      appendToolResult(assistantId, { toolCallId: tc.id, content: result }, epoch)
      history.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
  }
}

// ---------- 组装 OpenAI 历史 ----------

/** CLI 模式候选模型白名单：主模型 + 已配档位（trim 后非空）。写入与采用两处共用同一规则 */
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
      // 有 meta 时，确保系统指令存在（编辑重发可能只保留了用户文字）
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
    if (m.pending) continue // 流式中的半成品不进历史
    if (m.toolCalls?.length) {
      const results = m.toolResults ?? []
      // 协议要求 assistant.tool_calls 与 tool 结果一一配对：只有全部调用都有结果才走结构化路径。
      // CLI 工具卡（executeTool 不参与，永远没有结果）与中途中断的残留没有完整配对，
      // 降级为文本痕迹，避免切回 API 模式后每轮请求都 400
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
          // CLI 工具卡永远没有 toolResults（executeTool 不参与），但卡片状态 done 代表 CLI 已真实执行——
          // 如实标注「已执行」，否则下一轮历史会告诉 CLI 它成功的命令「未执行」，诱导重跑装依赖/写文件
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

/** 末条 assistant 消息的形态分类：决定流式增量落到哪。
 *  工具卡消息不算草稿也不算思考（增量另起新消息）；pending=true 是正文草稿；
 *  pending 为假但有 reasoning 是纯思考块（思考先于正文到达的场景） */
function assistantTailKind(m: ChatMessage | undefined): 'draft' | 'thinking' | 'none' {
  if (!m || m.role !== 'assistant' || (m.toolCalls?.length ?? 0) > 0) return 'none'
  if (m.pending) return 'draft'
  return (m.reasoning ?? '') !== '' ? 'thinking' : 'none'
}

/** CLI 多块流式去重：result 缺席时 adapter 回退的全文累积（content）会包含此前分段
 *  已在独立气泡展示过的正文；把最后 pending 分段之前、同一轮内连续 assistant 文本分段
 *  拼成前缀，权威全文以其开头则剥去，避免同一段文字渲染两遍 */
function stripStreamedPrefix(msgs: ChatMessage[], pendingIdx: number, content: string): string {
  let prefix = ''
  for (let i = pendingIdx - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'assistant') break // 到本轮 user 消息为止
    if (m.toolCalls?.length || !m.content) continue // 工具卡/纯思考分段不产生正文
    prefix = m.content + prefix // 倒序遍历前置入 → 保时序拼接
  }
  return prefix && content.startsWith(prefix) ? content.slice(prefix.length) : content
}

/** 收口所有残留的流式 assistant 消息：关闭 pending 正文，并把在途工具卡打到终态
 *  （CLI 中断 / stop 事件丢失时的兜底，避免永久打字机光标与永久 running spinner）。
 *  exceptId 的消息不处理工具卡（finalize 刚挂上的 HTTP 工具卡要留给执行循环打状态）。
 *  无可改动的消息时原数组返回，便于调用方跳过 setState */
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

/** 关闭流式草稿：错误 / 取消时以给定文本收尾。
 *  CLI 多消息块场景可能残留多条 pending / 在途工具卡，除最后一条 pending 外全部强制收口 */
function finalizeDraft(text: string, isError: boolean, epoch: number) {
  const s = useChatStore.getState()
  if (s.epoch !== epoch) return // 会话已清空/换代：丢弃过期写入
  const msgs = [...s.messages]
  // 找最后一条 pending 正文消息（不是工具消息），以给定文本收尾
  let pendingIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].pending) { pendingIdx = i; break }
  }
  if (pendingIdx !== -1) {
    msgs[pendingIdx] = { ...msgs[pendingIdx], content: text || msgs[pendingIdx].content || '（无内容）', pending: false, error: isError }
  } else if (text) {
    msgs.push({ id: uid(), role: 'assistant', content: text, error: isError })
  }
  // 其余残留 pending / 在途工具卡统一收口
  const collapsed = collapseStreamingMessages(msgs, 'error')
  if (pendingIdx !== -1 || text || collapsed !== msgs) {
    useChatStore.setState({ messages: collapsed })
  }
}

/** 补全返回后定稿：回填权威内容并挂上工具调用卡片，返回消息 id。
 *  返回的 id 必须是携带 toolCalls 的那条消息——工具结果按它回填（appendToolResult），
 *  buildHistory 也要求 tool_calls 与 tool 结果挂在同一条消息上配对，拆开会丢历史（协议 400） */
function finalizeAssistant(completion: AiCompletion, epoch: number): string {
  const s = useChatStore.getState()
  if (s.epoch !== epoch) return '' // 会话已清空/换代：丢弃过期写入

  // CLI 模式 adapter 恒回 toolCalls:[]（工具卡已由 cli-tool-event 实时写入独立消息），
  // 因此无需按传输方式分叉，直接采用 completion.toolCalls 即不会重复建卡
  const toolCalls: ToolCall[] = completion.toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    args: safeParseObject(tc.arguments),
    status: 'running',
  }))

  // 找到 pending 的正文消息（CLI 多消息块场景下不一定是最后一条）
  let pendingIdx = -1
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === 'assistant' && s.messages[i].pending) { pendingIdx = i; break }
  }
  const draftOpen = pendingIdx !== -1
  const last = draftOpen ? s.messages[pendingIdx] : s.messages[s.messages.length - 1]

  let content = completion.content ?? ''
  // CLI 多块流式：权威全文可能包含此前分段已展示过的正文，剥前缀防重复渲染
  if (draftOpen) content = stripStreamedPrefix(s.messages, pendingIdx, content)
  // 纯空白内容按空处理：无工具卡片时显示占位文案，避免定稿出空白气泡
  if (!content.trim() && !toolCalls.length) {
    content = (draftOpen ? last.content.trim() : '') || '（模型未返回内容）'
  }

  const reasoning = draftOpen ? (last.reasoning ?? undefined) : undefined

  if (draftOpen) {
    // 更新 pending 的正文消息（content + reasoning，不覆盖已有 toolCalls）
    const updated: ChatMessage = { ...last, content, pending: false, toolCalls: [...(last.toolCalls ?? []), ...toolCalls] }
    const msgs = [...s.messages]
    msgs[pendingIdx] = updated
    // 收口其余残留的流式消息（CLI 多消息块场景）；刚定稿消息上的 HTTP 工具卡留给执行循环
    useChatStore.setState({ messages: collapseStreamingMessages(msgs, 'done', updated.id) })
    return updated.id
  }
  // 无草稿（纯 tool_calls 轮）：工具卡与正文同条消息，保证结果回填与历史配对都落在一条上
  const msg: ChatMessage = { id: uid(), role: 'assistant', content, pending: false, toolCalls }
  if (reasoning) msg.reasoning = reasoning
  useChatStore.setState({ messages: collapseStreamingMessages([...s.messages, msg], 'done', msg.id) })
  return msg.id
}

function patchToolCard(toolCallId: string, patch: Partial<ToolCall>, epoch: number) {
  if (useChatStore.getState().epoch !== epoch) return
  useChatStore.setState((s) => ({
    messages: s.messages.map((m) =>
      m.toolCalls?.some((t) => t.id === toolCallId)
        ? { ...m, toolCalls: m.toolCalls!.map((t) => (t.id === toolCallId ? { ...t, ...patch } : t)) }
        : m,
    ),
  }))
}

function appendToolResult(messageId: string, entry: { toolCallId: string; content: string }, epoch: number) {
  if (useChatStore.getState().epoch !== epoch) return
  useChatStore.setState((s) => ({
    messages: s.messages.map((m) =>
      m.id === messageId ? { ...m, toolResults: [...(m.toolResults ?? []), entry] } : m,
    ),
  }))
}

// ---------- askUserQuestion ----------

function askUser(toolCallId: string, question: string, options: string[] | null): Promise<string> {
  return new Promise<string>((resolve) => {
    useChatStore.setState({
      status: 'awaiting-user',
      pendingAsk: { id: toolCallId, question, options },
    })
    askResolver = resolve
  })
}

function parseOptions(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const list = v.map(String).filter((s) => s.length > 0)
  return list.length ? list : null
}
