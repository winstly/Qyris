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
import { embedTexts, embedReady, EMBED_DIM, DEFAULT_EMBED_MODEL } from './embed'
import { getConfig } from '../config'
import { emitToAllWindows } from '../emitter'

// ---------- 类型（渲染层契约，camelCase，service 层做行⇄对象映射） ----------

export type MemoryTier = 'short' | 'long'
export type MemoryStatus = 'active' | 'merged' | 'archived'

export interface MemoryItem {
  id: string
  projectKey: string
  sessionId: string | null
  tier: MemoryTier
  category: string
  title: string
  content: string
  sourceJson: string | null
  importance: number
  accessCount: number
  lastAccessedAt: number | null
  status: MemoryStatus
  supersededBy: string | null
  createdAt: number
  updatedAt: number
}

export interface MemoryHit extends MemoryItem {
  score: number
}

export interface MemorySearchResult {
  hits: MemoryHit[]
  /** true = 向量路不可用（sqlite-vec 缺席 / 模型未就绪或降级 / 本次推理失败），本次仅关键词路 */
  degraded: boolean
}

export interface MemoryPatch {
  title?: string
  content?: string
  category?: string
  importance?: number
}

export interface MemoryStats {
  total: number
  byTier: Record<string, number>
  byCategory: Record<string, number>
  embedReady: boolean
  vecAvailable: boolean
  dbBytes: number
  /** mem agent 蒸馏累计 token（近似值，清空记忆时归零） */
  distillTokens: { input: number; output: number }
}

/** mem agent 蒸馏 token 累计（面板展示，清空时归零，持久化到 meta 表） */
export const distillTokens = { input: 0, output: 0 }
const TOKENS_KEY = 'distill_tokens'

