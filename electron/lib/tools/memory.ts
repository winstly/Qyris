/**
 * 记忆域工具：让 agent 主动检索 / 沉淀 / 修正长期记忆。
 * 之前记忆只能经注入的 memoryBlock「被动读」——agent 无法回忆、无法沉淀用户明说的
 * 偏好、无法修正过时条目。底层一律走 memory/service 统一入口：
 *   · 检索 = memorySearch 混合检索（MCP 子进程无 embedder，自动降级关键词路）；
 *   · 沉淀 = createOrFoldAtomic（同主题自动折叠、importance 只升不降，不产生重复行）；
 *   · 修正 = memoryArchive（与记忆面板同语义，可恢复）。
 * 跨进程安全：sqlite WAL + worker 线程隔离，子进程读并发安全；检索 touch 写为单语句原子。
 */
import { archivedByOf, createOrFoldAtomic, memoryArchive, memorySearch, memoryUpdate } from '../memory/service'
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

/** 可选文本参数：缺失/空串回 undefined（text() 对可选键会误伤抛错） */
function optText(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
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
      includeArchived: { type: 'boolean', description: 'true 时把已归档条目也纳入检索（考古用，默认只查活跃）' },
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
    const includeArchived = rec.includeArchived === true
    let r = await withRetry(() => memorySearch(query, scopeRoot, topK, includeArchived), {
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
      scope: { type: 'string', description: 'user=跨工程通用（个人偏好/常用工具链）；project=仅本工程（选型/约定/本项目教训）。preference 类恒 user；其余两可时选 project', enum: ['user', 'project'] },
      importance: { type: 'number', description: '重要度 0~1，默认 0.5', minimum: 0, maximum: 1 },
      sources: { type: 'array', items: { type: 'string' }, description: '依据来源引用（如转录行号 "#12"）；记忆蒸馏场景使用' },
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
    let scope = rec.scope === 'user' ? 'user' : rec.scope === 'project' ? 'project' : null
    if (!scope) throw new Error('scope 必须是 user 或 project')
    // preference 恒 user（跨工程个人偏好）：模型标 project 时强制纠正，防偏好被锁进单工程
    if (category === 'preference' && scope === 'project') {
      console.warn(`[memory] preference 类被标为 project，已强制 user：${title}`)
      scope = 'user'
    }
    if (scope === 'project' && !ctx.projectRoot) throw new Error('当前未打开工程，project 作用域不可用（可改 scope=user）')
    const importance = optFloat(rec, 'importance', 0, 1)
    const sources = Array.isArray(rec.sources)
      ? rec.sources.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : []
    const r = await withRetry(
      () =>
        createOrFoldAtomic({
          ...(scope === 'user' ? { global: true } : { projectRoot: ctx.projectRoot as string }),
          tier: 'long',
          category,
          title,
          content,
          origin: ctx.origin ?? 'agent_suggest',
          ...(importance !== undefined ? { importance } : {}),
          ...(sources.length > 0 ? { sourceJson: JSON.stringify({ messageSeqs: sources }) } : {}),
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
  description:
    '归档一条过时或错误的长期记忆（id 从 memory_search 的结果拿）。归档不是删除，可在记忆面板恢复。' +
    '必须给出 reason（用户可见归档理由）。用户显式保存的记忆（来源标注「你保存的」）默认不许归档——' +
    '确需归档时必须带 allowArchiveExplicit=true（会进整理摘要供用户复核）。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '记忆条目 id（memory_search 结果中的 id）' },
      reason: { type: 'string', description: '归档理由（一句话，会展示给用户）' },
      supersedes: { type: 'string', description: '可选：本操作由新记忆取代该旧 id 时，填新条目 id' },
      allowArchiveExplicit: { type: 'boolean', description: '归档用户显式保存的记忆时必须显式传 true' },
    },
    required: ['id', 'reason'],
  },
  permission: 'write',
  async execute(input, ctx) {
    const rec = asRecord(input)
    const id = text(rec, 'id')
    const reason = text(rec, 'reason')
    const supersedes = optText(rec, 'supersedes')
    try {
      const ok = await withRetry(
        () => memoryArchive(id, {
          reason,
          by: archivedByOf(ctx.origin ?? 'agent_suggest'),
          supersedes,
          allowArchiveExplicit: rec.allowArchiveExplicit === true,
        }),
        { label: 'memory_archive', retries: 1 },
      )
      if (!ok) return { content: `[memory_archive] ${id} 已处于归档状态（幂等无操作）。` }
      return { content: `[memory_archive] 已归档 ${id}：${reason}（可在记忆面板恢复）。` }
    } catch (e) {
      return { content: `[memory_archive] ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
}

const memoryUpdateTool: Tool = {
  name: 'memory_update',
  description:
    '按 id 更新一条已有记忆的正文（id 从 memory_search 的结果拿）。标题/分类不变的正文修订用这个；' +
    '换主题时改用 memory_save（同 title 自动折叠）。若新表述推翻了另一条旧记忆，带 supersedes 链上旧 id（旧条归档留痕可回看）。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '记忆条目 id（memory_search 结果中的 id）' },
      content: { type: 'string', description: '新的记忆正文' },
      supersedes: { type: 'string', description: '可选：被本次更新取代的旧记忆 id（语义推翻时链上）' },
    },
    required: ['id', 'content'],
  },
  permission: 'write',
  async execute(input, ctx) {
    const rec = asRecord(input)
    const id = text(rec, 'id')
    const content = text(rec, 'content')
    const supersedes = optText(rec, 'supersedes')
    try {
      const updated = await withRetry(
        () => memoryUpdate(id, { content, supersedes }, { by: archivedByOf(ctx.origin ?? 'agent_suggest') }),
        { label: 'memory_update', retries: 1 },
      )
      // memoryUpdate 在重嵌失败时静默整体回滚（返回旧条目）：回报与真实写入状态对齐，
      // 不许把没写上说成「已更新」
      if (updated.content !== content) {
        return {
          content: `[memory_update] ${id} 重嵌失败，正文未改动（保持旧表述）。`,
          isError: true,
        }
      }
      return { content: `[memory_update] 已更新 ${id} 的正文${supersedes ? `（已取代 ${supersedes}）` : ''}。` }
    } catch (e) {
      return { content: `[memory_update] 更新失败：${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
}

/** 记忆域工具集 */
export const memoryTools: Tool[] = [memorySearchTool, memorySaveTool, memoryUpdateTool, memoryArchiveTool]
