/**
 * 消息持久化 + 记忆检索底座冒烟测试：临时目录初始化 SQLite。
 * P0 段：跨会话写入 / 最新会话分页 / 游标走查 / 局部改写 / 截断重发 / 工程删除与隔离。
 * P1 段：记忆 CRUD / FTS 同步三态 / vec 插入与 KNN / LIKE 兜底 / RRF 融合 /
 *        update 重嵌（含失败 no-op）/ stats / 存储迁移（含回滚）——embedder 注入确定性假实现离线可测。
 * 运行：npm run smoke:memory
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { initDbAt, closeDb, dataDir, getDb, vecReadyFlag, projectKey } from '../electron/lib/db'
import {
  messagesRecent, messagesBefore, messageAppend, messagePatch, messagesTruncate, projectDataDelete,
} from '../electron/lib/messages'
import type { StoredMessage } from '../electron/lib/messages'
import {
  memoryList, memorySearch, memoryUpdate, memoryDelete, memoryClear, memoryStats,
  memoryCreate, memoryMoveScope, addDistillTokens, setEmbedder, memoryArchive,
  memoryUnarchive, createOrFoldAtomic, memoryImportData,
  runDecayJob, memoryDecayAudit, memoryRestoreMany,
} from '../electron/lib/memory/service'
import { setReadyOverride } from '../electron/lib/memory/embed'
import { setConfigWriter, migrateDataDir } from '../electron/lib/migrate'
import { snapshotFile, listSnapshots } from '../electron/lib/snapshot'

let failures = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    console.log(`  OK ${label}`)
  } catch (e) {
    failures++
    console.error(`  FAIL ${label}`)
    console.error(`    ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  OK ${label}`)
  } catch (e) {
    failures++
    console.error(`  FAIL ${label}`)
    console.error(`    ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 连续追加 count 条（user/assistant 交替），返回 id→seq 对账表 */
async function appendMany(root: string, sessionId: string, count: number, tag: string): Promise<Map<string, number>> {
  const seqById = new Map<string, number>()
  for (let i = 1; i <= count; i++) {
    const { seq } = await messageAppend(root, sessionId, {
      id: `${tag}-${i}`,
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `${tag} 内容 ${i}`,
    })
    seqById.set(`${tag}-${i}`, seq)
  }
  return seqById
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 确定性假嵌入：字符 trigram 词袋 → 512 维并 L2 归一化（真 bge 输出为单位向量，
 *  假实现必须同构，否则距离封顶筛选下的检索几何失真） */
function fakeVec(text: string): Float32Array {
  const v = new Float32Array(512)
  const s = text.toLowerCase()
  for (let i = 0; i + 3 <= s.length; i++) {
    const g = s.slice(i, i + 3)
    let h = 0
    for (let j = 0; j < g.length; j++) h = (h * 131 + g.charCodeAt(j)) >>> 0
    v[h % 512] += 1
  }
  let norm = 0
  for (const x of v) norm += x * x
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm)
    for (let i = 0; i < v.length; i++) v[i] *= inv
  }
  return v
}

