import type { ModelTiers } from '@/types'
import { IconClose, IconCheck, IconAlert, IconFolder } from '@/components/common/icons'
import { Select } from '@/components/common/Select'

interface Props {
  dispatchMode: 'api' | 'claude-cli'
  setDispatchMode: (v: 'api' | 'claude-cli') => void
  cliPermission: 'auto' | 'readonly'
  setCliPermission: (v: 'auto' | 'readonly') => void
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
  editingDirs: string[]
  setDirsDraft: React.Dispatch<React.SetStateAction<string[] | null>>
  commitDirs: (list: string[]) => void
  skillsDirs: string[]
  skillMetas: { id: string }[]
  loadSkills: () => void
  pickSkillsDir: () => Promise<string | null | undefined>
  testResult: { ok: boolean; text: string } | null
  testing: boolean
  onTest: () => void
  onClearKey: () => void
  onSave: () => void
  onClose: () => void
}

/** 模型设置 tab：调度方式、服务商、Base URL、API Key、任务档位、Skills 目录 */
export function ModelSettingsTab(p: Props) {
  return (
    <>
      <div className="modal__body">
        <label className="field">
          <span className="field__label">调度模型方式</span>
          <Select
            value={p.dispatchMode}
            onChange={(v) => p.setDispatchMode(v as 'api' | 'claude-cli')}
            options={[
              { value: 'api', label: 'API 直连（OpenAI 兼容 / Anthropic）' },
              { value: 'claude-cli', label: 'Claude CLI（本机 agent）' },
            ]}
          />
          <span className="field__hint">
            {p.dispatchMode === 'claude-cli'
              ? '经由本机 claude 命令自主执行，自带文件/命令工具与模型配置，无需 API Key；需已安装并登录 Claude Code'
              : '主进程直连模型服务；需要调度本机工具时切换到 Claude CLI'}
          </span>
        </label>

        {p.dispatchMode === 'claude-cli' && (
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
            <span className="field__hint">全自动下 CLI 可直接改文件、执行命令；受限只读仅允许检索/浏览类工具，更安全但能力受限</span>
          </label>
        )}

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

        {/* Skills 目录 */}
        <div className="field">
          <span className="field__label">Skills 目录（可多个，按序扫描，同名取首个；失焦后生效）</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {p.editingDirs.map((d, i) => (
              <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  className="field__input mono"
                  value={d}
                  onChange={(e) => {
                    const next = [...p.editingDirs]
                    next[i] = e.target.value
                    p.setDirsDraft(next)
                  }}
                  onBlur={() => p.commitDirs(p.editingDirs)}
                  placeholder="Skills 目录绝对路径"
                  style={{ flex: 1 }}
                />
                <button
                  className="icon-btn"
                  onClick={() => p.commitDirs(p.editingDirs.filter((_, j) => j !== i))}
                  aria-label="移除该目录"
                  title="移除该目录"
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn btn--ghost btn--sm"
                onClick={async () => {
                  try {
                    const dir = await p.pickSkillsDir()
                    if (dir && !p.editingDirs.includes(dir)) p.commitDirs([...p.editingDirs, dir])
                  } catch (e) { console.error('pickSkillsDir 失败：', e) }
                }}
                title="浏览选择目录"
              >
                <IconFolder size={13} /> 添加目录
              </button>
              {p.skillsDirs.length > 0 && (
                <button className="btn btn--ghost btn--sm" onClick={() => void p.loadSkills()} title="重新扫描 Skills">
                  刷新
                </button>
              )}
            </div>
          </div>
          <span className="field__hint">
            {p.skillsDirs.length > 0
              ? `已扫描到 ${p.skillMetas.length} 个 Skill（每个 Skill 是一个含 SKILL.md 的子目录）`
              : '配置目录后，AI 可在对话中按场景加载专业指令集（每个 Skill 是一个含 SKILL.md 的子目录）'}
          </span>
        </div>

        {p.testResult && (
          <div className={`notice ${p.testResult.ok ? 'notice--ok' : 'notice--err'}`}>
            {p.testResult.ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
            <span>{p.testResult.text}</span>
          </div>
        )}
      </div>

      <div className="modal__actions modal__actions--split">
        <div className="modal__actions-left">
          {p.hasApiKey && (
            <button className="btn btn--danger-ghost" onClick={p.onClearKey}>清除已存 Key</button>
          )}
        </div>
        <div className="modal__actions-right">
          <button className="btn btn--ghost" onClick={p.onTest} disabled={p.testing || (p.dispatchMode === 'api' && !p.baseUrl.trim())}>
            {p.testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn btn--ghost" onClick={p.onClose}>取消</button>
          <button className="btn btn--primary" onClick={p.onSave} disabled={(p.dispatchMode === 'api' && (!p.model.trim() || !p.baseUrl.trim()))}>
            保存
          </button>
        </div>
      </div>
    </>
  )
}
