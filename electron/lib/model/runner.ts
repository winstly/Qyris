/**
 * 模型生态统一 · Agent 工具循环（Runner）—— 自研 tool loop：provider 只出补全，工具是我们自己的。
 *
 * 职责边界（对齐 types.ts 铁律）：
 *   · provider：complete({messages, tools}) → events，无会话、无工具执行；
 *   · store：消息唯一持有者（append 落账、snapshot 出全量自含上下文）；
 *   · runner：把两者串成「补全 → 工具执行 → 结果回喂」的循环，权限档在这一层拦截而不是工具内部。
 *
 * 落库顺序（硬约束，违反即语义颠倒）：assistant(含 toolUse) → tool(toolResult)×N → 下一轮 complete。
 * 先结果后消息 = provider 看到「结果先于调用」的非法历史（store.window 也要求 toolResult 必须有
 * 配对 toolUse 在前，孤立 toolResult 会被 provider 判 400）。所以工具执行放在 done 之后成批做，
 * 结果按调用序落账。
 *
 * 状态机（turn = 一次 provider.complete + 其工具批）：
 *   user 入库
 *   → complete 流：text-delta 透传 / tool-call 登记（校验存在性 + 权限档，非法当场合成
 *     isError 结果喂回模型自纠，不中断循环）/ error 或异常上抛
 *   → done：消息归一（补缺失 toolUse、补丢失正文）→ 入库 → 执行工具批（每件 tool-end 收口）
 *     → 工具结果按调用序入库
 *   → 本 turn 无工具调用：turn-end + done 收口，返回该消息
 *   → 有工具调用：turn-end → 下一 turn；超过 maxTurns 带诊断错误收口（轮数 + 末状态）
 *   任一路径异常：error 事件 + 同一 Error reject——事件给 UI，reject 给控制流；
 *   错误对象自带诊断，不是裸 throw，也不静默吞。
 *
 * 三条执行路径（按 provider 能力声明路由，互斥）：
 *   · capabilities.tools=true → streamNative：provider 发 tool-call，runner 校验+执行+回喂；
 *   · capabilities.executesOwnTools=true → streamSelfContained：provider 自持工具循环
 *     （claude-cli 的 MCP 模式），工具已经（经 MCP 回本进程 ToolRegistry）执行完，provider 只发
 *     tool-executed——本路径不注工具协议、不解析、不执行，正文/思考/工具卡全透传，单轮收口
 *     （CLI 内部已跑完它的 agentic loop，runner 再起一轮只会复读）。tools:false+executesOwnTools
 *     的语义分工见 model/types.ts；
 *   · 其余（tools=false 且无自持）→ streamPromptTools：提示词描述工具 + 围栏块协议解析模型输出，
 *     解析失败带反馈重试（MAX_PARSE_RETRIES，同 memory/agent.ts 口径），耗尽才报错——
 *     不把坏输出静默当纯文本放行（那会把「工具没跑」伪装成「模型答完了」）。
 *     ⚠️ 围栏降级现已仅剩 codex / opencode（tools:false 且未挂 MCP）；claude-cli 已迁 MCP。
 *
 * 中止语义：signal 传遍 provider 与每个工具 ctx；工具进程树杀是工具的职责
 * （ctx.signal + killTree，同 ai-cli 的取消链）。runner 保证「立刻停」：轮界检查 +
 * 工具执行与 abort 竞速（卡死的工具拖不住循环），已 tool-start 未收口的调用补
 * tool-end(isError)，防 UI 永久转圈。
 *
 * 工具契约（tools/ 层，违反即集成炸）：
 *   · isError 只表示「没正常跑完」（真异常 / 超时 / 取消）；命令非 0 退出是**合法结果**——
 *     tools 层写进 content（形如 exit: N），runner 原样回喂让模型自判要不要改命令，
 *     不当异常、不中断循环；
 *   · 工具批**必须串行**（不是 v1 偷懒）：run_command 走 proc.runOnce 同工程排队，
 *     超时定时器在排队期就可能触发、那次 cancelRunOnce 打空（shell 层 1s 补刀保证
 *     「不漏跑」不保证「到点返回」），并发发会让排在后面的在排队中被误杀；
 *   · 暴露给模型的工具按会话权限档过滤（少暴露 = 少幻觉），执行侧再复核一次；
 *   · 交互型工具（tools/index.isDeferredTool，当前只有 askUserQuestion）不进执行面：
 *     登记后不发 tool-start/tool-end（渲染层建卡走调用方 toolCalls 流程）、本轮直接收口 run，
 *     toolUse 随最终消息交回调用方——主进程不挂起等回答（没有回填通道，见 tools/ask.ts）。
 *
 * 上下文压缩（store/compact 契约）：window() 是纯视图不删消息，压缩触发与摘要去重
 * 是 runner 的账——超 maxContextTokens 时 window + summarize + applySummary，
 * 摘要物化在 kept 置顶 system 块里、不再单独注入（双份会污染人格）；摘要失败
 * 降级纯窗口切片，不阻塞主链路（中止除外，中止必须上抛）。
 */
import { randomUUID } from 'node:crypto'
import { clampToolResult, isDeferredTool } from '../tools'
import { applySummary, estimateTokens, summarize } from './compact'
import type { ConversationStore } from './store'
import type {
  CompletionRequest,
  ContentPart,
  Message,
  ModelProvider,
  Tool,
  ToolCtx,
  ToolPermission,
  ToolResult,
  ToolSchema,
  Usage,
} from './types'

// ---------- 对外契约 ----------

export type RunnerEvent =
  | { type: 'text-delta'; text: string }
  /** 思考增量透传（仅 provider.capabilities.thinking 时会出现） */
  | { type: 'reasoning-delta'; text: string }
  /** 工具已被 provider 自持循环（MCP）执行完——只透传给 UI 建卡，runner 不再执行 */
  | { type: 'tool-executed'; id: string; name: string; input: unknown; result: ToolResult }
  /** 工具已发起、MCP 往返执行中（自持循环路径：CLI 刚吐 tool_use，结果未回） */
  | { type: 'tool-progress'; id: string; name: string; input: unknown }
  /** 工具执行期的逐行输出（run_command 等长命令的实时反馈） */
  | { type: 'tool-output'; id: string; line: string; stream: 'stdout' | 'stderr' }
  | { type: 'tool-start'; id: string; name: string; input: unknown }
  | { type: 'tool-end'; id: string; result: ToolResult }
  | { type: 'turn-end'; usage: Usage }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: Error }

export interface RunnerOptions {
  provider: ModelProvider
  /** 工具集（可传全量表：runner 按会话权限档再滤出暴露面）；表外名字按「未知工具」合成 isError 结果回喂 */
  tools: Tool[]
  /** 消息归它持有：runner 只走 append / snapshot */
  store: ConversationStore
  /** 会话权限档：只放行「工具所需档位 ≤ 会话档位」的调用 */
  permission: ToolPermission
  /** 防跑飞上限（turn 数）；缺省 DEFAULT_MAX_TURNS */
  maxTurns?: number
  signal?: AbortSignal
  onEvent?: (e: RunnerEvent) => void
  /**
   * 工程根（写进 ToolCtx.projectRoot，路径工具越界防护用）。
   * RunnerOptions 契约未列、ToolCtx 又必须有——以可选字段补齐，缺省 null 由工具自行降级。
   */
  projectRoot?: string | null
  /**
   * 上下文 token 预算：超过即 window()+summarize 压缩旧消息。缺省不压缩（调用方自管）。
   * 压缩触发与摘要去重是 runner 的职责（store.window 是纯视图）——但预算是 provider 相关的
   * （200k / 32k 本地），runner 猜不到，必须由调用方按所选模型传入。
   */
  maxContextTokens?: number
}

