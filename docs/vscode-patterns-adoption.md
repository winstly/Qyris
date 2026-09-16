# 从 VSCode 源码采纳工程设计 — Qyris 落地方案

> **实施状态（2026-09-16）：Phase 0-3 已全部落地。** 实施结果与本方案的差异及有意裁剪项见文末 §7「实施记录」。


> 调研日期：2026-09-16。基于本地 vscode 源码（`src/vs`，行号以当前 checkout 为准）与 Qyris 全量源码勘察（95 文件 / ~20K 行）。
> 方法：不是"VSCode 有什么好的"，而是 **Qyris 有什么痛 → VSCode 哪个设计恰好是解**。每项结论均经双源交叉验证（Qyris 侧 文件:行号 + VSCode 侧 文件:行号）。

---

## TL;DR

Qyris 与 VSCode 规模差 50:1（20K vs ~百万行），照搬平台架构必死。值得拿的是**三类资产**：

1. **零依赖基础库**（lifecycle / event / cancellation / async / errors / log）——VSCode 里最经久打磨的部分，单文件可直接移植，是后面一切的地基；
2. **数据安全设计**（dirty 版本判定、保存串行化、mtime 冲突拒绝、工作区级 undo、备份防损坏）——ADE 替用户写文件，这是信任底座，Qyris 当前有**静默覆盖丢数据**的实际漏洞；
3. **协议与契约纪律**（单一契约源、结构化错误、配置 diff 事件）——消除 Qyris 的"同一套代码手写四遍"漂移。

**明确不抄**：DI 容器、扩展进程架构、完整 IChannel 协议、Layers 分层 lint、Storage scope 体系、ContextKeyExpr 表达式树（理由见 §6）。

---

## 1. Qyris 现状薄弱面（勘察结论，证据已复核）

| # | 薄弱面 | 关键证据 | 严重度 |
|---|--------|---------|--------|
| W1 | AI 写文件与用户未保存编辑**静默互踩**：dirty 文件跳过重载，磁盘已是 AI 内容，用户 Ctrl+S 直接覆盖 | `src/store/useFileStore.ts:342-344`（注释自认"dirty 保留用户编辑"）→ `:317` 直接覆盖写，全链无冲突检测 | 🔴 数据丢失 |
| W2 | 写文件非原子：`writeFile` 直接覆盖，崩溃可截断文件 | `electron/lib/fsops.ts:145-157` | 🔴 数据丢失 |
| W3 | 快照只有会话首版全量，会话内 AI 中间版本不可回退；回退无 diff 预览（盲操作） | `electron/lib/snapshot.ts:55-56`、`DiffView.tsx:1-4`（DiffView 仅服务 git） | 🟠 可恢复性 |
| W4 | 错误处理零兜底：主进程未捕获异常直接崩、渲染层无 ErrorBoundary、工具成败靠字符串前缀协议 | 全库 grep `uncaughtException/unhandledRejection/ErrorBoundary` 零匹配；`src/services/tools.ts:5-10` | 🟠 稳定性 |
| W5 | IPC 契约四份手抄：preload 实现 / main 注册 / desktop.ts 封装 / desktop-api.d.ts 类型，各写一遍 | `preload/index.ts:23-206`、`main/index.ts:71-270`、`desktop.ts:31-281`、`desktop-api.d.ts` | 🟠 漂移风险 |
| W6 | 无统一取消：四套机制（AbortController / 杀子进程 / 杀进程树 / 500ms 轮询），取消一条消息要打三路 | `ai-api.ts:18-27`、`ai-cli.ts:45-46`、`proc.ts:120-134`、`useChatStore.ts:639-654` | 🟡 一致性 |
| W7 | 无结构化日志：主进程仅 stdout（打包后不可见），无级别/落盘 | 30 处 console.warn 散落 7 个文件 | 🟡 可运维 |
| W8 | 配置无变更事件：多窗口 A 改设置 B 不知情；无 schema 版本迁移框架 | `preload/index.ts:182-205` 无 onConfigChanged；`config.ts:78-127` 逐字段 `??` | 🟡 一致性 |
| W9 | 事件系统裸奔：字符串通道、无组合子、API 模式广播/CLI 模式定向不一致、`requestWindowMap` 只写不读（死代码） | `emitter.ts:12,47,51`；`ai-api.ts:95` vs `ai-cli.ts:301` | 🟡 扩展性 |
| W10 | 流式渲染放大：每个 delta 触发全列表重渲染，MessageBubble 未 memo、无虚拟化 | `MessageBubble.tsx:11`、`MessageList.tsx:71-73`、`useChatStore.ts:210-232` | 🟡 性能 |
| W11 | AI 无内容搜索工具：search_files 只匹配文件名，AI 无法自主 grep 排障 | `fsops.ts:82-115`、`tools.ts` 工具清单 | 🟡 能力缺口 |
| W12 | 三套命令体系零共享：快捷键 if/else 硬编码、页签内联菜单、斜杠命令 | `useKeyboardShortcuts.ts:14-48`、`EditorPane.tsx:223-234` | ⚪ 技术债 |
| W13 | 子进程：runOnce 无排队去重；主进程 6 处 spawnSync 阻塞事件循环 | `proc.ts:466-521`、`proc.ts:40,123,341,430-437` | ⚪ 技术债 |

