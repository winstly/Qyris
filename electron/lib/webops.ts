/**
 * 网络检索底层：HTML 实体解码 / URL 安全闸 / HTML 转文本 / Bing 结果解析 / HTTP GET。
 * tools/web.ts 只做参数校验与结果格式化（与 fs.ts → fsops、git.ts → lib/git 同切分）。
 *
 * 只用 Node 内置模块（http / https / dns / zlib / URL / TextDecoder）——本模块同时
 * 跑在主进程与 MCP 子进程（ELECTRON_RUN_AS_NODE=1），不可用 Electron API。
 */
import http from 'node:http'
import { STATUS_CODES } from 'node:http'
import https from 'node:https'
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import zlib from 'node:zlib'

// ---------- 常量 ----------

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
export const ACCEPT_HTML = 'text/html,application/xhtml+xml'
const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8'

/** 响应体硬上限（字节）：先看 Content-Length，再流式累加超限即弃 */
const MAX_BODY_BYTES = 2_000_000
/** HTML 解析输入上限（字符）：再长先截断，圈住正则最坏耗时 */
const MAX_HTML_PARSE_CHARS = 300_000
/** 重定向跟随上限 */
const MAX_REDIRECTS = 5

// ---------- 实体解码 ----------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwnj: '',
  zwj: '',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  times: '×',
  sect: '§',
  para: '¶',
  bull: '•',
  dagger: '†',
  permil: '‰',
  deg: '°',
  plusmn: '±',
  frac12: '½',
}

/** 合法 Unicode 码点：排除 NUL 与孤立代理项（fromCodePoint 对它们不抛错，但会注入脏字符） */
function isSafeCodePoint(cp: number): boolean {
  return cp !== 0 && !(cp >= 0xd800 && cp <= 0xdfff) && cp <= 0x10ffff
}

/** HTML 实体单遍解码：命名 / 十进制 / 十六进制；未知实体与非法码点原样保留 */
export function decodeEntities(s: string): string {
  return s.replace(
    /&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g,
    (m, hex: string, dec: string, name: string) => {
      try {
        if (hex) {
          const cp = parseInt(hex, 16)
          return isSafeCodePoint(cp) ? String.fromCodePoint(cp) : m
        }
        if (dec) {
          const cp = parseInt(dec, 10)
          return isSafeCodePoint(cp) ? String.fromCodePoint(cp) : m
        }
        return NAMED_ENTITIES[name.toLowerCase()] ?? m
      } catch {
        return m
      }
    },
  )
}

// ---------- URL 安全闸 ----------

/** 点分 IPv4 判定（a.b.c.d 每段 0~255 由调用方保证，此处只查段值） */
function isBlockedIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

/** IPv6 展开成 8 组 16 位整数；非法形态返回 null */
function expandIpv6(host: string): number[] | null {
  let s = host
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  // 尾部内嵌 IPv4（::ffff:127.0.0.1 / ::127.0.0.1）折成两组十六进制
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (v4) {
    const parts = v4[1].split('.').map(Number)
    if (parts.some((n) => n > 255)) return null
    const hi = (parts[0] << 8) | parts[1]
    const lo = (parts[2] << 8) | parts[3]
    s = s.slice(0, s.length - v4[1].length) + hi.toString(16) + ':' + lo.toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - (head.length + tail.length)
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const nums: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    nums.push(parseInt(g, 16))
  }
  return nums
}