/** 从 meta 表恢复 token 计数（getDb 后调用） */
export async function loadDistillTokens(): Promise<void> {
  try {
    const db = await getDb()
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(TOKENS_KEY) as { value: string } | undefined
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
  void getDb().then((db) => {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(TOKENS_KEY, JSON.stringify(distillTokens))
  }).catch(() => {})
}

export function resetDistillTokens(): void {
  distillTokens.input = 0
  distillTokens.output = 0
  void getDb().then((db) => {
    db.prepare('DELETE FROM meta WHERE key = ?').run(TOKENS_KEY)
  }).catch(() => {})
}

/** P2 mem agent 写入口（渲染层六通道不含 create，暂不注册 IPC） */
export interface MemoryCreateInput {
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
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(FINGERPRINT_KEY) as { value: string } | undefined
  if (!row?.value) {
    if (embedReady()) db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(FINGERPRINT_KEY, expected)
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

// ---------- 检索加权参数（封顶可调） ----------

/** RRF 融合常数（论文默认 60） */
const RRF_K = 60
/** importance 线性加权系数 */
const IMPORTANCE_WEIGHT = 0.05
/** 新近加权封顶（updated_at 距今 0 天拿满） */
const RECENCY_BONUS_MAX = 0.1
/** 新近加权衰减速率（每整天） */
const RECENCY_DECAY_PER_DAY = 0.02
const DAY_MS = 86_400_000
/** 向量召回距离封顶（vec0 默认 L2；bge 输出已归一化，L2²=2-2cos，1.0 ≈ cos>0.5 的粗筛）。
 *  不设门槛时 KNN 在小语料下会把所有条目当"最近邻"灌进融合，污染检索结果。 */
const VEC_DISTANCE_CAP = 1.0

// ---------- 六通道 ----------

/** 列表：本工程 + 跨工程（'global'）条目，updated_at 降序；projectRoot=null 仅查 global */
export async function memoryList(projectRoot: string | null, includeArchived = false): Promise<{ items: MemoryItem[] }> {
  const db = await getDb()
  const statusSql = includeArchived ? '' : " AND status = 'active'"
  if (!projectRoot) {
    const rows = db.prepare(`SELECT * FROM mem_items WHERE project_key = 'global'${statusSql} ORDER BY updated_at DESC`).all() as MemRow[]
    return { items: rows.map(rowToItem) }
  }
  const key = projectKey(projectRoot)
  const rows = db
    .prepare(`SELECT * FROM mem_items WHERE (project_key = ? OR project_key = 'global')${statusSql} ORDER BY updated_at DESC`)
    .all(key) as MemRow[]
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
  const useVec = vecReadyFlag() && fingerprintOk && embedReady()
  const headroom = limit * 3 // 融合前多捞，补偿 scope/status 过滤与两路交叉

  // 关键词路：≥3 字走 FTS5 trigram 短语查询；1-2 字 trigram 无法成串，走 LIKE 兜底
  const kwRows = q.length >= 3
    ? searchFts(db, q, key, includeArchived, headroom)
    : searchLike(db, q, key, includeArchived, headroom)

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
        const near = db
          .prepare('SELECT item_id, distance FROM mem_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
          .all(vec, headroom) as { item_id: string; distance: number }[]
        const byId = fetchRowsByIds(db, near.map((n) => n.item_id))
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

  // RRF 融合：score = Σ 1/(60+rank)，叠加 importance 与新近度轻加权
  const now = Date.now()
  const scores = new Map<string, { row: MemRow; score: number }>()
  const add = (row: MemRow, rank: number): void => {
    const cur = scores.get(row.id)
    const base = (cur?.score ?? 0) + 1 / (RRF_K + rank)
    scores.set(row.id, { row, score: base })
  }
  kwRows.forEach((row, i) => add(row, i + 1))
  vecRows.forEach(({ row }, i) => add(row, i + 1))
  const hits: MemoryHit[] = [...scores.values()]
    .map(({ row, score }) => {
      const days = Math.max(0, (now - row.updated_at) / DAY_MS)
      const recency = Math.max(0, RECENCY_BONUS_MAX - days * RECENCY_DECAY_PER_DAY)
      return { ...rowToItem(row), score: score + row.importance * IMPORTANCE_WEIGHT + recency }
    })
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    .slice(0, limit)

  // 回写访问计数（检索热路径上的小同步写，优于引入异步队列）。
  // 并发说明：单语句原子，与 memoryClear 的 SELECT→事务删除交错时最多对已删 id UPDATE 0 行，无害。
  if (hits.length > 0) {
    const touch = db.prepare('UPDATE mem_items SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?')
    const ts = Date.now()
    for (const h of hits) touch.run(ts, h.id)
  }
  return { hits, degraded: !useVec || vecFailed }
}

/** 更新：title/content 变化时重嵌（read→embed→write 收口为「embed 在事务外、写在一个同步事务」；
 *  embed 失败整体 no-op 返回原条目）。显式字段的并发写为 last-write-wins（正确语义）；
 *  embed 期间条目被并发删除时 UPDATE 影响 0 行 → 向量一并放弃，不留孤儿。 */
export async function memoryUpdate(id: string, patch: MemoryPatch): Promise<MemoryItem> {
  const db = await getDb()
  const row = getRow(db, id)
  if (!row) throw new Error(`记忆不存在：${id}`)
  const nextTitle = typeof patch.title === 'string' ? patch.title : row.title
  const nextContent = typeof patch.content === 'string' ? patch.content : row.content
  const nextCategory = typeof patch.category === 'string' ? patch.category : row.category
  const nextImportance = typeof patch.importance === 'number' ? clampImportance(patch.importance) : row.importance
  const textChanged = nextTitle !== row.title || nextContent !== row.content
  if (!textChanged && nextCategory === row.category && nextImportance === row.importance) return rowToItem(row)

  // 嵌入在事务外（纯函数不读库）：失败（空结果/超维/抛错）即整体 no-op——条目与向量保持一致旧态
  let vector: Float32Array | null = null
  if (textChanged) {
    vector = await embedOne(db, nextTitle, nextContent)
    if (!vector && vecReadyFlag() && embedReady()) {
      console.warn(`[memory] 重嵌失败，更新整体回滚：${id}`)
      return rowToItem(row)
    }
  }
  // vec 不可用时只更新文本：向量表不可达（vecReady 把关），FTS 由触发器自同步

  const run = db.transaction(() => {
    const res = db.prepare(
      'UPDATE mem_items SET title = ?, content = ?, category = ?, importance = ?, updated_at = ? WHERE id = ?',
    ).run(nextTitle, nextContent, nextCategory, nextImportance, Date.now(), id)
    if (vector && Number(res.changes) > 0) {
      db.prepare('DELETE FROM mem_vec WHERE item_id = ?').run(id)
      db.prepare('INSERT INTO mem_vec (item_id, embedding) VALUES (?, ?)').run(id, vector)
    }
  })
  run()
  emitMemoryChanged([row.project_key])
  const updated = getRow(db, id)
  return rowToItem(updated ?? row)
}

/** 删除：mem_items（触发器清 FTS）+ mem_vec 同步清 */
export async function memoryDelete(id: string): Promise<void> {
  const db = await getDb()
  const row = getRow(db, id)
  const run = db.transaction(() => {
    db.prepare('DELETE FROM mem_items WHERE id = ?').run(id)
    if (vecReadyFlag()) db.prepare('DELETE FROM mem_vec WHERE item_id = ?').run(id)
  })
  run()
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
  const row = getRow(db, id)
  if (!row) throw new Error(`记忆不存在：${id}`)
  if (row.category === 'summary') throw new Error('会话滚动摘要不支持 scope 转换')
  const toUser = target === 'user'
  if (!toUser && !projectRoot) throw new Error('转为项目记忆需要指定目标工程')
  const nextKey = toUser ? 'global' : projectKey(String(projectRoot))
  const nextTier = toUser ? 'long' : row.tier
  const nextSession = toUser ? null : row.session_id
  db.prepare(
    'UPDATE mem_items SET project_key = ?, tier = ?, session_id = ?, updated_at = ? WHERE id = ?',
  ).run(nextKey, nextTier, nextSession, Date.now(), id)
  emitMemoryChanged([row.project_key, nextKey])
  const updated = getRow(db, id)
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
  const rows = db.prepare(`SELECT id FROM mem_items WHERE ${where}`).all(...params) as { id: string }[]
  // 蒸馏 token 归零：仅全库清空（scope='all'）时归零——局部清空不应重置全局累计
  if (scope === 'all') resetDistillTokens()
  if (rows.length === 0) return
  const run = db.transaction(() => {
    const delItem = db.prepare('DELETE FROM mem_items WHERE id = ?')
    const delVec = vecReadyFlag() ? db.prepare('DELETE FROM mem_vec WHERE item_id = ?') : null
    for (const { id } of rows) {
      delItem.run(id)
      delVec?.run(id)
    }
  })
  run()
  emitMemoryChanged(
    scope === 'all' ? 'all' : [scope === 'global' ? 'global' : projectKey(String(projectRoot))],
  )
}

/** 统计：面板概览用 */
export async function memoryStats(): Promise<MemoryStats> {
  const db = await getDb()
  const total = (db.prepare('SELECT COUNT(*) AS n FROM mem_items').get() as { n: number }).n
  const byTier: Record<string, number> = {}
  for (const r of db.prepare('SELECT tier AS k, COUNT(*) AS n FROM mem_items GROUP BY tier').all() as { k: string; n: number }[]) {
    byTier[r.k] = r.n
  }
  const byCategory: Record<string, number> = {}
  for (const r of db.prepare('SELECT category AS k, COUNT(*) AS n FROM mem_items GROUP BY category').all() as { k: string; n: number }[]) {
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
export function emitMemoryChanged(keys: string[] | 'all'): void {
  const payload = keys === 'all'
    ? { all: true, projectKeys: [] as string[] }
    : { all: false, projectKeys: [...new Set(keys)] }
  emitToAllWindows('memory-changed', payload)
}

/** 事务内插入 mem_items 行（FTS 由触发器自同步） */
function insertItemTx(db: SqliteDb, item: MemoryItem): void {
  db.prepare(
    `INSERT INTO mem_items
       (id, project_key, session_id, tier, category, title, content, source_json, importance,
        access_count, last_accessed_at, status, superseded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'active', NULL, ?, ?)`,
  ).run(
    item.id, item.projectKey, item.sessionId, item.tier, item.category, item.title, item.content,
    item.sourceJson, item.importance, item.createdAt, item.updatedAt,
  )
}

/** 嵌入结果回写（事务）：条目已不存在（embed 期间被并发删除/清空）则放弃，不留孤儿向量 */
function writeVecGuarded(db: SqliteDb, id: string, vec: Float32Array | null): void {
  if (!vec || !vecReadyFlag()) return
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM mem_items WHERE id = ?').get(id)) return
    db.prepare('DELETE FROM mem_vec WHERE item_id = ?').run(id)
    db.prepare('INSERT INTO mem_vec (item_id, embedding) VALUES (?, ?)').run(id, vec)
  })()
}

/** 嵌入一条（事务外调用）；不可用/失败回 null（条目照落，仅关键词可检索） */
async function embedOne(db: SqliteDb, title: string, content: string): Promise<Float32Array | null> {
  if (!vecReadyFlag() || !(await checkEmbedFingerprint(db)) || !embedReady()) return null
  const vecs = await safeEmbed([embedDoc(title, content)])
  return vecs.length === 1 && vecs[0]?.length === EMBED_DIM ? vecs[0] : null
}

/** 原子「新建或折叠」（mem agent create 唯一入口）：查重与写入收进同一同步事务——
 *  双工程并发蒸馏不再产生重复行（应用层不变量 + 唯一索引双保险）。
 *  折叠语义：content 覆写、importance 取 MAX（只升不降）；返回 folded 让调用方计数。 */
export async function createOrFoldAtomic(input: MemoryCreateInput): Promise<{ folded: boolean; id: string }> {
  const db = await getDb()
  const key = input.global ? 'global' : projectKey(String(input.projectRoot ?? ''))
  if (!input.global && !input.projectRoot) throw new Error('memory_create 需要 projectRoot 或 global=true')
  const now = Date.now()
  const importance = clampImportance(input.importance ?? 0.5)
  // tx1（同步，原子）：查重 → 折叠 / 插入
  const tx1 = db.transaction((): { folded: boolean; id: string } => {
    const dup = db
      .prepare(
        `SELECT id FROM mem_items
         WHERE project_key = ? AND category = ? AND title = ? AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(key, input.category, input.title) as { id: string } | undefined
    if (dup) {
      db.prepare(
        'UPDATE mem_items SET content = ?, importance = MAX(importance, ?), updated_at = ? WHERE id = ?',
      ).run(input.content, importance, now, dup.id)
      return { folded: true, id: dup.id }
    }
    const item: MemoryItem = {
      id: `mem_${randomUUID()}`,
      projectKey: key,
      sessionId: input.sessionId ?? null,
      tier: input.tier,
      category: input.category,
      title: input.title,
      content: input.content,
      sourceJson: input.sourceJson ?? null,
      importance,
      accessCount: 0,
      lastAccessedAt: null,
      status: 'active',
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
    }
    insertItemTx(db, item)
    return { folded: false, id: item.id }
  })
  const result = tx1()
  // 事务外：嵌入 + 向量回写（存在性检查防孤儿）
  writeVecGuarded(db, result.id, await embedOne(db, input.title, input.content))
  emitMemoryChanged([key])
  return result
}

/** 新建（无折叠语义的直建入口，agent create 走 createOrFoldAtomic）：
 *  同步事务插入 → 事务外 embed → 向量回写带存在性检查（embed 期间被删则不留孤儿向量）。
 *  向量为 best-effort（embedder 未就绪/失败时仅落文本条目，FTS 可检索，不丢数据）。 */
export async function memoryCreate(input: MemoryCreateInput): Promise<MemoryItem> {
  const db = await getDb()
  const key = input.global ? 'global' : projectKey(String(input.projectRoot ?? ''))
  if (!input.global && !input.projectRoot) throw new Error('memory_create 需要 projectRoot 或 global=true')
  const now = Date.now()
  const item: MemoryItem = {
    id: `mem_${randomUUID()}`,
    projectKey: key,
    sessionId: input.sessionId ?? null,
    tier: input.tier,
    category: input.category,
    title: input.title,
    content: input.content,
    sourceJson: input.sourceJson ?? null,
    importance: clampImportance(input.importance ?? 0.5),
    accessCount: 0,
    lastAccessedAt: null,
    status: 'active',
    supersededBy: null,
    createdAt: now,
    updatedAt: now,
  }
  db.transaction(() => insertItemTx(db, item))()
  writeVecGuarded(db, item.id, await embedOne(db, item.title, item.content))
  emitMemoryChanged([key])
  return item
}

// ---------- P2：mem agent 支撑面（session 摘要 / lesson / 归档 / 长期记忆标题） ----------

const SUMMARY_TITLE = '会话滚动摘要'

/** 该 session 的 active 滚动摘要正文（无则 null）——memory_session_context 通道 */
export async function sessionSummary(projectRoot: string, sessionId: string): Promise<string | null> {
  const db = await getDb()
  const row = db
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
    createdAt: now,
    updatedAt: now,
  }
  db.transaction(() => {
    const olds = db
      .prepare(
        `SELECT id FROM mem_items
         WHERE project_key = ? AND session_id = ? AND tier = 'short' AND category = 'summary' AND status = 'active'`,
      )
      .all(key, sessionId) as { id: string }[]
    for (const old of olds) {
      db.prepare("UPDATE mem_items SET status = 'archived', updated_at = ? WHERE id = ?").run(now, old.id)
    }
    insertItemTx(db, item)
  })()
  writeVecGuarded(db, item.id, await embedOne(db, item.title, content))
  emitMemoryChanged([key])
}

/** 归档（文本不变，不重嵌）；目标不存在回 false（mem agent 的 archive op 据此计数跳过） */
export async function memoryArchive(id: string): Promise<boolean> {
  const db = await getDb()
  const result = db.prepare("UPDATE mem_items SET status = 'archived', updated_at = ? WHERE id = ?").run(Date.now(), id)
  return Number(result.changes) > 0
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
  const tx1 = db.transaction((): string => {
    const dup = db
      .prepare(
        `SELECT id FROM mem_items
         WHERE project_key = ? AND category = 'lesson' AND status = 'active' AND title = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(key, title) as { id: string } | undefined
    if (dup) {
      db.prepare(
        'UPDATE mem_items SET content = ?, importance = MIN(1.0, importance + 0.1), updated_at = ? WHERE id = ?',
      ).run(content, now, dup.id)
      return dup.id
    }
    const item: MemoryItem = {
      id: `mem_${randomUUID()}`,
      projectKey: key,
      sessionId,
      tier: 'short',
      category: 'lesson',
      title,
      content,
      sourceJson: null,
      importance: clampImportance(0.5),
      accessCount: 0,
      lastAccessedAt: null,
      status: 'active',
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
    }
    insertItemTx(db, item)
    return item.id
  })
  const id = tx1()
  writeVecGuarded(db, id, await embedOne(db, title, content))
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
  return db
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

export interface DecayStats {
  /** importance 被衰减的 long 条目数 */
  decayed: number
  /** 被归档的 short 条目数 */
  archived: number
}

/** 衰减作业周期 */
export const DECAY_INTERVAL_MS = 6 * 60 * 60_000
/** boot 后首跑延迟 */
const DECAY_BOOT_DELAY_MS = 30_000
/** long 层衰减基线：距上次访问超 14d 视为陈旧 */
const DECAY_LONG_STALE_MS = 14 * DAY_MS
/** 每轮衰减步长与下限 */
const DECAY_IMPORTANCE_STEP = 0.05
const DECAY_IMPORTANCE_FLOOR = 0.1
/** short 层归档基线：创建超 30d 且几乎未被检索（access_count ≤ 1） */
const ARCHIVE_SHORT_STALE_MS = 30 * DAY_MS
const ARCHIVE_SHORT_MAX_ACCESS = 1

/** 衰减/归档一轮（幂等，可手动调用；boot 由 startDecayJob 每 6h 调度）：
 *  - long 层 active：陈旧 → importance −0.05（下限 0.1），永不自动归档；
 *    从未被访问的条目以 created_at 为陈旧基线（否则永久免疫衰减）
 *  - short 层 active：创建超 30d 且 access_count ≤1 → status='archived'（superseded_by 留空）
 *  - mem_vec 不动：归档后默认检索查不到即可，向量保留给 includeArchived 场景
 *  - 只动 importance/status 列：FTS 触发器 WHEN 子句判定文本未变，不触发无谓的倒排重建；
 *    updated_at 刻意不动（衰减不该刷新检索新近度权重） */
export async function runDecayJob(): Promise<DecayStats> {
  const db = await getDb()
  const now = Date.now()
  const decayed = db
    .prepare(
      `UPDATE mem_items SET importance = MAX(importance - ?, ?)
       WHERE tier = 'long' AND status = 'active'
         AND COALESCE(last_accessed_at, created_at) < ?`,
    )
    .run(DECAY_IMPORTANCE_STEP, DECAY_IMPORTANCE_FLOOR, now - DECAY_LONG_STALE_MS)
  const archived = db
    .prepare(
      `UPDATE mem_items SET status = 'archived'
       WHERE tier = 'short' AND status = 'active' AND created_at < ? AND access_count <= ?`,
    )
    .run(now - ARCHIVE_SHORT_STALE_MS, ARCHIVE_SHORT_MAX_ACCESS)
  const stats: DecayStats = { decayed: Number(decayed.changes), archived: Number(archived.changes) }
  console.info(`[memory] 衰减作业：decay ${stats.decayed} / archive ${stats.archived}`)
  return stats
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
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(FINGERPRINT_KEY) as { value: string } | undefined
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
  const items = db
    .prepare("SELECT id, title, content FROM mem_items WHERE status = 'active' ORDER BY rowid")
    .all() as { id: string; title: string; content: string }[]
  if (items.length === 0) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(FINGERPRINT_KEY, expected)
    console.info('[memory] 无 active 条目，指纹直接更新')
    return
  }
  // 绕过指纹闸门（闸门正是被这次作业解除的）：callEmbed 直接走真实/注入的 embedder
  const writeBatch = async (batch: { id: string; title: string; content: string }[], label: string): Promise<void> => {
    const vecs = await safeEmbed(batch.map((b) => embedDoc(b.title, b.content)))
    if (vecs.length !== batch.length) throw new Error(`${label}嵌入返回 ${vecs.length}/${batch.length}`)
    const run = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const vec = vecs[j]
        if (vec?.length !== EMBED_DIM) throw new Error(`条目 ${batch[j].id} 嵌入维度异常`)
        db.prepare('DELETE FROM mem_vec WHERE item_id = ?').run(batch[j].id)
        db.prepare('INSERT INTO mem_vec (item_id, embedding) VALUES (?, ?)').run(batch[j].id, vec)
      }
    })
    run()
    await new Promise<void>((resolve) => setImmediate(resolve)) // 逐批让路事件循环
  }
  try {
    for (let i = 0; i < items.length; i += REEMBED_BATCH) {
      await writeBatch(items.slice(i, i + REEMBED_BATCH), `第 ${i} 批`)
    }
    // 补漏：作业期间新建的条目被指纹闸门挡在向量路外、又不在上面的快照里——
    // 按「active 但无向量行」补嵌一轮，否则它们要等下一次指纹变更才进得了向量路
    const missing = db
      .prepare("SELECT id, title, content FROM mem_items WHERE status = 'active' AND id NOT IN (SELECT item_id FROM mem_vec)")
      .all() as { id: string; title: string; content: string }[]
    for (let i = 0; i < missing.length; i += REEMBED_BATCH) {
      await writeBatch(missing.slice(i, i + REEMBED_BATCH), `补漏第 ${i} 批`)
    }
    if (missing.length > 0) console.info(`[memory] 重嵌补漏：${missing.length} 条`)
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(FINGERPRINT_KEY, expected)
    console.info(`[memory] 全量重嵌完成：${items.length} 条（补漏 ${missing.length}），指纹已更新为 ${expected}`)
  } catch (e) {
    console.warn(`[memory] 全量重嵌失败，保留旧指纹（下次 boot 重试）：${String(e)}`)
  }
}

// ---------- P3：导出/导入（全量备份语义：含 archived/merged） ----------

export interface MemoryExportPayload {
  version: 1
  exportedAt: number
  items: MemoryItem[]
}

export interface MemoryExportResult {
  ok: boolean
  path?: string
  count?: number
  error?: string
}

export interface MemoryImportResult {
  ok: boolean
  imported?: number
  skipped?: number
  error?: string
}

/** 对话框接缝：smoke 注入假实现离线测往返；缺省包一层 electron dialog（绑定调用方窗口） */
export interface MemoryDialogAdapter {
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

/** 注入假对话框（smoke 用）；置 null 恢复 electron dialog */
export function setDialogAdapter(a: MemoryDialogAdapter | null): void {
  dialogAdapter = a
}

function activeDialog(): MemoryDialogAdapter {
  return dialogAdapter ?? electronDialog
}

/** 导出数据组装（内存纯函数，smoke 直测；scope 语义与 memoryClear 一致） */
export async function memoryExportData(scope: 'project' | 'global' | 'all', projectRoot?: string): Promise<MemoryExportPayload> {
  const db = await getDb()
  const { where, params } = scopeWhere(scope, projectRoot)
  const rows = db
    .prepare(`SELECT * FROM mem_items WHERE ${where} ORDER BY created_at ASC`)
    .all(...params) as MemRow[]
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
  const exists = db.prepare('SELECT 1 FROM mem_items WHERE id = ?')
  const dup = db.prepare(
    "SELECT 1 FROM mem_items WHERE project_key = ? AND category = ? AND title = ? AND status = 'active'",
  )
  const insert = db.prepare(
    `INSERT INTO mem_items
       (id, project_key, session_id, tier, category, title, content, source_json, importance,
        access_count, last_accessed_at, status, superseded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    // 单条同步事务：存在性/重复检查与 INSERT 原子（并发蒸馏在两条语句之间插不进来）
    const tryOne = db.transaction((): boolean => {
      if (exists.get(it.id)) return false
      if (dup.get(key, it.category, it.title)) return false
      insert.run(it.id, key, sid, it.tier, it.category, it.title, it.content, sj, imp, ac, lat, st, sb, now, now)
      return true
    })
    if (!tryOne()) {
      skipped++
      continue
    }
    touchedKeys.add(key)
    fresh.push({ id: it.id, projectKey: key, sessionId: sid, tier: it.tier, category: it.category, title: it.title, content: it.content, sourceJson: sj, importance: imp, accessCount: 0, lastAccessedAt: null, status: st, supersededBy: sb, createdAt: now, updatedAt: now })
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
      const run = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          if (vecs[j]?.length !== EMBED_DIM) continue // 单条异常只跳过该条向量
          // embed 途中被并发删除/清空的条目不落向量（防孤儿）
          if (!db.prepare('SELECT 1 FROM mem_items WHERE id = ?').get(batch[j].id)) continue
          db.prepare('INSERT INTO mem_vec (item_id, embedding) VALUES (?, ?)').run(batch[j].id, vecs[j])
        }
      })
      run()
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
  created_at: number
  updated_at: number
}

function rowToItem(row: MemRow): MemoryItem {
  return {
    id: row.id,
    projectKey: row.project_key,
    sessionId: row.session_id,
    tier: row.tier === 'short' ? 'short' : 'long',
    category: row.category,
    title: row.title,
    content: row.content,
    sourceJson: row.source_json,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    status: row.status === 'merged' ? 'merged' : row.status === 'archived' ? 'archived' : 'active',
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getRow(db: SqliteDb, id: string): MemRow | undefined {
  return db.prepare('SELECT * FROM mem_items WHERE id = ?').get(id) as MemRow | undefined
}

function fetchRowsByIds(db: SqliteDb, ids: string[]): Map<string, MemRow> {
  const map = new Map<string, MemRow>()
  if (ids.length === 0) return map
  const stmt = db.prepare(`SELECT * FROM mem_items WHERE id IN (${ids.map(() => '?').join(',')})`)
  for (const row of stmt.all(...ids) as MemRow[]) map.set(row.id, row)
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
function searchFts(db: SqliteDb, q: string, key: string | null, includeArchived: boolean, limit: number): MemRow[] {
  const phrase = `"${q.replace(/"/g, '""')}"`
  const statusSql = includeArchived ? '' : " AND mi.status = 'active'"
  const { sql, param } = scopeCond(key)
  const stmt = `SELECT mi.* FROM mem_fts JOIN mem_items mi ON mi.rowid = mem_fts.rowid WHERE mem_fts MATCH ? AND ${sql}${statusSql} ORDER BY bm25(mem_fts) LIMIT ?`
  return param !== undefined
    ? db.prepare(stmt).all(phrase, param, limit) as MemRow[]
    : db.prepare(stmt).all(phrase, limit) as MemRow[]
}

/** 1-2 字兜底：LIKE 全表（本工程+global 范围内），%/_/\ 转义防通配符注入 */
function searchLike(db: SqliteDb, q: string, key: string | null, includeArchived: boolean, limit: number): MemRow[] {
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const statusSql = includeArchived ? '' : " AND mi.status = 'active'"
  const { sql, param } = scopeCond(key)
  const stmt = `SELECT * FROM mem_items mi WHERE (mi.title LIKE ? ESCAPE '\\' OR mi.content LIKE ? ESCAPE '\\') AND ${sql}${statusSql} ORDER BY mi.updated_at DESC LIMIT ?`
  return param !== undefined
    ? db.prepare(stmt).all(pattern, pattern, param, limit) as MemRow[]
    : db.prepare(stmt).all(pattern, pattern, limit) as MemRow[]
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
