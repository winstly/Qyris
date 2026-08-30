import { useState, type ReactNode } from 'react'
import type { ToolCall } from '@/types'
import { IconCheck, IconAlert, IconFolder, IconFile, IconPencil, IconTerminal } from '@/components/common/icons'

const TOOL_META: Record<string, { label: string; icon: ReactNode }> = {
  list_files: { label: '列出目录', icon: <IconFolder size={13} /> },
  read_file: { label: '读取文件', icon: <IconFile size={13} /> },
  write_file: { label: '写入文件', icon: <IconPencil size={13} /> },
}

/** 工具调用过程卡片：正在读取 xxx → 已读取 xxx（点击展开详情）。 */
export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const meta = TOOL_META[call.name] ?? { label: call.name, icon: <IconTerminal size={13} /> }
  const target = String(call.args.path ?? call.args.dir ?? '')

  return (
    <button
      className={`toolcard toolcard--${call.status}`}
      onClick={() => call.result && setOpen((v) => !v)}
      aria-expanded={open}
    >
      <span className="toolcard__row">
        <span className="toolcard__icon">{meta.icon}</span>
        <span className="toolcard__text">
          {meta.label}
          {target && <code className="toolcard__target"> {target}</code>}
        </span>
        <span className="toolcard__state">
          {call.resultSummary && <span className="toolcard__summary">{call.resultSummary}</span>}
          {call.status === 'running' && <span className="spinner" aria-label="执行中" />}
          {call.status === 'done' && <IconCheck size={12} />}
          {call.status === 'error' && <IconAlert size={12} />}
        </span>
      </span>
      {open && call.result && (
        <pre className="toolcard__detail mono">{call.result}</pre>
      )}
    </button>
  )
}
