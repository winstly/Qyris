/** 非敏感配置持久化（userData/config.json）。刻意不含 API Key。 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { errorMessage } from './util'
import { storageDir } from './storage'

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
    }
    configCache = cfg; configCacheAt = Date.now()
    return cfg
  } catch {
    const fallback: AppConfig = {
      lastProjectPath: null, aiBaseUrl: null, aiModel: null, aiProvider: null,
      aiTiers: undefined,
      aiDispatchMode: 'api', aiCliPermission: 'auto',
      recentProjects: [], skillsDirs: [], skillsDir: null,
      startupCommands: undefined, projectSkillsDirsMap: undefined,
      dataDir: null, embedModel: null, embedRemoteHost: null,
      memExtractRounds: undefined,
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

/** 整体覆盖写入，立即落盘（pretty JSON）；写入后清缓存 */
export async function setConfig(config: AppConfig): Promise<void> {
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
}

function configPath(): string {
  return path.join(storageDir(), 'config.json')
}
