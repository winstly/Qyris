import { useState, type ReactNode } from 'react'
import type { ToolCall } from '@/types'
import { IconCheck, IconAlert, IconFolder, IconFile, IconPencil, IconTerminal } from '@/components/common/icons'
import { AgentToolCard } from './AgentPanel'

const TOOL_META: Record<string, { label: string; icon: ReactNode }> = {
  list_files: { label: '列出目录', icon: <IconFolder size={13} /> },
  read_file: { label: '读取文件', icon: <IconFile size={13} /> },
  write_file: { label: '写入文件', icon: <IconPencil size={13} /> },
  // CLI 工具（Claude Code 内置工具）
  Read: { label: '读取文件', icon: <IconFile size={13} /> },
  Write: { label: '写入文件', icon: <IconPencil size={13} /> },
  Glob: { label: '搜索文件', icon: <IconFolder size={13} /> },
  Grep: { label: '搜索内容', icon: <IconFile size={13} /> },
  LS: { label: '列出目录', icon: <IconFolder size={13} /> },
  Bash: { label: '执行命令', icon: <IconTerminal size={13} /> },
  Edit: { label: '编辑文件', icon: <IconPencil size={13} /> },
  WebFetch: { label: '获取网页', icon: <IconTerminal size={13} /> },
  WebSearch: { label: '搜索网络', icon: <IconTerminal size={13} /> },
}

/** 工具调用过程卡片：正在读取 xxx → 已读取 xxx（点击展开详情）。 */
export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  // 子任务编排走专用卡片（批次面板 + 实时转录）
  if (call.name === 'dispatch_subtasks') return <AgentToolCard call={call} />
  const meta = TOOL_META[call.name] ?? { label: call.name, icon: <IconTerminal size={13} /> }
  // 参数目标提取：Qyris 工具用 path/dir，CLI 工具用 file_path/command/pattern/url
  const target = String(
    call.args.path ?? call.args.dir ?? call.args.file_path ?? call.args.command
      ?? call.args.pattern ?? call.args.url ?? call.args.summary ?? '',
  ).slice(0, 120)

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
