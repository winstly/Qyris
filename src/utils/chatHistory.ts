/**
 * OAI 历史重建（纯函数，零运行时依赖——供 useChatStore 与冒烟断言共用）。
 *
 * 工作记忆窗口化：buildHistory 不再全量
 * 重建，只取最近 HISTORY_WINDOW 条消息；被窗口截掉的更早进展由会话滚动摘要
 * （category='summary'）注入 system 区补齐。
 */
import type { ChatMessage, OAIMessage } from '@/types'
import { skillLoadInstruction, stripSkillInstruction } from '@/utils/skillInstruction'

/** 元素注入块前缀：send() 拼装时垫在消息最外层（Skill 指令与用户原文在其后） */
const ELEMENT_PREFIX = '[用户选中的预览页元素]'

/** 存储消息 → 用户原文：剥元素注入块与 Skill 指令前缀（这两段对 AI 可见，用户只看卡片）。
 *  元素块在最外层，先剥元素再剥 skill——反序剥不掉 skill 前缀。无前缀消息原样 trim 返回。 */
export function userTextOf(content: string): string {
  let rest = content
  if (rest.startsWith(ELEMENT_PREFIX)) {
    const idx = rest.indexOf('\n\n', rest.indexOf(']'))
    rest = idx >= 0 ? rest.slice(idx + 2) : ''
  }
  return stripSkillInstruction(rest).trim()
}

/** 工作记忆窗口大小（消息条数）。窗口起点回退到 user 边界时可少量超出。 */
export const HISTORY_WINDOW = 40

/**
 * 取「安全尾窗」：最多 HISTORY_WINDOW 条。
 *
 * 工具组（assistant toolCalls + toolResults）原子存储在同一条 ChatMessage 上，
 * 按消息粒度切窗天然不会把组劈开；真正要防的是窗口以 assistant 消息开头——
 * 部分厂商要求对话以 user 开始。因此起点回退到最近一条 user 消息（向前多包含，
 * 以历史重建合法性优先于 40 条硬上限）。
 */
export function windowSlice(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= HISTORY_WINDOW) return messages
  let start = messages.length - HISTORY_WINDOW
  while (start > 0 && messages[start].role !== 'user') start--
  return messages.slice(start)
}

/** 消息原数据 → OpenAI 兼容历史（Skill 指令前缀 / 工具组重建，与库内 tool_json 对齐） */
export function buildHistory(messages: ChatMessage[]): OAIMessage[] {
  const out: OAIMessage[] = []
  for (const m of windowSlice(messages)) {
    if (m.role === 'user') {
      let content = m.content
      if (m.meta?.skills?.length && !content.includes('load_skill')) {
        // 生成器唯一来源（措辞是 ai-cli 反解正则的契约），见 utils/skillInstruction.ts
        const instr = skillLoadInstruction(m.meta.skills.map((s) => s.id))
        content = content ? `${instr}\n\n${content}` : instr
      }
      out.push({ role: 'user', content })
      continue
    }
    if (m.pending) continue
    if (m.toolCalls?.length) {
      const results = m.toolResults ?? []
      if (results.length >= m.toolCalls.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((t) => ({
            id: t.id,
            type: 'function' as const,
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          })),
        })
        for (const tr of results) {
          out.push({ role: 'tool', tool_call_id: tr.toolCallId, content: tr.content })
        }
      } else {
        const lines = m.toolCalls.map((t) => {
          const tr = results.find((r) => r.toolCallId === t.id)
          return `- ${t.name}：${tr ? tr.content.slice(0, 200) : t.status === 'done' ? '（已执行）' : '（未执行，被中断）'}`
        })
        const text = [m.content, '（此前调用过工具，结果如下：）', ...lines].filter(Boolean).join('\n')
        out.push({ role: 'assistant', content: text })
      }
    } else if (m.content) {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}
