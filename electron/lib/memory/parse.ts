/**
 * mem agent 输出解析（纯函数，零外部依赖）。
 * 从 agent.ts 抽取以便 smoke 测试可直接 import（agent.ts 依赖链含 onnxruntime，esbuild 无法 bundle .node）。
 *
 * 解析管线：剥 code fence → 定位首个平衡 JSON → JSON.parse（含尾随逗号/引号修复）→ ops 归一。
 * 兼容 LLM 常见偏差：ops/operations/actions 键名、create/add、patch/update/modify/edit、archive/delete/remove。
 */

// ---------- 类型（与 agent.ts 共享） ----------

export interface AgentCreateOp {
  op: 'create'
  scope?: 'project' | 'user'
  tier: 'short' | 'long'
  category: string
  title: string
  content: string
  importance: number
  sources: string[]
}
export interface AgentPatchOp {
  op: 'patch'
  targetId: string
  content: string
  reason?: string
}
export interface AgentArchiveOp {
  op: 'archive'
  targetId: string
  reason?: string
}
export type AgentOp = AgentCreateOp | AgentPatchOp | AgentArchiveOp

export interface AgentOutput {
  ops: AgentOp[]
  summary: string | null
}

// ---------- 常量 ----------

const CATEGORY_WHITELIST = new Set(['preference', 'fact', 'event', 'lesson', 'skill'])

/** op 类型别名映射：LLM 常把 create 写成 add 等 */
const OP_TYPE_MAP: Record<string, string> = {
  add: 'create', update: 'patch', modify: 'patch', edit: 'patch', delete: 'archive', remove: 'archive',
}

// ---------- 纯函数 ----------

/** 确定性 scope 判定：preference 类恒 user（本系统定义 preference=用户偏好，项目选型/约定应记 fact）。
 *  其余类别尊重模型显式 scope，缺省/非法落 project。 */
function resolveScope(category: string, rawScope: unknown, title: string): 'user' | 'project' {
  if (category === 'preference') {
    if (rawScope === 'project') console.warn(`[mem-agent] preference 被模型标为 project，已强制 user：${title}`)
    return 'user'
  }
  return rawScope === 'user' ? 'user' : 'project'
}

/** 剥离尾随逗号（对象/数组末项后）：`{"a":1,}` / `[1,2,]` → 合法 JSON。逐字符扫描，跳过字符串字面量。 */
function stripTrailingCommas(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === ',') {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      if (s[j] === '}' || s[j] === ']') continue // 丢弃尾随逗号
    }
    out += c
  }
  return out
}