---

## 2. 采纳路线图（四阶段，每阶段独立可交付）

### Phase 0 · 基础库移植（地基，后续一切的前置）

从 VSCode 直接移植**零依赖纯 TS** 的 base 库，落到 `src/lib/base/`（渲染层与主进程共用；Electron 双 tsconfig 需确认 include 路径）。

| 模块 | VSCode 出处 | 移植内容 | 规模 |
|------|------------|---------|------|
| Disposable | `base/common/lifecycle.ts` | `Disposable` / `DisposableStore` / `MutableDisposable` / `DisposableMap` / `combinedDisposable` / `toDisposable`；可选 `GCBasedDisposableTracker`（FinalizationRegistry 泄漏报警，dev 开关） | ~300 行 |
| Event/Emitter | `base/common/event.ts` | `Event<T>` 可订阅函数形态 + `Emitter`（含 `onWillAddFirstListener` 钩子）+ 组合子 `once/map/filter/debounce/forward/any`；可选 `LeakageMonitor` 简化版（阈值告警即可，不必 ListenerRefusalError） | ~250 行 |
| CancellationToken | `base/common/cancellation.ts` | **全文整抄（207 行）**：父 token 级联、冻结单例 `Cancelled`、`cancelOnDispose` | 207 行 |
| Async 工具 | `base/common/async.ts` | 精选 6 个：`SequencerByKey`（26 行原文照抄）/ `Limiter`+`Queue` / `DeferredPromise` / `raceCancellationError` / `Delayer` / `AsyncIterableSource`（AI 流式推拉适配） | ~250 行 |
| 统一错误 | `base/common/errors.ts` | `onUnexpectedError` / `setUnexpectedErrorHandler` / `isCancellationError` / `CancellationError` / `ErrorNoTelemetry` | ~100 行 |
| Log 服务 | `platform/log/common/log.ts` + `bufferLog.ts` | `LogLevel` / `ConsoleLogger` / `MultiplexLogger` / `BufferLogger`（启动早期缓冲）+ 一个 `FileLogger`（electron-log 或自写 append，落 `userData/logs/main.log`） | ~150 行 |

**验收**：`npm run typecheck` 过；现有 `emitter.ts` 消费方（`emitToWindow`/`emitToAllWindows`）改写为 typed `Emitter` 后 smoke:cli / smoke:memory 全绿。

> ⚠️ 勘误提醒（vscode-patterns agent 核实）：网上资料常提的 `shutdownLeakDetector` 与 `Event.fromPromise` 在当前源码中**不存在**——泄漏检测真身是 `DisposableTracker.computeLeakingDisposables`（lifecycle.ts:141）与 `LeakageMonitor`（event.ts:1002）；promise→事件组合在 `AsyncIterableObject.fromPromise`（async.ts:2082）。

### Phase 1 · 数据安全（P0，信任底座）

**1.1 冲突检测 + 原子写**（解决 W1/W2）

VSCode 出处：`workbench/services/textfile/common/textFileEditorModel.ts`
- dirty 判定用 `model.getAlternativeVersionId() !== bufferSavedVersionId`（:619）——**undo 回到保存点自动变 clean**，比 Qyris 现在的 `dirty[path]: boolean` 语义准；
- 保存串行化 `saveSequentializer`（:809-821）：同文件永不并发写；
- `lastResolvedFileStat` 只接受 mtime 前进的 stat（:1014-1038），mtime 倒退/变更即进冲突模式，**拒绝静默覆盖**。

