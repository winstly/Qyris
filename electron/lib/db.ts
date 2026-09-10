/**
 * SQLite 基座（Worker 线程版）：库文件落 <dataDir>/qyris.db（WAL + foreign_keys），
 * 进程级单例 Worker 线程持有 better-sqlite3 连接，主进程通过 MessagePort 异步通信。
 *
 * 旧版同步 API（db.prepare().get()）在主进程阻塞事件循环，新版全部 async：
 *   const db = await getDb()
 *   const row = await db.get('SELECT ...', [param])
 *   const rows = await db.all('SELECT ...')
 *   await db.run('INSERT ...', [param])
 *   await db.exec('CREATE TABLE ...')
 *   await db.transaction([{ sql: '...', params: [...] }])
 *
 * 迁移期闸门：migrate.ts 搬库窗口内置 migrating 标志，getDb() 一律拒绝。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { getConfig } from './config'
import { storageDir } from './storage'

/** Worker 线程持有的 better-sqlite3 实例类型（仅 Worker 内部使用，主进程不直接碰） */
type RawSqliteDb = import('better-sqlite3').Database

/** 预编译语句的 async 代理（内部通过 Worker 执行） */
export interface PreparedStatement {
  get(...params: unknown[]): Promise<Record<string, unknown> | null | undefined>
  all(...params: unknown[]): Promise<Record<string, unknown>[]>
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>
}

/** 主进程侧的 async 数据库接口（所有操作通过 Worker 异步执行） */
export interface SqliteDb {
  /** 预编译语句：返回代理对象，其 .get/.all/.run 均为 async */
  prepare(sql: string): PreparedStatement
  /** 查询单行：无结果返回 null */
  get(sql: string, ...params: unknown[]): Promise<Record<string, unknown> | null | undefined>
  /** 查询多行 */
  all(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>
  /** 执行写操作：返回 { changes, lastInsertRowid } */
  run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>
  /** 执行原始 SQL（DDL 等） */
  exec(sql: string): Promise<void>
  /** 事务：在 Worker 内原子执行多条语句 */
  transaction(stmts: { sql: string; params?: unknown[] }[]): Promise<unknown[]>
  /** PRAGMA 查询 */
  pragma(sql: string): Promise<unknown[]>
  /** 关闭连接 */
  close(): Promise<void>
}

interface WorkerResponse {
  id: number
  result?: unknown
  error?: string
}

let instance: SqliteDb | null = null
let worker: Worker | null = null
let overrideDir: string | null = null
let migrating = false
let vecReady = false

/** 数据根目录 */
export async function dataDir(): Promise<string> {
  if (overrideDir) return overrideDir
  const cfg = await getConfig()
  const configured = typeof cfg.dataDir === 'string' ? cfg.dataDir.trim() : ''
  const dir = configured || path.join(storageDir(), 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Worker 通信层 */
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function sendToWorker(msg: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, ...msg })
  })
}

