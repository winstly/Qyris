/**
 * mem agent 记忆蒸馏管线冒烟测试：假 provider（真 runner 工具循环）+ 假时钟 + 假 embedder 离线全链路。
 * 蒸馏走 agent+tools（与主对话同一条 runAgent 链路）：假 provider 发 tool-call → runner 真执行
 * memory_* 工具 → 断言直接查库（落库即真执行，不做解析层 mock）。
 * 运行：npm run smoke:memory-agent
 */
import { mkdtempSync, writeFileSync, renameSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { initDbAt, closeDb, dataDir, getDb, projectKey, vecReadyFlag } from '../electron/lib/db'
import { messageAppend, messagePatch, messagesRecent } from '../electron/lib/messages'
import {
  memoryCreate, memoryList, memorySearch, sessionSummary, noteLesson, setEmbedder,
} from '../electron/lib/memory/service'
import { setReadyOverride } from '../electron/lib/memory/embed'
import {
  SYSTEM_PROMPT, setProviderOverride, setClock, memoryMaybeExtract, sessionEnded, memoryRunNow,
  resetExtractStateForTest,
} from '../electron/lib/memory/agent'
import { setConfigWriter, migrateDataDir } from '../electron/lib/migrate'
import type { ContentPart, ModelProvider } from '../electron/lib/model/types'

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 追加一轮对话（user + assistant 各一条），返回无 */
async function appendTurn(root: string, sessionId: string, tag: string, n: number): Promise<void> {
  await messageAppend(root, sessionId, { id: `${tag}-u${n}`, role: 'user', content: `${tag} 用户请求 ${n}` })
  await messageAppend(root, sessionId, { id: `${tag}-a${n}`, role: 'assistant', content: `${tag} 助手回复 ${n}` })
}

async function messageCount(): Promise<number> {
  const db = await getDb()
  return Number((await db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n)
}

async function memRowCount(): Promise<number> {
  const db = await getDb()
  return Number((await db.prepare('SELECT COUNT(*) AS n FROM mem_items').get() as { n: number }).n)
}

/** 确定性假嵌入：字符 trigram 词袋 → 512 维并 L2 归一化（与 smoke-memory 同款） */
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
    for (let j = 0; j < v.length; j++) v[j] *= inv
  }
  return v
}

// ---------- 假 provider：真 runner 工具循环（tool-call → runner 执行 → 回喂 → done） ----------

/** 一步脚本：calls = 本轮发出的工具调用（runner 真执行）；text = 本轮正文（收尾轮即滚动摘要） */
interface FakeStep {
  calls?: { name: string; input: unknown }[]
  text?: string
}

let completeCalls = 0
const capturedUsers: string[] = []
const capturedSystems: string[] = []
/** 工具执行观测（name→次数）：断言 runner 真的跑了 executeTool */
const executedTools: string[] = []

function installFake(step: FakeStep, opts?: { gate?: Promise<void> }): void {
  const steps = Array.isArray(step) ? step : [step]
  completeCalls = 0
  capturedUsers.length = 0
  capturedSystems.length = 0
  executedTools.length = 0
  let turn = 0
  const provider: ModelProvider = {
    id: 'fake-mem',
    capabilities: { streaming: true, tools: true, thinking: false, jsonSchema: false },
    async *complete(req) {
      if (opts?.gate) await opts.gate
      // 脚本步按轮消费；耗尽后的轮次（工具结果回喂）只给收尾正文，不再重复发调用（防循环执行）
      const scripted = turn < steps.length
      const s = steps[Math.min(turn, steps.length - 1)]
      turn++
      completeCalls++
      const userMsg = [...req.messages].reverse().find((m) => m.role === 'user')
      const userText = textOf(userMsg?.content ?? [])
      capturedUsers.push(userText)
      const sysMsg = req.messages.find((m) => m.role === 'system')
      capturedSystems.push(textOf(sysMsg?.content ?? []))
      if (scripted) {
        for (const [idx, c] of (s.calls ?? []).entries()) {
          executedTools.push(c.name)
          yield { type: 'tool-call', id: `fake-${turn}-${idx}`, name: c.name, input: c.input }
        }
      }
      yield {
        type: 'done',
        message: { role: 'assistant', content: [{ type: 'text', text: s.text ?? '' }], meta: { ts: 0 } },
        usage: { inputTokens: 10, outputTokens: 10 },
      }
    },
  }
  setProviderOverride(provider)
}

