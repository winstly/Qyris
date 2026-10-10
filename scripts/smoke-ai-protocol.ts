/**
 * AI CLI 协议原语冒烟：对话序列化（system 丢弃 / 工具痕迹截断 / 工具名回查 / 总量掐头留尾 /
 * 记忆摘要前置节）、Skill 协议反解（三种加载指令形态 / NEXT_SKILL / START_COMMANDS）、
 * Skill 多目录内联与索引、testCliConnection 自定义命令拆分（`"<path> -cc"` 形态，
 * 回归整串当 exe 名的 ENOENT）。
 *
 * 这些断言钉死的是 skillInstruction.ts 生成器措辞 ↔ ai-cli.ts 反解正则 的双拷贝契约，
 * 改措辞必须生成器、正则、本冒烟三处同步。
 * 运行：npm run smoke:protocol
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serializeConversation, testCliConnection, setCliCommandForTest, extractNextSkill, extractStartCommands, extractSkillIds, resolveSkillBlock, buildSkillIndex } from '../electron/lib/ai-cli'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

async function main(): Promise<void> {
  console.log('serializeConversation：')
  const msgs = [
    { role: 'system', content: 'SYSTEM_MARKER_1 你有 list_files 等工具' },
    { role: 'user', content: '第一个问题' },
    {
      role: 'assistant', content: '第一个回答',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.ts', content: 'X'.repeat(500) }) } },
        { id: 'call_2', type: 'function', function: { name: 'run_once', arguments: 'npm test' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'Y'.repeat(2000) },
    { role: 'tool', tool_call_id: 'call_2', content: 'ok' },
    { role: 'tool', tool_call_id: 'zz_abcdef123', content: '孤儿结果' },
    { role: 'assistant', content: '第二个回答' },
    { role: 'user', content: '第二个问题' },
  ]
  const s = serializeConversation(msgs)
  assert(!s.includes('SYSTEM_MARKER_1'), 'system 消息全部丢弃（CLI 系统提示由 adapter 注入）')
  assert(s.includes('用户：第一个问题') && s.includes('用户：第二个问题'), 'user 消息保留')
  assert(s.includes('助手：第一个回答') && s.includes('助手：第二个回答'), 'assistant 纯文本保留')
  assert(s.includes('这些工具不存在于本环境'), '轻驭工具痕迹带「本环境不存在」声明')
  assert(s.includes('- write_file 参数：') && s.includes('- run_once 参数：npm test'), '工具痕迹逐条列出')
  assert(!s.includes('X'.repeat(400)) && s.includes('X'.repeat(100)), '工具参数截断（300 上限）')
  assert(s.includes('（工具 write_file 返回：') && s.includes('（工具 run_once 返回：ok）'), 'tool 结果带工具名回查')
  assert(!s.includes('Y'.repeat(1600)) && s.includes('Y'.repeat(100)), 'tool 结果截断（1500 上限）')
  assert(s.includes('（工具 zz_abcde 返回：孤儿结果）'), '查不到名字的 tool_call_id 取前 8 位')
  assert(!s.includes('…更早对话已省略…'), '未超总量的历史不掐头')

  const bigS = serializeConversation([
    { role: 'user', content: 'HEAD_MARKER' + 'A'.repeat(120_000) },
    { role: 'assistant', content: 'B'.repeat(120_000) },
    { role: 'user', content: 'TAIL_MARKER 最后一条请求' },
  ])
  assert(bigS.includes('…更早对话已省略…'), '超 160k 掐头留尾插省略标记')
  assert(bigS.includes('TAIL_MARKER 最后一条请求'), '末尾本轮请求必须在留尾段完整保留')

  // P0 修复回归：CLI 路径的记忆反哺通道（渲染层注入的 system 在此被丢弃，
  // 工作记忆摘要与长期记忆块必须经 serializeConversation 前置进正文）
  console.log('serializeConversation：记忆/摘要前置节（CLI 记忆反哺通道）')
  const memS = serializeConversation(msgs, '上周决定用 pnpm', '【长期记忆（供参考，可能过时）】\n- [preference] 包管理器用 pnpm：用户明确要求一律用 pnpm')
  assert(memS.includes('【此前会话进展】\n上周决定用 pnpm'), '会话摘要前置且带节标题')
  assert(memS.includes('【长期记忆（供参考，可能过时）】\n- [preference] 包管理器用 pnpm'), '长期记忆块（渲染层预格式化）原样前置')
  assert(
    memS.indexOf('【此前会话进展】') < memS.indexOf('【长期记忆') && memS.indexOf('【长期记忆') < memS.indexOf('用户：第一个问题'),
    '头部（摘要→记忆）在对话正文之前',
  )
  const memOnly = serializeConversation(msgs, null, 'MEM_BLOCK_ONLY')
  assert(memOnly.startsWith('MEM_BLOCK_ONLY'), '仅记忆无摘要时同样前置')
  assert(!serializeConversation(msgs).includes('MEM_BLOCK_ONLY'), '不传记忆块时无前置节（向后兼容）')
  const headBig = serializeConversation(
    [{ role: 'user', content: 'H' + 'A'.repeat(200_000) }],
    '短摘要', '短记忆',
  )
  assert(headBig.includes('【此前会话进展】\n短摘要') && headBig.includes('短记忆'), '正文截断时头部（摘要/记忆）永不丢失')
  assert(headBig.includes('…更早对话已省略…'), '正文预算按头部长度扣除后照常掐头留尾')

  console.log('extractSkillIds：')
  const skillMsgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '请先用 load_skill 依次加载以下 2 个 Skill，全部加载后再执行：ding, frontend-design\n\n任务正文' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '请先用 load_skill 加载 Skill「debug-react」，再执行。\n还有 ding\n[附带 Skill：review-style]' },
  ]
  const ids = extractSkillIds(skillMsgs)
  assert(JSON.stringify(ids) === JSON.stringify(['ding', 'frontend-design', 'debug-react', 'review-style']), `三种指令形态提取 + 去重保序（实际 ${JSON.stringify(ids)}）`)
  assert(extractSkillIds([{ role: 'user', content: '普通消息' }]).length === 0, '无指令返回空')

  console.log('extractNextSkill：')
  const ns = extractNextSkill('正文\n[[NEXT_SKILL: ding, 钉味2]]')
  assert(ns.ids.join('|') === 'ding|钉味2' && ns.text === '正文', '尾行多 id 提取（含中文目录名）+ 剥离')
  assert(extractNextSkill('正文没有指令').ids.length === 0, '无指令返回空')
  assert(extractNextSkill('[[NEXT_SKILL: a]]\n后续').ids.length === 0, '非末尾不提取')
  assert((extractNextSkill('正文\n[[NEXT_MODEL: m1]]').text.includes('NEXT_MODEL')), 'NEXT_SKILL 提取不误伤 NEXT_MODEL')

  console.log('extractStartCommands：')
  const sc = extractStartCommands('正文\n[[START_COMMANDS: [{"name":"portal","run":"npm run dev"},{"name":"admin","run":"npm run dev"}]]]')
  assert(sc.text === '正文' && sc.commands.length === 2 && sc.commands[0].name === 'portal' && sc.commands[0].run === 'npm run dev', '尾行紧凑 JSON 提取 + 剥离')
  const lc = extractStartCommands('正文\n[[start_commands: [{"name":"p","run":"x"}]]]')
  assert(lc.commands.length === 1 && lc.text === '正文', '小写指令同样识别（/i）')
  const ml = extractStartCommands('正文\n[[START_COMMANDS: [\n  {"name":"p","run":"x"}\n]]]')
  assert(ml.commands.length === 1 && ml.text === '正文', '美化换行 JSON 同样识别（/s）')
  assert(extractStartCommands('正文\n[[START_COMMANDS: [{\"name\":\"p\"}]]]').commands.length === 0, '缺 run 的条目被过滤（指令行仍剥离）')
  assert(extractStartCommands('正文\n[[START_COMMANDS: not-json]]').commands.length === 0, '非法 JSON 剥离但不采纳')
  assert(extractStartCommands('[[START_COMMANDS: [{\"name\":\"a\",\"run\":\"b\"}]]]\n尾随文本').commands.length === 0, '非末尾不提取')
  assert(extractStartCommands('普通正文').commands.length === 0, '无指令返回空')

  console.log('resolveSkillBlock / buildSkillIndex：')
  const skillDir = mkdtempSync(path.join(os.tmpdir(), 'qyris-cli-skill-'))
  try {
    mkdirSync(path.join(skillDir, 'ding'), { recursive: true })
    writeFileSync(
      path.join(skillDir, 'ding', 'SKILL.md'),
      '---\nname: 钉味\ndescription: 钉内钉外提醒\n---\n\n# 钉味正文\n证据链验收。',
      'utf8',
    )
    // 第二目录：同名 ding 内容不同（验证首中优先）+ 独有 skill
    const skillDir2 = path.join(skillDir, 'more')
    mkdirSync(path.join(skillDir2, 'ding'), { recursive: true })
    mkdirSync(path.join(skillDir2, 'review-style'), { recursive: true })
    writeFileSync(path.join(skillDir2, 'ding', 'SKILL.md'), '# 第二目录的 ding', 'utf8')
    writeFileSync(
      path.join(skillDir2, 'review-style', 'SKILL.md'),
      '---\nname: 评审风格\ndescription: 多 agent 代码评审\n---\n\n# 评审正文',
      'utf8',
    )
    const dirs = [skillDir, skillDir2]
    const block = await resolveSkillBlock(dirs, ['ding', 'not-exist', '../escape'])
    assert(block.includes('<skill id="ding">') && block.includes('证据链验收。'), '多目录按序首个命中')
    assert(!block.includes('第二目录的 ding'), '同名 id 不吃后续目录')
    assert(block.includes('无需执行任何加载动作'), '声明免加载动作')
    assert(!block.includes('not-exist') && !block.includes('escape'), '不存在/越权 id 静默跳过')
    assert(await resolveSkillBlock([], ['ding']) === '', '未配置目录返回空')
    assert(await resolveSkillBlock(dirs, []) === '', '无引用返回空')

    const idx = await buildSkillIndex(dirs, ['ding'])
    assert(idx.includes('review-style：评审风格（多 agent 代码评审）'), '索引含名称与描述')
    assert(!idx.includes('钉味'), '已内联的 id 从索引排除')
    assert(idx.includes('[[NEXT_SKILL:'), '索引含请求通道说明')
    assert(await buildSkillIndex([], []) === '', '无目录索引为空')
  } finally {
    rmSync(skillDir, { recursive: true, force: true })
  }

  console.log('testCliConnection：自定义命令「可执行 + 前置参数」拆分（回归 `cfuse -cc` ENOENT）')
  const cdir = mkdtempSync(path.join(os.tmpdir(), 'qyris-cli-cfuse-'))
  try {
    const binDir = path.join(cdir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const cfuse = path.join(binDir, process.platform === 'win32' ? 'cfuse.cmd' : 'cfuse')
    if (process.platform === 'win32') {
      // 前置参数形态：-cc 占 $1，--version 落到 $2——两个位置都要认
      writeFileSync(cfuse, '@echo off\r\nif /i "%~1"=="--version" echo cfuse 1.0.0\r\nif /i "%~2"=="--version" echo cfuse 1.0.0\r\nexit /b 0\r\n', 'utf8')
    } else {
      writeFileSync(cfuse, '#!/bin/sh\nif [ "$1" = "--version" ] || [ "$2" = "--version" ]; then echo "cfuse 1.0.0"; fi\nexit 0\n', 'utf8')
      chmodSync(cfuse, 0o755)
    }
    // 引号路径 + 前置参数：旧 runCli 把整串当 exe 名 spawn → 非 Windows ENOENT。
    // 拆分正确时 --version 命中假脚本、auth status 退出 0 → 报告「已登录」
    const msg = await testCliConnection(`"${cfuse}" -cc`)
    assert(!/ENOENT/i.test(msg), `无 ENOENT（实际：${msg}）`)
    assert(msg.includes('cfuse 1.0.0'), `拆分命中假脚本（--version 输出透传，实际：${msg}）`)
    assert(msg.includes('已登录'), `auth status 探测通过（实际：${msg}）`)
  } finally {
    setCliCommandForTest(null)
    rmSync(cdir, { recursive: true, force: true })
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