function isBlockedIpv6(host: string): boolean {
  const g = expandIpv6(host)
  if (!g) {
    // 无法展开的怪形态按拒绝处理（fail-closed）
    return true
  }
  // 回环 ::1 与未指定 ::
  if (g.every((n) => n === 0)) return true
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true
  // 唯一本地 fc00::/7、链路本地 fe80::/10、站点本地 fec0::/10 → fc/fe 全段（fc00–feff）
  if (g[0] >= 0xfc00 && g[0] <= 0xfeff) return true
  // 组播 ff00::/8
  if (g[0] >= 0xff00) return true
  // IPv4-mapped ::ffff:a.b.c.d → 查内嵌 IPv4
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return isBlockedIpv4(`${(g[6] >> 8) & 255}.${g[6] & 255}.${(g[7] >> 8) & 255}.${g[7] & 255}`)
  }
  // IPv4-compatible ::a.b.c.d（含 ::7f00:1 这类回环）
  if (g.slice(0, 6).every((n) => n === 0)) {
    return isBlockedIpv4(`${(g[6] >> 8) & 255}.${g[6] & 255}.${(g[7] >> 8) & 255}.${g[7] & 255}`)
  }
  // 6to4 2002::/16：第 2、3 组内嵌 IPv4
  if (g[0] === 0x2002) {
    return isBlockedIpv4(`${(g[1] >> 8) & 255}.${g[1] & 255}.${(g[2] >> 8) & 255}.${g[2] & 255}`)
  }
  // NAT64 64:ff9b::/96：第 7、8 组内嵌 IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) {
    return isBlockedIpv4(`${(g[6] >> 8) & 255}.${g[6] & 255}.${(g[7] >> 8) & 255}.${g[7] & 255}`)
  }
  return false
}

function isBlockedIp(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isBlockedIpv4(h)
  // 只对 IPv6 形态走 fail-closed 展开；域名串直接放行（由后缀名单 + DNS 复检管）
  if (h.includes(':') || host.includes('[')) return isBlockedIpv6(h)
  return false
}