/** 定位文本中首个（字符串之外的）{ 或 [，返回下标与开括号；无则 null */
function firstOpenBrace(text: string): { idx: number; open: string } | null {
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{' || c === '[') return { idx: i, open: c }
  }
  return null
}

/** 从 start 起扫描与 open 匹配的平衡括号，返回闭合下标；未闭合回 -1。跳过字符串内括号。 */
function scanBalanced(text: string, start: number, open: string): number {
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** JSON 解析（含常见 LLM 输出修复）：原始 parse → 尾随逗号/引号/反斜杠修复 → 再 parse。失败回 undefined。 */
function tryParseJson(slice: string): unknown | undefined {
  try {
    return JSON.parse(slice)
  } catch {
    const fixed = stripTrailingCommas(slice)
      .replace(/[""]/g, "'")
      .replace(/\\(?!["\\/bfnrt])/g, '/')
    try {
      return JSON.parse(fixed)
    } catch {
      return undefined
    }
  }
}

/** 从文本提取所有平衡 {...} 对象（跳过字符串内括号），用于残缺/多对象兜底 */
function extractObjects(text: string): unknown[] {
  const objs: unknown[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && text[i] !== '{') i++
    if (i >= text.length) break
    const end = scanBalanced(text, i, '{')
    if (end === -1) { i++; continue }
    const p = tryParseJson(text.slice(i, end + 1))
    if (p !== undefined) objs.push(p)
    i = end + 1
  }
  return objs
}

/** 解析模型输出：剥 code fence → 定位首个平衡 JSON（对象/数组）→ JSON.parse（含尾随逗号/引号修复）。
 *  平衡块缺失/解析失败 → 逐 {...} 对象提取兜底；仍无 → null（按 no-op 处理，调用方照样推进游标）。
 *  非法 op 条目剔除（create 缺 title/content、patch/archive 缺 targetId、未知 op）并告警计数。 */
export function parseAgentJson(raw: string): AgentOutput | null {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '').replace(/^﻿/, '').trim()

  let parsed: unknown | undefined
  const head = firstOpenBrace(text)
  if (head) {
    const end = scanBalanced(text, head.idx, head.open)
    if (end !== -1) parsed = tryParseJson(text.slice(head.idx, end + 1))
  }
  if (parsed === undefined) {
    const objs = extractObjects(text)
    if (objs.length > 0) parsed = objs
  }
  if (parsed === undefined) {
    if (text) console.warn(`[mem-agent] 输出无 JSON 结构，按 no-op 处理：${text.slice(0, 120)}`)
    return null
  }
  // 兼容多种格式：
  //  1. CLI --json-schema 输出 {"structured_output":{...}} → 取 structured_output
  //  2. 直接 {"ops":[...],"summary":...} / {"operations":[...]} / {"actions":[...]} → 取 ops/summary
  //  3. 数组 [{...}] → 直接当 rawOps
  let rawOps: unknown[]
  let summary: string | null = null
  if (Array.isArray(parsed)) {
    rawOps = parsed
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    // --json-schema 结构化输出：优先取 structured_output
    const src = (obj.structured_output && typeof obj.structured_output === 'object')
      ? obj.structured_output as Record<string, unknown>
      : obj
    // 兼容 LLM 偏差：ops / operations / actions 均可（模型常把 ops 写成 actions）
    rawOps = Array.isArray(src.ops) ? src.ops
      : Array.isArray(src.operations) ? src.operations
      : Array.isArray(src.actions) ? src.actions
      : []
    summary = typeof src.summary === 'string' ? src.summary : null
  } else {
    return null
  }
  const dropped: string[] = []
  const ops: AgentOp[] = []
  for (const item of rawOps) {
    const op = item as Record<string, unknown>
    const rawOpType = ((op.op ?? op.action) as string | undefined)?.toLowerCase()
    // 兼容 LLM 偏差：add→create, update/modify/edit→patch, delete/remove→archive
    const opType = rawOpType ? (OP_TYPE_MAP[rawOpType] ?? rawOpType) : undefined
    if (opType === 'create') {
      const title = typeof op.title === 'string' ? op.title.trim() : ''
      const content = typeof op.content === 'string' ? op.content.trim() : ''
      if (!title || !content) {
        dropped.push('create')
        continue
      }
      const category = typeof op.category === 'string' && CATEGORY_WHITELIST.has(op.category) ? op.category : 'fact'
      ops.push({
        op: 'create',
        scope: resolveScope(category, op.scope, title),
        tier: op.tier === 'short' ? 'short' : 'long',
        category,
        title,
        content,
        importance:
          typeof op.importance === 'number' && Number.isFinite(op.importance)
            ? Math.min(Math.max(op.importance, 0), 1)
            : 0.5,
        sources: Array.isArray(op.sources)
          ? op.sources.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          : [],
      })
    } else if (opType === 'patch') {
      const targetId = typeof op.targetId === 'string' ? op.targetId.trim() : ''
      const content = typeof op.content === 'string' ? op.content.trim() : ''
      if (!targetId || !content) {
        dropped.push('patch')
        continue
      }
      ops.push({ op: 'patch', targetId, content, reason: typeof op.reason === 'string' ? op.reason : undefined })
    } else if (opType === 'archive') {
      const targetId = typeof op.targetId === 'string' ? op.targetId.trim() : ''
      if (!targetId) {
        dropped.push('archive')
        continue
      }
      ops.push({ op: 'archive', targetId, reason: typeof op.reason === 'string' ? op.reason : undefined })
    } else {
      dropped.push(String(opType ?? 'unknown'))
    }
  }
  if (dropped.length > 0) {
    console.warn(`[mem-agent] ${dropped.length} 个非法 op 已剔除（${[...new Set(dropped)].join(',')}）`)
  }
  return { ops, summary: summary?.trim() || null }
}
