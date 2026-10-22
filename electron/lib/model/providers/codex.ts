/**
 * 模型生态 · codex provider —— app-server 通道（正文流式 + thinking）。
 *
 * 通道：`codex app-server`（stdio JSON-RPC 长驻，0.163+ 实测）。每轮 spawn 一个、
 * turn 结束即杀（无跨轮状态），与引擎「单轮补全、无会话」契约同构：
 *   initialize → initialized → thread/start → turn/start → 通知流 → turn/completed → kill
 * 词表按 0.163.0 真机实测 + 官方 app-server 文档 + `codex app-server generate-json-schema`：
 *   · 正文流式 = item/agentMessage/delta（增量追加）；item/completed 带全文兜底
 *   · 思考流式 = item/reasoning/summaryTextDelta（可读摘要，优先）/ textDelta（原始思考）
 *   · 用量 = thread/tokenUsage/updated（total.inputTokens/outputTokens/cachedInputTokens）
 *   · 收口 = turn/completed（status: completed | interrupted | failed，failed 带 error.message）
 * 审批（server→client 请求，必须应答否则 turn 挂死）：Qyris 的权限面在 qyris-tools MCP
 * （readonly/exec 档 + 工具面裁剪），codex 原生审批按权限档自动应答——
 *   · commandExecution/fileChange 审批：exec 档 accept，readonly/纯补全档 decline
 *   · mcpServer/elicitation（_meta.codex_approval_kind=mcp_tool_call）：accept（否则 MCP 工具全灭）
 *   · item/permissions/requestApproval：回 {permissions:{}}（分文不授，走 qyris-tools 面）
 * MCP 挂载：CODEX_HOME 指向本轮 scratchDir，config.toml 落盘 [mcp_servers.qyris-tools]
 * （command/args/env 全显式——env 继承被外层壳切断时 mcp-server 会以 Electron GUI 形态
 * 启动，见 2026-10-21 改造记录）；auth.json 复制进 scratch 保登录态，用完即删。
 * 沙箱：thread/start 的 sandbox 是 kebab 字符串（"workspace-write"/"read-only"——0.163 真机
 * -32600 报错口径；新版文档的驼峰写法在这版直接报错）。Windows 下 workspace-write 沙箱
 * 不可用会回落 read-only，此时原生命令走审批外逃（exec 档自动 accept）。
 * 未知 item/事件/请求一律容错忽略或空应答（tolerant：跨版本词表漂移只会少卡片，不会错渲染）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildCmdLine, splitCliCommand } from '../../cmd-quote'
import { buildChildEnv } from '../../proc-env'
import { cancelRunOnce, registerOnceProc } from '../../proc'
import { MCP_SERVER_NAME } from '../../mcp/server'
import {
  HOST_TOOL_ENV_EXCLUDE,
  HOST_TOOL_ENV_EXTERNAL_FILE,
  HOST_TOOL_ENV_INCLUDE,
  HOST_TOOL_ENV_PORT,
  HOST_TOOL_ENV_TOKEN,
} from '../../mcp/proxy'
import type { CliMcpChannel } from './claude-cli'
import type {
  CompletionEvent,
  CompletionRequest,
  Message,
  ModelProvider,
  ProviderCapabilities,
  ToolResult,
  Usage,
} from '../types'

type Json = Record<string, any>

/** 过程工具卡的挂起态（started 开卡 → completed 收口） */
interface ToolCard {
  name: string
  input: unknown
}

