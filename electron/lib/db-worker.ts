/**
 * SQLite Worker 线程：拥有 better-sqlite3 连接，主进程通过 MessagePort 异步通信。
 * 所有同步 SQLite 操作在此线程执行，不阻塞主进程事件循环。
 *
 * 协议：主进程发 { id, op, ... }，worker 回 { id, result } 或 { id, error }。
 */
import { parentPort } from 'node:worker_threads'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

type SqliteDb = InstanceType<typeof Database>

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

const SCHEMA_VEC = `
CREATE VIRTUAL TABLE IF NOT EXISTS mem_vec USING vec0(item_id TEXT PRIMARY KEY, embedding FLOAT[512]);
`

let db: SqliteDb | null = null
let vecReady = false

function loadVec(target: SqliteDb): void {
  try {
    const vec = require('sqlite-vec') as { load(t: SqliteDb): void }
    vec.load(target)
    vecReady = true
  } catch {
    vecReady = false
  }
}

function ensureMemActiveTitleIndex(target: SqliteDb): void {
  const INDEX_NAME = 'idx_mem_active_title'
  try {
    const existed = target
      .prepare('SELECT 1 FROM sqlite_master WHERE type = \'index\' AND name = ?')
      .get(INDEX_NAME)
    if (existed) return
    target.transaction(() => {
      const groups = target
        .prepare(
          `SELECT project_key, category, title, COUNT(*) AS n
           FROM mem_items WHERE status = 'active' AND category != 'summary'
           GROUP BY project_key, category, title HAVING n > 1`,
        )
        .all() as { project_key: string; category: string; title: string; n: number }[]
      if (groups.length > 0) {
        const archive = target.prepare(
          "UPDATE mem_items SET status = 'archived', superseded_by = ? WHERE id = ?",
        )
        for (const g of groups) {
          const keep = target
            .prepare(
              `SELECT id FROM mem_items
               WHERE project_key = ? AND category = ? AND title = ? AND status = 'active'
               ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
            )
            .get(g.project_key, g.category, g.title) as { id: string }
          const olds = target
            .prepare(
              `SELECT id FROM mem_items
               WHERE project_key = ? AND category = ? AND title = ? AND status = 'active' AND id != ?`,
            )
            .all(g.project_key, g.category, g.title, keep.id) as { id: string }[]
          for (const o of olds) archive.run(keep.id, o.id)
        }
      }
      target.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
         ON mem_items(project_key, category, title) WHERE status = 'active' AND category != 'summary'`,
      )
    })()
  } catch {
    /* 不阻塞启动 */
  }
}

function initDb(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'qyris.db')
  const instance = new Database(dbPath)
  const isNetwork = dir.startsWith('\\\\')
  if (isNetwork) {
    instance.pragma('journal_mode = DELETE')
  } else {
    instance.pragma('journal_mode = WAL')
  }
  instance.pragma('foreign_keys = ON')
  loadVec(instance)
  instance.exec(SCHEMA)
  if (vecReady) instance.exec(SCHEMA_VEC)
  ensureMemActiveTitleIndex(instance)
  db = instance
}

interface WorkerRequest {
  id: number
  op: string
  [key: string]: unknown
}

parentPort?.on('message', (msg: WorkerRequest) => {
  const { id, op } = msg
  try {
    switch (op) {
      case 'init':
        initDb(msg.dir as string)
        parentPort?.postMessage({ id, result: { vecReady } })
        break
      case 'get': {
        if (!db) throw new Error('DB not initialized')
        const stmt = db.prepare(msg.sql as string)
        const row = msg.params ? stmt.get(...(msg.params as unknown[])) : stmt.get()
        parentPort?.postMessage({ id, result: row ?? null })
        break
      }
      case 'all': {
        if (!db) throw new Error('DB not initialized')
        const stmt = db.prepare(msg.sql as string)
        const rows = msg.params ? stmt.all(...(msg.params as unknown[])) : stmt.all()
        parentPort?.postMessage({ id, result: rows })
        break
      }
      case 'run': {
        if (!db) throw new Error('DB not initialized')
        const stmt = db.prepare(msg.sql as string)
        const info = msg.params ? stmt.run(...(msg.params as unknown[])) : stmt.run()
        parentPort?.postMessage({ id, result: { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) } })
        break
      }
      case 'exec': {
        if (!db) throw new Error('DB not initialized')
        db.exec(msg.sql as string)
        parentPort?.postMessage({ id, result: null })
        break
      }
      case 'transaction': {
        if (!db) throw new Error('DB not initialized')
        const stmts = msg.statements as { sql: string; params?: unknown[] }[]
        const results: unknown[] = []
        db.transaction(() => {
          for (const s of stmts) {
            const stmt = db!.prepare(s.sql)
            if (s.sql.trimStart().toUpperCase().startsWith('SELECT') || s.sql.trimStart().toUpperCase().startsWith('PRAGMA')) {
              results.push(s.params ? stmt.all(...s.params) : stmt.all())
            } else {
              const info = s.params ? stmt.run(...s.params) : stmt.run()
              results.push({ changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) })
            }
          }
        })()
        parentPort?.postMessage({ id, result: results })
        break
      }
      case 'pragma': {
        if (!db) throw new Error('DB not initialized')
        const result = db.pragma(msg.sql as string)
        parentPort?.postMessage({ id, result })
        break
      }
      case 'close':
        if (db) { try { db.close() } catch {} db = null }
        parentPort?.postMessage({ id, result: null })
        break
      case 'vecReady':
        parentPort?.postMessage({ id, result: vecReady })
        break
      default:
        parentPort?.postMessage({ id, error: `Unknown op: ${op}` })
    }
  } catch (e) {
    parentPort?.postMessage({ id, error: String(e) })
  }
})