/**
 * 摘要去重缓存：store → 上次蒸摘要时的消息数（compressCache 口径：新增 <5 条不重蒸）。
 * 为什么在 runner：window() 不删消息，同一批 dropped 每个请求都会被反复交进来，
 * 没有这层判重就是每个 turn 白烧一次 summarize 调用（compact.ts 头注释点名的分工）。
 * WeakMap 按 store 实例隔离：换会话（新 store）自动失效，不需要显式清理入口。
 */
const summarizeCache = new WeakMap<ConversationStore, { messageCount: number }>()

/** 与 useChatStore.compressCache 同口径：新增消息 <5 条视为窗口自然滚动，不重蒸摘要 */
const RESUMMARIZE_SLACK = 5

/** 一次完整 run 的 turn 上限缺省（一个 turn = 一次 complete + 其工具批）；防跑飞，调用方可覆盖 */
export const DEFAULT_MAX_TURNS = 20

/** 降级路径解析失败的带反馈重试次数（首答 + 2 重试 = 3 次调用，同 memory/agent.ts 口径） */
const MAX_PARSE_RETRIES = 2

/** 降级路径工具调用围栏块标签：```qyris-tool {json} ``` */
const TOOL_FENCE = 'qyris-tool'

// ---------- 内部结构 ----------

/** 伪标签工具调用：弱工具调用模型（网关 GLM 实测）会把调用写成正文里的自创标签
 *  （实测 <triangle>list_dir{"path":"."}</triangle>）而不是原生 tool_use——CLI 收到纯文本
 *  即结束回合，工具永不执行、任务停摆。识别「标签包已知工具名 + JSON」的形态做救援。 */
const PSEUDO_TOOL_CALL_RE = /<([a-zA-Z][\w-]*)>\s*([a-zA-Z_][\w.]*)\s*(\{[\s\S]*?\})\s*<\/\1>/g

/** 旧协议围栏（```qyris-tool {…}```）：历史会话残留 + 弱模型模仿的文本形态工具调用。
 *  JSON 形态为 { tool: 工具名, ...参数 }（如 {"tool":"list_dir","path":"."}）。 */
const LEGACY_TOOL_FENCE_RE = /```qyris-tool\s*(\{[\s\S]*?\})\s*```/g

/** 自持路径救援上限：防伪标签 ↔ 执行 ↔ 续跑来回打转 */
const SELF_RESCUE_MAX = 4

