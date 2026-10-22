# codex app-server 协议定案（0.163.0 · Windows 实测 2026-10-22）

> 用途：codex provider（electron/lib/model/providers/codex.ts）app-server 通道的权威词表。
> 取证：真机探针 scripts/probe-codex-appserver.mjs × 6 轮 + `codex app-server generate-json-schema`
> + 官方 app-server 文档。改 codex provider 前必读。
> 真机端到端：npm run e2e:codex（纯补全）/ npm run smoke:codex-cli（假 server 全链断言）。

## 握手与生命周期

- 启动 `codex app-server`（stdio ndjson JSON-RPC 长驻）→ `initialize`（clientInfo）→
  `initialized` 通知 → `thread/start` → `turn/start` → 通知流 → `turn/completed` → kill
- 未知方法回 -32600 error（带全景）；**参数形状错直接 -32600 报错**（如 sandbox 驼峰），
  未知字段则静默忽略——所以「静默」= 键名不存在，「报错」= 键存在值不对

## thread/start（0.163.0 实测定案）

```json
{ "cwd": "<工程根>", "approvalPolicy": "on-request", "sandbox": "workspace-write" }
```

- `sandbox`：**kebab 字符串**（`read-only` / `workspace-write` / `danger-full-access`）。
  新版官方文档的驼峰 `workspaceWrite` 在 0.163 报 -32600；`sandboxPolicy` 对象形在本版不存在
- `approvalPolicy`：`never` 会让 MCP 工具调用直接被拒（"requires approval, but approval policy is
  never"），必须 on-request + 客户端自动应答审批
- Windows：workspace-write 沙箱不可用，回落 read-only（回显 sandbox.type=readOnly），
  原生命令全部走审批外逃——exec 可用性完全取决于审批应答
- `skipGitRepoCheck` 非本版字段（被忽略），无需传

## 审批（server→client 请求，必须应答否则 turn 挂死在 waitingOnApproval）

带 id + method 的帧 = 请求。0.163 实测三类 + 应答形状（generate-json-schema 口径）：

| 请求 | 应答 |
|------|------|
| `item/commandExecution/requestApproval` | `{"decision":"accept"}`（或 acceptForSession/decline/cancel） |
| `item/fileChange/requestApproval` | `{"decision":"accept"}`（同上值域） |
| `mcpServer/elicitation/request` | `{"action":"accept","content":null}`——MCP 工具调用审批带 `_meta.codex_approval_kind:"mcp_tool_call"`；真表单征集不要 accept |
| `item/permissions/requestApproval` | `{"permissions":{}}`（分文不授；无 decline 枚举，空授予=拒） |

Qyris 策略：exec 档命令/文件审批 accept，readonly/纯补全档 decline；mcp_tool_call 征集 accept；
其余 elicitation decline。`trusted = true`（config.toml mcp 段）在 0.163 被忽略（configWarning 官宣）。

## 事件词表（通知）

- 正文流式：`item/agentMessage/delta` `{itemId, delta}` 增量追加；`item/completed` 带全文兜底
- 思考流式：`item/reasoning/summaryTextDelta`（可读摘要）/ `item/reasoning/textDelta`（原始思考）
  ——两者都会来，provider 收到 summary 后弃 raw 防双份
- 用量：`thread/tokenUsage/updated` `{tokenUsage:{total:{inputTokens, outputTokens, cachedInputTokens}}}`
  （turn/completed 里**没有** usage）
- 收口：`turn/completed` `{turn:{status: completed|interrupted|failed, error:{message}}}`；
  `turn/failed` 方法在本版事件流中未出现（provider 容错保留）
- item 类型：userMessage / agentMessage{text,phase} / reasoning{summary,content}（**无 text 字段**）/
  commandExecution{command,cwd,status,**aggregatedOutput**(驼峰),exitCode} / mcpToolCall{server,tool,
  arguments,status,result:{content:[{type:'text',text}]},error} / fileChange / webSearch / plan 等
- 失败：`error` 通知（error.message）伴随 turn/completed status=failed；重连类消息透思考区不收口

## MCP 挂载

- CODEX_HOME 指 scratchDir + config.toml `[mcp_servers.qyris-tools]`（command/args/env 全显式）
- app-server 会启动 MCP server 并发 `mcpServer/startupStatus/updated`（starting→ready）
- MCP 工具调用走 elicitation 审批（必须 accept，见上）；accept 后 result 正常返回

## Skills（官方通道，Qyris 现走内联等价）

- 官方：turn/start input 混入 `{type:"skill", name, path}` 条目 + 文本里 `$<skill-name>` 标记；
  `skills/list {cwds}` 发现技能
- Qyris：skill 内容由 ai-cli.ts 内联进用户消息文本（`<skill id>` 块），随 serializeTurnInput
  replay 进 codex——内容可达即生效；CompletionRequest 无 skills 字段，provider 层拿不到 name+path，
  官方条目通道暂不启用（接入需先扩引擎契约）

## 工具

- `scripts/probe-codex-appserver.mjs`——真机探针（thread 参数矩阵 / exec / MCP 端到端取证）
- `codex app-server generate-json-schema --out <dir>`——本版权威数据结构（离线，别信网上文档的版本漂移）
