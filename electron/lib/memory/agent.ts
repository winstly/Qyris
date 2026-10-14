/**
 * mem agent —— 记忆蒸馏管线（headless agent + tools，旁路，永不阻塞对话）。
 * 设计口径：
 *  - 触发三口（渲染层经 IPC 驱动，主进程持游标与频控）：
 *      memoryMaybeExtract 滚动提取：自 cursor 起新增 assistant ≥6 轮且距上次提取 ≥60s；
 *      sessionEnded      收尾提取：cursor 后有内容即跑（无视阈值/冷却），完成后 cursor 作废；
 *      memoryRunNow      手动「立即整理」：对当前 session 立即增量提取（无视冷却，仍防并发）。
 *  - 输入 = 增量转录（纯 user/assistant 原文 + 工具名/一行摘要，不付工具结果 token，memU 双
 *    transcript 纪律）+ 现有长期记忆标题清单（渐进披露）；单次输入 12000 字符封顶，超出取最新。
 *  - 执行 = runAgent + memory 域工具白名单（与主对话同一条 agent+tools 链路，无自有协议层）：
 *      API 档 → runner 原生 tool-call 循环；CLI 档 → MCP 自持循环（provider-resolve 装配）。
 *      记忆写入由工具执行即完成（memory_save/update/archive 直落 mem_items），无「收集 ops
 *      再回放」的中间层；滚动 summary 取收尾正文。轮数 3 封顶（发工具 + 收尾 + 余量）。
 *  - 安全面：工具白名单只含 memory 域（read/write 记忆，无 fs/shell）——蒸馏不持工程写权限；
 *      白名单经 mcp includeTools 注入 CLI 档 MCP 面（server.ts 暴露面过滤）。
 *  - 防自食：store 为内存 ConversationStore（即焚，绝不写 messages 表），断言见 smoke ③。
 *  - 并发防护：per-project 串行队列 + 提取中标志，同 (project, session) 重复触发合并。
 *  - 失败退避（P3）：连续失败按 min(2^count×60s, 30min) 退避，maybe_extract/run_now
 *    窗口内直接跳过；成功归零。
 * 测试钩子：setProviderOverride（注入假 provider，同时绕过启用检查）/ setClock（注入假时钟），
 * smoke 全链路离线可测。
 */
import type { SqliteDb } from '../db'
import { basename } from 'node:path'
import { getDb, projectKey } from '../db'
import { getConfig } from '../config'
import { resolveChatProvider } from '../model/provider-resolve'
import { runAgent, type RunnerEvent } from '../model/runner'
import { ConversationStore } from '../model/store'
import type { ContentPart, ModelProvider, Tool, ToolResult } from '../model/types'
import type { MemoryLastTidy } from '../../../shared/ipc-types'
import { openHostToolProxy, type HostToolProxyEndpoint } from '../mcp/proxy'
import { executeTool, toolsForPermission } from '../tools'
import { emitToAllWindows } from '../emitter'
import * as service from './service'

// ---------- 纪律条款（memU 移植） ----------

const DISCIPLINE = `铁律：
1. 空操作是完全合格的产出——不要为了证明跑过而编造记忆
2. 合并优先于新建：与现有记忆同主题时，更新原条目（memory_update 的 id 从【现有记忆清单】里取），不要另起一条
3. scope 看内容指向哪个工程（【当前工程】= 本次蒸馏所属工程，见输入）：内容讲的是【当前工程】自身的事才产出；讲别的具名工程（哪怕是排查它的故障、哪怕转录里出现它的名字）→ no-op，绝不产出；两可（分不清指向哪个工程）→ 也 no-op。宁可漏记，不许串工程污染
4. 只记稳定事实：用户偏好（包管理器/代码风格/工作流习惯）、项目结构与选型事实、踩坑教训、可复用的工作流技能；一次性的任务细节不值得记
5. 读不到的不许猜：转录里没有的不要脑补；工具结果里的密钥/token/密码绝对不能进记忆
6. title 一行以内，具体不含糊（「包管理器用 pnpm」好，「用户偏好」坏）；事件类记录必须锚定绝对日期（「周四」要写成「2026-10-15」——相对时间无法追溯）
7. 关系裁决（动手前先 memory_search 语义近邻，四选一）：无等价 → memory_save 新建；互补增强且更全 → memory_update；被推翻/取代 → 用同题 memory_save 提交新表述（旧行自动留痕）或 memory_update 带 supersedes；都不满足 → 不调用
8. 显式条目（来源标注「你保存的」）不许 memory_archive——它过时时用同题 memory_save 取代，新表述自动接管保护

scope 与 category 的绑定（关键）：
- preference = 用户偏好（个人编码风格/工具链/工作流习惯），恒 scope="user"——项目技术选型不是 preference
- 项目技术选型/约定（如「本项目用 sqlite-vec」）记 fact + scope="project"
- 其余类别用换工程测试判定 scope——把这条知识拿到一个完全不相关的新工程里，还对吗？
  对 → "user"（跨工程通用：个人编码偏好、常用工具链/包管理器、通用环境常识、工作流习惯）
  不对/没意义 → "project"（仅本工程：目录结构、技术选型与约定、接口配置、本项目踩坑教训）
- scope 判定的前置是铁律 3：内容必须指向【当前工程】才谈 scope；指向别的具名工程或两可 → 直接 no-op
- 【现有记忆清单】为「（暂无）」时是首次蒸馏：更倾向新建，但依然只记稳定事实、禁止编造`

