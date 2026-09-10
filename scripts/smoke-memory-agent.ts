/**
 * mem agent 记忆蒸馏管线冒烟测试：LLM mock（setLlmHook）+ 假时钟（setClock）+ 假 embedder 离线全链路。
 * 覆盖：
 *   ① 增量提取 create/patch/archive/summary 全生效 + prompt 组装断言 + 防自食（messages 表零写入）
 *   ② no-op 纪律（空 ops 不产生行）与 code fence 剥除
 *   ③ 非法 JSON 按 no-op
 *   ④ 游标推进（重复 maybe_extract 不重复提取）
 *   ⑤ 6 轮阈值与 60s 冷却（时间注入可测）
 *   ⑥ 收尾提取 + 游标作废幂等
 *   ⑦ summary last-write-wins（旧摘要 archived）
 *   ⑧ note_lesson 去重强化路径
 *   ⑨ run_now：无视冷却 + 并发防护 + 无活跃会话报错
 *   ⑩ parseAgentJson 直测（非法 op 剔除 / importance 收敛 / 围栏剥除）
 *   ⑪ 嵌入模型指纹不符 → 向量路停用（P1 遗留修复②）
 *   ⑫ 迁移中断接管（P1 遗留修复①：源库缺失 / 空库源 → 接管；源库非空仍拒绝）
 *   ⑭ 游标持久化（meta 表跨重启恢复）/ 无游标会话基线 0（首轮内容不漏，P2 修复回归）
 *   ⑮ create 去重护栏（重扫同题折叠为 patch，不产生重复行）
 *   ⑯ 转录护栏（最新一条超预算截断入选，游标不空转）
 * 运行：npm run smoke:memory-agent
 */
import { mkdtempSync, rmSync, existsSync, copyFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { initDbAt, closeDb, dataDir, getDb, projectKey, vecReadyFlag } from '../electron/lib/db'
import { messageAppend, messagePatch, messagesRecent } from '../electron/lib/messages'
import {
  memoryCreate, memoryList, memorySearch, sessionSummary, noteLesson, setEmbedder,
} from '../electron/lib/memory/service'
import { setReadyOverride } from '../electron/lib/memory/embed'
import {
  SYSTEM_PROMPT, setLlmHook, setClock, memoryMaybeExtract, sessionEnded, memoryRunNow, parseAgentJson,
  resetExtractStateForTest,
} from '../electron/lib/memory/agent'
import { setConfigWriter, migrateDataDir } from '../electron/lib/migrate'

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
    for (let i = 0; i < v.length; i++) v[i] *= inv
  }
  return v
}

// ---------- LLM mock：记录器 + 可切换回复 ----------

let hookCalls: { system: string; user: string }[] = []
let hookReply = '{"ops":[],"summary":null}'

function installRecorder(): void {
  setLlmHook(async (system, user) => {
    hookCalls.push({ system, user })
    return hookReply
  })
}

const NOOP = '{"ops":[],"summary":null}'

