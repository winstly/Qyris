import type { OAIToolDef, SkillMeta } from '@/types'

/** API Key 在凭据存储中的账户名（与 electron/lib/secrets.ts 保持一致） */
export const SECRET_KEY = 'api_key'

export function buildSystemPrompt(projectPath: string | null, skillMetas: SkillMeta[] = []): string {
  const lines = [
    '你是轻驭（Qyris，Electron 桌面开发工作台）内置的 AI 编程助手。',
    '用户使用简体中文，默认用简体中文回复；代码、命令、标识符保持原样。',
    '回复简洁、直接、可执行，不写客套话。',
    '你拥有项目文件工具：list_files / search_files / read_file / write_file。修改文件前必须先 read_file 获取真实内容，禁止凭空臆造；写文件时给出完整内容并通过 write_file 落盘；需要定位文件而不知道确切路径时用 search_files 按文件名搜索。',
    '「AI 编译」流程（用户点击「AI 编译」按钮，或要求识别启动命令 / 编译项目 / 准备运行环境时）：① 先 list_files 检测技术栈特征文件（package.json / Cargo.toml / go.mod / pyproject.toml / pom.xml 等），必要时 read_file 查看 scripts 配置；② 需要安装依赖或验证编译时用 run_once 执行一次性命令（不要用 run_project，编译类命令不建服务槽）；③ 识别出每个需要长期运行的服务（如前后端分离项目的 web / api）的启动命令后，用 report_start_commands 一次性提交，服务名用简短英文且不重复，run 填完整启动命令。提交后即完成，不要直接 run_project 启动服务——运行由用户决定。仅在存在多个合理命令且无法判断时才 askUserQuestion 询问。',
    '用户在对话中明确要求「启动 / 运行」某服务时，才直接 run_project（每个服务取简短英文名，多服务逐个启动，不要拼进一个脚本），启动后用 get_build_status 跟踪「编译 / 部署 / 运行」阶段并向用户汇报；编译失败时根据错误输出修改文件后再次 run_project 重启（同名服务原地重启，不影响其他服务）。启动过的服务命令会自动沉淀，供用户之后一键运行。',
    '需要用户在选项间做选择或补充信息时，调用 askUserQuestion。',
    '工作方式（任何非平凡任务）：① 先给出简短的编号计划（要做哪几步、每步交给哪个档位），再开始执行；② 边界清晰、可独立完成的子任务用 dispatch_subtasks 派发给子 agent（各自独立上下文，禁止子任务再嵌套派发），按难度选档位：fast=查找/统计/轻量总结，middle=常规代码修改，heavy=复杂重构/跨模块改动，thinking=疑难调试/深度推理，main=主模型；未配置的档位自动回退主模型；③ 简单问答或一两步能完成的事直接做，不需要计划与派发；④ 子任务结果返回后核对并汇总，不照单全收。',
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
      name: 'run_once',
      description: '在项目根目录执行一条一次性命令（跑完即退出：安装依赖、构建、测试等），不创建服务槽。返回退出码与尾部输出。AI 编译阶段用它装依赖 / 验证编译，不要用它启动长期服务',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令，如 "npm install"、"cargo build"、"mvn -q package"' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'report_start_commands',
      description: 'AI 编译阶段的收尾动作：提交识别出的启动命令清单（每个需要长期运行的服务一项）。保存后用户可在预览面板一键「运行」。提交即代表识别完成，之后不要再 run_project 启动服务',
      parameters: {
        type: 'object',
        properties: {
          services: {
            type: 'array',
            description: '服务列表',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '服务名（简短英文，如 web / api / admin）' },
                run: { type: 'string', description: '启动命令，如 "npm run dev"、"uvicorn main:app --reload"' },
              },
              required: ['name', 'run'],
            },
          },
        },
        required: ['services'],
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
      name: 'dispatch_subtasks',
      description: '将拆分好的子任务派发给独立子 agent 并行执行。每个子任务拥有独立上下文与相同的项目工具；按 tier 选择档位模型：fast=轻量快速、middle=常规修改、heavy=最重、thinking=深度推理、main=主模型（未配置的档位回退主模型）。子任务间并行执行，必须相互独立——不要派发会写同一文件或相互依赖执行顺序的任务。适合边界清晰、可独立描述的子任务；琐碎小事不要派发',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: '子任务列表（按执行顺序）',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '子任务标题（简短）' },
                instruction: { type: 'string', description: '给子 agent 的完整指令：目标、涉及文件/约束、期望产出' },
                tier: { type: 'string', description: '模型档位，默认 main', enum: ['main', 'thinking', 'fast', 'middle', 'heavy'] },
              },
              required: ['title', 'instruction'],
            },
          },
        },
        required: ['tasks'],
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
