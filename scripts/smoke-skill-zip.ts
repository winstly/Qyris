/**
 * Skill zip 导入冒烟测试：对临时目录构造多种结构 zip 样本跑 importSkillFromZip，
 * 覆盖：单顶层目录 / 根含 SKILL.md / 多子目录批量 / __MACOSX 垃圾不破坏判定 /
 * 无 SKILL.md 报错 / 损坏 zip 报错 / 覆盖导入 / tmp 目录清理。
 * 运行：npm run smoke:skill-zip
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { importSkillFromZip } from '../electron/lib/skills'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

function makeZip(file: string, files: Record<string, string>): void {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content, 'utf8'))
  zip.writeZip(file)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qyris-skillzip-smoke-'))
  const dest = path.join(dir, 'skills')
  try {
    console.log('importSkillFromZip 结构判定：')

    // A：单顶层目录
    const zipA = path.join(dir, 'a-skill.zip')
    makeZip(zipA, {
      'debug-react/SKILL.md': '---\nname: 调试 React\ndescription: x\n---\n# 调试',
      'debug-react/scripts/run.js': 'console.log(1)',
    })
    const rA = await importSkillFromZip(dest, zipA)
    assert(rA.ok && rA.name === 'debug-react', `A 单顶层目录（实际 ${JSON.stringify(rA)}）`)
    assert(existsSync(path.join(dest, 'debug-react', 'SKILL.md')), 'A SKILL.md 落位')
    assert(existsSync(path.join(dest, 'debug-react', 'scripts', 'run.js')), 'A 子目录随包落位')

    // B：根直接含 SKILL.md → id 取 zip 文件名（含中文/空格名也照常）
    const zipB = path.join(dir, '我的 技能包.zip')
    makeZip(zipB, {
      'SKILL.md': '---\nname: 根包\ndescription: x\n---\n# 根包',
      'assets/logo.svg': '<svg/>',
    })
    const rB = await importSkillFromZip(dest, zipB)
    assert(rB.ok && rB.name === '我的 技能包', `B 根含 SKILL.md（实际 ${JSON.stringify(rB)}）`)
    assert(existsSync(path.join(dest, '我的 技能包', 'SKILL.md')), 'B SKILL.md 落位')

    // C：多个子目录各含 SKILL.md → 批量
    const zipC = path.join(dir, 'batch.zip')
    makeZip(zipC, {
      'skill-one/SKILL.md': '# one',
      'skill-two/SKILL.md': '# two',
      'readme.txt': 'not a skill',
    })
    const rC = await importSkillFromZip(dest, zipC)
    assert(rC.ok && rC.count === 2, `C 多子目录批量（实际 ${JSON.stringify(rC)}）`)
    assert(existsSync(path.join(dest, 'skill-one', 'SKILL.md')) && existsSync(path.join(dest, 'skill-two', 'SKILL.md')), 'C 两个子 Skill 都落位')

    // __MACOSX / .DS_Store / ._* 垃圾不破坏单顶层目录判定
    const zipJunk = path.join(dir, 'junk.zip')
    makeZip(zipJunk, {
      'mac-skill/SKILL.md': '# mac',
      '__MACOSX/mac-skill/._SKILL.md': 'junk',
      '.DS_Store': 'junk',
    })
    const rJunk = await importSkillFromZip(dest, zipJunk)
    assert(rJunk.ok && rJunk.name === 'mac-skill', `垃圾文件不破坏判定（实际 ${JSON.stringify(rJunk)}）`)
    assert(!existsSync(path.join(dest, '__MACOSX')), '垃圾未随导入落盘')

    // 无 SKILL.md → 明确报错
    const zipNo = path.join(dir, 'noskill.zip')
    makeZip(zipNo, { 'only/readme.md': 'no skill here' })
    const rNo = await importSkillFromZip(dest, zipNo)
    assert(!rNo.ok && (rNo.error ?? '').includes('未找到 SKILL.md'), `无 SKILL.md 报错（实际 ${rNo.error}）`)

    // 损坏 zip → 可读报错（不吐原始堆栈）
    const zipBad = path.join(dir, 'broken.zip')
    writeFileSync(zipBad, 'this is not a zip')
    const rBad = await importSkillFromZip(dest, zipBad)
    assert(!rBad.ok && typeof rBad.error === 'string' && rBad.error.length > 0, `损坏 zip 报错（实际 ${rBad.error}）`)
    assert(!(rBad.error ?? '').includes('Error: Error'), '报错无堆栈叠词')

    // 覆盖导入：同名 Skill 再导一次 → 成功覆盖
    makeZip(zipA, { 'debug-react/SKILL.md': '---\nname: 调试 React\ndescription: y\n---\n# 调试 v2' })
    const rOver = await importSkillFromZip(dest, zipA)
    assert(rOver.ok, '覆盖导入成功')
    assert(readFileSync(path.join(dest, 'debug-react', 'SKILL.md'), 'utf8').includes('v2'), '覆盖后内容为新版')

    // tmp 目录清理：dest 下不残留 __import_tmp_*
    const leftovers = readdirSync(dest).filter((n) => n.startsWith('__import_tmp_'))
    assert(leftovers.length === 0, `无 tmp 残留（实际 ${leftovers.join(',')}）`)

    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  if (failures > 0) process.exit(1)
}

void main()
