/**
 * 外部 MCP 工具管理 —— 连接池 + Tool 适配器 + 动态注册源。
 *
 * 分工：client.ts 管「一个 server 的协议」；本文件管「多个 server 的编排」——连哪些、
 * 工具叫什么名、失败怎么办、何时收割。对外只吐 Qyris Tool（tools/registry 合并进注册表），
 * 上层（runner / 提示词面 / UI）对内外工具一视同仁。
 *
 * 命名：mcp__<server>__<tool>（与 Claude Code MCP 工具名约定一致）：
 *   · 与内置工具零撞名（内置是裸名 web_search，外部永远带前缀）；
 *   · UI 经 stripMcpPrefix 剥前缀查 meta + mcp 紫兜底出工具卡；
 *   · 权限档 / 提示词面拿全名，语义无歧义。
 *
 * 池生命周期：**按 projectRoot 分域**（key = projectRoot ?? ''）——各工程的连接互不干扰，
 * 切工程 / 并行多工程对话不拆对方在途连接；每域独立 init（幂等）与收割。
 * 子进程经 proc.registerOnceProc 登记进 killTree 清理链，before-quit 统一收割（closeExternalTools）。
 * 配置表改动无需重启：ensure 按 server 表指纹惰性重建（下一条消息生效）。
 *
 * 过滤边界（fail-closed，过滤在 ai.ts / mcp/server.ts）：
 *   · 连接池住主进程；mcp-server 子进程每次补全新拉起，只注入工具元数据（stub），
 *     执行一律经 hostProxy 代行回主进程；
 *   · 连接失败的 server 其工具不进面（提示词面 = 可达面）。
 */
import type { Tool, ToolPermission, ToolResult } from '../model/types'
import { activeMcpServers, getConfig, isMcpEnabled } from '../config'
import { isExternalToolName } from './proxy'
import { connectMcpServer, type McpConnection, type McpServerEntry, type McpRemoteTool } from './client'

/** 描述截断上限：防巨型描述吃爆上下文 */
const MAX_DESCRIPTION = 2048
const TRUNCATION_MARK = '…（描述过长已截断）'
/** 工具/服务名归一：API 名字面 ^[a-zA-Z0-9_-]{1,64}$ */
const NAME_INVALID = /[^a-zA-Z0-9_-]/g
/** 注册名 = mcp__<server>__<tool>，整名须 ≤64（API 函数名约束）——两段各限 27，
 *  5 + 27 + 2 + 27 = 61；重名时在 doInit 侧加序号消歧 */
const MAX_NAME_SEGMENT = 27

export function normalizeMcpName(name: string): string {
  return name.replace(NAME_INVALID, '_').slice(0, MAX_NAME_SEGMENT)
}

/** 外部工具判别（唯一口径在 proxy.ts：网关 / 连接池 / 注册表共用） */
export { isExternalToolName }

/** 一个工程域的连接池 */
interface Pool {
  adapters: Tool[]
  connections: McpConnection[]
  /** 域内 init（幂等，可共享）；顶层失败即清空，下次 ensure 重试 */
  init: Promise<void> | null
  /** init 数据源：'config' = 读配置表；对象 = 测试注入的 server 表（引用一致视为已就绪，不重建） */
  source: 'config' | Record<string, McpServerEntry>
  /** config 源指纹（server 表序列化）：与当前配置不符 = 用户改过表 → 下次 ensure 重建该域池 */
  configFingerprint: string | null
  /** 池代次：收割时 +1，在途 doInit 发现不匹配即作废（防旧轮覆盖新池） */
  generation: number
}

/** projectRoot → 池（key = projectRoot ?? ''；无工程与「无宿主」同域） */
const pools = new Map<string, Pool>()

function poolKey(projectRoot?: string | null): string {
  return projectRoot ?? ''
}

function getPool(key: string): Pool {
  let p = pools.get(key)
  if (!p) {
    p = { adapters: [], connections: [], init: null, source: 'config', configFingerprint: null, generation: 0 }
    pools.set(key, p)
  }
  return p
}

