/**
 * 消息持久化（SQLite messages 表）：按 (project_key, session_id, seq) 组织，seq 会话内递增（事务内分配）。
 * 经 IPC 六通道供渲染层读写：messages_recent / messages_before / message_append / message_patch /
 * messages_truncate / project_data_delete。
 * 行⇄对象映射：content/reasoning 直列；meta_json ↔ meta；tool_json ↔ { toolCalls, toolResults }（缺省 NULL）。
 */
import type { SqliteDb } from './db'
import { getDb, projectKey } from './db'

/** 以下三型与 src/types 对齐（electron tsconfig 不含 src，故内联维护，改动需两侧同步） */
export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  resultSummary?: string
  result?: string
}

export interface ToolResultRecord {
  toolCallId: string
  content: string
}

export interface MessageMetaRecord {
  /** 引用的 Skills（显示卡片用） */
  skills?: { id: string; name: string }[]
  /** AI 启动项目（显示卡片用） */
  projectStart?: boolean
  /** 预览页选中的元素（显示卡片用） */
  element?: { selector: string; tag: string; id: string; text: string }
}

/** 持久化消息（与 src/types ChatMessage 结构对齐，另带会话内序号 seq；pending/error 为 UI 态不入库） */
export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: ToolCallRecord[]
  toolResults?: ToolResultRecord[]
  meta?: MessageMetaRecord
  seq: number
}

/** append 入参：渲染层 ChatMessage 的可持久化子集（id/role 必填） */
export interface AppendMessage {
  id: string
  role: 'user' | 'assistant'
  content?: string
  reasoning?: string | null
  meta?: MessageMetaRecord
  toolCalls?: ToolCallRecord[]
  toolResults?: ToolResultRecord[]
}

/** patch 入参：字段缺省不动；reasoning 显式 null → SQL NULL；meta 显式 null → SQL NULL（清空）；
 *  tool 整列覆写（null 清列）。meta 通道供渲染层持久化 citations 等展示元数据 */
export interface MessagePatch {
  content?: string
  reasoning?: string | null
  meta?: MessageMetaRecord | null
  tool?: { toolCalls?: ToolCallRecord[]; toolResults?: ToolResultRecord[] } | null
}

/** 游标分页结果（正序返回；oldestSeq = 本批最小 seq，供继续向前翻页） */
export interface MessagesPage {
  messages: StoredMessage[]
  hasMore: boolean
  oldestSeq: number | null
}

/** messages_recent 结果：最新会话最新一页 + 该工程消息总数 */
export interface MessagesRecentPage extends MessagesPage {
  sessionId: string | null
  total: number
}

interface MessageRow {
  id: string
  role: string
  content: string
  reasoning: string | null
  meta_json: string | null
  tool_json: string | null
  seq: number
}

const SELECT_COLS = 'id, role, content, reasoning, meta_json, tool_json, seq'

/** 最新会话最新一页：最新会话 = 该工程 MAX(created_at) 最大者所属 session；无任何消息回空形 */
export async function messagesRecent(projectRoot: string, limit?: number): Promise<MessagesRecentPage> {
  const db = await getDb()
  const key = projectKey(projectRoot)
  const latest = db
    .prepare('SELECT session_id FROM messages WHERE project_key = ? ORDER BY created_at DESC LIMIT 1')
    .get(key) as { session_id: string } | undefined
  if (!latest) return { sessionId: null, messages: [], hasMore: false, oldestSeq: null, total: 0 }
  return {
    sessionId: latest.session_id,
    ...pageSession(db, key, latest.session_id, null, limit),
    total: countProject(db, key),
  }
}

/** 游标分页：该会话 seq < beforeSeq 的最新 limit 条，正序返回 */
export async function messagesBefore(
  projectRoot: string, sessionId: string, beforeSeq: number, limit?: number,
): Promise<MessagesPage> {
  const db = await getDb()
  return pageSession(db, projectKey(projectRoot), sessionId, beforeSeq, limit)
}

/** 追加一条消息：seq = 该会话 MAX(seq)+1（事务内分配防并发）；失败抛错交上层感知，禁止静默 */
export async function messageAppend(
  projectRoot: string, sessionId: string, message: AppendMessage,
): Promise<{ seq: number }> {
  const db = await getDb()
  const key = projectKey(projectRoot)
  const insert = db.prepare(
    `INSERT INTO messages (id, project_key, session_id, seq, role, content, reasoning, meta_json, tool_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const nextSeq = db.transaction((): number => {
    const row = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE project_key = ? AND session_id = ?')
      .get(key, sessionId) as { seq: number }
    insert.run(
      message.id, key, sessionId, Number(row.seq), message.role, message.content ?? '',
      message.reasoning ?? null, toJson(message.meta), toolJson(message), Date.now(),
    )
    return Number(row.seq)
  })
  return { seq: nextSeq() }
}

/** 局部更新：只动 patch 里出现的字段（id 不存在时影响 0 行，不视为错误） */
export async function messagePatch(
  projectRoot: string, sessionId: string, id: string, patch: MessagePatch,
): Promise<void> {
  const db = await getDb()
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.content !== undefined) {
    sets.push('content = ?')
    params.push(patch.content)
  }
  if (patch.reasoning !== undefined) {
    sets.push('reasoning = ?') // 显式 null 即 SQL NULL
    params.push(patch.reasoning)
  }
  if (patch.meta !== undefined) {
    sets.push('meta_json = ?') // 显式 null 即 SQL NULL（清空）；缺省不动
    params.push(patch.meta === null ? null : JSON.stringify(patch.meta))
  }
  if (patch.tool !== undefined) {
    sets.push('tool_json = ?')
    params.push(patch.tool === null ? null : toolJson(patch.tool))
  }
  if (sets.length === 0) return
  params.push(projectKey(projectRoot), sessionId, id)
  db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE project_key = ? AND session_id = ? AND id = ?`).run(...params)
}

