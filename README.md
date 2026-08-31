# 轻驭 Qyris

<p align="center">
  <img src="build/icon.png" width="120" alt="Qyris Logo">
</p>

<p align="center">
  <strong>跨平台 AI 编程工作台</strong><br>
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

轻驭是一款本地运行的跨平台 AI 编程工作台。左侧是真实本地项目的文件树 + 代码编辑器 + 多服务运行预览，右侧是接入 OpenAI 兼容 API 的 AI 对话栏——AI 可以直接读写你的项目文件、规划并编排子任务、按难度分配不同档位的模型执行、识别并管理多个本地服务。

## 功能特性

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
- 运行中自动解析监听地址，iframe 实时预览 + 多地址切换 + **系统默认浏览器打开**
- 切换项目或退出时强制杀掉全部进程树

### 文件

- 文件树懒加载，万级文件不卡
- 文件名搜索
- 右键菜单：新建 / 重命名 / 删除 / 切换分支
- 页签批量关闭
- 外部修改自动刷新
- CodeMirror 6 编辑器（语法高亮 + oneDark 主题）
- **Ctrl/Cmd+F 全局搜索**——编辑器未聚焦也能呼出
- 所有文件操作经 IPC 白名单通道，渲染进程不直接碰文件系统

### AI 对话与多 Agent 编排

- OpenAI 兼容流式对话（SSE）+ Anthropic 协议支持
- Markdown 渲染 + 代码块高亮 + 一键复制
- 工具调用过程可视化
- **规划优先**：非平凡任务先出编号计划，再拆分执行
- **子任务派发**（`dispatch_subtasks`）：
  - 子 agent **并行执行**，独立上下文互不污染
  - 按任务难度分配**档位模型**（Thinking / Haiku 级 / Sonnet 级 / Opus 级，未配置自动回退主模型）
  - 对话内实时面板：每个子 agent 的状态灯、转录逐条入账
  - **切换器 / 专注视图**随时查看任意子 agent 执行进度
  - 子 agent **独立 token 记账**，总额自动汇总到主对话
  - 失败自动重试（模型类错误），完成 / 取消自动清理出列表
- 内置工具：`list_files` / `search_files` / `read_file` / `write_file` / `run_once` / `report_start_commands` / `run_project` / `get_build_status` / `stop_project` / `dispatch_subtasks` / `askUserQuestion` / `load_skill`
- 真取消：「停止生成」在网络层硬中断请求，连同在途子 agent 请求一并取消
- **多模型档位设置**：主模型之外可配置 Thinking / Haiku 级 / Sonnet 级 / Opus 级四档，留空回退主模型

### 安全

- API Key 经系统级加密存储，明文永不进入渲染进程
- preload 逐方法白名单暴露，无通用 invoke 透传
- git URL / 分支名入参守卫，防 CLI 选项注入
- 外链统一经 `shell.openExternal`，仅允许 http/https

### Skills 系统

- 可自定义的 Skill 指令集，扩展 AI 能力
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

1. 填写 Base URL（任意 OpenAI 兼容端点）
2. 填写 API Key
3. 填写主模型名（可选：配置 Thinking / Haiku 级 / Sonnet 级 / Opus 级档位模型）
4. 点击「测试连接」

左上角「打开项目」选择任意本地目录即可开始。

## 开发命令

```bash
npm run dev         # 启动开发模式
npm run build       # 构建
npm run typecheck   # 类型检查
npm run dist        # 构建 + 打包安装包
```

## 目录结构

```
├── electron-builder.yml
├── build/                          # 应用图标（ico / png）
├── electron/
│   ├── main/index.ts               # 主进程（IPC 注册 · 窗口 · 外链治理）
│   ├── preload/index.ts            # contextBridge 白名单
│   └── lib/                        # 文件操作 · 子进程 · AI 代理 · 凭据 · Git
└── src/
    ├── renderer/index.html         # HTML 入口
    ├── renderer/main.tsx           # 渲染入口
    ├── App.tsx                     # 布局
    ├── services/                   # AI 逻辑 · 工具定义 · 子任务执行器
    ├── store/                      # zustand 状态（对话 · 文件 · 构建 · 子 agent）
    └── components/                 # UI 组件
```

## 许可证

MIT
