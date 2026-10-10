/**
 * ConversationStore —— 会话存储层（模型生态统一重构）。
 *
 * 定位（types.ts 铁律 1）：provider 永不接触会话。追加、快照、按 token 预算开窗、
 * 序列化落盘全在本模块；换 provider 时这里的数据一行都不用动。
 *
 * 与渲染层（src/store/useChatStore.ts）的对齐口径——两层同构但不共享类型（tsconfig 隔离）：
 *   · Message.content 是 ContentPart[]（模型语义）；ChatMessage.content 是纯文本 +
 *     toolCalls / toolResults 两翼（展示语义）。映射：text part ↔ content 字符串；
 *     toolUse part ↔ toolCalls[i]；toolResult part ↔ toolResults[i]。
 *   · 本层内部 seq ↔ ChatMessage.seq：都只用于持久化排序，不参与模型语义。
 *     Message 本身不带 id/seq——那是存储层关注点，不进全仓契约（types.ts 不改）。
 *   · 摘要槽位 ↔ ChatMessage 切片的 lastSummary / contextSummary：都不在消息列表里。
 *
 * 设计要点（为什么这么设计）：
 *   1. append 是唯一的消息写入口：消息一律经它克隆 + 冻结 + 分配 seq，外部绕不过
 *      顺序与不可变约定。摘要走独立槽位 setSummary（不产生 Message、不占 seq），
 *      所以「唯一写入口」对消息列表严格成立。
 *   2. snapshot() 返回冻结视图：消息入库时已深冻结，外部拿到引用也改不动内部状态，
 *      防的是「调用方改了 snapshot 结果反噬 store」这类隐性数据损坏。
 *   3. 持久化格式纯 JSON + version 字段：不写任何 provider 特有结构（toolUse.input
 *      也是通用 JSON），字段演进只在 parseEnvelope 里按版本号做升级读取，旧文件永远有路。
 *   4. provider 绑定是运行期概念（opts.provider），绝不进序列化——「换 provider 数据
 *      不变」靠的就是它不在文件里。注意与 Message.meta.provider 区分：那条是「这条消息
 *      是谁产出的」历史记账标签，属于数据，跟着消息走。
 *   5. window() 是纯视图，不删消息：历史要能向上翻页（对齐 useChatStore「历史不清除」），
 *      裁剪只发生在请求组装时。重复压缩的去重是调用方的账（见 compact.summarize 注释）。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ContentPart, Message, Role } from './types'

// ---------- 常量与内部形状 ----------

const ROLES: readonly Role[] = ['system', 'user', 'assistant', 'tool']

/** 持久化格式版本。改字段先在这里升号，再在 parseEnvelope 里写升级读取分支。 */
const FORMAT_VERSION = 1 as const

/**
 * 内部条目：seq 是持久化排序用的自增号。
 * 为什么不塞进 Message：types.ts 是全仓唯一契约，往 meta 里加 seq 就是新造 Message 形状；
 * 包一层条目既拿到排序能力，又让 Message 保持 provider 无关的纯数据。
 */
interface StoreEntry {
  seq: number
  msg: Message
}

/** 落盘信封：纯 JSON、可迁移。刻意不含 persistPath/provider（本地与运行期概念）。 */
interface PersistedEnvelope {
  version: typeof FORMAT_VERSION
  id: string
  /** 摘要槽位原文（见 setSummary）；null = 无摘要 */
  summary: string | null
  entries: { seq: number; message: Message }[]
}

export interface ConversationStoreOptions {
  /** 会话身份（持久化往返保留）；缺省自动生成 */
  id?: string
  /**
   * 落盘路径。给出后 save() 写这里；构造时若文件已存在则续载（seq 从旧数据续接）。
   * 文件损坏直接抛错而不是静默开新会话——后者会在下次 save() 时把坏文件覆盖掉，数据就真没了。
   */
  persistPath?: string
  /**
   * 运行期 provider 绑定（可选）：标记「这个会话当前挂在谁身上」。
   * 不进序列化（换 provider 时数据零改动）；与 Message.meta.provider 不是一回事，见文件头。
   */
  provider?: string
}

// ---------- 不可变性与校验 ----------

/**
 * 深冻结：递归冻到叶子，外拿到任何一层引用都写不动。
 * 为什么不用 structuredClone：契约要求消息是纯 JSON（可迁移的前提），
 * JSON 往返同时完成克隆与「确实可序列化」的校验——非 JSON 值在这里就现形，
 * 比落盘后才发现静默丢字段要好。
 */
function cloneAndFreeze<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T
  deepFreeze(copy)
  return copy
}

