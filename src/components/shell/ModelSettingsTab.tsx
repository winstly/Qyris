import type { ModelTiers } from '@/types'
import { IconCheck, IconAlert } from '@/components/common/icons'
import { Select } from '@/components/common/Select'

interface Props {
  dispatchMode: 'api' | 'claude-cli' | 'codex-cli'
  setDispatchMode: (v: 'api' | 'claude-cli' | 'codex-cli') => void
  cliPermission: 'auto' | 'readonly'
  setCliPermission: (v: 'auto' | 'readonly') => void
  cliCommand: string
  setCliCommand: (v: string) => void
  codexCommand: string
  setCodexCommand: (v: string) => void
  maxTurns: string
  setMaxTurns: (v: string) => void
  subagentMaxTurns: string
  setSubagentMaxTurns: (v: string) => void
  requestTimeoutMin: string
  setRequestTimeoutMin: (v: string) => void
  provider: 'openai' | 'anthropic'
  setProvider: (v: 'openai' | 'anthropic') => void
  baseUrl: string
  setBaseUrl: (v: string) => void
  apiKeyInput: string
  setApiKeyInput: (v: string) => void
  hasApiKey: boolean
  model: string
  setModel: (v: string) => void
  tiers: ModelTiers
  setTiers: React.Dispatch<React.SetStateAction<ModelTiers>>
  testResult: { ok: boolean; text: string } | null
}

/** 模型配置段（模型/记忆弹窗上半）：调度方式、服务商、Base URL、API Key、任务档位。
 *  纯 body——保存/测试等动作由宿主（ModelMemoryDialog）持有；Skills 目录已迁技能 tab 全局组 */
