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
 *  - LLM 通道双 adapter，均为 headless 单轮：API 模式复用 aiChatStream（system=蒸馏指令，
 *    tools 传 undefined）；CLI 模式走 callCliJson 直调（--system-prompt 蒸馏指令 +
 *    --output-format json 单次返回，readonly 工具白名单 + --max-turns 1 + cwd 固定 homedir——
 *    记忆蒸馏绝不持项目写权限，也不给工具循环留口子）；
 *    模型取 aiTiers.middle 缺省回退主模型；API Key 缺失（getSecretInternal）→ 静默禁用。
 *  - 并发防护：per-project 串行队列 + 提取中标志，同 (project, session) 重复触发合并。
 *  - 失败退避（P3）：连续 LLM 失败按 min(2^count×60s, 30min) 退避，maybe_extract/run_now
 *    窗口内直接跳过；成功归零。
 *  - sources 纪律：转录行暴露 #seq（模型可见的稳定引用），message id 为内部 UUID 不可见，
 *    故 source_json 落 { messageSeqs: [...] } 而非 messageIds。
 * 测试钩子：setLlmHook（注入假 LLM，同时绕过启用检查）/ setClock（注入假时钟），smoke 全链路离线可测。
 */
import { randomUUID } from 'node:crypto'
import type { SqliteDb } from '../db'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { getDb, projectKey } from '../db'
import { getConfig } from '../config'
import { getSecretInternal } from '../secrets'
import { SECRET_ACCOUNT } from '../ai-api'
import { aiChatStream } from '../ai'
import { buildCliArgs } from '../ai-cli'
import { registerOnceProc, cancelRunOnce, detectCommand } from '../proc'
import { emitToAllWindows } from '../emitter'
import * as service from './service'
import { parseAgentJson } from './parse'
export type { AgentCreateOp, AgentPatchOp, AgentArchiveOp, AgentOp, AgentOutput } from './parse'

// ---------- 纪律条款（memU 移植，系统提示原文） ----------