function textOfContent(parts: readonly ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** 计划形态判定：正文呈「我要做 1/2/3」的计划叙事而非最终答复（「只说不做」推进救援的触发条件） */
function planishText(text: string): boolean {
  return /计划|步骤|首先|接下来|第\s*1\s*步|先查看|初始化|搭建/.test(text)
}

// ---------- 工具叙述抑制 ----------

/** 伪标签抑制的 MCP 全名前缀（弱模型偶尔带前缀复述；救援扫描同款剥法，口径一致） */
const MCP_TOOL_PREFIX = 'mcp__qyris-tools__'
/** 未证实候选的扣留上限。候选期有界、证实后抑制无界——悬而未决的片段不能无限拖住正文 */
const CANDIDATE_MAX = 512

export interface NarrationSuppressorStats {
  /** 累计抑制字符数（含围栏/标签定界符） */
  suppressedChars: number
  /** 完整抑制的工具叙述围栏块数（含流终止时未闭合的） */
  suppressedFences: number
  /** 完整抑制的伪标签数（含流终止时未闭合的） */
  suppressedTags: number
  /** 扣而未决的字符数（候选片段 / 围栏头 / 待定夺正文） */
  pendingChars: number
  /** 是否处于抑制中（已证实叙述块但尚未闭合） */
  suppressing: boolean
}

/**
 * 工具叙述抑制器（自研流式状态机；算法思想对齐 open-design 的 toolCallTextSuppressor——
 * 候选扣留、跨 chunk 拼接再判定、flush 收尾分级、stats 诊断——针对 Qyris 的叙述语法重写，一行未搬）。
 *
 * 抑制对象（弱模型把「已发起/已执行的工具调用」复述进正文的两种实测形态）：
 *   · 围栏块：```read_file path: …``` / ```write_file content: <整份文件>```（首 token 是已知工具名）
 *   · 伪标签：<triangle>list_dir{"path":"."}</triangle>（标签体是「工具名 + JSON」）
 * 命中已知工具名 → 整块抑制（工具卡已承载该信息，全量下发既刷屏又重复）；其余代码块原样放行。
 *
 * 四态机（跨 chunk 安全：carry + chunk 拼接后再判，无一块边界假设）：
 *   text        扫描最早出现的 ``` 或 `<tag` 候选；无信号时扣留尾部候选等下一块：
 *               1~2 个尾部反引号（``` 可能被切开）、未闭合的 `<name` 片段（≤ CANDIDATE_MAX）
 *   fence-open  ``` 已见、头行未完（头行 = ``` + 首行）：工具名判定要等完整首行；
 *               头行超长仍未换行 → 按普通围栏放行（候选期有界；头词是工具名时仍照抑制）
 *   fence-body  头行已定：叙述围栏逐段扣入 suppressed；普通围栏原样放行；
 *               两侧都只扣留尾部 1~2 个反引号防闭合符被切开
 *   tag-body    伪标签证实（`<tag>` 后紧跟已知工具名 + `{`，剥可选 MCP 前缀）后抑制无界直到
 *               `</tag>`；从最后一个 `<` 起扣留疑似闭合片段（闭合符可能被切开）
 *
 * flush（流终止）分级语义：
 *   · 未证实的 text 候选 → 放行（宁可误放不可吞正文；open-design 普通 flush 同此语义，
 *     其 flushForVisibleOutputCheck 的「疑似 opener 即弃」是另一个消费方的需求，本处不采用——
 *     救援扫描要用全量，弃了就丢信息）；
 *   · 未闭合的工具叙述围栏 / 伪标签 → 全量进 suppressed（绝不漏到 visible 刷屏）；
 *   · 未闭合的普通围栏 → 放行。
 * 不变量：visible + suppressed + 扣留 = 输入，字符零丢失；救援扫描拿 visible+suppressed 即全量。
 */
export function createToolNarrationSuppressor(toolNames: ReadonlySet<string>): {
  /** 返回 {visible, suppressed}：visible 进聊天流，suppressed 留账（救援/诊断用，不丢弃） */
  push(chunk: string): { visible: string; suppressed: string }
  flush(): { visible: string; suppressed: string }
  stats(): NarrationSuppressorStats
} {
  type Mode = 'text' | 'fence-open' | 'fence-body' | 'tag-body'
  let mode: Mode = 'text'
  let visibleFence = false // fence-body：false=工具叙述（抑制）/ true=普通围栏（放行）
  let carry = '' // 跨 chunk 扣留：text 候选 / fence-body 尾部反引号 / tag-body 疑似闭合片段
  let fenceHead = '' // fence-open：含 ``` 前缀的头行片段（未遇换行）
  let tagName = '' // tag-body：等待的闭合标签名
  let suppressedChars = 0
  let suppressedFences = 0
  let suppressedTags = 0

  /** 剥可选 MCP 全名前缀（mcp__qyris-tools__list_dir → list_dir；救援扫描同款口径） */
  const stripMcpPrefix = (s: string): string =>
    s.startsWith(MCP_TOOL_PREFIX) ? s.slice(MCP_TOOL_PREFIX.length) : s
  /** 围栏头行的工具名词：剥反引号/空白/全角冒号取首 token，再剥可选 MCP 前缀 */
  const headWord = (head: string): string => {
    const w = (head.split('\n')[0] ?? '').replace(/`+/g, '').trim()
    return stripMcpPrefix(w.split(/[\s:：]+/)[0] ?? '')
  }
  /** 截断头行是否疑似工具名（双向前缀：头词可能是某工具名的前缀或反之） */
  const headMaybe = (head: string): boolean => {
    const w = headWord(head)
    if (!w) return false
    for (const t of toolNames) if (t.startsWith(w) || w.startsWith(t)) return true
    return false
  }
  /**
   * 标签体内容对工具名的判定（剥可选 MCP 前缀后比对）：
   *   confirm = 内容是「某工具名 + 紧跟 {」→ 伪标签证实；
   *   maybe   = 内容还是某工具名的前缀 → 悬而未决，继续扣；
   *   no      = 与任何工具名无关。
   */
  const toolPrefix = (content: string): 'confirm' | 'maybe' | 'no' => {
    const s = stripMcpPrefix(content.replace(/^\s+/, ''))
    let maybe = false
    for (const t of toolNames) {
      if (s.startsWith(t) && /^\s*\{/.test(s.slice(t.length))) return 'confirm'
      if (t.startsWith(s)) maybe = true
    }
    return maybe ? 'maybe' : 'no'
  }
  /**
   * 评估以 `<` + 字母开头的候选片段（text 态专用）。返回：
   *   emit n   —— 前 n 字符是正文，放行后从 n 处重扫（残余可能还藏着围栏/标签）
   *   hold     —— 整段扣到下一块再判
   *   suppress —— 伪标签证实，name 为闭合时要等标签名
   */
  const evalTag = (
    s: string,
  ): { kind: 'emit'; n: number } | { kind: 'hold' } | { kind: 'suppress'; name: string } => {
    const gt = s.indexOf('>')
    const nl = s.indexOf('\n')
    if (nl >= 0 && (gt < 0 || nl < gt)) return { kind: 'emit', n: nl + 1 } // 标签名不含换行 → 换行前是正文
    if (gt < 0) {
      // 裸 `<` 或仍可长成合法标签名的片段 → 扣住等下一块（`<` 后的字母可能被 chunk 切开）
      if (s === '<' || (/^<[a-zA-Z][\w.-]*$/.test(s) && s.length <= CANDIDATE_MAX)) return { kind: 'hold' }
      return { kind: 'emit', n: 2 } // 名字非法/超长 → 只放 `<x`，残余重扫（不能吞掉紧随的 ``` 候选）
    }
    const name = s.slice(1, gt)
    if (!/^[a-zA-Z][\w.-]*$/.test(name)) return { kind: 'emit', n: gt + 1 }
    if (toolPrefix(s.slice(gt + 1)) === 'confirm') return { kind: 'suppress', name }
    if (toolPrefix(s.slice(gt + 1)) === 'maybe' && s.length <= CANDIDATE_MAX) return { kind: 'hold' }
    return { kind: 'emit', n: gt + 1 } // 名字合法但标签体不是工具调用 → `<tag>` 是普通正文
  }
  /** 尾部反引号扣留数（1~2 个；3 个连排已被 indexOf 命中，到不了这里） */
  const backtickTail = (buf: string): number => {
    let n = 0
    while (n < buf.length && n < 2 && buf[buf.length - 1 - n] === '`') n++
    return n
  }
  /** text 态无信号时的扣留起点：疑似 `<tag` 尾片段（含裸 `<`）与尾部反引号中更早者 */
  const textHoldFrom = (buf: string): number => {
    let from = buf.length - backtickTail(buf)
    const i = buf.lastIndexOf('<')
    const tail = buf.slice(i)
    if (
      i >= 0 &&
      buf.length - i <= CANDIDATE_MAX &&
      (tail === '<' || /^<[a-zA-Z][\w.-]*$/.test(tail))
    ) {
      from = Math.min(from, i)
    }
    return Math.max(from, 0)
  }

  return {
    push(chunk: string): { visible: string; suppressed: string } {
      let out = ''
      let sup = ''
      const noteSup = (s: string): void => {
        if (!s) return
        sup += s
        suppressedChars += s.length
      }
      let buf = (mode === 'fence-open' ? fenceHead : carry) + chunk
      fenceHead = ''
      carry = ''
      for (;;) {
        if (mode === 'text') {
          const fenceIdx = buf.indexOf('```')
          let tagIdx = -1
          for (let i = buf.indexOf('<'); i >= 0; i = buf.indexOf('<', i + 1)) {
            const c = buf.charAt(i + 1)
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
              tagIdx = i
              break
            }
          }
          if (fenceIdx >= 0 && (tagIdx < 0 || fenceIdx < tagIdx)) {
            out += buf.slice(0, fenceIdx)
            buf = buf.slice(fenceIdx + 3)
            mode = 'fence-open'
            fenceHead = '```' // 开定界符随头行一起扣着（放行时要原样吐回）
            continue
          }
          if (tagIdx >= 0) {
            out += buf.slice(0, tagIdx)
            buf = buf.slice(tagIdx)
            const v = evalTag(buf)
            if (v.kind === 'hold') {
              carry = buf
              buf = ''
              break
            }
            if (v.kind === 'emit') {
              out += buf.slice(0, v.n)
              buf = buf.slice(v.n)
              continue
            }
            // 伪标签证实：`<tag>` 起全部抑制，进入 tag-body 等闭合
            mode = 'tag-body'
            tagName = v.name
            continue
          }
          const from = textHoldFrom(buf)
          out += buf.slice(0, from)
          carry = buf.slice(from)
          buf = ''
          break
        }
        if (mode === 'fence-open') {
          const nl = buf.indexOf('\n')
          if (nl < 0 && fenceHead.length + buf.length <= CANDIDATE_MAX) {
            fenceHead += buf // 头行未完且未超长：继续扣（fenceHead 已含 ``` 前缀）
            buf = ''
            break
          }
          const head = nl >= 0 ? fenceHead + buf.slice(0, nl) : fenceHead + buf
          buf = nl >= 0 ? buf.slice(nl + 1) : ''
          // 头行超长（nl<0 走到这里）且头词不是工具名 → 按普通围栏放行（候选期有界）；
          // 头词是工具名则超长也照抑制——那就是一条未闭合的叙述围栏
          if (toolNames.has(headWord(head))) {
            noteSup(head + (nl >= 0 ? '\n' : '')) // 头行随叙述一起进 suppressed（零丢失）
            visibleFence = false
          } else {
            out += head + (nl >= 0 ? '\n' : '') // 普通围栏：头行原样放行
            visibleFence = true
          }
          mode = 'fence-body'
          continue
        }
        if (mode === 'fence-body') {
          const close = buf.indexOf('```')
          if (close >= 0) {
            const seg = buf.slice(0, close + 3)
            buf = buf.slice(close + 3)
            if (visibleFence) out += seg
            else {
              noteSup(seg)
              suppressedFences += 1
            }
            mode = 'text'
            continue
          }
          const emitN = buf.length - backtickTail(buf) // 扣留尾部反引号防闭合符被切开
          if (visibleFence) out += buf.slice(0, emitN)
          else noteSup(buf.slice(0, emitN))
          carry = buf.slice(emitN)
          buf = ''
          break
        }
        // tag-body：等 </tagName>（与救援正则同口径的精确匹配，剥离结果才对得上）
        const closeToken = `</${tagName}>`
        const close = buf.indexOf(closeToken)
        if (close >= 0) {
          noteSup(buf.slice(0, close + closeToken.length))
          suppressedTags += 1
          buf = buf.slice(close + closeToken.length)
          mode = 'text'
          continue
        }
        // 闭合符可能被切开：从最后一个 < 起扣留疑似闭合片段（compact 前缀匹配，扣留有界）
        let keepFrom = buf.length
        const i = buf.lastIndexOf('<')
        if (i >= 0) {
          const compact = buf.slice(i).replace(/\s+/g, '')
          if (closeToken.startsWith(compact) && compact.length < closeToken.length) keepFrom = i
        }
        noteSup(buf.slice(0, keepFrom))
        carry = buf.slice(keepFrom)
        buf = ''
        break
      }
      return { visible: out, suppressed: sup }
    },
    flush(): { visible: string; suppressed: string } {
      let out = ''
      let sup = ''
      const noteSup = (s: string): void => {
        if (!s) return
        sup += s
        suppressedChars += s.length
      }
      if (mode === 'text') {
        out = carry // 未证实候选放行：宁可误放，不可吞正文
      } else if (mode === 'fence-open') {
        // 流在头行中途终止：头词疑似工具名 → 按截断叙述抑制；否则原样放行
        if (headMaybe(fenceHead)) {
          noteSup(fenceHead)
          suppressedFences += 1
        } else {
          out = fenceHead
        }
      } else if (mode === 'fence-body') {
        if (visibleFence) out = carry
        else {
          noteSup(carry) // 未闭合的工具叙述围栏也全量抑制，绝不漏到 visible
          suppressedFences += 1
        }
      } else {
        noteSup(carry) // 未闭合的伪标签：全量留 suppressed 供救援扫描
        suppressedTags += 1
      }
      // 状态归零：flush 即终态（每轮补全一个实例，用完即弃）
      mode = 'text'
      carry = ''
      fenceHead = ''
      tagName = ''
      return { visible: out, suppressed: sup }
    },
    stats(): NarrationSuppressorStats {
      return {
        suppressedChars,
        suppressedFences,
        suppressedTags,
        pendingChars: mode === 'fence-open' ? fenceHead.length : carry.length,
        suppressing: mode !== 'text',
      }
    },
  }
}

