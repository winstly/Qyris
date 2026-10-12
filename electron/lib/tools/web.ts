/**
 * 网络检索工具：web_search（Bing 检索）+ web_fetch（抓取网页正文）。
 * 解析、URL 安全闸与 HTTP 层在 ../webops；本层做入参校验、检索编排与结果格式化。
 *
 * web_fetch 只接受 http/https，禁本地/内网地址（字面 + DNS 复检，重定向逐跳检查）。
 * HTML 解析手写正则，不引第三方解析库；畸形 HTML 降级为部分文本，不抛异常。
 */
import type { Tool } from '../model/types'
import type { HttpOk, SearchHit } from '../webops'
import { errorMessage } from '../util'
import {
  ACCEPT_HTML,
  httpGet,
  htmlToText,
  looksBinary,
  looksLikeHtml,
  mimeOf,
  parseBingHtml,
} from '../webops'

// ---------- 常量 ----------

const SEARCH_TIMEOUT_MS = 15_000
const FETCH_TIMEOUT_MS = 20_000

const DEFAULT_RESULTS = 5
const MAX_RESULTS = 10

const FETCH_DEFAULT_CHARS = 24_000
const FETCH_MIN_CHARS = 1_000
const FETCH_MAX_CHARS = 40_000
const OUTPUT_TRUNCATION_MARK = '\n…（内容过长，已截断）'

// ---------- 入参校验（工具层本地小助手） ----------

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('工具入参必须是 JSON 对象')
  }
  return input as Record<string, unknown>
}

