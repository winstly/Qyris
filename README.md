# 轻驭 Qyris

<p align="center">
  <img src="build/icon.png" width="120" alt="Qyris Logo">
</p>

<p align="center">
  <strong>跨平台 AI 编程工作台</strong><br>
  预览 · 文件 · AI 对话 · 一站式开发体验
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

轻驭是一款本地运行的跨平台 AI 编程工作台。左侧是真实本地项目的文件树 + 代码编辑器 + 多服务运行预览，右侧是接入 OpenAI 兼容 API 的 AI 对话栏——AI 可以直接读写你的项目文件、探测技术栈、启动和管理多个本地服务。

## 功能特性

### 预览

- **多服务并行运行**——每个命名服务独立成槽，各自拥有独立的日志、状态、启停控制
- AI 自动探测技术栈并启动服务，服务名 / 启动命令 / 地址均由 AI 给出
- 阶段进度条：`编译中 → 部署中 → 运行中 / 异常`
- 运行中自动解析监听地址，iframe 实时预览
- 切换项目或退出时强制杀掉全部进程树

### 文件

- 文件树懒加载，万级文件不卡
- 文件名搜索
- 右键菜单：新建 / 重命名 / 删除
- 页签批量关闭
- 外部修改自动刷新
- CodeMirror 6 编辑器（语法高亮 + oneDark 主题）
- 所有文件操作经 IPC 白名单通道，渲染进程不直接碰文件系统

### AI 对话

- OpenAI 兼容流式对话（SSE）
- Markdown 渲染 + 代码块高亮 + 一键复制
- 工具调用过程可视化
- 内置工具：`list_files` / `search_files` / `read_file` / `write_file` / `run_project` / `get_build_status` / `stop_project` / `askUserQuestion`
- 真取消：「停止生成」在网络层硬中断请求

### 安全

- API Key 经系统级加密存储，明文永不进入渲染进程
- preload 逐方法白名单暴露，无通用 invoke 透传

### Skills 系统

- 可自定义的 Skill 指令集，扩展 AI 能力
- AI 根据用户问题自动匹配并加载对应 Skill

## 快速开始

### 环境要求

- Node.js ≥ 20
- npm

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
3. 填写模型名
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
├── build/                          # 应用图标
├── electron/
│   ├── main/index.ts               # 主进程
│   ├── preload/index.ts            # contextBridge 白名单
│   └── lib/                        # 文件操作 · 子进程 · AI 代理 · 凭据
└── src/
    ├── renderer/index.html         # HTML 入口
    ├── main.tsx / App.tsx          # 入口与布局
    ├── services/                   # AI 逻辑与工具定义
    ├── store/                      # zustand 状态管理
    └── components/                 # UI 组件
```

## 许可证

MIT