/** server 表指纹（键序归一）：ensure 据此判断配置表是否已变、需否重建连接 */
function fingerprintServers(servers: Record<string, McpServerEntry>): string {
  return JSON.stringify(Object.entries(servers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** 已注册的外部工具（该工程域内连接成功的 server 才在列） */
export function externalTools(projectRoot?: string | null): readonly Tool[] {
  return pools.get(poolKey(projectRoot))?.adapters ?? []
}

/** 可序列化工具描述：主进程 → mcp-server 子进程的暴露面元数据（执行不随行，代行回主进程） */
export interface ExternalToolStub {
  name: string
  description: string
  inputSchema: object
  permission: ToolPermission
}

/** 主进程侧导出当前外部工具的元数据（供 mcp-config 链路注入子进程） */
export function externalToolStubs(projectRoot?: string | null): ExternalToolStub[] {
  return externalTools(projectRoot).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    permission: t.permission,
  }))
}

/**
 * 子进程侧采纳 stub：只建元数据 + 代行执行的适配器，本进程不持有任何外部连接
 * （连接池住主进程——mcp-server 每次补全新拉起，见 mcp/server.ts:161）。
 * 与 ensureExternalTools 互斥使用：ensure 供主进程（本地连接），adopt 供子进程（纯代行）。
 */
export function adoptRemoteStubs(
  stubs: readonly ExternalToolStub[],
  hostExec: (name: string, input: unknown, signal?: AbortSignal) => Promise<ToolResult>,
  projectRoot?: string | null,
): void {
  const pool = getPool(poolKey(projectRoot))
  pool.adapters = stubs
    .filter((s) => s && typeof s.name === 'string' && isExternalToolName(s.name))
    .map((s) => ({
      name: s.name,
      description: typeof s.description === 'string' ? s.description : '',
      inputSchema: s.inputSchema && typeof s.inputSchema === 'object' ? s.inputSchema : { type: 'object', properties: {} },
      permission: s.permission === 'readonly' || s.permission === 'write' || s.permission === 'exec' ? s.permission : 'exec',
      async execute(input: unknown, ctx): Promise<ToolResult> {
        if (ctx.signal?.aborted) return { content: '已取消', isError: true }
        try {
          return await hostExec(s.name, input, ctx.signal)
        } catch (e) {
          return { content: `[${s.name}] ${e instanceof Error ? e.message : String(e)}`, isError: true }
        }
      },
    }))
}

/**
 * 确保该工程域的外部工具就绪（幂等；并行调用共享同一个 init）。
 * server 面 = 全局 ∪ 当前项目（activeMcpServers：同名项目域覆盖全局域；项目域各项目独立）。
 * servers 缺省读配置；测试可注入假 server 配置（此时以引用一致判重，不按 projectRoot 重建）。
 * 配置表改动无需重启：ensure 比对 server 表指纹，变了就地重建该域池（下一条消息生效）。
 * 任何失败只降级为「该 server 工具不可用」，不 reject——对话不因外部 server 故障中断。
 */
export async function ensureExternalTools(
  projectRoot?: string | null,
  servers?: Record<string, McpServerEntry>,
): Promise<void> {
  const key = poolKey(projectRoot)
  const pool = getPool(key)
  if (pool.init) {
    if (servers) {
      if (pool.source === servers) return pool.init
    } else {
      const cfg = await getConfig()
      const fp = fingerprintServers(activeMcpServers(cfg, projectRoot))
      if (pool.source === 'config' && pool.configFingerprint === fp) return pool.init
    }
  }
  // 数据源变了（测试注入换表 / 配置表改过）：收割本域旧池后重建；他域池不受影响
  if (pool.init || pool.connections.length > 0) closePool(pool)
  pool.source = servers ?? 'config'
  const gen = ++pool.generation
  pool.init = doInit(pool, gen, projectRoot, servers).catch((e: unknown) => {
    console.warn('[mcp-external] 初始化失败，本轮无外部工具：', e)
    // 代次不匹配的失败不得清掉新池的 adapters
    if (gen === pool.generation) {
      pool.adapters = []
      // 顶层失败（如 getConfig 暂时读不到）不缓存：下次对话重试，而非锁死空池到切项目/重启
      pool.init = null
      pool.configFingerprint = null
    }
  })
  return pool.init
}