export interface CodexConfig {
  /** CLI 可执行文件名/路径：缺省 'codex'（支持「可执行 + 前置参数」形态） */
  cliCommand?: string
  /** 单轮看门狗（ms）：null=不限制；undefined=缺省 30 分钟 */
  timeoutMs?: number | null
  /** codex 原生工具的落点目录（shell/apply_patch 依赖 cwd）：agent 形态必须扎工程根 */
  cwd?: string | null
  /** MCP 工具通道（qyris-tools 挂载）；缺省/null = 纯补全形态（read-only 沙箱兜底） */
  mcp?: CliMcpChannel | null
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000

export function createCodexProvider(cfg: CodexConfig): ModelProvider {
  const capabilities: ProviderCapabilities = {
    streaming: true,
    // 能力面按 cfg.mcp 分叉（与 claude-cli 同构）：有通道 = codex 自持工具循环，runner 只透传
    tools: !!cfg.mcp,
    executesOwnTools: !!cfg.mcp,
    // reasoning delta 通知真实存在（app-server 通知流），thinking 过程可见
    thinking: true,
    // app-server 无 --output-schema 等价物：结构化需求走调用方降级路径
    jsonSchema: false,
  }
  return { id: 'codex', capabilities, complete: (req) => runTurn(cfg, capabilities, req) }
}

// ---------------- spawn（沿用引擎口径：Windows shell 单串 + 树杀登记） ----------------

function spawnAppServer(command: string, cwd: string | undefined, envExtra: Record<string, string>): ChildProcess {
  const args = ['app-server']
  const env = { ...buildChildEnv(), ...envExtra }
  if (process.platform === 'win32') {
    const cmdLine = buildCmdLine(command, args)
    if (cmdLine.length > 7500) throw new Error('CLI 命令行过长（Windows 上限 8191）')
    return spawn(cmdLine, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true, env })
  }
  const [exe, ...prefix] = splitCliCommand(command)
  return spawn(exe, [...prefix, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true, env })
}

// ---------------- MCP：CODEX_HOME 隔离 + config.toml 落盘 ----------------

/** config.toml 的 [mcp_servers.qyris-tools] 段。TOML literal string 单引号包裹
 * （Windows 反斜杠免转义）；env 表全显式——继承被外层壳切断时 mcp-server 会以
 * Electron GUI 形态启动（弹新窗口、消息死等，2026-10-21 真机事故）。 */
function buildMcpConfigToml(mcp: CliMcpChannel, externalToolsFile: string | null): string {
  const lit = (s: string): string => `'${s.replace(/'/g, '')}'`
  const serverArgs = [
    resolveMcpServerScript(),
    '--permission',
    mcp.permission,
    '--project-root',
    mcp.projectRoot ?? '',
    ...(mcp.origin ? ['--origin', mcp.origin] : []),
  ]
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  for (const [id, secret] of Object.entries(mcp.sshCredentials ?? {})) {
    env[`QYRIS_SSH_CRED_${id}`] = secret
  }
  if (mcp.hostProxy) {
    env[HOST_TOOL_ENV_PORT] = String(mcp.hostProxy.port)
    env[HOST_TOOL_ENV_TOKEN] = mcp.hostProxy.token
  }
  if (mcp.excludeTools?.length) env[HOST_TOOL_ENV_EXCLUDE] = mcp.excludeTools.join(',')
  if (mcp.includeTools?.length) env[HOST_TOOL_ENV_INCLUDE] = mcp.includeTools.join(',')
  if (externalToolsFile) env[HOST_TOOL_ENV_EXTERNAL_FILE] = externalToolsFile

  const lines = [`[mcp_servers.${MCP_SERVER_NAME}]`, `command = ${lit(process.execPath)}`, 'args = [']
  for (const a of serverArgs) lines.push(`  ${lit(a)},`)
  lines.push(']')
  if (Object.keys(env).length > 0) {
    lines.push(`[mcp_servers.${MCP_SERVER_NAME}.env]`)
    for (const [k, v] of Object.entries(env)) lines.push(`${lit(k)} = ${lit(v)}`)
  }
  return lines.join('\n') + '\n'
}

/** codex 会话脚本路径（asar→asar.unpacked 改写，与 claude 同口径） */
function resolveMcpServerScript(): string {
  const p = join(__dirname, 'mcp-server.js')
  return p.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1')
}

// ---------------- 单轮 turn（provider 主循环） ----------------

