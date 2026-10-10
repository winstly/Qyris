/**
 * mem agent —— 记忆蒸馏管线（主进程 headless 单轮 LLM 调用，旁路，永不阻塞对话）。
 * 设计定稿 docs/memory-system-design.md §6：
 *  - 触发三口（渲染层经 IPC 驱动，主进程持游标与频控）：
 *      memoryMaybeExtract 滚动提取：自 cursor 起新增 assistant ≥6 轮且距上次提取 ≥60s；
 *      sessionEnded      收尾提取：cursor 后有内容即跑（无视阈值/冷却），完成后 cursor 作废；
 *      memoryRunNow      手动「立即整理」：对当前 session 立即增量提取（无视冷却，仍防并发）。
 *  - 输入 = 增量转录（纯 user/assistant 原文 + 工具名/一行摘要，不付工具结果 token，memU 双
 *    transcript 纪律）+ 现有长期记忆标题清单（渐进披露）；单次输入 12000 字符封顶，超出取最新。
 *  - 输出 = 严格 JSON ops（create/patch/archive，no-op 合法）+ 滚动 summary（last-write-wins）；
 *    解析剥 code fence，失败按 no-op 处理并告警；非法 op 条目剔除不拖垮合法部分。
 *  - 防自食：本模块绝不写 messages 表（memU MEMU_BRIDGING_RUN 教训），断言见 smoke ③。
 *  - LLM 通道统一走 ModelProvider（见 callAgent）：API 档按 aiProvider 分流 anthropic/openai，
 *    CLI 档走 claude-cli（--safe-mode + --tools "" 无任何工具——记忆蒸馏绝不持项目写权限，
 *    比 readonly 白名单更硬）。蒸馏指令走 system，结构化输出走 options.jsonSchema。
 *    模型取 aiTiers.middle 缺省回退主模型；API Key 缺失（getSecretInternal）→ 静默禁用。
 *  - 并发防护：per-project 串行队列 + 提取中标志，同 (project, session) 重复触发合并。
 *  - 失败退避（P3）：连续 LLM 失败按 min(2^count×60s, 30min) 退避，maybe_extract/run_now
 *    窗口内直接跳过；成功归零。
 *  - sources 纪律：转录行暴露 #seq（模型可见的稳定引用），message id 为内部 UUID 不可见，
 *    故 source_json 落 { messageSeqs: [...] } 而非 messageIds。
 * 测试钩子：setLlmHook（注入假 LLM，同时绕过启用检查）/ setClock（注入假时钟），smoke 全链路离线可测。
 */
import type { SqliteDb } from '../db'
import { basename } from 'node:path'
import { getDb, projectKey } from '../db'
import { getConfig } from '../config'
import { getSecretInternal } from '../secrets'
import { SECRET_ACCOUNT } from '../ai-api'
import { detectCommand } from '../proc'
import { resolveProvider, type ProviderKind } from '../model/providers/registry'
import type { ContentPart, Message, ModelProvider } from '../model/types'
import { emitToAllWindows } from '../emitter'
import * as service from './service'
import { parseAgentJson } from './parse'
import type { AgentOutput } from './parse'
export type { AgentCreateOp, AgentPatchOp, AgentArchiveOp, AgentOp, AgentOutput } from './parse'

// ---------- 纪律条款（memU 移植，系统提示原文） ----------

