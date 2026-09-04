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
}

export interface AppConfig {
  lastProjectPath: string | null
  aiBaseUrl: string | null
  aiModel: string | null
  aiProvider: 'openai' | 'anthropic' | null
  /** 任务档位模型（thinking/fast/middle/heavy，空缺回退主模型） */
  aiTiers?: { thinking?: string; fast?: string; middle?: string; heavy?: string }
  /** 调度模型方式：api=HTTP 直连；claude-cli=本机 Claude Code CLI（白名单归一，垃圾值回 api） */
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

/** 读取失败一律回默认值（get_config 永不 reject） */
export async function getConfig(): Promise<AppConfig> {
  try {
    const raw = await fsp.readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    return {
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
    }
  } catch {
    return {
      lastProjectPath: null, aiBaseUrl: null, aiModel: null, aiProvider: null,
      aiDispatchMode: 'api', aiCliPermission: 'auto',
      recentProjects: [], skillsDirs: [], skillsDir: null,
    }
  }
}

/** 部分合并写入：读当前配置 → 浅合并 → 整体落盘。
 *  新增配置字段时调用方只需传变更项，避免全量覆盖漏字段静默丢数据。 */
export async function mergeConfig(patch: Partial<AppConfig>): Promise<void> {
  const current = await getConfig()
  await setConfig({ ...current, ...patch })
}

/** 整体覆盖写入，立即落盘（pretty JSON） */
export async function setConfig(config: AppConfig): Promise<void> {
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