async function doInit(
  pool: Pool,
  gen: number,
  projectRoot?: string | null,
  override?: Record<string, McpServerEntry>,
): Promise<void> {
  let servers = override
  if (!servers) {
    const cfg = await getConfig()
    servers = activeMcpServers(cfg, projectRoot)
    // 指纹落池（init 成功完成时）：下次 ensure 据此跳过或重建
    if (gen === pool.generation) pool.configFingerprint = fingerprintServers(servers)
  }
  const jobs = Object.entries(servers)
    .filter(([, e]) => isMcpEnabled(e) && (e.command?.trim() || e.url?.trim()))
    .map(async ([name, entry]): Promise<Tool[]> => {
      let conn: McpConnection | null = null
      try {
        conn = await connectMcpServer(name, entry)
        const tools = await conn.listTools()
        // 代次不匹配 = 本轮已被收割作废：连接不入池，就地收掉
        if (gen !== pool.generation) {
          conn.close()
          return []
        }
        pool.connections.push(conn)
        const built = tools.map((t) => wrapTool(name, entry, conn!, t))
        // 中途断连（子进程崩/被杀）：把该 server 的工具撤出注册表，避免继续进提示词面
        const serverPrefix = `mcp__${normalizeMcpName(name)}__`
        conn.onClose = () => {
          if (gen !== pool.generation) return
          pool.adapters = pool.adapters.filter((t) => !t.name.startsWith(serverPrefix))
        }
        return built
      } catch (e) {
        // 单 server 失败不影响其他 server；连接就地收割（不进池）
        try { conn?.close() } catch { /* 进程已不在 */ }
        console.warn(`[mcp-external] server「${name}」连接失败，其工具不暴露：`, e)
        return []
      }
    })
  const nested = await Promise.allSettled(jobs)
  if (gen !== pool.generation) return // 整轮作废：不覆盖新池的 adapters
  const built = nested.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  // 归一后重名（如 web.search 与 web_search）：后到者加序号消歧，防工具面出现同名双条
  const seen = new Set<string>()
  pool.adapters = built.map((t) => {
    let name = t.name
    for (let n = 2; seen.has(name); n++) name = `${t.name.slice(0, 58)}_${n}`
    seen.add(name)
    return name === t.name ? t : { ...t, name }
  })
}

function wrapTool(serverName: string, entry: McpServerEntry, conn: McpConnection, remote: McpRemoteTool): Tool {
  const fullName = `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(remote.name)}`
  const description =
    remote.description.length > MAX_DESCRIPTION
      ? remote.description.slice(0, MAX_DESCRIPTION) + TRUNCATION_MARK
      : remote.description
  return {
    name: fullName,
    description,
    inputSchema: remote.inputSchema,
    // fail-safe：缺省 exec 档才暴露（外部 server 是用户配置的任意代码，宁可少放行）；
    // 检索类只读 server 可在配置里声明 permission: 'readonly'
    permission: entry.permission ?? 'exec',
    async execute(input: unknown, ctx): Promise<ToolResult> {
      if (ctx.signal?.aborted) return { content: '已取消', isError: true }
      try {
        return await conn.callTool(remote.name, input, ctx.signal)
      } catch (e) {
        return { content: `[${fullName}] ${e instanceof Error ? e.message : String(e)}`, isError: true }
      }
    },
  }
}

/** 收割一域连接；不传 projectRoot = 收割全部域（测试/退出用；正常退出走 proc 清理链的 killTree） */
export function closeExternalTools(projectRoot?: string | null): void {
  if (projectRoot === undefined) {
    for (const pool of pools.values()) closePool(pool)
    pools.clear()
    return
  }
  const key = poolKey(projectRoot)
  const pool = pools.get(key)
  if (!pool) return
  closePool(pool)
  pools.delete(key)
}

function closePool(pool: Pool): void {
  pool.generation++
  for (const c of pool.connections.splice(0)) {
    try {
      c.close()
    } catch {
      /* 进程已不在 */
    }
  }
  pool.adapters = []
  pool.init = null
  pool.configFingerprint = null
}

/** 测试连接（MCP 面板用）：独立建连 → tools/list → 即刻收割，不进连接池、不影响会话工具面 */
export async function testExternalServer(
  serverName: string,
  entry: McpServerEntry,
): Promise<{ ok: boolean; tools: { name: string; description: string }[]; error?: string }> {
  try {
    const conn = await connectMcpServer(serverName, entry)
    try {
      const tools = await conn.listTools()
      return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description })) }
    } finally {
      conn.close()
    }
  } catch (e) {
    return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) }
  }
}
