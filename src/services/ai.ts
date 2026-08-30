import type { OAIToolDef, SkillMeta } from '@/types'

/** API Key 在凭据存储中的账户名（与 electron/lib/secrets.ts 保持一致） */
export const SECRET_KEY = 'api_key'

export function buildSystemPrompt(projectPath: string | null, skillMetas: SkillMeta[] = []): string {
  const lines = [
    '你是轻驭（Qyris，Electron 桌面开发工作台）内置的 AI 编程助手。',
    '用户使用简体中文，默认用简体中文回复；代码、命令、标识符保持原样。',
    '回复简洁、直接、可执行，不写客套话。',
    '你拥有项目文件工具：list_files / search_files / read_file / write_file。修改文件前必须先 read_file 获取真实内容，禁止凭空臆造；写文件时给出完整内容并通过 write_file 落盘；需要定位文件而不知道确切路径时用 search_files 按文件名搜索。',
    '用户通过「AI 启动」按钮或明确要求启动项目时，视为已授权：先 list_files 检测技术栈特征文件（package.json / Cargo.toml / go.mod / pyproject.toml / pom.xml 等），必要时 read_file 查看 scripts 配置，确定启动命令后直接 run_project 启动（仅在存在多个合理命令且无法判断时才 askUserQuestion 询问）。工作台支持同时运行多个服务：每个服务取一个简短英文名（如 web / api / admin / blog-server），run_project 必须传 name 且各服务 name 不重复；多服务项目（如前后端分离）应逐个 run_project 启动，不要拼进一个脚本。启动后用 get_build_status 跟踪，并向用户分阶段汇报「编译 / 部署 / 运行」三个阶段各自的状态；编译失败时根据错误输出修改文件后再次 run_project 重启（同名服务会原地重启，不影响其他服务），直到运行成功或明确需要用户介入。',
    '需要用户在选项间做选择或补充信息时，调用 askUserQuestion。',
    '代码放在 markdown 代码块中并标注语言（```ts、```rust 等）。',
  ]
  if (projectPath) {
    lines.push(`当前打开的项目目录：${projectPath}。工具的 path/dir 参数传项目内相对路径（如 "src/main.tsx"），绝对路径也可以。`)
  } else {
    lines.push('当前未打开任何项目。涉及文件的操作前，先提醒用户点击「打开项目」。')
  }
  // Skills 摘要注入
  if (skillMetas.length > 0) {
    lines.push('')
    lines.push(`你有 ${skillMetas.length} 个可用 Skill（专业指令集）。当用户的问题匹配某个 Skill 的触发词或场景时，先调用 load_skill 加载完整指令，然后按指令执行。用户消息中引用多个 Skill 时，必须逐个 load_skill 全部加载后再执行，不要只加载一个。`)
    for (const s of skillMetas) {
      const triggers = s.triggers.length > 0 ? ` [${s.triggers.join(', ')}]` : ''
      lines.push(`- ${s.id}：${s.description}${triggers}`)
    }
  }
  return lines.join('\n')
}

/** 暴露给模型的 function calling 工具（OpenAI 格式） */
export const TOOL_DEFS: OAIToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出项目某个目录下的文件与文件夹（单层）',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '目录路径，相对项目根，如 "src" 或 "." ' },
        },
        required: ['dir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在项目内递归按文件名搜索（大小写不敏感子串匹配，node_modules 等目录自动跳过），返回相对路径列表',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '文件名关键字，如 "config" 或 "useBuildStore.ts"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取项目内文本文件内容（超长会截断）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对项目根' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入（创建或整体覆盖）项目内文本文件，父目录不存在会自动创建',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对项目根' },
          content: { type: 'string', description: '完整的文件内容（UTF-8 文本）' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_project',
      description: '在项目根目录以指定服务名启动（或重启）一个开发/构建命令。每个服务名独立成槽，同名重启只替换该服务，不影响其他已运行的服务。多服务项目应逐个启动、各取不同 name。启动前建议先与用户确认命令',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '服务名（简短英文，如 web / api / admin）；必填，用于区分多个同时运行的服务' },
          command: { type: 'string', description: '启动命令，如 "npm run dev"、"cargo run"、"go run ."、"mvn spring-boot:run"' },
        },
        required: ['name', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_build_status',
      description: '查看服务进程的状态。不传 name 时返回全部服务的总览（每服务一行：阶段/命令/地址）；传 name 时返回单个服务的三阶段（编译/部署/运行）详情、退出码与最近输出',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '可选：服务名。不传则汇总所有服务' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_project',
      description: '停止服务进程。传 name 停单个服务；不传则停止全部服务（各自结束整棵进程树）',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '可选：服务名；不传则停止全部' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'askUserQuestion',
      description: '当需要用户做选择或补充信息时，向用户提问并等待回答',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '问题文本' },
          options: { type: 'array', items: { type: 'string' }, description: '可选项；不传则用户自由输入' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '加载一个 Skill 的完整内容。当用户问题匹配系统提示中列出的某个 Skill 时调用，获取完整指令后按指令执行。同一 Skill 只需加载一次（结果会留在对话历史中）',
      parameters: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill 的 ID（系统提示中列出的路径，如 "debug-react.md"）' },
        },
        required: ['skill_id'],
      },
    },
  },
]
