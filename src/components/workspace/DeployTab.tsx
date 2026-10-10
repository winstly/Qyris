/**
 * 发布 tab：服务器卡片 + AI 一键自动部署。
 *
 * 形态（对齐技能卡语言）：卡片网格展示服务器（名称/host/已部署服务标签/部署策略），
 * 每卡「AI 部署」按钮 → AI 识别服务器列表自动选部署方式（单机/微服务/集群）→
 * 出部署计划（JSON）→ 确认后逐步执行（ssh 流式）→ 完成后更新服务标签。
 * 配置（服务器增删改）走弹窗表单；密码只写不回读（secrets 密文）。
 */
import { useEffect, useRef, useState } from 'react'
import { isDesktop, onConfigChanged } from '@/services/desktop'
import { useAppStore } from '@/store/useAppStore'
import { useChatStore, selectCurrentChat } from '@/store/useChatStore'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import type { DeployServer } from '@/types'
import { EmptyState } from '@/components/common/EmptyState'
import { Select } from '@/components/common/Select'
import {
  IconAlert, IconCheck, IconClose, IconPencil, IconPlay, IconPlus, IconTrash,
} from '@/components/common/icons'

const STRATEGY_LABEL: Record<string, string> = {
  single: '单机',
  microservice: '微服务',
  cluster: '集群',
}

export function DeployTab() {
  const [servers, setServers] = useState<DeployServer[]>([])
  const [editing, setEditing] = useState<DeployServer | null>(null)   // 弹窗表单（null=关）
  const projectPath = useAppStore((s) => s.projectPath)
  const hasApiKey = useAppStore((s) => s.hasApiKey)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 提示 6s 自动消失（与 ProjectSkillsSection 同款，不留常驻残影） */
  const showNotice = (n: { kind: 'ok' | 'err'; text: string }) => {
    setNotice(n)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 6000)
  }

  // 服务器列表加载 + 订阅变更：AI 的 update_server_tags 工具 / 另一窗口改了 deployServers
  // 都会广播 config:changed——不订阅则工具更新标签后卡片列表纹丝不动
  useEffect(() => {
    if (!isDesktop || !window.desktopAPI) return
    const reload = (): void => {
      void window.desktopAPI!.deployListServers().then(setServers).catch(() => {})
    }
    reload()
    return onConfigChanged((keys) => {
      if (keys.includes('deployServers')) reload()
    })
  }, [])

  /** 卡片/表单保存后的本地同步 */
  const upsertServer = (s: DeployServer) => {
    setServers((prev) => {
      const idx = prev.findIndex((x) => x.id === s.id)
      if (idx >= 0) { const n = [...prev]; n[idx] = s; return n }
      return [...prev, s]
    })
  }

  /** AI 部署（对齐 AI 编译模式）：部署请求作为消息进当前会话，
   *  AI 在对话里判定部署方式（单机/微服务/集群）并给出各服务器的部署命令步骤。 */
  const deployViaChat = async (mode: 'all' | 'single', target?: DeployServer) => {
    if (!projectPath) return
    const cliMode = useAppStore.getState().settings.dispatchMode === 'claude-cli'
    if (!hasApiKey && !cliMode) {
      void useAppStore.getState().showAlert('尚未配置 API Key', '点击左侧栏底部的设置图标，配置 Base URL 与 API Key 后即可使用 AI 部署。')
      return
    }
    const curChat = selectCurrentChat(useChatStore.getState())
    if (curChat.status !== 'idle' && curChat.status !== 'error') {
      void useAppStore.getState().showAlert('AI 正忙', '上一条消息还在处理中，请稍候。')
      return
    }
    const list = mode === 'all' ? servers : [target!].filter(Boolean)
    if (list.length === 0) return
    const listText = list
      .map((x) => `- 名称：${x.name}｜地址：${x.username}@${x.host}:${x.port}｜已部署标签：${(x.tags ?? []).join(', ') || '（无）'}`)
      .join('\n')
    const scope = mode === 'all'
      ? '以下是全部服务器，请判定全局部署方式（单机/微服务/集群），把部署任务合理分配到各服务器。'
      : '请为该服务器制定重新部署计划。'
    const prompt = `这是 AI 部署阶段：
${listText}

${scope}
执行约束（必须遵守）：
- 远程命令一律用 remote_exec 工具（serverName 填上面的服务器名称），上传文件用 remote_upload；
- 禁止用 run_command 执行 ssh/scp/sftp——无 TTY 环境下它们会卡在密码输入直到超时；
- SSH 认证由工作台代行，不要向用户索要服务器密码。
请输出：
1) 部署方式判定（单机/微服务/集群）与理由
2) 每台服务器上要执行的部署命令步骤（幂等可重跑，含安装/配置/启动/校验）
3) 部署完成后应补全的服务标签。
完成判定（重要）：
- 部署「完成」必须有验证证据：用 remote_exec 跑健康检查（curl 服务端口 / systemctl status / 进程存在性），凭证据宣布成功——只凭命令退出码 0 不算部署完成；
- 某一步失败时，先读输出定位原因再调整命令重试，不要盲目重复同一条命令。`
    void useChatStore.getState().send(prompt, { deployStart: true })
    if (useAppStore.getState().chatPanelCollapsed) useAppStore.getState().toggleChatPanel()
  }

  if (!isDesktop) {
    return <EmptyState icon={<IconPlay size={22} />} title="桌面应用内可用" text="发布功能需在桌面应用内运行（npm run dev）。" />
  }

  return (
    <div className="deploy-board">
      <div className="skills-panel__skills-bar">
        <span className="skill-card__name" style={{ letterSpacing: '0.8px' }}>服务器</span>
        <div className="skills-panel__spacer" />
        {servers.length > 0 && (
          <button className="btn btn--primary btn--sm" onClick={() => void deployViaChat('all')}>
            <IconPlay size={12} /> AI 部署全部
          </button>
        )}
        <button className="btn btn--ghost btn--sm" onClick={() => setEditing({ id: '', name: '', host: '', port: 22, username: '', auth: 'password', tags: [] })}>
          <IconPlus size={13} /> 添加服务器
        </button>
      </div>

      {notice && (
        <div className={`notice ${notice.kind === 'ok' ? 'notice--ok' : 'notice--err'}`}>
          {notice.kind === 'ok' ? <IconCheck size={14} /> : <IconAlert size={14} />}
          <span>{notice.text}</span>
        </div>
      )}

      {servers.length === 0 ? (
        <EmptyState
          icon={<IconPlus size={22} />}
          title="还没有服务器"
          text="添加服务器后，AI 可自动识别部署方式并执行部署。"
          action={<button className="btn btn--primary" onClick={() => setEditing({ id: '', name: '', host: '', port: 22, username: '', auth: 'password', tags: [] })}>添加服务器</button>}
        />
      ) : (
        <div className="deploy-grid">
          {servers.map((s, i) => (
            <ServerCard
              key={s.id}
              server={s}
              index={i}
              onEdit={() => setEditing(s)}
              onDeploy={() => void deployViaChat('single', s)}
            />
          ))}
        </div>
      )}

      {editing && (
        <ServerFormDialog
          server={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => { upsertServer(saved); setEditing(null); showNotice({ kind: 'ok', text: '服务器已保存' }) }}
          onDeleted={(id) => { setServers((p) => p.filter((x) => x.id !== id)); setEditing(null); showNotice({ kind: 'ok', text: '服务器已删除' }) }}
        />
      )}


    </div>
  )
}

