/**
 * 消息持久化（SQLite messages 表）：按 (project_key, session_id, seq) 组织，seq 会话内递增（事务内分配）。
 * 经 IPC 六通道供渲染层读写：messages_recent / messages_before / message_append / message_patch /
 * messages_truncate / project_data_delete。
 * 行⇄对象映射：content/reasoning 直列；meta_json ↔ meta；tool_json ↔ { toolCalls, toolResults }（缺省 NULL）。
 *
 * ⚠️ 所有 db 操作均为 async（Worker 线程执行），旧版 db.prepare().get() 同步写法已全部迁移。
 */
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
  skills?: { id: string; name: string }[]
  projectStart?: boolean
  element?: { selector: string; tag: string; id: string; text: string }
}

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

export interface AppendMessage {
  id: string
  role: 'user' | 'assistant'
  content?: string
  reasoning?: string | null
  meta?: MessageMetaRecord
  toolCalls?: ToolCallRecord[]
  toolResults?: ToolResultRecord[]
}

export interface MessagePatch {
  content?: string
  reasoning?: string | null
  meta?: MessageMetaRecord | null
  tool?: { toolCalls?: ToolCallRecord[]; toolResults?: ToolResultRecord[] } | null
}

export interface MessagesPage {
  messages: StoredMessage[]
  hasMore: boolean
  oldestSeq: number | null
}

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
const CURRENT_SESSION_PREFIX = 'current_session:'

export async function saveCurrentSession(projectRoot: string, sessionId: string): Promise<void> {
  try {
    const db = await getDb()
    await db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', CURRENT_SESSION_PREFIX + projectKey(projectRoot), sessionId)
  } catch (e) { console.warn(`[messages] saveCurrentSession 失败：${String(e)}`) }
}

export async function messagesRecent(projectRoot: string, limit?: number): Promise<MessagesRecentPage> {
  const db = await getDb()
  const key = projectKey(projectRoot)
  const current = await db.get('SELECT value FROM meta WHERE key = ?', CURRENT_SESSION_PREFIX + key) as { value: string } | undefined
  if (current?.value) {
    const page = await pageSession(db, key, current.value, null, limit)
    return { sessionId: current.value, ...page, total: await countProject(db, key) }
  }
  const latest = await db.get('SELECT session_id FROM messages WHERE project_key = ? ORDER BY created_at DESC LIMIT 1', key) as { session_id: string } | undefined
  if (!latest) return { sessionId: null, messages: [], hasMore: false, oldestSeq: null, total: 0 }
  return {
    sessionId: latest.session_id,
    ...await pageSession(db, key, latest.session_id, null, limit),
    total: await countProject(db, key),
  }
}

export async function messagesBefore(
  projectRoot: string, sessionId: string, beforeSeq: number, limit?: number,
): Promise<MessagesPage> {
  const db = await getDb()
  return pageSession(db, projectKey(projectRoot), sessionId, beforeSeq, limit)
}

