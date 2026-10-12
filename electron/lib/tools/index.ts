/**
 * ToolRegistry —— 模型生态统一的工具注册表（tools/ 唯一对外出口）。
 *
 * 职责：
 *   1. 注册全部自有工具（fs / git / shell / project / skill / ask / subagent / remote / memory / preview / web）；
 *   2. 查询/过滤/执行/截断在 ./registry（叶子模块——skill/subagent 与注册核的循环由此解开，
 *      不再需要动态 import 破循环）；
 *   3. executeTool 是唯一执行入口：查表 → 权限复核（fail-closed）→ 执行 → 结果统一截断；
 *   4. isDeferredTool 标记交互型工具（askUserQuestion）：runner 延迟整轮给调用方，不在主进程执行。
 *
 * 契约来源：../model/types.ts（不在此层改语义，只做编排）。
 */
import { fsTools } from './fs'
import { gitTools } from './git'
import { shellTools } from './shell'
import { projectTools } from './project'
import { skillTools } from './skill'
import { askTools } from './ask'
import { subagentTools } from './subagent'
import { remoteTools } from './remote'
import { memoryTools } from './memory'
import { previewTools } from './preview'
import { webTools } from './web'
import { adoptTools } from './registry'

/** 内置工具注册（模块加载期一次，顺序稳定：fs → git → shell → project → skill → ask → subagent → remote → memory → preview → web） */
adoptTools([
  ...fsTools,
  ...gitTools,
  ...shellTools,
  ...projectTools,
  ...skillTools,
  ...askTools,
  ...subagentTools,
  ...remoteTools,
  ...memoryTools,
  ...previewTools,
  ...webTools,
])

export * from './registry'