interface CallRecord {
  id: string
  name: string
  input: unknown
  /** 校验期合成（未知工具 / 权限不足 / 中止）或执行产出；null = 待执行 */
  result: ToolResult | null
  /** tool-start 已发（tool-end 必须配对收口，防 UI 永久转圈） */
  started: boolean
  ended: boolean
  /**
   * 交互型工具（tools/ask.ts）：不在主进程执行，也不发 tool-start/tool-end——
   * 调用方按 AiCompletion.toolCalls 自己建卡（渲染层 askUser 流程要 pendingAsk 才能交互）。
   * 本轮出现 deferred 调用即结束 run（见主循环），由调用方完成「挂起等回答」闭环。
   */
  deferred: boolean
}

interface TurnOutcome {
  message: Message
  usage: Usage
  calls: CallRecord[]
}

type ToolUsePart = Extract<ContentPart, { type: 'toolUse' }>

// ---------- 纯工具函数 ----------

function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || '未知错误'
  return String(err)
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  const e = new Error(
    reason !== undefined && reason !== null && reason !== '' ? String(reason) : '已取消（AbortSignal 触发）',
  )
  e.name = 'AbortError'
  return e
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function normalizeUsage(u: Usage | null | undefined): Usage {
  return {
    inputTokens: Number(u?.inputTokens) || 0,
    outputTokens: Number(u?.outputTokens) || 0,
    cacheReadTokens: Number(u?.cacheReadTokens) || 0,
    cacheWriteTokens: Number(u?.cacheWriteTokens) || 0,
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  }
}

/** 工具所需档位 ≤ 会话档位才放行；未知档位 fail-safe（要求方按最高、给的按最低） */
function permissionAllows(granted: ToolPermission, required: ToolPermission): boolean {
  const rank: Record<ToolPermission, number> = { readonly: 0, write: 1, exec: 2 }
  return (rank[granted] ?? -1) >= (rank[required] ?? 2)
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], meta: { ts: Date.now() } }
}

function toolResultMessage(c: CallRecord): Message {
  const r = c.result ?? { content: '（无结果）', isError: true }
  return {
    role: 'tool',
    content: [{ type: 'toolResult', toolUseId: c.id, content: r.content, isError: r.isError }],
    meta: { ts: Date.now() },
  }
}

/**
 * 消息归一：补齐缺失的 toolUse 部件。
 * 双保险——有的 provider 把 tool-call 只走事件流不进 done.message，有的只进消息不发事件，
 * 两侧取并集后，落库的 assistant 消息必须自含全部 toolUse，否则 toolResult 悬空。
 */
function ensureToolUseParts(message: Message, calls: readonly CallRecord[]): Message {
  const have = new Set(
    message.content.filter((p): p is ToolUsePart => p.type === 'toolUse').map((p) => p.id),
  )
  const missing = calls.filter((c) => !have.has(c.id))
  if (missing.length === 0) return message
  return {
    ...message,
    content: [
      ...message.content,
      ...missing.map((c) => ({ type: 'toolUse' as const, id: c.id, name: c.name, input: c.input })),
    ],
  }
}

/** 正文兜底：provider 只发 text-delta 不把正文写进 done.message 时，用累计增量回填 */
function backfillText(message: Message, streamedText: string): Message {
  if (!streamedText) return message
  if (message.content.some((p) => p.type === 'text' && p.text.trim())) return message
  return { ...message, content: [{ type: 'text', text: streamedText }, ...message.content] }
}

/**
 * 正文清洗替换：把消息里的全部 text 部件换成 text（非文本部件原位保留）。
 * 自持路径的 done.message 带的是模型原始全量文本（含工具叙述围栏/伪标签），
 * 落库与回传前必须与用户实际看到的可见流对齐——叙述抑制后两者天然分叉，这里是收口点。
 */
function withTextContent(message: Message, text: string): Message {
  const others = message.content.filter((p) => p.type !== 'text')
  return { ...message, content: [{ type: 'text', text }, ...others] }
}

// ---------- 降级路径：提示词工具 + 围栏块解析 ----------

function buildToolInstruction(tools: readonly Tool[]): string {
  const catalog = tools
    .map((t) => `- ${t.name}：${t.description}\n  入参 JSON Schema：${JSON.stringify(t.inputSchema ?? {})}`)
    .join('\n')
  return [
    '【工具调用协议（系统注入，非用户发言）】',
    '你可以调用以下工具完成任务：',
    catalog || '（当前无可用工具）',
    '',
    '需要调用工具时，输出一个围栏块（前面可以有简短说明文字，围栏块单独成段）：',
    '```' + TOOL_FENCE,
    '{"calls":[{"name":"工具名","input":{...}}]}',
    '```',
    '规则：',
    '- 围栏块内必须是合法 JSON 对象：{"calls":[...]}（或单个 {"name":"...","input":{...}}）；不要注释、尾逗号或任何非 JSON 文字',
    '- input 必须符合该工具的入参 JSON Schema；一次可以调用多个工具',
    '- 相互独立的调用合并进同一个 calls 数组一次发出；有依赖的调用必须分轮：先发起前序，拿到工具结果再发起后续',
    '- 不需要工具时直接输出最终回答，不要输出工具块；无法完成时用文字说明原因，不要输出空的 calls 数组',
    '- 工具执行结果会以 tool 消息回给你，据此继续或收尾',
  ].join('\n')
}

function parseFeedback(reason: string, raw: string): string {
  return [
    '你上一次的工具调用无法解析，请修正后严格按协议重新输出。',
    `失败原因：${reason}`,
    '协议（必须使用围栏块，块内是合法 JSON）：',
    '```' + TOOL_FENCE,
    '{"calls":[{"name":"工具名","input":{...}}]}',
    '```',
    '注意：',
    '- 围栏块内不要写注释、尾逗号、markdown 或任何非 JSON 文字',
    '- 字符串内的英文双引号需转义；围栏必须闭合',
    '- 不需要工具时直接输出最终回答文本（不要输出工具块）',
    '',
    `你上一次的输出（供参考）：\n${raw.slice(0, 2000)}`,
  ].join('\n')
}

type FallbackParse =
  | { kind: 'none'; prose: string }
  | { kind: 'calls'; prose: string; calls: Array<{ id: string; name: string; input: unknown }> }
  | { kind: 'error'; reason: string; raw: string }

/** 裸 JSON 但形似工具调用（没包围栏）→ 归解析失败走反馈重试，别把调用伪装成正文放行 */
function looksLikeToolJson(text: string): boolean {
  if (!text.startsWith('{')) return false
  try {
    const obj = JSON.parse(text) as { calls?: unknown; name?: unknown } | null
    if (!obj || typeof obj !== 'object') return false
    return Array.isArray(obj.calls) || (typeof obj.name === 'string' && 'input' in obj)
  } catch {
    // 写坏的 JSON 也常带工具调用痕迹；整段以 { 开头才认，降低正文误伤
    return /"calls"\s*:/.test(text) || (/"name"\s*:/.test(text) && /"input"\s*:/.test(text))
  }
}

