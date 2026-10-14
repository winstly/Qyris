/** 非敏感配置持久化（userData/config.json）。API Key 不入此文件（走 secrets）。 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { errorMessage } from './util'
import { storageDir } from './storage'
import type { McpServerEntry } from './mcp/client'
import { Emitter } from '../../shared/base/event'
import type { IDisposable } from '../../shared/base/lifecycle'

/** 配置类型簇（AppConfig / RecentProject / StartCommand / DeployServer）：
 *  唯一定义在 shared/app-config.ts，此处再导出供主进程消费 */
import type { AppConfig, DeployServer, ModelTiers, RecentProject, StartCommand } from '../../shared/app-config'
export type { AppConfig, DeployServer, ModelTiers, RecentProject, StartCommand }


/** 新数组字段 + 旧单目录字段合并去重（旧字段排前，保持存量用户主目录序） */
function mergeSkillDirs(list: unknown, legacy: unknown): string[] {
  const out: string[] = []
  for (const raw of [legacy, ...(Array.isArray(list) ? list : [])]) {
    if (typeof raw !== 'string') continue
    const t = raw.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** 记忆整理轮次归一：合法区间 2..60，非法/越界回 undefined（消费方取缺省 6） */
function clampRounds(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.floor(v)
  if (n < 2 || n > 60) return undefined
  return n
}

/** 上下文压缩阈值归一：合法区间 64000..512000，非法/越界回 undefined（消费方取缺省 256000） */
function clampCompressThreshold(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.floor(v)
  if (n < 64000 || n > 512000) return undefined
  return n
}

/** 主对话工具循环轮数归一：合法区间 4..500，非法回 null（消费方取缺省 60） */
function clampMaxTurns(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const n = Math.floor(v)
  return n >= 4 ? Math.min(500, n) : null
}

/** 子 agent 工具循环轮数归一：合法区间 2..200，非法回 null（消费方取缺省 20） */
function clampSubagentMaxTurns(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const n = Math.floor(v)
  return n >= 2 ? Math.min(200, n) : null
}

/** 内存缓存：getConfig 被热路径频繁调用（memorySearch / embed / memAgent），避免每次读磁盘+JSON.parse */
let configCache: AppConfig | null = null
let configCacheAt = 0
const CONFIG_CACHE_TTL = 2000 // 2s TTL，mergeConfig/setConfig 时主动清失效

function invalidateConfigCache(): void { configCache = null; configCacheAt = 0 }

/** 外部 MCP server 表归一（冒烟直接引用）：单条非法只丢该条、不拖垮整体。
 *  形状对齐 MCP 配置规范（stdio / Streamable HTTP 两型）；未知字段（options/transport/
 *  autoApprove…）原样保留——导入/编辑 round-trip 不丢字段。
 *  名字面跳过 __proto__/constructor/prototype：普通对象字面量上的 out[key]= 会走原型
 *  setter（改原型而不是建自有键），条目静默消失。 */
export function sanitizeMcpServers(raw: unknown): Record<string, McpServerEntry> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
  const strMap = (v: unknown): Record<string, string> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
        )
      : undefined
  const out: Record<string, McpServerEntry> = {}
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = name.trim()
    if (!key || FORBIDDEN_KEYS.has(key) || !v || typeof v !== 'object' || Array.isArray(v)) continue
    const e = v as Record<string, unknown>
    const command = typeof e.command === 'string' ? e.command.trim() : ''
    const url = typeof e.url === 'string' ? e.url.trim() : ''
    // stdio 要 command；streamableHttp 要 url；两者皆无 → 丢该条
    if (!command && !url) continue
    const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : undefined
    const env = strMap(e.env)
    const headers = strMap(e.headers)
    const cwd = typeof e.cwd === 'string' && e.cwd.trim() ? e.cwd.trim() : undefined
    const description = typeof e.description === 'string' && e.description.trim() ? e.description.trim() : undefined
    const type = e.type === 'stdio' || e.type === 'streamableHttp' || e.type === 'http' ? e.type : undefined
    const permission = e.permission === 'readonly' || e.permission === 'write' || e.permission === 'exec' ? e.permission : undefined
    const timeoutMs =
      typeof e.timeoutMs === 'number' && Number.isFinite(e.timeoutMs) && e.timeoutMs >= 1000 ? Math.floor(e.timeoutMs) : undefined
    // 未知字段保留（options/transport/autoApprove 等），已归一字段覆盖
    const {
      command: _c, url: _u, args: _a, env: _e, headers: _h, cwd: _w, description: _d,
      type: _t, permission: _p, timeoutMs: _m, enabled: _en, disabled: _dis, ...rest
    } = e
    out[key] = {
      ...(rest as Record<string, unknown>),
      ...(type ? { type } : {}),
      ...(command ? { command } : {}),
      ...(url ? { url } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(description ? { description } : {}),
      // 启停只落 disabled 一个字段：历史 enabled:false 口径在读入时归一，写侧不再产生双开关
      ...(e.disabled === true || e.enabled === false ? { disabled: true } : {}),
      ...(permission ? { permission } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    } as McpServerEntry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

import { projectConfigKey } from '../../shared/project-key'
import { isMcpEnabled } from '../../shared/mcp'

/** 项目键归一（与 watcher.ts normPath / proc.ts runOnce 同口径）：见 shared/project-key.ts */
export { projectConfigKey }

/** MCP server 启停判别唯一口径：见 shared/mcp.ts */
export { isMcpEnabled }

/** 项目级发布数据取数：只认 deployServersMap[projectKey]，不做跨项目/全局回退。
 *  legacy 全局字段仅存档在 config.json，不外露到任何项目。
 *  归一键优先、原键兜底（兼容归一化之前写入的条目） */
export function projectDeployServers(
  cfg: { deployServersMap?: Record<string, DeployServer[]> } | null | undefined,
  projectRoot: string | null | undefined,
): DeployServer[] {
  if (!projectRoot) return []
  const map = cfg?.deployServersMap
  return map?.[projectConfigKey(projectRoot)] ?? map?.[projectRoot] ?? []
}

/** 项目级发布数据写入（projectDeployServers 的写侧孪生）：整表 spread 收敛在这一处，
 *  调用方不再手拼 map */
export async function setProjectDeployServers(projectRoot: string, next: DeployServer[]): Promise<void> {
  const cfg = await getConfig()
  const key = projectConfigKey(projectRoot)
  await mergeConfig({ deployServersMap: { ...(cfg.deployServersMap ?? {}), [key]: next } })
}

/** 会话可见的外部 MCP server 面（全局 ∪ 当前项目；同名时项目域覆盖全局域）：
 *  项目域各项目相互独立（与 deployServers 同口径——无跨项目回退，见 projectDeployServers） */
export function activeMcpServers(
  cfg: { mcpServers?: Record<string, McpServerEntry>; mcpServersMap?: Record<string, Record<string, McpServerEntry>> } | null | undefined,
  projectRoot: string | null | undefined,
): Record<string, McpServerEntry> {
  const projMap = projectRoot
    ? cfg?.mcpServersMap?.[projectConfigKey(projectRoot)] ?? cfg?.mcpServersMap?.[projectRoot] ?? {}
    : {}
  return {
    ...(cfg?.mcpServers ?? {}),
    ...projMap,
  }
}

/** 项目域 MCP server 表写入（activeMcpServers 的写侧）：整表 spread 收敛在这一处 */
export async function setProjectMcpServers(
  projectRoot: string,
  next: Record<string, McpServerEntry>,
): Promise<void> {
  const cfg = await getConfig()
  await mergeConfig({ mcpServersMap: { ...(cfg.mcpServersMap ?? {}), [projectConfigKey(projectRoot)]: next } })
}

/** 读取失败一律回默认值（get_config 永不 reject） */
export async function getConfig(): Promise<AppConfig> {
  if (configCache && Date.now() - configCacheAt < CONFIG_CACHE_TTL) return configCache
  try {
    const raw = await fsp.readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    const cfg: AppConfig = {
      lastProjectPath: parsed.lastProjectPath ?? null,
      aiBaseUrl: parsed.aiBaseUrl ?? null,
      aiModel: parsed.aiModel ?? null,
      aiProvider: parsed.aiProvider ?? null,
      aiTiers:
        parsed.aiTiers && typeof parsed.aiTiers === 'object' && !Array.isArray(parsed.aiTiers)
          ? parsed.aiTiers
          : undefined,
      aiDispatchMode: parsed.aiDispatchMode === 'claude-cli' ? 'claude-cli' : 'api',
      aiCliPermission: parsed.aiCliPermission === 'readonly' ? 'readonly' : 'auto',
      aiCliCommand: typeof parsed.aiCliCommand === 'string' && parsed.aiCliCommand.trim() ? parsed.aiCliCommand.trim() : null,
      aiMaxTurns: clampMaxTurns(parsed.aiMaxTurns),
      aiSubagentMaxTurns: clampSubagentMaxTurns(parsed.aiSubagentMaxTurns),
      recentProjects: Array.isArray(parsed.recentProjects) ? parsed.recentProjects : [],
      skillsDirs: mergeSkillDirs(parsed.skillsDirs, parsed.skillsDir),
      // 旧字段原样透传：渲染层启动迁移（并入 skillsDirs 后写 null 清空）依赖读到它
      skillsDir: typeof parsed.skillsDir === 'string' ? parsed.skillsDir : null,
      startupCommands:
        parsed.startupCommands && typeof parsed.startupCommands === 'object' && !Array.isArray(parsed.startupCommands)
          ? parsed.startupCommands
          : undefined,
      projectSkillsDirsMap:
        parsed.projectSkillsDirsMap && typeof parsed.projectSkillsDirsMap === 'object' && !Array.isArray(parsed.projectSkillsDirsMap)
          ? parsed.projectSkillsDirsMap
          : undefined,
      dataDir: typeof parsed.dataDir === 'string' && parsed.dataDir.trim() ? parsed.dataDir : null,
      embedModel: typeof parsed.embedModel === 'string' && parsed.embedModel.trim() ? parsed.embedModel : null,
      embedRemoteHost:
        typeof parsed.embedRemoteHost === 'string' && parsed.embedRemoteHost.trim() ? parsed.embedRemoteHost : null,
      memExtractRounds: clampRounds(parsed.memExtractRounds),
      memAutoArchive: parsed.memAutoArchive === false ? false : undefined,
      contextCompressThreshold: clampCompressThreshold(parsed.contextCompressThreshold),
      closeAction: parsed.closeAction === 'minimize' || parsed.closeAction === 'quit' ? parsed.closeAction : undefined,
      petSound: parsed.petSound === true ? true : undefined,
      petHidden: parsed.petHidden === true ? true : undefined,
      // 发布 tab：项目级服务器表（重启持久化）；单项目值非数组只丢该条
      deployServersMap:
        parsed.deployServersMap && typeof parsed.deployServersMap === 'object' && !Array.isArray(parsed.deployServersMap)
          ? Object.fromEntries(
              Object.entries(parsed.deployServersMap as Record<string, unknown>).filter(
                ([k, v]) => k.trim().length > 0 && Array.isArray(v),
              ) as [string, DeployServer[]][],
            )
          : undefined,
      deployServers: Array.isArray(parsed.deployServers) ? parsed.deployServers : undefined,
      deployScripts:
        parsed.deployScripts && typeof parsed.deployScripts === 'object' && !Array.isArray(parsed.deployScripts)
          ? parsed.deployScripts
          : undefined,
      cliRecentRounds: typeof parsed.cliRecentRounds === 'number' && parsed.cliRecentRounds >= 2 && parsed.cliRecentRounds <= 40
        ? Math.floor(parsed.cliRecentRounds) : undefined,
      mcpServers: sanitizeMcpServers(parsed.mcpServers),
      mcpServersMap:
        parsed.mcpServersMap && typeof parsed.mcpServersMap === 'object' && !Array.isArray(parsed.mcpServersMap)
          ? Object.fromEntries(
              Object.entries(parsed.mcpServersMap as Record<string, unknown>)
                .map(([k, v]) => [k, sanitizeMcpServers(v) ?? {}] as const)
                .filter(([k]) => k.trim().length > 0),
            )
          : undefined,
    }
    configCache = cfg; configCacheAt = Date.now()
    return cfg
  } catch {
    const fallback: AppConfig = {
      lastProjectPath: null, aiBaseUrl: null, aiModel: null, aiProvider: null,
      aiTiers: undefined,
      aiDispatchMode: 'api', aiCliPermission: 'auto', aiCliCommand: null, aiMaxTurns: null, aiSubagentMaxTurns: null,
      recentProjects: [], skillsDirs: [], skillsDir: null,
      startupCommands: undefined, projectSkillsDirsMap: undefined,
      dataDir: null, embedModel: null, embedRemoteHost: null,
      memExtractRounds: undefined, contextCompressThreshold: undefined,
      closeAction: undefined,
    }
    // 损坏的原文件先备份再放行默认值；默认值不进缓存——缓存后 mergeConfig 会把
    // 默认值当用户配置整体写回，等于清空用户配置
    try {
      const file = configPath()
      await fsp.copyFile(file, `${file}.corrupt-${Date.now()}`)
    } catch { /* 备份失败不阻断 */ }
    return fallback
  }
}

/** 部分合并写入：读当前配置 → 浅合并 → 整体落盘。
 *  新增配置字段时调用方只需传变更项，避免全量覆盖漏字段静默丢数据。 */
export async function mergeConfig(patch: Partial<AppConfig>): Promise<void> {
  const current = await getConfig()
  await setConfig({ ...current, ...patch })
}

/** 整体覆盖写入，立即落盘（pretty JSON）；写入后清缓存并广播 diff 事件 */
async function setConfig(config: AppConfig): Promise<void> {
  const prev = configCache
  invalidateConfigCache()
  const file = configPath()
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
  } catch (e) {
    throw new Error(`无法获取应用数据目录：${errorMessage(e)}`)
  }
  try {
    // 临时文件 + rename 原子替换：直接 writeFile 被中断会留下截断 JSON，下次读失败走默认值
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  } catch (e) {
    throw new Error(`配置写入失败：${errorMessage(e)}`)
  }
  const affected = prev ? shallowDiffKeys(prev, config) : new Set(Object.keys(config))
  if (affected.size > 0) configChangedEmitter.fire(affected)
}

// ---------- 配置变更事件（多窗口同步） ----------

const configChangedEmitter = new Emitter<Set<string>>({ name: 'config' })

/** 盘上配置变更（setConfig/mergeConfig 成功后触发）：affectedKeys 为实际发生变化的顶层键 */
export function onConfigChanged(cb: (affectedKeys: Set<string>) => void): IDisposable {
  return configChangedEmitter.event(cb)
}

/** 顶层键浅对比；对象值用 JSON 序列化比较（配置量级小，开销可忽略） */
function shallowDiffKeys(a: AppConfig, b: AppConfig): Set<string> {
  const changed = new Set<string>()
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  for (const k of keys) {
    const va = ra[k]
    const vb = rb[k]
    if (va === vb) continue
    if (typeof va === 'object' && typeof vb === 'object' && JSON.stringify(va) === JSON.stringify(vb)) continue
    changed.add(k)
  }
  return changed
}

function configPath(): string {
  return path.join(storageDir(), 'config.json')
}