/** 就地深冻结（void 返回：冻结是副作用，返回值再走泛型会被 Readonly<T> → T 卡住） */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  if (Object.isFrozen(obj)) return // 自引用防护：契约内是树，但终止条件不能省
  for (const key of Object.keys(obj)) deepFreeze(obj[key])
  Object.freeze(obj)
}

/** Message 最低形状校验（不写 schema 校验器：字段就这几个，手工判别报错更可读） */
function assertMessage(raw: unknown, where: string): Message {
  const m = raw as Message | null | undefined
  if (!m || typeof m !== 'object' || typeof m.role !== 'string' || !Array.isArray(m.content)) {
    throw new Error(`${where} 不是合法 Message：需要 { role, content: ContentPart[] }`)
  }
  if (!ROLES.includes(m.role)) {
    throw new Error(`${where}.role 非法：${String(m.role)}（只认 system/user/assistant/tool）`)
  }
  return m
}

// ---------- 类 ----------

export class ConversationStore {
  readonly id: string
  /** 运行期 provider 绑定；不进 toJSON（换 provider 数据不变） */
  readonly provider: string | null
  readonly persistPath: string | null

  private entries: StoreEntry[] = []
  /** 下一个自增 seq。恢复时取 max(seq)+1 续接，不落盘双写（两处真源必然走失一个） */
  private nextSeq = 1
  private summarySlot: string | null = null

  constructor(opts: ConversationStoreOptions = {}) {
    this.provider = opts.provider ?? null
    this.persistPath = opts.persistPath ?? null
    if (this.persistPath && existsSync(this.persistPath)) {
      // 续载旧会话：seq 从旧数据续接，追加顺序在跨进程重启后依然单调
      const restored = parseEnvelope(readFileSync(this.persistPath, 'utf8'))
      this.id = opts.id ?? restored.id
      this.summarySlot = restored.summary
      this.entries = restored.entries
      this.nextSeq = restored.entries.length > 0
        ? restored.entries[restored.entries.length - 1].seq + 1
        : 1
      return
    }
    this.id = opts.id ?? randomUUID()
  }

  // ---------- 写入口 ----------

  /**
   * 唯一的消息写入口：克隆 + 冻结 + 分配 seq。
   * 入参非法直接抛——写入口必须严格，宽进会让脏数据一路流进持久化文件。
   * 注意：入参会被克隆后丢弃，调用方手里的对象保持原样（store 不抢外部所有权）。
   */
  append(msg: Message): void {
    const checked = assertMessage(msg, 'append 入参')
    this.entries.push({ seq: this.nextSeq++, msg: cloneAndFreeze(checked) })
  }

  /**
   * 摘要槽位写入（唯一非消息写入口；配合 compact.applySummary 使用）。
   * 为什么是槽位而不是真插一条 system 消息：
   *   · 插队会破坏「seq 单调 = 追加顺序」，等于给 append 开后门；
   *   · 摘要不在消息列表里，window() 裁剪永远不会把它裁掉——它是压缩的产物，必须活过窗口；
   *   · 持久化只多一个 summary 字段，可迁移性不受影响。
   * 消费侧：snapshot()/window() 已把槽位物化成置顶 system 消息（SUMMARY_HEADER 标题），
   * 请求组装时不要再单独注入一遍。传 null（或空串）= 清空：「没有值得记的」也是结论，
   * last-write-wins，不留旧摘要误导模型。
   */
  setSummary(summary: string | null): void {
    const text = (summary ?? '').trim()
    this.summarySlot = text ? text : null
  }

  /**
   * 稳定点落盘（对齐 useChatStore「只在稳定点落库」纪律）：同步写 JSON。
   * 时机由调用方定（一轮对话收口 / 会话收尾），不做每条 append 的 write-through——
   * 同步写文件进消息热路径会把对话主链路拖死。
   */
  save(): void {
    if (!this.persistPath) {
      throw new Error('ConversationStore.save() 需要构造时传 persistPath')
    }
    writeFileSync(this.persistPath, this.toJSON(), 'utf8')
  }

  // ---------- 读视图 ----------

  /** 摘要槽位原文（不含展示用标题）；null = 无摘要 */
  get summary(): string | null {
    return this.summarySlot
  }

  /**
   * 不可变视图：数组冻结 + 元素已在入库时深冻结，外部既改不了元素也改不了顺序。
   * 摘要槽位若存在，物化为置顶 system 消息（SUMMARY_HEADER），拿到的就是可直接发请求的列表。
   */
  snapshot(): readonly Message[] {
    return Object.freeze(this.materialize())
  }