Qyris 落点：
- `src/store/useFileStore.ts`：`setContent`/`saveFile`（:304-336）改为记录 `savedAltVersionId`；`saveFile` 前比对磁盘 mtime 与打开时 stat，不一致弹「文件已被外部修改：覆盖 / 重新加载 / 另存」；
- `src/components/workspace/EditorPane.tsx`：model 管理处（:242-337）暴露 `getAlternativeVersionId`；
- `electron/lib/fsops.ts:writeTextFile`（:145-157）：改**临时文件 + rename 原子写**（Windows 用 `rename` 前先 `unlink` 目标或用 `MOVEFILE_REPLACE_EXISTING` 语义），一行 API 不变，调用方零改动。

**1.2 快照 v2：AI 编辑可回退、可预览、可崩溃恢复**（解决 W3）

VSCode 出处：
- 工作区级 undo：`platform/undoRedo/common/undoRedoService.ts` — workspace 元素在多个资源栈占位、`prepareUndoRedo()` 两阶段、一致性不满足时 `split()` 降级为单文件 undo（:814-827）；
- 备份防损坏：`workbench/services/workingCopy/common/workingCopyBackupTracker.ts` — dirty 防抖 1000ms 备份、备份文件 preamble+结束标记、半截文件恢复时判 corrupt 丢弃（:456-461）、关停先 cancel 全部挂起备份再 suspend（:68-79）。

Qyris 落点（`snapshot.ts` v2）：
- 快照粒度从"会话首版"升级为"**每次 AI 写文件前的版本**"（一次 AI 回合 = 一个 workspace undo 单元，含该回合改过的所有文件）；
- 回退入口接现有 `DiffView`（当前仅服务 git，`DiffView.tsx:1-4`）——回退前先看 diff；
- 恢复/回滚文件写盘走 1.1 的原子写；启动时扫描未完成快照 → 提示「检测到上次未完成的 AI 编辑：恢复 / 丢弃」（workingCopyBackupTracker 的恢复时机设计：等渲染就绪再扫，不阻塞启动）。

**验收**：手工剧本——①打开文件编辑不保存 → 让 AI 写同文件 → 保存 → 应弹冲突对话框而非静默覆盖；②AI 连续改 3 文件 → 一键回退整回合 → diff 预览正确；③写盘中途 kill -9 → 重启提示恢复，文件无截断。

### Phase 2 · 一致性契约（解决 W4/W5/W7/W8）

**2.1 错误兜底 + 工具结果结构化**
- 主进程：`main/index.ts` 注册 `process.on('uncaughtException'/'unhandledRejection')` → `onUnexpectedErrorHandler`（log + 可选弹窗，不退出）；`isCancellationError` 一律静默（VSCode 惯例：**取消不是错误**，errors.ts:109-111）。
- 渲染层：App 外层加一个 ErrorBoundary（30 行），崩溃显示「重载面板」而不是白屏。
- `tools.ts:5-10` 的字符串前缀协议改为 `{ ok: boolean; value?: string; error?: { kind: string; message: string } }`——消费方 `useChatStore.ts` / `subagent.ts` 的 `startsWith('错误：')` 全部替换；`isRetryableError`（`useChatStore.ts:634-636`）从正则猜改为按 `error.kind` 分类。

**2.2 IPC 契约单一事实源**（不上 ProxyChannel，先做类型层）
- 现状 `preload/index.ts:210` 已 `export type DesktopAPI = typeof desktopAPI` 但 `desktop-api.d.ts` 手抄一份。**最小动作**：d.ts 改为 `import type { DesktopAPI } from '../preload/index'`（tsconfig 隔离问题用 `types` 引用或抽出 `shared/ipc-contract.ts` 解），`desktop.ts` 的 281 行手写转发同步收敛——**四份变一份**；
- 通道名收进 `shared/ipc-channels.ts` 常量表，四处引用同一来源；
- 中期（若引入 utility process 再评估）VSCode `base/parts/ipc/common/ipc.ts` 的 `IChannel(call/listen)` + `ProxyChannel.toService` 模式：两个方法承载全部服务、`onXxx` 属性名约定即事件、token 取消跨进程透传。