export const SYSTEM_PROMPT = `你是记忆蒸馏器。输入分两节：【增量转录】是开发会话的新增消息（#序号 + 发言人 + 内容，工具调用压成一行摘要）；【现有记忆清单】是已沉淀的长期记忆与本会话短期记忆（- [分类] 标题（id））。你的唯一任务：判断增量转录里是否有值得长期记住的稳定事实，输出 JSON 操作清单。

铁律：
1. 空操作是完全合格的产出——不要为了证明跑过而编造记忆（no-op 输出 {"ops":[],"summary":null}）
2. 合并优先于新建：与现有记忆同主题时，输出 patch 更新原条目（targetId 从【现有记忆清单】里取），不要另起一条
3. scope 看内容指向哪个工程（【当前工程】= 本次蒸馏所属工程，见输入）：内容讲的是【当前工程】自身的事才产出；讲别的具名工程（哪怕是排查它的故障、哪怕转录里出现它的名字）→ no-op，绝不产出；两可（分不清指向哪个工程）→ 也 no-op。宁可漏记，不许串工程污染
4. 只记稳定事实：用户偏好（包管理器/代码风格/工作流习惯）、项目结构与选型事实、踩坑教训、可复用的工作流技能；一次性的任务细节不值得记
5. 读不到的不许猜：转录里没有的不要脑补；工具结果里的密钥/token/密码绝对不能进记忆
6. title 一行以内，具体不含糊（「包管理器用 pnpm」好，「用户偏好」坏）

输出格式：严格输出一个 JSON 对象（单行），禁止 markdown 代码块、禁止任何解释文字、禁止在 JSON 前后输出任何文字：
{"ops":[{"op":"create","scope":"project|user","tier":"long","category":"preference|fact|event|lesson|skill","title":"一行标题","content":"记忆正文","importance":0.5,"sources":["#seq"]}],"summary":"本会话摘要或null"}
字段说明：
- op：操作类型，必须是 "create"/"patch"/"archive"（不是 "action"！）
- category：preference / fact / event / lesson / skill 五选一
- sources：该记忆依据的转录行号（"#<seq>"格式）
- scope 与 category 的绑定（关键）：
  · preference = 用户偏好（个人编码风格/工具链/工作流习惯），恒 scope="user"——项目技术选型不是 preference
  · 项目技术选型/约定（如「本项目用 sqlite-vec」）记 fact + scope="project"
  · 其余类别用换工程测试判定 scope——把这条知识拿到一个完全不相关的新工程里，还对吗？
    对 → "user"（跨工程通用：个人编码偏好、常用工具链/包管理器、通用环境常识、工作流习惯）
    不对/没意义 → "project"（仅本工程：目录结构、技术选型与约定、接口配置、本项目踩坑教训）
  · user 正例：「用户偏好 pnpm 而非 npm」「用户要求注释用中文」「用户常用 tailwind」
  · project 正例：「本项目用 sqlite-vec」「本项目的 IPC 五层接线约定」
  · scope 判定的前置是铁律 3：内容必须指向【当前工程】才谈 scope；指向别的具名工程或两可 → 直接 no-op
- 【现有记忆清单】为「（暂无）」时是首次蒸馏：更倾向 create，但依然只记稳定事实、禁止编造
- 无产出时输出：{"ops":[],"summary":null}
JSON 安全规则（违反必然解析失败）：
- 字符串值里不允许出现英文双引号 "：需要引用时写单引号 '
- 全文不允许出现反斜杠：路径写正斜杠 /
- 不能输出 markdown 代码块（不要 \`\`\`json）
- 必须输出 {...} 对象，不能输出 [...] 数组！
- 最后一个元素后不要加逗号`

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

// ---------- 输出契约（严格 JSON ops） ----------
// 类型与解析函数已抽取到 parse.ts（零外部依赖，smoke 可直接 import）

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

export type LlmHook = (system: string, user: string) => Promise<string>
let llmHook: LlmHook | null = null