async function main(): Promise<void> {
  const root = 'E:\\fake\\agent-alpha'
  const root2 = 'E:\\fake\\agent-beta'
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qyris-agent-smoke-'))
  const extraDirs: string[] = [] // 迁移接管段临时目录，finally 统一清理
  installRecorder()
  try {
    console.log('① 初始化：')
    initDbAt(dir)
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
    check('5 轮 assistant 未达 6 轮阈值 → 不提取', () => assert.equal(hookCalls.length, 0))
    await appendTurn(root, 'S1', 't1', 6)
    await memoryMaybeExtract(root, 'S1')
    check('第 6 轮 assistant 达阈值 → 提取一次（no-op）', () => assert.equal(hookCalls.length, 1))
    now = 1_030_000 // 距上次提取 30s
    for (let n = 7; n <= 12; n++) await appendTurn(root, 'S1', 't1', n)
    await memoryMaybeExtract(root, 'S1')
    check('冷却中（30s < 60s）→ 不提取', () => assert.equal(hookCalls.length, 1))
    now = 1_061_000 // 距上次提取 61s
    await memoryMaybeExtract(root, 'S1')
    check('冷却过（61s ≥ 60s）→ 提取', () => assert.equal(hookCalls.length, 2))

    console.log('③ 增量提取全生效（create/patch/archive/summary）：')
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
    hookReply = JSON.stringify({
      ops: [
        { op: 'create', tier: 'long', category: 'preference', title: '包管理器用 pnpm', content: '用户明确要求一律用 pnpm', importance: 0.8, sources: ['#25'] },
        { op: 'patch', targetId: m1.id, content: '部署流程约定（已合并 pnpm 偏好）', reason: '同主题合并' },
        { op: 'archive', targetId: m2.id, reason: '已过时' },
      ],
      summary: 'S1 阶段进展：确定包管理器与部署约定',
    })
    await memoryMaybeExtract(root, 'S1')
    check('LLM 恰被调用一次', () => assert.equal(hookCalls.length, 3))
    check('系统提示 = agent 纪律条款常量', () => assert.equal(hookCalls[2].system, SYSTEM_PROMPT))
    const user = hookCalls[2].user
    check('prompt 含增量转录节与消息行', () => {
      assert.ok(user.includes('【增量转录】'))
      assert.ok(user.includes('#25 用户：t3 用户请求 1'))
      assert.ok(user.includes('#26 助手：t3 助手回复 1'))
    })
    check('prompt 工具一行摘要：只取 command 第一行，不付工具结果 token', () => {
      assert.ok(user.includes('工具 run_command：pnpm install --frozen-lockfile'))
      assert.ok(!user.includes('echo done'))
    })
    check('prompt 含现有记忆清单（long + 本会话 short，带 id 供 patch/archive 定位）', () => {
      assert.ok(user.includes('【现有记忆清单】'))
      assert.ok(user.includes(`- [fact] 部署流程约定（${m1.id}）`))
      assert.ok(user.includes(`- [skill] 过时技巧（${m2.id}）`))
    })
    await checkAsync('create op 生效（tier/category/importance/sources）', async () => {
      const item = (await memoryList(root)).items.find((i) => i.title === '包管理器用 pnpm')
      assert.ok(item)
      assert.equal(item.tier, 'long')
      assert.equal(item.category, 'preference')
      assert.equal(item.projectKey, 'global') // preference 类恒 user
      assert.equal(item.importance, 0.8)
      assert.ok(item.sourceJson?.includes('#25'))
      assert.equal(item.sessionId, null) // long 层不挂 session
    })
    await checkAsync('patch op 生效（按 targetId 更新正文）', async () => {
      const item = (await memoryList(root, true)).items.find((i) => i.id === m1.id)
      assert.equal(item?.content, '部署流程约定（已合并 pnpm 偏好）')
    })
    await checkAsync('archive op 生效（status=archived）', async () => {
      const item = (await memoryList(root, true)).items.find((i) => i.id === m2.id)
      assert.equal(item?.status, 'archived')
    })
    await checkAsync('summary 落为该 session 的 active 摘要', async () =>
      assert.equal(await sessionSummary(root, 'S1'), 'S1 阶段进展：确定包管理器与部署约定'))
    await checkAsync('防自食：提取前后 messages 行数一致（agent 不写 messages 表）', async () =>
      assert.equal(await messageCount(), msgsBefore))

    console.log('④ 游标推进：')
    now = 3_000_000
    await memoryMaybeExtract(root, 'S1')
    await memoryMaybeExtract(root, 'S1')
    check('无新增消息时重复触发不再提取', () => assert.equal(hookCalls.length, 3))

    console.log('⑤ no-op 纪律 + code fence：')
    now = 3_100_000
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S1', 't5', n)
    const memBefore5 = await memRowCount()
    hookReply = '```json\n{"ops":[],"summary":null}\n```'
    await memoryMaybeExtract(root, 'S1')
    check('围栏包裹的空 ops 正常解析执行', () => assert.equal(hookCalls.length, 4))
    await checkAsync('no-op 不产生任何记忆行', async () => assert.equal(await memRowCount(), memBefore5))
    await checkAsync('summary=null 不动已有摘要', async () =>
      assert.equal(await sessionSummary(root, 'S1'), 'S1 阶段进展：确定包管理器与部署约定'))

    console.log('⑥ 非法 JSON 按 no-op：')
    now = 3_200_000
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S1', 't6', n)
    hookReply = '这段对话都是一次性任务细节，没什么值得长期记住的。'
    const memBefore6 = await memRowCount()
    await memoryMaybeExtract(root, 'S1')
    check('纯文本回复不炸不挂', () => assert.equal(hookCalls.length, 5))
    await checkAsync('非法 JSON 不产生记忆行且游标推进（下轮不重复）', async () => {
      assert.equal(await memRowCount(), memBefore6)
      await memoryMaybeExtract(root, 'S1')
      assert.equal(hookCalls.length, 5)
    })

    console.log('⑦ 收尾提取 + 游标作废幂等（会话 S2）：')
    await memoryMaybeExtract(root, 'S2') // 首见：游标落 0
    for (let n = 1; n <= 2; n++) await appendTurn(root, 'S2', 's2', n) // 2 轮，低于阈值
    hookReply = '{"ops":[],"summary":"S2 做了环境搭建"}'
    await sessionEnded(root, 'S2')
    check('收尾无视阈值，提取一次', () => assert.equal(hookCalls.length, 6))
    await checkAsync('收尾摘要落库', async () => assert.equal(await sessionSummary(root, 'S2'), 'S2 做了环境搭建'))
    await sessionEnded(root, 'S2')
    check('重复 session_ended 幂等（游标已作废）', () => assert.equal(hookCalls.length, 6))
    await appendTurn(root, 'S2', 's2', 3)
    await memoryMaybeExtract(root, 'S2')
    check('作废后重建游标（首见基线 0，历史 3 轮低于阈值不触发）', () => assert.equal(hookCalls.length, 6))

    console.log('⑧ summary last-write-wins：')
    now = 4_000_000
    for (let n = 4; n <= 9; n++) await appendTurn(root, 'S2', 's2b', n)
    hookReply = '{"ops":[],"summary":"S2 新摘要（覆盖版）"}'
    await memoryMaybeExtract(root, 'S2')
    await checkAsync('滚动摘要被新值覆盖', async () =>
      assert.equal(await sessionSummary(root, 'S2'), 'S2 新摘要（覆盖版）'))
    await checkAsync('旧摘要 archived、active 恰一条', async () => {
      const db = await getDb()
      const rows = db
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
      const rows = db
        .prepare("SELECT * FROM mem_items WHERE project_key = ? AND category = 'lesson' AND title = ?")
        .all(projectKey(root), '端口 5173 被占用') as { tier: string; session_id: string | null; importance: number }[]
      assert.equal(rows.length, 1)
      assert.equal(rows[0].tier, 'short')
      assert.equal(rows[0].session_id, 'S1')
      assert.equal(rows[0].importance, 0.5)
    })
    for (const v of ['v2', 'v3', 'v4', 'v5', 'v6', 'v7']) {
      await noteLesson(root, 'S1', { title: '端口 5173 被占用', content: `排查记录 ${v}` })
    }
    await checkAsync('同 title 重复上报：不新建、正文更新、importance 封顶 1', async () => {
      const db = await getDb()
      const rows = db
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
    let release: (() => void) | undefined
    const callsBeforeGate = hookCalls.length
    setLlmHook(async (system, user) => {
      hookCalls.push({ system, user })
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return NOOP
    })
    const first = memoryRunNow(root)
    await sleep(30) // 让首个任务进入 LLM 门
    const second = await memoryRunNow(root)
    check('提取中再触发 run_now 被并发防护拒绝', () => {
      assert.equal(second.ok, false)
      assert.match(second.error ?? '', /进行中/)
    })
    release?.()
    const firstResult = await first
    check('run_now ok=true（无视冷却）', () => assert.equal(firstResult.ok, true))
    check('并发触发合并：LLM 只跑一次', () => assert.equal(hookCalls.length, callsBeforeGate + 1))
    installRecorder()

    console.log('⑪ parseAgentJson 直测：')
    check('纯文本 → null', () => assert.equal(parseAgentJson('没有任何 JSON'), null))
    check('残缺 JSON → null', () => assert.equal(parseAgentJson('{"ops":[{"op":"create"'), null))
    const parsed = parseAgentJson(
      '```json\n{"ops":['
      + '{"op":"create","title":"有效","content":"正文","importance":9,"tier":"short","category":"weird"},'
      + '{"op":"create","content":"缺 title"},'
      + '{"op":"patch","content":"缺 targetId"},'
      + '{"op":"archive"},'
      + '{"op":"nope"},'
      + '{"op":"patch","targetId":"mem_x","content":"合并正文","reason":"r"},'
      + '{"op":"archive","targetId":"mem_y","reason":"旧"}'
      + '],"summary":"  "}\n```',
    )
    check('非法 op 剔除、合法保留、importance 收敛、category 兜底', () => {
      assert.ok(parsed)
      assert.equal(parsed!.ops.length, 3)
      const create = parsed!.ops[0]
      assert.equal(create.op, 'create')
      assert.equal((create as { importance: number }).importance, 1)
      assert.equal((create as { category: string }).category, 'fact')
      assert.equal((create as { tier: string }).tier, 'short')
      assert.equal(parsed!.ops[1].op, 'patch')
      assert.equal(parsed!.ops[2].op, 'archive')
    })
    check('空白 summary 归一为 null', () => assert.equal(parsed!.summary, null))

    console.log('⑫ 嵌入模型指纹（P1 遗留修复②）：')
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

    console.log('⑬ 迁移中断接管（P1 遗留修复①）：')
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
    closeDb()
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
    closeDb()
    copyFileSync(path.join(dirTA, 'qyris.db'), path.join(dirTB, 'qyris.db')) // 目标 = 现库副本（非空）
    rmSync(path.join(dirTA, 'qyris.db'))
    initDbAt(dirTA) // 源替换为全 schema 空库（0 行），生产中空库必然带全 schema
    closeDb()
    const takeB = await migrateDataDir(dirTB)
    check('空库源 → 接管 ok=true', () => assert.equal(takeB.ok, true, takeB.error))
    check('config 写入器收到新目标目录', () => assert.equal(configWrites[configWrites.length - 1], path.resolve(dirTB)))
    await checkAsync('dataDir() 已重定向到接管目标', async () => assert.equal(await dataDir(), path.resolve(dirTB)))
    await checkAsync('接管后数据完整保留', async () => {
      assert.equal((await messagesRecent(root)).total, rowsBefore)
      assert.equal((await sessionSummary(root, 'S2')), 'S2 新摘要（覆盖版）')
    })
    setConfigWriter(null)

    console.log('⑭ 游标持久化 + 首见基线 0（P2 修复回归）：')
    // ⑬ 之后现库在接管目标目录（overrideDir 已重定向）；重开同库 + 清内存态 = 模拟进程重启
    const dbCur = await getDb()
    const savedCursor = dbCur
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(`mem_cursor:${projectKey(root)}|S2`) as { value: string } | undefined
    check('游标已持久化到 meta 表', () => {
      assert.ok(savedCursor?.value)
      assert.match(savedCursor!.value, /^\d+$/)
    })
    closeDb()
    initDbAt(await dataDir())
    resetExtractStateForTest()
    const callsBeforeRestart = hookCalls.length
    await memoryMaybeExtract(root, 'S2')
    check('重启后游标自 meta 恢复：无新增消息不重复提取', () => assert.equal(hookCalls.length, callsBeforeRestart))
    // 从未蒸馏过的会话（无持久化游标）：首见基线 0，历史 ≥6 轮即触发，首轮内容进转录窗口
    now = 5_000_000
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S3', 's3', n)
    hookReply = NOOP
    await memoryMaybeExtract(root, 'S3')
    check('无游标会话首见基线 0：6 轮历史即提取', () =>
      assert.equal(hookCalls.length, callsBeforeRestart + 1))
    check('首轮内容不漏（旧实现会把首轮误标为已蒸馏基线）', () => {
      const firstUser = hookCalls[hookCalls.length - 1].user
      assert.ok(firstUser.includes('#1 用户：s3 用户请求 1'))
    })

    console.log('⑮ create 去重护栏（重扫不重复建条）：')
    // S3 游标已在末尾 → run_now 走「重置 0 全量重扫」路径；同题 active 条目（③ 所建）必须折叠为 patch
    hookReply = JSON.stringify({
      ops: [{ op: 'create', tier: 'long', category: 'preference', title: '包管理器用 pnpm', content: '重扫后的新表述', importance: 0.9 }],
      summary: null,
    })
    now = 5_100_000
    const dup = await memoryRunNow(root)
    await checkAsync('重扫同题 create → 折叠为 patch，行数不变', async () => {
      assert.equal(dup.ok, true, dup.error)
      const db = await getDb()
      const rows = db
        .prepare("SELECT id, content, importance FROM mem_items WHERE project_key = 'global' AND title = '包管理器用 pnpm'")
        .all() as { id: string; content: string; importance: number }[]
      assert.equal(rows.length, 1)
      assert.equal(rows[0].content, '重扫后的新表述')
      assert.equal(rows[0].importance, 0.9) // max(0.8, 0.9)
    })

    console.log('⑯ 转录护栏（最新一条超预算必入选）：')
    // 单条 assistant 挂 120 个工具行（≈12.6k > 12k 预算）：旧实现整窗漏蒸且游标照推
    const hugeCalls = Array.from({ length: 120 }, (_, i) => ({
      id: `hc-${i}`, name: 'run_command', args: { command: `cmd-${i} ${'x'.repeat(90)}` },
    }))
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S4', 's4', n)
    await messagePatch(root, 'S4', 's4-a6', { tool: { toolCalls: hugeCalls } })
    hookReply = NOOP
    now = 5_200_000
    await memoryMaybeExtract(root, 'S4')
    check('最新一条截断入选，转录非空', () => {
      const user = hookCalls[hookCalls.length - 1].user
      assert.ok(user.includes('#12 助手：s4 助手回复 6'))
      assert.ok(user.includes('（更早已省略）'))
    })

    console.log('⑰ 非 JSON 容错（尾随逗号/平衡括号 + 带反馈重试 + 游标推进）：')
    check('尾随逗号剥离后解析', () => {
      const p = parseAgentJson('{"ops":[{"op":"create","scope":"user","tier":"long","title":"t","content":"c"},],"summary":null}')
      assert.ok(p)
      assert.equal(p!.ops.length, 1)
      assert.equal(p!.ops[0].title, 't')
      assert.equal((p!.ops[0] as { scope?: string }).scope, 'user')
    })
    check('平衡括号：正文含额外 } 不切错边界', () => {
      const p = parseAgentJson('{"ops":[{"op":"create","title":"t","content":"含 } 括号的正文"}],"summary":null}')
      assert.ok(p)
      assert.equal(p!.ops.length, 1)
      assert.equal((p!.ops[0] as { content: string }).content, '含 } 括号的正文')
    })
    check('preference 类恒 user（覆盖模型误标 project）', () => {
      const p = parseAgentJson('{"ops":[{"op":"create","scope":"project","category":"preference","title":"t","content":"c"}]}')
      assert.ok(p)
      assert.equal(p!.ops.length, 1)
      assert.equal((p!.ops[0] as { scope?: string }).scope, 'user')
    })
    // 带反馈重试 + 游标推进（首答坏 JSON，次答 no-op）
    now = 6_000_000
    const callsBeforeRetry = hookCalls.length
    let badFirst = true
    setLlmHook(async (system, user) => {
      hookCalls.push({ system, user })
      if (badFirst) { badFirst = false; return '{{{broken' }
      return NOOP
    })
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S6', 's6', n)
    await memoryMaybeExtract(root, 'S6')
    check('解析失败 → 带反馈重试一次（LLM 共 2 次）', () => assert.equal(hookCalls.length, callsBeforeRetry + 2))
    check('重试 prompt 含错误反馈与上次坏输出', () => {
      const u = hookCalls[hookCalls.length - 1].user
      assert.ok(u.includes('无法解析为 JSON'))
      assert.ok(u.includes('{{{broken'))
    })
    await checkAsync('重试成功后游标推进（再触发不重提）', async () => {
      await memoryMaybeExtract(root, 'S6')
      assert.equal(hookCalls.length, callsBeforeRetry + 2)
    })
    // 重试耗尽也推进游标（不卡死同一窗口反复烧 token）——修「JSON 解析失败卡死」bug
    now = 6_100_000
    const callsBeforeExhaust = hookCalls.length
    setLlmHook(async (system, user) => {
      hookCalls.push({ system, user })
      return '{{{still-broken'
    })
    for (let n = 1; n <= 6; n++) await appendTurn(root, 'S7', 's7', n)
    await memoryMaybeExtract(root, 'S7')
    check('重试耗尽 → LLM 共 3 次（1 首答 + 2 重试）', () => assert.equal(hookCalls.length, callsBeforeExhaust + 3))
    await checkAsync('重试耗尽后游标推进（再触发不重提，不卡死）', async () => {
      await memoryMaybeExtract(root, 'S7')
      assert.equal(hookCalls.length, callsBeforeExhaust + 3)
    })
    installRecorder()

    setEmbedder(null)
    setReadyOverride(null)
    setLlmHook(null)
    setClock(null)
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
    for (const d of extraDirs) rmSync(d, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
}

void main().catch((e) => {
  console.error('smoke 崩溃：', e)
  process.exit(1)
})