const PROMPT_HEAD = `你是记忆蒸馏器。输入分两节：【增量转录】是开发会话的新增消息（#序号 + 发言人 + 内容，工具调用压成一行摘要）；【现有记忆清单】是已沉淀的长期记忆与本会话短期记忆（- [分类] 标题（id））。你的唯一任务：判断增量转录里是否有值得长期记住的稳定事实并提交记忆操作。`

/** 蒸馏系统提示（唯一版）：纪律 + 工具提交通道，无 JSON 拼写负担 */
export const SYSTEM_PROMPT = `${PROMPT_HEAD}

${DISCIPLINE}

提交方式（结构化协议，不要在正文里手写 JSON）：
- 有值得记住的稳定事实 → 调用 memory_save / memory_update / memory_archive 工具提交，相互独立可并行多个
- 滚动摘要写在最终回复正文里；没有可记内容时不调用任何工具，正文即为摘要（可为空）
- 字符串值内避免英文双引号与反斜杠`

// ---------- 常量 ----------

/** 滚动提取阈值缺省值：自 cursor 起新增 assistant 消息条数（设置页可配，config.memExtractRounds） */
const ASSISTANT_ROUNDS_THRESHOLD = 6
/** 距上次提取的最小间隔（冷却） */
const EXTRACT_COOLDOWN_MS = 60_000
/** 单次提取的转录字符预算（超出取最新，头部截断标注「（更早已省略）」） */
const TRANSCRIPT_CHAR_LIMIT = 12_000
/** 单条消息正文封顶（防单条超长吃光预算，保证最新一条必入选、游标不空转） */
const ROW_CHAR_CAP = 6_000
/** 注入 prompt 的现有长期记忆标题条数上限 */
const CONTEXT_TITLES_LIMIT = 40
/** 工具一行摘要截断长度 */
const TOOL_SUMMARY_MAX = 80

/** 蒸馏工具白名单（runner 执行面与 CLI MCP 面同一名单；write 档下即 memory 域四工具） */
const DISTILL_TOOLS = ['memory_search', 'memory_save', 'memory_update', 'memory_archive']
/** 蒸馏 agent 轮数：一轮发工具 + 一轮收尾，余量 1 */
const DISTILL_MAX_TURNS = 3
/** 每轮操作预算：防幻觉批量调用（一次抽风不许批量清洗记忆库），超限 isError 让模型收手 */
const DISTILL_OP_BUDGET: Record<string, number> = { memory_save: 3, memory_update: 3, memory_archive: 2 }

/** 本轮操作预算计数（每次提取重置）：API 档经 withOpBudget 装饰 Tool.execute；CLI 档经
 *  代行通道 executor 计数——两条执行路共用同一计数，预算两档同口径。 */
let opBudgetUsed = new Map<string, number>()

/** 预算闸门：超限回 isError（模型收手，本轮不再写） */
function budgetGate(name: string): ToolResult | null {
  const cap = DISTILL_OP_BUDGET[name]
  if (!cap) return null
  const n = (opBudgetUsed.get(name) ?? 0) + 1
  opBudgetUsed.set(name, n)
  if (n > cap) {
    return { content: `[${name}] 本轮操作预算已用尽（${cap} 次），剩余操作请下一轮蒸馏再提。`, isError: true }
  }
  return null
}

/** 给工具面加每轮预算（API 档 runner 直调 execute 的包装） */
function withOpBudget(tools: readonly Tool[]): Tool[] {
  return tools.map((t) => {
    if (!DISTILL_OP_BUDGET[t.name]) return t
    return {
      ...t,
      async execute(input, ctx): Promise<ToolResult> {
        const rejected = budgetGate(t.name)
        if (rejected) return rejected
        return t.execute(input, ctx)
      },
    }
  })
}

// ---------- 触发状态（游标 / 频控 / 并发） ----------

