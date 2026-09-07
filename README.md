# 轻驭 Qyris

<p align="center">
  <img src="build/icon.png" width="120" alt="Qyris Logo">
</p>

<p align="center">
  <strong>Agentic Development Environment</strong><br>
  预览 · 文件 · AI 对话 · 多 Agent 编排 · 一站式开发体验
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform">
  <img src="https://img.shields.io/badge/electron-44-47848f" alt="Electron">
  <img src="https://img.shields.io/badge/react-18-61dafb" alt="React">
  <img src="https://img.shields.io/badge/typescript-5.6-3178c6" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

---

## 什么是轻驭？

轻驭是一款本地运行的 **Agentic Development Environment（ADE）**。左侧是真实本地项目的文件树 + 代码编辑器 + 多服务运行预览，右侧是 AI 对话栏——AI 可以直接读写你的项目文件、规划并编排子任务、识别并管理多个本地服务。

## 功能特性

### 双模式 AI 调度

- **API 模式**：OpenAI 兼容（SSE）+ Anthropic 协议，直连云端模型；支持多档位模型（Thinking / Haiku / Sonnet / Opus），按子任务难度自动选档
- **CLI 模式**：经本机 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 调度自主 agent，CLI 自带文件读写、命令执行工具与模型配置，无需 API Key
- 两种模式共享同一对话界面，设置中一键切换
- CLI 模式支持 **Skill 协议**（`[[NEXT_SKILL]]` 请求附带指令集）和**启动命令协议**（`[[START_COMMANDS]]` 自动存档）
- CLI 工具调用实时回填：每个工具（Read / Write / Bash / Glob 等）渲染为折叠卡片，点击展开完整输入与输出
- CLI 子 agent（Agent/Task 派发）实时面板：工具调用逐条入账，结果自动回填，token 账目独立记账

### 项目创建

- **创建空项目 / 从远端克隆**（支持多仓库）
- 克隆前「测试连接」：验证仓库有效性并列出全部分支
- **分支选择**（支持搜索），按指定分支克隆
- 文件树右键**切换 Git 分支**：本地 + 远端分支统一列表，checkout 后文件树自动刷新

### 预览

- **AI 编译 / 运行两段式**：「AI 编译」探测技术栈、安装依赖、识别启动命令并存档；「运行」直接执行存档命令，**零模型调用**
- 重新识别需用户确认，杜绝重复消耗
- 一次性命令（依赖安装、构建验证）走 `run_once`，不污染服务列表
- **多服务并行运行**——每个命名服务独立成槽，各自拥有独立的日志、状态、启停控制
- 阶段进度条：`编译中 → 部署中 → 运行中 / 异常`
- 运行中自动解析监听地址，**WebContentsView** 独立进程预览 + 多地址切换 + 系统浏览器打开
- 预览页 **DevTools** 一键打开（独立 Chromium 实例，不影响主 UI）
- 一键清缓存刷新（`session.clearStorageData` + `clearCache`，按 origin 精确清理）
- **元素选取器**：悬浮高亮 → 点选元素 → IPC 回传 → 输入区卡片展示（浮动动画）→ 发送后以结构化 meta 呈现
- 启动失败报错区「发给 AI 修复」按钮，一键将 stderr 发到对话让 AI 诊断
- 弹窗打开时自动隐藏预览层（WebContentsView 是 native overlay，会遮挡 DOM 弹窗）
- 切换项目或退出时强制杀掉全部进程树

### 文件

- 文件树懒加载，万级文件不卡
- 文件名搜索
- 右键菜单：新建 / 重命名 / 删除 / 切换分支
- 页签批量关闭
- 外部修改自动刷新
- Monaco Editor（语法高亮 + 多语言支持）
- **Ctrl/Cmd+F 全局搜索**——编辑器未聚焦也能呼出
- 所有文件操作经 IPC 白名单通道，渲染进程不直接碰文件系统

### AI 对话与多 Agent 编排

