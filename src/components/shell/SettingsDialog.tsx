import { useEffect, useState } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useAppStore } from '@/store/useAppStore'
import { api } from '@/services/desktop'
import { SECRET_KEY } from '@/services/ai'
import { useMemoryStore } from '@/store/useMemoryStore'
import type { ModelTiers } from '@/types'
import { IconClose, IconCheck, IconCopy } from '@/components/common/icons'
import { Select } from '@/components/common/Select'
import { ModelSettingsTab } from './ModelSettingsTab'

/**
 * 设置面板：模型设置 + 记忆设置 + 桌宠设置 + 系统设置。
 * 桌宠专属项（音效/显示）只在「桌宠」tab；「系统设置」只留关闭行为（提示文案涉及桌宠找回）。
 * API Key 只写入系统 keychain，绝不落配置文件或 localStorage。
 */
export function SettingsDialog() {
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const hasApiKey = useAppStore((s) => s.hasApiKey)
  const refreshHasApiKey = useAppStore((s) => s.refreshHasApiKey)
  const showConfirm = useAppStore((s) => s.showConfirm)
  const showAlert = useAppStore((s) => s.showAlert)
  const skillsDirs = useAppStore((s) => s.skillsDirs)
  const setSkillsDirs = useAppStore((s) => s.setSkillsDirs)
  const skillMetas = useAppStore((s) => s.skillMetas)
  const loadSkills = useAppStore((s) => s.loadSkills)

  const [tab, setTab] = useState<'model' | 'memory' | 'pet' | 'system'>('model')
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [model, setModel] = useState(settings.model)
  const [provider, setProvider] = useState<'openai' | 'anthropic'>(settings.provider)
  const [dispatchMode, setDispatchMode] = useState<'api' | 'claude-cli'>(settings.dispatchMode)
  const [cliPermission, setCliPermission] = useState<'auto' | 'readonly'>(settings.cliPermission)
  const [cliCommand, setCliCommand] = useState(settings.cliCommand ?? '')
  // 工具循环轮数：输入态用字符串（空 = 未设置走默认），保存时校验钳制
  const [maxTurns, setMaxTurns] = useState(settings.maxTurns != null ? String(settings.maxTurns) : '')
  const [subagentMaxTurns, setSubagentMaxTurns] = useState(settings.subagentMaxTurns != null ? String(settings.subagentMaxTurns) : '')
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
  const [compressThreshold, setCompressThreshold] = useState('')
  // 记忆字段是否已从配置加载：未加载时不写回，避免空串被当成「清空」抹掉既有值
  const [memLoaded, setMemLoaded] = useState(false)
  // 系统设置：主窗口关闭行为（ask=每次询问，落盘值为 minimize/quit）
  const [closeAction, setCloseAction] = useState<'ask' | 'minimize' | 'quit'>('ask')
  // 桌宠音效开关
  const [petSound, setPetSound] = useState(false)
  // 隐藏桌宠开关
  const [petHidden, setPetHidden] = useState(false)

  useEffect(() => {
    if (!open) return
    setTab('model')
    setBaseUrl(settings.baseUrl)
    setModel(settings.model)
    setProvider(settings.provider)
    setDispatchMode(settings.dispatchMode)
    setCliPermission(settings.cliPermission)
    setCliCommand(settings.cliCommand ?? '')
    setMaxTurns(settings.maxTurns != null ? String(settings.maxTurns) : '')
    setSubagentMaxTurns(settings.subagentMaxTurns != null ? String(settings.subagentMaxTurns) : '')
    setTiers(settings.tiers ?? {})
    setApiKeyInput('')
    setTestResult(null)
    setDirsDraft(null)
    setDirBusy(null)
    setMemRounds('')
    setCompressThreshold('')
    setMemLoaded(false)
    // 记忆字段随打开即取值：onSave 会整体写回，未加载就保存会把既有配置抹成 undefined
    api.getConfig().then((c) => {
      setMemRounds(c.memExtractRounds != null ? String(c.memExtractRounds) : '')
      setCompressThreshold(c.contextCompressThreshold != null ? String(c.contextCompressThreshold) : '')
      setMemLoaded(true)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 进入系统/桌宠 tab 时读取主窗口关闭行为偏好 + 桌宠音效/显示开关（两 tab 共用一份配置）
  useEffect(() => {
    if (!open || (tab !== 'pet' && tab !== 'system')) return
    let alive = true
    api.getConfig().then((c) => {
      if (!alive) return
      setCloseAction(c.closeAction === 'minimize' || c.closeAction === 'quit' ? c.closeAction : 'ask')
      setPetSound(c.petSound === true)
      setPetHidden(c.petHidden === true)
    }).catch(() => {})
    return () => { alive = false }
  }, [open, tab])

  // 进入记忆 tab 时读取数据存储位置（触发轮次/压缩阈值已在打开时加载）
  useEffect(() => {
    if (!open || tab !== 'memory') return
    let alive = true
    api.getDataDir().then((d) => { if (alive) setDataDir(d) }).catch(() => {})
    return () => { alive = false }
  }, [open, tab])

  if (!open) return null

  const editingDirs = dirsDraft ?? skillsDirs
  const commitDirs = (list: string[]) => {
    const clean = [...new Set(list.map((d) => d.trim()).filter(Boolean))]
    setDirsDraft(null)
    if (clean.join('\n') !== skillsDirs.join('\n')) setSkillsDirs(clean)
  }

  /** 数字输入解析：空串/非数 = 未设置（null）；越界钳到边界（不放宽到默认） */
  const clampIntInput = (raw: string, lo: number, hi: number): number | null => {
    if (!raw.trim()) return null
    const n = Math.floor(Number(raw))
    if (!Number.isFinite(n)) return null
    return Math.min(hi, Math.max(lo, n))
  }

  const onSave = async () => {
    if (apiKeyInput.trim()) await api.setSecret(SECRET_KEY, apiKeyInput.trim())
    const cleanTiers: ModelTiers = {}
    for (const [k, v] of Object.entries(tiers)) {
      if (v && v.trim()) cleanTiers[k as keyof ModelTiers] = v.trim()
    }
    await saveSettings({
      baseUrl: baseUrl.trim(), model: model.trim(), provider, dispatchMode, cliPermission,
      cliCommand: cliCommand.trim() || null,
      maxTurns: clampIntInput(maxTurns, 4, 500),
      subagentMaxTurns: clampIntInput(subagentMaxTurns, 2, 200),
      tiers: Object.keys(cleanTiers).length ? cleanTiers : undefined,
    })
    // 记忆字段未加载时不写回：空串是「还没读到」不是「清空」，写 undefined 会抹掉既有配置
    if (memLoaded) {
      await api.mergeConfig({
        memExtractRounds: clampIntInput(memRounds, 2, 60) ?? undefined,
        contextCompressThreshold: clampIntInput(compressThreshold, 64000, 512000) ?? undefined,
      })
    }
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
      // 透传未保存的临时 cliCommand：未保存就测连接时测的是面板现值，不是已存旧值
      const msg = await api.aiTestConnection(provider, baseUrl.trim(), model.trim(), dispatchMode, cliCommand.trim() || undefined)
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
    <div ref={trapRef} className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal__head">
          <span>设置</span>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="关闭"><IconClose size={14} /></button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="设置分类">
          {(['model', 'memory', 'pet', 'system'] as const).map((t) => (
            <button
              key={t}
              className={`settings-tab ${tab === t ? 'settings-tab--active' : ''}`}
              onClick={() => setTab(t)}
              role="tab"
              aria-selected={tab === t}
            >
              {t === 'model' ? '模型设置' : t === 'memory' ? '记忆设置' : t === 'pet' ? '桌宠' : '系统设置'}
            </button>
          ))}
        </div>

        {tab === 'model' ? (
          <ModelSettingsTab
            dispatchMode={dispatchMode} setDispatchMode={setDispatchMode}
            cliPermission={cliPermission} setCliPermission={setCliPermission}
            cliCommand={cliCommand} setCliCommand={setCliCommand}
            maxTurns={maxTurns} setMaxTurns={setMaxTurns}
            subagentMaxTurns={subagentMaxTurns} setSubagentMaxTurns={setSubagentMaxTurns}
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
                <span className="field__label">上下文压缩阈值</span>
                <div className="settings-memrounds">
                  <input className="field__input" type="number" min={64000} max={512000} step={16000}
                    value={compressThreshold} onChange={(e) => setCompressThreshold(e.target.value)}
                    placeholder="默认 256000" aria-label="上下文压缩阈值" />
                  <span className="settings-memrounds__unit">token</span>
                </div>
                <span className="field__hint">对话历史总 token 超过此值时，自动压缩旧消息为摘要（保留最近 40 条原文）——越大越晚压缩、token 消耗越多；清空输入恢复默认（256k）</span>
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
        ) : tab === 'pet' ? (
          <>
            <div className="modal__body">
              <div className="field">
                <span className="field__label">桌宠音效</span>
                <label className="modal__check">
                  <input
                    type="checkbox"
                    checked={petSound}
                    onChange={(e) => {
                      const next = e.target.checked
                      setPetSound(next)
                      void api.mergeConfig({ petSound: next })
                    }}
                  />
                  <span className="modal__check-label">播放桌宠动画音效</span>
                </label>
                <span className="field__hint">开启后桌宠动画将播放内置音轨；默认静音</span>
              </div>
              <div className="field">
                <span className="field__label">桌宠显示</span>
                <label className="modal__check">
                  <input
                    type="checkbox"
                    checked={petHidden}
                    onChange={(e) => {
                      const next = e.target.checked
                      setPetHidden(next)
                      void api.mergeConfig({ petHidden: next })
                      window.desktopAPI?.setPetHidden?.(next)
                    }}
                  />
                  <span className="modal__check-label">隐藏桌宠</span>
                </label>
                <span className="field__hint">隐藏后桌宠不显示，取消勾选即恢复；不销毁桌宠进程</span>
              </div>
            </div>
            <div className="modal__actions">
              <button className="btn btn--primary" onClick={() => setOpen(false)}>完成</button>
            </div>
          </>
        ) : (
          <>
            <div className="modal__body">
              <label className="field">
                <span className="field__label">关闭主窗口时</span>
                <Select
                  value={closeAction}
                  onChange={(v) => {
                    const next = v as 'ask' | 'minimize' | 'quit'
                    setCloseAction(next)
                    void api.mergeConfig({ closeAction: next === 'ask' ? undefined : next })
                  }}
                  options={[
                    { value: 'ask', label: '每次询问（可勾选记住选择）' },
                    { value: 'minimize', label: '最小化到桌宠（保留桌宠，可找回）' },
                    { value: 'quit', label: '完全退出应用（连同桌宠）' },
                  ]}
                />
                <span className="field__hint">最小化后主窗口从任务栏消失，右键桌宠选「打开工作台」找回</span>
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