interface SessionCursor {
  /** 上次提取到的 messages.seq（含） */
  cursor: number
  /** 上次提取完成时刻（假时钟可注入） */
  lastRunAt: number
}

/** (projectKey, sessionId) → 游标 */
const cursors = new Map<string, SessionCursor>()
/** projectKey → 最近活跃 sessionId（memoryRunNow 定位「当前 session」用） */
const lastSession = new Map<string, string>()
/** projectKey → per-project 串行队列尾 */
const queues = new Map<string, Promise<unknown>>()
/** 提取中/已排队的 (projectKey, sessionId)（重复触发合并） */
const pending = new Set<string>()

/** 该工程当前是否有提取在排队/执行（渲染层「整理中」状态源 + 查询通道） */
export function isExtracting(projectRoot: string): boolean {
  const prefix = `${projectKey(projectRoot)}|`
  for (const k of pending) if (k.startsWith(prefix)) return true
  return false
}

/** 广播提取状态变化（整理开始/结束），渲染层据此切换「整理中」并禁用非查询操作 */
function emitExtractState(projectRoot: string): void {
  emitToAllWindows('memory-extract-state', { projectRoot, extracting: isExtracting(projectRoot) })
}

// ---------- 连续失败退避（P3：LLM 故障时不再按冷却节拍反复打水漂请求） ----------

/** 连续 LLM 失败计数（成功归零） */
let failCount = 0
/** 退避窗口截止时刻（clock 可注入，smoke 可测） */
let backoffUntil = 0
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 30 * 60_000

/** 退避时长 = min(2^count × 60s, 30min) */
function backoffDelayFor(count: number): number {
  return Math.min(2 ** count * BACKOFF_BASE_MS, BACKOFF_MAX_MS)
}

function inBackoff(): boolean {
  return clock() < backoffUntil
}

function cursorKey(projectRoot: string, sessionId: string): string {
  return `${projectKey(projectRoot)}|${sessionId}`
}

// ---------- 游标持久化（meta 表，跨重启存活） ----------
// 游标语义 =「该 session 已蒸馏到的 messages.seq」。内存 Map 是缓存，meta 是事实源：
// 重启后内存态清零，若不持久化，首见游标只能落 maxSeq（存量内容被误标为已蒸馏）或 0
// （每次重启全量重扫）。持久化后：有过游标的会话重启即恢复，从无游标的会话基线 0
// （从未蒸馏过的内容——含新会话第一轮——首轮触发即纳入提取窗口）。

const CURSOR_META_PREFIX = 'mem_cursor:'

/** 读持久化游标：无记录回 null（从未蒸馏），有记录回 seq 数值（含 0） */
async function loadPersistedCursor(db: SqliteDb, ck: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(CURSOR_META_PREFIX + ck) as { value: string } | undefined
  if (!row?.value) return null
  const n = Number(row.value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 游标推进落盘（异步短写，失败不阻塞提取主流程） */
async function persistCursor(db: SqliteDb, ck: string, cursor: number): Promise<void> {
  try {
    await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(CURSOR_META_PREFIX + ck, String(cursor))
  } catch (e) {
    console.warn(`[mem-agent] 游标持久化失败（下次触发重扫窗口）：${String(e)}`)
  }
}

/** 游标作废（会话收尾）：内存 + meta 一并清 */
async function deletePersistedCursor(db: SqliteDb, ck: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM meta WHERE key = ?').run(CURSOR_META_PREFIX + ck)
  } catch { /* 作废失败无害：最多多扫一次窗口 */ }
}

async function maxSeqOf(db: SqliteDb, key: string, sessionId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE project_key = ? AND session_id = ?')
    .get(key, sessionId) as { seq: number }
  return Number(row?.seq ?? 0)
}

// ---------- 测试钩子 ----------

let providerOverride: ModelProvider | null = null

/** 注入假 provider（smoke 用）；置 null 恢复真实现。存在时绕过启用检查（离线可测） */
export function setProviderOverride(p: ModelProvider | null): void {
  providerOverride = p
}

let clock: () => number = () => Date.now()

/** 注入假时钟（smoke 测 60s 冷却）；置 null 恢复 Date.now */
export function setClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now())
}

/** 清空全部进程态（游标/队列/并发/退避），模拟重启；smoke 测游标持久化用 */
export function resetExtractStateForTest(): void {
  cursors.clear()
  lastSession.clear()
  queues.clear()
  pending.clear()
  failCount = 0
  backoffUntil = 0
}

// ---------- 触发三口（IPC 契约，见 main/index.ts 与 preload/index.ts） ----------

/** 退避自愈计数器：连续被跳过的 maybeExtract 调用次数（用于周期性日志） */
let skippedCount = 0

