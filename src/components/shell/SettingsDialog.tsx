import { useEffect, useState } from 'react'
import { useAppStore, type Theme } from '@/store/useAppStore'
import { api } from '@/services/desktop'
import { SECRET_KEY } from '@/services/ai'
import { useMemoryStore } from '@/store/useMemoryStore'
import type { ModelTiers } from '@/types'
import { IconClose, IconCheck, IconCopy } from '@/components/common/icons'
import { Select } from '@/components/common/Select'
import { ModelSettingsTab } from './ModelSettingsTab'

/**
 * 设置面板：模型设置 + 记忆设置 + 系统设置。
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
  const showConfirm = useAppStore((s) => s.showConfirm)
  const showAlert = useAppStore((s) => s.showAlert)
  const skillsDirs = useAppStore((s) => s.skillsDirs)
  const setSkillsDirs = useAppStore((s) => s.setSkillsDirs)
  const skillMetas = useAppStore((s) => s.skillMetas)
  const loadSkills = useAppStore((s) => s.loadSkills)

  const [tab, setTab] = useState<'model' | 'memory' | 'system'>('model')
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [model, setModel] = useState(settings.model)
  const [provider, setProvider] = useState<'openai' | 'anthropic'>(settings.provider)
  const [dispatchMode, setDispatchMode] = useState<'api' | 'claude-cli'>(settings.dispatchMode)
  const [cliPermission, setCliPermission] = useState<'auto' | 'readonly'>(settings.cliPermission)
  const [tiers, setTiers] = useState<ModelTiers>(settings.tiers ?? {})
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  // Skills 目录草稿：输入过程不落盘不重扫，失焦/增删行时统一提交
  const [dirsDraft, setDirsDraft] = useState<string[] | null>(null)
  // 记忆 tab：数据存储位置 + 触发轮次
  const [dataDir, setDataDir] = useState<string | null>(null)
  const [dirBusy, setDirBusy] = useState<'pick' | 'migrate' | null>(null)
  const [dirCopied, setDirCopied] = useState(false)
  const [memRounds, setMemRounds] = useState('')

  useEffect(() => {
    if (!open) return
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
    setDirBusy(null)
    setMemRounds('')
  }, [open, settings])

  // 进入记忆 tab 时读取配置 + 数据存储位置
  useEffect(() => {
    if (!open || tab !== 'memory') return
    let alive = true
    api.getDataDir().then((d) => { if (alive) setDataDir(d) }).catch(() => {})
    api.getConfig().then((c) => {
      if (!alive) return
      setMemRounds(c.memExtractRounds != null ? String(c.memExtractRounds) : '')
    }).catch(() => {})
    return () => { alive = false }
  }, [open, tab])

  if (!open) return null

  const editingDirs = dirsDraft ?? skillsDirs
  const commitDirs = (list: string[]) => {
    const clean = [...new Set(list.map((d) => d.trim()).filter(Boolean))]
    setDirsDraft(null)
    if (clean.join('\n') !== skillsDirs.join('\n')) setSkillsDirs(clean)
  }

  const onSave = async () => {
    if (apiKeyInput.trim()) await api.setSecret(SECRET_KEY, apiKeyInput.trim())
    const cleanTiers: ModelTiers = {}
    for (const [k, v] of Object.entries(tiers)) {
      if (v && v.trim()) cleanTiers[k as keyof ModelTiers] = v.trim()
    }
    await saveSettings({
      baseUrl: baseUrl.trim(), model: model.trim(), provider, dispatchMode, cliPermission,
      tiers: Object.keys(cleanTiers).length ? cleanTiers : undefined,
    })
    const rounds = Math.floor(Number(memRounds))
    await api.mergeConfig({
      memExtractRounds: Number.isFinite(rounds) && rounds >= 2 ? Math.min(60, rounds) : undefined,
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

  const onCopyDataDir = async () => {
    if (!dataDir) return
    try {
      await navigator.clipboard.writeText(dataDir)
      setDirCopied(true)
      window.setTimeout(() => setDirCopied(false), 1500)
    } catch { /* 剪贴板不可用时静默 */ }
  }

  const onChangeDataDir = async () => {
    if (dirBusy) return
    setDirBusy('pick')
    try {
      const target = await api.selectDataDir()
      if (!target || target === dataDir) return
      const confirmed = await showConfirm('更改数据存储位置', `应用数据将迁移到：${target}。迁移期间请勿操作，确定继续？`)
      if (confirmed !== true) return
      setDirBusy('migrate')
      const r = await api.migrateDataDir(target)
      if (r.ok) {
        setDataDir(target)
        void useMemoryStore.getState().refreshStats()
        void showAlert('迁移完成', '应用数据已迁移到新位置。')
      } else {
        void showAlert('迁移失败', r.error ?? '未知错误')
      }
    } catch (e) {
      void showAlert('迁移失败', String(e))
    } finally {
      setDirBusy(null)
    }
  }

  const pickSkillsDir = () => api.pickSkillsDir()

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal__head">
          <span>设置</span>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="关闭"><IconClose size={14} /></button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="设置分类">
          {(['model', 'memory', 'system'] as const).map((t) => (
            <button
              key={t}
              className={`settings-tab ${tab === t ? 'settings-tab--active' : ''}`}
              onClick={() => setTab(t)}
              role="tab"
              aria-selected={tab === t}
            >
              {t === 'model' ? '模型设置' : t === 'memory' ? '记忆设置' : '系统设置'}
            </button>
          ))}
        </div>

        {tab === 'model' ? (
          <ModelSettingsTab
            dispatchMode={dispatchMode} setDispatchMode={setDispatchMode}
            cliPermission={cliPermission} setCliPermission={setCliPermission}
            provider={provider} setProvider={setProvider}
            baseUrl={baseUrl} setBaseUrl={setBaseUrl}
            apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput}
            hasApiKey={hasApiKey}
            model={model} setModel={setModel}
            tiers={tiers} setTiers={setTiers}
            editingDirs={editingDirs} setDirsDraft={setDirsDraft}
            commitDirs={commitDirs}
            skillsDirs={skillsDirs} skillMetas={skillMetas}
            loadSkills={loadSkills} pickSkillsDir={pickSkillsDir}
            testResult={testResult} testing={testing}
            onTest={onTest} onClearKey={onClearKey} onSave={onSave}
            onClose={() => setOpen(false)}
          />
        ) : tab === 'memory' ? (
          <>
            <div className="modal__body">
              <div className="field">
                <span className="field__label">记忆整理触发轮次</span>
                <div className="settings-memrounds">
                  <input className="field__input" type="number" min={2} max={60} step={1}
                    value={memRounds} onChange={(e) => setMemRounds(e.target.value)}
                    placeholder="默认 6" aria-label="记忆整理触发轮次" />
                  <span className="settings-memrounds__unit">轮 AI 回复</span>
                </div>
                <span className="field__hint">每累计多少轮 AI 回复后自动把对话蒸馏进记忆——越小记得越勤、token 消耗越多；清空输入恢复默认</span>
              </div>
              <div className="field">
                <span className="field__label">数据存储位置</span>
                <div className="settings-datadir">
                  <code className="settings-datadir__path mono" title={dataDir ?? ''}>{dataDir ?? '—'}</code>
                  <button className="icon-btn" onClick={() => void onCopyDataDir()} disabled={!dataDir} aria-label="复制路径" title="复制路径">
                    {dirCopied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                  </button>
                  <button className="btn btn--ghost btn--sm" onClick={() => void onChangeDataDir()} disabled={dirBusy !== null}>
                    {dirBusy === 'migrate' ? '迁移中…' : '更改位置…'}
                  </button>
                </div>
                <span className="field__hint">对话历史、记忆与文件快照存储于此目录；更改位置时自动迁移</span>
              </div>
            </div>
            <div className="modal__actions">
              <button className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>取消</button>
              <button className="btn btn--primary btn--sm" onClick={() => void onSave()}>保存</button>
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
