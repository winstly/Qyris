/**
 * Skills 目录扫描与内容读取。
 *
 * 目录规范：每个 Skill 是一个子目录，内含 SKILL.md 文件。
 *   skillsDir/
 *     debug-react/
 *       SKILL.md        ← frontmatter + 指令内容
 *       scripts/        ← 可选：可执行代码
 *       references/     ← 可选：文档资料
 *       assets/         ← 可选：模板和资源
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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'

const execFileAsync = promisify(execFile)

export interface SkillMeta {
  /** 唯一标识：子目录名（如 "debug-react"） */
  id: string
  /** 显示名称（来自 frontmatter name，缺省取目录名） */
  name: string
  /** 一句话描述 */
  description: string
  /** 触发关键词列表 */
  triggers: string[]
  /** 来源标记（渲染层注入，主进程扫描时不填） */
  scope?: 'user' | 'project'
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

/** 从 ZIP 文件导入 Skill：解压到目标目录（ZIP 内应含一个顶层目录，内含 SKILL.md） */
export async function importSkillFromZip(destDir: string, zipPath: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    await fsp.mkdir(destDir, { recursive: true })
    const tmpDir = path.join(destDir, '__import_tmp__')
    await fsp.mkdir(tmpDir, { recursive: true })
    try {
      // 解压：Windows 用 PowerShell，macOS/Linux 用 unzip
      const isWin = os.platform() === 'win32'
      if (isWin) {
        await execFileAsync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force`])
      } else {
        await execFileAsync('unzip', ['-o', zipPath, '-d', tmpDir])
      }
      // 定位解压后的 skill 目录
      const entries = await fsp.readdir(tmpDir, { withFileTypes: true })
      const skillSrc = entries.length === 1 && entries[0].isDirectory()
        ? path.join(tmpDir, entries[0].name)   // ZIP 根单目录 → 直接用
        : tmpDir                                // ZIP 根多文件 → 整个 tmpDir
      const skillName = skillSrc === tmpDir
        ? path.basename(zipPath, path.extname(zipPath))
        : entries[0].name
      // 验证 SKILL.md 存在
      const hasSkill = await fsp.access(path.join(skillSrc, SKILL_FILE)).then(() => true, () => false)
      if (!hasSkill) return { ok: false, error: 'ZIP 中未找到 SKILL.md，不是合法的 Skill 包' }
      // 移动到目标位置（覆盖已有）
      const dest = path.join(destDir, skillName)
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
      await fsp.rename(skillSrc, dest)
      return { ok: true, name: skillName }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  } catch (e) {
    return { ok: false, error: `导入失败：${String(e)}` }
  }
}

/** 从本地目录导入 Skill：复制到目标目录。
 *  兼容两种结构：
 *    A) srcDir 本身含 SKILL.md → 单个 Skill，目录名即 id
 *    B) srcDir 的子目录含 SKILL.md → 批量导入所有子 Skill */
export async function importSkillFromDir(destDir: string, srcDir: string): Promise<{ ok: boolean; name?: string; count?: number; error?: string }> {
  try {
    await fsp.mkdir(destDir, { recursive: true })

    // 结构 A：srcDir 本身含 SKILL.md
    try {
      await fsp.access(path.join(srcDir, SKILL_FILE))
      const skillName = path.basename(srcDir)
      const dest = path.join(destDir, skillName)
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
      await fsp.cp(srcDir, dest, { recursive: true })
      return { ok: true, name: skillName, count: 1 }
    } catch { /* 不含 SKILL.md，继续检查子目录 */ }

    // 结构 B：扫描子目录中含 SKILL.md 的
    const entries = await fsp.readdir(srcDir, { withFileTypes: true })
    let imported = 0
    let firstName: string | undefined
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        await fsp.access(path.join(srcDir, entry.name, SKILL_FILE))
      } catch { continue }
      const dest = path.join(destDir, entry.name)
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
      await fsp.cp(path.join(srcDir, entry.name), dest, { recursive: true })
      imported++
      if (!firstName) firstName = entry.name
    }
    if (imported === 0) {
      return { ok: false, error: '所选目录及子目录中均未找到 SKILL.md' }
    }
    return { ok: true, name: firstName, count: imported }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 删除指定目录下的 Skill（整个子目录） */
export async function deleteProjectSkill(dir: string, skillId: string): Promise<{ ok: boolean; error?: string }> {
  if (!skillId || skillId.includes('/') || skillId.includes('\\') || skillId.includes('..')) {
    return { ok: false, error: '无效的 Skill id' }
  }
  const skillDir = path.join(dir, skillId)
  // 双重校验：规范化后确保仍在 dir 内（skillId 校验 + 路径前缀）
  const normDir = path.resolve(dir)
  const normTarget = path.resolve(skillDir)
  if (!normTarget.startsWith(normDir + path.sep) && normTarget !== normDir) {
    return { ok: false, error: '路径越界' }
  }
  try {
    await fsp.rm(skillDir, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 手动解析 YAML frontmatter（避免引入额外依赖）。
 *  支持：连字符 key、空值行、嵌套对象、多行标量（>/|）。 */
function parseFrontmatter(raw: string): Frontmatter {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const lines = match[1].split('\n')
  const result: Frontmatter = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 顶层 key（支持字母、数字、连字符、下划线）
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/)
    if (m) {
      const key = m[1].trim()
      let val: string = m[2].trim()
      // 多行标量：> (folded) 或 | (literal)
      if (val === '>' || val === '|' || val === '>-' || val === '|-') {
        const folded = val.startsWith('>')
        const buf: string[] = []
        i++
        while (i < lines.length && /^\s+/.test(lines[i])) {
          buf.push(lines[i].replace(/^  /, ''))
          i++
        }
        val = folded ? buf.join(' ').replace(/\n\s+/g, ' ').trim() : buf.join('\n').trim()
      } else {
        // 去引号
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        }
        i++
      }
      if (key === 'name') result.name = val || undefined
      else if (key === 'description') result.description = val || undefined
      else if (key === 'triggers') {
        if (val.startsWith('[') && val.endsWith(']')) {
          result.triggers = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        } else if (val) {
          result.triggers = [val]
        }
      }
      continue
    }
    // 缩进行（嵌套对象子字段 / 漏网的多行续行）→ 跳过
    i++
  }
  return result
}