/** 滚动提取触发（渲染层每轮 assistant 收尾后调用；不满足阈值/冷却时为空操作） */
export async function memoryMaybeExtract(projectRoot: string, sessionId: string): Promise<void> {
  const key = projectKey(projectRoot)
  const ck = cursorKey(projectRoot, sessionId)
  lastSession.set(key, sessionId)
  const db = await getDb()
  let cur = cursors.get(ck)
  if (!cur) {
    // 首见：优先恢复持久化游标（重启/接管场景，含基线 0 的记录）；无持久化记录 = 从未蒸馏 →
    // 基线 0（该会话历史整体进蒸馏窗口）。旧的 MAX(seq) 回退会把首轮误标为已蒸馏、
    // 新会话前 N 轮即进蒸馏窗口；存量长会话的重扫规模由转录预算兜底。
    const persisted = await loadPersistedCursor(db, ck)
    if (persisted !== null) {
      cur = { cursor: persisted, lastRunAt: 0 }
    } else {
      cur = { cursor: 0, lastRunAt: 0 }
      // 落盘基线 0：重启后恢复的是「从头蒸馏」而不是再次落进首见分支
      await persistCursor(db, ck, 0)
    }
    cursors.set(ck, cur)
  }

  // 退避自愈：退避窗口已过期 + 连续失败 ≥3 → 自动归零（防永久卡退避）
  if (failCount >= 3 && !inBackoff()) {
    console.warn(`[mem-agent] 退避窗口已过期，自动归零 failCount=${failCount}（之前连续失败 ${failCount} 次）`)
    failCount = 0
    backoffUntil = 0
  }

  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE project_key = ? AND session_id = ? AND seq > ? AND role = 'assistant'",
    )
    .get(key, sessionId, cur.cursor) as { n: number }
  // 阈值可配（设置页「记忆整理触发轮次」，config.ts 已归一到 2..60）；未配置回缺省 6
  const cfg = await getConfig()
  const threshold = cfg.memExtractRounds ?? ASSISTANT_ROUNDS_THRESHOLD
  const assistantCount = Number(row.n)

  if (assistantCount < threshold) {
    // 每 5 次未达阈值的调用打一条 debug 日志（定位「对话很多但不触发」场景）
    skippedCount++
    if (skippedCount % 5 === 1) {
      console.debug(`[mem-agent] 未达阈值：assistant=${assistantCount}/${threshold}，cursor=${cur.cursor}，冷却=${clock() - cur.lastRunAt < EXTRACT_COOLDOWN_MS}，退避=${inBackoff()}`)
    }
    return
  }
  skippedCount = 0 // 重置
  if (clock() - cur.lastRunAt < EXTRACT_COOLDOWN_MS) return
  if (inBackoff()) return // 退避窗口内静默跳过（游标不动，窗口过后照常重试）
  await enqueueExtract(projectRoot, sessionId, 'incremental')
}

/** 会话收尾（渲染层 clear() 时调用）：cursor 后有内容则收尾提取，完成后 cursor 作废。
 *  游标缺席且无持久化记录 = 本进程从未触发过提取且库中无游标 → 跳过（不回溯蒸馏旧会话）。
 *  但有持久化游标（进程重启后恢复）= 该 session 之前提取过 → 恢复游标后收尾。
 *  保证重复 session_ended 幂等（游标作废后再次调用无持久化记录即跳过）。 */
export async function sessionEnded(projectRoot: string, sessionId: string): Promise<void> {
  const key = projectKey(projectRoot)
  const ck = cursorKey(projectRoot, sessionId)
  lastSession.delete(key) // 该 session 即将换代，不再是「当前」（新会话由后续 maybe_extract 登记）
  let cur = cursors.get(ck)
  if (!cur) {
    // 恢复持久化游标（进程重启场景）；无持久化记录 = 从未提取过 → 跳过
    const db = await getDb()
    const persisted = await loadPersistedCursor(db, ck)
    if (persisted === null) return // 从未提取过且无游标 → 不回溯
    cur = { cursor: persisted, lastRunAt: 0 }
    cursors.set(ck, cur)
  }
  const db = await getDb()
  const max = await maxSeqOf(db, key, sessionId)
  if (max <= cur.cursor) {
    cursors.delete(ck)
    await deletePersistedCursor(db, ck)
    return
  }
  await enqueueExtract(projectRoot, sessionId, 'final')
  cursors.delete(ck) // 收尾完成，游标作废
  await deletePersistedCursor(db, ck)
}

