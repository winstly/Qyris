import { useEffect, useState } from 'react'
import { useAppStore, type Theme } from '@/store/useAppStore'
import { api } from '@/services/desktop'
import { SECRET_KEY } from '@/services/ai'
import type { ModelTiers } from '@/types'
import { IconClose, IconCheck, IconAlert, IconFolder } from '@/components/common/icons'
import { Select } from '@/components/common/Select'

/**
 * 设置面板：两个 tab —— 模型设置（Base URL / API Key / 模型名）+ 系统设置（主题）。
 * API Key 只写入系统 keychain，绝不落配置文件或 localStorage。
 */
export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const hasApiKey = useAppStore((s) => s.hasApiKey)
  const refreshHasApiKey = useAppStore((s) => s.refreshHasApiKey)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const skillsDirs = useAppStore((s) => s.skillsDirs)
  const setSkillsDirs = useAppStore((s) => s.setSkillsDirs)
  const skillMetas = useAppStore((s) => s.skillMetas)
  const loadSkills = useAppStore((s) => s.loadSkills)

  const [tab, setTab] = useState<'model' | 'system'>('model')
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [model, setModel] = useState(settings.model)
  const [provider, setProvider] = useState<'openai' | 'anthropic'>(settings.provider)
  const [dispatchMode, setDispatchMode] = useState<'api' | 'claude-cli'>(settings.dispatchMode)
  const [cliPermission, setCliPermission] = useState<'auto' | 'readonly'>(settings.cliPermission)
  const [tiers, setTiers] = useState<ModelTiers>(settings.tiers ?? {})
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  // Skills 目录本地编辑草稿：输入过程不落盘不重扫（否则每个按键 = 一次配置写盘 + 全目录扫描），
  // 失焦/增删行时统一提交。null = 未在编辑，直接透传 store 值
  const [dirsDraft, setDirsDraft] = useState<string[] | null>(null)

  useEffect(() => {
    if (open) {
      setTab('model')
      setBaseUrl(settings.baseUrl)
      setModel(settings.model)
      setProvider(settings.provider)
      setDispatchMode(settings.dispatchMode)
      setCliPermission(settings.cliPermission)
      setTiers(settings.tiers ?? {})
      setApiKeyInput('')
      setTestResult(null)
      setDirsDraft(null)
    }
  }, [open, settings])

  if (!open) return null

  // Skills 目录：编辑草稿 → 提交（trim + 去空 + 去重保序）→ 未变化则跳过（避免无谓落盘重扫）
  const editingDirs = dirsDraft ?? skillsDirs
  const commitDirs = (list: string[]) => {
    const clean = [...new Set(list.map((d) => d.trim()).filter(Boolean))]
    setDirsDraft(null)
    if (clean.join('\n') !== skillsDirs.join('\n')) setSkillsDirs(clean)
  }

  const onSave = async () => {
    if (apiKeyInput.trim()) {
      await api.setSecret(SECRET_KEY, apiKeyInput.trim())
    }
    // 空档位剔除（回退主模型）
    const cleanTiers: ModelTiers = {}
    for (const [k, v] of Object.entries(tiers)) {
      if (v && v.trim()) cleanTiers[k as keyof ModelTiers] = v.trim()
    }
    await saveSettings({
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      provider,
      dispatchMode,
      cliPermission,
      tiers: Object.keys(cleanTiers).length ? cleanTiers : undefined,
    })
    await refreshHasApiKey()
    setOpen(false)
  }

  const onClearKey = async () => {
    await api.deleteSecret(SECRET_KEY)
    await refreshHasApiKey()
  }

  const onTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      if (apiKeyInput.trim()) await api.setSecret(SECRET_KEY, apiKeyInput.trim())
      const msg = await api.aiTestConnection(provider, baseUrl.trim(), model.trim(), dispatchMode)
      setTestResult({ ok: true, text: msg })
    } catch (e) {
      setTestResult({ ok: false, text: String(e) })
    } finally {
      setTesting(false)
      await refreshHasApiKey()
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal__head">
          <span>设置</span>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="关闭">
            <IconClose size={14} />
          </button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="设置分类">
          <button
            className={`settings-tab ${tab === 'model' ? 'settings-tab--active' : ''}`}
            onClick={() => setTab('model')}
            role="tab"
            aria-selected={tab === 'model'}
          >
            模型设置
          </button>
          <button
            className={`settings-tab ${tab === 'system' ? 'settings-tab--active' : ''}`}
            onClick={() => setTab('system')}
            role="tab"
            aria-selected={tab === 'system'}
          >
            系统设置
          </button>
        </div>

        {tab === 'model' ? (
          <>
            <div className="modal__body">
            <label className="field">
              <span className="field__label">调度模型方式</span>
              <Select
                value={dispatchMode}
                onChange={(v) => setDispatchMode(v as 'api' | 'claude-cli')}
                options={[
                  { value: 'api', label: 'API 直连（OpenAI 兼容 / Anthropic）' },
                  { value: 'claude-cli', label: 'Claude CLI（本机 agent）' },
                ]}
              />
              <span className="field__hint">
                {dispatchMode === 'claude-cli'
                  ? '经由本机 claude 命令自主执行，自带文件/命令工具，无需 API Key；首轮用主模型，后续 CLI 按任务轻重在每轮末尾为下一轮挑选模型（任务档位即候选菜单）；需已安装并登录 Claude Code'
                  : '主进程直连模型服务；需要调度本机工具时切换到 Claude CLI'}
              </span>
            </label>

            {dispatchMode === 'claude-cli' && (
              <label className="field">
                <span className="field__label">CLI 权限模式</span>
                <Select
                  value={cliPermission}
                  onChange={(v) => setCliPermission(v as 'auto' | 'readonly')}
                  options={[
                    { value: 'auto', label: '全自动（跳过权限确认）' },
                    { value: 'readonly', label: '受限只读（仅检索类工具）' },
                  ]}
                />
                <span className="field__hint">全自动下 CLI 可直接改文件、执行命令；受限只读仅允许检索/浏览类工具，更安全但能力受限</span>
              </label>
            )}

            {dispatchMode === 'api' && (
              <>
                <label className="field">
                  <span className="field__label">服务商</span>
                  <Select
                    value={provider}
                    onChange={(v) => setProvider(v as 'openai' | 'anthropic')}
                    options={[
                      { value: 'openai', label: 'OpenAI 兼容' },
                      { value: 'anthropic', label: 'Anthropic' },
                    ]}
                  />
                  <span className="field__hint">Base URL 填服务 base（OpenAI 到 /v1，Anthropic 到 anthropic 根路径），具体端点由程序拼接</span>
                </label>

                <label className="field">
                  <span className="field__label">API Base URL</span>
                  <input
                    className="field__input mono"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                  <span className="field__hint">填 service base：OpenAI 到 /v1（阿里云为 …/compatible-mode/v1）；Anthropic 到根路径（如 …/apps/anthropic）</span>
                </label>

                <label className="field">
                  <span className="field__label">API Key</span>
                  <input
                    className="field__input mono"
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={hasApiKey ? '已保存在系统 keychain（输入可覆盖）' : 'sk-…'}
                    autoComplete="off"
                  />
                  <span className="field__hint">
                    {hasApiKey
                      ? '已通过操作系统凭据存储加密保存，不写配置文件、不进 localStorage'
                      : '将存入操作系统 keychain（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service）'}
                  </span>
                </label>
              </>
            )}

            <label className="field">
              <span className="field__label">主模型</span>
              <input
                className="field__input mono"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4o-mini"
              />
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
                      value={tiers[key] ?? ''}
                      onChange={(e) => setTiers((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder="留空用主模型"
                    />
                  </label>
                ))}
              </div>
              <span className="field__hint">API 模式：按子任务难度自动选档，未配置回退主模型；CLI 模式：作为模型菜单，CLI 在每轮末尾为下一轮挑选</span>
            </div>

            <div className="field">
              <span className="field__label">Skills 目录（可多个，按序扫描，同名取首个；失焦后生效）</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {editingDirs.map((d, i) => (
                  <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input
                      className="field__input mono"
                      value={d}
                      onChange={(e) => {
                        const next = [...editingDirs]
                        next[i] = e.target.value
                        setDirsDraft(next)
                      }}
                      onBlur={() => commitDirs(editingDirs)}
                      placeholder="Skills 目录绝对路径"
                      style={{ flex: 1 }}
                    />
                    <button
                      className="icon-btn"
                      onClick={() => commitDirs(editingDirs.filter((_, j) => j !== i))}
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
                        const dir = await api.pickSkillsDir()
                        if (dir && !editingDirs.includes(dir)) commitDirs([...editingDirs, dir])
                      } catch (e) {
                        console.error('pickSkillsDir 失败：', e)
                      }
                    }}
                    title="浏览选择目录"
                  >
                    <IconFolder size={13} /> 添加目录
                  </button>
                  {skillsDirs.length > 0 && (
                    <button className="btn btn--ghost btn--sm" onClick={() => void loadSkills()} title="重新扫描 Skills">
                      刷新
                    </button>
                  )}
                </div>
              </div>
              <span className="field__hint">
                {skillsDirs.length > 0
                  ? `已扫描到 ${skillMetas.length} 个 Skill（每个 Skill 是一个含 SKILL.md 的子目录）`
                  : '配置目录后，AI 可在对话中按场景加载专业指令集（每个 Skill 是一个含 SKILL.md 的子目录）'}
              </span>
            </div>

            {testResult && (
              <div className={`notice ${testResult.ok ? 'notice--ok' : 'notice--err'}`}>
                {testResult.ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
                <span>{testResult.text}</span>
              </div>
            )}
            </div>

            <div className="modal__actions modal__actions--split">
              <div className="modal__actions-left">
                {hasApiKey && (
                  <button className="btn btn--danger-ghost" onClick={onClearKey}>清除已存 Key</button>
                )}
              </div>
              <div className="modal__actions-right">
                <button className="btn btn--ghost" onClick={onTest} disabled={testing || (dispatchMode === 'api' && !baseUrl.trim())}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
                <button className="btn btn--ghost" onClick={() => setOpen(false)}>取消</button>
                <button className="btn btn--primary" onClick={onSave} disabled={!model.trim() || (dispatchMode === 'api' && !baseUrl.trim())}>
                  保存
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="modal__body">
              <label className="field">
                <span className="field__label">主题</span>
                <Select
                  value={theme}
                  onChange={(v) => setTheme(v as Theme)}
                  options={[
                    { value: 'system', label: '跟随系统（白天浅色 / 晚上深色）' },
                    { value: 'light', label: '浅色' },
                    { value: 'dark', label: '深色' },
                  ]}
                />
                <span className="field__hint">选择后立即生效；「跟随系统」随操作系统外观自动切换</span>
              </label>
            </div>

            <div className="modal__actions">
              <button className="btn btn--primary" onClick={() => setOpen(false)}>完成</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}