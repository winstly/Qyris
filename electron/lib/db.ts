/**
 * SQLite 基座：库文件落 <dataDir>/qyris.db（WAL + foreign_keys），进程级单例连接，首次打开即建表。
 * dataDir 解析：config.dataDir（P1 出设置项与迁移）→ 缺省 ~/.qyris/data；
 * 原生依赖 better-sqlite3 / sqlite-vec 由 electron-vite externalizeDepsPlugin 外置（dependencies 不进 bundle）。
 * sqlite-vec 加载失败不阻断启动：vecReady()=false，检索层自动降级 FTS-only。
 * 迁移期闸门：migrate.ts 搬库窗口内置 migrating 标志，getDb() 一律拒绝，防止写请求打到半移动状态。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { getConfig } from './config'
import { storageDir } from './storage'

/** 连接类型：@types/better-sqlite3 的类型面嵌在命名空间里（Database.Database），别名化后供各模块复用 */
export type SqliteDb = InstanceType<typeof Database>

/** 库结构（全部 IF NOT EXISTS，重复打开幂等）。
 *  mem_fts 用外部内容表（content='mem_items'）+ 三触发器同步：FTS5 标准做法，
 *  删除/更新由触发器回收倒排索引，杜绝 contentless 手工维护残留；WHEN 子句让
 *  access_count 等无关列更新不触发无谓的索引重建。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  reasoning TEXT,
  meta_json TEXT,
  tool_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(project_key, session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_msg_page ON messages(project_key, session_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_msg_project ON messages(project_key);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS mem_items (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  session_id TEXT,
  tier TEXT NOT NULL CHECK(tier IN ('short','long')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_json TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','merged','archived')),
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_scope ON mem_items(project_key, tier, status);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  title, content, content='mem_items', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS mem_fts_ai AFTER INSERT ON mem_items BEGIN
  INSERT INTO mem_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS mem_fts_ad AFTER DELETE ON mem_items BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS mem_fts_au AFTER UPDATE ON mem_items
  WHEN old.title IS NOT new.title OR old.content IS NOT new.content
BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO mem_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
`

/** 向量虚表依赖 sqlite-vec 扩展，仅在扩展加载成功后执行（表缺席时检索层走 FTS-only） */
const SCHEMA_VEC = `
CREATE VIRTUAL TABLE IF NOT EXISTS mem_vec USING vec0(item_id TEXT PRIMARY KEY, embedding FLOAT[512]);
`

let instance: SqliteDb | null = null
/** 测试覆盖根（initDbAt 设置后 dataDir 直接返回，绕过 config），主进程正常运行恒为 null */
let overrideDir: string | null = null
/** sqlite-vec 扩展是否加载成功（不成功则 mem_vec 表不存在，检索降级 FTS-only） */
let vecReady = false
/** 数据目录迁移窗口（migrate.ts 控制）：期间 getDb() 一律拒绝，防止写穿半移动状态 */
let migrating = false

/** 数据根目录：解析 config.dataDir（垃圾值回缺省），mkdir recursive 后返回绝对路径 */
export async function dataDir(): Promise<string> {
  if (overrideDir) return overrideDir
  const cfg = await getConfig()
  const configured = typeof cfg.dataDir === 'string' ? cfg.dataDir.trim() : ''
  const dir = configured || path.join(storageDir(), 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 进程级单例连接（懒打开；WAL + foreign_keys，首次连接执行 schema 初始化） */
export async function getDb(): Promise<SqliteDb> {
  if (migrating) throw new Error('数据目录迁移进行中，请稍后重试')
  if (!instance) instance = openAt(await dataDir())
  return instance
}

/** 测试钩子：显式指定目录初始化（关闭既有连接并接管单例），smoke 用临时目录 */
export function initDbAt(dir: string): SqliteDb {
  closeDb()
  overrideDir = dir
  instance = openAt(dir)
  return instance
}

/** 迁移成功后由 migrate.ts 调用：override 模式（smoke）下同步测试根到新目录，生产模式 no-op */
export function rebaseOverrideDir(dir: string): void {
  if (overrideDir) overrideDir = dir
}

/** 迁移窗口开关（仅 migrate.ts 使用） */
export function setMigrating(v: boolean): void {
  migrating = v
}

/** sqlite-vec 扩展可用性（service 层据此决定是否走向量路） */
export function vecReadyFlag(): boolean {
  return vecReady
}

/** 退出清理（幂等）：checkpoint 落盘 WAL 并关闭连接 */
export function closeDb(): void {
  if (!instance) return
  try {
    instance.close()
  } catch {
    /* 已关闭/损坏时忽略，退出路径不抛 */
  }
  instance = null
}

/** 工程键：sha1(projectRoot) 前 16 hex（与旧 sessions/snapshot 键规则同源） */
export function projectKey(projectRoot: string): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 16)
}