export const SYSTEM_PROMPT = `你是记忆蒸馏器。输入分两节：【增量转录】是开发会话的新增消息（#序号 + 发言人 + 内容，工具调用压成一行摘要）；【现有记忆清单】是已沉淀的长期记忆与本会话短期记忆（- [分类] 标题（id））。你的唯一任务：判断增量转录里是否有值得长期记住的稳定事实，输出 JSON 操作清单。

铁律：
1. 空操作是完全合格的产出——不要为了证明跑过而编造记忆（no-op 输出 {"ops":[],"summary":null}）
2. 合并优先于新建：与现有记忆同主题时，输出 patch 更新原条目（targetId 从【现有记忆清单】里取），不要另起一条
3. 只记稳定事实：用户偏好（包管理器/代码风格/工作流习惯）、项目结构与选型事实、踩坑教训、可复用的工作流技能；一次性的任务细节不值得记
4. 读不到的不许猜：转录里没有的不要脑补；工具结果里的密钥/token/密码绝对不能进记忆
5. title 一行以内，具体不含糊（「包管理器用 pnpm」好，「用户偏好」坏）

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
  · 两可时选 project（宁少污染跨工程视野）
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
  const row = db
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
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE project_key = ? AND session_id = ?')
    .get(key, sessionId) as { seq: number }
  return Number(row.seq)
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

/** 滚动提取触发（渲染层每轮 assistant 收尾后调用；不满足阈值/冷却时为空操作） */
export async function memoryMaybeExtract(projectRoot: string, sessionId: string): Promise<void> {
  const key = projectKey(projectRoot)
  const ck = cursorKey(projectRoot, sessionId)
  lastSession.set(key, sessionId)
  const db = await getDb()
  let cur = cursors.get(ck)
  if (!cur) {
    // 首见：优先恢复持久化游标（重启/接管场景）；从无记录 → 基线 0，历史窗口照常可提取
    cur = { cursor: (await loadPersistedCursor(db, ck)) ?? 0, lastRunAt: 0 }
    cursors.set(ck, cur)
  }
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE project_key = ? AND session_id = ? AND seq > ? AND role = 'assistant'",
    )
    .get(key, sessionId, cur.cursor) as { n: number }
  // 阈值可配（设置页「记忆整理触发轮次」，config.ts 已归一到 2..60）；未配置回缺省 6
  const cfg = await getConfig()
  const threshold = cfg.memExtractRounds ?? ASSISTANT_ROUNDS_THRESHOLD
  if (Number(row.n) < threshold) return
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
  const row = db
    .prepare('SELECT session_id FROM messages WHERE project_key = ? ORDER BY created_at DESC LIMIT 1')
    .get(projectKey(projectRoot)) as { session_id: string } | undefined
  return row?.session_id ?? null
}

/** 手动「立即整理」（记忆面板按钮）：对当前 session 立即增量提取（无视冷却，仍防并发）。
 *  未启用回 ok=false；无会话时从 messages 表兜底查找。返回 ops 供面板区分"有产出"和"no-op"。 */
export async function memoryRunNow(projectRoot: string): Promise<{ ok: boolean; error?: string; ops?: number }> {
  if (!(await resolveRunContext())) return { ok: false, error: '记忆蒸馏未启用：未配置 API Key 或模型。请在设置中配置 AI 助手。' }
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

/** 最近一次提取错误（memoryRunNow 返回后清空） */
let lastExtractError: string | null = null

/** 提取主流程：读增量 → 组装 → LLM → 解析 → 执行 ops → 推进游标。异常只告警（游标不动，下轮重试）。返回实际应用的 ops 数。 */
async function runExtraction(projectRoot: string, sessionId: string, trigger: string): Promise<number> {
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
  const rows = db
    .prepare(
      `SELECT id, seq, role, content, tool_json FROM messages
       WHERE project_key = ? AND session_id = ? AND seq > ? ORDER BY seq ASC`,
    )
    .all(projectKey(projectRoot), sessionId, cur.cursor) as TranscriptRow[]
  if (rows.length === 0) {
    if (trigger === 'manual') {
      // 手动触发：cursor 已到末尾但用户要求重新整理 → 重置为 0 全量重扫
      //（重复内容由 applyOps 的去重护栏折叠为 patch，不会产生重复行）
      cursors.set(ck, { cursor: 0, lastRunAt: clock() })
      await persistCursor(db, ck, 0)
      const allRows = db
        .prepare(`SELECT id, seq, role, content, tool_json FROM messages WHERE project_key = ? AND session_id = ? ORDER BY seq ASC`)
        .all(projectKey(projectRoot), sessionId) as TranscriptRow[]
      if (allRows.length === 0) return 0
      // 用重置后的 rows 继续执行
      return await extractWithRows(projectRoot, sessionId, trigger, ck, allRows)
    }
    return 0
  }
  if (!(await resolveRunContext())) return 0
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
  const user = [
    '【增量转录】（#序号 发言人：内容；工具调用为一行摘要）',
    transcript.text,
    '【现有记忆清单】（- [分类] 标题（id）；patch/archive 的 targetId 从这里取）',
    titles.length > 0 ? titles.join('\n') : '（暂无）',
  ].join('\n')

  const MAX_PARSE_RETRIES = 2 // 带反馈重试更高效，2 次足矣（首答 + 2 重试 = 3 次调用）
  let raw = ''
  let out: AgentOutput | null = null

  try {
    raw = llmHook ? await llmHook(SYSTEM_PROMPT, user) : await callLlm(SYSTEM_PROMPT, user)
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
        raw = llmHook
          ? await llmHook(SYSTEM_PROMPT, `${user}\n\n${feedback}`)
          : await callLlm(SYSTEM_PROMPT, `${user}\n\n${feedback}`)
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

// ---------- LLM 调用（仅 API adapter，headless 单轮） ----------

interface RunContext {
  provider: string
  baseUrl: string
  model: string
  dispatchMode: string
}

let disabledLogged = false

/** 启用检查：llmHook 存在 = 测试模式直通。
 *  蒸馏跟随主模型调度（aiDispatchMode）：CLI / API。
 *  配置不完整 / Key 缺失 / CLI 未安装静默禁用。 */
async function resolveRunContext(): Promise<RunContext | null> {
  if (llmHook) return { provider: 'openai', baseUrl: 'test://llm-hook', model: 'test-model', dispatchMode: 'api' }
  const cfg = await getConfig()
  const dispatchMode = cfg.aiDispatchMode ?? 'api'
  if (dispatchMode === 'claude-cli') {
    if (detectCommand('claude') === false) return disabled('CLI 未安装')
    return { provider: 'openai', baseUrl: '', model: cfg.aiModel || '', dispatchMode: 'claude-cli' }
  }
  if (!cfg.aiBaseUrl || !cfg.aiModel) return disabled('API 配置不完整')
  let key: string | null = null
  try {
    key = await getSecretInternal(SECRET_ACCOUNT)
  } catch {
    key = null
  }
  if (!key) return disabled('API Key 缺失')
  return { provider: cfg.aiProvider ?? 'openai', baseUrl: cfg.aiBaseUrl, model: cfg.aiModel, dispatchMode: 'api' }
}

function disabled(reason: string): null {
  if (!disabledLogged) {
    disabledLogged = true
    console.info(`[mem-agent] 记忆蒸馏未启用（${reason}），检索底座不受影响`)
  }
  return null
}

/** headless 单轮调用：requestId 独立前缀（与渲染层 uid 空间隔离）；windowId=null 不定向路由 */
async function callLlm(system: string, user: string): Promise<string> {
  const ctx = await resolveRunContext()
  if (!ctx) throw new Error('mem-agent 未启用')

  if (ctx.dispatchMode === 'claude-cli') {
    // CLI 模式：--system-prompt + --output-format json，单次返回完整结果，不走流式解析
    const result = await callCliJson(system, user, ctx.model)
    service.addDistillTokens(
      Math.ceil((system.length + user.length) / 4),
      Math.ceil(result.length / 4),
    )
    return result
  }

  const completion = await aiChatStream(
    `mem-agent-${randomUUID()}`,
    ctx.provider,
    ctx.baseUrl,
    ctx.model,
    [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ],
    undefined,
    'api',
    null,
    null,
  )
  service.addDistillTokens(
    Math.ceil((system.length + user.length) / 4),
    Math.ceil((completion.content ?? '').length / 4),
  )
  return completion.content ?? ''
}

/** CLI 直调：--system-prompt + --output-format json + --json-schema，spawn 子进程拿完整结果。
 *  纪律三件套：readonly 工具白名单（蒸馏绝不持写权限）/ max-turns 1（headless 单轮，不给工具
 *  循环留口子）/ 超时树杀（挂起必须能自愈，否则 per-project 串行队列被永久占死） */
const MEM_AGENT_CLI_TIMEOUT_MS = 10 * 60_000

/** 记忆蒸馏 JSON Schema（--json-schema 强制输出结构，彻底消除格式偏差） */
const DISTILL_JSON_SCHEMA = JSON.stringify({
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
  required: ['ops'],
})

function callCliJson(systemPrompt: string, userMessage: string, model: string): Promise<string> {
  const prompt = `<conversation>\n用户：${userMessage}\n</conversation>`
  // --bare：跳过 hooks/skills/MCP/CLAUDE.md，蒸馏是纯文本→JSON 单轮任务，不需要这些
  // readonly 档（--allowedTools 白名单，只读）而非 auto（--dangerously-skip-permissions）
  // --json-schema 强制输出结构：ops 字段名、op 类型、category 枚举全部由 schema 保证
  const args = buildCliArgs(model, 'readonly', { bare: true, systemPrompt, outputFormat: 'json', maxTurns: 1, jsonSchema: DISTILL_JSON_SCHEMA })
  const isWin = process.platform === 'win32'
  const cliCommand = 'claude'

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(isWin ? 'cmd.exe' : cliCommand, isWin ? ['/C', cliCommand, ...args] : args, {
        cwd: homedir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      reject(new Error(`CLI 启动失败：${String(e)}`))
      return
    }
    // 登记进 onceProc 取消链：超时/退出清理走统一 cancelRunOnce（Windows cmd.exe /C 需树杀）。
    // token 必须私有（传参取消），无参 cancelRunOnce 会误杀全部在途一次性子进程
    const token = `mem-agent-cli-${randomUUID()}`
    const unregister = registerOnceProc(token, child)
    let stdout = ''
    let stderr = ''
    let settled = false
    let interrupted = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unregister()
      fn()
    }
    timer = setTimeout(() => {
      interrupted = true
      cancelRunOnce(token) // 只杀自己，不碰聊天主链路的在途 CLI 子进程
    }, MEM_AGENT_CLI_TIMEOUT_MS)

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    if (!child.stdin) {
      settle(() => reject(new Error('CLI stdin 不可用')))
      return
    }
    child.stdin.write(prompt)
    child.stdin.end()

    child.on('close', (code) => {
      settle(() => {
        if (interrupted) {
          reject(new Error(`CLI 蒸馏超过 ${MEM_AGENT_CLI_TIMEOUT_MS / 60_000} 分钟未返回，已中止`))
          return
        }
        if (code !== 0) {
          reject(new Error(`CLI 退出码 ${code}：${stderr.slice(-500)}`))
          return
        }
        // --output-format json 返回 {"result":"...","structured_output":{...}}
        // --json-schema 时 structured_output 是 schema 约束的 JSON，优先使用
        try {
          const parsed = JSON.parse(stdout) as { result?: string; structured_output?: unknown; is_error?: boolean }
          if (parsed.is_error) {
            reject(new Error(`CLI 报告错误：${parsed.result ?? '未知'}`))
            return
          }
          // 优先取 structured_output（--json-schema 约束的结构化结果）
          if (parsed.structured_output && typeof parsed.structured_output === 'object') {
            const so = JSON.stringify(parsed.structured_output)
            console.info(`[mem-agent] CLI json 返回 structured_output 长度=${so.length}，前300字：${so.slice(0, 300)}`)
            resolve(so)
          } else {
            const resultText = parsed.result ?? stdout
            console.info(`[mem-agent] CLI json 返回 result 长度=${resultText.length}，前300字：${resultText.slice(0, 300)}`)
            resolve(resultText)
          }
        } catch {
          // 如果不是 JSON，直接用原始输出
          console.info(`[mem-agent] CLI json 返回非JSON，原始输出前300字：${stdout.slice(0, 300)}`)
          resolve(stdout.trim())
        }
      })
    })

    child.on('error', (e) => settle(() => reject(e)))
  })
}
