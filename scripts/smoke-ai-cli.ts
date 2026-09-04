/**
 * Claude CLI adapter 冒烟测试：对话序列化（system 丢弃 / 工具痕迹截断 / 工具名回查 / 总量掐头留尾）、
 * CLI 启动参数组装（flag 白名单 / 模型名净化 / 权限档位）、
 * 假 claude 子进程罐装 NDJSON 全链路（增量事件序列 / 工具活动行 / result 权威收口）。
 * 运行：npm run smoke:cli
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serializeConversation, buildCliSystemPrompt, buildCliArgs, claudeCliChatStream, setCliCommandForTest, extractNextModel, extractNextSkill, extractStartCommands, extractSkillIds, resolveSkillBlock, buildSkillIndex, buildModelMenu } from '../electron/lib/ai-cli'
import { setMainWindow } from '../electron/lib/emitter'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

async function main(): Promise<void> {
  // emitter 假窗口：捕获 emitToRenderer 广播（真实渲染进程外 mainWindow 恒 null，事件会被静默丢弃）
  const events: { channel: string; payload: Record<string, unknown> }[] = []
  setMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        events.push({ channel, payload: payload as Record<string, unknown> })
      },
    },
  } as any)

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

  console.log('buildCliArgs：')
  const autoArgs = buildCliArgs('sonnet', 'auto')
  assert(autoArgs.includes('-p'), '-p 非交互模式')
  assert(autoArgs.includes('--output-format') && autoArgs.includes('stream-json'), 'stream-json 输出格式')
  assert(autoArgs.includes('--verbose'), '--verbose 完整事件')
  assert(autoArgs.includes('--include-partial-messages'), '--include-partial-messages 增量分片')
  assert(autoArgs.includes('--max-turns') && autoArgs.includes('60'), 'max-turns=60 防失控')
  const mi = autoArgs.indexOf('--model')
  assert(mi >= 0 && autoArgs[mi + 1] === 'sonnet', '--model 透传')
  assert(autoArgs.includes('--dangerously-skip-permissions'), 'auto 档跳过权限确认')
  assert(autoArgs.every((a) => !a.includes(' ')), 'argv 全部无空格（cmd.exe /C 拼接零引号风险）')
  assert(!buildCliArgs('', 'readonly').includes('--model'), '空模型省略 --model')
  assert(!buildCliArgs('-dash', 'auto').includes('--model'), '以 - 开头的模型名丢弃（防 flag 注入）')
  const cleanArgs = buildCliArgs('gpt-4o mini!', 'auto')
  assert(cleanArgs[cleanArgs.indexOf('--model') + 1] === 'gpt-4omini', '模型名净化（去空格与非法字符）')
  const colonArgs = buildCliArgs('anthropic:claude-x', 'auto')
  assert(colonArgs[colonArgs.indexOf('--model') + 1] === 'anthropic:claude-x', '模型名净化保留冒号（网关限定名）')
  const roArgs = buildCliArgs('sonnet', 'readonly')
  const ai = roArgs.indexOf('--allowedTools')
  assert(ai >= 0 && roArgs[ai + 1] === 'Read,Glob,Grep,LS,TodoWrite,WebSearch,WebFetch', 'readonly 档白名单逗号单参数')
  assert(!roArgs.includes('--dangerously-skip-permissions'), 'readonly 档不跳权限')

  console.log('buildCliSystemPrompt：')
  assert(buildCliSystemPrompt('E:/proj').includes('E:/proj'), '包含项目目录')
  assert(buildCliSystemPrompt(null).includes('未打开项目'), '无项目提示')
  assert(buildCliSystemPrompt('E:/proj').includes('不存在于你这里'), '声明轻驭工具痕迹不可用')
  assert(buildCliSystemPrompt('E:/proj', 'MENU_LINES').includes('MENU_LINES'), '模型菜单注入系统提示')
  assert(!buildCliSystemPrompt('E:/proj').includes('NEXT_MODEL'), '无菜单时不出现选模规则')
  assert(
    buildCliSystemPrompt('E:/proj', '', 'SKILL_BLOCK_HERE').includes('SKILL_BLOCK_HERE')
      && buildCliSystemPrompt('E:/proj', '', 'X').includes('唯一的例外是 load_skill'),
    'Skill 内容注入 + load_skill 例外声明',
  )
  assert(buildCliSystemPrompt('E:/proj').includes('忽略它并按任务字面继续'), '无 Skill 时声明忽略加载要求')

  console.log('extractSkillIds / buildModelMenu / resolveSkillBlock：')
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
  assert(buildCliSystemPrompt('E:/proj').includes('[[START_COMMANDS:'), '系统提示含启动命令协议')
  assert(buildModelMenu(null) === '', 'config 为 null 时菜单为空')
  const menu = buildModelMenu({
    lastProjectPath: null, aiBaseUrl: null, aiModel: 'claude-sonnet-4-6', aiProvider: 'anthropic',
    aiDispatchMode: 'claude-cli', aiCliPermission: 'auto',
    aiTiers: { fast: 'claude-haiku-4-5', heavy: 'claude-opus-4-6' },
  })
  assert(menu.includes('主模型（默认）：claude-sonnet-4-6') && menu.includes('档位 fast：claude-haiku-4-5'), '菜单含主模型与档位')
  assert(menu.includes('[[NEXT_MODEL:'), '菜单含选模规则')

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
    assert(buildCliSystemPrompt('E:/proj', '', '', idx).includes(idx), '索引注入系统提示')
  } finally {
    rmSync(skillDir, { recursive: true, force: true })
  }

  console.log('extractNextModel：')
  assert(extractNextModel('正文\n[[NEXT_MODEL: claude-haiku-4-5]]').nextModel === 'claude-haiku-4-5', '末行指令提取')
  assert(extractNextModel('正文\n[[NEXT_MODEL: claude-haiku-4-5]]').text === '正文', '指令行从正文剥离')
  assert(extractNextModel('正文没有指令') === null || extractNextModel('正文没有指令').nextModel === null, '无指令返回 null')
  assert(extractNextModel('[[NEXT_MODEL: m1]]\n后续文本').nextModel === null, '非末尾指令不提取')
  assert(extractNextModel('正文\n[[next_model: Sonnet-4.6]]').nextModel === 'Sonnet-4.6', '大小写不敏感且允许点号')
  assert(extractNextModel('正文\n[[NEXT_MODEL: anthropic:claude-haiku]]').nextModel === 'anthropic:claude-haiku', '网关限定名含冒号可提取')
  assert(extractNextModel('正文\n[[NEXT_MODEL: rm -rf x]]').nextModel === null, '含空格的非法模型名不提取')

  console.log('假 claude 全链路（罐装 NDJSON）：')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qyris-cli-smoke-'))
  try {
    const canned = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-test-1' }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step1 ' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } } }),
      // tool_use 流式组装（与 HTTP delta.tool_calls 同构）：content_block_start → input_json_delta → content_block_stop
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu2', name: 'Write' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/a.ts","content":"x"}' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 2 } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'FINAL TEXT\n[[START_COMMANDS: [{"name":"portal","run":"npm run dev"}]]]\n[[NEXT_SKILL: ding, 钉味2]]\n[[NEXT_MODEL: claude-haiku-4-5]]', total_cost_usd: 0.0042, num_turns: 3, session_id: 'sess-test-1' }),
    ].join('\n')
    const cannedPath = path.join(dir, 'canned.ndjson')
    writeFileSync(cannedPath, canned, 'utf8')

    // 假 claude 绝对路径注入（测试接缝）：PATH 前插会被 buildChildEnv 注册表优先合并稀释，
    // 曾因此误调本机真实 claude——绝对路径在双平台都确定性命中
    const binDir = path.join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const fakePath = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
    if (process.platform === 'win32') {
      writeFileSync(fakePath, `@echo off\r\ntype "${cannedPath}"\r\n`, 'utf8')
    } else {
      writeFileSync(fakePath, `#!/bin/sh\ncat "${cannedPath}"\n`, 'utf8')
      chmodSync(fakePath, 0o755)
    }
    setCliCommandForTest(fakePath)

    const completion = await claudeCliChatStream('req-smoke-1', 'sonnet', [
      { role: 'user', content: 'hi' },
    ], dir, 'auto')

    assert(completion.content === 'FINAL TEXT', 'result 全文为权威 content（三条指令行均剥离）')
    assert(completion.nextModel === 'claude-haiku-4-5', '下一轮模型指令透传 nextModel')
    assert(completion.nextSkill?.join('|') === 'ding|钉味2', '下一轮 Skill 请求透传 nextSkill')
    assert(completion.startCommands?.length === 1 && completion.startCommands[0].name === 'portal', '启动命令清单透传 startCommands')
    const rsn = completion.reasoning ?? ''
    assert(
      rsn.includes('下一轮对话将使用模型：claude-haiku-4-5')
      && rsn.includes('下一轮将附带 Skill：ding、钉味2')
      && rsn.includes('启动命令清单已提交（1 项：portal）'),
      '三项决策进 reasoning 透明展示',
    )
    assert(completion.finishReason === 'stop', 'finishReason=stop')
    // CLI 工具活动通过 cli-tool-event 实时写入消息，不进 completion.toolCalls（避免触发 executeTool）
    assert(completion.toolCalls.length === 0, `toolCalls 数=${completion.toolCalls.length}（CLI 模式不进 completion.toolCalls）`)
    assert((completion.reasoning ?? '').includes('step1 '), 'thinking 增量进 reasoning')
    // 工具活动行已分离到 cli-activity 事件（不再进 reasoning），见下方 acts 断言
    assert((completion.reasoning ?? '').includes('3 轮') && (completion.reasoning ?? '').includes('$0.0042'), '完成元信息（轮数/费用）')

    const deltas = events.filter((e) => e.channel === 'ai-delta' && e.payload.requestId === 'req-smoke-1')
    assert(deltas.map((e) => e.payload.delta).join('') === 'Hello world', 'ai-delta 增量序列拼出正文')
    const reasons = events.filter((e) => e.channel === 'ai-reasoning' && e.payload.requestId === 'req-smoke-1')
    assert(reasons.length >= 2, `ai-reasoning 事件数=${reasons.length}（thinking + 元信息，不含工具活动）`)
  } finally {
    setCliCommandForTest('claude')
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