/** 服务器卡片（技能卡同语言）：名称彩色 / host / 服务标签 / 策略标 / AI 部署 */
function ServerCard({ server, index, onEdit, onDeploy }: {
  server: DeployServer
  index: number
  onEdit: () => void
  onDeploy: () => void
}) {
  const tone = ['purple', 'blue', 'green', 'orange'][index % 4]
  return (
    <div className={`skill-card skill-card--${tone} deploy-card`} role="listitem">
      <div className="skill-card__head">
        <span className="skill-card__name">{server.name}</span>
        <div className="skill-card__actions">
          <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onEdit() }} title="编辑" aria-label={`编辑 ${server.name}`}>
            <IconPencil size={13} />
          </button>
        </div>
      </div>
      <div className="deploy-card__host mono">{server.username}@{server.host}:{server.port}</div>
      {server.strategy && (
        <div className="deploy-card__strategy">{STRATEGY_LABEL[server.strategy] ?? server.strategy}</div>
      )}
      <div className="skill-card__tags">
        {(server.tags ?? []).length === 0
          ? <span className="skill-card__tag">未部署</span>
          : (server.tags ?? []).map((t) => <span key={t} className="skill-card__tag skill-card__tag--on">{t}</span>)}
      </div>
      <div className="deploy-card__actions">
        <button className="btn btn--ghost btn--sm" onClick={onDeploy}>
          <IconPlay size={12} /> AI 部署
        </button>
      </div>
    </div>
  )
}

