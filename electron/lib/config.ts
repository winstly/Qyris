/** 非敏感配置持久化（userData/config.json）—— config.rs 的逐语义移植。刻意不含 API Key。 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { errorMessage } from './util'
import { storageDir } from './storage'

export interface RecentProject {
  path: string
  name: string
  lastOpened: number
}

export interface AppConfig {
  lastProjectPath: string | null
  aiBaseUrl: string | null
  aiModel: string | null
  aiProvider: 'openai' | 'anthropic' | null
  recentProjects?: RecentProject[]
  skillsDir?: string | null
}

/** 读取失败一律回默认值（get_config 永不 reject，与 config.rs 一致） */
export async function getConfig(): Promise<AppConfig> {
  try {
    const raw = await fsp.readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    return {
      lastProjectPath: parsed.lastProjectPath ?? null,
      aiBaseUrl: parsed.aiBaseUrl ?? null,
      aiModel: parsed.aiModel ?? null,
      aiProvider: parsed.aiProvider ?? null,
      recentProjects: Array.isArray(parsed.recentProjects) ? parsed.recentProjects : [],
      skillsDir: parsed.skillsDir ?? null,
    }
  } catch {
    return { lastProjectPath: null, aiBaseUrl: null, aiModel: null, aiProvider: null, recentProjects: [], skillsDir: null }
  }
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