/** 从 messages 表查该工程最新 session_id（lastSession 缓存未命中时兜底） */
async function latestSessionId(projectRoot: string): Promise<string | null> {
  const db = await getDb()
  const row = await db
    .prepare('SELECT session_id FROM messages WHERE project_key = ? ORDER BY created_at DESC LIMIT 1')
    .get(projectKey(projectRoot)) as { session_id: string } | undefined
  return row?.session_id ?? null
}

/** 手动「立即整理」（记忆面板按钮）：对当前 session 立即增量提取（无视冷却，仍防并发）。
 *  未启用回 ok=false；无会话时从 messages 表兜底查找。返回 ops 供面板区分"有产出"和"no-op"。
 *  不预建 provider 做启用探测（避免一次整理装配两遍模型链路）：runExtraction 内解析失败
 *  会记 lastDisabledReason，这里统一收口成同一个错误文案。 */
export async function memoryRunNow(projectRoot: string): Promise<{ ok: boolean; error?: string; ops?: number; tidy?: MemoryLastTidy | null }> {
  const key = projectKey(projectRoot)
  const sessionId = lastSession.get(key) ?? await latestSessionId(projectRoot)
  if (!sessionId) return { ok: false, error: '当前无活跃会话，请先发送一条消息。' }
  const ck = cursorKey(projectRoot, sessionId)
  if (pending.has(ck)) return { ok: false, error: '已有提取在进行中，请稍候。' }
  if (!cursors.has(ck)) {
    const db = await getDb()
    cursors.set(ck, { cursor: (await loadPersistedCursor(db, ck)) ?? 0, lastRunAt: 0 })
  }
  lastDisabledReason = null
  const result = await enqueueExtractWithResult(projectRoot, sessionId, 'manual')
  if (lastDisabledReason) {
    const reason = lastDisabledReason
    lastDisabledReason = null
    return { ok: false, error: `记忆蒸馏未启用：${reason}。请在设置中配置 AI 助手。` }
  }
  if (lastExtractError) {
    const err = lastExtractError
    lastExtractError = null
    return { ok: false, error: `提取失败：${err}` }
  }
  return { ok: true, ops: result, tidy: await service.lastTidy() }
}

// ---------- 串行队列 ----------

/** per-project 串行队列；同 (project, session) 已排队/在跑则合并（不重复入队） */
function enqueueExtract(
  projectRoot: string, sessionId: string, trigger: 'incremental' | 'final' | 'manual',
): Promise<void> {
  return enqueueExtractWithResult(projectRoot, sessionId, trigger).then(() => {})
}

function enqueueExtractWithResult(
  projectRoot: string, sessionId: string, trigger: 'incremental' | 'final' | 'manual',
): Promise<number> {
  const key = projectKey(projectRoot)
  const ck = cursorKey(projectRoot, sessionId)
  if (pending.has(ck)) return Promise.resolve(0)
  pending.add(ck)
  emitExtractState(projectRoot) // 入队/开始 → 渲染层「整理中」
  const tail: Promise<unknown> = (queues.get(key) ?? Promise.resolve()).catch(() => {})
  const task = tail
    .then(() => runExtraction(projectRoot, sessionId, trigger))
    .finally(() => {
      pending.delete(ck)
      emitExtractState(projectRoot) // 收尾 → 渲染层恢复
    })
  queues.set(key, task.catch(() => {}))
  return task
}

// ---------- 提取主流程 ----------

interface TranscriptRow {
  id: string
  seq: number
  role: string
  content: string
  tool_json: string | null
}

/** 最近一次提取错误（每次提取开始时清空，memoryRunNow 只看本轮的错误） */
let lastExtractError: string | null = null

/** 提取主流程：读增量 → 组装转录 → runAgent（工具写入即落库）→ 收尾摘要 → 推进游标。
 *  异常只告警（游标不动，下轮重试）。返回本轮成功写入的 ops 数。 */
async function runExtraction(projectRoot: string, sessionId: string, trigger: string): Promise<number> {
  lastExtractError = null // 每轮独立记账：不把上一轮的陈旧错误算进本轮
  try {
    return await runExtractionInner(projectRoot, sessionId, trigger)
  } catch (e) {
    const msg = String(e)
    lastExtractError = msg
    console.warn(`[mem-agent] 提取流程异常（游标不动，下轮重试）：${msg}`)
    return 0
  }
}