/** 注入假 LLM（smoke 用）；置 null 恢复真实现。钩子存在时绕过启用检查（离线可测） */
export function setLlmHook(hook: LlmHook | null): void {
  llmHook = hook
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
    // 新会话前 N 轮永不蒸馏（P2 修复回归的靶子）；存量长会话的重扫规模由转录预算兜底。
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
 *  未启用回 ok=false；无会话时从 messages 表兜底查找。返回 ops 供面板区分"有产出"和"no-op"。 */
export async function memoryRunNow(projectRoot: string): Promise<{ ok: boolean; error?: string; ops?: number }> {
  if (!(await resolveModelProvider())) return { ok: false, error: '记忆蒸馏未启用：未配置 API Key 或模型。请在设置中配置 AI 助手。' }
  const key = projectKey(projectRoot)
  const sessionId = lastSession.get(key) ?? await latestSessionId(projectRoot)
  if (!sessionId) return { ok: false, error: '当前无活跃会话，请先发送一条消息。' }
  const ck = cursorKey(projectRoot, sessionId)
  if (pending.has(ck)) return { ok: false, error: '已有提取在进行中，请稍候。' }
  if (!cursors.has(ck)) {
    const db = await getDb()
    cursors.set(ck, { cursor: (await loadPersistedCursor(db, ck)) ?? 0, lastRunAt: 0 })
  }
  const result = await enqueueExtractWithResult(projectRoot, sessionId, 'manual')
  if (lastExtractError) {
    const err = lastExtractError
    lastExtractError = null
    return { ok: false, error: `提取失败：${err}` }
  }
  return { ok: true, ops: result }
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

/** 提取主流程：读增量 → 组装 → LLM → 解析 → 执行 ops → 推进游标。异常只告警（游标不动，下轮重试）。返回实际应用的 ops 数。 */
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
      //（重复内容由 applyOps 的去重护栏折叠为 patch，不会产生重复行）
      cursors.set(ck, { cursor: 0, lastRunAt: clock() })
      await persistCursor(db, ck, 0)
      const allRows = await db
        .prepare(`SELECT id, seq, role, content, tool_json FROM messages WHERE project_key = ? AND session_id = ? ORDER BY seq ASC`)
        .all(projectKey(projectRoot), sessionId) as unknown as TranscriptRow[]
      if (allRows.length === 0) return 0
      // 用重置后的 rows 继续执行
      return await extractWithRows(projectRoot, sessionId, trigger, ck, allRows)
    }
    return 0
  }
  if (!(await resolveModelProvider())) return 0
  return extractWithRows(projectRoot, sessionId, trigger, ck, rows)
}