/** 截断重发：删除同会话 seq > afterSeq 的全部消息 */
export async function messagesTruncate(projectRoot: string, sessionId: string, afterSeq: number): Promise<void> {
  const db = await getDb()
  db.prepare('DELETE FROM messages WHERE project_key = ? AND session_id = ? AND seq > ?')
    .run(projectKey(projectRoot), sessionId, afterSeq)
}

/** 清空该工程的全部消息行（P0 不含快照目录）；顺带清会话 token 记录（tok:<key>:*）防孤儿计数 */
export async function projectDataDelete(projectRoot: string): Promise<void> {
  const db = await getDb()
  const key = projectKey(projectRoot)
  db.prepare('DELETE FROM messages WHERE project_key = ?').run(key)
  db.prepare("DELETE FROM meta WHERE key LIKE 'tok:' || ? || ':%'").run(key)
}

// ---------- 内部 ----------

/** 页查询与 hasMore 对账（正序返回） */
function pageSession(db: SqliteDb, key: string, sessionId: string, beforeSeq: number | null, rawLimit?: number): MessagesPage {
  const limit = pageSize(rawLimit)
  const rows = (beforeSeq === null
    ? db.prepare(`SELECT ${SELECT_COLS} FROM messages WHERE project_key = ? AND session_id = ? ORDER BY seq DESC LIMIT ?`)
      .all(key, sessionId, limit)
    : db.prepare(`SELECT ${SELECT_COLS} FROM messages WHERE project_key = ? AND session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
      .all(key, sessionId, beforeSeq, limit)) as MessageRow[]
  const messages = rows.map(rowToMessage).reverse()
  const oldestSeq = messages.length > 0 ? messages[0].seq : null
  const hasMore = oldestSeq !== null
    && db.prepare('SELECT 1 FROM messages WHERE project_key = ? AND session_id = ? AND seq < ? LIMIT 1')
      .get(key, sessionId, oldestSeq) !== undefined
  return { messages, hasMore, oldestSeq }
}

function countProject(db: SqliteDb, key: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE project_key = ?').get(key) as { n: number }
  return Number(row.n)
}

/** limit 容错：IPC 传来的 null/非法值回 50 */
function pageSize(raw: unknown, fallback = 50): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

function rowToMessage(row: MessageRow): StoredMessage {
  const msg: StoredMessage = {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    seq: row.seq,
  }
  if (row.reasoning !== null) msg.reasoning = row.reasoning
  if (row.meta_json) {
    const meta = parseJson<MessageMetaRecord>(row.meta_json, 'meta_json')
    if (meta !== undefined) msg.meta = meta
  }
  if (row.tool_json) {
    const tool = parseJson<{ toolCalls?: ToolCallRecord[]; toolResults?: ToolResultRecord[] }>(row.tool_json, 'tool_json')
    if (tool?.toolCalls) msg.toolCalls = tool.toolCalls
    if (tool?.toolResults) msg.toolResults = tool.toolResults
  }
  return msg
}

/** tool_json 序列化：两组都缺省 → NULL 列 */
function toolJson(parts: { toolCalls?: unknown; toolResults?: unknown }): string | null {
  if (!parts.toolCalls && !parts.toolResults) return null
  const out: Record<string, unknown> = {}
  if (parts.toolCalls) out.toolCalls = parts.toolCalls
  if (parts.toolResults) out.toolResults = parts.toolResults
  return JSON.stringify(out)
}

function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

/** 脏行容错：单行 JSON 损坏按缺省处理并告警，不拖垮整页读取 */
function parseJson<T>(raw: string, col: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    console.warn(`[messages] ${col} 解析失败已跳过：${String(e)}`)
    return undefined
  }
}

// ---------- 会话 token 持久化（per-session，存 meta 表） ----------

function tokenKey(projectRoot: string, sessionId: string): string {
  return `tok:${projectKey(projectRoot)}:${sessionId}`
}

/** 保存会话 token 用量（fire-and-forget，调用方不 await） */
export async function saveSessionTokens(
  projectRoot: string, sessionId: string, tokens: { input: number; output: number },
): Promise<void> {
  try {
    const db = await getDb()
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(tokenKey(projectRoot, sessionId), JSON.stringify(tokens))
  } catch { /* 静默 */ }
}

/** 加载会话 token 用量（无记录回 {input:0, output:0}） */
export async function loadSessionTokens(
  projectRoot: string, sessionId: string,
): Promise<{ input: number; output: number }> {
  try {
    const db = await getDb()
    const row = db.prepare('SELECT value FROM meta WHERE key = ?')
      .get(tokenKey(projectRoot, sessionId)) as { value: string } | undefined
    if (row?.value) {
      const t = JSON.parse(row.value) as { input?: number; output?: number }
      return { input: t.input ?? 0, output: t.output ?? 0 }
    }
  } catch { /* 静默 */ }
  return { input: 0, output: 0 }
}
