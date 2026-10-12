/**
 * 上下文压缩 —— 把窗口外的旧消息蒸成摘要，摘要回填 ConversationStore 的摘要槽位。
 *
 * 纯度纪律（为什么 summarize 不自己调 provider）：
 *   补全能力是运行期注入的（complete 回调），本模块因此不 import 任何 provider——
 *   既不把 ai-api / ai-cli 的耦合带进来，也能用假 complete 离线测全链路。
 *   （同 memory/agent.ts 的 setLlmHook 思路：被测模块不选通道，通道由调用方给。）
 *
 * 与渲染层（useChatStore.maybeCompressContext）的对齐口径：
 *   · 同一份转录组装：user/assistant 原文 + 工具压一行，不付工具结果全文 token；
 *   · 同一份失败语义：摘要失败由调用方降级（不写摘要、保留原窗口），本模块不吞错；
 *   · 差异：那边按 sessionId + messageCount 缓存去重，这边只管「给一批消息还一段摘要」。
 *     去重是调用方（runner）的账——window() 是纯视图，同一批 dropped 会被反复交进来，
 *     调用方要像 compressCache 那样按消息数变化判重，否则每次请求都白烧一次摘要调用。
 *
 * 典型用法（runner 侧）：
 *   const { kept, dropped } = store.window(maxTokens, estimateTokens)
 *   if (dropped.length > 0 && needsResummarize) {
 *     applySummary(await summarize(dropped, complete), store)  // 槽位 last-write-wins
 *   }
 *   // kept 已含置顶摘要 system 块，直接当请求消息用，不要再单独注入 store.summary
 */
import type { Message } from './types'
import type { ConversationStore } from './store'

// ---------- token 粗估 ----------

/** 单张图片的粗估 token：各家按分辨率计费，取常见小图的一档常量，误差可接受 */
const IMAGE_TOKEN_GUESS = 1024

/**
 * 消息 token 粗估：字符数 / 4（任务约定的粗估口径）。
 * 已知偏差：中文约 1 字 1 token，按 /4 会偏小 3-4 倍。这里接受偏差——
 * 用途是「窗口装不装得下」的相对判断，不是账单；精度换简单度是划算的。
 * 若要上账单级精度，换 tiktoken 类词表，本函数签名不用动（window 只认 estimate 回调）。
 */
export function estimateTokens(msg: Message): number {
  if (!msg || !Array.isArray(msg.content)) return 0
  // 1 token 垫底：角色/消息结构开销，空消息也不至于算 0 被预算循环误判
  let tokens = 1
  for (const part of msg.content) {
    switch (part.type) {
      case 'text':
        tokens += part.text.length / 4
        break
      case 'image':
        tokens += IMAGE_TOKEN_GUESS // base64 长度与计费无关，按张估算
        break
      case 'toolUse':
        // input 走 JSON 展开计长：嵌套参数（命令行、代码片段）往往是这条消息的大头
        tokens += (part.name.length + JSON.stringify(part.input ?? null).length) / 4
        break
      case 'toolResult':
        tokens += part.content.length / 4
        break
      default:
        // 未知块类型记 0：types.ts 将来加块不该让估算器崩，粗估也不值得为它分支
        break
    }
  }
  return Math.ceil(tokens)
}

// ---------- 摘要 ----------

/** 转录组装的字符上限：压缩输入本身也要省 token */
const TRANSCRIPT_CAP = 20_000

/**
 * 压缩指令。措辞对齐 useChatStore.maybeCompressContext 的 compressSystem——
 * 两层最终产出的是同一种东西（9 节结构化摘要、留事实与待办、去寒暄），口径漂移会让
 * 摘要质量随调用路径漂移。改动需与渲染层同步。
 */
const SUMMARIZE_SYSTEM = [
  '你是上下文压缩器。把下面的对话历史压成结构化摘要，供后续对话在无原文时继续工作。',
  '输出两块：先用 <analysis> 包住梳理草稿（按时间顺序逐段核对：用户明确诉求、你的做法、关键决策与技术概念、文件名、完整代码片段、函数签名、文件改动、报错与修法、用户让你改做法的反馈），再用 <summary> 包住正式摘要。',
  '',
  '<summary> 必须按这 9 节组织，宁全勿缺：',
  '1. 主要请求与意图：用户所有明确诉求与目标（含被修正过的意图）',
  '2. 关键技术概念：涉及的技术、框架、架构决策',
  '3. 文件与代码片段：逐一列出读过/改过的文件，附完整代码片段、函数签名、改动原因（这一节是恢复上下文的命脉，不许省略）',
  '4. 错误与修复：所有报错原文、修法、用户对错误的反馈',
  '5. 问题解决：已解决的问题与仍在排查的问题',
  '6. 全部用户消息：逐条列出用户消息（工具结果除外）',
  '7. 未完成任务：用户明确交代过的待办',
  '8. 当前工作：摘要生成前正在做的事（含最近的文件与代码细节）',
  '9. 下一步：与最近工作直接相关的下一步；附最近对话的原文引用防漂移；若任务已结束则写「无」',
  '',
  '不要保留寒暄、确认性回复、已完成的中间步骤。用简体中文写摘要。',
].join('\n')

