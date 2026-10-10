/**
 * ModelProvider 统一构造入口 —— 主对话与子 agent 共用同一套「模型是服务」的解析。
 *
 * 子 agent 只是独立 session（自己的 ConversationStore / 工具面 / 事件出口），
 * 不是另一种模型通道：provider 构造必须与主对话一字不差，否则子 agent 会掉进
 * 「纯补全形态」降级（--max-turns 1 + 无工具），而子 agent 系统提示却在教它用工具
 * ——模型一调用就 error_max_turns（线上实测形态）。
 *
 * claude-cli 档在「要工具」时挂 MCP 通道（ClaudeCliConfig.mcp）：工具面经 MCP 由本仓
 * ToolRegistry 执行（providers/claude-cli.ts + lib/mcp/server.ts），provider 转为
 * executesOwnTools 模式，runner 走透传。纯补全调用（wantTools=false，如上下文压缩）
 * 不挂 MCP——少一份 mcp-config 落盘与 MCP server 进程。
 */
import { getConfig, type AppConfig } from '../config'
import { getSecretInternal } from '../secrets'
import { SECRET_ACCOUNT } from '../ai-api'
import { detectCommand } from '../proc'
import { resolveProvider, type ProviderKind } from './providers/registry'
import type { HostToolProxyTarget } from '../mcp/proxy'
import type { ModelProvider, ToolPermission } from './types'

const NOT_INSTALLED_MSG =
  '未找到 claude 命令：请先安装 Claude Code CLI（npm install -g @anthropic-ai/claude-code）并在终端完成登录后重试'

/**
 * MCP 通道 SSH 凭据注入：remote_exec/remote_upload 在 mcp-server 子进程执行，该进程是纯
 * Node 形态、无 safeStorage，secrets 解密不可用。主进程在此解密好凭据，经 mcp-config 的 env
 * 单向注入；子进程出口由 buildChildEnv 统一剥离（run_command 等模型可见的工具读不到）。
 * 仅 exec 档会话注入——低档会话不暴露 remote_* 工具。
 */
async function sshCredentialEnv(permission: ToolPermission): Promise<Record<string, string>> {
  if (permission !== 'exec') return {}
  const servers = (await getConfig().catch(() => null))?.deployServers ?? []
  const out: Record<string, string> = {}
  for (const s of servers) {
    const secret = await getSecretInternal(`ssh:${s.id}`).catch(() => null)
    if (secret) out[s.id] = secret
  }
  return out
}

export interface ResolveChatProviderOptions {
  dispatchMode: string
  /** API 档 provider 名（anthropic / openai 子串判定）；CLI 档忽略 */
  provider: string
  /** API 档 Base URL；CLI 档忽略 */
  baseUrl: string
  /** API 档模型名（子 agent 可传档位模型）；CLI 档忽略——模型由 claude 自带配置决定 */
  model: string
  projectRoot: string | null
  cfg: AppConfig | null
  permission: ToolPermission
  /** 「要不要工具」是调用方意图：false = 纯补全（上下文压缩等），不挂 MCP */
  wantTools: boolean
  /** 主进程代行通道（编排/主进程单例类工具回主进程执行）；null = MCP 面不暴露这些工具 */
  hostProxy: HostToolProxyTarget | null
  /** MCP 面额外剔除的工具名（子 session 禁嵌套派发时传 ['dispatch_subtasks']） */
  excludeTools?: readonly string[]
  /** 工具循环轮数上限覆盖（CLI 落为 --max-turns）：子 agent 传 aiSubagentMaxTurns；
   *  不传则用 cfg.aiMaxTurns。getConfig 已归一，这里不再钳制 */
  maxTurns?: number | null
}

/** 按请求参数解析 ModelProvider（API 档按 provider 分流 anthropic / openai；CLI 档走 claude-cli）。
 *  换 Codex / OpenCode 只改这里的 kind，上层零改动——这正是「模型是服务」的验收点。 */
export async function resolveChatProvider(opts: ResolveChatProviderOptions): Promise<ModelProvider> {
  const {
    dispatchMode, provider, baseUrl, model, projectRoot, cfg,
    permission, wantTools, hostProxy, excludeTools = [], maxTurns: maxTurnsOverride,
  } = opts
  if (dispatchMode === 'claude-cli') {
    const cliCommand = (cfg?.aiCliCommand || 'claude').trim() || 'claude'
    // 工具循环轮数上限：子 agent 传 aiSubagentMaxTurns 覆盖，主对话用 aiMaxTurns（getConfig 已归一）
    const maxTurns = maxTurnsOverride ?? cfg?.aiMaxTurns ?? undefined
    // 可用性预检：自定义路径写错时给出可读提示，不让裸的 spawn ENOENT 落到用户面前
    // （detectCommand 返回 null = 超时/探测异常，同样按不可用处理）
    if ((await detectCommand(cliCommand)) !== true) {
      if (cliCommand === 'claude') throw new Error(NOT_INSTALLED_MSG)
      throw new Error(`未找到 CLI 命令「${cliCommand}」：请检查设置中的 Claude CLI 自定义命令（支持含空格的引号路径与附带参数）`)
    }
    return resolveProvider('claude-cli', {
      kind: 'claude-cli',
      cliCommand,
      maxTurns,
      // 旧链路 CLI_TIMEOUT_MS=30 分钟：单轮补全沿用同一水位，长思考不被 10 分钟缺省掐掉
      timeoutMs: 30 * 60_000,
      cwd: projectRoot,
      ...(wantTools
        ? {
            mcp: {
              permission,
              projectRoot,
              sshCredentials: await sshCredentialEnv(permission),
              hostProxy,
              ...(excludeTools.length > 0 ? { excludeTools } : {}),
            },
          }
        : {}),
    })
  }
  const key = await getSecretInternal(SECRET_ACCOUNT).catch(() => null)
  if (!key) throw new Error('尚未配置 API Key，请打开设置面板填写（将存入系统 keychain）')
  if (!baseUrl || !model) throw new Error('API 配置不完整（未设置 Base URL 或模型）')
  const kind: ProviderKind = (provider ?? '').toLowerCase().includes('anthropic') ? 'anthropic' : 'openai'
  return resolveProvider(kind, { kind, apiKey: key, baseUrl, model })
}