  /**
   * 按 token 预算开窗（纯视图，不改内部状态）。起点选择三层，越往后优先级越高：
   *   1. 预算层：system 永不丢弃（丢了等于换人格），其 token 先从预算里扣；
   *      其余消息从最新往回收，下限保底最新一条（空窗口毫无意义，且会立刻再次触发压缩）。
   *   2. 结构层（硬）：窗口开头不能是孤立 toolResult——toolUse 落在窗口外会被 provider 判 400。
   *      撞上就向前补齐配对的 toolUse；没有供给方的孤儿结果只能丢。预算在这里让步。
   *   3. user 锚点层（软，有上限）：窗口以 assistant 开头对部分厂商非法（见 USER_ANCHOR_SLACK）。
   *      代价在上限内就回补到最近的 user；超上限则保结构边界，把首条引导帧留给 wire 层。
   * dropped 保持原顺序返回，交给 compact.summarize 蒸摘要；store 里的原消息不动（历史可回看）。
   */
  window(
    maxTokens: number,
    estimate: (m: Message) => number,
  ): { kept: Message[]; dropped: Message[] } {
    const msgs = this.materialize()
    const cost = (m: Message): number => {
      const n = estimate(m)
      return Number.isFinite(n) && n > 0 ? n : 0 // 负数/NaN 当 0：预算循环不能被坏估算带崩
    }
    const isSystem = (m: Message): boolean => m.role === 'system'

    // system 固定开销先扣（永不丢弃，但要让调用方的预算为此买单）
    let budget = maxTokens
    for (const m of msgs) if (isSystem(m)) budget -= cost(m)

    // 非 system 消息的下标轨，从尾部往回收
    const track: number[] = []
    for (let i = 0; i < msgs.length; i++) if (!isSystem(msgs[i])) track.push(i)

    let start = track.length // 全不收（只有 system 或空会话）
    if (track.length > 0) {
      // 下限：最新一条必收
      start = track.length - 1
      let used = cost(msgs[track[start]])
      for (let k = track.length - 2; k >= 0; k--) {
        const c = cost(msgs[track[k]])
        if (used + c > budget) break
        used += c
        start = k
      }
    }

    // 结构层：窗口首条不得携带 toolResult（其 toolUse 必在窗口外 = 孤儿）
    while (start < track.length && hasToolResult(msgs[track[start]])) {
      const idx = track[start]
      const need = toolResultIds(msgs[idx])
      // 只认 assistant 为 toolUse 的供给方（types.ts 的语义归属）
      let providerIdx = -1
      for (let j = idx - 1; j >= 0; j--) {
        if (msgs[j].role === 'assistant' && hasToolUseAny(msgs[j], need)) {
          providerIdx = j
          break
        }
      }
      if (providerIdx === -1) {
        // 没有配对 toolUse 的孤儿结果：只能丢（进 dropped），窗口从下一条重算
        start++
        continue
      }
      // 补进供给方；它自己若也带 toolResult，下一轮继续向前补（下标严格递减，必然终止）
      start = track.indexOf(providerIdx)
    }

    // user 锚点层：结构边界落在 assistant 上时，看代价内能不能回到 user
    if (start < track.length && msgs[track[start]].role !== 'user') {
      const slack = maxTokens * USER_ANCHOR_SLACK
      let anchor = -1
      let extra = 0
      for (let k = start - 1; k >= 0; k--) {
        extra += cost(msgs[track[k]])
        if (msgs[track[k]].role === 'user') {
          anchor = k
          break
        }
      }
      // 代价在上限内才回补；否则保结构边界（压缩不能被 user 锚点杀死）
      if (anchor >= 0 && extra <= slack) start = anchor
    }

    const startIdx = start < track.length ? track[start] : msgs.length
    const kept: Message[] = []
    const dropped: Message[] = []
    for (let i = 0; i < msgs.length; i++) {
      if (isSystem(msgs[i])) kept.push(msgs[i]) // system 无条件保留（含摘要物化块）
      else if (i >= startIdx) kept.push(msgs[i])
      else dropped.push(msgs[i])
    }
    return { kept, dropped }
  }

  // ---------- 序列化 ----------

  /**
   * 纯 JSON 序列化（格式见 PersistedEnvelope）。带 version 是可迁移的前提：
   * 将来字段演进在 parseEnvelope 里按版本号升级读取，旧文件永远有路。
   */
  toJSON(): string {
    const envelope: PersistedEnvelope = {
      version: FORMAT_VERSION,
      id: this.id,
      summary: this.summarySlot,
      entries: this.entries.map((e) => ({ seq: e.seq, message: e.msg })),
    }
    return JSON.stringify(envelope, null, 2)
  }

  /**
   * 从 JSON 重建（纯函数，不碰文件系统——文件读取是构造器 persistPath 的事）。
   * 恢复时按 seq 排序（手工编辑/未来迁移的文件不保证物理序），消息克隆冻结后入库。
   */
  static fromJSON(raw: string): ConversationStore {
    const restored = parseEnvelope(raw)
    const store = new ConversationStore({ id: restored.id })
    store.entries = restored.entries
    store.summarySlot = restored.summary
    store.nextSeq = restored.entries.length > 0
      ? restored.entries[restored.entries.length - 1].seq + 1
      : 1
    return store
  }

