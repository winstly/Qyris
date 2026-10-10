/**
 * 模型生态 · codex 子进程 provider（形态对齐 claude-cli：单轮补全、无会话、无工具执行）。
 *
 * 参数面按 codex-cli 0.160.0 的 `codex exec --help` 逐条对齐（该版本实测得到）：
 *  · PROMPT 用 `-` —— 帮助原文「If not provided as an argument (or if `-` is used),
 *    instructions are read from stdin」，大体积上下文走 stdin，不碰 Windows 8191 命令行上限
 *  · --ephemeral —— 「Run without persisting session files to disk」，禁止它自己存会话
 *  · --sandbox read-only —— codex 没有「整体关停工具」的开关（--tools 仅 claude 有），
 *    只读沙箱是它给到的最强约束：工具可以读，写不进去
 *  · --skip-git-repo-check —— 补全通道 cwd 在 homedir，不该被 git 仓库检查拦死
 *  · --json —— stdout 出 JSONL 事件流
 *  · -o <file> —— 「Specifies file where the last message from the agent should be written」，
 *    最后消息落盘。这是正文的权威来源：--json 的事件形态跨版本变过（item.* 与 msg.* 两代并存），
 *    文件口径稳定，事件解析只当增量加速，解析不中也不会丢正文
 *  · --output-schema <file> —— 结构化输出走文件（而不是 claude 那种 argv 内嵌 schema），
 *    大 schema 也安全
 *
 * 残留风险（已知、非缺陷）：codex 的 exec 本身是 agent 形态，核心 shell/apply_patch 工具无开关可关。
 * 本 provider 只读沙箱 + prompt 通道约束兜住；若事件里出现 command_execution 等工具痕迹，
 * 一律不转成 CompletionEvent（契约里 capabilities.tools=false），也不会拿它的工具结果当我们的工具结果。
 */
import { readFileSync } from 'node:fs'
import { createCliProvider, type CliDialect, type CliRunOptions } from './claude-cli'
import type { ModelProvider, Usage } from '../types'

type Json = Record<string, any>

export type CodexConfig = CliRunOptions

export function createCodexProvider(cfg: CodexConfig): ModelProvider {
  return createCliProvider(codexDialect, cfg)
}

const codexDialect: CliDialect = {
  id: 'codex',
  defaultCommand: 'codex',
  capabilities: {
    // item.updated 按事件词表做前缀增量（0.160 二进制词表里存在 ItemUpdated/item.updated）；
    // 某版本若不发增量，正文会在收尾一次性落地，行为退化但不错
    streaming: true,
    tools: false,
    thinking: false,
    jsonSchema: true, // --output-schema <FILE>
  },
  buildArgs: (ctx) => {
    // 开关在前、位置参数 `-` 收尾：防 CLI 把 `-` 之后的内容当 PROMPT 尾随参数吞掉
    const args = [
      'exec',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--json',
    ]
    if (ctx.lastMessagePath) args.push('-o', ctx.lastMessagePath)
    if (ctx.jsonSchemaPath) args.push('--output-schema', ctx.jsonSchemaPath)
    args.push('-') // 显式声明从 stdin 读 prompt（不给 PROMPT 参数也行，但显式更抗版本漂移）
    return args
  },
  createParser: (ctx) => {
    // 每条 agent_message 按前缀增长吸收：item.updated 可能给碎片，也可能每条都是全量。
    // Map 保序，收尾按插入序拼回
    const slots = new Map<string, { text: string; emitted: number }>()
    let usage: Usage | null = null

    const absorb = (key: string, t: string): void => {
      if (!t) return
      let slot = slots.get(key)
      if (!slot) {
        slot = { text: '', emitted: 0 }
        slots.set(key, slot)
      }
      if (t.length > slot.text.length && t.startsWith(slot.text)) {
        const suffix = t.slice(slot.emitted)
        slot.text = t
        if (suffix) {
          ctx.emit(suffix)
          slot.emitted = t.length
        }
      } else if (!slot.text) {
        slot.text = t
        ctx.emit(t)
        slot.emitted = t.length
      }
    }

    return {
      line(raw) {
        let obj: Json
        try {
          obj = JSON.parse(raw) as Json
        } catch {
          return
        }
        // 旧形态：{"id":..,"msg":{"type":"agent_message","message":".."}}
        if (obj?.msg?.type === 'agent_message' && typeof obj.msg.message === 'string') {
          absorb(String(obj.id ?? 'default'), obj.msg.message)
          return
        }
        const item = obj?.item as Json | undefined
        if (item && (obj.type === 'item.completed' || obj.type === 'item.updated')) {
          // command_execution / function_call / local_shell_call 等工具痕迹：不吸收、不下发
          if (item.type === 'agent_message') {
            const t = typeof item.text === 'string' ? item.text : typeof item.message === 'string' ? item.message : ''
            absorb(String(item.id ?? 'default'), t)
          }
          return
        }
        const u = (obj?.usage ?? (obj?.info as Json | undefined)?.total_token_usage) as Json | undefined
        if (u) usage = usageOfCodex(u) ?? usage
      },
      finish: () => {
        // 权威正文优先取 -o 落盘（跨版本稳定）；文件为空再用事件里吸收的正文
        let fileText = ''
        try {
          if (ctx.lastMessagePath) fileText = readFileSync(ctx.lastMessagePath, 'utf8').trim()
        } catch { /* 未写出就用事件正文 */ }
        const joined = [...slots.values()].map((s) => s.text).join('\n\n')
        return { text: fileText || joined, usage }
      },
    }
  },
}

/** codex 的 usage 字段名跨版本不稳，按常见别名兜 */
function usageOfCodex(u: Json): Usage | null {
  const input = u.input_tokens ?? u.input ?? u.prompt_tokens
  const output = u.output_tokens ?? u.output ?? u.completion_tokens
  if (input == null && output == null) return null
  return {
    inputTokens: num(input),
    outputTokens: num(output),
    cacheReadTokens: num(u.cached_input_tokens ?? u.cache_read_input_tokens ?? (u.cache as Json | undefined)?.read),
    cacheWriteTokens: num(u.cache_creation_input_tokens ?? (u.cache as Json | undefined)?.write),
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