async function runExtractionInner(projectRoot: string, sessionId: string, trigger: string): Promise<number> {
  const ck = cursorKey(projectRoot, sessionId)
  const cur = cursors.get(ck)
  if (!cur) return 0
  const db = await getDb()
  const rows = await db
    .prepare(
      `SELECT id, seq, role, content, tool_json FROM messages
       WHERE project_key = ? AND session_id = ? AND seq > ? ORDER BY seq ASC`,
    )
    .all(projectKey(projectRoot), sessionId, cur.cursor) as unknown as TranscriptRow[]
  if (rows.length === 0) {
    if (trigger === 'manual') {
      // 手动触发：cursor 已到末尾但用户要求重新整理 → 重置为 0 全量重扫
      //（重复内容由 memory_save 的 createOrFoldAtomic 同题折叠，不会产生重复行）
      cursors.set(ck, { cursor: 0, lastRunAt: clock() })
      await persistCursor(db, ck, 0)
      const allRows = await db
        .prepare(`SELECT id, seq, role, content, tool_json FROM messages WHERE project_key = ? AND session_id = ? ORDER BY seq ASC`)
        .all(projectKey(projectRoot), sessionId) as unknown as TranscriptRow[]
      if (allRows.length === 0) return 0
      return await runWithProvider(projectRoot, (provider) =>
        extractWithRows(projectRoot, sessionId, trigger, ck, allRows, provider))
    }
    return 0
  }
  return await runWithProvider(projectRoot, (provider) =>
    extractWithRows(projectRoot, sessionId, trigger, ck, rows, provider))
}

/** 装配 provider 跑一次提取，收尾释放（CLI 档代行通道随 provider 生灭） */
async function runWithProvider(
  projectRoot: string,
  run: (provider: ModelProvider) => Promise<number>,
): Promise<number> {
  const built = await resolveModelProvider(projectRoot)
  if (!built) return 0
  try {
    return await run(built.provider)
  } finally {
    built.dispose()
  }
}

/** 提取公共逻辑：组装转录 → runAgent（工具写入即落库）→ 收尾摘要 → 推进游标 */
async function extractWithRows(
  projectRoot: string, sessionId: string, trigger: string,
  ck: string, rows: TranscriptRow[], provider: ModelProvider,
): Promise<number> {
  const transcript = renderTranscript(rows)
  // 空转录快路径：窗口全空（纯思考/占位轮）→ 无可提取内容，不调 LLM 直接推游标省一次调用
  if (!transcript.text.trim()) {
    cursors.set(ck, { cursor: transcript.maxSeq, lastRunAt: clock() })
    await persistCursor(await getDb(), ck, transcript.maxSeq)
    console.info(`[mem-agent] trigger=${trigger} 转录为空（${rows.length} 行全为思考/占位），跳过 LLM 直推游标`)
    return 0
  }
  // 渐进披露上下文：long（工程+global）+ 本会话 short——只给 long 会让模型看不到本会话已蒸出的
  // short/lesson，重扫时无从合并只会重复新建
  const titles = (await service.listContextTitles(projectRoot, sessionId, CONTEXT_TITLES_LIMIT))
    .map((t) => `- [${t.category}] ${t.title}（${t.id}）`)
  // 两节的角色标注进提示（memory_update / memory_archive 的 id 从清单取；「（暂无）」标记被 smoke 断言钉死）
  // 【当前工程】锚点：铁律 3 的 scope 判定基准——不给工程名，模型无从判断内容指向哪个工程，
  // 「排查 BetaProject 卡死」会被误记进当前工程的 project 记忆（串工程污染）
  const user = [
    `【当前工程】${basename(projectRoot)}`,
    '【增量转录】（#序号 发言人：内容；工具调用为一行摘要）',
    transcript.text,
    '【现有记忆清单】（- [分类] 标题（id）；memory_update / memory_archive 的 id 从这里取）',
    titles.length > 0 ? titles.join('\n') : '（暂无）',
  ].join('\n')

  // 蒸馏跑 agent+tools（与主对话同一条链路）：记忆写入由工具执行即完成，收尾正文即滚动摘要。
  // store 为内存即焚（防自食：蒸馏过程绝不写 messages 表）；system = 蒸馏纪律，随 store 进 prompt。
  // 统计口径：只数执行完且非 isError 的写操作（tool-start 在执行前触发，预算拒绝/失败也会计数；
  // CLI 档自持循环只发 tool-executed 不发 tool-start）——ops 与面板「上次整理」同源。
  opBudgetUsed = new Map()
  const callNames = new Map<string, string>()
  const opCounts = { saved: 0, updated: 0, archived: 0 }
  let usageInput = 0
  let usageOutput = 0
  let finalMessage
  try {
    const store = new ConversationStore()
    store.append({ role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }], meta: { ts: Date.now() } })
    finalMessage = await runAgent(user, {
      provider,
      tools: withOpBudget(toolsForPermission('write').filter((t) => DISTILL_TOOLS.includes(t.name))),
      toolOrigin: 'distill',
      store,
      permission: 'write',
      maxTurns: DISTILL_MAX_TURNS,
      projectRoot,
      onEvent: (ev: RunnerEvent) => {
        if (ev.type === 'tool-start') {
          callNames.set(ev.id, ev.name)
          return
        }
        if (ev.type === 'turn-end') {
          usageInput += ev.usage.inputTokens
          usageOutput += ev.usage.outputTokens
          return
        }
        if (ev.type !== 'tool-end' && ev.type !== 'tool-executed') return
        const name = ev.type === 'tool-executed' ? ev.name : callNames.get(ev.id)
        if (ev.result.isError) return
        if (name === 'memory_save') opCounts.saved++
        else if (name === 'memory_update') opCounts.updated++
        else if (name === 'memory_archive') opCounts.archived++
      },
    })
  } catch (e) {
    failCount++
    backoffUntil = clock() + backoffDelayFor(failCount)
    lastExtractError = `蒸馏 agent 失败（第${failCount}次）：${String(e)}`
    console.warn(`[mem-agent] ${lastExtractError}`)
    return 0
  }
  failCount = 0
  backoffUntil = 0

  if (usageInput > 0 || usageOutput > 0) await service.addDistillTokens(usageInput, usageOutput)
  const summary = textOfContent(finalMessage.content).trim()
  if (summary) await service.saveSessionSummary(projectRoot, sessionId, summary)
  // 「上次整理」快照：面板摘要条数据源（拆分新增/更新/归档——合说「更新 N 条」是口径谎言）
  await service.saveLastTidy({ ts: clock(), ...opCounts })
  const applied = opCounts.saved + opCounts.updated + opCounts.archived
  console.info(
    `[mem-agent] trigger=${trigger} 输入=${rows.length}条(转录${transcript.text.length}字) ` +
    `save=${opCounts.saved} update=${opCounts.updated} archive=${opCounts.archived} summary=${summary ? '有' : '无'}`,
  )
  if (applied === 0) {
    console.info(`[mem-agent] 判定 no-op（无成功写入）。转录前200字：${transcript.text.slice(0, 200)}`)
  }
  cursors.set(ck, { cursor: transcript.maxSeq, lastRunAt: clock() })
  await persistCursor(await getDb(), ck, transcript.maxSeq)
  return applied
}