**2.3 配置分层 + diff 事件**（解决 W8）
- VSCode 出处：`platform/configuration/common/configurationModels.ts` 的 compare diff（added/removed/updated 按 key 差集，:1283-1316）+ `affectsConfiguration` 单串 indexOf 判定（:1256-1280）。
- Qyris 落点：`config.ts` 增加 `onDidChange(affectedKeys: Set<string>)`；`mergeConfig` 成功后 `emitToWindow(win, 'config:changed', affectedKeys)`；preload 加 `onConfigChanged` 白名单；`useSettingsStore` 订阅后局部更新（受影响 key 才 set，避免全量覆盖用户正在编辑的表单）。顺带把 `DEFAULTS` 加 `schemaVersion` 字段，迁移函数按版本号链式执行，替代现在内联的 `skillsDir`→`skillsDirs` 兼容（`config.ts:52-60`）。

**2.4 日志落盘**（解决 W7）
- Phase 0 的 FileLogger 挂上：主进程 30 处 `console.warn('[tag]', ...)` 统一替换 `log.warn('tag', ...)`；打包产物日志落 `userData/logs/main.log`（轮转：按天或 5MB）；渲染层关键路径（CLI 事件、agent 循环错误）经 IPC `log:append` 汇入同一文件。

**验收**：①主进程抛未捕获异常 → 不崩、日志有记录；②A 窗口改设置 → B 窗口 1s 内生效；③删掉 desktop-api.d.ts 手抄段后 typecheck 仍过（证明单一事实源成立）。

### Phase 3 · 体验与性能（解决 W6/W9/W10/W11/W12/W13）

**3.1 统一取消**（W6）：Phase 0 的 CancellationToken 贯穿——`runAgentLoop` 创建 CTS，父 token 级联到 API fetch（`AbortController` 由 `raceCancellationError` 驱动）、CLI 子进程（token→kill）、runOnce（token→taskkill）；`sleepInterruptible` 500ms 轮询（`useChatStore.ts:639-654`）替换为 token 事件即醒。三路手动取消收敛为 `cts.cancel()` 一行。

**3.2 事件路由治理**（W9）：`emitter.ts` 的 `requestWindowMap` 死代码删除（只写不读：`:47` 写、`:51` 删、全库无读取）；`ai-api.ts:95` 的 deprecated 广播改为与 `ai-cli.ts:301` 一致的定向 `emitToWindow`；App.tsx 单 useEffect 接 8 个事件（`App.tsx:53-67`）拆为各 store 自己 `store.add(onXxx(...))` 订阅（DisposableStore 纪律）。

**3.3 渲染性能**（W10）：`MessageBubble` 加 `React.memo`（按 message 引用比较）；delta 聚合用 `MicrotaskEmitter` 思路（一帧至多 set 一次 state，而非每 token）；长会话上虚拟化（react-window 或手写窗口化，MessageList.tsx:71-73 全量 map 替换）。

**3.4 AI 内容搜索工具**（W11）：VSCode `workbench/services/search/common/searchService.ts` 形态——`search(query, token, onProgress)` 三件套（可取消 + 增量进度 + 聚合）。Qyris 最小版：主进程新增 `grep_files(pattern, glob, token)`（Node 原生逐行读 + 简单互斥上锁），`tools.ts` 注册为 AI 工具，进度按文件回传渲染为折叠卡片。ripgrep 二进制**暂不引入**（先验证 AI 用内容搜索的真实频率，再决定是否上 rg）。

**3.5 命令注册表**（W12）：轻量版 CommandsRegistry——`registerCommand({ id, run, when? })` + `executeCommand(id)` 单一入口；快捷键表、页签右键菜单（`EditorPane.tsx:223-234`）、斜杠命令全部从注册表取项。`when` 用简单谓词（`(ctx) => ctx.hasActiveEditor`），**不抄** ContextKeyExpr 表达式树。VSCode 的核心思想可移植：菜单项的 enabled 与命令执行条件**同源**（actions.ts:616），不会出现"按钮可点但命令拒绝"。

**3.6 子进程卫生**（W13）：`runOnce` 前 `SequencerByKey` 按工程排队去重（async.ts:337 原文 26 行）；6 处 `spawnSync`（`proc.ts:40,123,341,430-437`）改 `execFile` async + Promise，主进程事件循环不再被 5s 超时的 where.exe 阻塞。

**3.7 watcher 事件合并**（W9 关联）：VSCode `platform/files/common/watcher.ts` 的 `EventCoalescer`（:378-469，~90 行纯函数）套在 chokidar 外——同批 CREATE+DELETE 抵消、DELETE+CREATE 合成 UPDATED、父目录删除折叠子文件事件（Qyris 现在是 `rm -rf` 来一次转发几千事件再靠 App.tsx 400ms 手写节流兜底，`App.tsx:163-179`）。