function textOf(parts: readonly ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

const NOOP_STEP: FakeStep = { text: '' }

async function main(): Promise<void> {
  const root = 'E:\\fake\\agent-alpha'
  const root2 = 'E:\\fake\\agent-beta'
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qyris-agent-smoke-'))
  const extraDirs: string[] = [] // 迁移接管段临时目录，finally 统一清理
  installFake(NOOP_STEP)
  try {
    console.log('① 初始化：')
    await initDbAt(dir)
    setReadyOverride(true)
    setEmbedder((texts) => Promise.resolve(texts.map(fakeVec)))
    check('库文件已创建', () => assert.ok(existsSync(path.join(dir, 'qyris.db'))))
    await checkAsync('dataDir() 返回显式目录', async () => assert.equal(await dataDir(), dir))

    console.log('② 阈值与冷却（假时钟，会话 S1）：')
    let now = 1_000_000
    setClock(() => now)
    await memoryMaybeExtract(root, 'S1') // 首见：空会话，游标落 0
    for (let n = 1; n <= 5; n++) await appendTurn(root, 'S1', 't1', n)
    await memoryMaybeExtract(root, 'S1')
    check('5 轮 assistant 未达 6 轮阈值 → 不提取', () => assert.equal(completeCalls, 0))
    await appendTurn(root, 'S1', 't1', 6)
    await memoryMaybeExtract(root, 'S1')
    check('第 6 轮 assistant 达阈值 → 提取一次（no-op）', () => assert.equal(completeCalls, 1))
    now = 1_030_000 // 距上次提取 30s
    for (let n = 7; n <= 12; n++) await appendTurn(root, 'S1', 't1', n)
    await memoryMaybeExtract(root, 'S1')
    check('冷却中（30s < 60s）→ 不提取', () => assert.equal(completeCalls, 1))
    now = 1_061_000 // 距上次提取 61s
    for (let n = 13; n <= 18; n++) await appendTurn(root, 'S1', 't2', n)
    await memoryMaybeExtract(root, 'S1')
    check('冷却过 → 提取', () => assert.equal(completeCalls, 2))

    console.log('③ 增量提取全生效（save/update/archive/summary，工具真执行）：')
    const m1 = await memoryCreate({
      projectRoot: root, tier: 'long', category: 'fact', title: '部署流程约定', content: '旧正文', importance: 0.6,
    })
    const m2 = await memoryCreate({
      projectRoot: root, tier: 'long', category: 'skill', title: '过时技巧', content: '已被淘汰的做法', importance: 0.4,
    })
    now = 2_000_000
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S1', 't3', n)
    // 第 2 轮 assistant 带工具调用：多行 command，验证只取第一行 80 字符摘要
    await messagePatch(root, 'S1', 't3-a2', {
      tool: {
        toolCalls: [{ id: 'tc-1', name: 'run_command', args: { command: 'pnpm install --frozen-lockfile\necho done' }, status: 'done' }],
      },
    })
    const msgsBefore = await messageCount()
    installFake({
      calls: [
        {
          name: 'memory_save',
          input: {
            scope: 'user', category: 'preference', title: '包管理器用 pnpm',
            content: '用户明确要求一律用 pnpm', importance: 0.8, sources: ['#25'],
          },
        },
        { name: 'memory_update', input: { id: m1.id, content: '部署流程约定（已合并 pnpm 偏好）' } },
        { name: 'memory_archive', input: { id: m2.id, reason: '已被淘汰' } },
      ],
      text: 'S1 阶段进展：确定包管理器与部署约定',
    })
    await memoryMaybeExtract(root, 'S1')
    check('runner 两轮收敛（工具轮 + 收尾轮）', () => assert.equal(completeCalls, 2))
    check('三个记忆工具被真执行', () =>
      assert.deepEqual(executedTools, ['memory_save', 'memory_update', 'memory_archive']))
    const system = capturedSystems[capturedSystems.length - 1]
    check('系统提示 = 蒸馏纪律常量', () => assert.equal(system, SYSTEM_PROMPT))
    const user = capturedUsers[capturedUsers.length - 1]
    check('prompt 含增量转录节与消息行', () => {
      assert.ok(user.includes('【增量转录】'))
      assert.ok(user.includes('#37 用户：t3 用户请求 1'))
      assert.ok(user.includes('#40 助手：t3 助手回复 2'))
    })
    check('prompt 工具一行摘要：只取 command 第一行，不付工具结果 token', () => {
      assert.ok(user.includes('工具 run_command：pnpm install --frozen-lockfile'))
      assert.ok(!user.includes('echo done'))
    })
    check('prompt 含白名单说明（工具提交通道，非 JSON 手写）', () => {
      assert.ok(system.includes('memory_save'))
      assert.ok(!system.includes('"ops"'))
    })
    check('prompt 含现有记忆清单（long + 本会话 short，带 id 供 update/archive 定位）', () => {
      assert.ok(user.includes('【现有记忆清单】'))
      assert.ok(user.includes(`- [fact] 部署流程约定（${m1.id}）`))
      assert.ok(user.includes(`- [skill] 过时技巧（${m2.id}）`))
    })
    await checkAsync('memory_save 生效（category/importance/sources 落库）', async () => {
      const item = (await memoryList(root)).items.find((i) => i.title === '包管理器用 pnpm')
      assert.ok(item)
      assert.equal(item.tier, 'long')
      assert.equal(item.category, 'preference')
      assert.equal(item.projectKey, 'global') // preference 类恒 user
      assert.equal(item.importance, 0.8)
      assert.ok(item.sourceJson?.includes('#25'))
      assert.equal(item.sessionId, null) // long 层不挂 session
    })
    await checkAsync('memory_update 生效（按 id 更新正文）', async () => {
      const item = (await memoryList(root, true)).items.find((i) => i.id === m1.id)
      assert.equal(item?.content, '部署流程约定（已合并 pnpm 偏好）')
    })
    await checkAsync('memory_archive 生效（status=archived）', async () => {
      const item = (await memoryList(root, true)).items.find((i) => i.id === m2.id)
      assert.equal(item?.status, 'archived')
    })
    await checkAsync('summary 落为该 session 的 active 摘要', async () =>
      assert.equal(await sessionSummary(root, 'S1'), 'S1 阶段进展：确定包管理器与部署约定'))
    await checkAsync('防自食：提取前后 messages 行数一致（蒸馏不写 messages 表）', async () =>
      assert.equal(await messageCount(), msgsBefore))

    console.log('④ 游标推进：')
    now = 3_000_000
    await memoryMaybeExtract(root, 'S1')
    await memoryMaybeExtract(root, 'S1')
    check('无新增消息时重复触发不再提取', () => assert.equal(completeCalls, 2))

    console.log('⑤ no-op 纪律（不调工具纯收尾）：')
    now = 3_100_000
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S1', 't5', n)
    const memBefore5 = await memRowCount()
    installFake({ text: '' })
    await memoryMaybeExtract(root, 'S1')
    check('单轮收敛（无工具轮）', () => assert.equal(completeCalls, 1))
    await checkAsync('no-op 不产生任何记忆行', async () => assert.equal(await memRowCount(), memBefore5))
    await checkAsync('空摘要不动已有摘要', async () =>
      assert.equal(await sessionSummary(root, 'S1'), 'S1 阶段进展：确定包管理器与部署约定'))

    console.log('⑥ 纯文本收尾（婉拒场景）：正文即摘要，无记忆条目，游标推进：')
    now = 3_200_000
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S1', 't6', n)
    installFake({ text: '都是一次性任务细节，无长期可记内容' })
    const memBefore6 = await getDb().then((db) => db
      .prepare("SELECT COUNT(*) AS n FROM mem_items WHERE category != 'summary'").get()) as { n: number }
    await memoryMaybeExtract(root, 'S1')
    check('纯文本收尾不炸不挂（单轮）', () => assert.equal(completeCalls, 1))
    await checkAsync('无记忆条目（summary 除外）、summary 落盘、游标推进（下轮不重复）', async () => {
      const db = await getDb()
      const after = await db
        .prepare("SELECT COUNT(*) AS n FROM mem_items WHERE category != 'summary'").get() as { n: number }
      assert.equal(after.n, memBefore6.n, '婉拒不产生记忆条目')
      assert.equal(await sessionSummary(root, 'S1'), '都是一次性任务细节，无长期可记内容')
      await memoryMaybeExtract(root, 'S1')
      assert.equal(completeCalls, 1, '游标已推进，重复触发不再提取')
    })

    console.log('⑦ 收尾提取 + 游标作废幂等（会话 S2）：')
    await memoryMaybeExtract(root, 'S2') // 首见：游标落 0
    for (let n = 1; n <= 2; n++) await appendTurn(root, 'S2', 's2', n) // 2 轮，低于阈值
    installFake({ text: 'S2 做了环境搭建' })
    await sessionEnded(root, 'S2')
    check('收尾无视阈值，提取一次', () => assert.equal(completeCalls, 1))
    await checkAsync('收尾摘要落库', async () => assert.equal(await sessionSummary(root, 'S2'), 'S2 做了环境搭建'))
    await sessionEnded(root, 'S2')
    check('重复 session_ended 幂等（游标已作废）', () => assert.equal(completeCalls, 1))
    await appendTurn(root, 'S2', 's2', 3)
    await memoryMaybeExtract(root, 'S2')
    check('作废后重建游标（首见基线 0，历史 3 轮低于阈值不触发）', () => assert.equal(completeCalls, 1))

    console.log('⑧ summary last-write-wins：')
    now = 4_000_000
    for (let n = 4; n <= 9; n++) await appendTurn(root, 'S2', 's2b', n)
    installFake({ text: 'S2 新摘要（覆盖版）' })
    await memoryMaybeExtract(root, 'S2')
    await checkAsync('滚动摘要被新值覆盖', async () =>
      assert.equal(await sessionSummary(root, 'S2'), 'S2 新摘要（覆盖版）'))
    await checkAsync('旧摘要 archived、active 恰一条', async () => {
      const db = await getDb()
      const rows = await db
      .prepare(
        "SELECT status, content FROM mem_items WHERE project_key = ? AND session_id = 'S2' AND category = 'summary'",
      )
      .all(projectKey(root)) as { status: string; content: string }[]
      assert.equal(rows.length, 2)
      assert.equal(rows.filter((r) => r.status === 'active').length, 1)
      assert.equal(rows.find((r) => r.status === 'active')?.content, 'S2 新摘要（覆盖版）')
      assert.equal(rows.filter((r) => r.status === 'archived').length, 1)
    })

    console.log('⑨ note_lesson 去重强化：')
    await noteLesson(root, 'S1', { title: '端口 5173 被占用', content: '排查记录 v1' })
    await checkAsync('首次创建 short lesson（importance 0.5）', async () => {
      const db = await getDb()
      const rows = await db
        .prepare("SELECT * FROM mem_items WHERE project_key = ? AND category = 'lesson' AND title = ?")
        .all(projectKey(root), '端口 5173 被占用') as { tier: string; session_id: string | null; importance: number }[]
      assert.equal(rows.length, 1)
      assert.equal(rows[0].tier, 'long') // 教训恒 long：落 short 会被 30 天自动归档扔进坟场
      assert.equal(rows[0].session_id, 'S1')
      assert.equal(rows[0].importance, 0.5)
    })
    for (const v of ['v2', 'v3', 'v4', 'v5', 'v6', 'v7']) {
      await noteLesson(root, 'S1', { title: '端口 5173 被占用', content: `排查记录 ${v}` })
    }
    await checkAsync('同 title 重复上报：不新建、正文更新、importance 封顶 1', async () => {
      const db = await getDb()
      const rows = await db
        .prepare("SELECT content, importance FROM mem_items WHERE project_key = ? AND category = 'lesson' AND title = ?")
        .all(projectKey(root), '端口 5173 被占用') as { content: string; importance: number }[]
      assert.equal(rows.length, 1)
      assert.equal(rows[0].content, '排查记录 v7')
      assert.equal(rows[0].importance, 1.0)
    })
    await noteLesson(root, 'S1', { title: '另一个教训', content: 'x' })
    await checkAsync('不同 title 照常新建', async () => {
      const db = await getDb()
      const n = (await db.prepare("SELECT COUNT(*) AS n FROM mem_items WHERE category = 'lesson'").get() as { n: number }).n
      assert.equal(Number(n), 2)
    })

    console.log('⑩ run_now：无视冷却 + 并发防护：')
    const rNone = await memoryRunNow(root2)
    check('无活跃会话 → ok=false 带错误', () => {
      assert.equal(rNone.ok, false)
      assert.match(rNone.error ?? '', /无活跃会话/)
    })
    now = 4_010_000 // 距上次提取仅 10s，冷却未过——run_now 必须无视
    for (let n = 10; n <= 15; n++) await appendTurn(root, 'S2', 's2c', n)
    let release!: () => void
    // 门外先备好 deferred：release 若在 provider 进门后才捕获，晚到的 release?.() 会空跑 → await first 永久挂起
    const gate = new Promise<void>((resolve) => { release = resolve })
    installFake({ text: '' }, { gate })
    const first = memoryRunNow(root)
    await sleep(30) // 让首个任务进入门
    const second = await memoryRunNow(root)
    check('提取中再触发 run_now 被并发防护拒绝', () => {
      assert.equal(second.ok, false)
      assert.match(second.error ?? '', /进行中/)
    })
    release()
    const firstResult = await first
    check('run_now ok=true（无视冷却）', () => assert.equal(firstResult.ok, true))
    check('并发触发合并：只跑一次', () => assert.equal(completeCalls, 1))

    console.log('⑪ 嵌入模型指纹（P1 遗留修复②）：')
    const dbFp = await getDb()
    const readFp = async (): Promise<string | undefined> =>
      (await dbFp.prepare("SELECT value FROM meta WHERE key = 'embed_model_fingerprint'").get() as { value: string } | undefined)?.value
    const fp = await readFp()
    check('首嵌已写入指纹（模型id|维度）', () => {
      assert.ok(fp)
      assert.match(fp as string, /\|\d+$/)
    })
    await dbFp.prepare("UPDATE meta SET value = 'other-model|999' WHERE key = 'embed_model_fingerprint'").run()
    const d1 = await memorySearch('部署流程约定', root)
    check('指纹不符 → 向量路停用（degraded=true）', () => assert.equal(d1.degraded, true))
    check('指纹不符时关键词路不受影响', () => assert.ok(d1.hits.length >= 1))
    await dbFp.prepare('UPDATE meta SET value = ? WHERE key = ?').run(fp, 'embed_model_fingerprint')
    const d2 = await memorySearch('部署流程约定', root)
    check('指纹恢复 → 向量路恢复（degraded=false）', () => assert.equal(d2.degraded, false))

    console.log('⑫ 迁移中断接管（P1 遗留修复①）：')
    const configWrites: (string | null)[] = []
    setConfigWriter(async (d) => {
      configWrites.push(d)
    })
    const rowsBefore = (await messagesRecent(root)).total
    const dirTR = mkdtempSync(path.join(os.tmpdir(), 'qyris-takeover-tr-'))
    extraDirs.push(dirTR)
    writeFileSync(path.join(dirTR, 'qyris.db'), 'occupied', 'utf8')
    await checkAsync('源库非空 → 目标非空库仍拒绝覆盖', async () => {
      const r = await migrateDataDir(dirTR)
      assert.equal(r.ok, false)
      assert.match(r.error ?? '', /非空/)
    })

    // 场景 A：源库缺失（上次迁移已搬走 db 但未写 config）→ 接管
    const dirTA = mkdtempSync(path.join(os.tmpdir(), 'qyris-takeover-ta-'))
    extraDirs.push(dirTA)
    // 必须 await 关库：Worker 还握着文件时 renameSync 直接 EBUSY（Windows 句柄释放滞后）
    await closeDb()
    renameSync(path.join(dir, 'qyris.db'), path.join(dirTA, 'qyris.db'))
    const takeA = await migrateDataDir(dirTA)
    check('源库缺失 → 接管 ok=true', () => assert.equal(takeA.ok, true, takeA.error))
    check('config 写入器收到目标目录', () => assert.equal(configWrites[configWrites.length - 1], path.resolve(dirTA)))
    await checkAsync('dataDir() 已重定向', async () => assert.equal(await dataDir(), path.resolve(dirTA)))
    await checkAsync('接管后消息/记忆行数保留', async () => {
      assert.equal((await messagesRecent(root)).total, rowsBefore)
      assert.ok((await memoryList(root, true)).items.length >= 1)
    })
    check('接管后 sqlite-vec 仍可用', () => assert.equal(vecReadyFlag(), true))

    // 场景 B：源库为空库（messages+mem_items 均 0 行）→ 接管
    const dirTB = mkdtempSync(path.join(os.tmpdir(), 'qyris-takeover-tb-'))
    extraDirs.push(dirTB)
    await closeDb()
    copyFileSync(path.join(dirTA, 'qyris.db'), path.join(dirTB, 'qyris.db')) // 目标 = 现库副本（非空）
    rmSync(path.join(dirTA, 'qyris.db'))
    await initDbAt(dirTA) // 源替换为全 schema 空库（0 行），生产中空库必然带全 schema
    await closeDb()
    const takeB = await migrateDataDir(dirTB)
    check('空库源 → 接管 ok=true', () => assert.equal(takeB.ok, true, takeB.error))
    check('config 写入器收到新目标目录', () => assert.equal(configWrites[configWrites.length - 1], path.resolve(dirTB)))
    await checkAsync('dataDir() 已重定向到接管目标', async () => assert.equal(await dataDir(), path.resolve(dirTB)))
    await checkAsync('接管后数据完整保留', async () => {
      assert.equal((await messagesRecent(root)).total, rowsBefore)
      assert.equal((await sessionSummary(root, 'S2')), 'S2 新摘要（覆盖版）')
    })
    setConfigWriter(null)

    console.log('⑬ 游标持久化 + 首见基线 0（P2 修复回归）：')
    // ⑫ 之后现库在接管目标目录（overrideDir 已重定向）；重开同库 + 清内存态 = 模拟进程重启
    const dbCur = await getDb()
    const savedCursor = await dbCur
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(`mem_cursor:${projectKey(root)}|S2`) as { value: string } | undefined
    check('游标已持久化到 meta 表', () => {
      assert.ok(savedCursor?.value)
      assert.match(savedCursor!.value, /^\d+$/)
    })
    await closeDb()
    await initDbAt(await dataDir())
    resetExtractStateForTest()
    installFake({ text: '' })
    await memoryMaybeExtract(root, 'S2')
    check('重启后游标自 meta 恢复：无新增消息不重复提取', () => assert.equal(completeCalls, 0))
    // 从未蒸馏过的会话（无持久化游标）：首见基线 0，历史 ≥6 轮即触发，首轮内容进转录窗口
    now = 5_000_000
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S3', 's3', n)
    await memoryMaybeExtract(root, 'S3')
    check('无游标会话首见基线 0：6 轮历史即提取', () => assert.equal(completeCalls, 1))
    check('首轮内容不漏（旧实现会把首轮误标为已蒸馏基线）', () => {
      assert.ok(capturedUsers[capturedUsers.length - 1].includes('#1 用户：s3 用户请求 1'))
    })

    console.log('⑭ create 去重护栏（重扫不重复建条）：')
    // S3 游标已在末尾 → run_now 走「重置 0 全量重扫」路径；同题 active 条目（③ 所建）必须折叠
    installFake({
      calls: [{
        name: 'memory_save',
        input: { scope: 'user', category: 'preference', title: '包管理器用 pnpm', content: '重扫后的新表述', importance: 0.9 },
      }],
      text: '',
    })
    now = 5_100_000
    const dup = await memoryRunNow(root)
    await checkAsync('重扫同题 save → 折叠，行数不变', async () => {
      assert.equal(dup.ok, true, dup.error)
      const db = await getDb()
      const rows = await db
        .prepare("SELECT id, content, importance FROM mem_items WHERE project_key = 'global' AND title = '包管理器用 pnpm'")
        .all() as { id: string; content: string; importance: number }[]
      assert.equal(rows.length, 1)
      assert.equal(rows[0].content, '重扫后的新表述')
      assert.equal(rows[0].importance, 0.9) // max(0.8, 0.9)
    })

    console.log('⑮ 转录护栏（最新一条超预算必入选）：')
    // 单条 assistant 挂 120 个工具行（≈12.6k > 12k 预算）：护栏 = 最新一条截断入选，不许整窗漏蒸
    const hugeCalls = Array.from({ length: 120 }, (_, i) => ({
      id: `hc-${i}`, name: 'run_command', args: { command: `cmd-${i} ${'x'.repeat(90)}` }, status: 'done' as const,
    }))
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S4', 's4', n)
    await messagePatch(root, 'S4', 's4-a6', { tool: { toolCalls: hugeCalls } })
    installFake({ text: '' })
    now = 5_200_000
    await memoryMaybeExtract(root, 'S4')
    check('最新一条截断入选，转录非空', () => {
      const u = capturedUsers[capturedUsers.length - 1]
      assert.ok(u.includes('#12 助手：s4 助手回复 6'))
      assert.ok(u.includes('（更早已省略）'))
    })

    console.log('⑯ scope 铁律 + 【当前工程】锚点（串工程污染防线）：')
    // 当前工程 agent-alpha，转录内容讲的是 BetaProject 的事——铁律 3 要求 no-op（不串工程），
    // 并且 prompt 必须带【当前工程】锚点，否则模型无从判定「这是别的工程」
    for (let n = 1; n <= 2; n++) await appendTurn(root, 'S5', 's5', n)
    await messageAppend(root, 'S5', { id: 's5-x', role: 'user', content: 'BetaProject 卡死，排查一下它启动时挂住的问题' })
    installFake({ text: '' })
    now = 5_300_000
    await memoryRunNow(root)
    check('prompt 带【当前工程】锚点（basename）', () => {
      const u = capturedUsers[capturedUsers.length - 1]
      assert.ok(u.includes('【当前工程】agent-alpha'), u.slice(0, 300))
    })
    check('铁律 3 声明串工程 no-op（别的具名工程/两可都不产出）', () => {
      const sys = capturedSystems[capturedSystems.length - 1]
      assert.ok(sys.includes('串工程'), '铁律缺串工程声明')
      assert.ok(/no-op/.test(sys) && sys.includes('两可'), '铁律缺两可 no-op')
    })

    console.log('⑰ 空转录快路径（全空窗口不烧 LLM，游标照常推进）：')
    now = 6_200_000
    const callsBeforeBlank = completeCalls
    for (let n = 1; n <= 6; n++) {
      await messageAppend(root, 'S8', { id: `s8-a${n}`, role: 'assistant', content: '' })
    }
    await memoryMaybeExtract(root, 'S8')
    check('全空窗口不调 provider（无可提取内容）', () => assert.equal(completeCalls, callsBeforeBlank))
    await checkAsync('全空窗口游标照常推进（不空转、不回溯）', async () => {
      const db = await getDb()
      const row = await db.prepare('SELECT value FROM meta WHERE key = ?')
        .get(`mem_cursor:${projectKey(root)}|S8`) as { value: string } | undefined
      const max = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE session_id = ?')
        .get('S8') as { seq: number }
      assert.ok(row, '游标已落盘')
      assert.equal(Number(row!.value), max.seq, '游标 = 窗口末尾')
    })

    console.log('⑱ 蒸馏执行面（write 档 ∩ memory 白名单 = 窄面，无 fs/shell）：')
    await checkAsync('执行面恰为四个 memory 工具', async () => {
      const { toolsForPermission } = await import('../electron/lib/tools')
      const surface = toolsForPermission('write').filter((t) =>
        ['memory_search', 'memory_save', 'memory_update', 'memory_archive'].includes(t.name))
      assert.deepEqual(surface.map((t) => t.name).sort(), ['memory_archive', 'memory_save', 'memory_search', 'memory_update'])
    })

    console.log('⑲ 每轮操作预算 + 显式条目归档拒绝（防幻觉批量清洗）：')
    {
      now = 6_500_000
      for (let n = 1; n <= 6; n++) await appendTurn(root, 'S10', 's10', n)
      // 一轮发 4 个 save（预算 3）：第 4 个应被预算拦截
      installFake({
        calls: [1, 2, 3, 4].map((n) => ({
          name: 'memory_save',
          input: { scope: 'user', category: 'fact', title: `预算条目${n}`, content: `c${n}` },
        })),
        text: '',
      })
      const beforeBudget = (await memoryList(root)).items.filter((i) => i.title.startsWith('预算条目')).length
      await memoryMaybeExtract(root, 'S10')
      await checkAsync('预算 3/轮：第 4 次 save 被拦截，只落 3 条', async () => {
        const after = (await memoryList(root)).items.filter((i) => i.title.startsWith('预算条目'))
        assert.equal(after.length, beforeBudget + 3)
      })
      // 显式条目归档拒绝：蒸馏器调 archive 被保护契约弹回，条目保持活跃
      await memoryCreate({
        projectRoot: root, tier: 'long', category: 'preference',
        title: '用户显式偏好', content: '亲口说的', origin: 'user_explicit',
      })
      now = 6_600_000
      for (let n = 1; n <= 6; n++) await appendTurn(root, 'S11', 's11', n)
      installFake({
        calls: [{ name: 'memory_archive', input: { id: (await memoryList(root)).items.find((i) => i.title === '用户显式偏好')!.id, reason: '蒸馏想清理' } }],
        text: '',
      })
      await memoryMaybeExtract(root, 'S11')
      await checkAsync('蒸馏器归档显式条目被拒（保护契约生效）', async () => {
        const it = (await memoryList(root, true)).items.find((i) => i.title === '用户显式偏好')
        assert.equal(it?.status, 'active', '显式条目仍活跃')
      })
    }

    setEmbedder(null)
    setReadyOverride(null)
    setProviderOverride(null)
    setClock(null)
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
  // sqlite worker 的 MessagePort 在 closeDb 后仍挂事件循环（与 smoke:workspace-tools 同形态），
  // 不显式退出则 npm run 永不收口
  process.exit(0)
}

void main()
