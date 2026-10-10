/**
 * 记忆域工具：让 agent 主动检索 / 沉淀 / 修正长期记忆。
 * 之前记忆只能经注入的 memoryBlock「被动读」——agent 无法回忆、无法沉淀用户明说的
 * 偏好、无法修正过时条目。底层一律走 memory/service 统一入口：
 *   · 检索 = memorySearch 混合检索（MCP 子进程无 embedder，自动降级关键词路）；
 *   · 沉淀 = createOrFoldAtomic（同主题自动折叠、importance 只升不降，不产生重复行）；
 *   · 修正 = memoryArchive（与记忆面板同语义，可恢复）。
 * 跨进程安全：sqlite WAL + worker 线程隔离，子进程读并发安全；检索 touch 写为单语句原子。
 */
import { createOrFoldAtomic, memoryArchive, memorySearch } from '../memory/service'
import { withRetry } from '../retry'
import type { Tool } from '../model/types'

const CATEGORIES: readonly string[] = ['preference', 'fact', 'event', 'lesson', 'skill']
const CONTENT_CAP = 400

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('工具入参必须是 JSON 对象')
  }
  return input as Record<string, unknown>
}

function text(rec: Record<string, unknown>, key: string): string {
  const v = rec[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v.trim()
}

function optInt(rec: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须是数字`)
  const n = Math.trunc(v)
  if (n < min || n > max) throw new Error(`参数 ${key} 需在 ${min}~${max} 之间`)
  return n
}

/** 浮点参数校验（不截断）：0~1 量表类字段（如 importance）用它，optInt 的 Math.trunc 会把 0.8 截成 0 */
function optFloat(rec: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须是数字`)
  if (v < min || v > max) throw new Error(`参数 ${key} 需在 ${min}~${max} 之间`)
  return v
}

const memorySearchTool: Tool = {
  name: 'memory_search',
  description:
    '检索长期记忆（用户偏好 / 项目事实与选型 / 踩坑教训 / 可复用技能）。「这类问题之前是不是遇到过」' +
    '有疑问时先查一次再动手，避免重复踩坑或违背用户已表达的偏好。支持语义+关键词混合检索，命中按相关度排序。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词（自然语句或关键词均可）' },
      topK: { type: 'integer', description: '返回条数上限，默认 6', minimum: 1, maximum: 20 },
      globalOnly: { type: 'boolean', description: 'true 时只查跨工程记忆（默认查本工程 + 全局）' },
    },
    required: ['query'],
  },
  permission: 'readonly',
  async execute(input, ctx) {
    const rec = asRecord(input)
    const query = text(rec, 'query')
    const topK = optInt(rec, 'topK', 1, 20) ?? 6
    const globalOnly = rec.globalOnly === true
    const scopeRoot = globalOnly ? null : ctx.projectRoot
    let r = await withRetry(() => memorySearch(query, scopeRoot, topK), {
      label: 'memory_search',
      retries: 1,
    })
    // FTS trigram 短语查询对多词串偏严（词间需原文相邻）：整串零命中时拆词逐查、合并去重。
    // 「包管理器 pnpm」查不到「包管理器用 pnpm」就是这条路径救回来的
    if (r.hits.length === 0) {
      const words = [...new Set(query.split(/[\s,，、]+/).map((w) => w.trim()).filter((w) => w.length >= 2))]
      if (words.length > 1) {
        const seen = new Set<string>()
        const merged: typeof r.hits = []
        let degraded = false
        for (const w of words) {
          const part = await withRetry(() => memorySearch(w, scopeRoot, Math.max(3, topK)), { label: 'memory_search:word', retries: 1 })
          degraded = degraded || part.degraded
          for (const h of part.hits) {
            if (seen.has(h.id)) continue
            seen.add(h.id)
            merged.push(h)
          }
        }
        r = { hits: merged.slice(0, topK), degraded }
      }
    }
    if (r.hits.length === 0) {
      return { content: `[memory_search]「${query}」无命中。` }
    }
    const lines = r.hits.map((h, i) => {
      const content = String(h.content ?? '').slice(0, CONTENT_CAP)
      const scope = h.projectKey === 'global' ? 'user' : 'project'
      return `${i + 1}. [${h.category}] ${h.title}（scope=${scope} · importance ${h.importance} · id=${h.id}）\n   ${content}`
    })
    return {
      content:
        `[memory_search] 命中 ${r.hits.length} 条${r.degraded ? '（向量路不可用，关键词路结果）' : ''}：\n${lines.join('\n')}\n` +
        '修正某条用 memory_archive（带 id）。',
    }
  },
}