async function main(): Promise<void> {
  const root = 'E:\\fake\\project-alpha'
  const root2 = 'E:\\fake\\project-beta'
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qyris-memory-smoke-'))
  const extraDirs: string[] = [] // 迁移段临时目录（dirB/dirC/dirD），finally 统一清理
  try {
    console.log('① 初始化：')
    // initDbAt 内部先 await closeDb() 再落 overrideDir：不 await 会在 override 生效前就读 dataDir
    await initDbAt(dir)
    check('库文件已创建', () => assert.ok(existsSync(path.join(dir, 'qyris.db'))))
    await checkAsync('dataDir() 返回显式目录', async () => assert.equal(await dataDir(), dir))
    await checkAsync('空库 recent 回空形', async () => assert.deepEqual(await messagesRecent(root), {
      sessionId: null, messages: [], hasMore: false, oldestSeq: null, total: 0,
    }))

    console.log('② 跨会话写入：')
    const seqA = await appendMany(root, 'A', 20, 'a')
    await new Promise((resolve) => setTimeout(resolve, 8)) // 保证 B 的 created_at 严格更晚
    const seqB = await appendMany(root, 'B', 100, 'b')
    check('A 会话 seq 连续 1..20', () =>
      assert.deepEqual([...seqA.values()], Array.from({ length: 20 }, (_, i) => i + 1)))
    check('B 会话 seq 连续 1..100', () =>
      assert.deepEqual([...seqB.values()], Array.from({ length: 100 }, (_, i) => i + 1)))
    await checkAsync('非法 role 被 CHECK 约束拒绝（抛错不静默）', async () => {
      let threw = false
      try {
        await messageAppend(root, 'B', { id: 'bad-1', role: 'system' as unknown as 'user', content: 'x' })
      } catch {
        threw = true
      }
      assert.ok(threw)
    })
    await checkAsync('重复 id 触发主键冲突抛错', async () => {
      let threw = false
      try {
        await messageAppend(root, 'A', { id: 'a-1', role: 'user', content: 'dup' })
      } catch {
        threw = true
      }
      assert.ok(threw)
    })

    console.log('③ messages_recent：')
    const recent = await messagesRecent(root, 50)
    check('最新会话 = B（created_at 更晚）', () => assert.equal(recent.sessionId, 'B'))
    check('total = 项目全量 120', () => assert.equal(recent.total, 120))
    check('页内 50 条正序 51..100', () => {
      assert.equal(recent.messages.length, 50)
      assert.deepEqual(recent.messages.map((m) => m.seq), Array.from({ length: 50 }, (_, i) => i + 51))
    })
    check('hasMore=true 且 oldestSeq=51', () => {
      assert.equal(recent.hasMore, true)
      assert.equal(recent.oldestSeq, 51)
    })
    check('内容抽查 b-100', () => assert.equal(recent.messages[recent.messages.length - 1].content, 'b 内容 100'))

    console.log('④ messages_before 游标走查：')
    const seen: StoredMessage[] = [...recent.messages]
    let cursor: number | null = recent.oldestSeq
    while (cursor !== null) {
      const page = await messagesBefore(root, 'B', cursor, 50)
      seen.push(...page.messages)
      cursor = page.oldestSeq
    }
    check('B 会话走查到头共 100 条、seq 并集恰为 1..100', () => {
      assert.equal(seen.length, 100)
      const seqs = seen.map((m) => m.seq).sort((a, b) => a - b)
      assert.deepEqual(seqs, Array.from({ length: 100 }, (_, i) => i + 1))
    })
    const pageA = await messagesBefore(root, 'A', 21, 50)
    check('A 会话单页取尽 20 条、hasMore=false、oldestSeq=1', () => {
      assert.equal(pageA.messages.length, 20)
      assert.equal(pageA.hasMore, false)
      assert.equal(pageA.oldestSeq, 1)
    })

    console.log('⑤ message_patch：')
    await checkAsync('改 content + 写 tool 并验读', async () => {
      await messagePatch(root, 'B', 'b-7', {
        content: 'B 改写后',
        tool: {
          toolCalls: [{ id: 'tc-1', name: 'read_file', args: { path: 'a.txt' }, status: 'done', resultSummary: 'ok' }],
          toolResults: [{ toolCallId: 'tc-1', content: 'file content' }],
        },
      })
      const page = await messagesBefore(root, 'B', 8, 50)
      const target = page.messages.find((m) => m.id === 'b-7')
      assert.ok(target)
      assert.equal(target.content, 'B 改写后')
      assert.equal(target.toolCalls?.[0]?.name, 'read_file')
      assert.equal(target.toolResults?.[0]?.toolCallId, 'tc-1')
      assert.equal(target.reasoning, undefined) // patch 未触及 reasoning，保持空
    })
    await checkAsync('reasoning 写入后显式置 null → SQL NULL', async () => {
      await messagePatch(root, 'B', 'b-2', { reasoning: '思考过程' })
      const withReason = (await messagesBefore(root, 'B', 3, 50)).messages.find((m) => m.id === 'b-2')
      assert.equal(withReason?.reasoning, '思考过程')
      await messagePatch(root, 'B', 'b-2', { reasoning: null })
      const cleared = (await messagesBefore(root, 'B', 3, 50)).messages.find((m) => m.id === 'b-2')
      assert.equal(cleared?.reasoning, undefined)
    })

    console.log('⑥ messages_truncate：')
    await messagesTruncate(root, 'B', 60)
    const afterTruncate = await messagesRecent(root, 50)
    check('项目总数 120 → 80（B 删 seq 61..100 共 40 条）', () => assert.equal(afterTruncate.total, 80))
    check('B 最新 seq 收口到 60', () => assert.equal(afterTruncate.messages[afterTruncate.messages.length - 1].seq, 60))
    await checkAsync('截断后追加复用 seq=61（MAX+1）', async () => {
      const { seq } = await messageAppend(root, 'B', { id: 'b-61', role: 'assistant', content: 'B 内容 61' })
      assert.equal(seq, 61)
    })

    console.log('⑦ project_data_delete 与工程隔离：')
    await messageAppend(root2, 'X', { id: 'x-1', role: 'user', content: 'beta 内容 1' })
    await projectDataDelete(root)
    const cleared = await messagesRecent(root)
    check('alpha 工程行数清零（空形）', () => assert.deepEqual(cleared, {
      sessionId: null, messages: [], hasMore: false, oldestSeq: null, total: 0,
    }))
    const beta = await messagesRecent(root2)
    check('beta 工程不受牵连（total=1）', () => assert.equal(beta.total, 1))

    // ================= P1：记忆检索底座 =================

    console.log('⑧ 记忆 CRUD 与工程隔离：')
    check('sqlite-vec 已加载（vecReady=true）', () => assert.equal(vecReadyFlag(), true))
    const embedCalls: string[] = []
    setReadyOverride(true)
    setEmbedder((texts) => {
      embedCalls.push(...texts)
      return Promise.resolve(texts.map(fakeVec))
    })
    const itemA = await memoryCreate({
      projectRoot: root, tier: 'long', category: 'lesson',
      title: '登录鉴权模块', content: 'OAuth2 令牌签发与刷新', importance: 0.8,
    })
    check('create 回缺省值（active/acc=0/来源 NULL）', () => {
      assert.ok(itemA.id.startsWith('mem_'))
      assert.equal(itemA.status, 'active')
      assert.equal(itemA.accessCount, 0)
      assert.equal(itemA.lastAccessedAt, null)
      assert.equal(itemA.supersededBy, null)
      assert.equal(itemA.importance, 0.8)
    })
    await sleep(6)
    const itemG = await memoryCreate({
      global: true, tier: 'long', category: 'preference', title: '包管理器偏好', content: '用 pnpm 别用 npm',
    })
    await sleep(6)
    await memoryCreate({
      projectRoot: root2, tier: 'short', sessionId: 'B', category: 'event', title: 'beta 事件', content: 'beta 会话事件记录',
    })
    const listA = await memoryList(root)
    check('list：alpha 工程 + global，不含 beta，updated_at 降序', () => {
      assert.deepEqual(listA.items.map((i) => i.id).sort(), [itemA.id, itemG.id].sort())
      assert.equal(listA.items[0].id, itemG.id)
    })

    console.log('⑨ 混合检索（FTS/LIKE + vec KNN + RRF）：')
    await checkAsync('FTS：≥3 字短语命中，degraded=false，score>0', async () => {
      const r = await memorySearch('登录鉴权', root)
      assert.equal(r.degraded, false)
      assert.equal(r.hits.length, 1)
      assert.equal(r.hits[0].id, itemA.id)
      assert.ok(r.hits[0].score > 0)
    })
    await checkAsync('LIKE 兜底：1-2 字查询照常命中', async () => {
      const r1 = await memorySearch('鉴', root)
      assert.equal(r1.hits.length, 1)
      assert.equal(r1.hits[0].id, itemA.id)
      const r2 = await memorySearch('pnpm', root)
      assert.equal(r2.hits[0].id, itemG.id)
    })
    await checkAsync('命中回写 access_count/last_accessed_at', async () => {
      const before = (await memoryList(root)).items.find((i) => i.id === itemA.id)
      await memorySearch('登录鉴权', root)
      // 回写是 setImmediate 延迟落库（不阻塞检索响应）：让一拍再读，否则读到旧计数
      await new Promise((r) => setImmediate(r))
      const after = (await memoryList(root)).items.find((i) => i.id === itemA.id)
      assert.equal(after!.accessCount, before!.accessCount + 1)
      assert.ok(after!.lastAccessedAt !== null)
    })
    const itemT2 = await memoryCreate({
      projectRoot: root, tier: 'long', category: 'skill', title: '部署流水线', content: '部署流水线模板与缓存', importance: 0.5,
    })
    await checkAsync('FTS 同步三态①：改标题后旧词搜不到', async () => {
      const embedBefore = embedCalls.length
      const updated = await memoryUpdate(itemA.id, { title: '支付结算模块', content: '支付结算通道对账' })
      assert.equal(updated.title, '支付结算模块')
      assert.equal(updated.content, '支付结算通道对账')
      assert.equal(embedCalls.length, embedBefore + 1) // 重嵌恰好发生一次
      assert.equal(embedCalls[embedCalls.length - 1], '支付结算模块\n支付结算通道对账')
      const r = await memorySearch('登录鉴权', root)
      assert.equal(r.hits.length, 0)
    })
    await checkAsync('FTS 同步三态②：新词搜得到（标题与正文都进索引）', async () => {
      const r1 = await memorySearch('支付结算', root)
      assert.equal(r1.hits.length, 1)
      assert.equal(r1.hits[0].id, itemA.id)
      const r2 = await memorySearch('通道对账', root)
      assert.equal(r2.hits[0].id, itemA.id)
    })
    await checkAsync('vec KNN：FTS 查不到的变体查询由向量路召回', async () => {
      const r = await memorySearch('部署流水线x', root) // 'x' 使 FTS 短语必失配，只能靠向量
      assert.equal(r.degraded, false)
      assert.equal(r.hits[0].id, itemT2.id)
      assert.ok(r.hits[0].score > 1 / 61, '向量路贡献了 RRF 基础分')
    })
    await checkAsync('双轨打分 = 0.55·rrf_norm + 0.20·importance + 0.25·activation（钉公式形状）', async () => {
      // 行状态取检索前快照（打分先于 access 回写），镜像公式与实现对照
      const it = (await memoryList(root)).items.find((i) => i.id === itemA.id)!
      const r = await memorySearch('支付结算', root)
      assert.equal(r.hits[0].id, itemA.id)
      // 双路 rank1 → rrf_norm = 1.0；activation 按契约公式从行字段自算（权重/归一变动即破此断言）
      const s = (1 + it.accessCount) / (1 + it.accessCount + 3)
      const expected = 0.55 * 1.0 + 0.2 * it.importance + 0.25 * s
      assert.ok(Math.abs(r.hits[0].score - expected) < 0.01, `实得 ${r.hits[0].score} 预期 ${expected}`)
    })
    await checkAsync('FTS 同步三态③：删除后全搜不到且向量同步清', async () => {
      await memoryDelete(itemA.id)
      assert.equal((await memorySearch('支付结算', root)).hits.length, 0)
      assert.equal((await memorySearch('结算通道', root)).hits.length, 0)
      const vecLeft = await memorySearch('对账与重试', root)
      assert.equal(vecLeft.hits.length, 0)
    })
    await checkAsync('update 重嵌失败 → 整体 no-op（标题/向量保持旧态）', async () => {
      setEmbedder(() => Promise.reject(new Error('embed boom')))
      const r = await memoryUpdate(itemG.id, { title: '新标题' })
      assert.equal(r.title, '包管理器偏好')
      const s = await memorySearch('包管理器', root)
      assert.equal(s.hits.length, 1)
      assert.equal(s.hits[0].title, '包管理器偏好')
    })
    await checkAsync('importance/category 更新不触发重嵌', async () => {
      setEmbedder((texts) => Promise.resolve(texts.map(fakeVec)))
      const before = embedCalls.length
      await memoryUpdate(itemG.id, { importance: 0.9, category: 'preference' })
      assert.equal(embedCalls.length, before)
    })

    console.log('⑩ memory_stats 与 clear：')
    const stats = await memoryStats(root)
    const statsGlobal = await memoryStats(null)
    check('stats 按范围出账（工程档/全局档分账，与列表同口径）', () => {
      assert.equal(stats.total, 1) // 工程 root：itemA
      assert.equal(stats.byTier.long, 1)
      assert.equal(statsGlobal.total, 1) // global：itemG
      assert.equal(statsGlobal.byTier.long, 1)
      assert.ok((statsGlobal.byCategory.preference ?? 0) >= 1)
      assert.equal(stats.vecAvailable, true)
      assert.equal(stats.embedReady, true)
      assert.ok(stats.dbBytes > 0)
    })
    await memoryClear('project', root2)
    await checkAsync('clear(project) 只清本工程', async () => {
      assert.equal((await memoryStats(root2)).total, 0) // beta 已清
      assert.equal((await memoryStats(root)).total, 1) // itemT2 不受影响（itemA 已在三态③删除）
      assert.equal((await memoryStats(null)).total, 1) // itemG 不受影响
    })
    await memoryClear('global')
    await checkAsync('clear(global) 只清跨工程', async () => {
      assert.equal((await memoryStats(null)).total, 0) // itemG 已清
      assert.equal((await memoryStats(root)).total, 1) // itemT2 不受影响
    })

    console.log('⑪ 存储迁移（happy + 校验拒绝 + 回滚）：')
    const configWrites: (string | null)[] = []
    setConfigWriter(async (d) => { configWrites.push(d) })
    // 当前根（dir）落一个快照，验证快照随迁
    const projDir = path.join(dir, 'proj')
    mkdirSync(projDir, { recursive: true })
    const projFile = path.join(projDir, 'a.txt')
    writeFileSync(projFile, 'v1', 'utf8')
    await snapshotFile(root, 'S1', projFile)
    await checkAsync('迁移前源侧快照存在', async () => {
      assert.ok(Object.keys(await listSnapshots(root)).length > 0)
    })

    const dirB = mkdtempSync(path.join(os.tmpdir(), 'qyris-migrate-b-'))
    extraDirs.push(dirB)
    const migOk = await migrateDataDir(dirB)
    check('happy 迁移 ok=true', () => assert.equal(migOk.ok, true))
    check('config 写入器收到目标目录', () => assert.equal(configWrites[configWrites.length - 1], path.resolve(dirB)))
    check('库文件已移动', () => {
      assert.ok(existsSync(path.join(dirB, 'qyris.db')))
      assert.ok(!existsSync(path.join(dir, 'qyris.db')))
    })
    await checkAsync('dataDir() 已重定向到新根', async () => assert.equal(await dataDir(), path.resolve(dirB)))
    await checkAsync('快照随迁 + 源侧清除', async () => {
      const snaps = await listSnapshots(root)
      assert.ok(Object.keys(snaps).length > 0)
      assert.ok(!existsSync(path.join(dir, 'snapshots')))
    })
    await checkAsync('迁移后库可用：消息与记忆行数保留', async () => {
      assert.equal((await messagesRecent(root2)).total, 1)
      const items = await memoryList(root)
      assert.deepEqual(items.items.map((i) => i.id), [itemT2.id])
    })
    check('迁移后 sqlite-vec 仍可用', () => assert.equal(vecReadyFlag(), true))

    await checkAsync('同目录迁移拒绝', async () => {
      const r = await migrateDataDir(dirB)
      assert.equal(r.ok, false)
    })
    const dirC = mkdtempSync(path.join(os.tmpdir(), 'qyris-migrate-c-'))
    extraDirs.push(dirC)
    writeFileSync(path.join(dirC, 'qyris.db'), 'occupied', 'utf8')
    await checkAsync('目标已有非空库拒绝', async () => {
      const r = await migrateDataDir(dirC)
      assert.equal(r.ok, false)
      assert.match(r.error ?? '', /非空/)
    })
    const dirD = mkdtempSync(path.join(os.tmpdir(), 'qyris-migrate-d-'))
    extraDirs.push(dirD)
    writeFileSync(path.join(dirD, 'snapshots'), 'file-not-dir', 'utf8') // 迫使快照复制失败，触发回滚
    await checkAsync('快照复制失败 → 整体回滚', async () => {
      const r = await migrateDataDir(dirD)
      assert.equal(r.ok, false)
      assert.match(r.error ?? '', /迁移失败/)
      assert.ok(existsSync(path.join(dirB, 'qyris.db')), 'db 已挪回原位')
      assert.ok(!existsSync(path.join(dirD, 'qyris.db')), '目标无残留库')
      assert.ok(existsSync(path.join(dirB, 'snapshots')), '源侧快照未丢')
    })
    await checkAsync('回滚后库照常读写', async () => {
      assert.equal((await messagesRecent(root2)).total, 1)
      assert.equal((await memoryList(root)).items.length, 1)
    })

    console.log('⑪.5 scope 转换 + 蒸馏 token 归零：')
    const movedUser = await memoryMoveScope(itemT2.id, 'user')
    check('项目记忆转用户：project_key=global + tier=long + session 清空', () => {
      assert.equal(movedUser.projectKey, 'global')
      assert.equal(movedUser.tier, 'long')
      assert.equal(movedUser.sessionId, null)
    })
    const movedBack = await memoryMoveScope(itemT2.id, 'project', root)
    check('用户记忆转项目：project_key=工程键', () => {
      assert.equal(movedBack.projectKey, projectKey(root))
    })
    await checkAsync('summary 类拒绝 scope 转换', async () => {
      const s = await memoryCreate({ projectRoot: root, tier: 'short', category: 'summary', title: '会话滚动摘要', content: 'x' })
      let threw = false
      try { await memoryMoveScope(s.id, 'user') } catch { threw = true }
      await memoryDelete(s.id)
      assert.ok(threw)
    })
    addDistillTokens(120, 80)
    await memoryClear('project', root)
    await checkAsync('clear(project) 归零蒸馏 token（含空清空）', async () => {
      const t = (await memoryStats()).distillTokens
      assert.equal(t?.input, 0)
      assert.equal(t?.output, 0)
    })
    console.log('⑫ 并发一致性（原子折叠 / 唯一索引兜底 / 导入原子 / 孤儿向量守卫）：')
    setEmbedder((texts) => Promise.resolve(texts.map(fakeVec)))
    setReadyOverride(true)
    // 折叠语义：同 (scope,category,title) 的 create 收进单同步事务，命中即折叠（content 覆写、importance 取 MAX）
    const f1 = await createOrFoldAtomic({ projectRoot: root, tier: 'long', category: 'fact', title: '原子折叠目标', content: 'v1', importance: 0.4 })
    check('createOrFold 首次：新建', () => assert.equal(f1.folded, false))
    const f2 = await createOrFoldAtomic({ projectRoot: root, tier: 'long', category: 'fact', title: '原子折叠目标', content: 'v2', importance: 0.9 })
    check('createOrFold 同题再 create：折叠', () => assert.equal(f2.folded, true))
    check('折叠返回原条目 id', () => assert.equal(f2.id, f1.id))
    await checkAsync('折叠 content 覆写 + importance 取 MAX + 不产生重复行', async () => {
      const items = (await memoryList(root)).items
      const it = items.find((i) => i.id === f1.id)
      assert.ok(it)
      assert.equal(it.content, 'v2')
      assert.equal(it.importance, 0.9)
      assert.equal(items.filter((i) => i.title === '原子折叠目标').length, 1)
    })
    let f3Id = ''
    await checkAsync('仅存在 archived 同题时折叠不命中 → 新建', async () => {
      await memoryArchive(f1.id)
      const f3 = await createOrFoldAtomic({ projectRoot: root, tier: 'long', category: 'fact', title: '原子折叠目标', content: 'v3', importance: 0.6 })
      assert.equal(f3.folded, false)
      assert.notEqual(f3.id, f1.id)
      f3Id = f3.id
    })
    // 唯一索引兜底：绕过折叠的直建同题 active 触发约束抛错（库级拦截重复）
    await checkAsync('直建同题 active 触发唯一索引约束抛错', async () => {
      let threw = false
      try {
        await memoryCreate({ projectRoot: root, tier: 'long', category: 'fact', title: '原子折叠目标', content: 'dup' })
      } catch {
        threw = true
      }
      assert.ok(threw)
    })
    // 导入原子：同 id / 同 active 三元组逐条事务内 skip，不撞约束不拖垮整体
    await checkAsync('导入：新增 + 同 id skip + 同题 skip 计数正确', async () => {
      const payload = {
        version: 1,
        exportedAt: Date.now(),
        items: [
          { id: 'imp-1', tier: 'long', category: 'fact', title: '导入新条目', content: 'a', projectKey: 'global' },
          { id: f3Id, tier: 'long', category: 'fact', title: 'id 撞已存在', content: 'b' },
          { id: 'imp-3', tier: 'long', category: 'fact', title: '原子折叠目标', content: 'c', projectKey: projectKey(root) },
        ],
      }
      const r = await memoryImportData(JSON.stringify(payload))
      assert.equal(r.imported, 1)
      assert.equal(r.skipped, 2)
      const listed = (await memoryList(root)).items.filter((i) => i.id === 'imp-1')
      assert.equal(listed.length, 1)
    })
    // 孤儿向量守卫：embed 途中条目被并发删除 → 向量放弃落库，不崩、不留半态
    await checkAsync('embed 途中删除：守卫生效不落孤儿（路径可跑通）', async () => {
      const g0 = await createOrFoldAtomic({ projectRoot: root, tier: 'long', category: 'lesson', title: '孤儿守卫目标', content: 'v1' })
      setEmbedder(async (texts) => {
        await memoryDelete(g0.id) // 模拟另一窗口/清空在 embed 期间删除
        return texts.map(fakeVec)
      })
      try {
        await createOrFoldAtomic({ projectRoot: root, tier: 'long', category: 'lesson', title: '孤儿守卫目标', content: 'v2' })
      } finally {
        setEmbedder((texts) => Promise.resolve(texts.map(fakeVec)))
      }
      const left = (await memoryList(root, true)).items.filter((i) => i.title === '孤儿守卫目标')
      assert.equal(left.length, 0)
      // 守卫后系统照常读写
      const ok2 = await createOrFoldAtomic({ projectRoot: root, tier: 'long', category: 'lesson', title: '孤儿守卫目标', content: 'v3' })
      assert.equal(ok2.folded, false)
    })

    console.log('⑬ 信任地基（origin 契约 / 显式保护 / 归档痕迹 / 恢复往返 / supersede）：')
    {
      // origin 打标与缺省
      const r1 = await createOrFoldAtomic({ projectRoot: root, tier: 'long', category: 'fact', title: 'origin 缺省', content: 'v1' })
      await checkAsync('origin 缺省 = agent_suggest', async () => {
        const it = (await memoryList(root, true)).items.find((i) => i.id === r1.id)
        assert.equal(it?.origin, 'agent_suggest')
      })
      // 显式条目：importance 下限 0.6 + 免自动保护
      const r2 = await createOrFoldAtomic({
        projectRoot: root, tier: 'long', category: 'preference', title: '显式偏好',
        content: '用户亲口说的', importance: 0.3, origin: 'user_explicit',
      })
      await checkAsync('显式条目 importance 抬到下限 0.6', async () => {
        const it = (await memoryList(root, true)).items.find((i) => i.id === r2.id)
        assert.equal(it?.origin, 'user_explicit')
        assert.equal(it?.importance, 0.6)
      })
      // 显式保护：默认拒归档 + 显式放行可归档（带痕迹）
      await checkAsync('显式条目默认拒归档（保护契约）', async () => {
        await assert.rejects(() => memoryArchive(r2.id, { reason: 'x' }), /显式保存/)
      })
      await checkAsync('显式放行可归档且痕迹落库', async () => {
        assert.equal(await memoryArchive(r2.id, { reason: '用户改了偏好', by: 'user', allowArchiveExplicit: true }), true)
        const it = (await memoryList(root, true)).items.find((i) => i.id === r2.id)
        assert.equal(it?.status, 'archived')
        assert.equal(it?.archivedBy, 'user')
        assert.equal(it?.archivedReason, '用户改了偏好')
        assert.ok(it?.archivedAt)
      })
      // 恢复往返：清痕迹 + 重新计活
      await checkAsync('恢复往返（unarchive 清痕迹 + 重新计活）', async () => {
        const restored = await memoryUnarchive(r2.id)
        assert.equal(restored.status, 'active')
        assert.equal(restored.archivedAt, null)
        assert.equal(restored.archivedReason, null)
        assert.ok(restored.lastAccessedAt, '恢复即重新计活')
      })
      // 显式条目折叠 → supersede 不覆写（旧文保留可回看）
      await checkAsync('显式条目折叠 → supersede（不覆写旧文）', async () => {
        const r3 = await createOrFoldAtomic({
          projectRoot: root, tier: 'long', category: 'preference', title: '显式偏好',
          content: '新版表述', origin: 'distill',
        })
        assert.equal(r3.folded, true, '同题折叠计数')
        const all = (await memoryList(root, true)).items.filter((i) => i.title === '显式偏好')
        assert.equal(all.length, 2, '旧行归档留痕 + 新行 active（不覆写）')
        const oldRow = all.find((i) => i.id === r2.id)
        const newRow = all.find((i) => i.id === r3.id)
        assert.equal(oldRow?.status, 'archived')
        assert.equal(oldRow?.supersededBy, r3.id, '旧链指向新')
        assert.equal(oldRow?.content, '用户亲口说的', '旧文保留')
        assert.equal(newRow?.origin, 'user_explicit', '契约随版本传递')
        assert.equal(newRow?.content, '新版表述')
      })
      // 普通条目折叠契约升级（agent_suggest 行被显式 caller 再保存 → 升为 user_explicit）
      await checkAsync('折叠契约升级（显式 caller 保存同题 → 升级保护）', async () => {
        await createOrFoldAtomic({
          projectRoot: root, tier: 'long', category: 'fact', title: 'origin 缺省',
          content: 'v2 用户确认', origin: 'user_explicit',
        })
        const it = (await memoryList(root, true)).items.find((i) => i.id === r1.id)
        assert.equal(it?.origin, 'user_explicit')
        assert.equal(it?.content, 'v2 用户确认')
      })
    }

    console.log('⑭ 衰减作业（event 归档 / 显式豁免 / 触底谓词 / 幂等 / 审计 / 时钟守卫）：')
    {
      // 信息量门控（mem0 式 UPDATE-with-gate）：退化覆写拒绝、合法重写放行
      const g1 = await createOrFoldAtomic({ projectRoot: root, tier: 'long', category: 'fact', title: '门控目标', content: '完整信息包含很多细节与约定' })
      await checkAsync('信息量门控：折叠到大幅子串被拒（退化覆写）', async () => {
        await assert.rejects(() => createOrFoldAtomic({
          projectRoot: root, tier: 'long', category: 'fact', title: '门控目标', content: '完整信息',
        }), /信息退化/)
        assert.equal((await memoryList(root, true)).items.find((i) => i.id === g1.id)?.content, '完整信息包含很多细节与约定')
      })
      await checkAsync('信息量门控：合法重写/加长放行', async () => {
        const r = await createOrFoldAtomic({
          projectRoot: root, tier: 'long', category: 'fact', title: '门控目标', content: '完整信息包含很多细节与约定（补充了新约定与例外）',
        })
        assert.equal(r.folded, true)
        await assert.rejects(() => memoryUpdate(g1.id, { content: '约定' }), /信息退化/)
      })
    }
    {
      const NOW = 10_000_000_000_000
      const DAY = 86_400_000
      // 造 event 条目并回拨 updated_at（memoryCreate 恒写 now，衰减边界要按绝对时刻造）
      const mk = async (title: string, updatedAt: number, origin?: 'user_explicit' | 'agent_suggest' | 'distill') => {
        const it = await memoryCreate({
          projectRoot: root, tier: 'long', category: 'event', title, content: 'x',
          ...(origin ? { origin } : {}),
        })
        const db = await getDb()
        await db.prepare('UPDATE mem_items SET updated_at = ? WHERE id = ?').run(updatedAt, it.id)
        return it
      }
      /** 时间手术：三时间列（+ 归档行的 archived_at）统一拨到绝对时刻（清理线/老化按受控值造） */
      const setTimes = async (id: string, t: number): Promise<void> => {
        const db = await getDb()
        await db.prepare(
          "UPDATE mem_items SET last_accessed_at = ?, created_at = ?, updated_at = ?, archived_at = CASE WHEN status = 'archived' THEN ? ELSE archived_at END WHERE id = ?",
        ).run(t, t, t, t, id)
      }
      // event 边界：恰好 60d 不归档（严格 <），60d+1ms 归档
      const ev1 = await mk('event边界恰好', NOW - 60 * DAY)
      const ev2 = await mk('event边界超', NOW - 60 * DAY - 1)
      // 显式豁免：user_explicit 的 event 超期也不归档
      const ev3 = await mk('event显式豁免', NOW - 90 * DAY, 'user_explicit')
      const s1 = await runDecayJob(NOW)
      assert.equal(s1.decayed, 0, 'importance 静态化：作业不写 importance')
      assert.equal(s1.archived >= 1, true, `至少归档超期 event（实得 ${s1.archived}）`)
      await checkAsync('event 恰 60d 不归档（严格小于）', async () => {
        assert.equal((await memoryList(root, true)).items.find((i) => i.id === ev1.id)?.status, 'active')
      })
      await checkAsync('event 超 60d 归档（by=decay + reason）', async () => {
        const it = (await memoryList(root, true)).items.find((i) => i.id === ev2.id)
        assert.equal(it?.status, 'archived')
        assert.equal(it?.archivedBy, 'decay')
        assert.ok(it?.archivedReason?.includes('自动收起'))
      })
      await checkAsync('显式条目豁免自动归档（90d 超期仍活跃）', async () => {
        assert.equal((await memoryList(root, true)).items.find((i) => i.id === ev3.id)?.status, 'active')
      })
      // 批量恢复（趁清理发生前——v2 物理清理窗口 180d 会吃掉更早批次的归档行）
      await checkAsync('审计锚点 + 批量恢复（误归档还原）', async () => {
        const audit = await memoryDecayAudit()
        assert.ok(audit && audit.archivedIds.includes(ev2.id), '审计含归档 id')
        const r = await memoryRestoreMany(audit!.archivedIds)
        assert.ok(r.restored >= 1, `至少恢复本轮归档（实得 ${r.restored}）`)
        assert.equal((await memoryList(root, true)).items.find((i) => i.id === ev2.id)?.status, 'active')
      })
      // fact 规则：importance 触底(≤0.1) 且 180d 未访问 → 归档；未触底的陈旧 fact 不动
      const ft1 = await memoryCreate({ projectRoot: root, tier: 'long', category: 'fact', title: 'fact低值陈旧', content: 'x', importance: 0.1 })
      const ft2 = await memoryCreate({ projectRoot: root, tier: 'long', category: 'fact', title: 'fact正常陈旧', content: 'x', importance: 0.5 })
      // v2 物理清理靶：agent 来源 event 手动归档并把 archived_at 拨到清理线之前；显式对照行同样拨旧
      const evP = await mk('event清理靶', NOW - 90 * DAY)
      await memoryArchive(evP.id, { reason: '测试预归档', allowArchiveExplicit: false })
      await setTimes(evP.id, NOW - 90 * DAY)
      const evX = await mk('event显式清理豁免', NOW - 90 * DAY, 'user_explicit')
      await memoryArchive(evX.id, { reason: '显式对照', allowArchiveExplicit: true })
      await setTimes(evX.id, NOW - 90 * DAY)
      const s2 = await runDecayJob(NOW + 200 * DAY)
      assert.equal(s2.decayed, 0, 'importance 静态化：作业恒不写 importance')
      await checkAsync('fact 规则：触底低值陈旧归档、正常值陈旧保留', async () => {
        assert.equal((await memoryList(root, true)).items.find((i) => i.id === ft1.id)?.status, 'archived')
        assert.equal((await memoryList(root, true)).items.find((i) => i.id === ft2.id)?.status, 'active')
      })
      await checkAsync('v2 物理清理：agent 来源超期归档 event 被物理删除', async () => {
        const db = await getDb()
        const row = await db.prepare('SELECT 1 FROM mem_items WHERE id = ?').get(evP.id)
        assert.ok(!row, '行已物理删除（含 mem_vec）')
        assert.ok(s2.purged >= 1, `purge 计数（实得 ${s2.purged}）`)
      })
      await checkAsync('v2 物理清理：显式条目豁免（归档再久也不删）', async () => {
        const db = await getDb()
        const row = await db.prepare('SELECT 1 FROM mem_items WHERE id = ?').get(evX.id)
        assert.ok(row, '显式条目仍在库')
      })
      // 幂等：清账后同 now 再跑一轮全零
      await checkAsync('衰减幂等（清账后第二轮全零）', async () => {
        const s = await runDecayJob(NOW + 200 * DAY)
        assert.deepEqual(s, { decayed: 0, archived: 0, purged: 0 })
      })
      // 审计锚点（近 5 轮并集）
      await checkAsync('审计锚点保留多轮 archivedIds（误归档恢复依据）', async () => {
        const audit = await memoryDecayAudit()
        assert.ok(audit && audit.archivedIds.includes(ev2.id), '审计含首轮归档 id')
        assert.ok(audit.archivedIds.includes(ft1.id), '审计含次轮归档 id')
      })
      // 时钟回拨守卫：now 落后上次 60s 以上 → 跳过
      await checkAsync('时钟回拨守卫（now 回拨跳过本轮）', async () => {
        const s = await runDecayJob(NOW - 120_000)
        assert.deepEqual(s, { decayed: 0, archived: 0, purged: 0 })
      })
    }
    setEmbedder(null)
    setReadyOverride(null)

    setConfigWriter(null)
    await memoryClear('all')
    await checkAsync('clear(all) 清空全部', async () => {
      assert.equal((await memoryStats(null)).total, 0)
      assert.equal((await memoryStats(root)).total, 0)
    })
  } finally {
    // 先 await 关库再删临时目录：Windows 上 Worker 还握着 db 文件时 rm 会 EPERM
    await closeDb()
    rmSync(dir, { recursive: true, force: true })
    for (const d of extraDirs) rmSync(d, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
  // sqlite worker 的 MessagePort 在 closeDb 后仍挂事件循环，不显式退出则 npm run 永不收口
  process.exit(0)
}

void main().catch((e) => {
  console.error('smoke 崩溃：', e)
  process.exit(1)
})