async function* runTurn(
  cfg: CodexConfig,
  capabilities: ProviderCapabilities,
  req: CompletionRequest,
): AsyncGenerator<CompletionEvent> {
  const scratchDir = mkdtempSync(join(tmpdir(), 'qyris-codex-as-'))
  const command = cfg.cliCommand?.trim() || 'codex'
  let session: Session | null = null
  let token: string | null = null
  let unregister: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let interrupted: 'timeout' | 'abort' | null = null

  // 事件桥：通知回调 push，主循环边到边吐（AsyncGenerator 不能在回调里 yield）
  const queue: (CompletionEvent | { type: '__turn_done' })[] = []
  let turnDone = false
  let errorText: string | null = null
  let usage: Usage | null = null
  const slots = new Map<string, { text: string; emitted: number }>()
  /** 思考流已走 summary 档的 item（summary 一到就弃 raw textDelta，防双份） */
  const reasoningSummaryMode = new Set<string>()
  /** 思考已流出的累计文本（按 item id）：completed 全文兜底时做差集，防重复/丢段 */
  const reasoningAccum = new Map<string, string>()
  const toolOpen = new Map<string, ToolCard>()
  let toolSeq = 0
  let threadId: string | null = null
  let turnId: string | null = null

  /** 同步式正文（item/completed 全文 / 旧版 item/updated 累积文本） */
  const emitText = (id: string, t: string): void => {
    if (!t) return
    let slot = slots.get(id)
    if (!slot) {
      slot = { text: '', emitted: 0 }
      slots.set(id, slot)
    }
    if (t.length > slot.text.length && t.startsWith(slot.text)) {
      const suffix = t.slice(slot.emitted)
      slot.text = t
      if (suffix) {
        queue.push({ type: 'text-delta', text: suffix })
        slot.emitted = t.length
      }
    } else if (!slot.text) {
      slot.text = t
      queue.push({ type: 'text-delta', text: t })
      slot.emitted = t.length
    }
  }

  /** 增量式正文（item/agentMessage/delta 追加碎片） */
  const appendDelta = (id: string, delta: string): void => {
    if (!delta) return
    let slot = slots.get(id)
    if (!slot) {
      slot = { text: '', emitted: 0 }
      slots.set(id, slot)
    }
    slot.text += delta
    queue.push({ type: 'text-delta', text: delta })
    slot.emitted = slot.text.length
  }

  /** 思考增量直通：textDelta/summaryTextDelta 的 delta 是本次增量，直接下发——
   *  不能走累积差分管道（会把每段砍头、短段整丢，拼出词缀乱码） */
  const emitReasoningDelta = (id: string, delta: string): void => {
    if (!delta) return
    reasoningAccum.set(id, (reasoningAccum.get(id) ?? '') + delta)
    queue.push({ type: 'reasoning-delta', text: delta })
  }

  const stopAll = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (token) cancelRunOnce(token)
    unregister?.()
    unregister = null
    // 挂起中的 RPC 立刻拒绝（不等 20s 看门狗）：initialize/thread/start 期间点停止也要秒断
    session?.failPending(new Error('已取消'))
    session?.kill()
    session = null
  }

  /** 中断收口：必须推哨兵+置位 turnDone，否则主排水循环 50ms 轮询永久挂起（停止按钮无效根因） */
  const finishInterrupted = (why: 'timeout' | 'abort'): void => {
    interrupted = why
    turnDone = true
    queue.push({ type: '__turn_done' })
  }

  const onAbort = (): void => {
    finishInterrupted('abort')
    // 优雅中断优先（turn/interrupt），树杀兜底在 stopAll
    if (session && threadId) session.notify('turn/interrupt', { threadId, ...(turnId ? { turnId } : {}) })
    stopAll()
  }

  /** codex 原生审批的自动应答档：exec 档放行原生 shell/补丁，其余档拒（权限面归 qyris-tools） */
  const allowNativeExec = !!cfg.mcp && cfg.mcp.permission !== 'readonly'

  try {
    const mcp = cfg.mcp ?? null
    if (mcp) {
      let externalToolsFile: string | null = null
      if (mcp.externalTools?.length) {
        externalToolsFile = join(scratchDir, 'external-tools.json')
        writeFileSync(externalToolsFile, JSON.stringify(mcp.externalTools), 'utf8')
      }
      // config.toml = 用户 ~/.codex/config.toml 原文 + qyris-tools 追加段。只写 MCP 段会把
      // 用户的 model_provider/model（如 ZAI 路由 + 鉴权）冲掉，codex 退回默认上游裸连
      // → 无限 Reconnecting（2026-10-22 真机事故）。表头追加对任意原文结构均合法
      const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
      const userToml = join(home, '.codex', 'config.toml')
      const userCfg = existsSync(userToml) ? readFileSync(userToml, 'utf8') : ''
      const mcpToml = buildMcpConfigToml(mcp, externalToolsFile)
      writeFileSync(join(scratchDir, 'config.toml'), (userCfg && !userCfg.endsWith('\n') ? userCfg + '\n' : userCfg) + mcpToml, 'utf8')
      // 登录态：auth.json 在缺省 CODEX_HOME 下，CODEX_HOME 换 scratch 时随身携带
      const authSrc = join(home, '.codex', 'auth.json')
      if (existsSync(authSrc)) copyFileSync(authSrc, join(scratchDir, 'auth.json'))
    }

    session = new Session(command, cfg.cwd ?? undefined, mcp ? { CODEX_HOME: scratchDir } : {}, (method, params, id) => {
      // server→client 请求必须应答，否则 codex 挂在 waitingOnApproval（turn 永不收口）
      session?.reply(id, serverRequestReply(method, params, allowNativeExec))
    })
    session.onNotification = (method, params) => {
      const e = onNotification(method, params)
      if (e) queue.push(e)
    }

    if (req.signal?.aborted) throw new Error('已取消')
    req.signal?.addEventListener('abort', onAbort, { once: true })

    await session.request('initialize', { clientInfo: { name: 'qyris', version: '0.1.0' } })
    session.notify('initialized')
    // sandbox 是 kebab 字符串（"workspace-write"/"read-only"，0.163 真机 -32600 报错口径；
    // 新版文档的驼峰 workspaceWrite 在 0.163 会直接报错）。Windows 下 workspace-write 沙箱
    // 不可用会回落 read-only，此时原生命令走审批外逃（exec 档自动 accept）
    const started = await session.request<Json>('thread/start', {
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      approvalPolicy: 'on-request',
      sandbox: mcp && mcp.permission !== 'readonly' ? 'workspace-write' : 'read-only',
    })
    threadId = (started.thread as Json | undefined)?.id ?? null
    if (!threadId) throw new Error('codex app-server 未返回 thread id')

    token = randomUUID()
    unregister = registerOnceProc(token, session.proc)
    const timeoutMs = cfg.timeoutMs === null ? null : (cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        finishInterrupted('timeout')
        stopAll()
      }, timeoutMs)
    }

    // 全量 replay：新 thread 无历史，历史走序列化正文（与 claude 档 stdin replay 同构）。
    // system 文本置顶透传：skills 内联块与通道约束都在 system/用户文本里，丢了就瞎
    const prompt = serializeTurnInput(req.messages)
    const turnStarted = await session.request<Json>('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })
    turnId = ((turnStarted.turn as Json | undefined)?.id as string | undefined) ?? null

    // 通知处理：产出事件 / 置位收口标记（onNotification 在 turn/start 前已挂）
    function onNotification(method: string, params: Json): CompletionEvent | { type: '__turn_done' } | null {
      if (method === 'item/agentMessage/delta') {
        appendDelta(String(params.itemId ?? `codex-t${++toolSeq}`), typeof params.delta === 'string' ? params.delta : '')
        return null
      }
      if (method === 'item/reasoning/summaryTextDelta') {
        const id = String(params.itemId ?? `codex-s${++toolSeq}`)
        reasoningSummaryMode.add(id)
        emitReasoningDelta(id, typeof params.delta === 'string' ? params.delta : '')
        return null
      }
      if (method === 'item/reasoning/textDelta') {
        const id = String(params.itemId ?? `codex-r${++toolSeq}`)
        if (reasoningSummaryMode.has(id)) return null // 摘要已在流式，弃原始思考防双份
        emitReasoningDelta(id, typeof params.delta === 'string' ? params.delta : '')
        return null
      }
      if (method === 'item/started' || method === 'item/updated' || method === 'item/completed') {
        const item = (params.item ?? null) as Json | null
        if (!item) return null
        const phase = method === 'item/started' ? 'started' : method === 'item/updated' ? 'updated' : 'completed'
        const id = String(item.id ?? `codex-t${++toolSeq}`)
        switch (item.type) {
          case 'agentMessage':
            // delta 为主通道，completed 全文兜底（emitText 增量吐差集）
            emitText(id, typeof item.text === 'string' ? item.text : '')
            return null
          case 'reasoning': {
            // delta 已流过：completed 全文只补差集（文本被截断重排时差集为空即忽略，deltas 是事实源）
            const accum = reasoningAccum.get(id)
            if (accum !== undefined) {
              const full = reasoningFullText(item)
              if (full.length > accum.length && full.startsWith(accum)) emitReasoningDelta(id, full.slice(accum.length))
              return null
            }
            // delta 缺失的版本兜底：completed 带全文（content 数组 / summary 数组 / 旧版 text）
            const t = reasoningFullText(item)
            if (t) emitReasoningDelta(id, t)
            return null
          }
          case 'mcpToolCall': {
            if (String(item.server ?? '') !== MCP_SERVER_NAME) return null
            const name = `mcp__${MCP_SERVER_NAME}__${String(item.tool ?? '')}`
            const input = item.arguments ?? null
            if (phase === 'completed') {
              toolOpen.delete(id)
              const ok = String(item.status ?? '') === 'completed'
              const err = (item.error as Json | undefined)?.message
              const result: ToolResult = {
                content: ok ? mcpResultText(item.result) : String(err ?? '工具调用失败'),
                isError: !ok,
              }
              return { type: 'tool-executed', id, name, input, result }
            }
            if (!toolOpen.has(id)) {
              toolOpen.set(id, { name, input })
              return { type: 'tool-progress', id, name, input }
            }
            return null
          }
          case 'commandExecution': {
            const name = 'codex.commandExecution'
            const input = item.command ?? null
            if (phase === 'completed') {
              toolOpen.delete(id)
              const out = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : typeof item.aggregated_output === 'string' ? item.aggregated_output : ''
              const result: ToolResult = { content: out, isError: String(item.status ?? '') !== 'completed' }
              return { type: 'tool-executed', id, name, input, result }
            }
            if (!toolOpen.has(id)) {
              toolOpen.set(id, { name, input })
              return { type: 'tool-progress', id, name, input }
            }
            return null
          }
          case 'fileChange': {
            const name = 'codex.fileChange'
            const input = item.changes ?? null
            if (phase === 'completed') {
              toolOpen.delete(id)
              const result: ToolResult = {
                content: input ? JSON.stringify(input) : '',
                isError: String(item.status ?? '') !== 'completed',
              }
              return { type: 'tool-executed', id, name, input, result }
            }
            if (!toolOpen.has(id)) {
              toolOpen.set(id, { name, input })
              return { type: 'tool-progress', id, name, input }
            }
            return null
          }
          case 'webSearch':
          case 'plan':
          case 'todoList': {
            const name = `codex.${item.type}`
            const input = item.query ?? item.text ?? item.command ?? item.changes ?? null
            if (phase === 'completed') {
              toolOpen.delete(id)
              const result: ToolResult = { content: typeof input === 'string' ? input : JSON.stringify(input ?? ''), isError: false }
              return { type: 'tool-executed', id, name, input, result }
            }
            if (!toolOpen.has(id)) {
              toolOpen.set(id, { name, input })
              return { type: 'tool-progress', id, name, input }
            }
            return null
          }
          default:
            return null // userMessage/未知类型：忽略（tolerant）
        }
      }
      if (method === 'thread/tokenUsage/updated') {
        // 官方用量通道：total 为该 thread 累计（camelCase 字段）
        const total = ((params.tokenUsage as Json | undefined)?.total ?? null) as Json | null
        if (total) {
          usage = {
            inputTokens: typeof total.inputTokens === 'number' ? total.inputTokens : 0,
            outputTokens: typeof total.outputTokens === 'number' ? total.outputTokens : 0,
            cacheReadTokens: typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : 0,
          }
        }
        return null
      }
      if (method === 'turn/completed') {
        const turn = (params.turn ?? {}) as Json
        const status = String(turn.status ?? 'completed')
        usage = usageOfTurn(turn) ?? usage
        if (status === 'failed') {
          const msg = (turn.error as Json | undefined)?.message
          errorText = typeof msg === 'string' && msg ? msg : 'codex turn 失败'
        }
        // interrupted：只发生在自身 abort（turn/interrupt）路径，stopAll 已收口
        turnDone = true
        return { type: '__turn_done' }
      }
      if (method === 'turn/failed') {
        // 旧版收口形态，容错保留
        const msg = (params.turn as Json | undefined)?.error?.message ?? (params.error as Json | undefined)?.message
        errorText = typeof msg === 'string' && msg ? msg : 'codex turn 失败'
        turnDone = true
        return { type: '__turn_done' }
      }
      if (method === 'error') {
        // 错误实时透思考区（重连刷屏时聊天窗有反馈）；非重连类记为收口错误
        const msg = typeof params.error?.message === 'string' && params.error.message ? params.error.message : 'codex 错误'
        queue.push({ type: 'reasoning-delta', text: `[codex] ${msg}\n` })
        if (!/reconnect|retry/i.test(msg)) errorText = msg
        return null
      }
      return null
    }

    // 主排水：队列事件边到边吐；turn 完成后先排干残留，再收哨兵收口
    while (true) {
      const e =
        queue.shift() ??
        (turnDone
          ? { type: '__turn_done' as const }
          : await new Promise<(CompletionEvent | { type: '__turn_done' }) | null>((resolve) => {
              setTimeout(() => resolve(queue.shift() ?? null), 50)
            }))
      if (!e) continue
      if (e.type === '__turn_done') break
      yield e
    }

    if (interrupted === 'timeout') throw new Error(`codex 补全超过 ${Math.round((timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)} 分钟未返回，已中止`)
    if (interrupted === 'abort') throw new Error('已取消')
    if (errorText) throw new Error(errorText)

    // done：正文 = 增量拼接（单源：app-server 无 -o 双源问题）
    const text = [...slots.values()].map((s) => s.text).join('\n\n')
    if (!text.trim()) throw new Error('codex 未返回正文（事件流已结束但无 agentMessage）')
    yield {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        meta: { provider: 'codex', usage: usage ?? { inputTokens: 0, outputTokens: 0 } },
      },
      usage: usage ?? { inputTokens: 0, outputTokens: 0 },
    }
    void capabilities
  } catch (e) {
    // abort 路径对齐 runner 口径（isAbortError 认 name）：上层静默处理，UI 不弹错误条
    if (interrupted === 'abort' || req.signal?.aborted) {
      const err = e instanceof Error && e.name === 'AbortError' ? e : new Error('已取消')
      err.name = 'AbortError'
      yield { type: 'error', error: err }
      return
    }
    yield { type: 'error', error: e instanceof Error ? e : new Error(String(e)) }
    return
  } finally {
    stopAll()
    // Windows：子进程句柄延迟释放会让立即删除抛 EPERM/ENOTEMPTY（force 只吞 ENOENT）。
    // maxRetries 让 node 对这类错误码自带退避重试；仍失败则留给 OS 清理 tmp，不阻塞交付
    try {
      rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch { /* best-effort */ }
  }
}