function createWorker(): Worker {
  // Worker 代码内联：避免 Electron 打包路径问题
  const code = `
const { parentPort } = require('node:worker_threads');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = \`
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL, session_id TEXT NOT NULL,
  seq INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '', reasoning TEXT, meta_json TEXT, tool_json TEXT,
  created_at INTEGER NOT NULL, UNIQUE(project_key, session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_msg_page ON messages(project_key, session_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_msg_project ON messages(project_key);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS mem_items (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL, session_id TEXT,
  tier TEXT NOT NULL CHECK(tier IN ('short','long')), category TEXT NOT NULL,
  title TEXT NOT NULL, content TEXT NOT NULL, source_json TEXT,
  importance REAL NOT NULL DEFAULT 0.5, access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','merged','archived')),
  superseded_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_scope ON mem_items(project_key, tier, status);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(title, content, content='mem_items', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS mem_fts_ai AFTER INSERT ON mem_items BEGIN INSERT INTO mem_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
CREATE TRIGGER IF NOT EXISTS mem_fts_ad AFTER DELETE ON mem_items BEGIN INSERT INTO mem_fts(mem_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); END;
CREATE TRIGGER IF NOT EXISTS mem_fts_au AFTER UPDATE ON mem_items WHEN old.title IS NOT new.title OR old.content IS NOT new.content BEGIN INSERT INTO mem_fts(mem_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); INSERT INTO mem_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
\`;
const SCHEMA_VEC = 'CREATE VIRTUAL TABLE IF NOT EXISTS mem_vec USING vec0(item_id TEXT PRIMARY KEY, embedding FLOAT[512]);';
let db = null, vecReady = false;
function loadVec(t) { try { const v = require('sqlite-vec'); v.load(t); vecReady = true; } catch { vecReady = false; } }
function ensureIdx(t) { try { if (t.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_mem_active_title'").get()) return; t.transaction(() => { const gs = t.prepare("SELECT project_key, category, title, COUNT(*) AS n FROM mem_items WHERE status = 'active' AND category != 'summary' GROUP BY project_key, category, title HAVING n > 1").all(); if (gs.length > 0) { const a = t.prepare("UPDATE mem_items SET status = 'archived', superseded_by = ? WHERE id = ?"); for (const g of gs) { const k = t.prepare("SELECT id FROM mem_items WHERE project_key = ? AND category = ? AND title = ? AND status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(g.project_key, g.category, g.title); const os = t.prepare("SELECT id FROM mem_items WHERE project_key = ? AND category = ? AND title = ? AND status = 'active' AND id != ?").all(g.project_key, g.category, g.title, k.id); for (const o of os) a.run(k.id, o.id); } } t.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_active_title ON mem_items(project_key, category, title) WHERE status = 'active' AND category != 'summary'"); })(); } catch {} }
parentPort.on('message', (msg) => {
  const { id, op } = msg;
  try {
    switch (op) {
      case 'init': { const d = msg.dir; mkdirSync(d, { recursive: true }); const inst = new Database(path.join(d, 'qyris.db')); inst.pragma(d.startsWith('\\\\\\\\') ? 'journal_mode = DELETE' : 'journal_mode = WAL'); inst.pragma('foreign_keys = ON'); loadVec(inst); inst.exec(SCHEMA); if (vecReady) inst.exec(SCHEMA_VEC); ensureIdx(inst); db = inst; parentPort.postMessage({ id, result: { vecReady } }); break; }
      case 'get': { const s = db.prepare(msg.sql); const r = msg.params ? s.get(...msg.params) : s.get(); parentPort.postMessage({ id, result: r ?? null }); break; }
      case 'all': { const s = db.prepare(msg.sql); const r = msg.params ? s.all(...msg.params) : s.all(); parentPort.postMessage({ id, result: r }); break; }
      case 'run': { const s = db.prepare(msg.sql); const i = msg.params ? s.run(...msg.params) : s.run(); parentPort.postMessage({ id, result: { changes: i.changes, lastInsertRowid: Number(i.lastInsertRowid) } }); break; }
      case 'exec': { db.exec(msg.sql); parentPort.postMessage({ id, result: null }); break; }
      case 'transaction': { const ss = msg.statements; const rs = []; db.transaction(() => { for (const s of ss) { const st = db.prepare(s.sql); const up = s.sql.trimStart().toUpperCase(); if (up.startsWith('SELECT') || up.startsWith('PRAGMA')) { rs.push(s.params ? st.all(...s.params) : st.all()); } else { const i = s.params ? st.run(...s.params) : st.run(); rs.push({ changes: i.changes, lastInsertRowid: Number(i.lastInsertRowid) }); } } })(); parentPort.postMessage({ id, result: rs }); break; }
      case 'pragma': { parentPort.postMessage({ id, result: db.pragma(msg.sql) }); break; }
      case 'close': { if (db) { try { db.close(); } catch {} db = null; } parentPort.postMessage({ id, result: null }); break; }
      case 'vecReady': { parentPort.postMessage({ id, result: vecReady }); break; }
      default: parentPort.postMessage({ id, error: 'Unknown op: ' + op });
    }
  } catch (e) { parentPort.postMessage({ id, error: String(e) }); }
});
`
  const w = new Worker(code, { eval: true })
  w.on('message', (msg: WorkerResponse) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  })
  w.on('error', (e) => {
    console.error('[db-worker] Worker error:', e)
    // 拒绝所有 pending 请求
    for (const [, p] of pending) p.reject(e)
    pending.clear()
    worker = null
    instance = null
  })
  return w
}

