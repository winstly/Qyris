/**
 * AppConfig 与配置条目类型的唯一定义（跨进程纯类型，不 import node/electron）。
 * 渲染层（@/types 再导出）与主进程（lib/config 再导出）都从这里取。
 * 字段口径以主进程归一后形态为准（getConfig 的输出面）；写入方走 mergeConfig(Partial)。
 */
import type { McpServerEntry } from './mcp'

/** 任务档位模型（空缺回退主模型） */
export interface ModelTiers {
  /** 深度推理：疑难调试 / 架构分析 */
  thinking?: string
  /** 轻量快速（Haiku 级）：批量查找 / 轻量总结 */
  fast?: string
  /** 常规任务（默认档） */
  middle?: string
  /** 重活：大规模重构 / 长任务 */
  heavy?: string
}

/** 最近打开的工程 */
export interface RecentProject {
  path: string
  name: string
  lastOpened: number
}

/** AI 识别的启动命令（「运行」直接执行） */
export interface StartCommand {
  name: string
  run: string
  /** 本地预览地址（AI 已知则上报，如 http://localhost:8000）；启动时作为初始检测地址 */
  url?: string
}

/** 发布 tab 的服务器配置（非敏感；密码/口令在主进程 secrets，key=ssh:<id>） */
export interface DeployServer {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: 'password' | 'key'
  privateKeyPath?: string
  remotePath?: string
  note?: string
  /** 已部署服务标签（nginx / nacos / app-server / blog-portal …）——卡片展示 + AI 部署上下文 */
  tags?: string[]
  /** 部署策略（AI 判定或手动指定）：单机 / 微服务 / 集群 */
  strategy?: 'single' | 'microservice' | 'cluster'
}

/** 应用配置（config.json 盘上面）。不含 API Key（secrets 另存）。 */
export interface AppConfig {
  lastProjectPath: string | null
  aiBaseUrl: string | null
  aiModel: string | null
  aiProvider: 'openai' | 'anthropic' | null
  /** 任务档位模型（thinking/fast/middle/heavy，空缺回退主模型） */
  aiTiers?: ModelTiers
  /** 调度模型方式：api=HTTP 直连；claude-cli=本机 Claude Code CLI（垃圾值归一为 api） */
  aiDispatchMode: 'api' | 'claude-cli'
  /** CLI 可执行文件名/路径：缺省 'claude'（Windows 经 cmd.exe 查 PATH），可改为自定义路径 */
  aiCliCommand?: string | null
  /** 主对话工具循环轮数上限（API/CLI 通用，CLI 落为 --max-turns）：null=缺省 60；合法域 [4,500] */
  aiMaxTurns?: number | null
  /** 子 agent 单任务工具循环轮数上限：null=缺省 20；合法域 [2,200] */
  aiSubagentMaxTurns?: number | null
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
  /** 用户数据根目录（SQLite 库等大件所在），缺省 ~/.qyris/data */
  dataDir?: string | null
  /** 记忆嵌入模型（transformers.js hub id），缺省 Xenova/bge-small-zh-v1.5 */
  embedModel?: string | null
  /** 记忆嵌入模型下载镜像（transformers.js remoteHost），缺省 https://hf-mirror.com */
  embedRemoteHost?: string | null
  /** 记忆整理触发轮次：自游标起累计多少轮 assistant 回复后做滚动提取（2..60），缺省 6 */
  memExtractRounds?: number
  /** 自动归档长期未使用的短期/事件记忆（缺省 true；显式保存的记忆永不自动清理） */
  memAutoArchive?: boolean
  /** 上下文压缩阈值（token 数）：历史超过此值时自动压缩旧消息为摘要，缺省 256000；范围 64000~512000 */
  contextCompressThreshold?: number
  /** 主窗口关闭行为：缺省/ask=每次询问；minimize=隐藏窗口保留桌宠；quit=退出整个应用 */
  closeAction?: 'minimize' | 'quit'
  /** 桌宠音效开关：缺省 false（静音）；true 时播放 MP4 内置音轨 */
  petSound?: boolean
  /** 隐藏桌宠：true 时桌宠窗口隐藏（不销毁，设置里可恢复） */
  petHidden?: boolean
  /** 发布 tab：项目级服务器表（projectConfigKey(projectRoot) → 服务器；各项目数据相互独立，无跨项目回退） */
  deployServersMap?: Record<string, DeployServer[]>
  /** @deprecated 全局服务器表：不再读取，迁移时并入 deployServersMap 并清空 */
  deployServers?: DeployServer[]
  /** @deprecated 全局脚本草稿（serverId → 脚本内容）：同上，迁移后清空 */
  deployScripts?: Record<string, string>
  /** CLI 模式最近对话轮数（重放降级路径序列化多少轮 user+assistant+tool；缺省 8） */
  cliRecentRounds?: number
  /** 外部 MCP server 表（全局域：所有项目可见）：name → 启动配置。
   *  形状对齐 Claude Code `.mcp.json`（command/args/env）。 */
  mcpServers?: Record<string, McpServerEntry>
  /** 外部 MCP server 表（项目域：projectConfigKey(projectRoot) → servers，各项目独立，同名项目域覆盖全局域） */
  mcpServersMap?: Record<string, Record<string, McpServerEntry>>
}
