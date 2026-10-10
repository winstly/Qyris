/**
 * 产品工具（Skill 域）：load_skill。
 *
 * 复用 skills.ts 的多目录读取（readSkillFromDirs，含 skillId 路径穿越守卫）；
 * 目录三源合并走 skills.collectSkillDirs（与 ai.ts 系统提示组装同一入口，不另写一份规则）。
 * 只读档：不写任何文件。
 */
import { getConfig } from '../config'
import { collectSkillDirs, readSkillFromDirs, scanSkillsDirs } from '../skills'
import type { Tool, ToolCtx } from '../model/types'

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('工具入参必须是 JSON 对象')
  }
  return input as Record<string, unknown>
}

function text(rec: Record<string, unknown>, key: string): string {
  const v = rec[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v
}

const loadSkill: Tool = {
  name: 'load_skill',
  description:
    '加载一个 Skill 的完整内容。当用户问题匹配系统提示中列出的某个 Skill 时调用，获取完整指令后按指令执行。' +
    '同一 Skill 只需加载一次（结果会留在对话历史中）。',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: 'Skill 的加载 id：精确复制系统提示「可用 Skill」列表中的 id（如 "debug-react"），不要加路径或 .md 后缀',
      },
    },
    required: ['skill_id'],
  },
  permission: 'readonly',
  async execute(input, ctx: ToolCtx) {
    const rec = asRecord(input)
    const skillId = text(rec, 'skill_id')
    const cfg = await getConfig()
    const dirs = collectSkillDirs(ctx.projectRoot, cfg)
    const content = await readSkillFromDirs(dirs, skillId)
    if (content === null) {
      // 工具名误当 Skill id（线上形态：load_skill('dispatch_subtasks')）：直接指回工具调用，
      // 模型一轮自纠而不是在 Skill 域里打转。动态 import 避免 tools/index ↔ tools/skill 静态环
      const { getTool } = await import('./index')
      if (getTool(skillId)) {
        return {
          content: `[load_skill]「${skillId}」是工具名，不是 Skill id——请直接调用工具 ${skillId}，无需 load_skill。`,
          isError: true,
        }
      }
      // 未命中：把可用 id 列出来，模型可自纠（不要静默空结果）
      const metas = await scanSkillsDirs(dirs)
      const known = metas.map((m) => m.id).join('、')
      return {
        content: known
          ? `[load_skill] Skill「${skillId}」不存在或无法读取。可用 Skills：${known}`
          : `[load_skill] Skill「${skillId}」不存在。当前没有可用 Skill（Skills 目录未配置或为空，可在设置 → 系统设置中配置）。`,
        isError: true,
      }
    }
    return { content }
  },
}

/** Skill 工具集 */
export const skillTools: Tool[] = [loadSkill]