/** 创建 async 代理对象 */
function createDbProxy(_w: Worker): SqliteDb {
  return {
    prepare: (sql) => ({
      get: (...params) => sendToWorker({ op: 'get', sql, params }) as Promise<Record<string, unknown> | null | undefined>,
      all: (...params) => sendToWorker({ op: 'all', sql, params }) as Promise<Record<string, unknown>[]>,
      run: (...params) => sendToWorker({ op: 'run', sql, params }) as Promise<{ changes: number; lastInsertRowid: number }>,
    }),
    get: (sql, ...params) => sendToWorker({ op: 'get', sql, params }) as Promise<Record<string, unknown> | null | undefined>,
    all: (sql, ...params) => sendToWorker({ op: 'all', sql, params }) as Promise<Record<string, unknown>[]>,
    run: (sql, ...params) => sendToWorker({ op: 'run', sql, params }) as Promise<{ changes: number; lastInsertRowid: number }>,
    exec: (sql) => sendToWorker({ op: 'exec', sql }) as Promise<void>,
    transaction: (stmts) => sendToWorker({ op: 'transaction', statements: stmts }) as Promise<unknown[]>,
    pragma: (sql) => sendToWorker({ op: 'pragma', sql }) as Promise<unknown[]>,
    close: () => sendToWorker({ op: 'close' }) as Promise<void>,
  }
}

let initPromise: Promise<void> | null = null

/** 进程级单例连接（懒初始化 Worker；首次调用执行 schema 初始化）。
 *  initPromise 防并发：多个 getDb() 调用共享同一个初始化 Promise，不会重复创建 Worker。
 *  init 失败时重置 instance + initPromise，下次调用重新创建 Worker。 */
export async function getDb(): Promise<SqliteDb> {
  if (migrating) throw new Error('数据目录迁移进行中，请稍后重试')
  if (instance && initPromise) {
    try {
      await initPromise
      return instance
    } catch (e) {
      // init 失败：清空状态，下次重新创建 Worker
      instance = null
      initPromise = null
      if (worker) { worker.terminate().catch(() => {}); worker = null }
      throw e
    }
  }
  if (!instance) {
    const w = createWorker()
    worker = w
    // initPromise 必须在 instance 之前赋值：消除「instance 已就绪但 initPromise 为 null」的窗口期
    initPromise = (async () => {
      const dir = overrideDir ?? await dataDir()
      const initResult = await sendToWorker({ op: 'init', dir }) as { vecReady: boolean }
      vecReady = initResult.vecReady
    })()
    instance = createDbProxy(w)
    try {
      await initPromise
    } catch (e) {
      instance = null
      initPromise = null
      if (worker) { worker.terminate().catch(() => {}); worker = null }
      throw e
    }
  }
  return instance!
}

/** 测试钩子 */
export async function initDbAt(dir: string): Promise<SqliteDb> {
  await closeDb()
  overrideDir = dir
  const w = createWorker()
  worker = w
  const proxy = createDbProxy(w)
  instance = proxy
  const initResult = await sendToWorker({ op: 'init', dir }) as { vecReady: boolean }
  vecReady = initResult.vecReady
  return proxy
}

export function rebaseOverrideDir(dir: string): void {
  if (overrideDir) overrideDir = dir
}

export function setMigrating(v: boolean): void {
  migrating = v
}

export function vecReadyFlag(): boolean {
  return vecReady
}

export async function closeDb(): Promise<void> {
  if (!instance) return
  try {
    await instance.close()
  } catch {}
  instance = null
  worker = null
}

export function projectKey(projectRoot: string): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 16)
}
