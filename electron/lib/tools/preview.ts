/**
 * 预览面板工具：agent 能把预览指到服务地址、读取页面 console 报错。
 * 之前 run_project 起完服务，AI 既指不动预览面板、也看不到前端 console——
 * 「页面白屏/接口 404」类问题只能凭空猜。console 走 consolebridge 既有环形缓冲。
 *
 * 跨进程形态：MCP 子进程无 electron API（node-bootstrap 递归桩）——模块体一律
 * 动态 import（加载期零触达），调用期桩错误在工具层收敛为 isError，不杀进程。
 */
import { errorMessage } from '../util'
import type { Tool } from '../model/types'

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('工具入参必须是 JSON 对象')
  }
  return input as Record<string, unknown>
}

function text(rec: Record<string, unknown>, key: string): string {
  const v = rec[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v.trim()
}

function optInt(rec: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须是数字`)
  const n = Math.trunc(v)
  if (n < min || n > max) throw new Error(`参数 ${key} 需在 ${min}~${max} 之间`)
  return n
}

const previewOpen: Tool = {
  name: 'preview_open',
  description:
    '把工作台预览面板导航到指定 URL 并前置显示。本地预览服务（run_project）起好后用它打开页面给用户看；' +
    '也可以打开任意 http(s) 地址做对照。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) 地址' },
    },
    required: ['url'],
  },
  permission: 'readonly',
  async execute(input) {
    const url = text(asRecord(input), 'url')
    if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是 http(s) 地址')
    try {
      const preview = await import('../preview')
      await preview.setPreviewUrl(url)
      preview.setPreviewVisible(true)
      return { content: `[preview_open] 预览面板已打开 ${url}` }
    } catch (e) {
      return { content: `[preview_open] 预览面板不可用：${errorMessage(e)}`, isError: true }
    }
  },
}

const previewConsole: Tool = {
  name: 'preview_console',
  description:
    '读取预览面板页面的 console 输出（最近条目，缓冲上限 500 条）。排查「页面白屏 / 接口报错 / 资源 404」类问题' +
    '先读它拿真实报错，不要凭空猜测前端错误。',
  inputSchema: {
    type: 'object',
    properties: {
      level: { type: 'string', description: 'all=全部（默认）；error=仅错误；warning=错误+警告', enum: ['all', 'error', 'warning'] },
      limit: { type: 'integer', description: '返回最近条数，默认 50', minimum: 1, maximum: 200 },
    },
  },
  permission: 'readonly',
  async execute(input) {
    const rec = asRecord(input)
    const level = rec.level === 'error' || rec.level === 'warning' ? rec.level : 'all'
    const limit = optInt(rec, 'limit', 1, 200) ?? 50
    try {
      const { consoleHistory } = await import('../consolebridge')
      const hist = consoleHistory()
      const filtered = hist.filter((e) =>
        level === 'all' ? true : level === 'error' ? e.level === 'error' : e.level === 'error' || e.level === 'warning',
      )
      if (filtered.length === 0) {
        return { content: `[preview_console] 缓冲内无${level === 'all' ? '' : level + '级'}console 输出。` }
      }
      const tail = filtered.slice(-limit)
      const lines = tail.map((e) => `[${e.level}] ${e.message}${e.sourceId ? `（${e.sourceId.split('/').pop() ?? e.sourceId}）` : ''}`)
      return {
        content:
          `[preview_console] 最近 ${tail.length} 条（缓冲共 ${hist.length} 条）：\n${lines.join('\n')}` +
          (filtered.length > tail.length ? `\n（更早 ${filtered.length - tail.length} 条已省略）` : ''),
      }
    } catch (e) {
      return { content: `[preview_console] 预览面板不可用：${errorMessage(e)}`, isError: true }
    }
  },
}

/** 预览域工具集 */
export const previewTools: Tool[] = [previewOpen, previewConsole]
