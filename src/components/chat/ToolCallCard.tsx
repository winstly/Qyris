import { useState, type ReactNode } from 'react'
import type { ToolCall } from '@/types'
import {
  IconAlert, IconBranch, IconCheck, IconCopy, IconEye, IconFile, IconFolder, IconLayers,
  IconLink, IconPencil, IconPlay, IconRefresh, IconSearch, IconSend, IconStop, IconTerminal,
} from '@/components/common/icons'
import { AgentToolCard } from './AgentPanel'

/** 剥 MCP 全名前缀（mcp__qyris-tools__run_command → run_command）：
 *  历史数据 start 事件带全名落库，查表前兜底剥除，label/kernel 不落裸全名 */
export function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__[\w-]+?__/, '')
}

export const TOOL_META: Record<string, { label: string; icon: ReactNode }> = {
  // Qyris MCP 工具（key 对齐 electron/lib/tools/*.ts 的注册名）
  list_dir: { label: '列出目录', icon: <IconFolder size={13} /> },
  read_file: { label: '读取文件', icon: <IconFile size={13} /> },
  write_file: { label: '写入文件', icon: <IconPencil size={13} /> },
  edit_file: { label: '编辑文件', icon: <IconPencil size={13} /> },
  glob: { label: '按模式找文件', icon: <IconSearch size={13} /> },
  grep: { label: '搜索内容', icon: <IconSearch size={13} /> },
  search_files: { label: '搜索文件', icon: <IconSearch size={13} /> },
  git_status: { label: 'Git 状态', icon: <IconBranch size={13} /> },
  git_diff: { label: 'Git 差异', icon: <IconBranch size={13} /> },
  git_add: { label: 'Git 暂存', icon: <IconBranch size={13} /> },
  git_commit: { label: 'Git 提交', icon: <IconBranch size={13} /> },
  run_command: { label: '执行命令', icon: <IconTerminal size={13} /> },
  load_skill: { label: '加载 Skill', icon: <IconLayers size={13} /> },
  run_project: { label: '启动项目', icon: <IconPlay size={13} /> },
  stop_project: { label: '停止项目', icon: <IconStop size={13} /> },
  get_build_status: { label: '构建状态', icon: <IconRefresh size={13} /> },
  verify_start: { label: '验证启动', icon: <IconEye size={13} /> },
  report_start_commands: { label: '上报启动命令', icon: <IconSend size={13} /> },
  update_start_command: { label: '更新启动命令', icon: <IconPencil size={13} /> },
  remote_exec: { label: '远程执行', icon: <IconLink size={13} /> },
  remote_upload: { label: '上传文件', icon: <IconCopy size={13} /> },
  update_server_tags: { label: '更新服务标签', icon: <IconSend size={13} /> },
  memory_search: { label: '搜索记忆', icon: <IconSearch size={13} /> },
  memory_save: { label: '沉淀记忆', icon: <IconPencil size={13} /> },
  memory_archive: { label: '归档记忆', icon: <IconFolder size={13} /> },
  preview_open: { label: '打开预览', icon: <IconEye size={13} /> },
  preview_console: { label: '预览控制台', icon: <IconTerminal size={13} /> },
  askUserQuestion: { label: '向用户提问', icon: <IconSend size={13} /> },
  // 渲染层 legacy 工具名（src/services/ai.ts TOOL_DEFS）：与注册名并存，历史卡与 api 档仍用旧名
  list_files: { label: '列出目录', icon: <IconFolder size={13} /> },
  grep_files: { label: '搜索内容', icon: <IconSearch size={13} /> },
  run_once: { label: '执行命令', icon: <IconTerminal size={13} /> },
  // CLI 工具（Claude Code 内置工具）
  Read: { label: '读取文件', icon: <IconFile size={13} /> },
  Write: { label: '写入文件', icon: <IconPencil size={13} /> },
  Glob: { label: '按模式找文件', icon: <IconSearch size={13} /> },
  Grep: { label: '搜索内容', icon: <IconSearch size={13} /> },
  LS: { label: '列出目录', icon: <IconFolder size={13} /> },
  Bash: { label: '执行命令', icon: <IconTerminal size={13} /> },
  PowerShell: { label: '执行命令', icon: <IconTerminal size={13} /> },
  Edit: { label: '编辑文件', icon: <IconPencil size={13} /> },
  Task: { label: '子 agent', icon: <IconBranch size={13} /> },
  Agent: { label: '子 agent', icon: <IconBranch size={13} /> },
  WebFetch: { label: '获取网页', icon: <IconTerminal size={13} /> },
  WebSearch: { label: '搜索网络', icon: <IconTerminal size={13} /> },
}

