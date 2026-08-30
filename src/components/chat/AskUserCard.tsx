import { useState } from 'react'
import { useChatStore } from '@/store/useChatStore'
import type { ToolCall } from '@/types'
import { IconCheck } from '@/components/common/icons'

/**
 * askUserQuestion 交互卡片：AI 暂停等待用户选择或输入，
 * 回答会作为工具结果回传给模型继续对话。
 */
export function AskUserCard({ call }: { call: ToolCall }) {
  const pendingAsk = useChatStore((s) => s.pendingAsk)
  const answers = useChatStore((s) => s.answers)
  const answerAsk = useChatStore((s) => s.answerAsk)
  const status = useChatStore((s) => s.status)

  const answered = answers[call.id]
  const isActive = pendingAsk?.id === call.id && status === 'awaiting-user'
  const question = String(call.args.question ?? '')
  const options = Array.isArray(call.args.options)
    ? (call.args.options as unknown[]).map(String).filter((s) => s.length > 0)
    : []
  const [freeText, setFreeText] = useState('')

  const submit = (v: string) => {
    const t = v.trim()
    if (!t || !isActive) return
    answerAsk(t)
  }

  return (
    <div className={`askcard ${answered ? 'askcard--answered' : ''}`}>
      <div className="askcard__badge">AI 需要你的回答</div>
      <div className="askcard__q">{question}</div>

      {options.length > 0 && (
        <div className="askcard__opts">
          {options.map((opt) => (
            <button
              key={opt}
              className="askcard__opt"
              disabled={!isActive}
              data-selected={answered === opt || undefined}
              onClick={() => submit(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {isActive && (
        <div className="askcard__free">
          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(freeText) }}
            placeholder={options.length ? '或输入自定义回答，回车提交' : '输入回答，回车提交'}
            autoFocus
          />
        </div>
      )}

      {answered && (
        <div className="askcard__done">
          <IconCheck size={12} /> {answered}
        </div>
      )}
    </div>
  )
}
