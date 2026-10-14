/**
 * 记忆双轨打分行为基准：合成语料（冷关键/热点噪声/新鲜变体三组受控条目）+ 受控时间戳，
 * 跑真实 memorySearch，断言行为性质——语义相关主轴（冷关键不被新鲜噪声挤出）、时间敏感度有界。
 * 运行：npm run bench:mem-scoring
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { initDbAt, closeDb, getDb } from '../electron/lib/db'
import { memoryCreate, memorySearch, setEmbedder } from '../electron/lib/memory/service'
import { setReadyOverride } from '../electron/lib/memory/embed'
import { memoryActivation } from '../shared/memory-scoring'

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

const DAY = 86_400_000
/** 确定性假嵌入：字符 trigram 词袋 512 维 L2 归一（与 smoke-memory 同款，共享 trigram 的文本向量相近） */
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

/** 时间手术：把条目的三个时间列统一拨到绝对时刻（衰减边界/老化按受控值造） */
async function setTimes(id: string, t: number): Promise<void> {
  const db = await getDb()
  await db.prepare('UPDATE mem_items SET last_accessed_at = ?, created_at = ?, updated_at = ? WHERE id = ?').run(t, t, t, id)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qyris-mem-bench-'))
  const root = 'E:\\fake\\bench'
  try {
    await initDbAt(dir)
    setReadyOverride(true)
    setEmbedder((texts) => Promise.resolve(texts.map(fakeVec)))
    const NOW = Date.now()
    const N = 12

    // ── 语料三组 ──
    // ① 冷关键：imp 0.9、40 天未访问——语义价值高但热度冷（每条绑定专属查询词）
    const coldIds: string[] = []
    const LETTERS = 'ABCDEFGHIJKL'
    for (let i = 0; i < N; i++) {
      const it = await memoryCreate({
        projectRoot: root, tier: 'long', category: 'fact',
        title: `冷关键鉴权令牌轮换${LETTERS[i]}`, content: `冷查${LETTERS[i]} 鉴权令牌轮换的完整约定与例外场景`, importance: 0.9,
      })
      await setTimes(it.id, NOW - 40 * DAY)
      coldIds.push(it.id)
    }
    // ② 热点噪声：imp 0.3、命中 50 次、1 天前访问——热度满格但语义价值低（不含冷查词，不相关）
    for (let i = 1; i <= N; i++) {
      const it = await memoryCreate({
        projectRoot: root, tier: 'long', category: 'fact',
        title: `热点噪声条目${i}`, content: `热点噪声内容${i} 与鉴权完全无关`, importance: 0.3,
      })
      const db = await getDb()
      await db.prepare('UPDATE mem_items SET access_count = 50, last_accessed_at = ?, updated_at = ? WHERE id = ?').run(NOW - DAY, NOW - DAY, it.id)
      void it
    }
    // ③ 新鲜变体：imp 0.5、刚刚写入、正文共享冷查词（与冷关键同题竞争的新鲜条目）
    for (let i = 1; i <= N; i++) {
      for (let j = 1; j <= 3; j++) {
        const it = await memoryCreate({
          projectRoot: root, tier: 'long', category: 'fact',
          title: `新鲜变体${LETTERS[i]}-${j}`, content: `冷查${LETTERS[i]} 的新鲜变体表述${j}`, importance: 0.5,
        })
        await setTimes(it.id, NOW)
        void it
      }
    }

    console.log('G1 语义主轴（冷关键不被新鲜变体挤出 top1）：')
    let coldTop1 = 0
    const newRanks: number[] = []
    for (let i = 0; i < N; i++) {
      const r = await memorySearch(`冷查${LETTERS[i]}`, root)
      const rank = r.hits.findIndex((h) => h.id === coldIds[i]) + 1
      newRanks.push(rank)
      if (rank === 1) coldTop1++
    }
    check(`冷关键 top1 占比 ${coldTop1}/${N}（≥ 80%）`, () => assert.ok(coldTop1 / N >= 0.8))

    console.log('G2 时间敏感度（全体老化 1 天 → top8 排名移动 ≤ 2 名/条）：')
    {
      const before: Record<string, number>[] = []
      for (let i = 0; i < N; i++) {
        const r = await memorySearch(`冷查${LETTERS[i]}`, root)
        before.push(Object.fromEntries(r.hits.slice(0, 8).map((h, idx) => [h.id, idx])))
      }
      const db = await getDb()
      await db.prepare('UPDATE mem_items SET last_accessed_at = last_accessed_at - ?, created_at = created_at - ?, updated_at = updated_at - ?').run(DAY, DAY, DAY)
      let totalMove = 0
      let counted = 0
      for (let i = 0; i < N; i++) {
        const r = await memorySearch(`冷查${LETTERS[i]}`, root)
        const after = Object.fromEntries(r.hits.slice(0, 8).map((h, idx) => [h.id, idx]))
        for (const [id, bIdx] of Object.entries(before[i])) {
          const aIdx = after[id] ?? 8
          totalMove += Math.abs(aIdx - bIdx)
          counted++
        }
      }
      const avg = counted > 0 ? totalMove / counted : 0
      check(`平均排名移动 ${avg.toFixed(2)} 名/天（≤ 2；旧模型 recency 斜率折算 ≫ 10）`, () => assert.ok(avg <= 2))
    }

    console.log('G3 热点噪声不夺位（冷关键自身查询里，满格热度低价值条目不进 top3）：')
    {
      let clean = 0
      for (let i = 0; i < N; i++) {
        const r = await memorySearch(`冷查${LETTERS[i]}`, root)
        const top3 = r.hits.slice(0, 3)
        if (!top3.some((h) => h.title.startsWith('热点噪声'))) clean++
      }
      check(`top3 无热点噪声的查询 ${clean}/${N}（= 100%）`, () => assert.equal(clean, N))
    }

    console.log('G4 半衰期行为抽查（event 7d / preference 90d，同访问档案 60 天老化）：')
    {
      const t = NOW - 60 * DAY
      const ev = memoryActivation(0, t, t, 'event', NOW)
      const pf = memoryActivation(0, t, t, 'preference', NOW)
      check(`event 60d 热度 ≈ 0（${ev.toFixed(3)}），preference 仍存 ${(pf).toFixed(3)}`, () => {
        assert.ok(ev < 0.01 && pf > 0.1, `event 热度耗尽而 preference 尚存（s(0)=0.25 起始热度，0.157≈0.25×2^(-60/90) 为公式正确值）`)
      })
      check('饱和函数：n=100 热度 < 1（马太效应封顶）', () => {
        const hot = memoryActivation(100, NOW, NOW, 'fact', NOW)
        assert.ok(hot < 1 && hot > 0.9)
      })
    }

    setEmbedder(null)
    setReadyOverride(null)
  } finally {
    await closeDb()
    rmSync(dir, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.error(`\n${failures} 项门禁失败`)
    process.exit(1)
  }
  console.log('\n全部门禁通过（合成语料；真实数据校准待有日志后做生存分析）')
  process.exit(0)
}

void main().catch((e) => {
  console.error('bench 崩溃：', e)
  process.exit(1)
})