const memorySaveTool: Tool = {
  name: 'memory_save',
  description:
    '沉淀一条长期记忆。只记稳定事实：用户明说的偏好（工具链/代码风格/工作流）、项目选型与约定、踩坑教训、可复用技能；' +
    '一次性的任务细节不要存。title 与既有条目完全一致时自动折叠更新（importance 只升不降），不会产生重复条目。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '一行标题，具体不含糊（「包管理器用 pnpm」好，「用户偏好」坏）' },
      content: { type: 'string', description: '记忆正文' },
      category: { type: 'string', description: 'preference / fact / event / lesson / skill 五选一', enum: CATEGORIES },
      scope: { type: 'string', description: 'user=跨工程通用（个人偏好/常用工具链）；project=仅本工程（选型/约定/本项目教训）。两可时选 project', enum: ['user', 'project'] },
      importance: { type: 'number', description: '重要度 0~1，默认 0.5', minimum: 0, maximum: 1 },
    },
    required: ['title', 'content', 'category', 'scope'],
  },
  permission: 'write',
  async execute(input, ctx) {
    const rec = asRecord(input)
    const title = text(rec, 'title')
    const content = text(rec, 'content')
    const category = String(rec.category ?? '')
    if (!CATEGORIES.includes(category)) throw new Error(`category 必须是 ${CATEGORIES.join('/')}`)
    const scope = rec.scope === 'user' ? 'user' : rec.scope === 'project' ? 'project' : null
    if (!scope) throw new Error('scope 必须是 user 或 project')
    if (scope === 'project' && !ctx.projectRoot) throw new Error('当前未打开工程，project 作用域不可用（可改 scope=user）')
    const importance = optFloat(rec, 'importance', 0, 1)
    const r = await withRetry(
      () =>
        createOrFoldAtomic({
          ...(scope === 'user' ? { global: true } : { projectRoot: ctx.projectRoot as string }),
          tier: 'long',
          category,
          title,
          content,
          ...(importance !== undefined ? { importance } : {}),
        }),
      { label: 'memory_save', retries: 1 },
    )
    return {
      content: `[memory_save] ${r.folded ? '已折叠进既有同主题记忆' : '已新建记忆'}（id=${r.id}）：${title}`,
    }
  },
}

const memoryArchiveTool: Tool = {
  name: 'memory_archive',
  description: '归档一条过时或错误的长期记忆（id 从 memory_search 的结果拿）。归档不是删除，可在记忆面板恢复。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '记忆条目 id（memory_search 结果中的 id）' },
    },
    required: ['id'],
  },
  permission: 'write',
  async execute(input) {
    const id = text(asRecord(input), 'id')
    const ok = await withRetry(() => memoryArchive(id), { label: 'memory_archive', retries: 1 })
    if (!ok) return { content: `[memory_archive] 未找到记忆条目 ${id}（可能已归档或已删除）。`, isError: true }
    return { content: `[memory_archive] 已归档 ${id}（可在记忆面板恢复）。` }
  },
}

/** 记忆域工具集 */
export const memoryTools: Tool[] = [memorySearchTool, memorySaveTool, memoryArchiveTool]
