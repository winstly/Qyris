/**
 * AI 代理 —— 模型调度分发层（adapter dispatch）。
 * 按 dispatchMode 选择 adapter 实现：
 *   'api'        → ai-api.ts（OpenAI 兼容 / Anthropic 双协议 HTTP 直连）
 *   'claude-cli' → ai-cli.ts（本机 Claude Code CLI 子进程，stream-json NDJSON 流式）
 * 渲染层契约不变：ai-delta / ai-reasoning 增量事件 + requestId 关联 + AiCompletion 终值。
 * Key 在主进程内解密直用，明文不经过渲染层。
 */
import { getSecretInternal } from './secrets'
import { getConfig } from './config'
import { abortApi, anthropicChatStream, openaiChatStream, testApiConnection, SECRET_ACCOUNT } from './ai-api'
import { claudeCliChatStream, cliCancel, testCliConnection } from './ai-cli'

export interface AiToolCall {
  id: string
  name: string
  arguments: string
}

export interface AiCompletion {
  content: string | null
  /** 模型的思考过程 / CLI 工具活动进度，有则下发 */
  reasoning: string | null
  toolCalls: AiToolCall[]
  finishReason: string | null
  /** 仅 CLI 模式：模型为下一轮对话指定的模型（已从正文剥离指令行；渲染层白名单校验后采用） */
  nextModel?: string | null
  /** 仅 CLI 模式：模型请求下一轮附带的 Skill id 列表（渲染层按已扫描索引校验后采用） */
  nextSkill?: string[]
  /** 仅 CLI 模式：模型提交的启动命令清单（AI 编译场景，已按 name/run 归一；渲染层负责落盘） */
  startCommands?: { name: string; run: string }[] | null
}

/** 请求级取消：同时覆盖两个 adapter 的在途请求（requestId 全局唯一，两表互不误伤） */
export function aiCancel(requestId: string): void {
  abortApi(requestId)
  cliCancel(requestId)
}

export async function aiChatStream(
  requestId: string, provider: string, baseUrl: string, model: string, messages: unknown, tools: unknown,
  dispatchMode: string = 'api',
  projectRoot: string | null = null,
  windowId: number | null = null,
): Promise<AiCompletion> {
  if (dispatchMode === 'claude-cli') {
    const cfg = await getConfig()
    return claudeCliChatStream(requestId, model, messages, projectRoot, cfg.aiCliPermission === 'readonly' ? 'readonly' : 'auto', cfg, windowId)
  }
  const key = await getSecretInternal(SECRET_ACCOUNT)
  if (!key) throw new Error('尚未配置 API Key，请打开设置面板填写（将存入系统 keychain）')
  if (provider === 'anthropic') {
    return anthropicChatStream(requestId, key, baseUrl, model, messages, tools)
  }
  return openaiChatStream(requestId, key, baseUrl, model, messages, tools)
}

export async function aiTestConnection(
  provider: string, baseUrl: string, model: string, dispatchMode: string = 'api',
): Promise<string> {
  if (dispatchMode === 'claude-cli') return testCliConnection()
  return testApiConnection(provider, baseUrl, model)
}
