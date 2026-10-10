/**
 * 模型生态 · provider 注册表：按配置解析出 ModelProvider。
 *
 * 配置按家不同（apiKey/baseUrl/model 或 cliCommand），用可辨识联合表达，kind 即判别字段。
 * 新增一家 provider 只需：写 providers/xxx.ts → 在 ProviderKind / ProviderConfig / resolveProvider
 * 各补一个 case，上层（runner / 存储）零改动。
 */
import type { ModelProvider } from '../types'
import { createAnthropicProvider, type AnthropicConfig } from './anthropic'
import { createOpenAiProvider, type OpenAiConfig } from './openai'
import { createClaudeCliProvider, type ClaudeCliConfig } from './claude-cli'
import { createCodexProvider, type CodexConfig } from './codex'
import { createOpencodeProvider, type OpencodeConfig } from './opencode'

export type { AnthropicConfig, OpenAiConfig, ClaudeCliConfig, CodexConfig, OpencodeConfig }

export type ProviderKind = 'anthropic' | 'openai' | 'claude-cli' | 'codex' | 'opencode'

/** 可辨识联合：kind 判别 + 各家专属配置 */
export type ProviderConfig =
  | ({ kind: 'anthropic' } & AnthropicConfig)
  | ({ kind: 'openai' } & OpenAiConfig)
  | ({ kind: 'claude-cli' } & ClaudeCliConfig)
  | ({ kind: 'codex' } & CodexConfig)
  | ({ kind: 'opencode' } & OpencodeConfig)

export function resolveProvider(kind: ProviderKind, cfg: ProviderConfig): ModelProvider {
  if (cfg.kind !== kind) {
    throw new Error(`provider 配置不匹配：resolveProvider('${kind}') 收到 kind='${cfg.kind}' 的配置`)
  }
  switch (cfg.kind) {
    case 'anthropic':
      return createAnthropicProvider(cfg)
    case 'openai':
      return createOpenAiProvider(cfg)
    case 'claude-cli':
      return createClaudeCliProvider(cfg)
    case 'codex':
      return createCodexProvider(cfg)
    case 'opencode':
      return createOpencodeProvider(cfg)
  }
}

export function listProviders(): ProviderKind[] {
  return ['anthropic', 'openai', 'claude-cli', 'codex', 'opencode']
}
