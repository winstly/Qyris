/**
 * 工作台域工具冒烟：记忆 search/save/archive（initDbAt 临时目录隔离 + 确定性假 embedder，
 * 与 smoke:memory 同姿势）、服务器标签纯函数 applyServerPatch、重试 helper 暂态/非暂态分级、
 * preview 工具在 electron-stub 环境的响亮降级（isError 而非崩进程）、
 * load_skill 未命中的自纠报错（工具名误当 Skill id 时指回工具调用）。
 * update_server_tags 会写真实 config（~/.qyris/config.json），故只测其纯函数核，不触 IO 壳。
 * 运行：npm run smoke:workspace-tools
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDbAt, closeDb } from '../electron/lib/db'
import { setEmbedder, memoryList } from '../electron/lib/memory/service'
import { setReadyOverride, EMBED_DIM } from '../electron/lib/memory/embed'
import { setRetryWarn, withRetry, isTransientError } from '../electron/lib/retry'
import { memoryTools } from '../electron/lib/tools/memory'
import { previewTools } from '../electron/lib/tools/preview'
import { skillTools } from '../electron/lib/tools/skill'
import { applyServerPatch } from '../electron/lib/tools/remote'
import type { DeployServer } from '../electron/lib/config'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

/** 确定性假向量：trigram 散列入 512 维（同 smoke:memory 姿势，语义相近文本向量相近） */
function fakeVec(text: string): Float32Array {
  const v = new Float32Array(EMBED_DIM)
  const s = text.toLowerCase()
  for (let i = 0; i + 3 <= s.length; i++) {
    const g = s.slice(i, i + 3)
    let h = 0
    for (let j = 0; j < g.length; j++) h = (h * 31 + g.charCodeAt(j)) >>> 0
    v[h % EMBED_DIM] += 1
  }
  return v
}