/** 网络盘检测：UNC 路径（\\server\share）→ WAL 降级 DELETE（SQLite 官方警告网络共享损坏风险） */
const isNetworkPath = (dir: string): boolean => dir.startsWith('\\\\')

function openAt(dir: string): SqliteDb {
  mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'qyris.db')
  const db = new Database(dbPath)
  if (isNetworkPath(dir)) {
    console.warn(`[db] 数据目录位于网络路径（${dir}），WAL 模式有损坏风险，已降级为 journal_mode=DELETE。建议使用本地磁盘。`)
    db.pragma('journal_mode = DELETE')
  } else {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('foreign_keys = ON')
  loadVec(db)
  db.exec(SCHEMA)
  if (vecReady) db.exec(SCHEMA_VEC)
  ensureMemActiveTitleIndex(db)
  return db
}

/** 用户记忆去重唯一索引（部分索引，仅 active 行参与）：同 (project_key, category, title)
 *  只允许一条 active——双工程并发蒸馏折叠语义的库级兜底（应用层不变量在 memory/service.ts
 *  createOrFoldAtomic）。summary 类排除在外：滚动摘要按 (project_key, session_id) 每会话一条，
 *  同工程跨会话同题合法，其唯一性由 saveSessionSummary 的事务（先归档后插入）保证。
 *  启动幂等：索引已在即快返回；首次创建前先把存量重复归档
 *  （每组留 updated_at 最新，其余 status='archived' + superseded_by 指向留者，可逆不删）。
 *  status-only UPDATE 不带 title/content 变化，不会触发 mem_fts 重建触发器（WHEN 子句）。
 *  任何失败只告警不抛：启动永不因索引阻塞（写路径正确性不依赖索引，仅降级为无兜底）。 */
function ensureMemActiveTitleIndex(db: SqliteDb): void {
  const INDEX_NAME = 'idx_mem_active_title'
  try {
    const existed = db
      .prepare('SELECT 1 FROM sqlite_master WHERE type = \'index\' AND name = ?')
      .get(INDEX_NAME)
    if (existed) return
    db.transaction(() => {
      const groups = db
        .prepare(
          `SELECT project_key, category, title, COUNT(*) AS n
           FROM mem_items WHERE status = 'active' AND category != 'summary'
           GROUP BY project_key, category, title HAVING n > 1`,
        )
        .all() as { project_key: string; category: string; title: string; n: number }[]
      if (groups.length > 0) {
        const archive = db.prepare(
          "UPDATE mem_items SET status = 'archived', superseded_by = ? WHERE id = ?",
        )
        for (const g of groups) {
          // 留新弃旧：updated_at 最新者胜（并列看 rowid），其余归档并指向留者
          const keep = db
            .prepare(
              `SELECT id FROM mem_items
               WHERE project_key = ? AND category = ? AND title = ? AND status = 'active'
               ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
            )
            .get(g.project_key, g.category, g.title) as { id: string }
          const olds = db
            .prepare(
              `SELECT id FROM mem_items
               WHERE project_key = ? AND category = ? AND title = ? AND status = 'active' AND id != ?`,
            )
            .all(g.project_key, g.category, g.title, keep.id) as { id: string }[]
          for (const o of olds) archive.run(keep.id, o.id)
        }
        console.warn(`[db] 记忆去重：归档 ${groups.reduce((s, g) => s + g.n - 1, 0)} 条重复 active 条目（建唯一索引前置）`)
      }
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
         ON mem_items(project_key, category, title) WHERE status = 'active' AND category != 'summary'`,
      )
    })()
  } catch (e) {
    console.warn(`[db] 唯一索引 ${INDEX_NAME} 建立失败（不影响启动，仅无重复兜底）：${String(e)}`)
  }
}

/** sqlite-vec 为 externalized 原生依赖，运行时 require（import 会被打包器处理进 bundle 而报错）。
 *  失败（dll 缺失/版本不匹配）只告警不抛：vecReady=false，检索自动降级 FTS-only。 */
function loadVec(db: SqliteDb): void {
  try {
    const vec = require('sqlite-vec') as { load(target: SqliteDb): void }
    vec.load(db)
    vecReady = true
  } catch (e) {
    vecReady = false
    console.warn(`[db] sqlite-vec 加载失败，向量检索降级 FTS-only：${String(e)}`)
  }
}