// ---------- 转录组装（memU 双 transcript 纪律：不付工具结果全文 token） ----------

/** 自新向旧装配，超预算即止（取最新）；最新一条必入选（超预算时截断收录）——
 *  游标恒可推进且窗口不空转（否则该窗口内容会被永久跳过，且无任何告警）。
 *  空块（无正文无工具行的思考/占位行）整块跳过：不占预算、不给蒸馏器喂空发言信号。
 *  reason（思考过程）不进转录——转录只收陈述事实，思考里的半成品结论会教模型记幻觉。 */
function renderTranscript(rows: TranscriptRow[]): { text: string; maxSeq: number } {
  const maxSeq = rows[rows.length - 1].seq
  const lines: string[] = []
  let budget = TRANSCRIPT_CHAR_LIMIT
  let truncated = false
  for (let i = rows.length - 1; i >= 0; i--) {
    let block = renderRow(rows[i])
    if (!block) continue // 空块：跳过（不算省略）
    if (block.length > budget) {
      if (lines.length === 0) block = block.slice(0, budget) // 护栏：最新一条截断也要进转录
      else {
        truncated = true
        break
      }
    }
    budget -= block.length
    lines.unshift(block)
  }
  const text = (truncated ? ['（更早已省略）', ...lines] : lines).join('\n')
  return { text, maxSeq }
}

/** 单行渲染：无正文且无工具行 → 空串（调用方跳过）。工具行带结果一行摘要（成败信号，
 *  「踩坑教训」类记忆的依据；取持久化时的 resultSummary 首行，不付结果全文 token）。 */
function renderRow(row: TranscriptRow): string {
  const calls = parseToolCalls(row.tool_json)
  const who = row.role === 'user' ? '用户' : '助手'
  const body = row.content.length > ROW_CHAR_CAP ? `${row.content.slice(0, ROW_CHAR_CAP)}…（单条截断）` : row.content
  if (!body.trim() && calls.length === 0) return ''
  const lines = [`#${row.seq} ${who}：${body}`]
  for (const call of calls) {
    const outcome = call.resultSummary ? ` → ${call.resultSummary}` : ''
    lines.push(`  工具 ${call.name}：${toolArgSummary(call.args)}${outcome}`)
  }
  return lines.join('\n')
}

interface ParsedToolCall {
  name: string
  args: Record<string, unknown>
  /** 持久化时算好的结果一行摘要（firstLine ≤80）：只取首行，不搬结果全文 */
  resultSummary: string
}

