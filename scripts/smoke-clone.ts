/**
 * 批量克隆冒烟：并行 cloneRepos 的结果契约（逐仓成败互不影响）、进度事件终态、
 * 目标重名预校验、取消语义。用本地真实 git 仓库当源（不走网络、不 mock git）。
 * 运行：npm run smoke:clone
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { cloneRepos, cancelClones } from '../electron/lib/project-create'
import type { CloneProgress } from '../shared/ipc-types'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'ignore' })
}

/** 建一个含 fileCount 个小文件的本地 git 仓库，返回路径（clone 的源） */
function makeSrcRepo(root: string, name: string, fileCount: number): string {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  sh('git init -b main', dir)
  sh('git config user.email t@t.local', dir)
  sh('git config user.name t', dir)
  for (let i = 0; i < fileCount; i++) writeFileSync(path.join(dir, `f${i}.txt`), `content-${i}\n`)
  sh('git add -A && git commit -m init', dir)
  return dir
}

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qyris-clone-smoke-'))
  const src = path.join(root, 'src')
  mkdirSync(src)
  try {
    // 三个源仓库：各 800 文件，checkout 有可测的耗时，便于观察并发重叠
    const r1 = makeSrcRepo(src, 'alpha', 800)
    const r2 = makeSrcRepo(src, 'beta', 800)
    const r3 = makeSrcRepo(src, 'gamma', 800)

    // ── 1. 三仓并行：全部成功 + 每仓事件含终态 ──
    const events: CloneProgress[] = []
    const t0 = Date.now()
    const res = await cloneRepos(path.join(root, 'out1'), [{ url: r1 }, { url: r2 }, { url: r3 }], {
      onProgress: (p) => events.push({ ...p }),
    })
    const elapsed = Date.now() - t0
    assert(res.cloned.length === 3 && res.failed.length === 0, '三仓全部成功')
    assert(res.cloned.every((p) => existsSync(path.join(p, '.git'))), '三个目标目录都是 git 仓库')
    const doneIdx = new Set(events.filter((e) => e.state === 'done').map((e) => e.index))
    assert(doneIdx.size === 3, '每仓都收到 done 终态事件')
    assert(events.some((e) => e.state === 'cloning'), '有 cloning 进度事件')
    // 并发证据：同一时刻在克隆的仓库数峰值 ≥2（各仓 start→done 区间有重叠）
    const openAt = new Map<number, number>()
    let maxInflight = 0
    for (const e of events) {
      if (e.state === 'cloning' && !openAt.has(e.index)) openAt.set(e.index, Date.now())
      if (e.state === 'done' || e.state === 'error') openAt.delete(e.index)
      maxInflight = Math.max(maxInflight, openAt.size)
    }
    assert(maxInflight >= 2, `并行执行（峰值同时克隆 ${maxInflight} 个）`)
    console.log(`  info 三仓并行耗时 ${elapsed}ms`)

    // ── 2. 部分失败：坏地址不影响其余仓库 ──
    const res2 = await cloneRepos(path.join(root, 'out2'), [
      { url: r1 },
      { url: path.join(src, 'does-not-exist') },
      { url: r2 },
    ])
    assert(res2.cloned.length === 2, '两仓成功')
    assert(res2.failed.length === 1 && res2.failed[0].index === 1, '坏地址的那仓单独失败（index=1）')
    assert(!!res2.failed[0].error, '失败带错误文案')

    // ── 3. 目标目录名重复：开跑前拦截（并行写同一目录=写坏） ──
    let dupErr = ''
    try {
      await cloneRepos(path.join(root, 'out3'), [
        { url: r1 },
        { url: path.join(src, 'alpha') }, // 同名 alpha
      ])
    } catch (e) {
      dupErr = String(e)
    }
    assert(/仓库名重复/.test(dupErr), `重名预校验拦截：${dupErr || '未拦截'}`)

    // ── 4. 取消：以「克隆已取消」收场，不静默吞 ──
    let cancelErr = ''
    const cancelP = cloneRepos(path.join(root, 'out4'), [{ url: r1 }, { url: r2 }, { url: r3 }])
    cancelClones()
    try {
      await cancelP
    } catch (e) {
      cancelErr = String(e)
    }
    assert(/克隆已取消/.test(cancelErr), `取消语义：${cancelErr || '未抛取消'}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} 个断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