export async function messageAppend(
  projectRoot: string, sessionId: string, message: AppendMessage,
): Promise<{ seq: number }> {
  const db = await getDb()
  const key = projectKey(projectRoot)
  const results = await db.transaction([
    { sql: 'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE project_key = ? AND session_id = ?', params: [key, sessionId] },
    {
      sql: `INSERT INTO messages (id, project_key, session_id, seq, role, content, reasoning, meta_json, tool_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        message.id, key, sessionId, /* seq placeholder */ 0, message.role, message.content ?? '',
        message.reasoning ?? null, toJson(message.meta), toolJson(message), Date.now(),
      ],
    },
  ])
  // 第一条返回 seq，第二条是 INSERT
  const maxRow = ((results[0] as unknown[]) ?? [])[0] as { seq: number } | undefined
  const nextSeq = maxRow ? Number(maxRow.seq) : 1
  // 用正确的 seq 重跑 INSERT（事务已回滚，需重新执行）
  // 优化：改为单条 SQL 用子查询
  await db.run(
    `INSERT INTO messages (id, project_key, session_id, seq, role, content, reasoning, meta_json, tool_json, created_at)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE project_key = ? AND session_id = ?), ?, ?, ?, ?, ?, ?)`,
    message.id, key, sessionId, key, sessionId, message.role, message.content ?? '',
    message.reasoning ?? null, toJson(message.meta), toolJson(message), Date.now(),
  )
  // 读回实际分配的 seq
  const row = await db.get('SELECT seq FROM messages WHERE id = ?', message.id) as { seq: number } | undefined
  return { seq: row?.seq ?? nextSeq }
}

export async function messagePatch(
  projectRoot: string, sessionId: string, id: string, patch: MessagePatch,
): Promise<void> {
  const db = await getDb()
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.content !== undefined) { sets.push('content = ?'); params.push(patch.content) }
  if (patch.reasoning !== undefined) { sets.push('reasoning = ?'); params.push(patch.reasoning) }
  if (patch.meta !== undefined) { sets.push('meta_json = ?'); params.push(patch.meta === null ? null : JSON.stringify(patch.meta)) }
  if (patch.tool !== undefined) { sets.push('tool_json = ?'); params.push(patch.tool === null ? null : toolJson(patch.tool)) }
  if (sets.length === 0) return
  params.push(projectKey(projectRoot), sessionId, id)
  await db.run(`UPDATE messages SET ${sets.join(', ')} WHERE project_key = ? AND session_id = ? AND id = ?`, ...params)
}

export async function messagesTruncate(projectRoot: string, sessionId: string, afterSeq: number): Promise<void> {
  const db = await getDb()
  await db.run('DELETE FROM messages WHERE project_key = ? AND session_id = ? AND seq > ?', projectKey(projectRoot), sessionId, afterSeq)
}

export async function projectDataDelete(projectRoot: string): Promise<void> {
  const db = await getDb()
  const key = projectKey(projectRoot)
  await db.run('DELETE FROM messages WHERE project_key = ?', key)
  await db.run("DELETE FROM meta WHERE key LIKE 'tok:' || ? || ':%'", key)
}

// ---------- 内部 ----------

async function pageSession(db: Awaited<ReturnType<typeof getDb>>, key: string, sessionId: string, beforeSeq: number | null, rawLimit?: number): Promise<MessagesPage> {
  const limit = pageSize(rawLimit)
  const rows = beforeSeq === null
    ? await db.all(`SELECT ${SELECT_COLS} FROM messages WHERE project_key = ? AND session_id = ? ORDER BY seq DESC LIMIT ?`, key, sessionId, limit)
    : await db.all(`SELECT ${SELECT_COLS} FROM messages WHERE project_key = ? AND session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`, key, sessionId, beforeSeq, limit)
  const messages = (rows as unknown as MessageRow[]).map(rowToMessage).reverse()
  const oldestSeq = messages.length > 0 ? messages[0].seq : null
  const hasMore = oldestSeq !== null
    && (await db.get('SELECT 1 FROM messages WHERE project_key = ? AND session_id = ? AND seq < ? LIMIT 1', key, sessionId, oldestSeq)) !== undefined
  return { messages, hasMore, oldestSeq }
}

async function countProject(db: Awaited<ReturnType<typeof getDb>>, key: string): Promise<number> {
  const row = await db.get('SELECT COUNT(*) AS n FROM messages WHERE project_key = ?', key) as { n: number } | undefined
  return Number(row?.n ?? 0)
}

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

function parseJson<T>(raw: string, col: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    console.warn(`[messages] ${col} 解析失败已跳过：${String(e)}`)
    return undefined
  }
}

// ---------- 会话 token 持久化 ----------

function tokenKey(projectRoot: string, sessionId: string): string {
  return `tok:${projectKey(projectRoot)}:${sessionId}`
}

export async function saveSessionTokens(
  projectRoot: string, sessionId: string, tokens: { input: number; output: number },
): Promise<void> {
  try {
    const db = await getDb()
    await db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', tokenKey(projectRoot, sessionId), JSON.stringify(tokens))
  } catch { /* 静默 */ }
}

export async function loadSessionTokens(
  projectRoot: string, sessionId: string,
): Promise<{ input: number; output: number }> {
  try {
    const db = await getDb()
    const row = await db.get('SELECT value FROM meta WHERE key = ?', tokenKey(projectRoot, sessionId)) as { value: string } | undefined
    if (row?.value) {
      const t = JSON.parse(row.value) as { input?: number; output?: number }
      return { input: t.input ?? 0, output: t.output ?? 0 }
    }
  } catch { /* 静默 */ }
  return { input: 0, output: 0 }
}