- Markdown 渲染 + 代码块高亮 + 一键复制
- 工具调用过程可视化（折叠卡片：图标 + 标签 + 目标路径 + 状态指示器，点击展开详情）
- **规划优先**：非平凡任务先出编号计划，再拆分执行
- **子任务派发**（`dispatch_subtasks` / CLI Agent/Task）：
  - 子 agent **并行执行**，独立上下文互不污染
  - 按任务难度分配**档位模型**（Thinking / Haiku 级 / Sonnet 级 / Opus 级，未配置自动回退主模型）
  - 对话内实时面板：每个子 agent 的状态灯、转录逐条入账
  - **切换器 / 专注视图**随时查看任意子 agent 执行进度
  - 子 agent **独立 token 记账**，总额自动汇总到主对话
  - 失败自动重试（模型类错误），完成 / 取消自动清理出列表
- 内置工具（API 模式）：`list_files` / `search_files` / `read_file` / `write_file` / `run_once` / `report_start_commands` / `run_project` / `get_build_status` / `stop_project` / `dispatch_subtasks` / `askUserQuestion` / `load_skill`
- 内置工具（CLI 模式）：Read / Write / Bash / PowerShell / Glob / Grep / Edit / Agent / Task / WebFetch / WebSearch
- 真取消：「停止生成」在网络层硬中断请求，连同在途子 agent 请求一并取消

### 安全

- API Key 经系统级加密存储，明文永不进入渲染进程
- preload 逐方法白名单暴露，无通用 invoke 透传
- git URL / 分支名入参守卫，防 CLI 选项注入
- 外链统一经 `shell.openExternal`，仅允许 http/https
- 预览 WebContentsView 启用 sandbox + contextIsolation + 禁 nodeIntegration

### Skills 系统

- 可自定义的 Skill 指令集，扩展 AI 能力
- 支持**多目录**配置（`skillsDirs`），按目录序首中优先
- Skill 索引注入系统提示，CLI 可通过 `[[NEXT_SKILL: id]]` 请求下一轮附带全文
- AI 根据用户问题自动匹配并加载对应 Skill

## 快速开始

### 环境要求

- Node.js ≥ 20
- npm
- git（克隆 / 分支功能依赖）

### 安装与运行

```bash
git clone git@github.com:winstly/Qyris.git
cd Qyris
npm install
npm run dev
```

### 配置 AI

首次打开后，点击右上角对话栏的齿轮图标：

1. 选择调度模式：**API 直连** 或 **Claude Code CLI**
2. API 模式：填写 Base URL + API Key + 主模型名 + 可选档位模型
3. CLI 模式：本机需已安装 Claude Code CLI（`npm install -g @anthropic-ai/claude-code`）并完成登录
4. 点击「测试连接」

左上角「打开项目」选择任意本地目录即可开始。

### 常见问题

#### Electron 二进制缺失（"Error: Electron uninstall"）

`npm install` 后报错 Electron 二进制缺失，通常是网络问题：

1. **使用镜像**：项目 `.npmrc` 已配置 npmmirror 镜像，通常自动生效
2. **手动安装**：`node node_modules/electron/install.js`
3. **设置环境变量**：`ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ npm install`

#### 子进程输出乱码（Windows）

Windows 子进程（如 `taskkill`、`netstat`）输出使用系统 OEM 代码页（中文 = GBK），程序已内置自动检测。如仍乱码，确认系统代码页设置正确（`chcp` 查看）。

## 开发命令

```bash
npm run dev         # 启动开发模式
npm run build       # 构建
npm run typecheck   # 类型检查（渲染层 + 主进程双 tsconfig）
npm run dist        # 构建 + 打包安装包

# 冒烟测试
npm run smoke:cli   # CLI adapter 全链路（序列化 / 参数 / 罐装 NDJSON 事件）
npm run smoke:git   # Git 操作（分支 / 提交 / 状态解析）
npm run smoke:env   # 子进程环境（PATH 探测 / 命令检测 / 编码）
```

## 目录结构

