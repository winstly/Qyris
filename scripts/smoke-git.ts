/**
 * Git 工作区库冒烟测试：对临时真实仓库跑 gitStatus / diff / add / commit / unstage / discard / merge，
 * 覆盖 rename、中文文件名、空格文件名、暂存+工作区双改动、暂存删除、非仓库目录、
 * 合并（快进/幂等/冲突/脏树/引用注入守卫）。
 * 运行：npm run smoke:git
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { gitStatus, gitAdd, gitCommit, gitDiff, gitIsTracked, gitUnstage, gitDiscard, gitMerge, gitChangeLinesLive } from '../electron/lib/git'

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

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qyris-git-smoke-'))
  try {
    sh('git init -b main', dir)
    sh('git config user.email t@t.local', dir)
    sh('git config user.name t', dir)
    writeFileSync(path.join(dir, 'a.txt'), 'one\n')
    writeFileSync(path.join(dir, 'del.txt'), 'gone\n')
    writeFileSync(path.join(dir, 'old.txt'), 'moved\n')
    sh('git add -A && git commit -m init', dir)

    // 场景构造：a.txt=暂存+工作区双改动；中文新增=已暂存；空格名=未跟踪；rename=已暂存；del.txt=暂存删除
    writeFileSync(path.join(dir, 'a.txt'), 'two\n')
    sh('git add a.txt', dir)
    writeFileSync(path.join(dir, 'a.txt'), 'three\n')
    writeFileSync(path.join(dir, '中文新增.md'), '内容\n')
    sh('git add 中文新增.md', dir)
    writeFileSync(path.join(dir, 'with spaces.txt'), 'x\n')
    sh('git mv old.txt renamed.txt', dir)
    rmSync(path.join(dir, 'del.txt'))
    sh('git add del.txt', dir)

    console.log('gitStatus 解析：')
    const st = await gitStatus(dir)
    assert(st.isRepo, 'isRepo=true')
    assert(st.branch === 'main', `branch=main（实际 ${st.branch}）`)
    const find = (p: string) => st.files.find((f) => f.path === p)
    const a = find('a.txt')
    assert(!!a && a.staged && a.unstaged && a.status === 'modified', 'a.txt 暂存+工作区双改动（modified）')
    const cn = find('中文新增.md')
    assert(!!cn && cn.staged && cn.status === 'added', '中文新增.md 已暂存（added）')
    const sp = find('with spaces.txt')
    assert(!!sp && sp.status === 'untracked' && sp.unstaged, '空格文件名未跟踪（untracked）')
    const rn = find('renamed.txt')
    assert(!!rn && rn.status === 'renamed' && rn.renamedFrom === 'old.txt' && rn.staged, 'rename 双路径解析（renamed.txt ← old.txt）')
    const del = find('del.txt')
    assert(!!del && del.status === 'deleted' && del.staged, '暂存删除（deleted）')
    assert(st.files.length === 5, `共 5 条改动（实际 ${st.files.length}）`)

    console.log('gitDiff：')
    const worktreeDiff = await gitDiff(dir, 'a.txt')
    assert(worktreeDiff.includes('-two') && worktreeDiff.includes('+three'), '工作区 diff = index vs worktree（-two +three）')
    const stagedDiff = await gitDiff(dir, 'a.txt', true)
    assert(stagedDiff.includes('-one') && stagedDiff.includes('+two'), '暂存 diff = HEAD vs index（-one +two）')

    console.log('gitDiff（untracked）：')
    const untrackedDiff = await gitDiff(dir, 'with spaces.txt', false, true)
    assert(
      untrackedDiff.includes('new file mode') && untrackedDiff.includes('+x'),
      'untracked 工作区 diff = no-index 新增（new file mode +x）',
    )
    assert(await gitDiff(dir, 'with spaces.txt') === '', 'untracked 常规 diff 为空（exit 0 不报错）')
    assert(await gitDiff(dir, 'with spaces.txt', true) === '', 'untracked 暂存 diff 为空（exit 0 不报错）')
    assert(await gitIsTracked(dir, 'a.txt'), 'gitIsTracked：已跟踪文件=true')
    assert(!(await gitIsTracked(dir, 'with spaces.txt')), 'gitIsTracked：未跟踪文件=false')
    // agent 工具链路传的是 ensureInside 归一的绝对路径——ls-files 的绝对 pathspec 必须能匹配
    const absA = path.join(dir, 'a.txt')
    assert(await gitIsTracked(dir, absA), 'gitIsTracked：绝对路径（工具链路真实入参）=true')

    console.log('add / commit：')
    await gitAdd(dir)
    const out = await gitCommit(dir, 'test commit')
    assert(/test commit/.test(out), 'commit 返回包含提交信息')
    const st2 = await gitStatus(dir)
    assert(st2.files.length === 0, '提交后工作区干净')

    console.log('unstage / discard：')
    writeFileSync(path.join(dir, 'renamed.txt'), 'moved-edit\n')
    await gitAdd(dir, ['renamed.txt'])
    await gitUnstage(dir, ['renamed.txt'])
    const st3 = await gitStatus(dir)
    const r3 = st3.files.find((f) => f.path === 'renamed.txt')
    assert(!!r3 && !r3.staged && r3.unstaged, 'unstage 后仅剩工作区改动')
    await gitDiscard(dir, ['renamed.txt'])
    // Windows core.autocrlf 可能写入 CRLF：还原语义等价判断，不做字节级比较
    const restored = readFileSync(path.join(dir, 'renamed.txt'), 'utf8').replace(/\r\n/g, '\n')
    assert(restored === 'moved\n', 'discard 后还原为 HEAD 内容')

    console.log('discard 全部（空 paths = 整棵工作树）：')
    writeFileSync(path.join(dir, 'a.txt'), 'dirty\n')
    writeFileSync(path.join(dir, 'keep-untracked.txt'), 'x\n')
    sh('git add a.txt', dir) // 制造暂存+工作区双态，验证 restore --staged --worktree 全清
    await gitDiscard(dir)
    const st5 = await gitStatus(dir)
    assert(
      st5.files.length === 1 && st5.files[0].path === 'keep-untracked.txt' && st5.files[0].status === 'untracked',
      `空 paths 丢弃全部：已跟踪改动全还原、untracked 保留（实际 ${JSON.stringify(st5.files.map((f) => f.path))}）`,
    )

    console.log('边界：')
    const nonRepo = mkdtempSync(path.join(os.tmpdir(), 'qyris-git-norepo-'))
    const st4 = await gitStatus(nonRepo)
    assert(!st4.isRepo, '非仓库目录 isRepo=false')
    rmSync(nonRepo, { recursive: true, force: true })
    let threw = false
    try {
      await gitCommit(dir, '   ')
    } catch {
      threw = true
    }
    assert(threw, '空提交信息被拒绝')

    console.log('gitMerge：')
    // 收拢前段场景的残留改动，保证合并场景从干净树出发
    sh('git add -A && git commit -m merge-base --allow-empty', dir)
    // 快进合并：feature 领先 main 一步
    sh('git checkout -b feature', dir)
    writeFileSync(path.join(dir, 'f.txt'), 'feature\n')
    sh('git add f.txt && git commit -m feature', dir)
    sh('git checkout main', dir)
    const ff = await gitMerge(dir, 'feature')
    assert(/fast-forward/i.test(ff), `快进合并（实际首行：${ff.split('\n')[0]}）`)
    // 重复合并幂等：已包含
    const again = await gitMerge(dir, 'feature')
    assert(/already up to date/i.test(again), '重复合并 → Already up to date')
    // 冲突：两分支同建同名不同内容 → CONFLICT 转译为可读文案
    sh('git checkout -b side', dir)
    writeFileSync(path.join(dir, 'c.txt'), 'side\n')
    sh('git add c.txt && git commit -m side', dir)
    sh('git checkout main', dir)
    writeFileSync(path.join(dir, 'c.txt'), 'main\n')
    sh('git add c.txt && git commit -m main2', dir)
    let conflictMsg = ''
    try {
      await gitMerge(dir, 'side')
    } catch (e) {
      conflictMsg = String(e)
    }
    assert(conflictMsg.includes('合并冲突'), `冲突合并抛可读转译（实际：${conflictMsg.slice(0, 60)}）`)
    sh('git merge --abort', dir)
    // 脏工作区：合并将覆盖未提交改动 → 拒绝
    writeFileSync(path.join(dir, 'e.txt'), 'base\n')
    sh('git add e.txt && git commit -m base', dir)
    sh('git checkout -b touch', dir)
    writeFileSync(path.join(dir, 'e.txt'), 'branch\n')
    sh('git add e.txt && git commit -m touch', dir)
    sh('git checkout main', dir)
    writeFileSync(path.join(dir, 'e.txt'), 'local edit\n')
    threw = false
    try {
      await gitMerge(dir, 'touch')
    } catch {
      threw = true
    }
    assert(threw, '脏工作区合并被拒（本地改动会被覆盖）')
    sh('git checkout -- e.txt', dir)
    // 分支名注入守卫：- 开头按选项处理会被吞，必须拒
    threw = false
    try {
      await gitMerge(dir, '-evil')
    } catch {
      threw = true
    }
    assert(threw, '分支名以 - 开头被拒（选项注入守卫）')

    console.log('gitChangeLinesLive（编辑器 gutter 实时行级变更）：')
    {
      // 基线提交：后续全部用「传入内存内容」驱动，不依赖磁盘文件状态（实时语义）
      writeFileSync(path.join(dir, 'g-mod.txt'), 'one\n')
      writeFileSync(path.join(dir, 'g-del.txt'), 'r1\nr2\nr3\n')
      sh('git add g-mod.txt g-del.txt && git commit -m gutter-base', dir)

      // 未跟踪（HEAD/index 均无）→ 传入内容全行 added
      const untracked = await gitChangeLinesLive(dir, path.join(dir, 'g-never.txt'), 'l1\nl2\n')
      assert(untracked !== null && untracked.added.length === 2 && untracked.modified.length === 0, `未跟踪文件全行 added（实际 ${JSON.stringify(untracked)}）`)

      // 单行修改 → modified 含 1
      const mod = await gitChangeLinesLive(dir, path.join(dir, 'g-mod.txt'), 'one-changed\n')
      assert(mod !== null && mod.modified.includes(1) && mod.added.length === 0, `单行修改 → modified 含 1（实际 ${JSON.stringify(mod)}）`)

      // 删中间行：'r1 r2 r3' → 'r1 r3'，deleted 语义 = 删除点前保留行（git +start；VS Code 同位）→ 标 1
      const del = await gitChangeLinesLive(dir, path.join(dir, 'g-del.txt'), 'r1\nr3\n')
      assert(del !== null && del.deleted.includes(1) && del.modified.length === 0, `删第 2 行 → deleted 含 1（实际 ${JSON.stringify(del)}）`)

      // 追加一行 → added 含 4
      const app = await gitChangeLinesLive(dir, path.join(dir, 'g-mod.txt'), 'one\nextra\n')
      assert(app !== null && app.added.includes(2), `追加行 → added 含 2（实际 ${JSON.stringify(app)}）`)

      // 无变化 → 三类全空
      const same = await gitChangeLinesLive(dir, path.join(dir, 'g-mod.txt'), 'one\n')
      assert(same !== null && same.added.length === 0 && same.modified.length === 0 && same.deleted.length === 0, `无变更全空（实际 ${JSON.stringify(same)}）`)

      // CRLF 归一化：仓库 LF 基线 vs 编辑器 CRLF 内容（Windows 常态）不得误判全行 modified
      const crlf = await gitChangeLinesLive(dir, path.join(dir, 'g-mod.txt'), 'one\r\n')
      assert(crlf !== null && crlf.modified.length === 0 && crlf.added.length === 0 && crlf.deleted.length === 0, `CRLF 同内容不误判（实际 ${JSON.stringify(crlf)}）`)
      // CRLF 真实变更照常识别
      const crlfMod = await gitChangeLinesLive(dir, path.join(dir, 'g-mod.txt'), 'two\r\n')
      assert(crlfMod !== null && crlfMod.modified.includes(1), `CRLF 真变更仍识别（实际 ${JSON.stringify(crlfMod)}）`)

      // 大中文文件跨 pipe chunk（>64KB）：chunk-wise toString 会切断多字节字符 → 基线乱码
      // → 全文虚假失配、标记漂移。改第 300 行一个词，modified 必须只含 300
      const cnLines: string[] = []
      for (let i = 1; i <= 800; i++) {
        cnLines.push(i === 300 ? '第三百行：这里是一段较长的中文注释内容用于撑大输出体积' : `第${i}行：中文注释内容，包含标点与英文字母 mixed content。`)
      }
      writeFileSync(path.join(dir, 'g-cn.txt'), cnLines.join('\n') + '\n')
      sh('git add g-cn.txt && git commit -m gutter-cn', dir)
      cnLines[299] = '第300行：改过的行——修改后的中文内容 new-token'
      const cn = await gitChangeLinesLive(dir, path.join(dir, 'g-cn.txt'), cnLines.join('\n') + '\n')
      assert(
        cn !== null && cn.modified.length === 1 && cn.modified[0] === 300 && cn.added.length === 0 && cn.deleted.length === 0,
        `大中文文件单行修改只标 300（实际 ${JSON.stringify(cn)})`,
      )

      const outside = await gitChangeLinesLive(dir, path.join(path.dirname(dir), 'outside.txt'), 'x\n')
      assert(outside === null, `工程外文件 → null（实际 ${JSON.stringify(outside)}）`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
