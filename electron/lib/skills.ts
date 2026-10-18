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
import AdmZip from 'adm-zip'

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

/** Skill 目录三源合并：项目默认（<project>/.qyris/skills）+ 项目自定义 + 全局。
 *  唯一入口（ai.ts 的系统提示组装与 load_skill 工具共用，避免两份合并规则漂移） */
export function collectSkillDirs(
  projectRoot: string | null,
  cfg: { projectSkillsDirsMap?: Record<string, string[]>; skillsDirs: string[] },
): string[] {
  const defaultProjectDir = projectRoot ? `${projectRoot}/.qyris/skills` : null
  const extraProjectDirs = projectRoot ? (cfg.projectSkillsDirsMap?.[projectRoot] ?? []) : []
  const globalDirs = cfg.skillsDirs ?? []
  return [
    ...(defaultProjectDir ? [defaultProjectDir] : []),
    ...extraProjectDirs,
    ...globalDirs.filter((d) => d !== defaultProjectDir && !extraProjectDirs.includes(d)),
  ]
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

/** ZIP 系统垃圾顶层条目（macOS 压缩产物）：不剔除会破坏单顶层目录判定（__MACOSX 与真实目录并列
 *  → 根含 SKILL.md 误判失败）；嵌套在真实目录内部的垃圾不影响结构判定，不处理 */
const ZIP_JUNK = new Set(['__MACOSX', '.DS_Store'])
const isZipJunk = (name: string): boolean => ZIP_JUNK.has(name) || name.startsWith('._')

/** 从 ZIP 文件导入 Skill：adm-zip 进程内解压（不外调 PowerShell/unzip——外调是导入报错的最大
 *  来源：AppLocker/受限语言模式、压缩算法不支持、深路径超 MAX_PATH、杀软锁文件 rename 竞态）。
 *  覆盖写盘用 cp 而非 rename（同 importSkillFromDir），规避杀软实时扫描新落盘文件的 EPERM。
 *  兼容三种结构（对齐目录导入）：
 *    A) ZIP 根单顶层目录 → 交 importSkillFromDir（目录内含 SKILL.md → 单个；子目录含 → 批量）
 *    B) ZIP 根直接含 SKILL.md → 整包一个 Skill（id 取 ZIP 文件名）
 *    C) 多个顶层目录各含 SKILL.md → importSkillFromDir 结构 B 批量导入 */
export async function importSkillFromZip(destDir: string, zipPath: string): Promise<{ ok: boolean; name?: string; count?: number; error?: string }> {
  let tmpDir: string | null = null
  try {
    let zip: AdmZip
    try {
      zip = new AdmZip(zipPath)
    } catch {
      return { ok: false, error: '无法读取 ZIP 文件：文件可能已损坏、被加密或不是有效的 ZIP 包' }
    }
    if (zip.getEntries().length === 0) {
      return { ok: false, error: 'ZIP 包是空的，不是合法的 Skill 包' }
    }
    await fsp.mkdir(destDir, { recursive: true })
    tmpDir = path.join(destDir, `__import_tmp_${Date.now()}__`)
    await fsp.mkdir(tmpDir, { recursive: true })
    try {
      zip.extractAllTo(tmpDir, true)
    } catch {
      return { ok: false, error: 'ZIP 解压失败：包内可能含不支持的条目（非法文件名/不受支持的压缩方式）' }
    }
    // 清顶层垃圾后做结构判定
    for (const de of await fsp.readdir(tmpDir, { withFileTypes: true })) {
      if (isZipJunk(de.name)) await fsp.rm(path.join(tmpDir, de.name), { recursive: true, force: true }).catch(() => {})
    }

    // 结构 B：ZIP 根直接含 SKILL.md → 整包一个 Skill，id 取 ZIP 文件名
    const hasRootSkill = await fsp.access(path.join(tmpDir, SKILL_FILE)).then(() => true, () => false)
    if (hasRootSkill) {
      const skillName = path.basename(zipPath, path.extname(zipPath))
      // 名字不得含路径分隔符/..：拼进 destDir 会越出目标目录
      if (!skillName || /[\\/]/.test(skillName) || skillName === '..' || skillName === '.') {
        return { ok: false, error: 'ZIP 文件名不合法，无法作为 Skill 名，请重命名后重试' }
      }
      const dest = path.join(destDir, skillName)
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
      await fsp.cp(tmpDir, dest, { recursive: true })
      return { ok: true, name: skillName, count: 1 }
    }

    // 结构 A / C：单顶层目录或多个含 SKILL.md 的子目录 → 复用目录导入的判定与批量能力
    const r = await importSkillFromDir(destDir, tmpDir)
    if (!r.ok) {
      // 只改写「未找到 SKILL.md」这一确定语义；其余（IO 异常等）原样透传
      const notFound = (r.error ?? '').includes('未找到 SKILL.md')
      return notFound
        ? { ok: false, error: 'ZIP 中未找到 SKILL.md。支持的包结构：单个顶层目录内含 SKILL.md、根直接含 SKILL.md、或多个子目录各含 SKILL.md' }
        : { ok: false, error: `导入失败：${r.error}` }
    }
    return { ok: true, name: r.name, count: r.count }
  } catch (e) {
    return { ok: false, error: `导入失败：${e instanceof Error ? e.message : String(e)}` }
  } finally {
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
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
  // 按 \r?\n 切行：兼容 CRLF 文件（中间行不带尾 \r，行正则才匹配得到）
  const lines = match[1].split(/\r?\n/)
  const result: Frontmatter = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 顶层 key（支持字母、数字、连字符、下划线）
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/)
    if (m) {
      const key = m[1].trim()
      let val: string = m[2].trim()
      // 空值 key：值写在下一行——块序列（triggers，可无缩进）或 plain 多行标量（description）。
      // 注释行（# 开头）跳过：不进值、不终止序列/标量扫描
      let listVal: string[] | null = null
      if (val === '') {
        let j = i + 1
        const items: string[] = []
        while (j < lines.length) {
          const lj = lines[j]
          if (/^\s*#/.test(lj)) { j++; continue }
          const li = lj.match(/^\s*-\s+(.*)$/)
          if (!li) break
          const v = li[1].trim().replace(/^['"]|['"]$/g, '')
          if (v) items.push(v)
          j++
        }
        if (items.length > 0) {
          listVal = items
          i = j
        } else {
          const buf: string[] = []
          j = i + 1
          while (j < lines.length) {
            const lj = lines[j]
            if (/^\s*#/.test(lj)) { j++; continue }
            if (!/^\s+\S/.test(lj) || /^\s*-\s+/.test(lj)) break
            buf.push(lj.trim())
            j++
          }
          if (buf.length > 0) {
            val = buf.join(' ')
            i = j
          } else {
            i++
          }
        }
      } else if (val === '>' || val === '|' || val === '>-' || val === '|-') {
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
        if (listVal) {
          result.triggers = listVal
        } else if (val.startsWith('[') && val.endsWith(']')) {
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
