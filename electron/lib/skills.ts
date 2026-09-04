/**
 * Skills 目录扫描与内容读取。
 *
 * 目录规范：每个 Skill 是一个子目录，内含 SKILL.md 文件。
 *   skillsDir/
 *     debug-react/
 *       SKILL.md        ← frontmatter + 指令内容
 *     deploy-docker/
 *       SKILL.md
 *
 * SKILL.md 格式（YAML frontmatter）：
 *   ---
 *   name: 调试 React
 *   description: React 组件调试技巧
 *   triggers: [bug, 报错, 渲染异常]
 *   ---
 *   # 调试指南
 *   ... 具体指令 ...
 *
 * 渐进式加载：启动时只读 frontmatter（轻量摘要），对话中按需 readSkill 读取全文。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export interface SkillMeta {
  /** 唯一标识：子目录名（如 "debug-react"） */
  id: string
  /** 显示名称（来自 frontmatter name，缺省取目录名） */
  name: string
  /** 一句话描述 */
  description: string
  /** 触发关键词列表 */
  triggers: string[]
}

interface Frontmatter {
  name?: string
  description?: string
  triggers?: string[] | string
}

const SKILL_FILE = 'SKILL.md'

/** 扫描目录下所有子目录中的 SKILL.md，解析 frontmatter 返回摘要列表 */
export async function scanSkills(dir: string): Promise<SkillMeta[]> {
  const results: SkillMeta[] = []
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillFile = path.join(dir, entry.name, SKILL_FILE)
      try {
        const raw = await fsp.readFile(skillFile, 'utf8')
        const fm = parseFrontmatter(raw)
        results.push({
          id: entry.name,
          name: fm.name ?? entry.name,
          description: fm.description ?? '',
          triggers: Array.isArray(fm.triggers) ? fm.triggers : (typeof fm.triggers === 'string' ? [fm.triggers] : []),
        })
      } catch {
        // 子目录没有 SKILL.md 或读取失败，跳过
      }
    }
  } catch {
    // 目录不存在或不可读 → 返回空
  }
  return results
}

/** 多目录按序扫描：同名 id 首个命中者优先（与 load_skill / CLI resolve 的查找序一致）。
 *  多目录解析的唯一入口——渲染层 IPC 与 CLI adapter 都从这里取，避免各层各写一份去重规则 */
export async function scanSkillsDirs(dirs: string[]): Promise<SkillMeta[]> {
  const seen = new Set<string>()
  const metas: SkillMeta[] = []
  for (const dir of dirs) {
    for (const m of await scanSkills(dir)) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      metas.push(m)
    }
  }
  return metas
}

/** 多目录按序读取 Skill：首个命中即返回（readSkill 自带路径穿越守卫） */
export async function readSkillFromDirs(dirs: string[], skillId: string): Promise<string | null> {
  for (const dir of dirs) {
    const content = await readSkill(dir, skillId)
    if (content !== null) return content
  }
  return null
}

/** 读取单个 skill 的完整 SKILL.md 内容 */
export async function readSkill(dir: string, skillId: string): Promise<string | null> {
  // 安全校验：skillId 只允许目录名（不能含路径分隔符）
  if (!skillId || skillId.includes('/') || skillId.includes('\\') || skillId.includes('..')) return null
  const filePath = path.join(dir, skillId, SKILL_FILE)
  // 确保解析后仍在 dir 内
  if (!filePath.startsWith(dir)) return null
  try {
    return await fsp.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

/** 手动解析 YAML frontmatter（避免引入额外依赖） */
function parseFrontmatter(raw: string): Frontmatter {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const block = match[1]
  const result: Frontmatter = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^(\w+)\s*:\s*(.+)$/)
    if (!m) continue
    const key = m[1].trim()
    let val: string = m[2].trim()
    // 去引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key === 'name') result.name = val
    else if (key === 'description') result.description = val
    else if (key === 'triggers') {
      // 支持 [a, b, c] 和单值
      if (val.startsWith('[') && val.endsWith(']')) {
        result.triggers = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      } else {
        result.triggers = [val]
      }
    }
  }
  return result
}