/** server→client 请求的自动应答（形状按 0.163 generate-json-schema） */
function serverRequestReply(method: string, params: Json, allowNativeExec: boolean): Json {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    return { decision: allowNativeExec ? 'accept' : 'decline' }
  }
  if (method === 'mcpServer/elicitation/request') {
    // 仅自动放行 MCP 工具调用审批；真表单/URL 征集一律 decline（qyris-tools 不发起）
    const kind = (params._meta as Json | undefined)?.codex_approval_kind
    return kind === 'mcp_tool_call' ? { action: 'accept', content: null } : { action: 'decline', content: null }
  }
  if (method === 'item/permissions/requestApproval') {
    return { permissions: {} } // 分文不授：权限面归 qyris-tools
  }
  return {} // 未知请求：空结果应答防挂死（tolerant）
}

/** reasoning item 兜底取全文：content 数组 → summary 数组 → 旧版 text（蛇形/驼峰都兜） */
function reasoningFullText(item: Json): string {
  const joinParts = (v: unknown): string =>
    Array.isArray(v)
      ? v
          .map((p) => (typeof p === 'string' ? p : typeof (p as Json)?.text === 'string' ? (p as Json).text : ''))
          .filter(Boolean)
          .join('\n')
      : ''
  return joinParts(item.content) || joinParts(item.summary) || (typeof item.text === 'string' ? item.text : '')
}