/** 服务器配置弹窗（增删改 + 凭据只写不回读） */
function ServerFormDialog({ server, onClose, onSaved, onDeleted }: {
  server: DeployServer
  onClose: () => void
  onSaved: (s: DeployServer) => void
  onDeleted: (id: string) => void
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  const [draft, setDraft] = useState<DeployServer>(server)
  const [secret, setSecret] = useState('')
  const [tagsDraft, setTagsDraft] = useState((server.tags ?? []).join(', '))
  const [err, setErr] = useState('')

  const save = async () => {
    if (!draft.name || !draft.host || !draft.username) { setErr('名称 / 主机 / 用户名为必填'); return }
    const id = draft.id || `srv-${Date.now()}`
    const saved: DeployServer = {
      ...draft,
      id,
      port: Number(draft.port) || 22,
      tags: tagsDraft.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
    }
    await window.desktopAPI!.deploySaveServer(saved)
    if (secret) await window.desktopAPI!.deploySetCredential(id, secret)
    onSaved(saved)
  }

  const remove = async () => {
    if (!draft.id) { onClose(); return }
    const ok = await useAppStore.getState().showConfirm(
      '删除服务器',
      `将删除「${draft.name}」及其登录凭据，且不可撤销。`,
      undefined,
      { confirmLabel: '删除' },
    )
    if (!ok) return
    await window.desktopAPI!.deployDeleteServer(draft.id)
    onDeleted(draft.id)
  }

  return (
    <div ref={trapRef} className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="服务器配置">
        <div className="modal__head">
          <span>{draft.id ? '编辑服务器' : '添加服务器'}</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><IconClose size={14} /></button>
        </div>
        {err && <div className="notice notice--err"><IconAlert size={14} /><span>{err}</span></div>}
        <div className="field">
          <span className="field__label">名称</span>
          <input className="field__input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="生产服务器" />
        </div>
        <div className="deploy-form__row">
          <div className="field" style={{ flex: 3 }}>
            <span className="field__label">主机</span>
            <input className="field__input" value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} placeholder="192.168.1.10" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <span className="field__label">端口</span>
            <input className="field__input" value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) || 22 })} inputMode="numeric" />
          </div>
        </div>
        <div className="deploy-form__row">
          <div className="field" style={{ flex: 1 }}>
            <span className="field__label">用户名</span>
            <input className="field__input" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="root" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <span className="field__label">认证方式</span>
            <Select
              value={draft.auth}
              onChange={(v) => setDraft({ ...draft, auth: v as DeployServer['auth'] })}
              ariaLabel="认证方式"
              options={[
                { value: 'password', label: '密码' },
                { value: 'key', label: '私钥' },
              ]}
            />
          </div>
        </div>
        {draft.auth === 'key' && (
          <div className="field">
            <span className="field__label">私钥文件</span>
            <div className="deploy-form__row">
              <input
                className="field__input"
                value={draft.privateKeyPath ?? ''}
                onChange={(e) => setDraft({ ...draft, privateKeyPath: e.target.value })}
                placeholder="选择私钥文件，或手动输入路径"
                aria-label="私钥路径"
              />
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  void window.desktopAPI?.pickKeyFile().then((p) => { if (p) setDraft((d) => ({ ...d, privateKeyPath: p })) })
                }}
              >选择密钥</button>
            </div>
          </div>
        )}
        <div className="field">
          <span className="field__label">{draft.auth === 'key' ? '私钥口令（可选）' : '登录密码'}</span>
          <input className="field__input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="留空保持不变" autoComplete="new-password" />
          <span className="field__hint">凭据经系统钥匙串加密，不回显不明文落盘</span>
        </div>
        <div className="field">
          <span className="field__label">已部署服务标签</span>
          <input className="field__input" value={tagsDraft} onChange={(e) => setTagsDraft(e.target.value)} placeholder="nginx, nacos, app-server" />
          <span className="field__hint">逗号分隔；AI 部署完成后也会自动补全</span>
        </div>
        <div className="modal__actions">
          {draft.id && <button className="btn btn--danger-ghost" onClick={() => void remove()} style={{ marginRight: 'auto' }}><IconTrash size={13} /> 删除</button>}
          <button className="btn btn--ghost" onClick={onClose}>取消</button>
          <button className="btn btn--primary" onClick={() => void save()}>保存</button>
        </div>
      </div>
    </div>
  )
}