/** http/https 白名单 + 禁本地/内网/链路本地（fail-closed，语义对齐 pathsafety.ensureInside） */
export function assertSafeUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error(`无法解析的 URL：${raw}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`仅支持 http/https，拒绝协议 ${u.protocol}`)
  }
  if (u.username || u.password) throw new Error('URL 不得内嵌用户名/密码')
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) throw new Error(`禁止访问本地/内网地址：${host}`)
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home') || h.endsWith('.lan')) {
    throw new Error(`禁止访问本地/内网地址：${host}`)
  }
  if (isBlockedIp(host)) throw new Error(`禁止访问本地/内网地址：${host}`)
  return u
}

/** 地址集过内网闸门：任一命中即抛（fail-closed）。纯函数，smoke 直测 */
export function assertAddrsSafe(hostname: string, addrs: readonly { address: string }[]): void {
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new Error(`禁止访问本地/内网地址：${hostname}（解析到 ${a.address}）`)
    }
  }
}

/**
 * 连接期 DNS 守卫（net/tls 的 lookup 钩子）。回调返回的地址就是 socket 实际拨号目标，
 * 校验与拨号在同一次解析内完成——不存在「先校验、再二次解析建连」的窗口。
 * 解析出的每个地址都过闸门，任一命中即整批拒绝。
 */
function safeLookup(
  hostname: string,
  options: LookupOptions & { all?: boolean },
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { family: options.family, hints: options.hints, all: true, verbatim: true }, (err, addrs) => {
    // 出错时第二参数被 net 忽略，仅为满足 LookupFunction 签名
    if (err) return callback(err, '')
    const list: LookupAddress[] = Array.isArray(addrs) ? addrs : [{ address: String(addrs), family: 4 }]
    if (list.length === 0) {
      const e: NodeJS.ErrnoException = new Error(`无法解析主机名：${hostname}`)
      e.code = 'ENOTFOUND'
      return callback(e, '')
    }
    try {
      assertAddrsSafe(hostname, list)
    } catch (e) {
      const gate: NodeJS.ErrnoException = e instanceof Error ? e : new Error(String(e))
      gate.code = 'EACCES'
      return callback(gate, '')
    }
    if (options.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

// ---------- 纯函数（smoke 直测） ----------

/** 一条搜索结果 */
export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** 去标签 + 实体解码 + 空白折叠，按上限截断（标题/摘要用） */
function cleanSnippet(raw: string, cap: number): string {
  const t = decodeEntities(String(raw).replace(/<[^>]*$/g, '').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > cap ? `${t.slice(0, cap)}…` : t
}

/** Bing 结果解析（li.b_algo 块；摘要取 </h2> 之后首个 <p>） */
export function parseBingHtml(html: string): SearchHit[] {
  const out: SearchHit[] = []
  for (const block of html.split(/<li\s+class="[^"]*\bb_algo\b/i).slice(1)) {
    const body = block.split(/<\/li\s*>/i)[0]
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2\s*>/i.exec(body)
    if (!h2) continue
    const a = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i.exec(h2[1])
    if (!a) continue
    // 只认空白后的 href（排除 data-href / v-bind:href 等变体）；单双引号都收
    const hm = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(a[1])
    if (!hm) continue
    const url = decodeEntities(hm[1] ?? hm[2] ?? hm[3] ?? '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    const title = cleanSnippet(a[2], 120)
    if (!title) continue
    const after = body.slice(h2.index + h2[0].length)
    const p = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/i.exec(after)
    out.push({ title, url, snippet: p ? cleanSnippet(p[1], 300) : '' })
  }
  return out
}

/** 属性形态：name=value 或已知布尔属性裸名；不合形态的「属性」按正文算（挡 x<y and y>z 误伤） */
const ATTR_SRC = String.raw`(?:\s+[a-zA-Z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)|\s+(?:allow|async|autofocus|autoplay|checked|controls|default|defer|disabled|hidden|inert|ismap|loop|multiple|muted|nomodule|novalidate|open|playsinline|readonly|required|reversed|selected))`

/** 标签形态：名字 + 合法属性形态 + > */
const TAG_RE = new RegExp(String.raw`<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:${ATTR_SRC})*\s*/?>`, 'g')

/** HTML → 标题 + 纯文本。实体只在最后一步解码一次 */
export function htmlToText(html: string): { title: string; text: string } {
  const src = html.length > MAX_HTML_PARSE_CHARS ? html.slice(0, MAX_HTML_PARSE_CHARS) : html
  const title = decodeEntities(
    (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim(),
  )
  let s = src.replace(/\r\n?/g, '\n')

  // 注释与不可见/非正文块
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<![a-zA-Z][^>]*>/g, '')
  s = s.replace(
    new RegExp(String.raw`<(script|style|noscript|svg|iframe|template|object|embed)\b(?:${ATTR_SRC})*\s*>[\s\S]*?<\/\1\s*>`, 'gi'),
    '',
  )

  // 骨架块整块丢弃；header 保留
  s = s.replace(
    new RegExp(String.raw`<(nav|footer|aside|form)\b(?:${ATTR_SRC})*\s*>[\s\S]*?<\/\1\s*>`, 'gi'),
    '',
  )

  // 链接 → 文本 (URL)：先切出属性串，再从中取空白后的 href（data-href 不抢位；捕获不能放在量词循环里）
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
    const hm = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/.exec(attrs)
    const href = (hm?.[1] ?? hm?.[2] ?? hm?.[3] ?? '').trim()
    const innerText = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) return innerText
    return innerText && innerText !== href ? `${innerText} (${href})` : href
  })

  // 块级 → 换行；表格单元 → 制表符
  s = s.replace(new RegExp(String.raw`<br\s*/?>`, 'gi'), '\n')
  s = s.replace(
    new RegExp(
      String.raw`<\/?(?:p|h[1-6]|div|section|article|main|blockquote|pre|hr|li|tr|ul|ol|table|dl|dt|dd)\b(?:${ATTR_SRC})*\s*/?>`,
      'gi',
    ),
    '\n',
  )
  s = s.replace(new RegExp(String.raw`<\/?(?:td|th)\b(?:${ATTR_SRC})*\s*/?>`, 'gi'), '\t')

  // 其余标签丢弃
  s = s.replace(TAG_RE, '')

  // 实体单遍解码
  s = decodeEntities(s)

  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n')
  return { title, text: s.trim() }
}

// ---------- 正文形态判定 ----------

/** Content-Type 主类型（去参数、小写） */
export function mimeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase()
}

/** 含 NUL 视作二进制 */
export function looksBinary(body: string): boolean {
  return body.indexOf(String.fromCharCode(0)) >= 0
}

export function looksLikeHtml(body: string): boolean {
  return /^\s*<(!doctype|html|head|body|div|p|h[1-6]|main|article|section)/i.test(body)
}

// ---------- HTTP 层 ----------

export interface HttpOk {
  status: number
  statusText: string
  /** 重定向后的最终 URL */
  url: string
  contentType: string
  body: string
}

function decodeBody(buf: Uint8Array, contentType: string): string {
  const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1]?.replace(/["']/g, '') ?? 'utf-8'
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

/** 流式读响应体（按解压后大小计），超 maxBytes 即中止并弃流 */
function readBodyCapped(res: http.IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const declared = Number(res.headers['content-length'] ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy()
      reject(new Error(`内容过大（>${maxBytes} 字节），已拒绝`))
      return
    }
    const enc = String(res.headers['content-encoding'] ?? '').toLowerCase()
    let src: NodeJS.ReadableStream = res
    if (enc === 'gzip' || enc === 'x-gzip') src = res.pipe(zlib.createGunzip())
    else if (enc === 'deflate') src = res.pipe(zlib.createInflate())
    else if (enc === 'br') src = res.pipe(zlib.createBrotliDecompress())

    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    src.on('data', (c: Buffer) => {
      total += c.length
      if (total > maxBytes) {
        res.destroy()
        settle(() => reject(new Error(`内容过大（>${maxBytes} 字节），已拒绝`)))
        return
      }
      chunks.push(c)
    })
    src.on('end', () => settle(() => resolve(new Uint8Array(Buffer.concat(chunks)))))
    src.on('error', (e: Error) => {
      res.destroy()
      settle(() => reject(e))
    })
  })
}

/** 单跳请求：lookup 守卫在建连时生效，重定向由调用方逐跳复检 */
function requestOnce(
  target: URL,
  accept: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ status: number; statusText: string; contentType: string; location: string | null; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:'
    const mod = isHttps ? https : http
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        lookup: safeLookup,
        signal,
        headers: {
          'User-Agent': UA,
          'Accept-Language': ACCEPT_LANGUAGE,
          Accept: accept,
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location ? String(res.headers.location) : null
        // 重定向体不读，直接弃流
        if (status >= 300 && status < 400) {
          res.destroy()
          resolve({
            status,
            statusText: STATUS_CODES[status] ?? '',
            contentType: '',
            location,
            body: new Uint8Array(0),
          })
          return
        }
        readBodyCapped(res, maxBytes).then(
          (body) =>
            resolve({
              status,
              statusText: STATUS_CODES[status] ?? '',
              contentType: String(res.headers['content-type'] ?? ''),
              location,
              body,
            }),
          reject,
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** 网络错误粗分类：不回传 errno/端口细节，避免工具被当内网端口扫描器用 */
function netErrText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.startsWith('禁止访问') || msg.startsWith('仅支持') || msg.startsWith('无法解析') || msg.startsWith('URL 不得')) {
    return msg
  }
  if (msg.startsWith('超时') || msg.startsWith('请求已被取消') || msg.startsWith('内容过大') || msg.startsWith('重定向过多')) {
    return msg
  }
  return '网络请求失败（连接错误或域名解析失败）'
}

/** GET：字面闸门 → 逐跳建连（lookup 守卫在建连时校验解析结果）→ 限长读取 → 按 charset 解码 */
export async function httpGet(
  rawUrl: string,
  accept: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpOk> {
  if (signal?.aborted) throw new Error('请求已被取消')
  let target = assertSafeUrl(rawUrl)
  const controller = new AbortController()
  let timedOut = false
  let aborted = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => {
    aborted = true
    controller.abort()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const fail = (e: unknown): Error => {
    if (aborted) return new Error('请求已被取消')
    if (timedOut) return new Error(`超时（>${timeoutMs}ms）`)
    return new Error(netErrText(e))
  }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res: Awaited<ReturnType<typeof requestOnce>>
      try {
        res = await requestOnce(target, accept, controller.signal, MAX_BODY_BYTES)
      } catch (e) {
        throw fail(e)
      }
      // 重定向逐跳闸门：下一跳 URL 同样过字面闸门，建连时再过解析闸门
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) throw new Error(`HTTP ${res.status} 无 Location 无法跟随`)
        try {
          target = assertSafeUrl(new URL(res.location, target).toString())
        } catch (e) {
          throw fail(e)
        }
        continue
      }
      let body: string
      try {
        body = decodeBody(res.body, res.contentType)
      } catch (e) {
        throw fail(e)
      }
      return { status: res.status, statusText: res.statusText, url: target.toString(), contentType: res.contentType, body }
    }
    throw new Error(`重定向过多（>${MAX_REDIRECTS} 次）`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
