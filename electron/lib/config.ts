/** 非敏感配置持久化（userData/config.json）。刻意不含 API Key。 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { errorMessage } from './util'
import { storageDir } from './storage'
import { Emitter } from '../../shared/base/event'
import type { IDisposable } from '../../shared/base/lifecycle'

export interface RecentProject {
  path: string
  name: string
  lastOpened: number
}

/** 单个服务的启动命令（AI 编译阶段的识别结果，按项目路径存档） */
export interface StartCommand {
  name: string
  run: string
  /** 本地预览地址提示（可选，AI 已知端口时上报），启动时作为初始检测地址 */
  url?: string
}

export interface AppConfig {
  lastProjectPath: string | null
  aiBaseUrl: string | null
  aiModel: string | null
  aiProvider: 'openai' | 'anthropic' | null
  /** 任务档位模型（thinking/fast/middle/heavy，空缺回退主模型） */
  aiTiers?: { thinking?: string; fast?: string; middle?: string; heavy?: string }
  /** 调度模型方式：api=HTTP 直连；claude-cli=本机 Claude Code CLI（垃圾值回 api） */
  aiDispatchMode: 'api' | 'claude-cli'
  /** CLI 可执行文件名/路径：缺省 'claude'（Windows 经 cmd.exe 查 PATH），可改为自定义路径 */
  aiCliCommand?: string | null
  /** CLI 权限模式：auto=跳过权限确认；readonly=只读工具白名单 */
  aiCliPermission: 'auto' | 'readonly'
  recentProjects?: RecentProject[]
  /** Skills 目录列表（按序扫描、同名取首个；读取时兼容合并旧单目录字段） */
  skillsDirs: string[]
  /** @deprecated 旧单目录字段：仅读取兼容（并入 skillsDirs），写入方一律用 skillsDirs */
  skillsDir?: string | null
  /** 项目绝对路径 → 已识别的启动命令列表（AI 编译产出，「运行」直接执行） */
  startupCommands?: Record<string, StartCommand[]>
  /** 项目绝对路径 → 项目级 Skill 目录列表（用户在技能面板添加的额外目录） */
  projectSkillsDirsMap?: Record<string, string[]>
  /** 用户数据根目录（SQLite 库等大件所在），缺省 ~/.qyris/data；P1 出设置项与迁移 */
  dataDir?: string | null
  /** 记忆嵌入模型（transformers.js hub id），缺省 Xenova/bge-small-zh-v1.5 */
  embedModel?: string | null
  /** 嵌入模型下载镜像（transformers.js remoteHost），缺省 https://hf-mirror.com */
  embedRemoteHost?: string | null
  /** 记忆整理触发轮次：自游标起累计多少轮 assistant 回复后做滚动提取（2..60），缺省 6 */
  memExtractRounds?: number
  /** 上下文压缩阈值（token 数）：历史超过此值时自动压缩旧消息为摘要，缺省 256000；范围 64000~512000 */
  contextCompressThreshold?: number
  /** 主窗口关闭行为：缺省/ask=每次询问；minimize=隐藏窗口保留桌宠；quit=退出整个应用 */
  closeAction?: 'minimize' | 'quit'
  /** 桌宠音效开关：缺省 false（静音）；true 时播放 MP4 内置音轨 */
  petSound?: boolean
  /** CLI 模式最近对话轮数（重放降级路径序列化多少轮 user+assistant+tool；缺省 8） */
  cliRecentRounds?: number
}

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

/** 内存缓存：getConfig 被热路径频繁调用（memorySearch / embed / memAgent），避免每次读磁盘+JSON.parse */
let configCache: AppConfig | null = null
let configCacheAt = 0
const CONFIG_CACHE_TTL = 2000 // 2s TTL，mergeConfig/setConfig 时主动清失效

export function invalidateConfigCache(): void { configCache = null; configCacheAt = 0 }

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
      contextCompressThreshold: clampCompressThreshold(parsed.contextCompressThreshold),
      closeAction: parsed.closeAction === 'minimize' || parsed.closeAction === 'quit' ? parsed.closeAction : undefined,
      petSound: parsed.petSound === true ? true : undefined,
      cliRecentRounds: typeof parsed.cliRecentRounds === 'number' && parsed.cliRecentRounds >= 2 && parsed.cliRecentRounds <= 40
        ? Math.floor(parsed.cliRecentRounds) : undefined,
    }
    configCache = cfg; configCacheAt = Date.now()
    return cfg
  } catch {
    const fallback: AppConfig = {
      lastProjectPath: null, aiBaseUrl: null, aiModel: null, aiProvider: null,
      aiTiers: undefined,
      aiDispatchMode: 'api', aiCliPermission: 'auto', aiCliCommand: null,
      recentProjects: [], skillsDirs: [], skillsDir: null,
      startupCommands: undefined, projectSkillsDirsMap: undefined,
      dataDir: null, embedModel: null, embedRemoteHost: null,
      memExtractRounds: undefined, contextCompressThreshold: undefined,
      closeAction: undefined,
    }
    configCache = fallback; configCacheAt = Date.now()
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
export async function setConfig(config: AppConfig): Promise<void> {
  const prev = configCache
  invalidateConfigCache()
  const file = configPath()
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
  } catch (e) {
    throw new Error(`无法获取应用数据目录：${errorMessage(e)}`)
  }
  try {
    await fsp.writeFile(file, JSON.stringify(config, null, 2), 'utf8')
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
