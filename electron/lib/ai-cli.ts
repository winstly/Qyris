/**
 * AI CLI 协议原语 —— Skill 协议识别、对话序列化、连接测试、请求级取消。
 *
 * 旧的流式主流程（claudeCliChatStream / buildCliArgs / buildCliSystemPrompt / cliSessions）
 * 已整条拆除：聊天链路统一走 ai.ts 的 runAgent 编排 + model/providers/claude-cli.ts，
 * 会话由本软件自治理（弃 --resume，每轮全量 replay 进 stdin）——旧双轨的 --resume 续接
 * 在 clear() 后会串话（旧 session 里还有上一段对话），这是拆除的根因。
 * 本文件只剩无状态协议工具，渲染层/主进程两侧共用。
 *
 * Windows：claude 通常是 .cmd，直连 spawn 会被 Node ≥18 的 EINVAL 拦截 —— 统一经
 * spawnCliProcess 走 shell:true（cmd.exe /d /s /c "<整串>"，/s 只剥最外层引号，
 * 带空格的自定义路径才不会被 cmd 的引号剥离规则撕碎）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { getConfig } from './config'
import { readSkillFromDirs, scanSkillsDirs } from './skills'
import { cancelRunOnce, detectCommand, makeStreamDecoder } from './proc'
import { buildChildEnv } from './proc-env'
import { errorMessage } from './util'
import { mainLog } from './log-file'

type Json = Record<string, any>

const NOT_INSTALLED_MSG = '未找到 claude 命令：请先安装 Claude Code CLI（npm install -g @anthropic-ai/claude-code）并在终端完成登录后重试'

/** CLI 解析名：默认 'claude'（Windows 经 cmd 自查 PATH → claude.cmd，unix 经 PATH 直启）。
 *  运行时从 config.aiCliCommand 读取，缺省 'claude'；测试可注入覆盖。 */
const DEFAULT_CLI_COMMAND = 'claude'
let cliCommandOverride: string | null = null

/** 当前生效的 CLI 命令（测试注入 > 配置 > 默认值） */
export async function resolveCliCommand(): Promise<string> {
  if (cliCommandOverride) return cliCommandOverride
  try {
    const cfg = await getConfig()
    if (cfg.aiCliCommand) return cfg.aiCliCommand
  } catch { /* 配置不可读，用默认 */ }
  return DEFAULT_CLI_COMMAND
}

/** 同步取命令（仅供已 await resolveCliCommand 后的闭包内复用，不在首次调用处使用） */
let cachedCliCommand = DEFAULT_CLI_COMMAND

/** 冒烟测试用：注入假 CLI 路径；null 恢复从配置读取 */
export function setCliCommandForTest(cmd: string | null): void {
  cliCommandOverride = cmd
  if (cmd) cachedCliCommand = cmd
}

/** 请求级取消：CLI 子进程登记在 onceProcs（token=requestId），复用统一取消链 */
export function cliCancel(requestId: string): void {
  cancelRunOnce(requestId)
}

// ---------------- 子进程 spawn（跨平台统一通道） ----------------

/** 引号感知拆分 CLI 命令串：`"D:\My Tools\claude.cmd" --foo` → ['D:\\My Tools\\claude.cmd', '--foo']。
 *  自定义命令允许「可执行文件 + 前置参数」形态（如 `npx -y @anthropic-ai/claude-code`） */
function splitCliCommand(command: string): string[] {
  const out: string[] = []
  for (const m of command.matchAll(/"([^"]*)"|(\S+)/g)) {
    const t = m[1] ?? m[2] ?? ''
    if (t) out.push(t)
  }
  return out
}

