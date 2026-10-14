/**
 * 记忆服务（mem_items / mem_vec / mem_fts 的读写与混合检索）。
 * 渲染层契约（八通道，main/index.ts 注册 snake_case，preload 白名单逐字对应）：
 *   memory_list / memory_search / memory_update / memory_delete / memory_clear / memory_stats
 *   + P3 备份通道 memory_export / memory_import
 * 检索：FTS5 trigram（≥3 字短语 MATCH，1-2 字 LIKE 兜底）+ vec0 KNN 并行召回 →
 *   RRF 融合（k=60）+ importance/新近度轻加权；命中后回写 access_count/last_accessed_at。
 * 嵌入纪律：update 重嵌走 plan→embed→write，embed 失败整体 no-op；FTS 由 db.ts 触发器自同步，
 *   本模块不再手工维护倒排索引。嵌入前过模型指纹闸门（meta 表 embed_model_fingerprint），
 *   与库内指纹不符即停向量路（P2 只检测告警，全量重嵌作业 P3）。
 * P2 追加 mem agent 支撑面：session 滚动摘要读写 / note_lesson / 归档 / 长期记忆标题清单。
 * P3 追加维护作业与备份通道：runDecayJob 衰减归档（6h 周期，startDecayJob boot 调度）/
 *   maybeStartReembedJob 指纹不符全量重嵌自愈 / memory_export·memory_import 全量备份导入。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import type { SqliteDb } from '../db'
import { getDb, projectKey, vecReadyFlag, dataDir } from '../db'
import { embedTexts, embedReady, isEmbedBusy, EMBED_DIM, DEFAULT_EMBED_MODEL } from './embed'
import { getConfig } from '../config'
import { memoryActivation } from '../../../shared/memory-scoring'
import { emitToAllWindows } from '../emitter'

// ---------- 类型（渲染层契约，camelCase，service 层做行⇄对象映射） ----------

// 记忆载荷类型（唯一定义在 shared/ipc-types.ts，此处再导出供主进程/preload 消费）
import type {
  MemoryArchivedBy, MemoryCategory, MemoryHit, MemoryItem, MemoryLastTidy, MemoryOrigin, MemoryPatch, MemoryStats, MemoryTier,
} from '../../../shared/ipc-types'
export type { MemoryArchivedBy, MemoryCategory, MemoryHit, MemoryItem, MemoryLastTidy, MemoryOrigin, MemoryPatch, MemoryStats, MemoryTier }
export interface MemorySearchResult {
  hits: MemoryHit[]
  /** true = 向量路不可用（sqlite-vec 缺席 / 模型未就绪或降级 / 本次推理失败），本次仅关键词路 */
  degraded: boolean
}

/** 分类归一（入库/出库边界）：库内历史值或模型输出的未知分类统一落 'fact'，标签表只认白名单 */
const CATEGORIES: ReadonlySet<string> = new Set<MemoryCategory>(['preference', 'fact', 'event', 'lesson', 'skill', 'summary'])
function toCategory(raw: string): MemoryCategory {
  return CATEGORIES.has(raw) ? (raw as MemoryCategory) : 'fact'
}

/** mem agent 蒸馏 token 累计（面板展示，清空时归零，持久化到 meta 表） */
export const distillTokens = { input: 0, output: 0 }
const TOKENS_KEY = 'distill_tokens'

/** 从 meta 表恢复 token 计数（getDb 后调用） */
export async function loadDistillTokens(): Promise<void> {
  try {
    const db = await getDb()
    const row = await db.prepare('SELECT value FROM meta WHERE key = ?').get(TOKENS_KEY) as { value: string } | undefined
    if (row?.value) {
      const t = JSON.parse(row.value) as { input?: number; output?: number }
      distillTokens.input = t.input ?? 0
      distillTokens.output = t.output ?? 0
    }
  } catch { /* 首次启动无记录 */ }
}

export function addDistillTokens(input: number, output: number): void {
  distillTokens.input += input
  distillTokens.output += output
  // fire-and-forget 持久化
  void getDb().then(async (db) => {
    await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(TOKENS_KEY, JSON.stringify(distillTokens))
  }).catch(() => {})
}

function resetDistillTokens(): void {
  distillTokens.input = 0
  distillTokens.output = 0
  void getDb().then(async (db) => {
    await db.prepare('DELETE FROM meta WHERE key = ?').run(TOKENS_KEY)
  }).catch(() => {})
}

/** P2 mem agent 写入口（渲染层六通道不含 create，暂不注册 IPC） */
interface MemoryCreateInput {
  /** 工程条目按 projectRoot 归键；global=true 则落 'global' 跨工程 */
  projectRoot?: string
  global?: boolean
  /** short 层归属会话；long 为 NULL */
  sessionId?: string | null
  tier: MemoryTier
  category: string
  title: string
  content: string
  sourceJson?: string | null
  importance?: number
  /** 来源契约（写入侧打标，模型不可自填）；缺省 agent_suggest */
  origin?: MemoryOrigin
}

/** 显式条目重要度下限：「你亲口说的，不会被往后排」（衰减/覆写都不许打穿） */
const EXPLICIT_IMPORTANCE_FLOOR = 0.6

function effectiveImportance(raw: number | undefined, origin: MemoryOrigin | undefined): number {
  const base = clampImportance(raw ?? 0.5)
  return origin === 'user_explicit' ? Math.max(base, EXPLICIT_IMPORTANCE_FLOOR) : base
}

/** 信息量门控（mem0 式 UPDATE-with-gate）：新正文是旧正文的大幅子串 = 退化覆写，拒绝。
 *  纯启发式：真重写几乎不会是旧文的严格子串；合法精简（提炼）与改写都放行 */
function assertNotDegraded(oldContent: string, newContent: string): void {
  const oldC = oldContent.trim()
  const newC = newContent.trim()
  if (oldC && newC && oldC.includes(newC) && newC.length < oldC.length * 0.5) {
    throw new Error('疑似信息退化（新正文只是旧正文的片段）：请保留完整信息后再更新')
  }
}

// ---------- 嵌入模型指纹（meta 表 embed_model_fingerprint，不符停向量路；全量重嵌 P3） ----------

const FINGERPRINT_KEY = 'embed_model_fingerprint'

/** 当前预期指纹（模型 id|维度）。配置不可读回 null。 */
async function expectedFingerprint(): Promise<string | null> {
  try {
    const cfg = await getConfig()
    return `${cfg.embedModel || DEFAULT_EMBED_MODEL}|${EMBED_DIM}`
  } catch {
    return null
  }
}

/** 指纹校验：首嵌写入、不符告警并回 false（调用方停向量路）。
 *  每次嵌入前调（单行 PK 读代价可忽略），天然跨 initDbAt 换库保持正确。 */
async function checkEmbedFingerprint(db: SqliteDb): Promise<boolean> {
  const expected = await expectedFingerprint()
  if (!expected) return true
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').get(FINGERPRINT_KEY) as { value: string } | undefined
  if (!row?.value) {
    if (embedReady()) await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(FINGERPRINT_KEY, expected)
    return true
  }
  if (row.value !== expected) {
    console.warn(`[memory] 嵌入模型指纹不符：库内 ${row.value}，当前 ${expected}——向量路停用（P3 全量重嵌后恢复）`)
    return false
  }
  return true
}

/** smoke 注入：确定性假 embedder（module-level override，null 恢复真实现） */
type EmbedFn = (texts: string[]) => Promise<Float32Array[]>
let embedOverride: EmbedFn | null = null
export function setEmbedder(fn: EmbedFn | null): void { embedOverride = fn }
function callEmbed(texts: string[]): Promise<Float32Array[]> {
  return embedOverride ? embedOverride(texts) : embedTexts(texts)
}

// ---------- 双轨检索打分（importance=语义价值静态字段 / activation=使用热度检索时纯函数） ----------

/** RRF 融合常数（论文默认 60） */
const RRF_K = 60
/** 打分权重（Σ=1，三者同量纲 [0,1] 后权重即贡献占比）：语义相关性主轴，先验只做平移 */
const W_RRF = 0.55
const W_IMPORTANCE = 0.2
const W_ACTIVATION = 0.25
const DAY_MS = 86_400_000

/** 使用热度激活度（检索时纯函数，零写库——「衰减」永不产生 UPDATE churn）：
 *  Δt 基准 last_accessed_at（被使用就强化——不是 updated_at，折叠刷新不白拿热度），从未访问退化为 created_at。
 *  半衰期表/饱和函数单一真源在 shared/memory-scoring.ts（渲染层「重要度」展示同源）。 */
function activationOf(row: MemRow, now: number): number {
  return memoryActivation(row.access_count, row.last_accessed_at, row.created_at, row.category, now)
}
/** 向量召回距离封顶（vec0 默认 L2；bge 输出已归一化，L2²=2-2cos，1.0 ≈ cos>0.5 的粗筛）。
 *  不设门槛时 KNN 在小语料下会把所有条目当"最近邻"灌进融合，污染检索结果。 */
const VEC_DISTANCE_CAP = 1.0

// ---------- 六通道 ----------

