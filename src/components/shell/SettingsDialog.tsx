/**
 * 设置面板：桌宠 + 系统设置（全局资产）。
 * 模型/记忆配置在「模型与记忆」弹窗（对话头部 chip；本面板「系统设置」亦有入口——
 * 聊天面板折叠时头部按钮不可点）；Skills 全局目录在技能 tab 全局组。
 * 桌宠专属项（音效/显示）只在「桌宠」tab；「系统设置」含主窗口关闭行为与数据存储位置（迁移）。
 */
import { useEffect, useState } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useAppStore } from '@/store/useAppStore'
import { api } from '@/services/desktop'
import { useMemoryStore } from '@/store/useMemoryStore'
import { IconClose, IconCheck, IconCopy } from '@/components/common/icons'
import { Select } from '@/components/common/Select'
import { TabStrip } from '@/components/common/TabStrip'

export function SettingsDialog() {
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const setModelCfgOpen = useAppStore((s) => s.setModelCfgOpen)
  const showConfirm = useAppStore((s) => s.showConfirm)
  const showAlert = useAppStore((s) => s.showAlert)

  const [tab, setTab] = useState<'pet' | 'system'>('pet')
  const [dataDir, setDataDir] = useState<string | null>(null)
  const [dirBusy, setDirBusy] = useState<'pick' | 'migrate' | null>(null)
  const [dirCopied, setDirCopied] = useState(false)
  const [closeAction, setCloseAction] = useState<'ask' | 'minimize' | 'quit'>('ask')
  const [petSound, setPetSound] = useState(false)
  const [petHidden, setPetHidden] = useState(false)

  // 打开即取值：关闭行为 + 桌宠开关 + 数据存储位置（都是全局资产，一次读齐）
  useEffect(() => {
    if (!open) return
    setTab('pet')
    setDirBusy(null)
    let alive = true
    api.getConfig().then((c) => {
      if (!alive) return
      setCloseAction(c.closeAction === 'minimize' || c.closeAction === 'quit' ? c.closeAction : 'ask')
      setPetSound(c.petSound === true)
      setPetHidden(c.petHidden === true)
    }).catch(() => {})
    api.getDataDir().then((d) => { if (alive) setDataDir(d) }).catch(() => {})
    return () => { alive = false }
  }, [open])

  if (!open) return null

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

  return (
    <div ref={trapRef} className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal__head">
          <span>设置</span>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="关闭"><IconClose size={14} /></button>
        </div>

        <TabStrip
          label="设置分类"
          active={tab}
          onChange={setTab}
          items={[
            { id: 'pet', label: '桌宠' },
            { id: 'system', label: '系统设置' },
          ]}
        />

        {tab === 'pet' ? (
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
              <div className="field">
                <span className="field__label">模型与记忆配置</span>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => { setOpen(false); setModelCfgOpen(true) }}
                >
                  打开「模型与记忆」…
                </button>
                <span className="field__hint">调度方式 / 服务商 / API Key / 任务档位 / 记忆触发——也在对话头部入口可达</span>
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
              <button className="btn btn--primary" onClick={() => setOpen(false)}>完成</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
