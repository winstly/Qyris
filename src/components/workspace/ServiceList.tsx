import React, { useState, useRef } from 'react'
import { IconPlus, IconTerminal, IconTrash, IconPencil } from '@/components/common/icons'
import type { ServiceRow } from './PreviewTab'

const PHASE_LABEL: Record<string, string> = {
  idle: '未运行', building: '编译中', deploying: '部署中', running: '运行中', error: '异常',
}

interface Props {
  serviceRows: ServiceRow[]
  activeSlot: string | null
  logSlot: string | null
  setLogSlot: React.Dispatch<React.SetStateAction<string | null>>
  projectPath: string | null
  hasCommands: boolean
  startupCommands: { name: string; run: string; url?: string }[]
  aiCompile: () => void
  runAll: () => void
  stopAll: (path?: string) => void
  selectSlot: (name: string) => void
  start: (name: string, cmd: string, path?: string) => void
  stop: (name: string, path?: string) => void
  removeSlot: (name: string, path: string) => void
  updateStartCommand: (name: string, cmd: { run: string }, path: string) => void
  deleteStartCommand: (name: string, path: string) => void
  showConfirm: (title: string, msg?: string) => Promise<boolean | { confirmed: boolean; checks: Record<string, boolean> }>
  compiling: boolean
  anyAlive: boolean
  chatBusy: boolean
}

/** 服务列表：已识别服务 + 手动添加 + 全部运行/停止 */
export function ServiceList(p: Props) {
  const [editingCmd, setEditingCmd] = useState<string | null>(null)
  const [editingCmdValue, setEditingCmdValue] = useState('')
  const cmdSavedRef = useRef(false)
  const [addingService, setAddingService] = useState(false)
  const [addName, setAddName] = useState('')
  const [addCmd, setAddCmd] = useState('')

  const submitAddService = (): void => {
    const n = addName.trim()
    const c = addCmd.trim()
    if (n && c && p.projectPath) {
      void p.updateStartCommand(n, { run: c }, p.projectPath)
      setAddingService(false)
      setAddName('')
      setAddCmd('')
    }
  }

  if (p.serviceRows.length === 0) return null

  return (
    <>
      <div className="slots__count">共 {p.serviceRows.length} 个服务</div>
      <div className="slots" role="list" aria-label="服务列表">
        {p.serviceRows.map((row) => {
          const st = row.slot
          const alive = st?.processAlive ?? false
          const running = st?.phase === 'running' && !!st.detectedUrl
          const key = st?.name ?? row.name.toLowerCase()
          const logOn = p.logSlot === key
          return (
            <div
              key={key}
              role="listitem"
              className={`slots__row ${key === p.activeSlot ? 'slots__row--active' : ''}`}
              onClick={() => p.selectSlot(row.name)}
            >
              <span className={`status-dot status-dot--${st?.phase ?? 'idle'}`} />
              <span className="slots__name mono" title={row.name}>{row.name}</span>
              {editingCmd === key ? (
                <input
                  className="slots__cmd-input mono"
                  value={editingCmdValue}
                  onChange={(e) => setEditingCmdValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = editingCmdValue.trim()
                      if (val && val !== row.command && p.projectPath) void p.updateStartCommand(row.name, { run: val }, p.projectPath)
                      cmdSavedRef.current = true
                      setEditingCmd(null)
                    } else if (e.key === 'Escape') {
                      cmdSavedRef.current = true
                      setEditingCmd(null)
                    }
                  }}
                  onBlur={() => {
                    if (cmdSavedRef.current) return
                    const val = editingCmdValue.trim()
                    if (val && val !== row.command && p.projectPath) void p.updateStartCommand(row.name, { run: val }, p.projectPath)
                    setEditingCmd(null)
                  }}
                  autoFocus
                />
              ) : (
                <span className="slots__cmd mono" title={row.command || '（未知命令）'}>{row.command || '（未知命令）'}</span>
              )}
              {running && (
                <a className="slots__url mono" href={st!.detectedUrl!} target="_blank" rel="noreferrer"
                  title={`在浏览器中打开 ${st!.detectedUrl}`} onClick={(e) => e.stopPropagation()}>
                  {st!.detectedUrl}
                </a>
              )}
              <span key={st?.phase ?? 'idle'} className={`slots__phase slots__phase--${st?.phase ?? 'idle'}`}>
                {PHASE_LABEL[st?.phase ?? 'idle']}
              </span>
              {st && (
                <button className={`btn btn--ghost btn--sm slots__action ${logOn ? 'slots__action--on' : ''}`}
                  onClick={(e) => { e.stopPropagation(); p.selectSlot(key); p.setLogSlot((cur) => (cur === key ? null : key)) }}
                  aria-expanded={logOn} aria-label={`${key} 进程日志`} title="进程日志">
                  <IconTerminal size={12} /> 日志
                </button>
              )}
              {alive ? (
                <button className="btn btn--ghost btn--sm slots__action" onClick={(e) => { e.stopPropagation(); void p.stop(row.name, p.projectPath ?? undefined) }}>
                  停止
                </button>
              ) : (
                <button className="btn btn--ghost btn--sm slots__action" disabled={!row.command || !p.projectPath}
                  onClick={(e) => { e.stopPropagation(); void p.start(row.name, row.command, p.projectPath ?? undefined) }}
                  title={`以原命令运行「${row.name}」`}>
                  运行
                </button>
              )}
              {!alive && (
                <button className="icon-btn" onClick={(e) => {
                  e.stopPropagation(); cmdSavedRef.current = false; setEditingCmd(key); setEditingCmdValue(row.command)
                }} aria-label="编辑命令" title="编辑启动命令">
                  <IconPencil size={12} />
                </button>
              )}
              {!alive && (
                <button className="icon-btn" onClick={async (e) => {
                  e.stopPropagation()
                  if (!p.projectPath) return
                  if (await p.showConfirm('删除服务', `确认删除「${row.name}」？`) !== true) return
                  p.removeSlot(row.name, p.projectPath)
                  void p.deleteStartCommand(row.name, p.projectPath)
                }} aria-label="删除服务" title="删除此服务">
                  <IconTrash size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {addingService ? (
        <div className="slots__add-form">
          <input className="slots__add-input mono" placeholder="服务名" value={addName}
            onChange={(e) => setAddName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setAddingService(false) }} autoFocus />
          <input className="slots__add-input slots__add-input--cmd mono" placeholder="启动命令（如 npm run dev）" value={addCmd}
            onChange={(e) => setAddCmd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitAddService(); else if (e.key === 'Escape') setAddingService(false) }} />
          <button className="btn btn--ghost btn--sm" disabled={!addName.trim() || !addCmd.trim()} onClick={submitAddService}>添加</button>
          <button className="btn btn--ghost btn--sm" onClick={() => setAddingService(false)}>取消</button>
        </div>
      ) : (
        <button className="btn btn--ghost btn--sm slots__add-btn" onClick={() => setAddingService(true)}>
          <IconPlus size={12} /> 添加服务
        </button>
      )}
    </>
  )
}
