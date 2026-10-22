/**
 * codex provider 真机端到端（两相）：
 * ① 纯补全形态（mcp:null，read-only 沙箱）：thread → 正文流式 delta → done。
 * ② agent 形态（readonly 档挂 qyris-tools）：验证 scratch config.toml 合并用户
 *    ~/.codex/config.toml 后上游路由正确（ZAI）+ MCP 工具真调用全链。
 * 前置：本机 codex 已安装已登录（带网络与模型用量）。
 * ⚠️ 必须 bundle 到 out/main 运行（npm run e2e:codex）：resolveMcpServerScript 按
 *    __dirname 找 mcp-server.js，产品路径 = out/main——验证路径与产品路径不许分叉。
 */
import { createCodexProvider } from '../electron/lib/model/providers/codex'
import type { CompletionEvent, Message } from '../electron/lib/model/types'

async function runOnce(label: string, messages: readonly Message[], mcp: Parameters<typeof createCodexProvider>[0]['mcp'], signal?: AbortSignal): Promise<{ reasoningChars: number; reasoningSample: string } | null> {
  const provider = createCodexProvider({ cliCommand: 'codex', timeoutMs: null, cwd: process.cwd(), mcp: mcp ?? null })
  const t0 = Date.now()
  let text = ''
  let streamed = 0
  let reasoningChunks = 0
  let reasoningChars = 0
  let reasoningSample = ''
  let toolProgress = 0
  let toolExecuted = 0
  let usage: unknown = null
  for await (const e of provider.complete({ messages, signal }) as AsyncIterable<CompletionEvent>) {
    if (e.type === 'text-delta') {
      text += e.text
      streamed++
      process.stdout.write(e.text)
    } else if (e.type === 'reasoning-delta') {
      reasoningChunks++
      reasoningChars += e.text.length
      if (!reasoningSample && e.text.trim()) reasoningSample = e.text.trim().slice(0, 80)
    } else if (e.type === 'tool-progress') {
      toolProgress++
    } else if (e.type === 'tool-executed') {
      toolExecuted++
      console.log(`\n  [tool] ${e.name} isError=${String(e.result.isError)} content=${JSON.stringify(e.result.content).slice(0, 120)}`)
    } else if (e.type === 'done') {
      usage = e.usage
    } else if (e.type === 'error') {
      if (signal?.aborted && e.error.name === 'AbortError') {
        console.log(`\n--- ${label}：abort 正确收口（AbortError）`)
        return { reasoningChars, reasoningSample }
      }
      console.error(`\n${label} 失败：`, e.error.message)
      process.exit(1)
    }
  }
  console.log(
    `\n--- ${label}：${((Date.now() - t0) / 1000).toFixed(1)}s · 正文增量 ${streamed} 段 · 思考 ${reasoningChunks} 段/${reasoningChars} 字 · 工具进行 ${toolProgress} / 收口 ${toolExecuted} · usage ${JSON.stringify(usage)}`,
  )
  if (reasoningSample) console.log(`    思考样本：${reasoningSample}`)
  if (!text.trim()) {
    console.error(`${label} 失败：无正文`)
    process.exit(1)
  }
  return { reasoningChars, reasoningSample }
}

async function main(): Promise<void> {
  await runOnce('纯补全', [{ role: 'user', content: [{ type: 'text', text: '请只回复四个字：链路畅通' }] }], undefined)

  await runOnce(
    'agent 形态（readonly 档 MCP）',
    [{ role: 'user', content: [{ type: 'text', text: '调用 list_dir 工具查看当前目录（path 传 .），拿到结果后只回复：工具通' }] }],
    { permission: 'readonly', projectRoot: process.cwd() },
  )

  // ③ 停止链路：长任务 800ms 后 abort，3s 内必须收口（停止按钮无效回归防线）
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 800)
  const t0 = Date.now()
  await runOnce('停止链路', [{ role: 'user', content: [{ type: 'text', text: '写一篇 2000 字的散文，主题：秋天的算法' }] }], undefined, ctrl.signal)
  const dt = Date.now() - t0
  if (dt > 3000) {
    console.error(`停止链路失败：abort 后 ${dt}ms 才收口（>3s，疑似主循环挂死）`)
    process.exit(1)
  }
  console.log(`停止链路收口耗时 ${(dt / 1000).toFixed(1)}s ✓`)
  console.log('E2E 全部通过')
}

void main().catch((e) => {
  console.error('e2e 崩溃：', e)
  process.exit(1)
})