/** 列表：本工程 + 跨工程（'global'）条目，updated_at 降序；projectRoot=null 仅查 global */
export async function memoryList(projectRoot: string | null, includeArchived = false): Promise<{ items: MemoryItem[] }> {
  const db = await getDb()
  const statusSql = includeArchived ? '' : " AND status = 'active'"
  if (!projectRoot) {
    const rows = await db.prepare(`SELECT * FROM mem_items WHERE project_key = 'global'${statusSql} ORDER BY updated_at DESC`).all() as unknown as MemRow[]
    return { items: rows.map(rowToItem) }
  }
  const key = projectKey(projectRoot)
  const rows = await db
    .prepare(`SELECT * FROM mem_items WHERE (project_key = ? OR project_key = 'global')${statusSql} ORDER BY updated_at DESC`)
    .all(key) as unknown as MemRow[]
  return { items: rows.map(rowToItem) }
}

/** 混合检索：FTS/LIKE + vec KNN → RRF 融合 + 轻加权 → topK；projectRoot=null 仅查 global */
export async function memorySearch(
  query: string, projectRoot: string | null, topK = 8, includeArchived = false,
): Promise<MemorySearchResult> {
  const db = await getDb()
  const key = projectRoot ? projectKey(projectRoot) : null
  const q = String(query ?? '').trim()
  if (!q) return { hits: [], degraded: false }
  const limit = clampTopK(topK)
  const fingerprintOk = await checkEmbedFingerprint(db)
  // embedding 繁忙时（AI 记忆检索 / 蒸馏正在推理）跳过向量路，避免串行队列阻塞 IPC 响应
  const useVec = vecReadyFlag() && fingerprintOk && embedReady() && !isEmbedBusy()
  const headroom = limit * 3 // 融合前多捞，补偿 scope/status 过滤与两路交叉

  // 关键词路：≥3 字走 FTS5 trigram 短语查询；1-2 字 trigram 无法成串，走 LIKE 兜底
  const kwRows = await (q.length >= 3
    ? searchFts(db, q, key, includeArchived, headroom)
    : searchLike(db, q, key, includeArchived, headroom))

  // 向量路：KNN 召回（embed 失败/超维不阻断，降级关键词路）
  let vecRows: { row: MemRow; distance: number }[] = []
  let vecFailed = false
  if (useVec) {
    try {
      const vecs = await safeEmbed([q])
      let vec = vecs.length === 1 && vecs[0]?.length === EMBED_DIM ? vecs[0] : null
      if (vec) {
        // 全零向量无信息量（与任何条目等距），按本次不可用处理而非放行污染
        let nonzero = false
        for (const x of vec) { if (x !== 0) { nonzero = true; break } }
        if (!nonzero) vec = null
      }
      if (vec) {
        const near = await db
          .prepare('SELECT item_id, distance FROM mem_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
          .all(vec, headroom) as { item_id: string; distance: number }[]
        const byId = await fetchRowsByIds(db, near.map((n) => n.item_id))
        for (const n of near) {
          if (Number(n.distance) > VEC_DISTANCE_CAP) continue
          const row = byId.get(n.item_id)
          if (row && inScope(row, key, includeArchived)) vecRows.push({ row, distance: Number(n.distance) })
        }
      } else {
        vecFailed = true
      }
    } catch (e) {
      console.warn(`[memory] 向量召回失败，降级关键词路：${String(e)}`)
      vecFailed = true
    }
  }

  // 双轨打分：RRF（语义似然）为排序主轴 + importance（语义价值）/ activation（使用热度）先验。
  // rrf_norm = rrf × 61/n_paths 归一到 [0,1]（单路 rank1 与双路 rank1 同映射满分），
  // 三者同量纲后权重即贡献占比
  const now = Date.now()
  const nPaths = (kwRows.length > 0 ? 1 : 0) + (vecRows.length > 0 ? 1 : 0)
  const rrfScale = (RRF_K + 1) / Math.max(1, nPaths)
  const scores = new Map<string, { row: MemRow; rrf: number }>()
  const add = (row: MemRow, rank: number): void => {
    const cur = scores.get(row.id)
    scores.set(row.id, { row, rrf: (cur?.rrf ?? 0) + 1 / (RRF_K + rank) })
  }
  kwRows.forEach((row, i) => add(row, i + 1))
  vecRows.forEach(({ row }, i) => add(row, i + 1))
  const hits: MemoryHit[] = [...scores.values()]
    .map(({ row, rrf }) => ({
      ...rowToItem(row),
      score: W_RRF * rrf * rrfScale + W_IMPORTANCE * row.importance + W_ACTIVATION * activationOf(row, now),
    }))
    .sort((a, b) => b.score - a.score || (b.lastAccessedAt ?? b.createdAt) - (a.lastAccessedAt ?? a.createdAt))
    .slice(0, limit)

  // 回写访问计数：defer 到下一轮事件循环，不阻塞 IPC 响应。
  // 并发说明：单语句原子，与 memoryClear 的 SELECT→事务删除交错时最多对已删 id UPDATE 0 行，无害。
  if (hits.length > 0) {
    const ids = hits.map((h) => h.id)
    const ts = Date.now()
    setImmediate(() => {
      try {
        const touch = db.prepare('UPDATE mem_items SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?')
        for (const id of ids) void touch.run(ts, id)
      } catch { /* 静默：不阻塞检索主链路 */ }
    })
  }
  return { hits, degraded: !useVec || vecFailed }
}

/** 更新：title/content 变化时重嵌（read→embed→write 收口为「embed 在事务外、写在一个同步事务」；
 *  embed 失败整体 no-op 返回原条目）。显式字段的并发写为 last-write-wins（正确语义）；
 *  embed 期间条目被并发删除时 UPDATE 影响 0 行 → 向量一并放弃，不留孤儿。 */
export async function memoryUpdate(id: string, patch: MemoryPatch, opts?: { by?: MemoryArchivedBy }): Promise<MemoryItem> {
  const db = await getDb()
  const row = await getRow(db, id)
  if (!row) throw new Error(`记忆不存在：${id}`)
  // status='active' = 恢复语义（un-archive：清归档痕迹 + 重新计活）
  if (patch.status === 'active') return memoryUnarchive(id)
  // status='archived' 不在此受理（归档要带理由与操作者审计，走 memory_archive）——
  // 类型面允许但静默吞掉会让调用方以为归档成功
  if (patch.status === 'archived') {
    throw new Error('归档请走 memory_archive（需要理由与操作者审计）；memory_update 不支持 status=archived')
  }
  const origin = toOrigin(row.origin)
  const nextTitle = typeof patch.title === 'string' ? patch.title : row.title
  const nextContent = typeof patch.content === 'string' ? patch.content : row.content
  const nextCategory = typeof patch.category === 'string' ? patch.category : row.category
  const nextImportance = typeof patch.importance === 'number'
    ? effectiveImportance(patch.importance, origin) // 显式条目下限 0.6，衰减/覆写不许打穿
    : row.importance
  const textChanged = nextTitle !== row.title || nextContent !== row.content
  const metaChanged = nextCategory !== row.category || nextImportance !== row.importance
  // 语义推翻：本条取代 target——target 归档留痕并回链（新版本 = 当前更新的这条）
  const supersedesId = typeof patch.supersedes === 'string' && patch.supersedes.trim() && patch.supersedes.trim() !== id
    ? patch.supersedes.trim()
    : null
  if (!textChanged && !metaChanged && !supersedesId) return rowToItem(row)
  if (textChanged) assertNotDegraded(row.content, nextContent) // 信息量门控：拦退化覆写（副作用前）

  // 嵌入在事务外（纯函数不读库）：失败（空结果/超维/抛错）即整体 no-op——条目与向量保持一致旧态
  let vector: Float32Array | null = null
  if (textChanged) {
    vector = await embedOne(db, nextTitle, nextContent)
    if (!vector && vecReadyFlag() && embedReady()) {
      console.warn(`[memory] 重嵌失败，更新整体回滚：${id}`)
      return rowToItem(row)
    }
  }

  // 取代归档：校验与重嵌都通过后才动 target（先归档后失败会留下「已取代但新版本没写上」的半程状态）。
  // 目标不存在 → 只告警不阻断本条更新；目标是显式条目 → memoryArchive 按保护契约抛错（不自动放行）
  if (supersedesId) {
    const target = await getRow(db, supersedesId)
    if (!target) {
      console.warn(`[memory] supersedes 目标不存在：${supersedesId}`)
    } else {
      const ok = await memoryArchive(supersedesId, {
        by: opts?.by ?? 'distill', reason: '被新版本取代', supersedes: id,
      })
      if (!ok) console.warn(`[memory] supersedes 目标已归档：${supersedesId}`)
    }
  }
  // vec 不可用时只更新文本：向量表不可达（vecReady 把关），FTS 由触发器自同步。
  // 文本变更 → 热钟归零（内容刷新即一次「被用」，但不虚增 access_count）；纯元数据变更不动热钟
  const nowTs = Date.now()
  const heatTs = textChanged ? nowTs : null
  if (vector) {
    await db.transaction([
      { sql: 'UPDATE mem_items SET title = ?, content = ?, category = ?, importance = ?, last_accessed_at = COALESCE(?, last_accessed_at), updated_at = ? WHERE id = ?', params: [nextTitle, nextContent, nextCategory, nextImportance, heatTs, nowTs, id] },
      { sql: 'DELETE FROM mem_vec WHERE item_id = ?', params: [id] },
      { sql: 'INSERT INTO mem_vec (item_id, embedding) VALUES (?, ?)', params: [id, vector] },
    ])
  } else {
    await db.prepare(
      'UPDATE mem_items SET title = ?, content = ?, category = ?, importance = ?, last_accessed_at = COALESCE(?, last_accessed_at), updated_at = ? WHERE id = ?',
    ).run(nextTitle, nextContent, nextCategory, nextImportance, heatTs, nowTs, id)
  }
  emitMemoryChanged([row.project_key])
  const updated = await getRow(db, id)
  return rowToItem(updated ?? row)
}

/** 删除：mem_items（触发器清 FTS）+ mem_vec 同步清 */
export async function memoryDelete(id: string): Promise<void> {
  const db = await getDb()
  const row = await getRow(db, id)
  const stmts: { sql: string; params?: unknown[] }[] = [
    { sql: 'DELETE FROM mem_items WHERE id = ?', params: [id] },
  ]
  if (vecReadyFlag()) stmts.push({ sql: 'DELETE FROM mem_vec WHERE item_id = ?', params: [id] })
  await db.transaction(stmts)
  if (row) emitMemoryChanged([row.project_key])
}

/** scope 转换：项目记忆 ↔ 用户记忆（改 project_key；向量/FTS 按 rowid 不受影响，不重嵌）。
 *  target='user' → project_key='global' + 强制 tier='long' + session_id 清空（跨工程稳定事实不挂会话）；
 *  target='project' → project_key=projectKey(projectRoot)（需当前工程；tier/session 保持）。
 *  summary 类（会话滚动摘要）拒绝转换。 */
export async function memoryMoveScope(
  id: string, target: 'project' | 'user', projectRoot?: string,
): Promise<MemoryItem> {
  const db = await getDb()
  const row = await getRow(db, id)
  if (!row) throw new Error(`记忆不存在：${id}`)
  if (row.category === 'summary') throw new Error('会话滚动摘要不支持 scope 转换')
  const toUser = target === 'user'
  if (!toUser && !projectRoot) throw new Error('转为项目记忆需要指定目标工程')
  const nextKey = toUser ? 'global' : projectKey(String(projectRoot))
  const nextTier = toUser ? 'long' : row.tier
  const nextSession = toUser ? null : row.session_id
  await db.prepare(
    'UPDATE mem_items SET project_key = ?, tier = ?, session_id = ?, updated_at = ? WHERE id = ?',
  ).run(nextKey, nextTier, nextSession, Date.now(), id)
  emitMemoryChanged([row.project_key, nextKey])
  const updated = await getRow(db, id)
  return rowToItem(updated ?? row)
}

/** 作用域 SQL 片段（clear/export/import 共用）：project=本工程键（'global' 跨工程条目归 global 档管） */
function scopeWhere(scope: 'project' | 'global' | 'all', projectRoot?: string): { where: string; params: unknown[] } {
  if (scope === 'project') {
    if (!projectRoot) throw new Error('scope=project 需要 projectRoot')
    return { where: 'project_key = ?', params: [projectKey(projectRoot)] }
  }
  if (scope === 'global') return { where: "project_key = 'global'", params: [] }
  return { where: '1=1', params: [] }
}

/** 清空：project=本工程键（'global' 跨工程条目归 global 档管）/ global / all */
export async function memoryClear(scope: 'project' | 'global' | 'all', projectRoot?: string): Promise<void> {
  const db = await getDb()
  const { where, params } = scopeWhere(scope, projectRoot)
  const rows = await db.prepare(`SELECT id FROM mem_items WHERE ${where}`).all(...params) as { id: string }[]
  // 蒸馏 token 归零：清空即归零（字段文档与面板口径「清空记忆时归零」，含空清空）。
  // 计数是全局近似值，局部清空也从零重新累计——否则「清了记忆、面板还挂着旧账」
  resetDistillTokens()
  if (rows.length === 0) return
  const stmts: { sql: string; params?: unknown[] }[] = []
  for (const { id } of rows) {
    stmts.push({ sql: 'DELETE FROM mem_items WHERE id = ?', params: [id] })
    if (vecReadyFlag()) stmts.push({ sql: 'DELETE FROM mem_vec WHERE item_id = ?', params: [id] })
  }
  await db.transaction(stmts)
  emitMemoryChanged(
    scope === 'all' ? 'all' : [scope === 'global' ? 'global' : projectKey(String(projectRoot))],
  )
}

/** 统计：面板概览用（active/archived 分账——「共 N 条」与列表对不上是信任杀手） */
export async function memoryStats(): Promise<MemoryStats> {
  const db = await getDb()
  const total = ((await db.prepare('SELECT COUNT(*) AS n FROM mem_items').get()) as { n: number }).n
  const activeCount = Number(((await db.prepare("SELECT COUNT(*) AS n FROM mem_items WHERE status = 'active'").get()) as { n: number }).n)
  const archivedCount = Number(((await db.prepare("SELECT COUNT(*) AS n FROM mem_items WHERE status = 'archived'").get()) as { n: number }).n)
  const byTier: Record<string, number> = {}
  for (const r of await db.prepare('SELECT tier AS k, COUNT(*) AS n FROM mem_items GROUP BY tier').all() as { k: string; n: number }[]) {
    byTier[r.k] = r.n
  }
  const byCategory: Record<string, number> = {}
  for (const r of await db.prepare('SELECT category AS k, COUNT(*) AS n FROM mem_items GROUP BY category').all() as { k: string; n: number }[]) {
    byCategory[r.k] = r.n
  }
  let dbBytes = 0
  try {
    dbBytes = statSync(path.join(await dataDir(), 'qyris.db')).size
  } catch {
    /* 库文件尚不存在时回 0 */
  }
  return {
    total,
    activeCount,
    archivedCount,
    byTier,
    byCategory,
    embedReady: embedReady(),
    vecAvailable: vecReadyFlag(),
    dbBytes,
    distillTokens: { ...distillTokens },
  }
}

// ---------- 写入口（P2 mem agent 用） ----------

// ── 并发一致性纪律（多工程常驻 + 单主进程 + 单同步连接）──
// better-sqlite3 是同步 API：一个「不含 await 的同步事务」在单线程主进程里是原子的。
// 因此所有 check-then-act（查重→折叠/插入、importance 累加）必须收进同一个同步事务；
// 唯一允许跨在事务之间的 await 是 embed（纯函数，不读库）——嵌入结果回写时以
// 「行仍存在」为准（writeVecGuarded），embed 期间被并发删除/清空则放弃落向量。
// 库级兜底：idx_mem_active_title 部分唯一索引（db.ts 启动时确保）拦截漏网重复。

/** 记忆数据变更广播：主进程是全部窗口共享的单例库，任何写完成后广播，让各窗口列表自刷新
 *  （渲染层防抖消费）。主进程不节流；衰减作业（importance 漂移）刻意不发——不影响条目集合。 */
function emitMemoryChanged(keys: string[] | 'all'): void {
  const payload = keys === 'all'
    ? { all: true, projectKeys: [] as string[] }
    : { all: false, projectKeys: [...new Set(keys)] }
  emitToAllWindows('memory-changed', payload)
}

/** 插入 mem_items 行（FTS 由触发器自同步） */
async function insertItemTx(db: SqliteDb, item: MemoryItem): Promise<void> {
  await db.prepare(
    `INSERT INTO mem_items
       (id, project_key, session_id, tier, category, title, content, source_json, importance,
        access_count, last_accessed_at, status, superseded_by, origin, archived_at, archived_by, archived_reason,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'active', NULL, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    item.id, item.projectKey, item.sessionId, item.tier, item.category, item.title, item.content,
    item.sourceJson, item.importance, item.origin, item.createdAt, item.updatedAt,
  )
}

/** 嵌入结果回写（事务）：条目已不存在（embed 期间被并发删除/清空）则放弃，不留孤儿向量 */
async function writeVecGuarded(db: SqliteDb, id: string, vec: Float32Array | null): Promise<void> {
  if (!vec || !vecReadyFlag()) return
  const exists = await db.prepare('SELECT 1 FROM mem_items WHERE id = ?').get(id)
  if (!exists) return
  await db.transaction([
    { sql: 'DELETE FROM mem_vec WHERE item_id = ?', params: [id] },
    { sql: 'INSERT INTO mem_vec (item_id, embedding) VALUES (?, ?)', params: [id, vec] },
  ])
}

/** 嵌入一条（事务外调用）；不可用/失败回 null（条目照落，仅关键词可检索） */
async function embedOne(db: SqliteDb, title: string, content: string): Promise<Float32Array | null> {
  if (!vecReadyFlag() || !(await checkEmbedFingerprint(db)) || !embedReady()) return null
  const vecs = await safeEmbed([embedDoc(title, content)])
  return vecs.length === 1 && vecs[0]?.length === EMBED_DIM ? vecs[0] : null
}

/** 原子「新建或折叠」（mem agent create 唯一入口）：查重与写入收进同一同步事务——
 *  双工程并发蒸馏不再产生重复行（应用层不变量 + 唯一索引双保险）。
 *  折叠语义分两路：
 *   · 目标是显式条目（origin=user_explicit）→ 不覆写内容，改走 supersede：新建承接契约
 *     （origin 继承 user_explicit、importance 取 MAX），旧行归档留痕并回链——显式记忆绝不无痕改写；
 *   · 普通条目 → content 覆写、importance 取 MAX（只升不降）；caller 是显式时契约升级到目标行。
 *  信息量门控：新正文是旧正文大幅子串 → 拒绝退化覆写（mem0 式 UPDATE-with-gate）。
 *  UPDATE 带 status='active' 守卫：SELECT→UPDATE 间隙被衰减作业归档时不落进归档行，转插入。 */
export async function createOrFoldAtomic(input: MemoryCreateInput): Promise<{ folded: boolean; id: string }> {
  const db = await getDb()
  const key = input.global ? 'global' : projectKey(String(input.projectRoot ?? ''))
  if (!input.global && !input.projectRoot) throw new Error('memory_create 需要 projectRoot 或 global=true')
  const now = Date.now()
  const origin: MemoryOrigin = input.origin ?? 'agent_suggest'
  const importance = effectiveImportance(input.importance, origin)
  // 查重 → 折叠 / 插入（SELECT 在事务外，条件分支分别执行）
  const dup = await db
    .prepare(
      `SELECT id, importance, origin, content FROM mem_items
       WHERE project_key = ? AND category = ? AND title = ? AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(key, input.category, input.title) as { id: string; importance: number; origin: string | null; content: string } | undefined

  if (dup && toOrigin(dup.origin) === 'user_explicit') {
    // 显式条目：supersede 不覆写——新行承接契约（origin 继承 user_explicit、importance 取 MAX），
    // 旧行归档留痕回链。显式记忆绝不无痕改写（产品信任红线）；信息量门控同拦退化覆写
    assertNotDegraded(dup.content, input.content)
    const item: MemoryItem = {
      id: `mem_${randomUUID()}`,
      projectKey: key,
      sessionId: input.sessionId ?? null,
      tier: input.tier,
      category: toCategory(input.category),
      title: input.title,
      content: input.content,
      sourceJson: input.sourceJson ?? null,
      importance: Math.max(dup.importance, importance),
      accessCount: 0,
      lastAccessedAt: null,
      status: 'active',
      supersededBy: null,
      origin: 'user_explicit',
      archivedAt: null,
      archivedBy: null,
      archivedReason: null,
      createdAt: now,
      updatedAt: now,
    }
    await db.transaction([
      {
        sql: "UPDATE mem_items SET status = 'archived', superseded_by = ?, archived_at = ?, archived_by = ?, archived_reason = '被新版本取代', updated_at = ? WHERE id = ? AND status = 'active'",
        params: [item.id, now, archivedByOf(origin), now, dup.id],
      },
      {
        sql: `INSERT INTO mem_items (id, project_key, session_id, tier, category, title, content, source_json, importance, access_count, last_accessed_at, status, superseded_by, origin, archived_at, archived_by, archived_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'active', NULL, ?, NULL, NULL, NULL, ?, ?)`,
        params: [item.id, item.projectKey, item.sessionId, item.tier, item.category, item.title, item.content, item.sourceJson, item.importance, item.origin, item.createdAt, item.updatedAt],
      },
    ])
    await writeVecGuarded(db, item.id, await embedOne(db, item.title, item.content))
    emitMemoryChanged([key])
    return { folded: true, id: item.id }
  }

  if (dup) {
    // 普通折叠：信息量门控拦退化覆写；status='active' 守卫防「写进已归档行」（decay 归档落在
    // SELECT→UPDATE 间隙的竞态）；caller 是显式时契约升级到目标行（保护传递）；内容刷新 → 热钟归零
    assertNotDegraded(dup.content, input.content)
    const upgradedOrigin = origin === 'user_explicit' ? 'user_explicit' : toOrigin(dup.origin)
    const r = await db.prepare(
      "UPDATE mem_items SET content = ?, importance = MAX(importance, ?), origin = ?, last_accessed_at = ?, updated_at = ? WHERE id = ? AND status = 'active'",
    ).run(input.content, importance, upgradedOrigin, now, now, dup.id)
    if (Number(r.changes) > 0) {
      await writeVecGuarded(db, dup.id, await embedOne(db, input.title, input.content))
      emitMemoryChanged([key])
      return { folded: true, id: dup.id }
    }
    // 守卫失败（间隙内被归档）：走插入，唯一索引此时不冲突（旧行已 archived）
  }
  const item: MemoryItem = {
    id: `mem_${randomUUID()}`,
    projectKey: key,
    sessionId: input.sessionId ?? null,
    tier: input.tier,
    category: toCategory(input.category),
    title: input.title,
    content: input.content,
    sourceJson: input.sourceJson ?? null,
    importance,
    accessCount: 0,
    lastAccessedAt: null,
    status: 'active',
    supersededBy: null,
    origin,
    archivedAt: null,
    archivedBy: null,
    archivedReason: null,
    createdAt: now,
    updatedAt: now,
  }
  await insertItemTx(db, item)
  // 事务外：嵌入 + 向量回写（存在性检查防孤儿）
  await writeVecGuarded(db, item.id, await embedOne(db, input.title, input.content))
  emitMemoryChanged([key])
  return { folded: false, id: item.id }
}

/** 新建（无折叠语义的直建入口，agent create 走 createOrFoldAtomic）：
 *  同步事务插入 → 事务外 embed → 向量回写带存在性检查（embed 期间被删则不留孤儿向量）。
 *  向量为 best-effort（embedder 未就绪/失败时仅落文本条目，FTS 可检索，不丢数据）。 */
export async function memoryCreate(input: MemoryCreateInput): Promise<MemoryItem> {
  const db = await getDb()
  const key = input.global ? 'global' : projectKey(String(input.projectRoot ?? ''))
  if (!input.global && !input.projectRoot) throw new Error('memory_create 需要 projectRoot 或 global=true')
  const now = Date.now()
  const origin: MemoryOrigin = input.origin ?? 'agent_suggest'
  const item: MemoryItem = {
    id: `mem_${randomUUID()}`,
    projectKey: key,
    sessionId: input.sessionId ?? null,
    tier: input.tier,
    category: toCategory(input.category),
    title: input.title,
    content: input.content,
    sourceJson: input.sourceJson ?? null,
    importance: effectiveImportance(input.importance, origin),
    accessCount: 0,
    lastAccessedAt: null,
    status: 'active',
    supersededBy: null,
    origin,
    archivedAt: null,
    archivedBy: null,
    archivedReason: null,
    createdAt: now,
    updatedAt: now,
  }
  await insertItemTx(db, item)
  await writeVecGuarded(db, item.id, await embedOne(db, item.title, item.content))
  emitMemoryChanged([key])
  return item
}

// ---------- P2：mem agent 支撑面（session 摘要 / lesson / 归档 / 长期记忆标题） ----------

const SUMMARY_TITLE = '会话滚动摘要'

/** 该 session 的 active 滚动摘要正文（无则 null）——memory_session_context 通道 */
export async function sessionSummary(projectRoot: string, sessionId: string): Promise<string | null> {
  const db = await getDb()
  const row = await db
    .prepare(
      `SELECT content FROM mem_items
       WHERE project_key = ? AND session_id = ? AND tier = 'short' AND category = 'summary' AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(projectKey(projectRoot), sessionId) as { content: string } | undefined
  return row?.content ?? null
}

/** 滚动摘要写入（last-write-wins）：旧摘要归档 + 新摘要插入收进同一同步事务
 *  （唯一索引下「同档同分类同标题仅一条 active」不撞约束），embed 在事务外。 */
export async function saveSessionSummary(projectRoot: string, sessionId: string, content: string): Promise<void> {
  const db = await getDb()
  const key = projectKey(projectRoot)
  const now = Date.now()
  const item: MemoryItem = {
    id: `mem_${randomUUID()}`,
    projectKey: key,
    sessionId,
    tier: 'short',
    category: 'summary',
    title: SUMMARY_TITLE,
    content,
    sourceJson: null,
    importance: clampImportance(0.5),
    accessCount: 0,
    lastAccessedAt: null,
    status: 'active',
    supersededBy: null,
    origin: 'distill',
    archivedAt: null,
    archivedBy: null,
    archivedReason: null,
    createdAt: now,
    updatedAt: now,
  }
  const olds = await db.prepare(
    `SELECT id FROM mem_items
     WHERE project_key = ? AND session_id = ? AND tier = 'short' AND category = 'summary' AND status = 'active'`,
  ).all(key, sessionId) as { id: string }[]
  // 旧摘要换代也留痕（summary 是系统自用内容，reason 用固定模板）
  const stmts: { sql: string; params?: unknown[] }[] = olds.map((old) => ({
    sql: "UPDATE mem_items SET status = 'archived', archived_at = ?, archived_by = 'distill', archived_reason = '摘要换代', updated_at = ? WHERE id = ?",
    params: [now, now, old.id],
  }))
  stmts.push({
    sql: `INSERT INTO mem_items (id, project_key, session_id, tier, category, title, content, source_json, importance, access_count, last_accessed_at, status, superseded_by, origin, archived_at, archived_by, archived_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'active', NULL, ?, NULL, NULL, NULL, ?, ?)`,
    params: [item.id, item.projectKey, item.sessionId, item.tier, item.category, item.title, item.content, item.sourceJson, item.importance, item.origin, item.createdAt, item.updatedAt],
  })
  await db.transaction(stmts)
  await writeVecGuarded(db, item.id, await embedOne(db, item.title, content))
  emitMemoryChanged([key])
}

/** 归档（文本不变，不重嵌）：写归档痕迹三列 + 可选 supersede 回链 + 变更广播——
 *  自动归档必须可解释、可恢复（产品信任红线）。
 *  显式条目保护：origin=user_explicit 的条目默认拒绝归档（allowArchiveExplicit 显式放行才可）。
 *  返回：true=本次归档；false=已是归档态（幂等无操作）；目标不存在抛错。 */
export async function memoryArchive(
  id: string,
  opts?: { reason?: string; by?: MemoryArchivedBy; supersedes?: string; allowArchiveExplicit?: boolean },
): Promise<boolean> {
  const db = await getDb()
  const row = await getRow(db, id)
  if (!row) throw new Error(`记忆不存在：${id}`)
  if (row.status !== 'active') return false
  if (toOrigin(row.origin) === 'user_explicit' && opts?.allowArchiveExplicit !== true) {
    throw new Error(`「${row.title}」是用户显式保存的记忆，不许自动归档（确有必要请显式放行）`)
  }
  const now = Date.now()
  const by = opts?.by ?? 'user'
  const reason = opts?.reason?.trim() || (by === 'decay' ? '长期未使用，自动收起' : '手动归档')
  const result = await db.prepare(
    `UPDATE mem_items SET status = 'archived', archived_at = ?, archived_by = ?, archived_reason = ?,
       superseded_by = COALESCE(?, superseded_by), updated_at = ?
     WHERE id = ? AND status = 'active'`,
  ).run(now, by, reason, opts?.supersedes ?? null, now, id)
  if (Number(result.changes) === 0) return false
  emitMemoryChanged([row.project_key])
  return true
}

/** 恢复（un-archive）：清归档痕迹、恢复检索；「恢复即重新计活」防归档-恢复乒乓。
 *  同题已有活跃条目时撞唯一索引 → 报错让调用方决定，不静默跳过（假恢复比不恢复更糟）。 */
export async function memoryUnarchive(id: string): Promise<MemoryItem> {
  const db = await getDb()
  const row = await getRow(db, id)
  if (!row) throw new Error(`记忆不存在：${id}`)
  if (row.status === 'active') return rowToItem(row)
  const now = Date.now()
  try {
    await db.prepare(
      `UPDATE mem_items SET status = 'active', archived_at = NULL, archived_by = NULL, archived_reason = NULL,
         last_accessed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, id)
  } catch (e) {
    throw new Error(`恢复失败（同题已有活跃条目，请先处理重复项）：${String(e)}`)
  }
  emitMemoryChanged([row.project_key])
  return rowToItem({ ...row, status: 'active', archived_at: null, archived_by: null, archived_reason: null, last_accessed_at: now, updated_at: now })
}

/** note_lesson 通道：创建 short lesson；同工程已有 active 且同 title 的 lesson
 *  → 更新 content + importance+0.1（封顶 1）而非新建（重复踩坑是强化信号）。
 *  查重与写入收进同一同步事务，importance 的 +0.1 在 SQL 内累加——消灭 read-modify-write 丢更新。 */
export async function noteLesson(
  projectRoot: string, sessionId: string, lesson: { title: string; content: string },
): Promise<void> {
  const title = String(lesson?.title ?? '').trim()
  const content = String(lesson?.content ?? '')
  if (!title || !content.trim()) throw new Error('note_lesson 需要 title 与 content')
  const db = await getDb()
  const key = projectKey(projectRoot)
  const now = Date.now()
  const dup = await db
    .prepare(
      `SELECT id FROM mem_items
       WHERE project_key = ? AND category = 'lesson' AND status = 'active' AND title = ?
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(key, title) as { id: string } | undefined
  if (dup) {
    // 重复踩坑 = 强化信号：importance+0.1（永久，静态语义下不再被时间打回）+ 热钟归零 + 计一次使用
    const r = await db.prepare(
      "UPDATE mem_items SET content = ?, importance = MIN(1.0, importance + 0.1), access_count = access_count + 1, last_accessed_at = ?, updated_at = ? WHERE id = ? AND status = 'active'",
    ).run(content, now, now, dup.id)
    // 守卫失败（间隙内被归档）：走插入，不许静默丢掉这条教训
    if (Number(r.changes) > 0) return
  }
  const item: MemoryItem = {
    id: `mem_${randomUUID()}`,
    projectKey: key,
    sessionId,
    // tier 恒 long：教训是跨会话资产，不随 short 的自动归档窗口收起
    tier: 'long',
    category: 'lesson',
    title,
    content,
    sourceJson: null,
    importance: clampImportance(0.5),
    accessCount: 0,
    lastAccessedAt: null,
    status: 'active',
    supersededBy: null,
    origin: 'agent_suggest',
    archivedAt: null,
    archivedBy: null,
    archivedReason: null,
    createdAt: now,
    updatedAt: now,
  }
  await insertItemTx(db, item)
  await writeVecGuarded(db, item.id, await embedOne(db, title, content))
  emitMemoryChanged([key])
}

/** mem agent 渐进披露上下文清单（active，updated_at 降序）：长期（本工程+global）+ 本会话 short。
 *  patch/archive 定位与「合并优先于新建」判断都需要完整视野——只给 long 会漏掉本会话已蒸出的
 *  short/lesson，模型无从合并，重扫时只会重复新建。带 id，模型才定位得到 targetId */
export async function listContextTitles(
  projectRoot: string, sessionId: string, limit = 60,
): Promise<{ id: string; category: string; title: string }[]> {
  const db = await getDb()
  const key = projectKey(projectRoot)
  return await db
    .prepare(
      `SELECT id, category, title FROM mem_items
       WHERE status = 'active'
         AND ((tier = 'long' AND (project_key = ? OR project_key = 'global'))
           OR (tier = 'short' AND project_key = ? AND session_id = ?))
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(key, key, sessionId, limit) as { id: string; category: string; title: string }[]
}

// （原 findActiveDuplicate 已并入 createOrFoldAtomic：查重与写入必须同事务才原子，单独导出反而诱导误用）

// ---------- P3：衰减/归档作业（纯 SQL/JS，零 LLM） ----------

interface DecayStats {
  /** importance 被衰减的 long 条目数（双轨静态化后恒 0，保留字段兼容监控口径） */
  decayed: number
  /** 被归档的条目数 */
  archived: number
  /** 被物理清理的归档条目数（v2：supersede 链尾 365d / event 归档 180d，仅非显式来源） */
  purged: number
}

/** 衰减作业周期 */
const DECAY_INTERVAL_MS = 6 * 60 * 60_000
/** boot 后首跑延迟 */
const DECAY_BOOT_DELAY_MS = 30_000
/** importance 静态下限（语义价值地板；fact 低值陈旧行的归档判据之一） */
const DECAY_IMPORTANCE_FLOOR = 0.1
/** short 层归档基线：最后使用超 30d 且几乎未被检索（access_count ≤ 1） */
const ARCHIVE_SHORT_STALE_MS = 30 * DAY_MS
const ARCHIVE_SHORT_MAX_ACCESS = 1
/** event 层归档：60 天未更新即收起（事件是历史——排序先沉（h=7d 半衰期），归档后收） */
const ARCHIVE_EVENT_STALE_MS = 60 * DAY_MS
/** fact 层归档：importance 触底(≤0.1) 且 180d 未访问（显式写低值的陈旧事实） */
const ARCHIVE_FACT_STALE_MS = 180 * DAY_MS

/** 衰减/归档一轮（幂等；boot 由 startDecayJob 每 6h 调度；now 可注入供 smoke 测边界）。
 *  importance 是静态语义价值（双轨制：热度归 activation 检索时计算）——本作业**不写 importance**，
 *  只做归档（时间过时的三级退场），每类规则不同：
 *   - short：最后使用超 30d 且 access_count ≤1 → 归档（会话级短命）
 *   - event：updated_at 超 60d 未更新 → 归档（事件是历史，快进慢出：排序先沉、归档后收）
 *   - fact：importance 已触底(≤0.1) 且 180d 未访问 → 归档（显式写低值的陈旧事实）
 *   - preference / lesson / skill：永不自动归档（偏好/学费/技能不因冷置贬值——排序下沉即遗忘）
 *  显式条目（origin=user_explicit）一律豁免；归档写痕迹三列 + 审计锚点（meta 存 archivedIds，
 *  误归档批量恢复的唯一依据）+ 变更广播；设置开关 memAutoArchive=false 时全部归档规则停用。
 *  时钟守卫：now 回拨超 60s 跳过本轮（防审计时间线错乱；前跳场景靠审计+恢复通道兜底）。
 *  mem_vec 不动：归档后默认检索查不到即可，向量保留给 includeArchived 场景；updated_at 不动。 */
export async function runDecayJob(now: number = Date.now()): Promise<DecayStats> {
  if (decayInFlight) return { decayed: 0, archived: 0, purged: 0 } // in-flight 守卫：重叠两轮会双重归档
  decayInFlight = true
  try {
    const db = await getDb()
    // 时钟回拨守卫：now 比上次运行时间还早 60s 以上 = 时钟被拨回，跳过本轮
    const { ts: lastRun } = await readDecayAudit(db)
    if (lastRun > 0 && now < lastRun - 60_000) {
      console.warn(`[memory] 衰减作业跳过：时钟回拨（now=${now} < 上次 ${lastRun}）`)
      return { decayed: 0, archived: 0, purged: 0 }
    }
    const t0 = Date.now()
    // 归档规则受设置开关管（缺省开）：关掉 = 只调排序不动库（长期记忆永不自动清除）
    const autoArchive = await getConfig().then((c) => c.memAutoArchive !== false).catch(() => true)
    if (!autoArchive) {
      console.info('[memory] 衰减作业：归档 0（自动归档已关闭，排序衰减仍生效）')
      return { decayed: 0, archived: 0, purged: 0 }
    }
    // 归档三规则（先取 id 再按谓词更新——审计锚点需要 id 清单）：显式条目一律豁免
    const shortIds = (await db.prepare(
      `SELECT id FROM mem_items
       WHERE tier = 'short' AND status = 'active' AND origin != 'user_explicit'
         AND COALESCE(last_accessed_at, created_at) < ? AND access_count <= ?`,
    ).all(now - ARCHIVE_SHORT_STALE_MS, ARCHIVE_SHORT_MAX_ACCESS) as { id: string }[]).map((r) => r.id)
    const eventIds = (await db.prepare(
      `SELECT id FROM mem_items
       WHERE category = 'event' AND status = 'active' AND origin != 'user_explicit' AND updated_at < ?`,
    ).all(now - ARCHIVE_EVENT_STALE_MS) as { id: string }[]).map((r) => r.id)
    const factIds = (await db.prepare(
      `SELECT id FROM mem_items
       WHERE category = 'fact' AND status = 'active' AND origin != 'user_explicit'
         AND importance <= ? AND COALESCE(last_accessed_at, created_at) < ?`,
    ).all(DECAY_IMPORTANCE_FLOOR + 1e-9, now - ARCHIVE_FACT_STALE_MS) as { id: string }[]).map((r) => r.id)
    const archivedIds = [...shortIds, ...eventIds, ...factIds]
    let archivedCount = 0
    if (archivedIds.length > 0) {
      const batchDate = new Date(now)
      const localDay = `${batchDate.getFullYear()}-${String(batchDate.getMonth() + 1).padStart(2, '0')}-${String(batchDate.getDate()).padStart(2, '0')}`
      const reason = `长期未使用，自动收起（${localDay} 批次）`
      for (const id of archivedIds) {
        const r = await db.prepare(
          `UPDATE mem_items SET status = 'archived', archived_at = ?, archived_by = 'decay', archived_reason = ?
           WHERE id = ? AND status = 'active'`,
        ).run(now, reason, id)
        archivedCount += Number(r.changes)
      }
      emitMemoryChanged('all')
    }

    // v2 物理清理（仅 distill/agent 来源——显式条目永不物理删除）：
    //   ① supersede 链尾：被取代且归档超 365d（链已留痕，链尾无考古价值）
    //   ② event：归档超 180d（事件无审计刚需）
    // 旧迁移行 archived_at 为 NULL → 谓词不命中，保守不清理。mem_vec/FTS 随行清理（触发器自同步）。
    const purgeIds = (await db.prepare(
      `SELECT id FROM mem_items
       WHERE status = 'archived' AND origin != 'user_explicit' AND archived_at IS NOT NULL
         AND (
           (superseded_by IS NOT NULL AND archived_at < ?)
           OR (category = 'event' AND archived_at < ?)
         )`,
    ).all(now - 365 * DAY_MS, now - 180 * DAY_MS) as { id: string }[]).map((r) => r.id)
    let purged = 0
    if (purgeIds.length > 0) {
      const placeholders = purgeIds.map(() => '?').join(',')
      await db.transaction([
        { sql: `DELETE FROM mem_items WHERE id IN (${placeholders})`, params: purgeIds },
        { sql: `DELETE FROM mem_vec WHERE item_id IN (${placeholders})`, params: purgeIds },
      ])
      purged = purgeIds.length
      emitMemoryChanged('all')
    }

    const stats: DecayStats = { decayed: 0, archived: archivedCount, purged }
    // 审计锚点：误归档按批次恢复的唯一依据——保留近 5 轮非空批次（空跑不占窗口，
    // 否则连续空跑会把带 id 的真实批次挤掉，归档行还在但恢复依据已消失）
    const prior = await readDecayAudit(db)
    const runs = archivedIds.length > 0
      ? [{ ts: now, archivedIds }, ...prior.runs].slice(0, 5)
      : prior.runs
    await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(DECAY_AUDIT_KEY, JSON.stringify({ runs }))
    console.info(`[memory] 衰减作业：archive ${stats.archived} / purge ${stats.purged}（${Date.now() - t0}ms）`)
    return stats
  } finally {
    decayInFlight = false
  }
}

/** 衰减审计内读（runDecayJob 时钟守卫与写入共用） */
async function readDecayAudit(db: SqliteDb): Promise<{ ts: number; runs: { ts: number; archivedIds: string[] }[] }> {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').get(DECAY_AUDIT_KEY) as { value: string } | undefined
  if (!row?.value) return { ts: 0, runs: [] }
  try {
    const parsed = JSON.parse(row.value) as { ts?: number; runs?: { ts: number; archivedIds: string[] }[]; archivedIds?: string[] }
    // 兼容旧单轮格式 { ts, archivedIds }
    const runs = Array.isArray(parsed.runs) ? parsed.runs : parsed.archivedIds ? [{ ts: parsed.ts ?? 0, archivedIds: parsed.archivedIds }] : []
    return { ts: runs[0]?.ts ?? 0, runs }
  } catch {
    return { ts: 0, runs: [] }
  }
}

let decayInFlight = false
const DECAY_AUDIT_KEY = 'decay_last_run'

/** 读衰减审计（运维/恢复用）：近 5 轮归档 id 并集（误归档批量恢复依据） */
export async function memoryDecayAudit(): Promise<{ ts: number; archivedIds: string[] } | null> {
  const db = await getDb()
  const { ts, runs } = await readDecayAudit(db)
  if (runs.length === 0) return null
  return { ts, archivedIds: [...new Set(runs.flatMap((r) => r.archivedIds))] }
}

// ---------- 「上次整理」快照（面板摘要条数据源；蒸馏完成时落，读侧按 ts 判新旧） ----------

export type LastTidySnapshot = MemoryLastTidy

export async function saveLastTidy(s: LastTidySnapshot): Promise<void> {
  try {
    const db = await getDb()
    await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('mem_last_tidy', JSON.stringify(s))
  } catch { /* 摘要条是辅助面，失败不阻断 */ }
}

export async function lastTidy(): Promise<LastTidySnapshot | null> {
  try {
    const db = await getDb()
    const row = await db.prepare('SELECT value FROM meta WHERE key = ?').get('mem_last_tidy') as { value: string } | undefined
    return row?.value ? (JSON.parse(row.value) as LastTidySnapshot) : null
  } catch {
    return null
  }
}

/** 按审计批量恢复（误归档兜底）：逐条恢复，撞唯一索引的计入 failed 不静默跳过 */
export async function memoryRestoreMany(ids: readonly string[]): Promise<{ restored: number; failed: string[] }> {
  let restored = 0
  const failed: string[] = []
  for (const id of ids) {
    try {
      await memoryUnarchive(id)
      restored++
    } catch {
      failed.push(id)
    }
  }
  return { restored, failed }
}

let decayTimer: ReturnType<typeof setInterval> | null = null

/** boot 调度：延迟 30s 首跑 + 每 6h 循环；unref 不阻退出；幂等（重复调用不叠加定时器） */
export function startDecayJob(): void {
  if (decayTimer) return
  const first = setTimeout(() => {
    void runDecayJob().catch((e) => console.warn(`[memory] 衰减作业失败：${String(e)}`))
  }, DECAY_BOOT_DELAY_MS)
  first.unref?.()
  decayTimer = setInterval(() => {
    void runDecayJob().catch((e) => console.warn(`[memory] 衰减作业失败：${String(e)}`))
  }, DECAY_INTERVAL_MS)
  decayTimer.unref?.()
}

// ---------- P3：全量重嵌作业（嵌入模型指纹不符时的自愈） ----------

/** 重嵌批次大小（逐批 embed + 事务写回 + setImmediate 让路事件循环，防卡 UI） */
const REEMBED_BATCH = 64

/** boot 自愈入口（main 在 warmupEmbed 成功后调用）：meta 指纹与当前模型不符 →
 *  await 全量重嵌（main 侧 fire-and-forget，本函数可 await 供 smoke 断言）。
 *  embed 未就绪 / sqlite-vec 未加载 / 指纹一致 / 首嵌未发生 → 跳过等下次 boot。 */
export async function maybeStartReembedJob(): Promise<void> {
  const db = await getDb()
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').get(FINGERPRINT_KEY) as { value: string } | undefined
  const expected = await expectedFingerprint()
  if (!expected) return
  if (!row?.value) return // 首嵌闸门负责写入指纹，无需自愈
  if (row.value === expected) return
  if (!embedReady()) {
    console.info('[memory] 嵌入模型未就绪（下载中/降级），跳过全量重嵌（下次 boot 重试）')
    return
  }
  if (!vecReadyFlag()) {
    console.info('[memory] sqlite-vec 未加载，跳过全量重嵌（下次 boot 重试）')
    return
  }
  console.info(`[memory] 嵌入模型指纹不符（库内 ${row.value} → 当前 ${expected}），开始全量重嵌；期间与 mem agent 并行（各自行级写入无冲突）`)
  await runReembedJob(expected)
}

/** 全量重嵌：分批 embed 全部 active 条目（title+content 拼接，与 memoryCreate 同规则），
 *  逐批 DELETE+INSERT mem_vec。全部成功 → 写入新指纹；中途失败 → 保留旧指纹（下次 boot 重试，
 *  期间指纹闸门继续封锁向量路，半新半旧的向量不会被检索到）。 */
async function runReembedJob(expected: string): Promise<void> {
  const db = await getDb()
  const items = await db
    .prepare("SELECT id, title, content FROM mem_items WHERE status = 'active' ORDER BY rowid")
    .all() as { id: string; title: string; content: string }[]
  if (items.length === 0) {
    await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(FINGERPRINT_KEY, expected)
    console.info('[memory] 无 active 条目，指纹直接更新')
    return
  }
  // 绕过指纹闸门（闸门正是被这次作业解除的）：callEmbed 直接走真实/注入的 embedder
  const writeBatch = async (batch: { id: string; title: string; content: string }[], label: string): Promise<void> => {
    const vecs = await safeEmbed(batch.map((b) => embedDoc(b.title, b.content)))
    if (vecs.length !== batch.length) throw new Error(`${label}嵌入返回 ${vecs.length}/${batch.length}`)
    const stmts: { sql: string; params?: unknown[] }[] = []
    for (let j = 0; j < batch.length; j++) {
      const vec = vecs[j]
      if (vec?.length !== EMBED_DIM) throw new Error(`条目 ${batch[j].id} 嵌入维度异常`)
      stmts.push({ sql: 'DELETE FROM mem_vec WHERE item_id = ?', params: [batch[j].id] })
      stmts.push({ sql: 'INSERT INTO mem_vec (item_id, embedding) VALUES (?, ?)', params: [batch[j].id, vec] })
    }
    await db.transaction(stmts)
    await new Promise<void>((resolve) => setImmediate(resolve)) // 逐批让路事件循环
  }
  try {
    for (let i = 0; i < items.length; i += REEMBED_BATCH) {
      await writeBatch(items.slice(i, i + REEMBED_BATCH), `第 ${i} 批`)
    }
    // 补漏：作业期间新建的条目被指纹闸门挡在向量路外、又不在上面的快照里——
    // 按「active 但无向量行」补嵌一轮，否则它们要等下一次指纹变更才进得了向量路
    const missing = await db
      .prepare("SELECT id, title, content FROM mem_items WHERE status = 'active' AND id NOT IN (SELECT item_id FROM mem_vec)")
      .all() as { id: string; title: string; content: string }[]
    for (let i = 0; i < missing.length; i += REEMBED_BATCH) {
      await writeBatch(missing.slice(i, i + REEMBED_BATCH), `补漏第 ${i} 批`)
    }
    if (missing.length > 0) console.info(`[memory] 重嵌补漏：${missing.length} 条`)
    await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(FINGERPRINT_KEY, expected)
    console.info(`[memory] 全量重嵌完成：${items.length} 条（补漏 ${missing.length}），指纹已更新为 ${expected}`)
  } catch (e) {
    console.warn(`[memory] 全量重嵌失败，保留旧指纹（下次 boot 重试）：${String(e)}`)
  }
}

// ---------- P3：导出/导入（全量备份语义：含 archived/merged） ----------

interface MemoryExportPayload {
  version: 1
  exportedAt: number
  items: MemoryItem[]
}

interface MemoryExportResult {
  ok: boolean
  path?: string
  count?: number
  error?: string
}

interface MemoryImportResult {
  ok: boolean
  imported?: number
  skipped?: number
  error?: string
}

/** 对话框接缝：smoke 注入假实现离线测往返；缺省包一层 electron dialog（绑定调用方窗口） */
interface MemoryDialogAdapter {
  showSaveDialog(
    win: BrowserWindow | null, opts: { title: string; defaultPath: string },
  ): Promise<{ canceled: boolean; filePath?: string }>
  showOpenDialog(
    win: BrowserWindow | null, opts: { title: string; filters: { name: string; extensions: string[] }[] },
  ): Promise<{ canceled: boolean; filePaths: string[] }>
}

const electronDialog: MemoryDialogAdapter = {
  showSaveDialog: (win, opts) =>
    (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts)) as Promise<{ canceled: boolean; filePath?: string }>,
  showOpenDialog: (win, opts) =>
    (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts)) as Promise<{ canceled: boolean; filePaths: string[] }>,
}