/** 五色 kernel 归类（theme-v2-chat 工具条色系）：
 *  shell 青 = 终端/远程命令 · cmd 橙 = 网络/派发/项目管理 · tool 绿 = 文件/编辑/搜索/git
 *  mcp 紫 = mcp__ 前缀兜底 · skill 蓝 = skill 字样兜底
 *  shell 不用红：红是异常/危险的语义色，命令卡占了就分不出真错误 */
export type ToolKernel = 'shell' | 'cmd' | 'tool' | 'mcp' | 'skill'

const TOOL_KERNEL: Record<string, ToolKernel> = {
  Bash: 'shell',
  PowerShell: 'shell',
  run_command: 'shell',
  remote_exec: 'shell',
  remote_upload: 'shell',
  WebFetch: 'cmd',
  WebSearch: 'cmd',
  Task: 'cmd',
  Agent: 'cmd',
  dispatch_subtasks: 'cmd',
  run_project: 'cmd',
  stop_project: 'cmd',
  get_build_status: 'cmd',
  verify_start: 'cmd',
  report_start_commands: 'cmd',
  update_start_command: 'cmd',
  list_dir: 'tool',
  read_file: 'tool',
  write_file: 'tool',
  edit_file: 'tool',
  glob: 'tool',
  grep: 'tool',
  search_files: 'tool',
  git_status: 'tool',
  git_diff: 'tool',
  git_add: 'tool',
  git_commit: 'tool',
  Read: 'tool',
  Write: 'tool',
  Edit: 'tool',
  Glob: 'tool',
  Grep: 'tool',
  LS: 'tool',
  load_skill: 'skill',
  memory_search: 'tool',
  memory_save: 'tool',
  memory_archive: 'tool',
  preview_open: 'cmd',
  preview_console: 'cmd',
  update_server_tags: 'cmd',
  askUserQuestion: 'cmd',
  list_files: 'tool',
  grep_files: 'tool',
  run_once: 'shell',
}

export function classifyKernel(rawName: string): ToolKernel {
  const name = stripMcpPrefix(rawName)
  if (TOOL_KERNEL[name]) return TOOL_KERNEL[name]
  if (rawName.startsWith('mcp__') || /mcp/i.test(rawName)) return 'mcp'
  if (/skill/i.test(name)) return 'skill'
  return 'tool'
}

/** 工具调用过程卡片：正在读取 xxx → 已读取 xxx（点击展开详情）。 */
export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const base = stripMcpPrefix(call.name)
  // 子任务编排 / CLI 子 agent 派发走专用卡片（批次面板 + 实时转录）
  if (base === 'dispatch_subtasks' || call.name === 'Agent' || call.name === 'Task') return <AgentToolCard call={call} />
  const meta = TOOL_META[base] ?? { label: base, icon: <IconTerminal size={13} /> }
  // 参数目标提取：Qyris 工具用 path/dir，CLI 工具用 file_path/command/pattern/url
  const target = String(
    call.args.path ?? call.args.dir ?? call.args.file_path ?? call.args.command
      ?? call.args.pattern ?? call.args.url ?? call.args.summary ?? '',
  ).slice(0, 120)
  const kernel = classifyKernel(call.name)

  return (
    <button
      className={`toolcard toolcard--k-${kernel} toolcard--${call.status}`}
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
          {call.status === 'running' && <span className="spinner" aria-label="执行中" />}
          {call.status === 'done' && <IconCheck size={12} />}
          {call.status === 'error' && <IconAlert size={12} />}
        </span>
      </span>
      {/* 执行期实时输出：run_command 等长命令的逐行流。运行中自动展示尾部，
          让长命令执行期聊天窗有活体反馈（否则体感是假死） */}
      {call.status === 'running' && call.output && (
        <span className="toolcard__live mono" aria-label="执行输出">
          {call.output.split('\n').slice(-8).join('\n')}
        </span>
      )}
      {open && (call.result || call.output) && (
        <pre className="toolcard__detail mono">{call.result || call.output}</pre>
      )}
    </button>
  )
}