function parseFallbackToolCalls(text: string): FallbackParse {
  const fenceRe = new RegExp('```' + TOOL_FENCE + '[ \\t]*\\n([\\s\\S]*?)```', 'g')
  const blocks: string[] = []
  for (const m of text.matchAll(fenceRe)) blocks.push((m[1] ?? '').trim())
  const prose = text.replace(fenceRe, '').trim()
  if (blocks.length === 0) {
    // 没识别到围栏块 ≠ 一定没调用：裸 JSON、自创包裹标签（<function=…>、tool_use 之类）、
    // 未闭合围栏都算「疑似工具调用」。放行当正文 = 把「工具没跑」伪装成「模型答完了」
    // （文件头点名禁止的静默坏味道，真跑冒烟抓到过 <function=qyris_tool> 变体）→ 走反馈重试。
    if (looksLikeToolJson(text.trim()) || /<\s*tool[_-]?(call|use)\b|<\s*function[_-]?call\b|<\s*function=|```qyris-tool\b/i.test(text)) {
      return { kind: 'error', reason: `工具调用必须放在 \`\`\`${TOOL_FENCE} 围栏块里（且围栏要闭合）`, raw: text }
    }
    return { kind: 'none', prose }
  }
  const calls: Array<{ id: string; name: string; input: unknown }> = []
  for (const block of blocks) {
    let obj: unknown
    try {
      obj = JSON.parse(block)
    } catch (e) {
      return { kind: 'error', reason: `工具块不是合法 JSON：${errText(e)}`, raw: text }
    }
    if (!obj || typeof obj !== 'object') {
      return { kind: 'error', reason: '工具块必须是 JSON 对象', raw: text }
    }
    const rec = obj as { calls?: unknown; name?: unknown; input?: unknown }
    // 形状宽进：{"calls":[...]} 或单个 {"name","input"} 都收；name 必须是字符串
    const items: unknown[] = Array.isArray(rec.calls) ? rec.calls : typeof rec.name === 'string' ? [rec] : []
    if (!Array.isArray(rec.calls) && typeof rec.name !== 'string') {
      return {
        kind: 'error',
        reason: '工具块形状应为 {"calls":[{"name":"...","input":{...}}]}（或单个 {"name":"...","input":{...}}）',
        raw: text,
      }
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as { name?: unknown; input?: unknown; id?: unknown } | null
      const name = typeof item?.name === 'string' ? item.name.trim() : ''
      if (!name) return { kind: 'error', reason: `工具块第 ${i + 1} 个调用缺少字符串 name`, raw: text }
      calls.push({
        id: typeof item?.id === 'string' && item.id ? item.id : `fallback_${randomUUID()}`,
        name,
        input: item?.input ?? {},
      })
    }
  }
  if (calls.length === 0) return { kind: 'none', prose }
  return { kind: 'calls', prose, calls }
}

// ---------- 主入口 ----------