**验收**：①AI 生成中点停止 → 三路（fetch/CLI 子进程/runOnce）全部即时终止（无 500ms 尾巴）；②1000 条消息会话滚动 60fps；③AI 对话要求"找出项目里所有用到 setTimeout 的地方"→ grep_files 工具触发并返回结果。

---

## 3. 快赢清单（半天内，顺手做掉）

| 动作 | 落点 | 收益 |
|------|------|------|
| 删除 `requestWindowMap` 死代码 | `emitter.ts:12,47,51` | 减认知负担 |
| `ai-delta` 从广播改定向 | `ai-api.ts:95,106,298,301` | 与 CLI 模式一致，多窗口少一次无效过滤 |
| `writeTextFile` 临时文件+rename | `fsops.ts:153` | 3 行防截断，独立于 Phase 1 其余项 |
| `MessageBubble` 加 memo | `MessageBubble.tsx:11` | 一行，流式渲染立省 80% 重渲染 |
| `process.on` 全局兜底 + 日志文件 | `main/index.ts` | 崩溃可查，打包后不再是黑洞 |
| `desktop-api.d.ts` 复用 `typeof desktopAPI` | `preload/index.ts:210` | 消灭四份手抄中最脆的一份 |

## 4. 工作量与依赖关系

```
Phase 0 基础库（S，1-2 天等效）────┬──→ Phase 1 数据安全（M，冲突+快照v2）
                                  ├──→ Phase 2 一致性（M，契约+配置+日志）
                                  └──→ Phase 3 体验（L，取消/渲染/搜索/命令）
快赢清单：任意时点插入，无依赖
```

## 5. 采纳纪律（防止抄歪）

1. **抄行为，不抄架构**：每个移植模块砍掉 VSCode 里为十万行级服务性存在的部分（profiling、单 listener 特化、稀疏数组压缩），保留语义内核；
2. **契约先行**：Phase 2 动 IPC/工具协议前，先写清新旧协议映射表再动手，`smoke:cli`/`smoke:memory` 是回归底线；
3. **每阶段独立交付**：任一阶段单独合入都不破坏现有功能——Phase 0 的 base 库进来的第一周只服务新代码，不强推存量替换。

## 6. 明确不抄清单（减法优先）

| VSCode 设计 | 不抄理由 |
|------------|---------|
| InstantiationService DI 容器 | 20K 行直接 import 单例足够，DI 的收益在百服务级 |
| Extension Host 进程 + 完整 IChannel 协议 | Qyris 无第三方扩展；单窗口 `ipcMain.handle` 直连更简单。引入 utility process（如 sqlite worker 已有雏形 `db.ts:149`）时再局部评估 |
| Layers 分层架构 + eslint 强制 | 代码量不支持四层划分，纪律成本 > 收益 |
| Storage scope 三库体系 | SQLite + config.json + zustand persist 三处持久化虽多，但 schema 简单；先把 W8 的配置事件补上再观察 |
| ContextKeyExpr 表达式树 | 手写谓词函数可序列化为字符串 id 已够；表达式解析器是纯成本 |
| ripgrep 二进制集成 | 先用纯 JS grep 验证需求，避免分发/平台二进制负担 |
| Working Copy / Hot Exit 全套 | Phase 1 的快照 v2 已覆盖 ADE 场景（AI 编辑恢复）的核心诉求 |
| Monaco 全量 model service / codeEditorService | Qyris 的薄 wrapper（EditorPane.tsx:242-352）够用，只取 `getAlternativeVersionId` dirty 判定思想 |

---

## 7. 实施记录（2026-09-16）

### 7.1 已交付

**Phase 0 · 基础库**（`shared/base/`，渲染层与主进程 tsconfig 共用）
- `lifecycle.ts`（DisposableStore / Disposable / MutableDisposable / DisposableMap）、`errors.ts`（onUnexpectedError / isCancellationError / ErrorNoTelemetry）、`cancellation.ts`（父 token 级联 / 冻结单例 / cancelOnDispose）、`event.ts`（Emitter 泄漏告警 + 组合子 + MicrotaskEmitter）、`async.ts`（SequencerByKey / Limiter / Delayer / DeferredPromise / raceCancellationError / sleepInterruptible / AsyncIterableSource）、`log.ts`（BufferLogger / MultiplexLogger / ConsoleLogger）+ `electron/lib/log-file.ts`（按天落盘，保留 7 天）。