function text(rec: Record<string, unknown>, key: string): string {
  const v = rec[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v
}

function optInt(rec: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须是数字`)
  const n = Math.trunc(v)
  if (n < min || n > max) throw new Error(`参数 ${key} 需在 ${min}~${max} 之间`)
  return n
}

// ---------- 检索 ----------

async function searchBing(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await httpGet(
    `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=20`,
    ACCEPT_HTML,
    SEARCH_TIMEOUT_MS,
    signal,
  )
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  return parseBingHtml(res.body)
}

function dedupeKey(url: string): string {
  try {
    const u = new URL(url)
    return u.origin.toLowerCase() + u.pathname.replace(/\/+$/, '')
  } catch {
    return url
  }
}

// ---------- 工具实现 ----------

const webSearch: Tool = {
  name: 'web_search',
  description:
    '在互联网上搜索，返回标题、链接与摘要。' +
    '查资料、查报错、查 API 与库的最新信息时用它，不要凭记忆回答。' +
    'query 用简洁关键词；maxResults 默认 5（上限 10）。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      maxResults: {
        type: 'integer',
        description: '最多返回条数（去重后），默认 5，上限 10',
        minimum: 1,
        maximum: MAX_RESULTS,
      },
    },
    required: ['query'],
  },
  permission: 'readonly',
  async execute(input, ctx) {
    const rec = asRecord(input)
    const query = text(rec, 'query')
    const maxResults = optInt(rec, 'maxResults', 1, MAX_RESULTS) ?? DEFAULT_RESULTS
    if (ctx.signal?.aborted) throw new Error('搜索已被取消')

    let raw: SearchHit[]
    try {
      raw = await searchBing(query, ctx.signal)
    } catch (e) {
      return { content: `[web_search] 「${query}」\n失败：${errorMessage(e)}`, isError: true }
    }

    const hits: SearchHit[] = []
    const seen = new Set<string>()
    for (const h of raw) {
      const key = dedupeKey(h.url)
      if (seen.has(key)) continue
      seen.add(key)
      hits.push(h)
      if (hits.length >= maxResults) break
    }

    const header = `[web_search] 「${query}」· 共 ${hits.length} 条`
    if (hits.length === 0) return { content: `${header}\n\n（无结果）` }

    const body = hits
      .map((h, i) => {
        const lines = [`${i + 1}. ${h.title}`, `   ${h.url}`]
        if (h.snippet) lines.push(`   ${h.snippet}`)
        return lines.join('\n')
      })
      .join('\n\n')
    return { content: `${header}\n\n${body}` }
  },
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

const webFetch: Tool = {
  name: 'web_fetch',
  description:
    '获取指定 URL 的内容并转成纯文本（HTML 去脚本/样式/导航骨架，保留标题、正文与链接）。' +
    `仅支持 http/https，禁止本地/内网地址。默认最多 ${FETCH_DEFAULT_CHARS} 字符（最少 ${FETCH_MIN_CHARS}）。` +
    '先 web_search 找到链接再用它读详情；不要用它访问本地服务。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要获取的网页地址（仅 http/https）' },
      maxChars: {
        type: 'integer',
        description: `最多返回字符数，默认 ${FETCH_DEFAULT_CHARS}，范围 ${FETCH_MIN_CHARS}~${FETCH_MAX_CHARS}`,
        minimum: FETCH_MIN_CHARS,
        maximum: FETCH_MAX_CHARS,
      },
    },
    required: ['url'],
  },
  permission: 'readonly',
  async execute(input, ctx) {
    const rec = asRecord(input)
    const target = text(rec, 'url')
    const maxChars = optInt(rec, 'maxChars', FETCH_MIN_CHARS, FETCH_MAX_CHARS) ?? FETCH_DEFAULT_CHARS
    if (ctx.signal?.aborted) throw new Error('抓取已被取消')

    let res: HttpOk
    try {
      res = await httpGet(target, ACCEPT_HTML, FETCH_TIMEOUT_MS, ctx.signal)
    } catch (e) {
      return { content: `[web_fetch] ${target}\n失败：${errorMessage(e)}`, isError: true }
    }

    const mime = mimeOf(res.contentType)
    const treatAsHtml = mime === 'text/html' || mime === 'application/xhtml+xml' || (mime === '' && looksLikeHtml(res.body))
    const isJson = mime === 'application/json' || mime === 'text/json' || mime.endsWith('+json')
    const isTextual =
      mime.startsWith('text/') ||
      mime === 'application/xml' ||
      mime === 'application/javascript' ||
      mime === 'application/xhtml+xml' ||
      mime.endsWith('+xml') ||
      treatAsHtml

    if (looksBinary(res.body)) {
      return {
        content: `[web_fetch] ${res.url}\n失败：内容含二进制字节，无法按文本读取`,
        isError: true,
      }
    }
    if (!isTextual && !isJson && mime !== '') {
      return {
        content: `[web_fetch] ${res.url}\n失败：二进制内容（${mime || '未知类型'}），无法按文本读取`,
        isError: true,
      }
    }

    // 非 2xx 只取原始片段做预览，不做整页解析
    if (res.status < 200 || res.status >= 300) {
      const preview = res.body.slice(0, 200)
      const meta = [`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`, mime || '未知类型'].join(' · ')
      return {
        content: `[web_fetch] ${res.url}\n${meta}\n---\n${preview || '（无可读内容）'}`,
        isError: true,
      }
    }

    let title = ''
    let body: string
    if (treatAsHtml) {
      const parsed = htmlToText(res.body)
      title = parsed.title
      body = parsed.text
    } else if (isJson) {
      body = prettyJson(res.body)
    } else {
      body = res.body
    }

    const total = body.length
    const clipped = total > maxChars ? body.slice(0, maxChars) + OUTPUT_TRUNCATION_MARK : body
    const meta = [
      title ? `标题：${title}` : null,
      `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
      mime || '未知类型',
      `取 ${Math.min(total, maxChars)}/${total} 字符`,
    ]
      .filter(Boolean)
      .join(' · ')

    return {
      content: `[web_fetch] ${res.url}\n${meta}\n---\n${clipped || `（HTML 解析后无可读文本，原始 ${res.body.length} 字符）`}`,
    }
  },
}

export const webTools: Tool[] = [webSearch, webFetch]