let dialogAdapter: MemoryDialogAdapter | null = null

function activeDialog(): MemoryDialogAdapter {
  return dialogAdapter ?? electronDialog
}

/** 导出数据组装（内存纯函数，smoke 直测；scope 语义与 memoryClear 一致） */
async function memoryExportData(scope: 'project' | 'global' | 'all', projectRoot?: string): Promise<MemoryExportPayload> {
  const db = await getDb()
  const { where, params } = scopeWhere(scope, projectRoot)
  const rows = await db
    .prepare(`SELECT * FROM mem_items WHERE ${where} ORDER BY created_at ASC`)
    .all(...params) as unknown as MemRow[]
  return { version: 1, exportedAt: Date.now(), items: rows.map(rowToItem) }
}

/** 导出：保存对话框 → 写 JSON（含 archived，导出是全量备份语义）；取消回 ok:false */
export async function memoryExport(
  scope: 'project' | 'global' | 'all', projectRoot?: string, win?: BrowserWindow | null,
): Promise<MemoryExportResult> {
  let payload: MemoryExportPayload
  try {
    payload = await memoryExportData(scope, projectRoot)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const save = await activeDialog().showSaveDialog(win ?? null, {
    title: '导出记忆',
    defaultPath: `qyris-memory-${scope}-${new Date().toISOString().slice(0, 10)}.json`,
  })
  if (save.canceled || !save.filePath) return { ok: false, error: '已取消' }
  try {
    writeFileSync(save.filePath, JSON.stringify(payload, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` }
  }
  console.info(`[memory] 导出 ${payload.items.length} 条记忆 → ${save.filePath}`)
  return { ok: true, path: save.filePath, count: payload.items.length }
}

/** 导入数据应用（smoke 直测）：逐条校验 → 去重 → 插入 → 批量建向量。
 *  去重：同 id 已存在 skip；同 (project_key, category, title) 且已有 active skip——
 *  检查与插入收进单条同步事务（原子 check-then-act，与并发蒸馏互不产生重复行）。
 *  单条非法数据 skip 不拖垮整体；嵌入 best-effort（不可用时条目照落，仅关键词可检索）。 */
export async function memoryImportData(raw: string): Promise<{ imported: number; skipped: number }> {
  let payload: { version?: unknown; items?: unknown }
  try {
    payload = JSON.parse(raw) as { version?: unknown; items?: unknown }
  } catch (e) {
    throw new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }
  if (payload?.version !== 1 || !Array.isArray(payload.items)) {
    throw new Error('文件格式不符：需要 { version: 1, items: [...] }')
  }
  const db = await getDb()
  const insert = db.prepare(
    `INSERT INTO mem_items
       (id, project_key, session_id, tier, category, title, content, source_json, importance,
        access_count, last_accessed_at, status, superseded_by, origin, archived_at, archived_by, archived_reason,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const now = Date.now()
  const fresh: MemoryItem[] = []
  const touchedKeys = new Set<string>()
  let skipped = 0
  for (const rawItem of payload.items as unknown[]) {
    const it = (rawItem ?? {}) as Partial<MemoryItem>
    if (
      typeof it.id !== 'string' || !it.id
      || (it.tier !== 'short' && it.tier !== 'long')
      || typeof it.category !== 'string' || typeof it.title !== 'string' || typeof it.content !== 'string'
    ) {
      skipped++
      console.warn('[memory] 导入跳过一条非法条目（缺 id/tier/category/title/content）')
      continue
    }
    const key = typeof it.projectKey === 'string' && it.projectKey ? it.projectKey : 'global'
    const sid = typeof it.sessionId === 'string' ? it.sessionId : null
    const imp = clampImportance(typeof it.importance === 'number' ? it.importance : 0.5)
    const ac = typeof it.accessCount === 'number' && Number.isFinite(it.accessCount) ? Math.max(0, Math.floor(it.accessCount)) : 0
    const lat = typeof it.lastAccessedAt === 'number' ? it.lastAccessedAt : null
    const st = it.status === 'archived' || it.status === 'merged' ? it.status : 'active'
    const sb = typeof it.supersededBy === 'string' ? it.supersededBy : null
    const sj = typeof it.sourceJson === 'string' ? it.sourceJson : null
    // 存在性/重复检查 + 插入（检查在事务外，INSERT 原子）
    const idExists = await db.prepare('SELECT 1 FROM mem_items WHERE id = ?').get(it.id)
    if (idExists) { skipped++; continue }
    const titleDup = await db.prepare(
      "SELECT 1 FROM mem_items WHERE project_key = ? AND category = ? AND title = ? AND status = 'active'",
    ).get(key, it.category, it.title)
    if (titleDup) { skipped++; continue }
    // 备份里带来源/归档痕迹/时间戳就还原（roundtrip 审计连续）；旧格式（v1 无这些字段）按
    // 用户主动恢复备份 → user_explicit，归档态补导入痕迹
    const origin: MemoryOrigin = it.origin === 'user_explicit' || it.origin === 'agent_suggest' || it.origin === 'distill'
      ? it.origin
      : 'user_explicit'
    const archAt = st === 'archived' ? (typeof it.archivedAt === 'number' ? it.archivedAt : now) : null
    const archBy = st === 'archived' ? (toArchivedBy(it.archivedBy) ?? 'import') : null
    const archReason = st === 'archived'
      ? (typeof it.archivedReason === 'string' && it.archivedReason ? it.archivedReason : '导入自备份')
      : null
    const createdAt = typeof it.createdAt === 'number' ? it.createdAt : now
    const updatedAt = typeof it.updatedAt === 'number' ? it.updatedAt : now
    await insert.run(it.id, key, sid, it.tier, it.category, it.title, it.content, sj, imp, ac, lat, st, sb, origin, archAt, archBy, archReason, createdAt, updatedAt)
    touchedKeys.add(key)
    fresh.push({ id: it.id, projectKey: key, sessionId: sid, tier: it.tier, category: it.category, title: it.title, content: it.content, sourceJson: sj, importance: imp, accessCount: ac, lastAccessedAt: lat, status: st, supersededBy: sb, origin, archivedAt: archAt, archivedBy: archBy, archivedReason: archReason, createdAt, updatedAt })
  }
  if (fresh.length > 0) {
    const canVec = vecReadyFlag() && (await checkEmbedFingerprint(db)) && embedReady()
    if (!canVec) console.warn('[memory] 嵌入不可用（未就绪或指纹不符），导入条目暂仅关键词可检索')
    for (let i = 0; i < fresh.length && canVec; i += REEMBED_BATCH) {
      const batch = fresh.slice(i, i + REEMBED_BATCH)
      const vecs = await safeEmbed(batch.map((b) => embedDoc(b.title, b.content)))
      if (vecs.length !== batch.length) {
        console.warn('[memory] 导入批量嵌入失败，剩余条目仅关键词可检索')
        break
      }
      const stmts: { sql: string; params?: unknown[] }[] = []
      for (let j = 0; j < batch.length; j++) {
        if (vecs[j]?.length !== EMBED_DIM) continue
        const exists = await db.prepare('SELECT 1 FROM mem_items WHERE id = ?').get(batch[j].id)
        if (!exists) continue
        stmts.push({ sql: 'INSERT INTO mem_vec (item_id, embedding) VALUES (?, ?)', params: [batch[j].id, vecs[j]] })
      }
      if (stmts.length > 0) await db.transaction(stmts)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  if (touchedKeys.size > 0) emitMemoryChanged([...touchedKeys])
  return { imported: fresh.length, skipped }
}

/** 导入：打开对话框（json）→ 解析校验 → 逐条导入；取消/坏文件回 ok:false */
export async function memoryImport(win?: BrowserWindow | null): Promise<MemoryImportResult> {
  const open = await activeDialog().showOpenDialog(win ?? null, {
    title: '导入记忆',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (open.canceled || open.filePaths.length === 0) return { ok: false, error: '已取消' }
  let raw: string
  try {
    raw = readFileSync(open.filePaths[0], 'utf8')
  } catch (e) {
    return { ok: false, error: `读取失败：${e instanceof Error ? e.message : String(e)}` }
  }
  try {
    const { imported, skipped } = await memoryImportData(raw)
    console.info(`[memory] 导入完成：新增 ${imported} / 跳过 ${skipped}`)
    return { ok: true, imported, skipped }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- 内部 ----------

interface MemRow {
  id: string
  project_key: string
  session_id: string | null
  tier: string
  category: string
  title: string
  content: string
  source_json: string | null
  importance: number
  access_count: number
  last_accessed_at: number | null
  status: string
  superseded_by: string | null
  origin: string | null
  archived_at: number | null
  archived_by: string | null
  archived_reason: string | null
  created_at: number
  updated_at: number
}

const ORIGINS: ReadonlySet<string> = new Set<MemoryOrigin>(['user_explicit', 'agent_suggest', 'distill'])
function toOrigin(raw: string | null | undefined): MemoryOrigin {
  return raw && ORIGINS.has(raw) ? (raw as MemoryOrigin) : 'distill'
}
function toArchivedBy(raw: string | null | undefined): MemoryArchivedBy | null {
  return raw === 'user' || raw === 'agent' || raw === 'distill' || raw === 'decay' || raw === 'import' ? raw : null
}

/** 记忆写入来源 → 归档操作者（审计口径：agent 主动沉淀不冒充用户操作） */
export function archivedByOf(origin: MemoryOrigin): MemoryArchivedBy {
  return origin === 'distill' ? 'distill' : origin === 'user_explicit' ? 'user' : 'agent'
}

function rowToItem(row: MemRow): MemoryItem {
  return {
    id: row.id,
    projectKey: row.project_key,
    sessionId: row.session_id,
    tier: row.tier === 'short' ? 'short' : 'long',
    category: toCategory(row.category),
    title: row.title,
    content: row.content,
    sourceJson: row.source_json,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    status: row.status === 'merged' ? 'merged' : row.status === 'archived' ? 'archived' : 'active',
    supersededBy: row.superseded_by,
    origin: toOrigin(row.origin),
    archivedAt: row.archived_at,
    archivedBy: toArchivedBy(row.archived_by),
    archivedReason: row.archived_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function getRow(db: SqliteDb, id: string): Promise<MemRow | undefined> {
  return await db.prepare('SELECT * FROM mem_items WHERE id = ?').get(id) as MemRow | undefined
}

async function fetchRowsByIds(db: SqliteDb, ids: string[]): Promise<Map<string, MemRow>> {
  const map = new Map<string, MemRow>()
  if (ids.length === 0) return map
  const rows = await db.prepare(`SELECT * FROM mem_items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as MemRow[]
  for (const row of rows) map.set(row.id, row)
  return map
}

function inScope(row: MemRow, key: string | null, includeArchived: boolean): boolean {
  if (key === null) return row.project_key === 'global' && (includeArchived || row.status === 'active')
  if (row.project_key !== key && row.project_key !== 'global') return false
  return includeArchived || row.status === 'active'
}

/** project_key 范围 SQL 片段 + 参数：null=仅 global，非 null=本工程+global */
function scopeCond(key: string | null): { sql: string; param: unknown } {
  if (key === null) return { sql: "project_key = 'global'", param: undefined }
  return { sql: '(project_key = ? OR project_key = \'global\')', param: key }
}

/** FTS5 短语查询：整串引号包裹防 FTS 查询语法注入（内部引号双写转义），bm25 升序 = 相关性降序 */
async function searchFts(db: SqliteDb, q: string, key: string | null, includeArchived: boolean, limit: number): Promise<MemRow[]> {
  const phrase = `"${q.replace(/"/g, '""')}"`
  const statusSql = includeArchived ? '' : " AND mi.status = 'active'"
  const { sql, param } = scopeCond(key)
  const stmt = `SELECT mi.* FROM mem_fts JOIN mem_items mi ON mi.rowid = mem_fts.rowid WHERE mem_fts MATCH ? AND ${sql}${statusSql} ORDER BY bm25(mem_fts) LIMIT ?`
  return param !== undefined
    ? await db.prepare(stmt).all(phrase, param, limit) as unknown as MemRow[]
    : await db.prepare(stmt).all(phrase, limit) as unknown as MemRow[]
}

/** 1-2 字兜底：LIKE 全表（本工程+global 范围内），%/_/\ 转义防通配符注入 */
async function searchLike(db: SqliteDb, q: string, key: string | null, includeArchived: boolean, limit: number): Promise<MemRow[]> {
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const statusSql = includeArchived ? '' : " AND mi.status = 'active'"
  const { sql, param } = scopeCond(key)
  const stmt = `SELECT * FROM mem_items mi WHERE (mi.title LIKE ? ESCAPE '\\' OR mi.content LIKE ? ESCAPE '\\') AND ${sql}${statusSql} ORDER BY mi.updated_at DESC LIMIT ?`
  return param !== undefined
    ? await db.prepare(stmt).all(pattern, pattern, param, limit) as unknown as MemRow[]
    : await db.prepare(stmt).all(pattern, pattern, limit) as unknown as MemRow[]
}

/** 嵌入文本：标题与正文拼接（与设计稿一致，title 参与语义） */
function embedDoc(title: string, content: string): string {
  return `${title}\n${content}`
}

/** embed 调用统一 try/catch：任何异常都折算成空结果（检索/写入不因嵌入抛错而中断） */
async function safeEmbed(texts: string[]): Promise<Float32Array[]> {
  try {
    return await callEmbed(texts)
  } catch (e) {
    console.warn(`[memory] embed 抛错，按不可用处理：${String(e)}`)
    return []
  }
}

function clampTopK(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 64) : 8
}

function clampImportance(v: number): number {
  return Math.min(Math.max(v, 0), 1)
}