/** 压缩输出收口（与渲染层 formatCompactSummary 同一契约）：剥 <analysis> 草稿，取 <summary> 正文；无标签兜底回退原文。 */
function formatCompactSummary(raw: string): string {
  const s = (raw ?? '').trim()
  if (!s) return ''
  const body = s.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]
  if (body && body.trim()) return body.trim()
  return s.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim() || s
}

/**
 * 蒸摘要：把一批旧消息压成一段纯文本。
 * complete 由调用方注入（runner 把 provider 适配成 (messages) => Promise<string>），
 * 本函数只负责组装消息与约定失败语义——不 import 任何 provider（见文件头）。
 *
 * 失败语义：complete 抛错原样上抛，本函数不吞。吞错会把「摘要丢了」伪装成「没有摘要」，
 * 调用方降级路径（保留原窗口、不写槽位）需要真实异常来触发。
 * 空输入（dropped 为空 / 全是无文本内容）直接回 ''，不白烧一次补全。
 */
export async function summarize(
  dropped: readonly Message[],
  complete: (messages: Message[]) => Promise<string>,
): Promise<string> {
  if (dropped.length === 0) return ''
  const transcript = buildTranscript(dropped)
  if (!transcript) return ''
  const request: Message[] = [
    { role: 'system', content: [{ type: 'text', text: SUMMARIZE_SYSTEM }] },
    {
      role: 'user',
      content: [{ type: 'text', text: `请压缩以下对话历史（${dropped.length} 条消息）：\n\n${transcript}` }],
    },
  ]
  const summary = await complete(request)
  return formatCompactSummary(summary ?? '')
}

/**
 * 摘要回填：写进 store 的摘要槽位（不是消息列表——设计理由见 store.setSummary）。
 * 空摘要 = 清空槽位：「没有值得记的」也是结论，last-write-wins，不留旧摘要误导模型。
 */
export function applySummary(summary: string, store: ConversationStore): void {
  store.setSummary(summary)
}

// ---------- 转录组装 ----------

/**
 * 把消息摊成给摘要器看的转录。对齐 useChatStore 的口径：
 * user/assistant 出原文，工具调用/结果压成一行——摘要要的是事实脉络，不是工具载荷。
 * system 不进转录（它是指令不是对话事实；window() 也从不把 system 丢进 dropped）。
 */
function buildTranscript(messages: readonly Message[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const text = textOf(m)
    const toolNote = toolNoteOf(m)
    if (m.role === 'user') {
      lines.push(`用户：${text}`)
    } else if (m.role === 'assistant') {
      if (text) lines.push(`助手：${text}`)
      if (toolNote) lines.push(text ? `助手（工具）：${toolNote}` : `助手：${toolNote}`)
    } else {
      // tool 消息：结果压一行（工具名在 toolUse 那侧，这里只留结果首行）
      if (toolNote) lines.push(`工具结果：${toolNote}`)
    }
  }
  return clipTranscript(lines.join('\n'))
}

/** 只取 text parts：图片/工具细节不进摘要输入 */
function textOf(m: Message): string {
  let out = ''
  for (const p of m.content) {
    if (p.type === 'text') out += (out ? '\n' : '') + p.text
  }
  return out.trim()
}

/** 工具痕迹压一行：toolUse 列名字，toolResult 留首行（与渲染层 firstLine 口径一致） */
function toolNoteOf(m: Message): string {
  const notes: string[] = []
  for (const p of m.content) {
    if (p.type === 'toolUse') notes.push(`调用 ${p.name}`)
    else if (p.type === 'toolResult') notes.push(firstLine(p.content, 80))
  }
  return notes.join('；')
}

/** 首个非空行截断 */
function firstLine(s: string, cap: number): string {
  const line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > cap ? line.slice(0, cap) + '…' : line
}

/**
 * 超长转录裁剪：头 60% + 尾 40%，中间用省略标记隔开。
 * 为什么不是整个 slice(0, CAP)：dropped 里最早的部分是目标与约束、最近的部分是决策与待办，
 * 中段多是过程流水——两头都留才不丢摘要该保的东西。
 */
function clipTranscript(text: string): string {
  if (text.length <= TRANSCRIPT_CAP) return text
  const headLen = Math.floor(TRANSCRIPT_CAP * 0.6)
  const tailLen = TRANSCRIPT_CAP - headLen
  const omitted = text.length - TRANSCRIPT_CAP
  return `${text.slice(0, headLen)}\n…（中间省略 ${omitted} 字）…\n${text.slice(text.length - tailLen)}`
}
