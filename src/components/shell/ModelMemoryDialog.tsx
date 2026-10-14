/**
 * 模型 / 记忆配置弹窗（对话头部 chip 触发）——对话相关配置放对话旁，不再进设置弹窗。
 * 上半 = 模型配置段（ModelSettingsTab）；下半 = 记忆段（整理触发轮次 / 上下文压缩阈值）。
 * 保存动作在此持有（ModelSettingsTab 是纯 body）；API Key 只写入系统 keychain，绝不落盘明文。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useAppStore } from '@/store/useAppStore'
import { api } from '@/services/desktop'
import { SECRET_KEY } from '@/services/ai'
import type { ModelTiers } from '@/types'
import { IconClose } from '@/components/common/icons'
import { TabStrip } from '@/components/common/TabStrip'
import { ModelSettingsTab } from './ModelSettingsTab'

interface Props {
  open: boolean
  onClose: () => void
}

export function ModelMemoryDialog({ open, onClose }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(open)
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const hasApiKey = useAppStore((s) => s.hasApiKey)
  const refreshHasApiKey = useAppStore((s) => s.refreshHasApiKey)

  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [model, setModel] = useState(settings.model)
  const [provider, setProvider] = useState<'openai' | 'anthropic'>(settings.provider)
  const [dispatchMode, setDispatchMode] = useState<'api' | 'claude-cli'>(settings.dispatchMode)
  const [cliPermission, setCliPermission] = useState<'auto' | 'readonly'>(settings.cliPermission)
  const [cliCommand, setCliCommand] = useState(settings.cliCommand ?? '')
  const [maxTurns, setMaxTurns] = useState(settings.maxTurns != null ? String(settings.maxTurns) : '')
  const [subagentMaxTurns, setSubagentMaxTurns] = useState(settings.subagentMaxTurns != null ? String(settings.subagentMaxTurns) : '')
  const [tiers, setTiers] = useState<ModelTiers>(settings.tiers ?? {})
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const [memRounds, setMemRounds] = useState('')
  const [compressThreshold, setCompressThreshold] = useState('')
  /** 自动归档长期未使用的短期/事件记忆（缺省开；显式保存的记忆永不自动清理） */
  const [memAutoArchive, setMemAutoArchive] = useState(true)
  const [memLoaded, setMemLoaded] = useState(false)
  /** 记忆字段读取失败：保存时该段跳过写回，必须显式告知而非静默 */
  const [memError, setMemError] = useState(false)
  /** 弹窗内切片（模型 / 记忆）：两段一屏堆叠显割裂，用 tab 切换 */
  const [tab, setTab] = useState<'model' | 'memory'>('model')

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
    setMemRounds('')
    setCompressThreshold('')
    setMemLoaded(false)
    setMemError(false)
    // 记忆字段随打开即取值：保存会整体写回，未加载就保存会把既有配置抹成 undefined
    let alive = true
    api.getConfig().then((c) => {
      if (!alive) return
      setMemRounds(c.memExtractRounds != null ? String(c.memExtractRounds) : '')
      setCompressThreshold(c.contextCompressThreshold != null ? String(c.contextCompressThreshold) : '')
      setMemAutoArchive(c.memAutoArchive !== false)
      setMemLoaded(true)
    }).catch(() => {
      if (!alive) return
      // 读取失败必须可见：否则用户改完点保存，记忆字段被静默跳过写回
      setMemError(true)
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

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
    // 记忆字段未加载时不写回：空串是「还没读到」不是「清空」
    if (memLoaded) {
      await api.mergeConfig({
        memExtractRounds: clampIntInput(memRounds, 2, 60) ?? undefined,
        contextCompressThreshold: clampIntInput(compressThreshold, 64000, 512000) ?? undefined,
        memAutoArchive: memAutoArchive ? undefined : false,
      })
    }
    await refreshHasApiKey()
    onClose()
  }

  const onClearKey = async () => {
    try {
      await api.deleteSecret(SECRET_KEY)
      await refreshHasApiKey()
    } catch {
      // keychain/IPC 失败：按钮点击的 promise 不外抛（onClick 无 catch）
    }
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

  // portal 到 body：挂在对话头部内会被头部的层叠上下文困住 fixed 遮罩（与 ContextMenu 同款挂载）
  return createPortal(
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={trapRef} className="modal modal--wide" role="dialog" aria-modal="true" aria-label="模型与记忆配置">
        <div className="modal__head">
          <span>模型与记忆</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><IconClose size={14} /></button>
        </div>

        <TabStrip
          label="配置分类"
          active={tab}
          onChange={setTab}
          items={[
            { id: 'model', label: '模型' },
            { id: 'memory', label: '记忆' },
          ]}
        />

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
            testResult={testResult}
          />
        ) : (
        <div className="modal__body">
          {memError && (
            <div className="notice notice--err">记忆配置读取失败，本次保存不会写回记忆字段</div>
          )}
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
            <label className="settings-memtoggle">
              <input
                type="checkbox"
                checked={memAutoArchive}
                onChange={(e) => setMemAutoArchive(e.target.checked)}
                aria-label="自动归档长期未使用的短期记忆"
              />
              <span>自动归档长期未使用的短期记忆</span>
            </label>
            <span className="field__hint">
              30 天没用过的会话记忆与 60 天没更新的事件会被收起，不再参与检索；随时可在记忆面板恢复。
              你明确保存的记忆永远不会被自动清理（长期记忆只调整排序，任何情况下不会自动清除）。
            </span>
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
        </div>
        )}

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
            <button className="btn btn--ghost" onClick={onClose}>取消</button>
            <button className="btn btn--primary" onClick={() => void onSave()} disabled={(dispatchMode === 'api' && (!model.trim() || !baseUrl.trim()))}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