/** tool_json 只取 toolCalls 的 name + 关键参数一行摘要 + 结果一行摘要；toolResults 整体不进 prompt */
function parseToolCalls(toolJson: string | null): ParsedToolCall[] {
  if (!toolJson) return []
  try {
    const parsed = JSON.parse(toolJson) as { toolCalls?: { name?: unknown; args?: unknown; resultSummary?: unknown }[] }
    return (Array.isArray(parsed.toolCalls) ? parsed.toolCalls : []).map((t) => ({
      name: typeof t.name === 'string' && t.name ? t.name : 'unknown',
      args: t.args && typeof t.args === 'object' ? (t.args as Record<string, unknown>) : {},
      resultSummary: typeof t.resultSummary === 'string' ? t.resultSummary.split('\n', 1)[0].slice(0, TOOL_SUMMARY_MAX) : '',
    }))
  } catch {
    return []
  }
}

/** 工具一行摘要：command / file_path（兜底 path）的第一行 80 字符 */
function toolArgSummary(args: Record<string, unknown>): string {
  const raw = args.command ?? args.file_path ?? args.path
  if (typeof raw !== 'string' || raw.length === 0) return '（无参数摘要）'
  const firstLine = raw.split('\n', 1)[0] ?? ''
  return firstLine.length > TOOL_SUMMARY_MAX ? `${firstLine.slice(0, TOOL_SUMMARY_MAX)}…` : firstLine
}

// ---------- 蒸馏 provider 装配 ----------

/** 蒸馏 provider 句柄：provider + 代行通道（CLI 档 memory 写工具经通道回主进程执行） */
interface DistillProvider {
  provider: ModelProvider
  dispose: () => void
}

/** 蒸馏 provider：与主对话同一条 resolveChatProvider 装配链（wantTools + memory 白名单）。
 *  projectRoot 透传：memory_write 类工具落库要按工程记账。
 *  CLI 档必须开代行通道：memory 写工具在 HOST_ONLY_TOOLS（落盘后要 fire 记忆变更事件），
 *  无通道时 server.ts 暴露面过滤会把它们整体剔除，蒸馏 agent 一个写工具都看不到。
 *  未配置/不可用 → disabled（静默禁用语义，不 throw——蒸馏是旁路，失败只告警）。 */
async function resolveModelProvider(projectRoot: string): Promise<DistillProvider | null> {
  if (providerOverride) return { provider: providerOverride, dispose: () => {} }
  const cfg = await getConfig()
  const dispatchMode = cfg.aiDispatchMode ?? 'api'
  let hostProxy: HostToolProxyEndpoint | null = null
  try {
    if (dispatchMode === 'claude-cli') {
      hostProxy = await openHostToolProxy((name, input) => {
        if (!DISTILL_TOOLS.includes(name)) {
          return Promise.resolve({ content: `蒸馏工具面不含 ${name}`, isError: true })
        }
        const rejected = budgetGate(name)
        if (rejected) return Promise.resolve(rejected)
        return executeTool(name, input, { projectRoot, permission: 'write', origin: 'distill' })
      })
    }
    const provider = await resolveChatProvider({
      dispatchMode,
      provider: cfg.aiProvider ?? '',
      baseUrl: cfg.aiBaseUrl ?? '',
      model: cfg.aiModel ?? '',
      projectRoot,
      cfg,
      permission: 'write',
      wantTools: true,
      hostProxy,
      includeTools: DISTILL_TOOLS,
      toolOrigin: 'distill',
    })
    return { provider, dispose: () => { hostProxy?.close() } }
  } catch (e) {
    hostProxy?.close()
    return disabled(e instanceof Error ? e.message : String(e))
  }
}

let disabledLogged = false
/** 连续未启用计数：首次打 warn，后续每 10 次打一条（防刷屏但保持可观测） */
let disabledSkipCount = 0

/** 最近一次未启用原因（memoryRunNow 把它收口成用户可见错误） */
let lastDisabledReason: string | null = null

function disabled(reason: string): null {
  lastDisabledReason = reason
  disabledSkipCount++
  if (!disabledLogged) {
    disabledLogged = true
    console.warn(`[mem-agent] 记忆蒸馏未启用（${reason}），检索底座不受影响。记忆提取将一直跳过直到问题解决。`)
  } else if (disabledSkipCount % 10 === 0) {
    console.warn(`[mem-agent] 记忆蒸馏仍处于未启用状态（${reason}），已跳过 ${disabledSkipCount} 次提取`)
  }
  return null
}

/** 从内容块抽纯文本（收尾正文的权威来源 = 滚动摘要） */
function textOfContent(parts: readonly ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