/** 提取公共逻辑：组装转录 → LLM → 解析 → 执行 ops → 推进游标 */
async function extractWithRows(
  projectRoot: string, sessionId: string, trigger: string,
  ck: string, rows: TranscriptRow[],
): Promise<number> {
  const transcript = renderTranscript(rows)
  // 渐进披露上下文：long（工程+global）+ 本会话 short——只给 long 会让模型看不到本会话已蒸出的
  // short/lesson，重扫时无从合并只会重复新建
  const titles = (await service.listContextTitles(projectRoot, sessionId, CONTEXT_TITLES_LIMIT))
    .map((t) => `- [${t.category}] ${t.title}（${t.id}）`)
  // 两节的角色标注进提示（patch/archive 的 targetId 从清单取；「（暂无）」标记被 smoke 断言钉死）
  // 【当前工程】锚点：铁律 3 的 scope 判定基准——不给工程名，模型无从判断内容指向哪个工程，
  // 「排查 BetaProject 卡死」会被误记进当前工程的 project 记忆（串工程污染）
  const user = [
    `【当前工程】${basename(projectRoot)}`,
    '【增量转录】（#序号 发言人：内容；工具调用为一行摘要）',
    transcript.text,
    '【现有记忆清单】（- [分类] 标题（id）；patch/archive 的 targetId 从这里取）',
    titles.length > 0 ? titles.join('\n') : '（暂无）',
  ].join('\n')

  const MAX_PARSE_RETRIES = 2 // 带反馈重试更高效，2 次足矣（首答 + 2 重试 = 3 次调用）
  let raw = ''
  let out: AgentOutput | null = null

  try {
    raw = await callAgent(SYSTEM_PROMPT, user)
  } catch (e) {
    failCount++
    backoffUntil = clock() + backoffDelayFor(failCount)
    lastExtractError = `LLM 调用失败（第${failCount}次）：${String(e)}`
    console.warn(`[mem-agent] ${lastExtractError}`)
    return 0
  }
  failCount = 0
  backoffUntil = 0
  console.info(`[mem-agent] LLM 返回原始内容（前500字）：${raw.slice(0, 500)}`)
  out = parseAgentJson(raw)

  // 输出疑似 JSON（有 { 或 [）但解析失败 → 带错误反馈重试：把上次坏输出喂回去，让模型自纠
  if (!out && /[{[]/.test(raw)) {
    for (let attempt = 0; attempt < MAX_PARSE_RETRIES; attempt++) {
      console.warn(`[mem-agent] 解析失败（疑似 JSON 但格式错误），带反馈重试第 ${attempt + 1} 次…`)
      const feedback = [
        '你上一次的输出无法解析为 JSON。请严格重新输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字：',
        '- 字符串值里不允许出现英文双引号（需要引用时写单引号），全文不允许反斜杠（路径写 /）',
        '- 不要在最后一个元素后加逗号',
        '- 必须输出 {...} 对象（{"ops":[...],"summary":...}），不能输出 [...] 数组',
        '',
        `你上一次的错误输出（供参考）：\n${raw.slice(0, 2000)}`,
      ].join('\n')
      try {
        raw = await callAgent(SYSTEM_PROMPT, `${user}\n\n${feedback}`)
      } catch (e) {
        lastExtractError = `LLM 重试调用失败：${String(e)}`
        console.warn(`[mem-agent] ${lastExtractError}`)
        break
      }
      console.info(`[mem-agent] LLM 重试返回（第 ${attempt + 1} 次，前500字）：${raw.slice(0, 500)}`)
      out = parseAgentJson(raw)
      if (out) break
    }
    if (!out) {
      // 重试耗尽：按 no-op 处理并推进游标（不卡死同一窗口反复烧 token）——设计稿「失败按 no-op」语义
      lastExtractError = 'LLM 连续返回无效 JSON（已按 no-op 处理，游标照常推进）'
      console.warn(`[mem-agent] ${lastExtractError}`)
      out = null // 落到下方 no-op 分支，游标照常推进
    }
  }

  if (out) {
    console.info(`[mem-agent] 解析成功：ops=${out.ops.length} summary=${out.summary ? '有' : '无'}`)
    for (const op of out.ops) {
      if (op.op === 'create') console.info(`  → create scope=${op.scope} category=${op.category} title=${op.title}`)
    }
  } else {
    console.info(`[mem-agent] LLM 判定 no-op（纯文本回复）`)
  }
  const { applied, skipped } = await applyOps(projectRoot, sessionId, out)
  cursors.set(ck, { cursor: transcript.maxSeq, lastRunAt: clock() })
  await persistCursor(await getDb(), ck, transcript.maxSeq)
  const total = out ? out.ops.length : 0
  console.info(
    `[mem-agent] trigger=${trigger} 输入=${rows.length}条(转录${transcript.text.length}字) LLM返回=${raw.length}字 ops=${applied}/${total}${skipped > 0 ? ` 跳过=${skipped}` : ''} summary=${out?.summary ? '有' : '无'}`,
  )
  if (total === 0) {
    console.info(`[mem-agent] LLM 判定 no-op。转录前200字：${transcript.text.slice(0, 200)}`)
  }
  return applied
}

/** 执行 ops：create→memoryCreate（session_id 仅 short 时填）/ patch→按 targetId 更新 content
 *  （不存在忽略并计数）/ archive→status='archived'；summary 非空 → 滚动摘要 last-write-wins。
 *  防自食：只写 mem_items 系，绝不写 messages。 */
async function applyOps(
  projectRoot: string, sessionId: string, out: AgentOutput | null,
): Promise<{ applied: number; skipped: number }> {
  if (!out) return { applied: 0, skipped: 0 }
  let applied = 0
  let skipped = 0
  for (const op of out.ops) {
    try {
      if (op.op === 'create') {
        const isUser = op.scope === 'user'
        // 去重折叠收进服务端原子路径（createOrFoldAtomic）：查重与写入同一同步事务，
        // 重扫/重复蒸馏不再产生重复行，双工程并发蒸馏也不行（配合唯一索引双保险）。
        // 折叠语义：content 覆写、importance 取 MAX（SQL 内算，只升不降）。
        await service.createOrFoldAtomic({
          projectRoot: isUser ? undefined : projectRoot,
          global: isUser,
          tier: op.tier,
          sessionId: op.tier === 'short' ? sessionId : null,
          category: op.category,
          title: op.title,
          content: op.content,
          importance: op.importance,
          sourceJson: op.sources.length > 0 ? JSON.stringify({ messageSeqs: op.sources }) : null,
        })
        applied++
      } else if (op.op === 'patch') {
        await service.memoryUpdate(op.targetId, { content: op.content })
        applied++
      } else if (op.op === 'archive') {
        if (await service.memoryArchive(op.targetId)) applied++
        else skipped++
      }
    } catch (e) {
      skipped++ // 不存在的 targetId 等按失败跳过，不中断其余 ops
      console.warn(`[mem-agent] op 执行失败已跳过：${String(e)}`)
    }
  }
  if (out.summary) await service.saveSessionSummary(projectRoot, sessionId, out.summary)
  return { applied, skipped }
}

// ---------- 转录组装（memU 双 transcript 纪律：不付工具结果 token） ----------

/** 自新向旧装配，超预算即止（取最新）；最新一条必入选（超预算时截断收录）——
 *  游标恒可推进且窗口不空转（否则该窗口内容会被永久跳过，且无任何告警） */
function renderTranscript(rows: TranscriptRow[]): { text: string; maxSeq: number } {
  const maxSeq = rows[rows.length - 1].seq
  const lines: string[] = []
  let budget = TRANSCRIPT_CHAR_LIMIT
  for (let i = rows.length - 1; i >= 0; i--) {
    let block = renderRow(rows[i])
    if (block.length > budget) {
      if (lines.length === 0) block = block.slice(0, budget) // 护栏：最新一条截断也要进转录
      else break
    }
    budget -= block.length
    lines.unshift(block)
  }
  const text = (lines.length < rows.length ? ['（更早已省略）', ...lines] : lines).join('\n')
  return { text, maxSeq }
}

function renderRow(row: TranscriptRow): string {
  const who = row.role === 'user' ? '用户' : '助手'
  const body = row.content.length > ROW_CHAR_CAP ? `${row.content.slice(0, ROW_CHAR_CAP)}…（单条截断）` : row.content
  const lines = [`#${row.seq} ${who}：${body}`]
  for (const call of parseToolCalls(row.tool_json)) {
    lines.push(`  工具 ${call.name}：${toolArgSummary(call.args)}`)
  }
  return lines.join('\n')
}

interface ParsedToolCall {
  name: string
  args: Record<string, unknown>
}

/** tool_json 只取 toolCalls 的 name + 关键参数一行摘要；toolResults 整体不进 prompt */
function parseToolCalls(toolJson: string | null): ParsedToolCall[] {
  if (!toolJson) return []
  try {
    const parsed = JSON.parse(toolJson) as { toolCalls?: { name?: unknown; args?: unknown }[] }
    return (Array.isArray(parsed.toolCalls) ? parsed.toolCalls : []).map((t) => ({
      name: typeof t.name === 'string' && t.name ? t.name : 'unknown',
      args: t.args && typeof t.args === 'object' ? (t.args as Record<string, unknown>) : {},
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

// ---------- LLM 调用（ModelProvider headless 单轮） ----------

/** 按配置解析模型来源（统一走 ModelProvider，见 model/types.ts）。
 *  API 直连按 aiProvider 分流 anthropic / openai；CLI 档走 claude-cli。
 *  换 Codex / OpenCode 只改这里的 kind，上层 callAgent 零改动——这正是「模型是服务」的验收点。 */
async function resolveModelProvider(): Promise<ModelProvider | null> {
  const cfg = await getConfig()
  const dispatchMode = cfg.aiDispatchMode ?? 'api'
  if (dispatchMode === 'claude-cli') {
    const cliCmd = cfg.aiCliCommand || 'claude'
    if ((await detectCommand(cliCmd)) === false) return disabled(`CLI 命令 '${cliCmd}' 不可用`)
    return resolveProvider('claude-cli', { kind: 'claude-cli', cliCommand: cliCmd })
  }
  if (!cfg.aiBaseUrl || !cfg.aiModel) return disabled('API 配置不完整（未设置 Base URL 或模型）')
  let key: string | null = null
  try {
    key = await getSecretInternal(SECRET_ACCOUNT)
  } catch {
    key = null
  }
  if (!key) return disabled('API Key 缺失（请在设置中配置）')
  const kind: ProviderKind = (cfg.aiProvider ?? '').toLowerCase().includes('anthropic') ? 'anthropic' : 'openai'
  return resolveProvider(kind, { kind, apiKey: key, baseUrl: cfg.aiBaseUrl, model: cfg.aiModel })
}

let disabledLogged = false
/** 连续未启用计数：首次打 warn，后续每 10 次打一条（防刷屏但保持可观测） */
let disabledSkipCount = 0

function disabled(reason: string): null {
  disabledSkipCount++
  if (!disabledLogged) {
    disabledLogged = true
    console.warn(`[mem-agent] 记忆蒸馏未启用（${reason}），检索底座不受影响。记忆提取将一直跳过直到问题解决。`)
  } else if (disabledSkipCount % 10 === 0) {
    console.warn(`[mem-agent] 记忆蒸馏仍处于未启用状态（${reason}），已跳过 ${disabledSkipCount} 次提取`)
  }
  return null
}

/** 记忆蒸馏输出契约（结构化，彻底消除格式偏差）。
 *  传对象给 provider，由它按各自方言落地（claude 走 --json-schema，codex 走临时文件）。 */
const DISTILL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['create', 'patch', 'archive'] },
          scope: { type: 'string', enum: ['project', 'user'] },
          tier: { type: 'string', enum: ['short', 'long'] },
          category: { type: 'string', enum: ['preference', 'fact', 'event', 'lesson', 'skill'] },
          title: { type: 'string' },
          content: { type: 'string' },
          importance: { type: 'number', minimum: 0, maximum: 1 },
          sources: { type: 'array', items: { type: 'string' } },
          targetId: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['op'],
      },
    },
    summary: { type: ['string', 'null'] },
  },
  // 根级不设 required:['ops']：空转录时模型只会给 summary/空对象，强求 ops 会让
  // CLI 的 structured-output 校验连挂 5 次后 exit 1（实测报「must have required property 'ops'」）。
  // 提取指令里已约定 no-op 输出 {"ops":[],"summary":null}，缺 ops 由 parseAgentJson 归一成 []。
} as const

/** 从内容块抽纯文本（补全结果的权威正文） */
function textOfContent(parts: readonly ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** 蒸馏调用入口：统一走 ModelProvider（无状态补全，provider 不碰会话）。
 *  上层传参/交互与原 callLlm 一致；smoke 仍走 llmHook 离线直通。 */
async function callAgent(system: string, user: string): Promise<string> {
  const hook = llmHook
  if (hook) {
    const raw = await hook(system, user)
    service.addDistillTokens(Math.ceil((system.length + user.length) / 4), Math.ceil(raw.length / 4))
    return raw
  }

  const provider = await resolveModelProvider()
  if (!provider) throw new Error('mem-agent 未启用')

  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: system }] },
    { role: 'user', content: [{ type: 'text', text: user }] },
  ]

  // 增量优先、done.message 兜底（与 runner 同口径）；provider 已保证 done 正文 === 增量拼接
  let text = ''
  for await (const ev of provider.complete({ messages, options: { jsonSchema: DISTILL_JSON_SCHEMA } })) {
    if (ev.type === 'text-delta') text += ev.text
    else if (ev.type === 'done') text = textOfContent(ev.message.content) || text
    else if (ev.type === 'error') throw ev.error
  }

  service.addDistillTokens(
    Math.ceil((system.length + user.length) / 4),
    Math.ceil(text.length / 4),
  )
  return text
}