```
├── electron-builder.yml
├── build/                          # 应用图标（ico / png）
├── electron/
│   ├── main/index.ts               # 主进程（IPC 注册 · 窗口 · 外链治理）
│   ├── preload/index.ts            # contextBridge 白名单（~85 IPC 通道）
│   └── lib/
│       ├── ai.ts                   # AI dispatch 层（API / CLI 双 adapter 分发）
│       ├── ai-api.ts               # API adapter（OpenAI / Anthropic SSE）
│       ├── ai-cli.ts               # CLI adapter（Claude Code stream-json NDJSON）
│       ├── preview.ts              # 预览 WebContentsView 管理器
│       ├── proc.ts                 # 子进程管理（多槽 · 生命周期 · 端口查询）
│       ├── proc-env.ts             # 子进程环境构建（PATH 探测 · OEM 编码检测）
│       ├── config.ts               # 配置读写
│       ├── secrets.ts              # Keychain 凭据
│       ├── emitter.ts              # 多窗口事件路由
│       ├── consolebridge.ts        # 预览控制台桥（归一化 · 缓冲 · 广播）
│       ├── inspect.ts              # 元素选取器（IPC 回传）
│       ├── skills.ts               # Skill 目录扫描与读取
│       ├── git.ts                  # Git 操作
│       ├── fsops.ts                # 文件操作
│       ├── watcher.ts              # 文件变更监听
│       └── snapshot.ts             # 文件快照与回滚
└── src/
    ├── renderer/main.tsx           # 渲染入口
    ├── App.tsx                     # 布局 · 全局事件接线 · 弹窗/预览层联动
    ├── services/
    │   ├── ai.ts                   # 工具定义 · 系统提示
    │   ├── desktop.ts              # IPC 封装层
    │   ├── tools.ts                # 工具执行器
    │   └── subagent.ts             # API 子任务执行器
    ├── store/
    │   ├── defaults.ts             # 共享默认值（DEFAULT_SETTINGS）
    │   ├── useProjectStore.ts      # 工程路径单一事实源
    │   ├── useSettingsStore.ts     # 设置 / Skill 元数据只读镜像
    │   ├── useStartupStore.ts      # 启动命令存档
    │   ├── useChatStore.ts         # 对话状态 + Agent 循环 + CLI 事件处理
    │   ├── useAgentStore.ts        # 子 agent 线程状态
    │   ├── useAppStore.ts          # 全局应用状态（编排层）
    │   ├── useBuildStore.ts        # 编译流水线状态机
    │   ├── useFileStore.ts         # 文件树状态
    │   └── useGitStore.ts          # Git 状态
    ├── components/
    │   ├── chat/                   # 对话面板 · 工具卡片 · 子 agent 面板
    │   ├── workspace/              # 预览 · 编辑器 · 文件树 · Git
    │   ├── shell/                  # 设置 · 状态栏
    │   └── common/                 # 通用组件
    ├── styles/                     # CSS（BEM 命名 · z-index 阶梯）
    ├── types/                      # 共享类型
    ├── hooks/                      # 自定义 hooks
    └── utils/                      # 工具函数
```

## 架构设计

### Store 依赖图（零循环依赖）

```
useProjectStore   ← projectPath 单一事实源
useSettingsStore  ← settings / skillMetas / skillsDirs 单一事实源
useStartupStore   ← startupCommands 单一事实源
useAppStore       → 写入上述三个 store + 编排 UI 状态
useChatStore      → useSettingsStore + useStartupStore + useAgentStore
useBuildStore     → useProjectStore
useAgentStore     → 无 store 依赖
```

### AI 双 Adapter

```
渲染层 send() → useChatStore.runAgentLoop()
                  ├─ API 模式 → ai-api.ts（OpenAI/Anthropic SSE，tool_calls 回渲染层执行）
                  └─ CLI 模式 → ai-cli.ts（Claude Code stream-json，工具由 CLI 自主执行）
                       ├─ stream_event → ai-delta / ai-reasoning / cli-tool-event
                       ├─ user (tool_result) → cli-tool-result / cli-agent-event
                       └─ result → 权威收口
```

## 许可证

MIT
