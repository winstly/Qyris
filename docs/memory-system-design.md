# Qyris 分层记忆系统 · 设计定稿

> 2026-09-08 定稿。决策依据：memU（E:\DevelopWorkspace\memU，v0.11.0-beta.3）源码调研 + Qyris 全模块侦察，全部结论可回溯 file:line。

## 0. 已定案决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 历史兼容 | 不考虑 `.qyris` 旧 JSON 兼容，SQLite 直接成为唯一事实源（无存量用户） |
| 2 | 向量引擎 | **sqlite-vec**（sqlite-vss 已被作者废弃，vec 为官方继任：纯 C 零依赖、增量写入不重建索引） |
| 3 | clear 语义 | **开新会话、历史保留入库**（旧行为是覆写清空、历史真丢） |
| 4 | embedding 来源 | **本地模型 BGE-small-zh**（transformers.js/onnx，量化 ~30MB），离线零配置、记忆不出机；模型加载失败降级 FTS-only；中文 FTS5 用 trigram 分词器（unicode61 对中文无效） |
| 5 | mem agent | 主进程 headless 单轮调用、无工具、**middle 档**（蒸馏质量优先；每轮热路径检索保持零 LLM） |
| 6 | 数据存储位置 | 用户可在设置中自定义数据目录；`.qyris` 只存系统必须（config/secrets），用户数据默认 `~/.qyris/data`，变更时自动迁移 |

## 1. Working Backwards：场景倒推

| 场景 | 需要什么 |
|---|---|
| 上周说过"用 pnpm 别用 npm"，新会话 AI 直接用 pnpm | 长期记忆：用户偏好，跨会话注入 |
| 三天前调过登录 bug，今天说"还是那个问题" | 长期记忆：项目事件/教训，语义检索命中 |
| 会话第 40 轮，AI 还记得开头定的方案约束 | 工作记忆：滚出窗口的部分压缩成会话摘要，替代掐头留尾硬截断 |
| 几千条消息，向上滚动流畅翻历史 | 消息原数据 keyset 分页（P0 独立交付） |

## 2. 核心架构决策

- **D1 SQLite 单库 + project_key 列隔离（不分库）**：`<dataDir>/qyris.db`（WAL，messages + 记忆同库），dataDir 布局见 §4.1。工程键 `sha1(projectRoot)[:16]` 沿用 `sessions.ts` / `snapshot.ts` 双先例。万级行规模单库事务简单，跨工程全局记忆免费；主进程单连接同步短查询语句级串行；但 await 边界（embed 等）之间的 check-then-act 可交错——一致性纪律已固化为：查重/累加收进同一同步事务（createOrFoldAtomic 等，见 memory/service.ts）+ `idx_mem_active_title` 部分唯一索引兜底 + embed 串行队列 + memory-changed 变更广播。
- **D2 sqlite-vec 而非 sqlite-vss**：`vec0.dll` 随 electron-builder `extraResources` 打包，运行时 `db.loadExtension()`。
- **D3 mem agent = 事件触发的 headless 单轮调用**：memU 的 bridging task 即此形态（"a headless agent run whose prompt is the four-step pipeline"），但它够不着宿主会话边界只能小时级盲钟；Qyris 拥有会话生命周期，**在 sessionId 换代瞬间做晋升 job** 是其架构做不到的差异化点。
- **D4 存储零 LLM 判断（memU 哲学）**：记忆服务只做 embed/存/检索；一切"要不要记、怎么合并、要不要晋升"由 mem agent 判断。memU 的 v1 内联提取管线（两个 ~1500 行 mixin）在 2.0-beta 被亲手判死删码——纪律：**写入重判断、读取轻检索**。
- **D5 不建记忆关联图**：memU ADR 0007 设计 Node/Edge 图后自我推翻（"an entity index is not a graph — it is only a ranking feature"）。溯源用 source JSON 列。

## 3. 三层记忆模型

三层不是三张表，是 `mem_items.tier` + 各自生命周期：

| 层 | 本体 | 载体 | 生命周期 |
|---|---|---|---|
| 工作记忆 | 当前会话活跃上下文 = 最近 K 轮原数据 + 1 条滚动摘要 | messages 窗口 + `category='summary'` 条目（每会话至多一条 active，last-write-wins） | 随会话 |
| 短期记忆 | 会话内事件：决策、失败尝试、临时指令 | `tier='short'` + `session_id` | 会话收尾时晋升判断：高价值→long，其余归档 |
| 长期记忆 | 跨会话知识：preference / fact / event / lesson / skill | `tier='long'` + `project_key`（或 `'global'`） | 只合并归档不删除 |