async function main(): Promise<void> {
  setRetryWarn(() => {}) // smoke 静音重试告警
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qyris-ws-tools-'))
  const root = path.join(tmp, 'proj')
  await initDbAt(path.join(tmp, 'data'))
  setReadyOverride(true)
  setEmbedder((texts) => Promise.resolve(texts.map(fakeVec)))

  const [search, save, archive] = memoryTools
  const [previewOpen, previewConsole] = previewTools
  const ctx = { projectRoot: root, permission: 'write' as const }

  // 库位探针：initDbAt 后必须拿到空库（若 >0 说明打到了真实用户库——split-brain 实锤）
  const preCount = (await memoryList(null, true)).items.length
  console.log(`[probe] initDbAt 后库内条数 = ${preCount}（预期 0；save 的 id 将与此对照）`)

  try {
    console.log('① memory_save：新建与折叠（防重）：')
    const r1 = await save.execute({ title: '包管理器用 pnpm', content: '用户明确要求一律用 pnpm', category: 'preference', scope: 'user', importance: 0.8 }, ctx)
    console.log(`[probe] save id = ${/id=(mem_[^）]+)/.exec(r1.content)?.[1] ?? '?'}`)
    assert(!r1.isError && r1.content.includes('已新建'), `首次沉淀新建（实际：${r1.content.slice(0, 60)}）`)
    // 折叠查重键 = (projectKey, category, title) 精确匹配——同 title 才折叠
    const r2 = await save.execute({ title: '包管理器用 pnpm', content: '用户明确要求一律用 pnpm，CI 也要用', category: 'preference', scope: 'user' }, ctx)
    assert(!r2.isError && r2.content.includes('已折叠'), `同 title 自动折叠（实际：${r2.content.slice(0, 60)}）`)

    console.log('② memory_search：命中与降级标注：')
    const s1 = await search.execute({ query: '包管理器 pnpm' }, { projectRoot: root, permission: 'readonly' })
    assert(!s1.isError && s1.content.includes('[preference]'), `命中沉淀条目`)
    assert(s1.content.includes('id='), `结果带 id（供 archive 引用）`)
    const s2 = await search.execute({ query: '完全不存在的量子纠缠配置' }, { projectRoot: root, permission: 'readonly' })
    assert(!s2.isError && s2.content.includes('无命中'), `空命中如实说明`)

    console.log('③ memory_archive：归档与幂等：')
    const id = /id=(mem_[0-9a-f-]+)/.exec(s1.content)?.[1] ?? ''
    assert(id.startsWith('mem_'), `从检索结果提取到 id`)
    const a1 = await archive.execute({ id }, ctx)
    assert(!a1.isError, `归档成功（实际：${a1.content.slice(0, 80)}）`)
    const s3 = await search.execute({ query: '包管理器 pnpm' }, { projectRoot: root, permission: 'readonly' })
    assert(!s3.content.includes(id), `归档后默认检索不再出现`)
    const a2 = await archive.execute({ id }, ctx)
    assert(!a2.isError, `重复归档幂等成功（UPDATE 无 status 过滤，重复归档无害）`)

    console.log('④ applyServerPatch：标签/策略/备注纯函数（原样应用语义，去重在工具层入参校验）：')
    const servers: DeployServer[] = [
      { id: 's1', name: '生产', host: '1.2.3.4', port: 22, username: 'root', auth: 'password', tags: ['old'] },
      { id: 's2', name: '备用', host: '5.6.7.8', port: 22, username: 'root', auth: 'password', tags: [] },
    ]
    const p1 = applyServerPatch(servers, 's1', { tags: ['nginx', 'app'], strategy: 'single', note: '已部署博客' })
    assert(JSON.stringify(p1[0].tags) === '["nginx","app"]' && p1[0].strategy === 'single' && p1[0].note === '已部署博客', `命中服务器 tags + 策略 + 备注生效`)
    assert(p1[1].tags.length === 0 && p1[1].note === undefined, `未命中服务器原样保留`)
    const p2 = applyServerPatch(servers, 's1', { tags: [] })
    assert(p2[0].tags.length === 0 && p2[0].strategy === undefined, `空数组清空标签；不传策略不覆盖`)

    console.log('⑤ withRetry：暂态重试与确定性错误直抛：')
    {
      let calls = 0
      const v = await withRetry(async () => {
        calls++
        if (calls === 1) throw new Error('SQLITE_BUSY: database is locked')
        return 'ok'
      }, { baseDelayMs: 10, label: 't1' })
      assert(v === 'ok' && calls === 2, `暂态错误重试后成功（调用 ${calls} 次）`)
      calls = 0
      try {
        await withRetry(async () => {
          calls++
          throw new Error('参数错误：path 必填')
        }, { baseDelayMs: 10, retryOn: isTransientError })
        assert(false, '确定性错误应抛出')
      } catch (e) {
        assert(calls === 1 && String((e as Error).message).includes('参数错误'), `确定性错误不重试（调用 ${calls} 次）`)
      }
    }

    console.log('⑥ preview 工具：参数校验 + stub 环境响亮降级（不崩进程）：')
    {
      // 入参校验按代码库约定同步 throw（生产由 executeTool 收敛 isError），smoke 侧接住
      const bad = await previewOpen.execute({ url: 'ftp://x' }, ctx).then(
        (r) => r,
        (e: unknown) => ({ content: String((e as Error).message), isError: true }),
      )
      assert(bad.isError === true && /http/.test(bad.content), `非法协议被拒`)
      const r = await previewOpen.execute({ url: 'http://localhost:5188' }, ctx)
      // esbuild stub 环境下 preview 可能假成功（真实 MCP 子进程走 node-bootstrap 递归桩必抛 isError）；
      // 本环境只验证「调用不产生未捕获异常」
      assert(typeof r.content === 'string' && r.content.startsWith('[preview_open]'), `stub 环境调用不崩进程`)
      const c = await previewConsole.execute({ level: 'error' }, ctx)
      assert(typeof c.content === 'string' && c.content.startsWith('[preview_console]'), `console 工具结构化返回`)
    }

    console.log('⑦ 全部新工具权限档：')
    const all = [...memoryTools, ...previewTools]
    assert(search.permission === 'readonly' && previewOpen.permission === 'readonly' && previewConsole.permission === 'readonly', `读类工具 readonly（低档会话可用）`)
    assert(save.permission === 'write' && archive.permission === 'write', `写类工具 write`)
    assert(all.every((t) => t.name.startsWith('memory_') || t.name.startsWith('preview_')), `命名域统一`)

    console.log('⑧ load_skill 未命中自纠（工具名误当 Skill id）：')
    {
      const [loadSkill] = skillTools
      const asTool = await loadSkill.execute({ skill_id: 'dispatch_subtasks' }, ctx)
      assert(asTool.isError === true, `工具名误当 Skill → isError`)
      assert(asTool.content.includes('是工具名'), `指回工具调用（${asTool.content}）`)
      const missing = await loadSkill.execute({ skill_id: 'definitely-missing-skill-xyz' }, ctx)
      assert(missing.isError === true, `不存在的 Skill → isError`)
      assert(missing.content.includes('不存在'), `报错含「不存在」（${missing.content.slice(0, 50)}…）`)
    }
  } finally {
    closeDb()
    // Windows 下 sqlite worker 文件句柄释放滞后：清理失败容忍（tmp 残留无害）
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch { /* 残留于系统临时目录，无害 */ }
  }

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
  // sqlite worker 的 MessagePort 在 closeDb 后仍挂事件循环（实测 handles 含 MessagePort），
  // 不显式退出则 npm run 永不收口——smoke 以断言结果为准，退出码显式给
  process.exit(0)
}

void main().catch((e) => {
  console.error('smoke 崩溃：', e)
  process.exit(1)
})