export function ModelSettingsTab(p: Props) {
  return (
    <>
      <div className="modal__body">
        <label className="field">
          <span className="field__label">调度模型方式</span>
          <Select
            value={p.dispatchMode}
            onChange={(v) => p.setDispatchMode(v as 'api' | 'claude-cli' | 'codex-cli')}
            options={[
              { value: 'api', label: 'API 直连（OpenAI 兼容 / Anthropic）' },
              { value: 'claude-cli', label: 'Claude CLI（本机 agent）' },
              { value: 'codex-cli', label: 'Codex CLI（本机 agent）' },
            ]}
          />
          <span className="field__hint">
            {p.dispatchMode === 'claude-cli'
              ? '经由本机 claude 命令自主执行，自带文件/命令工具与模型配置，无需 API Key；需已安装并登录 Claude Code'
              : p.dispatchMode === 'codex-cli'
                ? '经由本机 codex 命令自主执行（codex exec），工具经 qyris-tools MCP 挂载；需已安装并登录 Codex CLI'
                : '主进程直连模型服务；需要调度本机工具时切换到 Claude CLI / Codex CLI'}
          </span>
        </label>

        {(p.dispatchMode === 'claude-cli' || p.dispatchMode === 'codex-cli') && (
          <>
            <label className="field">
              <span className="field__label">CLI 命令</span>
              <input
                className="field__input mono"
                value={p.dispatchMode === 'codex-cli' ? p.codexCommand : p.cliCommand}
                onChange={(e) => (p.dispatchMode === 'codex-cli' ? p.setCodexCommand(e.target.value) : p.setCliCommand(e.target.value))}
                placeholder={p.dispatchMode === 'codex-cli' ? 'codex' : 'claude'}
              />
              <span className="field__hint">CLI 执行指令，留空默认 {p.dispatchMode === 'codex-cli' ? '"codex"' : '"claude"'}</span>
            </label>
            <label className="field">
              <span className="field__label">CLI 权限模式</span>
              <Select
                value={p.cliPermission}
                onChange={(v) => p.setCliPermission(v as 'auto' | 'readonly')}
                options={[
                  { value: 'auto', label: '全自动（跳过权限确认）' },
                  { value: 'readonly', label: '受限只读（仅检索类工具）' },
                ]}
              />
              <span className="field__hint">
                {p.dispatchMode === 'codex-cli'
                  ? '全自动 = workspace-write 沙箱（可改工作区文件、执行命令）；受限只读 = read-only 沙箱（只能读）'
                  : '全自动下 CLI 可直接改文件、执行命令；受限只读仅允许检索/浏览类工具，更安全但能力受限'}
              </span>
            </label>
          </>
        )}
        <label className="field">
          <span className="field__label">主对话工具循环轮数上限</span>
          <input className="field__input" type="number" min={4} max={500} step={1}
            value={p.maxTurns} onChange={(e) => p.setMaxTurns(e.target.value)}
            placeholder="留空不限制" aria-label="主对话工具循环轮数上限" />
          <span className="field__hint">AI 自主持续执行的单次轮数上限（API/CLI 通用）；留空 = 不限制，长程任务不设轮界</span>
        </label>
        <label className="field">
          <span className="field__label">子 agent 工具循环轮数上限</span>
          <input className="field__input" type="number" min={2} max={200} step={1}
            value={p.subagentMaxTurns} onChange={(e) => p.setSubagentMaxTurns(e.target.value)}
            placeholder="留空不限制" aria-label="子 agent 工具循环轮数上限" />
          <span className="field__hint">每个派发子任务的独立执行轮数；留空 = 不限制</span>
        </label>
        <label className="field">
          <span className="field__label">单轮补全超时（分钟，仅 CLI 档）</span>
          <input className="field__input" type="number" min={1} max={720} step={1}
            value={p.requestTimeoutMin} onChange={(e) => p.setRequestTimeoutMin(e.target.value)}
            placeholder="留空不限制" aria-label="单轮补全超时分钟数" />
          <span className="field__hint">单次模型调用超过该时长将被中止；留空 = 不限制，30 分钟长程任务也能跑完</span>
        </label>

        {p.dispatchMode === 'api' && (
          <>
            <label className="field">
              <span className="field__label">服务商</span>
              <Select
                value={p.provider}
                onChange={(v) => p.setProvider(v as 'openai' | 'anthropic')}
                options={[
                  { value: 'openai', label: 'OpenAI 兼容' },
                  { value: 'anthropic', label: 'Anthropic' },
                ]}
              />
              <span className="field__hint">Base URL 填服务 base（OpenAI 到 /v1，Anthropic 到 anthropic 根路径），具体端点由程序拼接</span>
            </label>

            <label className="field">
              <span className="field__label">API Base URL</span>
              <input className="field__input mono" value={p.baseUrl} onChange={(e) => p.setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
              <span className="field__hint">填 service base：OpenAI 到 /v1（阿里云为 …/compatible-mode/v1）；Anthropic 到根路径（如 …/apps/anthropic）</span>
            </label>

            <label className="field">
              <span className="field__label">API Key</span>
              <input className="field__input mono" type="password" value={p.apiKeyInput} onChange={(e) => p.setApiKeyInput(e.target.value)} placeholder={p.hasApiKey ? '已保存在系统 keychain（输入可覆盖）' : 'sk-…'} autoComplete="off" />
              <span className="field__hint">
                {p.hasApiKey
                  ? '已通过操作系统凭据存储加密保存，不写配置文件、不进 localStorage'
                  : '将存入操作系统 keychain（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service）'}
              </span>
            </label>
          </>
        )}

        {p.dispatchMode === 'api' && (
          <>
            <label className="field">
              <span className="field__label">主模型</span>
              <input className="field__input mono" value={p.model} onChange={(e) => p.setModel(e.target.value)} placeholder="gpt-4o-mini" />
              <span className="field__hint">规划 + 复杂任务 + 未配置档位的兜底模型</span>
            </label>

            <div className="field">
              <span className="field__label">任务档位模型（可选，留空用主模型）</span>
              <div className="settings-tiers">
                {([
                  { key: 'thinking', label: 'Thinking · 深度推理', hint: '疑难调试 / 架构分析' },
                  { key: 'fast', label: 'Haiku 级 · 轻量快速', hint: '查找 / 统计 / 总结' },
                  { key: 'middle', label: 'Sonnet 级 · 中等', hint: '常规代码修改' },
                  { key: 'heavy', label: 'Opus 级 · 最重', hint: '复杂重构 / 跨模块改动' },
                ] as const).map(({ key, label, hint }) => (
                  <label key={key} className="settings-tiers__row" title={hint}>
                    <span className="settings-tiers__label">{label}</span>
                    <input
                      className="field__input mono"
                      value={p.tiers[key] ?? ''}
                      onChange={(e) => p.setTiers((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder="留空用主模型"
                    />
                  </label>
                ))}
              </div>
              <span className="field__hint">按子任务难度自动选档，未配置回退主模型</span>
            </div>
          </>
        )}

        {p.testResult && (
          <div className={`notice ${p.testResult.ok ? 'notice--ok' : 'notice--err'}`}>
            {p.testResult.ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
            <span>{p.testResult.text}</span>
          </div>
        )}
      </div>
    </>
  )
}