工作记忆直接修复两个现存痛点：API 模式 `buildHistory` 全量重建 → 摘要+窗口；CLI 模式 `serializeConversation` 的 160k 掐头留尾（`ai-cli.ts:121`）→ 摘要+留尾。

## 4. Schema

```sql
-- 消息原数据：唯一事实源，分页/工作记忆都从这里出
CREATE TABLE messages (
  id TEXT PRIMARY KEY,              -- 渲染层 uid()
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,         -- ChatSlice.sessionId，clear 即换代
  seq INTEGER NOT NULL,             -- 会话内单调递增
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  reasoning TEXT,
  meta_json TEXT,                   -- MessageMeta
  tool_json TEXT,                   -- {toolCalls, toolResults}（历史重建用）
  created_at INTEGER NOT NULL,
  UNIQUE(project_key, session_id, seq)
);
CREATE INDEX idx_msg_page ON messages(project_key, session_id, seq DESC);

-- 记忆条目
CREATE TABLE mem_items (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,        -- 'global' = 跨工程
  session_id TEXT,                  -- short 层归属；long 为 NULL
  tier TEXT NOT NULL CHECK(tier IN ('short','long')),
  category TEXT NOT NULL,           -- preference|fact|event|lesson|skill|summary
  title TEXT NOT NULL,              -- 一行摘要（嵌入时与 content 拼接）
  content TEXT NOT NULL,
  source_json TEXT,                 -- 溯源：message ids / snapshot refs
  importance REAL DEFAULT 0.5,
  access_count INTEGER DEFAULT 0,
  last_accessed_at INTEGER,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','merged','archived')),
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_mem_scope ON mem_items(project_key, tier, status);

-- 向量：sqlite-vec vec0 虚表
CREATE VIRTUAL TABLE mem_vec USING vec0(
  item_id TEXT PRIMARY KEY,
  embedding FLOAT[512]              -- bge-small 维度；记 meta 表，换模型全量重嵌
);

-- 关键词召回：FTS5（中文用 trigram 分词器）
CREATE VIRTUAL TABLE mem_fts USING fts5(title, content, tokenize='trigram');
```

### 4.1 存储布局与迁移

```
~/.qyris/                      # 系统必须（永不迁移）
  config.json                  # 含 dataDir 指针本身（引导键）
  secrets.json                 # safeStorage 加密，绑定当前机器用户，不迁

<dataDir>/                     # 用户数据（默认 ~/.qyris/data，设置可改）
  qyris.db                     # 唯一库文件：messages + 记忆全部表（WAL；
                               #   运行期伴生 -wal/-shm，正常退出自动合并消失）
  snapshots/                   # 文件快照（按工程哈希/会话分目录）
```

- **迁移流程**：设置改目录 → 主进程关 DB 连接 → 同卷 rename（瞬时）或跨卷 copy + `integrity_check` 验证后删源 → 更新 `config.dataDir` → 重开连接；任一步失败指针回滚、源数据不动。
- **网络盘/同步盘**：WAL 在网络共享上有损坏风险——UNC 路径（`\\server\share`）自动检测，db.ts `openAt` 降级 `journal_mode=DELETE` 并 console.warn；migrate.ts 目标校验同理警告。映射盘符的网络驱动器无可靠检测，保守不报。
- Electron 自身 `userData`（window-state / pending-kill）属应用元数据，维持现状不动。
- 热备份用 `VACUUM INTO` 取一致性快照。

## 5. 检索链路（每轮对话前，主进程，零 LLM）

```
query = 最新用户消息
 ├─ FTS5 BM25 top-8 ──┐
 ├─ vec0 KNN top-8  ──┤→ RRF 融合 + recency/importance 轻加权 → top 5-8
 └─（memU 教训：全链一次 embedding 调用，不做 LLM rerank）
→ 组装「【长期记忆】」块注入
   · API 模式：buildSystemPrompt 追加
   · CLI 模式：与 Skill 标记同通道拼进首条 user 历史
→ fire-and-forget 回写 access_count / last_accessed_at
```

本地 embedding：`electron/lib/memory/embed.ts` 加载 BGE-small-zh-v1.5（transformers.js，**WASM 后端**），批量接口 `embedTexts(texts[])`；加载失败自动降级 FTS-only（功能完整、语义匹配弱），不阻塞对话。

**已实测配方**（2026-09-08 探针 ALL GREEN：33ms/条、批量×3 15ms、512 维）：onnxruntime-node 原生绑定在本机 DLL 初始化失败（1.22/1.24 双版本皆炸），运行时方案为 Module._load shim 屏蔽 + `Symbol.for('onnxruntime')` 全局注入 `onnxruntime-web` 强制 WASM + `useWasmCache=false` + wasmPaths 用 file:// URL（Node 动态 import 只认 URL）+ numThreads=1；模型源 hf-mirror 国内镜像，缓存落 `<dataDir>/models`。FTS5 trigram 中文仅匹配 ≥3 字查询，1-2 字词走 LIKE 兜底。

