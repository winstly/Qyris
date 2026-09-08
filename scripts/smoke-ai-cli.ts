/**
 * Claude CLI adapter 冒烟测试：对话序列化（system 丢弃 / 工具痕迹截断 / 工具名回查 / 总量掐头留尾）、
 * CLI 启动参数组装（flag 白名单 / 模型名净化 / 权限档位）、
 * 假 claude 子进程罐装 NDJSON 全链路（增量事件序列 / 工具活动行 / 工具结果回填 /
 * 子 agent 转录（parent_tool_use_id 路由）/ result 权威收口）。
 * 运行：npm run smoke:cli
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serializeConversation, buildCliSystemPrompt, buildCliArgs, claudeCliChatStream, setCliCommandForTest, extractNextSkill, extractStartCommands, extractSkillIds, resolveSkillBlock, buildSkillIndex } from '../electron/lib/ai-cli'
import { registerWindow } from '../electron/lib/emitter'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

async function main(): Promise<void> {
  // emitter 假窗口：注册后捕获 emitToRenderer 广播（多窗口路由改造后的接线方式）
  const events: { channel: string; payload: Record<string, unknown> }[] = []
  registerWindow({
    id: 1,
    isDestroyed: () => false,
    on: () => {},
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

  console.log('buildCliArgs：')
  const autoArgs = buildCliArgs('sonnet', 'auto')
  assert(autoArgs.includes('-p'), '-p 非交互模式')
  assert(autoArgs.includes('--output-format') && autoArgs.includes('stream-json'), 'stream-json 输出格式')
  assert(autoArgs.includes('--verbose'), '--verbose 完整事件')
  assert(autoArgs.includes('--include-partial-messages'), '--include-partial-messages 增量分片')
  assert(autoArgs.includes('--max-turns') && autoArgs.includes('60'), 'max-turns=60 防失控')
  assert(!autoArgs.includes('--model'), '不传 --model（CLI 自带模型配置）')
  assert(autoArgs.includes('--dangerously-skip-permissions'), 'auto 档跳过权限确认')
  assert(autoArgs.every((a) => !a.includes(' ')), 'argv 全部无空格（cmd.exe /C 拼接零引号风险）')
  const roArgs = buildCliArgs('sonnet', 'readonly')
  const ai = roArgs.indexOf('--allowedTools')
  assert(ai >= 0 && roArgs[ai + 1] === 'Read,Glob,Grep,LS,TodoWrite,WebSearch,WebFetch', 'readonly 档白名单逗号单参数')
  assert(!roArgs.includes('--dangerously-skip-permissions'), 'readonly 档不跳权限')
  // mem agent 蒸馏直调（callCliJson）：readonly + json 输出 + 单轮
  const distillArgs = buildCliArgs('sonnet', 'readonly', { systemPrompt: '蒸馏指令', outputFormat: 'json', maxTurns: 1 })
  const di = distillArgs.indexOf('--max-turns')
  assert(di >= 0 && distillArgs[di + 1] === '1', 'max-turns 可覆盖（蒸馏 headless 单轮）')
  assert(distillArgs.includes('--system-prompt') && distillArgs.includes('蒸馏指令'), 'system-prompt 注入蒸馏指令')
  assert(distillArgs.includes('--output-format') && distillArgs.includes('json'), 'output-format json 单次完整返回')
  assert(!distillArgs.includes('--verbose'), 'json 格式不附带 stream-json 专属 flag')

  console.log('buildCliSystemPrompt：')
  assert(buildCliSystemPrompt('E:/proj').includes('E:/proj'), '包含项目目录')
  assert(buildCliSystemPrompt(null).includes('未打开项目'), '无项目提示')
  assert(buildCliSystemPrompt('E:/proj').includes('不存在于你这里'), '声明轻驭工具痕迹不可用')
  assert(!buildCliSystemPrompt('E:/proj').includes('NEXT_MODEL'), '系统提示不含选模指令')
  assert(
    buildCliSystemPrompt('E:/proj', 'SKILL_BLOCK_HERE').includes('SKILL_BLOCK_HERE')
      && buildCliSystemPrompt('E:/proj', 'X').includes('唯一的例外是 load_skill'),
    'Skill 内容注入 + load_skill 例外声明',
  )
  assert(buildCliSystemPrompt('E:/proj').includes('忽略它并按任务字面继续'), '无 Skill 时声明忽略加载要求')
  assert(
    buildCliSystemPrompt('E:/proj', '', '', ['C:/skills/a', 'C:/skills/b']).includes('C:/skills/a')
      && buildCliSystemPrompt('E:/proj', '', '', ['C:/skills/a']).includes('不要用 find/grep 全盘搜索'),
    '注入 Skill 目录路径（防全盘扫描）',
  )

  console.log('extractSkillIds / resolveSkillBlock：')
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
    assert(buildCliSystemPrompt('E:/proj', '', idx).includes(idx), '索引注入系统提示')
  } finally {
    rmSync(skillDir, { recursive: true, force: true })
  }

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
      // 完整 assistant 事件（主线程）：stream_event 已流式覆盖，不得重复入卡
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hi' } }] }, parent_tool_use_id: null }),
      // 主线程 tool_result（user 事件）：string content 与块数组 content 两种形态
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'tu1', type: 'tool_result', content: 'probe-step-1', is_error: false }] }, parent_tool_use_id: null }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'tu2', type: 'tool_result', content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }], is_error: true }] }, parent_tool_use_id: null }),
      // 子 agent 派发（Agent）流式组装
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu3', name: 'Agent' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"description":"Run probe","prompt":"p","subagent_type":"general-purpose"}' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 3 } }),
      // 子 agent 事件（parent_tool_use_id=tu3）：工具调用 → 工具结果（任务指令 user 文本事件不入转录）
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '运行 echo' }] }, parent_tool_use_id: 'tu3' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '子代理说明' }, { type: 'tool_use', id: 'tu-sub', name: 'PowerShell', input: { command: 'echo subagent-ok' } }] }, parent_tool_use_id: 'tu3' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'tu-sub', type: 'tool_result', content: 'subagent-ok', is_error: false }] }, parent_tool_use_id: 'tu3' }),
      // Agent 派发卡结果收口（主线程 user 事件 + 子 agent token 账目）
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'tu3', type: 'tool_result', content: [{ type: 'text', text: '子代理报告' }], is_error: false }] }, parent_tool_use_id: null, tool_use_result: { status: 'completed', usage: { input_tokens: 11949, output_tokens: 22 } } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'FINAL TEXT\n[[START_COMMANDS: [{"name":"portal","run":"npm run dev"}]]]\n[[NEXT_SKILL: ding, 钉味2]]', total_cost_usd: 0.0042, num_turns: 3, session_id: 'sess-test-1' }),
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

    assert(completion.content === 'FINAL TEXT', 'result 全文为权威 content（两条指令行均剥离）')
    assert(completion.nextSkill?.join('|') === 'ding|钉味2', '下一轮 Skill 请求透传 nextSkill')
    assert(completion.startCommands?.length === 1 && completion.startCommands[0].name === 'portal', '启动命令清单透传 startCommands')
    const rsn = completion.reasoning ?? ''
    assert(
      rsn.includes('下一轮将附带 Skill：ding、钉味2')
      && rsn.includes('启动命令清单已提交（1 项：portal）'),
      '两项决策进 reasoning 透明展示',
    )
    assert(completion.finishReason === 'stop', 'finishReason=stop')
    // CLI 工具活动通过 cli-tool-event 实时写入消息，不进 completion.toolCalls（避免触发 executeTool）
    assert(completion.toolCalls.length === 0, `toolCalls 数=${completion.toolCalls.length}（CLI 模式不进 completion.toolCalls）`)
    assert((completion.reasoning ?? '').includes('step1 '), 'thinking 增量进 reasoning')
    // 工具指令/结果与子 agent 转录经 cli-tool-event / cli-tool-result / cli-agent-event 分离，见下方断言
    assert((completion.reasoning ?? '').includes('3 轮') && (completion.reasoning ?? '').includes('$0.0042'), '完成元信息（轮数/费用）')

    console.log('cli-tool-event / cli-tool-result / cli-agent-event：')
    const toolEvents = events.filter((e) => e.channel === 'cli-tool-event' && e.payload.requestId === 'req-smoke-1')
    const starts = toolEvents.filter((e) => e.payload.phase === 'start')
    assert(starts.length === 3, `cli-tool-event start 数=3（主线程完整 assistant 事件不重复入卡，实际 ${starts.length}）`)
    const agentStart = starts.find((e) => e.payload.name === 'Agent')
    assert(!!agentStart && agentStart.payload.id === 'tu3', 'Agent 派发卡 start 事件')

    const toolResults = events.filter((e) => e.channel === 'cli-tool-result' && e.payload.requestId === 'req-smoke-1')
    assert(toolResults.length === 3, `cli-tool-result 数=3（实际 ${toolResults.length}）`)
    const r1 = toolResults.find((e) => e.payload.id === 'tu1')!
    assert(r1.payload.content === 'probe-step-1' && r1.payload.isError === false && r1.payload.tokens === undefined, '主线程工具结果（string content）回填')
    const r2 = toolResults.find((e) => e.payload.id === 'tu2')!
    assert(r2.payload.content === 'line1\nline2' && r2.payload.isError === true, '工具结果块数组拼接 + is_error 透传')
    const r3 = toolResults.find((e) => e.payload.id === 'tu3')!
    assert(r3.payload.content === '子代理报告' && r3.payload.isError === false, 'Agent 派发结果收口')
    const r3t = r3.payload.tokens as { input: number; output: number } | undefined
    assert(r3t?.input === 11949 && r3t?.output === 22, '子 agent token 账目透传')

    const agentEvents = events.filter((e) => e.channel === 'cli-agent-event' && e.payload.requestId === 'req-smoke-1')
    assert(agentEvents.every((e) => e.payload.parentId === 'tu3'), 'cli-agent-event 全部归属 Agent 派发卡')
    const kinds = agentEvents.map((e) => e.payload.kind)
    assert(JSON.stringify(kinds) === JSON.stringify(['text', 'tool', 'tool-result']), `子 agent 转录事件序列（实际 ${JSON.stringify(kinds)}）`)
    const subTool = agentEvents.find((e) => e.payload.kind === 'tool')!
    assert(subTool.payload.name === 'PowerShell' && String(subTool.payload.arguments).includes('echo subagent-ok'), '子 agent 工具调用入卡（名字+参数）')
    const subResult = agentEvents.find((e) => e.payload.kind === 'tool-result')!
    assert(subResult.payload.id === 'tu-sub' && subResult.payload.content === 'subagent-ok' && subResult.payload.isError === false, '子 agent 工具结果回填')

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