  // ---------- 内部 ----------

  /**
   * 请求组装视图：摘要槽位物化为置顶 system 消息 + 全量消息（seq 序）。
   * 摘要的展示标题与 storage 原文分离——文件里存原文（好检视、好再压缩），
   * 发给模型时带标题（模型才知道这段是被压缩过的旧史）。
   */
  private materialize(): Message[] {
    const head: Message[] = this.summarySlot
      ? [cloneAndFreeze({
          role: 'system' as const,
          content: [{ type: 'text' as const, text: `${SUMMARY_HEADER}\n${this.summarySlot}` }],
        })]
      : []
    return [...head, ...this.entries.map((e) => e.msg)]
  }
}

/**
 * 摘要块标题。措辞对齐渲染层 useChatStore 的 contextSummaryBlock
 * （「【早期对话摘要（原始历史已压缩）】」）——两边最终都拼进同一条 system，
 * 标题不一致会让模型以为是两份材料。改动需与渲染层同步。
 */
export const SUMMARY_HEADER = '【早期对话摘要（原始历史已压缩）】'

/**
 * window() 回补 user 边界的代价上限（相对 maxTokens 的比例）。
 * 为什么要回补：部分厂商要求对话以 user 开头（见 src/utils/chatHistory.ts windowSlice 注释，
 * ai-api.ts 的 Anthropic 转换也不做首条归一）——窗口以 assistant 开头在那条协议上是 400。
 * 为什么要设上限：唯一 user 在会话开头的长工具流里，无上限回补 = 回补整段历史，
 * dropped 恒为空、压缩永不触发——本模块存在的意义就没了。取舍：
 *   · 回补代价 ≤ maxTokens × 本系数 → 补到 user（覆盖常见对话/短工具流，走安全侧）
 *   · 超过 → 保结构边界（可能以 assistant 开头），压缩继续有效；
 *     首条引导帧属于 wire 层异构细节，由 provider 映射补（types.ts 铁律 3）。
 */
export const USER_ANCHOR_SLACK = 0.25

// ---------- 落盘解析 ----------

/** 信封解析 + 校验 + 克隆冻结。throws：坏文件宁可报错也不静默丢历史。 */
function parseEnvelope(raw: string): { id: string; summary: string | null; entries: StoreEntry[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`会话 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const env = parsed as Partial<PersistedEnvelope> | null
  if (!env || typeof env !== 'object' || !Array.isArray(env.entries)) {
    throw new Error('文件格式不符：需要 { version: 1, id, summary, entries: [{ seq, message }] }')
  }
  if (env.version !== FORMAT_VERSION) {
    // 迁移口子：version 2 在这里加升级分支（v1 数据 → v2 结构），旧文件永远读得进来
    throw new Error(`不支持的会话格式版本：${String(env.version)}（当前只认 version: ${FORMAT_VERSION}）`)
  }

  const seen = new Set<number>()
  const entries: StoreEntry[] = []
  for (let i = 0; i < env.entries.length; i++) {
    const item = env.entries[i] as { seq?: unknown; message?: unknown } | null
    const seq = item?.seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
      throw new Error(`entries[${i}].seq 不是正整数：${String(seq)}`)
    }
    if (seen.has(seq)) throw new Error(`entries[${i}].seq 重复：${seq}（排序唯一性被破坏）`)
    seen.add(seq)
    entries.push({ seq, msg: cloneAndFreeze(assertMessage(item?.message, `entries[${i}].message`)) })
  }
  entries.sort((a, b) => a.seq - b.seq)

  // id 缺失兜底生成：手写/旧文件不该因此读不进来（但有 id 就必须原样保留）
  const id = typeof env.id === 'string' && env.id.length > 0 ? env.id : randomUUID()
  const summary = typeof env.summary === 'string' && env.summary.trim() ? env.summary.trim() : null
  return { id, summary, entries }
}

// ---------- ContentPart 结构探针（window 的孤儿配对用） ----------

function hasToolResult(m: Message): boolean {
  return m.content.some((p) => p.type === 'toolResult')
}

function toolResultIds(m: Message): string[] {
  const ids: string[] = []
  for (const p of m.content) {
    if (p.type === 'toolResult') ids.push(p.toolUseId)
  }
  return ids
}

function hasToolUseAny(m: Message, ids: string[]): boolean {
  if (ids.length === 0) return false
  const want = new Set(ids)
  return m.content.some((p: ContentPart) => p.type === 'toolUse' && want.has(p.id))
}
