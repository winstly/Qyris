/**
 * 模型生态 · opencode 子进程 provider（形态对齐 claude-cli：单轮补全、无会话、无工具执行）。
 *
 * 参数面按 opencode-ai 1.18.34 的 `opencode run --help` + 实跑对齐：
 *  · 不给 message 位置参数 —— 实测 prompt 从 stdin 进（喂「菠萝蜜」回「菠萝蜜」），
 *    大体积上下文不碰 Windows 8191 命令行上限
 *  · --format json —— stdout 出 JSONL 事件流（type: step_start / text / tool_use / step_finish）
 *  · --pure —— 「run without external plugins」，等价于 claude 的净化开关
 *  · 不传 --continue / --session —— 禁止它 resume 会话，每次全量 replay 进 stdin
 *  · 不传 --auto —— 「auto-approve permissions that are not explicitly denied (dangerous!)」。
 *    实测不带它时工具写盘会被拒（state.error="The user rejected permission to use this specific tool call."），
 *    这就是 opencode 版「禁止它自己开工具」的等价开关：危险工具调用不会被自动放行
 *  · 不传 -m/--model —— 模型由 opencode 自带配置决定（契约口径：此时 capabilities.tools=false）
 *
 * 已知残留：opencode run 会在它自己的库里记一条 session（sessionID 见事件）。
 * 我们从不 --continue/--session 接回去，每次全量 replay，会话态不参与语义；仅留存储痕迹。
 */
import { createCliProvider, type CliDialect, type CliRunOptions } from './claude-cli'
import type { ModelProvider, Usage } from '../types'

type Json = Record<string, any>

export type OpencodeConfig = CliRunOptions

export function createOpencodeProvider(cfg: OpencodeConfig): ModelProvider {
  return createCliProvider(opencodeDialect, cfg)
}

const opencodeDialect: CliDialect = {
  id: 'opencode',
  defaultCommand: 'opencode',
  capabilities: {
    // 实测 1.18.34：一整段正文一个 text 事件收尾给全（20 行诗也只有 1 条 text 事件），
    // 不谎报增量能力——调用方按一次性落地渲染
    streaming: false,
    tools: false,
    thinking: false,
    jsonSchema: false, // run 没有结构化输出开关，结构化由调用方走提示词 + 解析兜底
  },
  buildArgs: () => [
    'run',
    '--format', 'json',
    '--pure',
    // 刻意不带 --continue/--session/--auto/-m，理由见文件头
  ],
  createParser: (ctx) => {
    const parts: string[] = []
    let usage: Usage | null = null
    return {
      line(raw) {
        let obj: Json
        try {
          obj = JSON.parse(raw) as Json
        } catch {
          return
        }
        const part = obj?.part as Json | undefined
        if (obj?.type === 'text' && part?.type === 'text' && typeof part.text === 'string' && part.text) {
          // 多段正文之间补分隔，保证流式片段与最终 done 文本一致
          if (parts.length > 0) ctx.emit('\n\n')
          parts.push(part.text)
          ctx.emit(part.text)
          return
        }
        // tool_use：工具调用痕迹（未放行的会被 opencode 自己拒掉）。不转 CompletionEvent，
        // 也不当我们的工具结果用——契约里 capabilities.tools=false
        if (obj?.type === 'step_finish' && part?.type === 'step-finish') {
          const t = (part.tokens ?? {}) as Json
          const cache = (t.cache ?? {}) as Json
          if (t.input != null || t.output != null) {
            usage = {
              inputTokens: num(t.input),
              // reasoning 是输出侧的思考 token，并入 output（Anthropic 口径 output_tokens 亦含思考）
              outputTokens: num(t.output) + num(t.reasoning),
              cacheReadTokens: num(cache.read),
              cacheWriteTokens: num(cache.write),
            }
          }
        }
      },
      finish: () => ({ text: parts.join('\n\n'), usage }),
    }
  },
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