**Phase 1 · 数据安全**
- `fsops.ts`：原子写（临时文件 + rename）；`writeTextFile` 带 mtime 冲突守卫（`FILE_CONFLICT::` 哨兵错误）；`readTextFile` 返回 mtimeMs。
- `useFileStore.ts`：mtime 基线跟踪；保存冲突 → 三选对话框（覆盖 / 重新加载 / 取消）；dirty 文件被 AI 改后**不再静默覆盖**。
- `snapshot.ts` v2：会话基线 + 版本快照双轨（每次 AI 写入前各留一份，每文件保留 9 版），`listFileSnapshotVersions / snapshotDiff / restoreSnapshotAt`；恢复走原子写。
- 新 UI `SnapshotHistoryDialog`：文件树右键「快照历史…」→ 版本列表 + unified diff 预览 + 定点回退；`textdiff.ts` 为零依赖行级 LCS diff。
- `tools.ts` write_file/edit_file 每次写入前双快照。

**Phase 2 · 一致性**
- 主进程 `uncaughtException / unhandledRejection / setUnexpectedErrorHandler` 全局兜底（取消静默），日志落盘 `userData/logs/`。
- 工具结果结构化：`ToolOutcome.ok` 取代「错误：」前缀 startsWith 协议（消费方 useChatStore / subagent 已切换）。
- 配置变更事件：`config.onConfigChanged(affectedKeys)` → `config:changed` IPC → 各窗口 `refreshRemoteConfig()`（boot 复用同一路径）。
- preload/d.ts/desktop 同步新通道（grep_files、snapshot v2、onConfigChanged）。

**Phase 3 · 体验与性能**
- 统一取消：每工程 CancellationTokenSource，`sleepInterruptible` 从 500ms 轮询改为 token 事件即时唤醒。
- 事件路由：`requestWindowMap` 死状态激活为 `emitToRequestWindow` 定向路由，API 模式 ai-delta 不再全窗口广播（与 CLI 模式一致）。
- 渲染：`MessageBubble` memo + App.tsx delta/reasoning 微任务批合（同帧 N 事件 → 1 次 store 更新）。
- AI 工具 `grep_files`：fsops 正则内容搜索（二进制跳过 / 512KB 单文件上限 / 有界遍历），TOOL_DEFS + 系统提示同步。
- 命令注册表 `services/commands.ts`（id + label + when 谓词），快捷键 hook 全部迁移为 id 绑定。
- 进程卫生：同工程 runOnce 经 SequencerByKey 串行排队；taskkill 与孤儿清理（powershell/ps）异步化，主进程不再被同步 spawn 阻塞。
- watcher：批内路径合并（去重 + 父目录折叠）。

**存量修复**：typecheck 从 ~30 处存量错误清零（其中 memory/service、ai-cli 的缺 `await` 属真实异步缺陷）；全量 `npm run build` 通过。

### 7.2 有意裁剪（与原方案差异）

| 项 | 裁剪理由 |
|----|---------|
| IPC 通道名常量表 | 通道字符串稳定且 desktop.ts 显式引用天然防漂移；收益低于全量改动风险 |
| App.tsx 事件订阅下沉各 store | 现有 offs 数组已符合 DisposableStore 纪律，等价满足 |
| 启动时"未完成 AI 编辑"恢复提示 | 原子写 + 快照历史已覆盖其场景，独立提示冗余 |
| 斜杠命令迁入命令注册表 | 斜杠命令是面向 LLM 的输入 DSL，与应用命令不同质，强并属"为统一而统一" |
| 页签右键菜单迁入命令注册表 | 注册表已就绪（seed），菜单迁移按需渐进 |
| CLI spawnSync `chcp` 探测异步化 | 一次性 ~50ms 懒初始化，异步化波及 buildChildEnv 同步契约 |

### 7.3 验收口径（本机实测）

- `npm run typecheck`：0 错误；`npm run build`：通过。
- smoke:cli / smoke:git：全绿；smoke:env：4 项失败 = 与 HEAD 基线持平（`where.exe` 探测类，本机环境）。
- smoke:memory：失败集为 HEAD 失败集的严格子集（comm 比对零新增；Windows 临时目录 EPERM + 原生依赖，存量问题）；smoke:memory-agent：HEAD 上即无法出断言（esbuild 本机 spawn 问题，存量）。
- GUI 手工剧本（冲突对话框 / 快照回退 diff / 停止生成即时性）需在桌面端按 §2 各阶段验收步骤人工确认——本环境无法运行 Electron GUI，此部分为待人工验收项。