/** mcpToolCall result 容错取文本：字符串直用；content 数组拼 text 段；其余 JSON 化 */
function mcpResultText(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  const r = result as Json
  if (Array.isArray(r.content)) {
    return r.content
      .map((p) => (typeof p === 'string' ? p : typeof (p as Json)?.text === 'string' ? (p as Json).text : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof r.text === 'string') return r.text
  return JSON.stringify(result)
}

// ---------------- JSON-RPC Session（行泵 + pending 表 + 通知/请求分流） ----------------

class Session {
  private child: ChildProcess
  /** 树杀登记用（registerOnceProc 需要真进程句柄） */
  get proc(): ChildProcess {
    return this.child
  }
  private buf = ''
  private pending = new Map<number, { resolve: (r: Json) => void; reject: (e: Error) => void }>()
  private nextId = 1
  onNotification: (method: string, params: Json) => void = () => {}
  /** server→client 请求（审批/elicitation）：调用方算决策，这里负责回帧 */
  onRequest: (method: string, params: Json, id: number) => void = () => {}

  constructor(command: string, cwd: string | undefined, envExtra: Record<string, string>, onRequest: (method: string, params: Json, id: number) => void) {
    this.onRequest = onRequest
    this.child = spawnAppServer(command, cwd, envExtra)
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.pump(chunk))
    this.child.stderr?.on('data', () => {})
    this.child.on('error', () => {})
  }

  private pump(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let obj: Json
      try {
        obj = JSON.parse(line) as Json
      } catch {
        continue
      }
      const id = typeof obj.id === 'number' ? obj.id : null
      if (id != null && typeof obj.method === 'string') {
        // server→client 请求：带 id 带方法，必须回帧（审批挂死防线）
        this.onRequest(obj.method, (obj.params ?? {}) as Json, id)
      } else if (id != null && this.pending.has(id)) {
        const p = this.pending.get(id)!
        this.pending.delete(id)
        p.resolve(obj)
      } else if (typeof obj.method === 'string') {
        this.onNotification(obj.method, (obj.params ?? {}) as Json)
      }
    }
  }

  notify(method: string, params?: Json): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** 立刻拒绝所有挂起请求（abort/超时路径：不等看门狗，秒断） */
  failPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  /** 回 server→client 请求的帧（result 形态由调用方定） */
  reply(id: number, result: Json): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  /** 请求 + 等响应（带看门狗：server 对参数错误会静默，防调用方挂死） */
  request<T = Json>(method: string, params?: Json, timeoutMs = 20_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex app-server「${method}」${Math.round(timeoutMs / 1000)}s 无响应`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer)
          if (r.error) reject(new Error(`codex app-server「${method}」失败：${String(r.error.message ?? JSON.stringify(r.error)).slice(0, 300)}`))
          else resolve((r.result ?? {}) as T)
        },
        reject,
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private write(obj: Json): void {
    try {
      this.child.stdin?.write(JSON.stringify(obj) + '\n')
    } catch { /* EPIPE：进程早退，close 路径收口 */ }
  }

  kill(): void {
    try {
      this.child.kill()
    } catch { /* 已退出 */ }
  }
}

// ---------------- 杂项 ----------------

/** turn.usage → Usage（官方用量走 thread/tokenUsage/updated；此兜底容错旧版字段名漂移） */
function usageOfTurn(turn: Json): Usage | null {
  const u = (turn.usage ?? null) as Json | null
  if (!u) return null
  const input = u.inputTokens ?? u.input_tokens ?? u.input
  const output = u.outputTokens ?? u.output_tokens ?? u.output
  if (input == null && output == null) return null
  return {
    inputTokens: typeof input === 'number' ? input : 0,
    outputTokens: typeof output === 'number' ? output : 0,
    cacheReadTokens: typeof (u.cachedInputTokens ?? u.cached_input_tokens) === 'number' ? (u.cachedInputTokens ?? u.cached_input_tokens) : 0,
  }
}

/** 全量 replay 正文（新 thread 无历史，历史走序列化正文——与 claude 档 stdin replay 同构）。
 *  system 置顶透传：skills 内联块随消息文本走，system 里若有约束/skill 文本直接丢弃会瞎 */
function serializeTurnInput(messages: readonly Message[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const parts = Array.isArray(m.content) ? m.content : []
    const text = parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
    if (!text) continue
    if (m.role === 'system') {
      lines.push(`系统指令：\n${text}`)
      continue
    }
    lines.push(`${m.role === 'assistant' ? '助手' : '用户'}：${text}`)
  }
  return lines.join('\n\n')
}