export async function runAgent(input: string, opts: RunnerOptions): Promise<Message> {
  // 调用方契约 bug：直接抛，不进 error 事件通道（error 事件是「跑起来之后」的失败收口）
  const provider = opts?.provider
  const store = opts?.store
  if (!provider || typeof provider.complete !== 'function') {
    throw new Error('runAgent: RunnerOptions.provider 缺失或不是 ModelProvider')
  }
  if (!store || typeof store.append !== 'function' || typeof store.snapshot !== 'function') {
    throw new Error('runAgent: RunnerOptions.store 缺失或不是 ConversationStore')
  }

  const tools = opts.tools ?? []
  // 权限档缺省按最严档兜底（fail-safe：宁可少放行，不可越权执行）
  const permission: ToolPermission = opts.permission ?? 'readonly'
  const maxTurns =
    opts.maxTurns != null && Number.isFinite(opts.maxTurns) && opts.maxTurns > 0
      ? Math.floor(opts.maxTurns)
      : DEFAULT_MAX_TURNS
  const signal = opts.signal
  const projectRoot = opts.projectRoot ?? null
  const maxContextTokens =
    opts.maxContextTokens != null && Number.isFinite(opts.maxContextTokens) && opts.maxContextTokens > 0
      ? Math.floor(opts.maxContextTokens)
      : null
  // 全量表留着做「未知工具 vs 权限不足」诊断；但**暴露给模型的**必须按会话档位过滤——
  // 少暴露 = 少幻觉（对齐 tools.toolsForPermission 口径；执行侧 registerCall 再复核一次）
  const exposedTools = tools.filter((t) => permissionAllows(permission, t.permission))
  const toolByName = new Map(tools.map((t) => [t.name, t]))
  const nativeTools = provider.capabilities?.tools === true
  // 自持工具循环（MCP）：工具已在 provider 侧执行完，runner 只透传（见 streamSelfContained）
  const selfContained = provider.capabilities?.executesOwnTools === true

  // 渲染回调是旁路：它抛错不能把循环带走
  const emit = (e: RunnerEvent): void => {
    if (!opts.onEvent) return
    try {
      opts.onEvent(e)
    } catch (err) {
      console.warn('[runner] onEvent 抛错（已忽略，不中断循环）：', err)
    }
  }
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw abortError(signal)
  }

  // 中止竞速共用一个 promise（每 run 挂一次 listener）；无人 await 时也有人接 rejection
  const abortWait: Promise<never> | null = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) reject(abortError(signal))
        else signal.addEventListener('abort', () => reject(abortError(signal)), { once: true })
      })
    : null
  abortWait?.catch(() => {})

  /** provider → compact.summarize 要的纯文本补全（compact 契约：适配是 runner 的账）；error/中止原样上抛 */
  const completeText = async (messages: Message[]): Promise<string> => {
    let text = ''
    let doneMessage: Message | null = null
    for await (const ev of provider.complete({ messages, signal })) {
      throwIfAborted()
      if (ev.type === 'text-delta') text += ev.text
      else if (ev.type === 'done') doneMessage = ev.message
      else if (ev.type === 'error') throw ev.error
      if (doneMessage) break
    }
    if (text.trim()) return text
    return (doneMessage?.content ?? [])
      .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
  }

  /**
   * 请求消息组装。压缩触发与摘要去重都是 runner 的账（store 只给原语）：
   *   · window() 纯视图不删消息 → 同一批 dropped 每个请求都会再来一遍，靠 summarizeCache 判重；
   *   · 摘要物化在 kept 的置顶 system 块里（store.setSummary 槽位），**不要再塞 store.summary**——双份；
   *   · summarize 失败降级纯窗口切片（对齐 useChatStore），但中止必须上抛，不许被降级吞掉。
   */
  const buildRequestMessages = async (): Promise<readonly Message[]> => {
    if (maxContextTokens == null) return store.snapshot()
    const { kept, dropped } = store.window(maxContextTokens, estimateTokens)
    if (dropped.length > 0) {
      const total = kept.length + dropped.length
      const cached = summarizeCache.get(store)
      if (!cached || total - cached.messageCount >= RESUMMARIZE_SLACK) {
        try {
          const summary = await summarize(dropped, completeText)
          applySummary(summary, store) // 空摘要 = 清槽位，last-write-wins（compact 契约）
          summarizeCache.set(store, { messageCount: total })
        } catch (err) {
          if (signal?.aborted || isAbortError(err)) throw abortError(signal)
          console.warn('[runner] 上下文压缩失败，降级为纯窗口切片：', errText(err))
        }
      }
    }
    // 重开窗：applySummary 之后 kept 里才有新摘要物化块；没压缩过时与上面等价（纯视图，代价可忽略）
    return store.window(maxContextTokens, estimateTokens).kept
  }

  /** 为已 tool-start 未 tool-end 的调用补收口（幂等），防 UI 永久转圈 */
  const closeOpenCalls = (calls: CallRecord[], reason: string): void => {
    for (const c of calls) {
      if (!c.started || c.ended) continue
      c.result = c.result ?? { content: reason, isError: true }
      c.ended = true
      emit({ type: 'tool-end', id: c.id, result: c.result })
    }
  }

  /**
   * 工具调用登记：tool-start 立即出卡（UI 及时看到调用）；校验不过当场合成 isError 结果
   * 喂回模型自纠——不是 runner 级失败，循环继续。事件与消息双报同一调用时按 id 去重。
   */
  const registerCall = (calls: CallRecord[], id: string, name: string, input: unknown): void => {
    const callId = id || `call_${randomUUID()}`
    if (calls.some((c) => c.id === callId)) return
    // 交互型工具：不建卡（tool-start/tool-end 是渲染层建卡信号，卡片要走调用方自己的 toolCalls 流程）、
    // 不执行——本轮登记后由主循环收口 run，toolUse 随最终消息交回调用方
    if (isDeferredTool(name)) {
      calls.push({ id: callId, name, input, result: null, started: false, ended: true, deferred: true })
      return
    }
    const record: CallRecord = { id: callId, name, input, result: null, started: true, ended: false, deferred: false }
    emit({ type: 'tool-start', id: callId, name, input })
    const tool = toolByName.get(name)
    if (!tool) {
      record.result = {
        content: `未知工具：${name}${exposedTools.length > 0 ? `（本会话可用：${exposedTools.map((t) => t.name).join('、')}）` : '（本会话未配置任何工具）'}`,
        isError: true,
      }
    } else if (!permissionAllows(permission, tool.permission)) {
      record.result = {
        content: `权限不足：工具「${name}」需要 ${tool.permission} 档，当前会话权限档为 ${permission}`,
        isError: true,
      }
    }
    if (record.result) {
      record.ended = true
      emit({ type: 'tool-end', id: callId, result: record.result })
    }
    calls.push(record)
  }

  /**
   * 单件工具执行。isError 语义（tools 契约）：isError **只表示「没正常跑完」**
   * （真异常 / 超时 / 取消）。命令非 0 退出是**合法结果**——tools 层写进 content
   * （形如 exit: N），此处原样回喂让模型自己判断要不要改命令，不当异常、不中断循环。
   * 只有工具真抛错才转 isError 喂回模型自纠；中止一律上抛（必须立刻停）。
   */
  const executeOne = async (call: CallRecord): Promise<ToolResult> => {
    const tool = toolByName.get(call.name)
    if (!tool) return { content: `未知工具：${call.name}`, isError: true } // register 已拦，双保险
    const ctx: ToolCtx = {
      projectRoot,
      signal,
      permission,
      // 执行期逐行回吐：长命令（npm install 等）不再让聊天窗静默数分钟
      onOutput: (line, stream) => emit({ type: 'tool-output', id: call.id, line, stream }),
    }
    // Promise.resolve 包一层：工具同步 throw 也走同一 catch；竞速落败方的 rejection 必须有人接
    const exec = Promise.resolve().then(() => tool.execute(call.input, ctx))
    exec.catch(() => {})
    try {
      const r = abortWait ? await Promise.race([exec, abortWait]) : await exec
      // 与 executeTool 同口径的 60k 兜底截断：本路径走 tool.execute 直调（保依赖注入），
      // 不经 executeTool，若不在此收口超长输出会绕过兜底吃爆上下文
      return clampToolResult(r)
    } catch (err) {
      // 工具自己抛的 AbortError / 竞速中止 → 一律按中止上抛，不得伪装成工具失败继续跑
      if (signal?.aborted || isAbortError(err)) throw abortError(signal)
      return clampToolResult({ content: `工具执行失败：${errText(err)}`, isError: true })
    }
  }

  /**
   * 工具批执行——**必须串行，这不是 v1 偷懒**：
   * run_command 走 proc.runOnce（同工程串行排队），它的超时定时器在排队期就可能触发，
   * 那次 cancelRunOnce 是打空的（shell 层靠 1s 补刀收割：保证「不漏跑」，不保证「到点返回」）。
   * 并发发多条 run_command，排在后面的会在排队中就被判超时补刀杀掉，等于没执行。
   * 「并行口子」只留在接口语义层：事件按 id 关联、结果按 id 回填、入库按调用序——
   * 执行完成顺序不进任何语义。真要并行（非 proc 类工具），也必须保持同工程 run_command 串行。
   */
  const runToolBatch = async (calls: CallRecord[]): Promise<void> => {
    for (const call of calls) {
      if (call.result !== null || call.deferred) continue
      throwIfAborted() // 中止后不再启动新工具；余下已 tool-start 的由 closeOpenCalls 收口
      call.result = await executeOne(call)
      call.ended = true
      emit({ type: 'tool-end', id: call.id, result: call.result })
    }
  }

  /** 落账：assistant(含 toolUse) 先行，工具结果按调用序随后——顺序即语义，见文件头 */
  const finishTurn = async (message: Message, calls: CallRecord[]): Promise<Message> => {
    const withTools = ensureToolUseParts(message, calls)
    store.append(withTools)
    try {
      await runToolBatch(calls)
    } finally {
      // 即使中止打断批次，已执行/已合成的结果也要落账，保证 toolUse 与 toolResult 配对完整
      closeOpenCalls(calls, '已取消（AbortSignal 触发，工具未完成）')
      for (const c of calls) if (c.result) store.append(toolResultMessage(c))
    }
    return withTools
  }

  // ---------- 单 turn：原生工具路径 ----------

  const streamNative = async (calls: CallRecord[]): Promise<{ message: Message; usage: Usage }> => {
    const schemas: ToolSchema[] = exposedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
    const req: CompletionRequest = {
      messages: await buildRequestMessages(),
      tools: schemas.length > 0 ? schemas : undefined,
      signal,
    }
    let message: Message | null = null
    let usage = zeroUsage()
    let streamedText = ''
    for await (const ev of provider.complete(req)) {
      throwIfAborted()
      switch (ev.type) {
        case 'text-delta':
          streamedText += ev.text
          emit({ type: 'text-delta', text: ev.text })
          break
        case 'reasoning-delta':
          // 思考不进正文、不落 store（只是过程可见性），但必须透传给 UI
          emit({ type: 'reasoning-delta', text: ev.text })
          break
        case 'tool-progress':
          // 工具发起（MCP 往返执行中）：透传给 UI 出「执行中」卡片
          emit({ type: 'tool-progress', id: ev.id, name: ev.name, input: ev.input })
          break
        case 'tool-executed':
          // provider 自持循环（MCP）已执行完：只透传 UI，runner 绝不再执行
          emit({ type: 'tool-executed', id: ev.id, name: ev.name, input: ev.input, result: ev.result })
          break
        case 'tool-call':
          registerCall(calls, ev.id, ev.name, ev.input)
          break
        case 'done':
          message = ev.message
          usage = normalizeUsage(ev.usage)
          break
        case 'error':
          throw ev.error
      }
      if (message) break // 契约：done/error 恒为最后一个事件；done 后不再消费
    }
    if (!message) {
      throw new Error('provider 流结束但未产出 done 消息（契约要求最后一个事件恒为 done 或 error）')
    }
    // 有的 provider 只发事件不把 toolUse 写进消息，有的反过来——并集归一，谁缺补谁
    for (const part of message.content) {
      if (part.type === 'toolUse') registerCall(calls, part.id, part.name, part.input)
    }
    return { message: backfillText(ensureToolUseParts(message, calls), streamedText), usage }
  }

  // ---------- 单 turn：自持工具循环路径（executesOwnTools：MCP 模式纯透传） ----------

  /**
   * provider 自持工具循环（claude-cli MCP 模式）：工具已由 CLI 经 MCP 调本进程 ToolRegistry
   * 执行完，随流以 tool-executed 上报。与 streamNative 的四点不同，全部是语义性的：
   *   · 不传 schemas（tools:false）——工具面由 provider 经 MCP tools/list 自取，runner 无账可管；
   *   · 不登记 CallRecord——登记了就会进 finishTurn 的执行批，MCP 已执行过再执行 = 双跑
 *     （types.ts 点名的互斥约束）；调用卡由调用方按 tool-executed 透传建卡，不走 tool-start/end；
   *   · calls 恒空 → 主循环单轮收口——CLI 内部已跑完它自己的 agentic loop，runner 再起一轮
   *     只会让模型对着已完结的上下文复读；
   *   · 正文过工具叙述抑制器（createToolNarrationSuppressor）：弱模型复述进正文的工具调用
   *     围栏/伪标签不再刷屏，visible 下发、suppressed 留账（救援扫描用全量）；
   *     done 消息正文与可见流对齐（withTextContent），救援语义不变。
   */
  const streamSelfContained = async (): Promise<{ message: Message; usage: Usage; calls: CallRecord[] }> => {
    let totalUsage = zeroUsage()
    let lastMessage: Message | null = null
    /** 交互型救援（askUserQuestion）：随最终消息交回调用方走渲染层 askUser 流程 */
    let deferredCalls: CallRecord[] = []
    /** 「只说不做」推进救援是否已用过（上限一次防打转） */
    let planNudged = false

    for (let pass = 0; pass <= SELF_RESCUE_MAX; pass++) {
      throwIfAborted()
      const req: CompletionRequest = { messages: await buildRequestMessages(), signal }
      // 每轮独立抑制器（用完即弃）：visible 进聊天流，suppressed 留账不丢弃——
      // 救援扫描要用全量（visible + suppressed = 模型原始全量，字符零丢失）
      const suppressor = createToolNarrationSuppressor(new Set(toolByName.keys()))
      let message: Message | null = null
      let usage = zeroUsage()
      let visibleText = ''
      let suppressedText = ''
      /** 本轮 CLI 是否真经 MCP 执行过工具（tool-executed 到达即置位）。
       *  置位后正文里的伪标签/围栏是已执行调用的复述、计划形态文本是交付物——
       *  救援与推进 nudge 都让路，防止同一批命令在服务端重复执行（回归：smoke:runner-mcp）。 */
      let hadToolExec = false
      for await (const ev of provider.complete(req)) {
        throwIfAborted()
        switch (ev.type) {
          case 'text-delta': {
            const r = suppressor.push(ev.text)
            if (r.visible) {
              visibleText += r.visible
              emit({ type: 'text-delta', text: r.visible })
            }
            suppressedText += r.suppressed
            break
          }
          case 'reasoning-delta':
            emit({ type: 'reasoning-delta', text: ev.text })
            break
          case 'tool-progress':
            // 工具发起（CLI 吐出 tool_use、MCP 往返执行中）：透传给 UI 出「执行中」卡片。
            // 不补这个 case 事件会被静默吞掉 → 长命令（npm install 数分钟）执行期聊天窗体感假死
            emit({ type: 'tool-progress', id: ev.id, name: ev.name, input: ev.input })
            break
          case 'tool-executed':
            hadToolExec = true
            // 纯透传给 UI 建卡；结果已在 MCP 侧收口，runner 不再执行、不回喂
            emit({ type: 'tool-executed', id: ev.id, name: ev.name, input: ev.input, result: ev.result })
            break
          case 'tool-call':
            // 能力声明与行为不一致（自持循环方只该发 tool-executed）：响亮报错而不是猜
            throw new Error(
              `provider「${provider.id}」声明 capabilities.executesOwnTools=true 却产出 tool-call 事件（能力声明与行为不一致）`,
            )
          case 'done':
            message = ev.message
            usage = normalizeUsage(ev.usage)
            break
          case 'error':
            throw ev.error
        }
        if (message) break // 契约：done/error 恒为最后一个事件；done 后不再消费
      }
      if (!message) {
        throw new Error('provider 流结束但未产出 done 消息（自持工具循环路径；契约要求最后一个事件恒为 done 或 error）')
      }
      totalUsage = addUsage(totalUsage, usage)
      // 收尾放行：flush 分级语义——未证实候选/普通围栏放行，未闭合叙述块全量进 suppressed
      const tail = suppressor.flush()
      if (tail.visible) {
        visibleText += tail.visible
        emit({ type: 'text-delta', text: tail.visible })
      }
      suppressedText += tail.suppressed

      // done 消息正文与可见流对齐（剔除工具叙述围栏/伪标签后的正文）：
      // provider 的 done.message 带原始全量文本，落库/回传前必须清洗，否则 UI 已抑制的东西又从消息里回来了
      let msg = backfillText(message, visibleText)
      if (visibleText || suppressedText) msg = withTextContent(msg, visibleText)

      // 伪标签救援：全量文本（可见 + 被抑制的叙述）里的「标签包已知工具名 + JSON」剥出来真执行，否则任务停摆。
      // 必须用全量：证实抑制的伪标签进了 suppressed，只扫可见流会漏救。
      // hadToolExec（本轮已真跑过 MCP 工具）时整体跳过：正文里的伪标签/围栏是已执行调用的复述，
      // 再救援会让同一命令在服务端重复执行；零执行（弱网关模型只会文本形态调用）才是救援的本命场景。
      const fullText = visibleText + suppressedText
      const passCalls: CallRecord[] = []
      if (!hadToolExec) {
        for (const m of fullText.matchAll(PSEUDO_TOOL_CALL_RE)) {
          const name = m[2].replace(/^mcp__qyris-tools__/, '')
          if (!toolByName.has(name)) continue
          let input: unknown = {}
          try { input = JSON.parse(m[3]) } catch { continue }
          const before = passCalls.length
          registerCall(passCalls, `pseudo-${pass}-${before}`, name, input)
        }
        // 旧协议围栏（```qyris-tool {…}```）：历史会话残留 + 弱模型模仿的文本形态调用，
        // MCP 模式下 runner 不解析围栏，这类调用原本会落空——一并救援。
        for (const m of fullText.matchAll(LEGACY_TOOL_FENCE_RE)) {
          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(m[1]) } catch { continue }
          const name = String(parsed.tool ?? '')
          if (!name || !toolByName.has(name)) continue
          const { tool: _toolName, ...input } = parsed
          const before = passCalls.length
          registerCall(passCalls, `legacy-${pass}-${before}`, name, input)
        }
      }
      if (passCalls.length === 0) {
        // 正常收口：无伪调用（或救援轮耗尽仍无），本条即最终回复。
        // 全被抑制且无正文时给一句诚实交代，不出空消息（静默空泡比一句话更糟）
        if (!textOfContent(msg.content).trim() && suppressedText) {
          msg = withTextContent(msg, '（该回复仅含工具调用叙述，已按工具卡口径抑制）')
        }
        // 「只说不做」推进救援：首轮且正文呈计划形态时追加一条推进指令续跑一轮（上限一次防打转）。
        // hadToolExec 时跳过：本轮已真跑过工具，此时的计划形态文本是交付物而非「只说不做」。
        if (pass === 0 && !planNudged && !hadToolExec && planishText(textOfContent(msg.content))) {
          planNudged = true
          store.append(userMessage('按你的计划立即执行第 1 步：现在就发起工具调用，不要只输出计划。'))
          continue
        }
        lastMessage = msg
        break
      }

      // 剥伪标签：对可见流剥（被抑制的从未上屏，无需剥）。流式证实有 CANDIDATE_MAX 兜底旁路，
      // 可见流里仍可能残留完整伪标签（候选超长放弃扣留的形态），此处兜底剥除，双保险。
      // 工具结果已在 store 供下一轮续跑。
      let cleaned = ''
      let cursor = 0
      for (const m of visibleText.matchAll(PSEUDO_TOOL_CALL_RE)) {
        const name = m[2].replace(/^mcp__qyris-tools__/, '')
        if (!toolByName.has(name)) continue
        const a = m.index as number
        const b = a + m[0].length
        cleaned += visibleText.slice(cursor, a)
        cursor = b
      }
      cleaned += visibleText.slice(cursor)
      msg = { ...msg, content: [{ type: 'text', text: cleaned.replace(/\n{3,}/g, '\n\n').trim() || '（调用工具中）' }] }

      let deferred = false
      for (const c of passCalls) {
        if (c.deferred) {
          // 交互型（askUserQuestion）：交回调用方走渲染层 askUser 挂起，主循环会收口 run
          deferredCalls.push(c)
          deferred = true
          continue
        }
        // tool-start 已由 registerCall 发过（与原生路径同一出口），此处不再重复
        c.result = await executeOne(c)
        c.ended = true
        emit({ type: 'tool-end', id: c.id, result: c.result })
        // 结果落库：下一轮 provider 从 store 看到回喂再续答
        store.append(toolResultMessage(c))
      }
      // 清洗后的 assistant 落库（下一轮可见）；交互型随 deferredCalls 走 finishTurn 正常建档
      store.append(msg)
      if (deferred) {
        lastMessage = msg
        break
      }
    }

    if (!lastMessage) {
      throw new Error('provider 流结束但未产出 done 消息（自持工具循环路径；契约要求最后一个事件恒为 done 或 error）')
    }
    return { message: lastMessage, usage: totalUsage, calls: deferredCalls }
  }

  // ---------- 单 turn：降级路径（无原生 tools → 提示词描述 + 解析输出） ----------
  const streamPromptTools = async (calls: CallRecord[]): Promise<{ message: Message; usage: Usage }> => {
    let totalUsage = zeroUsage()
    let lastRaw = ''
    let lastReason = ''
    for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
      throwIfAborted()
      // 协议注入走 user 尾消息：user 角色任何 provider 都会送达（system 多条会被部分家吞掉）
      // 只进请求不落 store——协议是每轮重发的运行时指令，不是会话内容
      const extra: Message =
        attempt === 0
          ? userMessage(buildToolInstruction(exposedTools))
          : userMessage(parseFeedback(lastReason, lastRaw))
      const req: CompletionRequest = { messages: [...(await buildRequestMessages()), extra], signal }
      let raw = ''
      let doneMessage: Message | null = null
      let usage = zeroUsage()
      let gotDone = false
      for await (const ev of provider.complete(req)) {
        throwIfAborted()
        switch (ev.type) {
          case 'text-delta':
            raw += ev.text
            break
          case 'reasoning-delta':
            // 降级通道（codex/opencode）capabilities.thinking=false，正常不会来；来了就透传，不进正文
            emit({ type: 'reasoning-delta', text: ev.text })
            break
          case 'tool-executed':
            emit({ type: 'tool-executed', id: ev.id, name: ev.name, input: ev.input, result: ev.result })
            break
          case 'tool-call':
            // 声明 tools:false 却吐 tool-call = 能力声明与行为不一致，明确报错而不是猜
            throw new Error(
              `provider「${provider.id}」声明 capabilities.tools=false 却产出 tool-call 事件（能力声明与行为不一致）`,
            )
          case 'done':
            doneMessage = ev.message
            usage = normalizeUsage(ev.usage)
            gotDone = true
            break
          case 'error':
            throw ev.error
        }
        if (gotDone) break
      }
      if (!gotDone) {
        throw new Error('provider 流结束但未产出 done 消息（降级路径；契约要求最后一个事件恒为 done 或 error）')
      }
      // 正文来源双保险：增量是模型原始输出，优先；done.message 只做「没增量」时的兜底。
      // 反过来（message 优先）有个静默坏味道：provider 若把 message 后处理过（剥掉围栏块），
      // 解析会看不到工具调用，工具不跑却当成「模型答完了」——宁可响亮失败，不可静默丢工具
      if (!raw.trim()) {
        raw = (doneMessage?.content ?? [])
          .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
      }
      totalUsage = addUsage(totalUsage, usage)
      lastRaw = raw
      const parsed = parseFallbackToolCalls(raw)
      if (parsed.kind === 'error') {
        lastReason = parsed.reason
        console.warn(`[runner] 降级工具块解析失败（第 ${attempt + 1}/${MAX_PARSE_RETRIES + 1} 次）：${parsed.reason}`)
        continue // 带反馈重试：把坏输出喂回去让模型自纠（同 memory/agent.ts 范式）
      }
      if (parsed.kind === 'calls') {
        for (const c of parsed.calls) registerCall(calls, c.id, c.name, c.input)
      }
      if (parsed.prose.trim()) emit({ type: 'text-delta', text: parsed.prose })
      // toolUse 部件由 finishTurn 统一补进消息（ensureToolUseParts），此处只带正文
      return {
        message: {
          role: 'assistant',
          content: parsed.prose.trim() ? [{ type: 'text', text: parsed.prose.trim() }] : [],
          meta: { provider: provider.id, ts: Date.now() },
        },
        usage: totalUsage,
      }
    }
    throw new Error(
      `降级工具调用连续 ${MAX_PARSE_RETRIES + 1} 次解析失败（最后一次原因：${lastReason}）；` +
        `最后一次输出片段：${lastRaw.slice(0, 200)}`,
    )
  }

  const runTurn = async (): Promise<TurnOutcome> => {
    const calls: CallRecord[] = []
    try {
      const outcome = selfContained
        ? await streamSelfContained() // 正常单轮收口；伪标签救援时带回 calls 续跑
        : await (async () => {
            // API/降级路径：calls 走闭包原地登记（streamNative/streamPromptTools 内部 push）
            const { message, usage } =
              nativeTools ? await streamNative(calls) : await streamPromptTools(calls)
            return { message, usage, calls }
          })()
      // API/降级路径的 calls 走闭包原地登记；自持路径的救援 calls 在返回值里
      const allCalls = selfContained ? outcome.calls : calls
      const finalMsg = await finishTurn(outcome.message, allCalls)
      return { message: finalMsg, usage: outcome.usage, calls: allCalls }
    } catch (err) {
      closeOpenCalls(calls, `本轮工具未完成：${errText(err)}`)
      throw err
    }
  }

  // ---------- 主循环 ----------

  try {
    throwIfAborted() // 入口即中止 = run 从未开始：不落 user 消息、不进循环
    store.append(userMessage(input))
    for (let turn = 1; ; turn++) {
      throwIfAborted()
      const outcome = await runTurn()
      emit({ type: 'turn-end', usage: outcome.usage })
      if (outcome.calls.length === 0) {
        emit({ type: 'done', message: outcome.message })
        return outcome.message
      }
      // 本轮含交互型调用 → 立即收口 run：toolUse 随最终消息交回调用方（渲染层 askUser 流程接管挂起/回填），
      // 不能继续下一轮——那会在没有答案的情况下让模型自己演下去
      if (outcome.calls.some((c) => c.deferred)) {
        emit({ type: 'done', message: outcome.message })
        return outcome.message
      }
      if (turn >= maxTurns) {
        // 可诊断错误：当前轮数 + 最后状态都写清，不是裸 throw——调用方拿到就能定位是不是任务过重
        const names = outcome.calls.map((c) => c.name).join('、') || '（未知工具）'
        throw new Error(
          `已达最大轮数上限：maxTurns=${maxTurns}（已跑 ${turn} 轮）。` +
            `最后一轮模型仍请求工具：${names}（本轮 ${outcome.calls.length} 个调用，均已执行并回喂）。` +
            '请拆分任务、收敛单轮工具量，或由调用方提高 maxTurns 后重试。',
        )
      }
    }
  } catch (err) {
    // 唯一 error 出口：事件给 UI，reject 给控制流，同一个 Error 对象（不双报、不静默）
    const e = toError(err)
    emit({ type: 'error', error: e })
    throw e
  }
}
