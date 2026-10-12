/**
 * 构建/启动输出行的启发式解析（纯函数，无 store/UI 依赖——smoke 可直接 import）。
 * 覆盖 vite / next / webpack / create-react-app 的常见输出语 + 通用服务端启动语
 * （Java/Go/Python 监听句式）+ 中文端口短语。未识别的构建工具不会误判：
 * 行级信号为空时由 useBuildStore 的 HTTP 主动探测 + 退出码路径兜底相位。
 * 扩覆盖面 = 在对应 HINTS 表补关键词（并给 smoke-build-hints 加样本行）。
 */

// 编译/构建完成 → 部署中（尚未确认监听端口）
const DEPLOY_HINTS: RegExp[] = [
  /compiled successfully/i, /webpack compiled/i, /built in/i, /transformed/i,
]

// 服务已启动/监听 → 运行中（即便无可预览 URL，如 Java / Go 后端）
export const RUN_HINTS: RegExp[] = [
  /ready in/i, /listening/i, /running on/i, /serving on/i,
  /started .* in \d/i, /started .* on port/i,
  /started (server|development|worker)/i, /server (is )?running/i,
  /accepting connections/i, /listen on/i,
]

const FATAL_HINTS: RegExp[] = [
  /failed to compile/i, /error TS\d+/i, /SyntaxError/i, /\bEADDRINUSE\b/,
  /Cannot find module/i, /Module not found/i, /^error:/im,
]

export const URL_RE = /https?:\/\/[^\s"'<>）】]+/i

/** 无完整 URL 时的高置信端口短语（仅在该行没有可归一 URL 时兜底）：
 *  - python -m http.server 旧格式「Serving HTTP on 0.0.0.0 port 8000」
 *  - 通用英文「listening/running/started … on (port) 8000」
 *  - 中文输出「端口 8000 / 监听端口: 8000」
 *  - 无协议的 host:port（0.0.0.0:8000 / localhost:3000） */
const PORT_LINE_RES: RegExp[] = [
  /serving http on [^\n]*? port (\d{1,5})/i,
  /\b(?:listening|running|serving|started|available)\b[^\n]{0,40}?\bon (?:port )?(\d{1,5})\b/i,
  /(?:端口|监听端口|端口号)[:：]?\s*(\d{1,5})/,
  /\b(?:0\.0\.0\.0|127\.0\.0\.1|localhost):(\d{1,5})\b/i,
]

/** 疑似报错/占用行：合成预览地址时跳过（防把「端口已被占用」当就绪地址） */
export function isNoiseLine(line: string): boolean {
  return /in use|占用|failed|error/i.test(line)
}

export function isFatalLine(line: string): boolean {
  return FATAL_HINTS.some((re) => re.test(line))
}

export function isRunLine(line: string): boolean {
  return RUN_HINTS.some((re) => re.test(line))
}

export function isDeployLine(line: string): boolean {
  return DEPLOY_HINTS.some((re) => re.test(line))
}

function validPort(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

export function localUrl(port: number): string {
  return `http://localhost:${port}`
}

/** 行内完整 URL → 归一（剥 ANSI、* 主机回退 localhost、只认本地主机 + 带端口） */
export function normalizeUrl(raw: string): string | null {
  try {
    const cleaned = raw
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    const parsed = new URL(cleaned.replace(/\*+/g, 'localhost'))
    const okHost =
      ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname) ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname)
    if (!okHost || !parsed.port) return null
    parsed.hostname = 'localhost'
    parsed.protocol = 'http:'
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname)
  } catch {
    return null
  }
}

/** 行内 URL（完整地址优先）：命中返回归一后的预览地址 */
export function extractLineUrl(line: string): string | null {
  const m = line.match(URL_RE)
  return m ? normalizeUrl(m[0]) : null
}

/** 行内高置信端口短语 → 预览地址（无完整 URL 时的兜底；报错/占用行不出地址） */
export function extractLineUrlFromPort(line: string): string | null {
  if (isNoiseLine(line)) return null
  for (const re of PORT_LINE_RES) {
    const pm = line.match(re)
    const port = pm ? validPort(pm[1]) : null
    if (port) return localUrl(port)
  }
  return null
}

/** 从启动命令提示端口：--port 8000 / http.server 8000 / PORT=3000 / -p 8080 / :8000
 *  （按置信度序取首个命中的最后一个）。
 *  用于「进程已运行但输出自始至终没有可识别地址」时的预览地址兜底合成 */
export function extractCommandPort(cmd: string): number | null {
  const patterns: RegExp[] = [
    /(?:^|\s)--port[= ](\d{1,5})(?:\s|$)/i,
    /\bhttp\.server\s+(\d{1,5})(?:\s|$)/i,
    /(?:^|\s)PORT=(\d{1,5})(?:\s|$)/i,
    /(?:^|\s)-p[= ](\d{1,5})(?:\s|$)/,
    /(?:^|\s):(\d{1,5})(?:\s|$)/,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    const rx = new RegExp(re.source, 'gi')
    let last: string | null = null
    while ((m = rx.exec(cmd)) !== null) {
      if (validPort(m[1])) last = m[1]
    }
    if (last) return validPort(last)
  }
  return null
}