## 6. mem agent 管线（主进程，旁路，永不阻塞对话）

```
触发
 ├─ 滚动提取：每完成 ≥6 轮 → 增量 transcript（自上次游标）
 ├─ 收尾提取：sessionId 换代 / 关工程 → 收尾 + 短期晋升判断（Qyris 差异化点）
 ├─ 手动：记忆面板「立即整理」
 └─ 防自食：mem agent 运行不写 messages 表（memU MEMU_BRIDGING_RUN 教训）

输入 = 增量 transcript：纯消息原文 + 工具名/一行摘要（不付工具结果 token，
       memU 双 transcript 设计）；上限：单 run ≤10 会话、资源 ≤50 条
输出 = 严格 JSON ops：create / patch / archive / []（空数组合法）
     + create 直接给 tier（晋升内置，不做独立流程）

频控：per-project 串行队列 + 全局冷却 60s + 失败退避
嵌入纪律（memU 同款）：plan→embed→write 不交错，失败即整体 no-op；
  按文本集合 diff，未变文本保留原向量不重算；embedding 批 64
```

**Prompt 纪律（memU 原文移植）**：no-op 合法（"do not invent a memory to justify the run"）/ 合并优先于新建 / 读不到的不许猜（宁可 null）/ 密钥过滤。

## 7. 消息列表：原数据 keyset 分页

```sql
最新页：  WHERE project_key=? AND session_id=? ORDER BY seq DESC LIMIT 50
向上翻页:  ... AND seq < :cursor ORDER BY seq DESC LIMIT 50
```

- 打开工程取最新 50 条入 `ChatSlice`，渲染层心智不变（窗口有下界）
- 上翻到顶：`messages_before(cursor)` IPC → prepend 后按高度差修正 `scrollTop`（视口零跳动）
- 写路径：废除 App.tsx 400ms 防抖全量覆写，改稳定点 write-through——user 发送 INSERT / assistant finalize UPSERT / toolResult 追加 UPDATE / error 收尾 UPSERT；流式 pending 只活在内存
- clear() = 开新会话（sessionId 换代），旧会话保留在库
- 删除工程 = `DELETE WHERE project_key=?`（含 mem_items / vec / fts）

## 8. 模块打通矩阵

| 模块 | 记忆事件 | 期 |
|---|---|---|
| chat/agent loop | transcript 游标（提取原料） | P2 |
| build 状态机 | error+FATAL_HINTS / 跨工程端口冲突 → lesson | P2 |
| proc run_once | 非零退出命令 → lesson | P2 |
| snapshot | sessionId 分箱 → 溯源 + "本会话改过哪些文件" | P2（只做 source） |
| consolebridge | 预览报错→lesson（error 级别、30s 同消息去重、每预览会话最多 3 条） | P3 ✅ |
| git | 分支事件→lesson | **暂缓**（git 模块无事件系统，hook UI 调用点侵入性大；设计标"噪音大，谨慎"，按意图不做） |

## 9. 分期落地

| 期 | 内容 |
|---|---|
| P0 基座 | better-sqlite3 接入（首验 Electron 44 ABI，备选 node:sqlite）+ dataDir 解析器与默认布局（§4.1）+ messages 表 + 写路径重构 + 分页 IPC（五层接线四件套）+ MessageList 翻页 |
| P1 检索 | sqlite-vec 加载 + 本地 embedding（BGE-small-zh）+ mem_items/FTS(trigram) + 记忆管理面板 + 存储位置设置项与迁移 |
| P2 管线 | mem agent（滚动+收尾）+ 工作记忆 summary + buildHistory 窗口化 + 记忆注入 + 引用 chip + build/run_once 教训 |
| P3 打磨 | CLI serialize 接摘要 + 衰减/归档作业 + 导出导入 |

每期配 `smoke:memory` 冒烟（沿用 scripts/smoke-*.ts 模式）：建库→分页断言→检索断言→mem agent prompt 组装断言（LLM mock）；验证命令不吞退出码。

## 10. 风险

1. **better-sqlite3 × Electron 44 ABI**：唯一硬风险，P0 第一件事验证；失败备选 node:sqlite（loadExtension 需实测）。
2. sqlite-vec dll 打包与 loadExtension 路径：P1 首验。
3. 主进程同步查询全部走索引短查询；全量重嵌分批 + setImmediate 让路。
4. 记忆质量：no-op 纪律 + 向量相似度 >0.92 提示 patch 优先。
5. 记忆库本地明文；面板提供一键清空与导出。