/** Windows 单 token 引号包装：含空白/引号才包，内层双引号翻倍（argv 通行规则） */
function qWin(token: string): string {
  return /[\s"]/.test(token) ? `"${token.replace(/"/g, '""')}"` : token
}

/** 统一 CLI 子进程 spawn。修复两类已复现缺陷：
 *  ① cwd 不存在 → spawn cmd.exe ENOENT（error 事件，用户看到「启动失败 spawn … ENOENT」）——
 *     cwd 缺失时回退 homedir 并落日志；
 *  ② 带空格的自定义路径经 cmd /C 逐 token 传参，被 cmd /C 的首尾引号剥离规则撕碎
 *     （报「'D:\Program' 不是内部或外部命令」）——Windows 改走 shell:true 单串传参
 *     （cmd.exe /d /s /c "<整串>"，/s 只剥最外层引号，内层引号原样抵达子进程），
 *     引号由 qWin 自管，与 Node 自身 shell:true 机制同源。
 *  Unix 直启 argv（execve 语义无引号问题），detached 保持旧惯性。
 *  已知边界：--system-prompt 等含换行的超长参数经 cmd 单行命令线传递受限（蒸馏路径现状如此，未回归恶化）。 */
/** CLI 输出解码：CLI 自身输出是 UTF-8，只有 cmd.exe 自己的报错才是系统代码页（GBK）。
 *  策略收编进 proc.makeStreamDecoder（UTF-8 优先 + U+FFFD 回落 OEM），与
 *  run_command/run_project 的子进程解码同源——那边原来「chcp 单编码硬解」，
 *  npm/git 等输出 UTF-8 的命令必乱码，两边统一后一处修处处修。 */
function makeCliDecoder(): { decode: (chunk: Buffer | string) => string; flush: () => string } {
  const dec = makeStreamDecoder()
  return {
    decode: (chunk) => dec.decode(chunk, { stream: true }),
    /** 流收尾：吐出解码器内残留的半截多字节序列（不 flush 会静默丢弃） */
    flush: () => dec.decode(),
  }
}

function spawnCliProcess(
  cliCommand: string,
  args: string[],
  opts?: { cwd?: string | null; env?: NodeJS.ProcessEnv; stdio?: ('pipe' | 'ignore')[] },
): ChildProcess {
  const isWin = process.platform === 'win32'
  let cwd = opts?.cwd ?? undefined
  if (cwd && !existsSync(cwd)) {
    mainLog.warn(`[ai-cli] cwd 不存在，回退 homedir：${cwd}`)
    cwd = homedir()
  }
  const stdio = opts?.stdio ?? ['pipe', 'pipe', 'pipe']
  if (isWin) {
    const cmdLine = [...splitCliCommand(cliCommand), ...args].map(qWin).join(' ')
    return spawn(cmdLine, {
      cwd,
      stdio,
      shell: true,
      windowsHide: true,
      env: opts?.env,
    })
  }
  const [exe, ...prefix] = splitCliCommand(cliCommand)
  return spawn(exe, [...prefix, ...args], {
    cwd,
    stdio,
    windowsHide: true,
    detached: true,
    env: opts?.env,
  })
}

// ---------------- prompt 组装（无状态重放核心） ----------------

const TOOL_ARG_CAP = 300 // 单条工具参数展示上限（write_file 的 arguments 可能含整文件内容）
const TOOL_RESULT_CAP = 1500 // 单条工具结果展示上限
const PROMPT_TOTAL_CAP = 160_000 // 整段对话序列化总上限，超限掐头留尾

function clip(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + '…' : s
}

/** 工具名回查：tool 消息只有 tool_call_id，从历史 assistant.tool_calls 里补回工具名 */
function toolNameOf(callId: string, namesById: Map<string, string>): string {
  return namesById.get(callId) ?? callId.slice(0, 8)
}

/** @internal 把轻驭历史（OpenAI 格式）扁平成 CLI 友好的对话文本。
 *  system 全部丢弃（CLI 系统提示由 adapter 注入，CLI 还会自动加载 cwd 下 CLAUDE.md）；
 *  轻驭工具痕迹以「本环境不存在」声明 + 截断参数保留，供 CLI 理解此前轮次发生了什么。
 *  sessionSummary / memoryBlock 非空时前置进正文（P0 修复：CLI 路径的记忆反哺通道——渲染层注入的
 *  system 消息在这里被丢弃，工作记忆摘要与长期记忆块必须走正文）——
 *  memoryBlock 为渲染层预格式化块（含节标题）原样透传；头部区永不截断，
 *  160k 总预算只约束对话正文（budget = 160k − 头部长度，正文仍超限才掐头留尾） */
export function serializeConversation(messages: unknown, sessionSummary?: string | null, memoryBlock?: string | null): string {
  const summary = typeof sessionSummary === 'string' ? sessionSummary.trim() : ''
  const memory = typeof memoryBlock === 'string' ? memoryBlock.trim() : ''
  const msgs = (Array.isArray(messages) ? messages : []) as Json[]
  const namesById = new Map<string, string>()
  for (const m of msgs) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const tc of m.tool_calls as Json[]) {
      const id = typeof tc?.id === 'string' ? tc.id : ''
      const name = typeof tc?.function?.name === 'string' ? tc.function.name : ''
      if (id && name) namesById.set(id, name)
    }
  }

  const out: string[] = []
  for (const m of msgs) {
    const role = m?.role
    if (role === 'system') continue
    const text = typeof m?.content === 'string' ? m.content : ''
    if (role === 'user') {
      out.push(`用户：${text}`)
    } else if (role === 'assistant') {
      const tcs = Array.isArray(m.tool_calls) ? (m.tool_calls as Json[]) : []
      if (tcs.length === 0) {
        out.push(`助手：${text}`)
      } else {
        const lines = [
          `助手：${text}`.trimEnd(),
          '（助手此前轮次调用过轻驭工作台工具，这些工具不存在于本环境，仅作上下文参考）',
        ]
        for (const tc of tcs) {
          const name = typeof tc?.function?.name === 'string' ? tc.function.name : 'unknown'
          const args = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : ''
          lines.push(`- ${name} 参数：${clip(args || '{}', TOOL_ARG_CAP)}`)
        }
        out.push(lines.join('\n'))
      }
    } else if (role === 'tool') {
      const callId = typeof m?.tool_call_id === 'string' ? m.tool_call_id : ''
      out.push(`（工具 ${toolNameOf(callId, namesById)} 返回：${clip(text, TOOL_RESULT_CAP)}）`)
    }
  }

  let joined = out.join('\n\n')
  // 头部（摘要 → 记忆）在前、正文在后：头部永不截断，正文 budget = 160k − 头部长度
  // 「【此前会话进展】」标题与渲染层 src/store/useChatStore.ts（summaryBlock）双拷贝契约：
  // tsconfig 隔离无法共享常量，改动必须两处同步并跑 smoke:protocol
  const head = [summary ? `【此前会话进展】\n${summary}` : '', memory].filter(Boolean).join('\n\n')
  const budget = head ? Math.max(0, PROMPT_TOTAL_CAP - head.length) : PROMPT_TOTAL_CAP
  if (joined.length > budget) {
    const half = budget / 2
    joined = `${joined.slice(0, half)}\n（…更早对话已省略…）\n${joined.slice(-half)}`
  }
  return head ? `${head}\n\n${joined}` : joined
}

/** @internal 下一轮 Skill 请求指令（尾行协议；id 允许中文目录名） */
const NEXT_SKILL_RE = /\[\[NEXT_SKILL:\s*([^\]\n]+?)\s*\]\]\s*$/i

/** 从回复尾部提取 [[NEXT_SKILL: id1, id2]] 并剥离 */
export function extractNextSkill(text: string): { text: string; ids: string[] } {
  if (!text) return { text, ids: [] }
  const m = text.match(NEXT_SKILL_RE)
  if (!m || m.index === undefined) return { text, ids: [] }
  const ids = m[1].split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  return { text: text.slice(0, m.index).trimEnd(), ids }
}

/** @internal 从回复尾部提取 [[START_COMMANDS: ...]] 并剥离 */
export function extractStartCommands(text: string): { text: string; commands: { name: string; run: string; url?: string }[] } {
  if (!text) return { text, commands: [] }
  const m = text.match(/\[\[START_COMMANDS:\s*(\[.*\])\s*\]\]\s*$/is)
  if (!m || m.index === undefined) return { text, commands: [] }
  let commands: { name: string; run: string; url?: string }[] = []
  try {
    const parsed = JSON.parse(m[1]) as unknown
    if (Array.isArray(parsed)) {
      commands = (parsed as Record<string, unknown>[])
        .map((s) => ({
          name: String(s?.name ?? '').trim(),
          run: String(s?.run ?? '').trim(),
          url: typeof s?.url === 'string' && s.url.trim() ? s.url.trim() : undefined,
        }))
        .filter((s) => s.name && s.run)
        .slice(0, 8)
    }
  } catch {
    /* 剥离但不采纳 */
  }
  return { text: text.slice(0, m.index).trimEnd(), commands }
}

// ---------------- Skill 内联（CLI 没有 load_skill 工具，内容必须直接注入） ----------------

/** buildHistory 注入的两种加载指令形态 + 渲染层 NEXT_SKILL 附带标记（均为同仓代码，格式钉死） */
const SKILL_MULTI_RE = /请先用 load_skill 依次加载以下 \d+ 个 Skill，全部加载后再执行：([^\n]+)/g
const SKILL_SINGLE_RE = /请先用 load_skill 加载 Skill「([^」]+)」/g
const SKILL_ATTACH_RE = /\[附带 Skill：([^\]\n]+)\]/g

/** @internal 从历史消息中提取被引用的 Skill id（子目录名，去重保序） */
export function extractSkillIds(messages: unknown): string[] {
  const msgs = (Array.isArray(messages) ? messages : []) as Json[]
  const found: string[] = []
  const pushIds = (raw: string): void => {
    for (const id of raw.split(/[,，、]/)) {
      const t = id.trim()
      if (t && !found.includes(t)) found.push(t)
    }
  }
  for (const m of msgs) {
    if (typeof m?.content !== 'string') continue
    for (const re of [SKILL_MULTI_RE, SKILL_SINGLE_RE, SKILL_ATTACH_RE]) {
      const rx = new RegExp(re.source, 'g')
      for (let x = rx.exec(m.content); x; x = rx.exec(m.content)) pushIds(x[1])
    }
  }
  return found
}

const SKILL_CONTENT_CAP = 20_000 // 单个 Skill 内容上限（指令文件通常远小于此）

/** @internal 读取被引用 Skill 的完整内容，组装注入块；目录未配置/全部读取失败返回空串。
 *  多目录按序查找首个命中（skills.ts 统一入口）；readSkill 自带路径穿越守卫，id 为子目录名 */
export async function resolveSkillBlock(dirs: string[], ids: string[]): Promise<string> {
  if (dirs.length === 0 || ids.length === 0) return ''
  const parts: string[] = []
  for (const id of ids) {
    const content = await readSkillFromDirs(dirs, id)
    if (content && content.trim()) parts.push(`<skill id="${id}">\n${clip(content, SKILL_CONTENT_CAP)}\n</skill>`)
  }
  if (parts.length === 0) return ''
  return [
    '本任务的历史引用了以下「轻驭 Skill」，完整内容附下——请直接遵循其中与当前任务相关的指令，无需执行任何加载动作：',
    ...parts,
  ].join('\n\n')
}

/** @internal 可用 Skill 索引（名称+描述，排除已内联全文的）：CLI 无按需加载工具，
 *  索引让它感知可用域，并给出 [[NEXT_SKILL]] 请求通道（下一轮附带全文） */
export async function buildSkillIndex(dirs: string[], excludeIds: string[]): Promise<string> {
  if (dirs.length === 0) return ''
  const excluded = new Set(excludeIds)
  const rows: string[] = []
  for (const m of await scanSkillsDirs(dirs)) {
    if (excluded.has(m.id)) continue
    rows.push(`- ${m.id}：${m.name}${m.description ? `（${m.description}）` : ''}`)
  }
  if (rows.length === 0) return ''
  return [
    '可用 Skill 索引（仅有摘要；若某个 Skill 与任务相关，在回复最后一行输出 [[NEXT_SKILL: <id>]] 请求下一轮附带其完整内容，多个用逗号分隔。该行由系统消费、不会展示给用户）：',
    ...rows,
  ].join('\n')
}


// ---------------- 连接测试（二进制 + 版本 + 登录态） ----------------

/** 异步执行 CLI 探测命令。
 *  自定义命令前置 detectCommand 预检——路径写错时给出可读提示，不让裸的 spawn ENOENT 落到用户面前。 */
async function runCli(args: string[], timeoutMs = 10_000): Promise<{ status: number | null; stdout: string; stderr: string; error: string | null }> {
  const cliCmd = cachedCliCommand
  const avail = await detectCommand(cliCmd)
  if (avail === false) {
    const msg = cliCmd === DEFAULT_CLI_COMMAND
      ? NOT_INSTALLED_MSG
      : `未找到 CLI 命令「${cliCmd}」：请检查设置中的 Claude CLI 自定义命令`
    return { status: null, stdout: '', stderr: '', error: msg }
  }
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      // 统一走 spawnCliProcess：`cfuse -cc` 这类「可执行 + 前置参数」的自定义命令
      // 由 splitCliCommand 拆开——旧实现整串当 exe 名 → 非 Windows spawn ENOENT
      child = spawnCliProcess(cliCmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildChildEnv(),
      })
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: '', error: errorMessage(e) })
      return
    }
    let stdout = ''
    let stderr = ''
    const collect = (stream: Readable | null, on: (chunk: string) => void): void => {
      if (!stream) return
      const dec = makeCliDecoder()
      stream.on('data', (chunk: Buffer) => on(dec.decode(chunk)))
      const flushTail = (): void => {
        const tail = dec.flush()
        if (tail) on(tail)
      }
      stream.on('end', flushTail)
      stream.on('close', flushTail)
    }
    collect(child.stdout, (d) => { stdout += d })
    collect(child.stderr, (d) => { stderr += d })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 进程已不在 */ }
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ status: null, stdout: '', stderr: '', error: errorMessage(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr, error: null })
    })
  })
}

export async function testCliConnection(cliCommand?: string): Promise<string> {
  // 优先透传值：设置面板「未保存就测连接」时必须测面板里的临时值——
  // 读已存旧值会把旧命令（如 claude）当「通」误报，用户保存后被坑
  const cmd = cliCommand?.trim() || (await resolveCliCommand())
  cachedCliCommand = cmd
  // 可用性预检对默认/自定义命令一视同仁：自定义路径写错此前直接落进 spawn，
  // 报出来的是裸的 spawn ENOENT / cmd 引号错误，用户没法读
  // detectCommand 返回 null（超时/探测异常）视为不可用，不让裸的 spawn ENOENT 落到用户面前
  if ((await detectCommand(cmd)) !== true) {
    if (cmd === DEFAULT_CLI_COMMAND) throw new Error(NOT_INSTALLED_MSG)
    throw new Error(`未找到 CLI 命令「${cmd}」：请检查设置中的 Claude CLI 自定义命令（支持含空格的引号路径与附带参数）`)
  }
  const version = await runCli(['--version'])
  if (version.error) throw new Error(`claude 命令执行失败：${version.error}`)
  const versionText = version.stdout.trim().split('\n')[0] || '版本未知'

  const auth = await runCli(['auth', 'status'])
  if (auth.status === 0) return `Claude CLI 就绪 · ${versionText} · 已登录`
  const combined = `${auth.stderr}\n${auth.stdout}`
  if (/unknown|unrecognized|invalid/i.test(combined)) {
    return `Claude CLI 已安装 · ${versionText}（登录状态未知，直接对话验证）`
  }
  return `Claude CLI 已安装 · ${versionText}，但未检测到登录：请在终端运行 claude 完成登录`
}
