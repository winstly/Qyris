/**
 * MCP 面板（「扩展」tab 的 MCP 切片）：外部 MCP server 本地管理——
 * **全局域 / 项目域两域**（左切右卡，与技能面板同构）：
 *   · 全局域（AppConfig.mcpServers）：所有项目可见；
 *   · 项目域（AppConfig.mcpServersMap[projectPath]）：仅当前项目，各项目相互独立，
 *     同名时项目域覆盖全局域（合并口径见 config.activeMcpServers）。
 * 两域均支持 stdio / Streamable HTTP 两型：列表 / 增删改 / 启停 / 测试连接 / 工具面预览 / JSON 导入。
 *
 * 连接池住主进程（mcp/external.ts）：保存后按 server 表指纹就地重建，下一条消息即用新表。
 * 测试连接是独立建连（不进连接池）——看到的工具面 = 下次启动后会话可达面。
 */
import { useEffect, useState } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { api, onMcpTestState } from '@/services/desktop'
import { useAppStore } from '@/store/useAppStore'
import { EmptyState } from '@/components/common/EmptyState'
import { DetailDialog } from '@/components/common/DetailDialog'
import { Notice, useNotice } from '@/components/common/Notice'
import { Select } from '@/components/common/Select'
import { ScopeRow } from '@/components/common/ScopeRow'
import {
  IconClose, IconPlus, IconSearch, IconTrash,
} from '@/components/common/icons'
import type { McpServerEntry } from '@/types'
import type { McpTestResult } from '../../../shared/ipc-types'
import { projectConfigKey } from '../../../shared/project-key'
import { isMcpEnabled, mcpServerKind } from '../../../shared/mcp'

const PERMISSION_LABEL: Record<string, string> = {
  readonly: '只读',
  write: '写入',
  exec: '完全',
}

const KIND_LABEL: Record<string, string> = {
  stdio: 'stdio',
  streamableHttp: 'HTTP',
  http: 'HTTP',
}

type ServerRow = { name: string; entry: McpServerEntry }
/** 测试结果进程级持有（mcp-test-state 事件 + 挂载拉取）；组件卸载不丢 */
type TestState = McpTestResult
type Scope = 'global' | 'project'

/** 传输类型判别（唯一口径见 shared/mcp.ts：与 client.connectMcpServer 同规则） */
const entryKind = mcpServerKind

/** 行摘要：stdio 显示 command+args；HTTP 显示 url */
function entryTarget(e: McpServerEntry): string {
  return entryKind(e) === 'stdio'
    ? [e.command, ...(e.args ?? [])].join(' ')
    : e.url ?? ''
}

/** 对象字面量禁用键：普通对象 out[key]= 走原型 setter 会改原型而不是建自有键，条目静默消失 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** KEY=VALUE 行文本 ⇄ 表（env / headers 共用） */
function parseKvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    if (!k || FORBIDDEN_KEYS.has(k)) continue
    out[k] = t.slice(i + 1)
  }
  return out
}

function kvToText(map?: Record<string, string>): string {
  return Object.entries(map ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')
}

/** 有效启用（唯一口径见 shared/mcp.ts） */
const isActive = isMcpEnabled

export function McpPanel() {
  const projectPath = useAppStore((s) => s.projectPath)
  const showConfirm = useAppStore((s) => s.showConfirm)
  const [scope, setScope] = useState<Scope>('global')
  /** 全局域：所有项目可见 */
  const [globalMap, setGlobalMap] = useState<Record<string, McpServerEntry>>({})
  /** 项目域：projectPath → servers（各项目独立，不串户） */
  const [projectMaps, setProjectMaps] = useState<Record<string, Record<string, McpServerEntry>>>({})
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<{ name: string; entry: McpServerEntry } | null>(null)
  /** 只读详情（卡片点击）：查看与编辑分离，编辑走「编辑」入口 */
  const [viewing, setViewing] = useState<{ name: string; entry: McpServerEntry } | null>(null)
  const [importing, setImporting] = useState(false)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  /** 结果键 = `${scope}::${name}`（主进程状态口径） */
  const keyOf = (name: string): string => `${scope === 'global' || !projectPath ? 'global' : projectConfigKey(projectPath)}::${name}`
  const [notice, setNotice] = useNotice()

  // 测试状态：挂载拉一次进程级快照 + 事件持续同步（切换切片/重开面板不丢结果）。
  // try/catch 包裹：API 缺席时 wrap 同步抛，裸 .catch 接不住
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const s = await api.mcpTestState()
        if (alive) setTests(s)
      } catch { /* 无桌面 API / IPC 拒绝：保持空态 */ }
    })()
    return onMcpTestState((s) => { if (alive) setTests(s) })
  }, [])

  useEffect(() => {
    let alive = true
    api.getConfig().then((c) => {
      if (!alive) return
      setGlobalMap(c.mcpServers ?? {})
      setProjectMaps(c.mcpServersMap ?? {})
      setLoaded(true)
    }).catch(() => setLoaded(true))
    return () => { alive = false }
  }, [])

  // 关掉项目后回落全局域（项目域无宿主）
  useEffect(() => {
    if (!projectPath && scope === 'project') setScope('global')
  }, [projectPath, scope])

  const projectServers = projectPath ? (projectMaps[projectConfigKey(projectPath)] ?? projectMaps[projectPath] ?? {}) : {}
  const activeMap: Record<string, McpServerEntry> = scope === 'global' ? globalMap : projectServers
  const rows: ServerRow[] = Object.entries(activeMap).map(([name, entry]) => ({ name, entry }))

  /** 整表写回当前域（下一条消息生效）：项目域走主进程 RMW（setProjectMcpServers，读最新盘上状态），
   *  避免渲染层 mount 快照整表覆写把其他窗口/项目的新改动抹掉 */
  const persistScope = async (next: Record<string, McpServerEntry>): Promise<void> => {
    if (scope === 'global') {
      setGlobalMap(next)
      await api.mcpSaveGlobalServers(next)
    } else if (projectPath) {
      const key = projectConfigKey(projectPath)
      setProjectMaps((p) => ({ ...p, [key]: next }))
      await api.mcpSaveProjectServers(projectPath, next)
    }
  }

  const onToggleEnabled = async (row: ServerRow): Promise<void> => {
    const active = isActive(row.entry)
    // 停用开关只落一个口径（disabled）；isActive/sanitize 都兼容 legacy enabled 字段
    const { enabled: _en, disabled: _dis, ...rest } = row.entry
    await persistScope({
      ...activeMap,
      [row.name]: active ? { ...rest, disabled: true } : rest,
    })
  }

  const onDelete = async (row: ServerRow): Promise<void> => {
    const ok = await showConfirm('删除 MCP server', `确定删除「${row.name}」？不会删除磁盘上的 server 程序。`)
    if (ok !== true) return
    const next = { ...activeMap }
    delete next[row.name]
    await persistScope(next)
    setTests((t) => { const n = { ...t }; delete n[keyOf(row.name)]; return n })
  }

  const onTest = async (row: ServerRow): Promise<void> => {
    const key = keyOf(row.name)
    setTests((t) => ({ ...t, [key]: { ok: false, tools: [], testing: true } }))
    try {
      const r = await api.mcpTest(row.name, row.entry as McpServerEntry, key.split('::')[0])
      setTests((t) => ({ ...t, [key]: r }))
    } catch (e) {
      // IPC/建连拒绝也要收敛 testing 态，否则「测试」按钮永久禁用
      setTests((t) => ({ ...t, [key]: { ok: false, tools: [], error: String(e) } }))
    }
  }

  const onSaveEdit = async (original: string | null, name: string, entry: McpServerEntry): Promise<void> => {
    const clean = name.trim()
    const kind = entryKind(entry)
    if (!clean) { setNotice({ kind: 'err', text: '名称不能为空' }); return }
    if (kind === 'stdio' && !entry.command?.trim()) { setNotice({ kind: 'err', text: 'stdio 型需要启动命令' }); return }
    if (kind === 'streamableHttp' && !/^https?:\/\//i.test(entry.url ?? '')) {
      setNotice({ kind: 'err', text: 'HTTP 型需要 http/https 端点 URL' }); return
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(clean)) {
      setNotice({ kind: 'err', text: '名称仅允许字母/数字/下划线/连字符（会进工具命名空间）' }); return
    }
    if (FORBIDDEN_KEYS.has(clean)) {
      setNotice({ kind: 'err', text: '名称「' + clean + '」是保留字，不能用作 server 名' }); return
    }
    // 改名落点与已有条目重合 = 覆盖对方配置，必须显式拦（新建与改名同口径）。
    // hasOwnProperty 排除原型链（toString/constructor 等 Object.prototype 成员会被误判已存在）
    if (Object.prototype.hasOwnProperty.call(activeMap, clean) && clean !== original) {
      setNotice({ kind: 'err', text: `名称「${clean}」在本域已存在` }); return
    }
    const next = { ...activeMap }
    if (original && original !== clean) delete next[original]
    next[clean] = entry
    await persistScope(next)
    setEditing(null)
    setNotice({ kind: 'ok', text: '已保存——下一条消息生效（连接池按新表就地重建）' })
  }

  /** JSON 导入：导入到当前域；接受 {mcpServers:{…}} / {servers:{…}} / 裸 map；同域同名覆盖 */
  const onImportJson = async (parsed: Record<string, McpServerEntry>): Promise<void> => {
    await persistScope({ ...activeMap, ...parsed })
    setImporting(false)
    setNotice({ kind: 'ok', text: `已导入 ${Object.keys(parsed).length} 个 server 到${scope === 'global' ? '全局域' : '项目域'}——下一条消息生效` })
  }

  return (
    <div className="skills-panel">
      {/* ── 左侧：配置域切换（全局 / 项目）——与技能面板同构 ── */}
      <div className="skills-panel__dirs">
        <div className="skills-panel__dirs-head">
          <span>配置域</span>
        </div>
        <div className="skills-panel__dirs-list">
          <ScopeRow
            row={{ dir: '全局', kind: 'global', badge: String(Object.keys(globalMap).length) }}
            active={scope === 'global'}
            onSelect={() => setScope('global')}
          />
          <ScopeRow
            row={{ dir: '项目', kind: 'project', badge: projectPath ? String(Object.keys(projectServers).length) : '—' }}
            active={scope === 'project'}
            onSelect={() => { if (projectPath) setScope('project') }}
            extraClass={projectPath ? undefined : 'mcp-panel__scope--off'}
          />
        </div>
      </div>

      {/* ── 右侧：当前域的 server 卡片列表 ── */}
      <div className="mcp-panel">
        <div className="mcp-panel__bar">
          <button
            className="btn btn--ghost btn--sm"
            disabled={scope === 'project' && !projectPath}
            onClick={() => setEditing({ name: '', entry: { command: '' } })}
          >
            <IconPlus size={13} /> 添加服务器
          </button>
          <button
            className="btn btn--ghost btn--sm"
            disabled={scope === 'project' && !projectPath}
            onClick={() => setImporting(true)}
          >
            导入 JSON
          </button>
          <div className="skills-panel__spacer" />
          <span className="mcp-panel__hint">
            {scope === 'global' ? '全局域 · 所有项目可见' : '项目域 · 仅当前项目'} · 保存后下一条消息生效
          </span>
        </div>

        <Notice notice={notice} />

        {!loaded ? (
          <div className="skills-panel__loading">加载中…</div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconSearch size={22} />}
            title={scope === 'global' ? '全局域还没有 MCP server' : '本项目还没有 MCP server'}
            text={
              scope === 'global'
                ? '全局域的 server 所有项目可见；手动添加（stdio / Streamable HTTP），或「导入 JSON」粘贴现成配置'
                : '项目域的 server 仅当前项目可见、各项目独立；手动添加或「导入 JSON」粘贴配置'
            }
          />
        ) : (
          <div className="mcp-panel__list" role="list" aria-label="MCP 服务器列表">
            {rows.map((row) => {
              const t = tests[keyOf(row.name)]
              const active = isActive(row.entry)
              return (
                <div key={row.name} className={`card mcp-panel__row ${active ? '' : 'mcp-panel__row--off'}`} role="listitem"
                  onClick={() => setViewing({ name: row.name, entry: { ...row.entry } })}>
                  <div className="mcp-panel__row-main">
                    <span className={`mcp-panel__dot ${t ? (t.ok ? 'mcp-panel__dot--ok' : t.testing ? '' : 'mcp-panel__dot--err') : ''}`} aria-hidden />
                    <span className="mcp-panel__name">{row.name}</span>
                    <span className="mcp-panel__kind">{KIND_LABEL[entryKind(row.entry)] ?? entryKind(row.entry)}</span>
                    <code className="mcp-panel__cmd mono" title={entryTarget(row.entry) || row.entry.description || ''}>
                      {entryTarget(row.entry) || row.entry.description || '—'}
                    </code>
                    <span className="mcp-panel__perm">{PERMISSION_LABEL[row.entry.permission ?? 'exec'] ?? '完全'}</span>
                    <span className="mcp-panel__status">
                      {!active ? '已停用'
                        : t?.testing ? '测试中…'
                        : t == null ? '未测试'
                        : t.ok ? `已连接 · ${t.tools.length} 工具`
                        : '测试失败'}
                    </span>
                    <div className="mcp-panel__actions">
                      <button className="btn btn--ghost btn--sm" disabled={t?.testing} onClick={(e) => { e.stopPropagation(); void onTest(row) }}>测试</button>
                      <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); setEditing({ name: row.name, entry: { ...row.entry } }) }}>编辑</button>
                      <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); void onToggleEnabled(row) }}>
                        {active ? '停用' : '启用'}
                      </button>
                      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); void onDelete(row) }} title="删除" aria-label={`删除 ${row.name}`}>
                        <IconTrash size={13} />
                      </button>
                    </div>
                  </div>
                  {/* 失败正文另起一行展开：状态徽章位是 nowrap 窄槽，错误塞进去只会截成省略号 */}
                  {t && !t.ok && !t.testing && !!t.error && (
                    <div className="mcp-panel__error">{t.error}</div>
                  )}
                  {t?.ok && t.tools.length > 0 && (
                    <div className="mcp-panel__tools">
                      {t.tools.map((tool) => (
                        <div key={tool.name} className="mcp-panel__tool" title={tool.description}>
                          <code className="mono">{tool.name}</code>
                          <span>{tool.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {viewing && (
          <DetailDialog
            title={viewing.name}
            rows={[
              { label: '类型', value: entryKind(viewing.entry) === 'stdio' ? 'stdio' : 'Streamable HTTP', kind: 'chip' },
              { label: entryKind(viewing.entry) === 'stdio' ? '命令' : '端点', value: entryTarget(viewing.entry), kind: 'mono' },
              { label: '参数', value: (viewing.entry.args ?? []).join(' '), kind: 'mono' },
              { label: '工作目录', value: viewing.entry.cwd ?? '', kind: 'mono' },
              { label: '环境变量', value: kvToText(viewing.entry.env), kind: 'mono' },
              { label: '请求头', value: kvToText(viewing.entry.headers), kind: 'mono' },
              { label: '权限档', value: PERMISSION_LABEL[viewing.entry.permission ?? 'exec'] ?? '完全', kind: 'chip' },
              { label: '超时', value: viewing.entry.timeoutMs ? `${viewing.entry.timeoutMs}ms` : '' },
              { label: '状态', value: isActive(viewing.entry) ? '启用' : '停用', kind: 'chip' },
              { label: '描述', value: viewing.entry.description ?? '' },
            ]}
            onClose={() => setViewing(null)}
            footer={
              <button className="btn btn--primary" onClick={() => { const v = viewing; setViewing(null); setEditing(v) }}>
                编辑
              </button>
            }
          />
        )}
        {editing && (
          <McpServerDialog
            original={editing.name || null}
            initial={editing.entry}
            onCancel={() => setEditing(null)}
            onSave={(original, name, entry) => void onSaveEdit(original, name, entry)}
          />
        )}
        {importing && (
          <McpImportDialog
            onCancel={() => setImporting(false)}
            onImport={(parsed) => void onImportJson(parsed)}
          />
        )}
      </div>
    </div>
  )
}

/** 添加/编辑弹窗：按 type 切 stdio / Streamable HTTP 字段；保存时未知字段（options/transport/autoApprove）随 initial 保留 */
function McpServerDialog(props: {
  original: string | null
  initial: McpServerEntry
  onCancel: () => void
  onSave: (original: string | null, name: string, entry: McpServerEntry) => void
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  const [name, setName] = useState(props.original ?? '')
  const [kind, setKind] = useState<'stdio' | 'streamableHttp'>(entryKind(props.initial))
  const [command, setCommand] = useState(props.initial.command ?? '')
  const [argsText, setArgsText] = useState((props.initial.args ?? []).join('\n'))
  const [cwd, setCwd] = useState(props.initial.cwd ?? '')
  const [url, setUrl] = useState(props.initial.url ?? '')
  const [headersText, setHeadersText] = useState(kvToText(props.initial.headers))
  const [envText, setEnvText] = useState(kvToText(props.initial.env))
  const [description, setDescription] = useState(props.initial.description ?? '')
  const [permission, setPermission] = useState<'readonly' | 'write' | 'exec'>(props.initial.permission ?? 'exec')
  const [enabled, setEnabled] = useState(isActive(props.initial))

  const buildEntry = (): McpServerEntry => {
    // 未知字段（options / transport / autoApprove …）随 initial 保留——编辑不丢配置。
    // permission 恒显式写入：省略键会让 initial 的旧档位残留（升到 exec 时停在 readonly）
    const { enabled: _en, disabled: _dis, permission: _perm, ...rest } = props.initial
    return {
      ...rest,
      type: kind,
      ...(kind === 'stdio'
        ? {
            command: command.trim(),
            args: argsText.split('\n').map((s) => s.trim()).filter(Boolean),
            ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          }
        : { url: url.trim() }),
      env: parseKvText(envText),
      headers: kind === 'streamableHttp' ? parseKvText(headersText) : undefined,
      description: description.trim() || undefined,
      // 停用开关只落一个口径（disabled）；enabled 留给导入配置的兼容读
      ...(enabled ? {} : { disabled: true }),
      permission,
    }
  }

  return (
    <div className="modal-mask">
      <div ref={trapRef} className="modal" role="dialog" aria-modal="true" aria-label="MCP server 配置">
        <div className="modal__head">
          <span>{props.original ? `编辑 ${props.original}` : '添加 MCP server'}</span>
          <button className="icon-btn" onClick={props.onCancel} aria-label="关闭"><IconClose size={14} /></button>
        </div>
        <div className="modal__body">
          <label className="field">
            <span className="field__label">名称（进工具命名空间：mcp__名称__工具）</span>
            <input className="field__input mono" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="websearch" aria-label="名称" />
            <span className="field__hint">仅字母/数字/下划线/连字符；改名 = 旧名条目删除重建</span>
          </label>
          <label className="field">
            <span className="field__label">传输类型</span>
            <Select
              value={kind}
              onChange={(v) => setKind(v as 'stdio' | 'streamableHttp')}
              options={[
                { value: 'stdio', label: 'stdio —— 本地进程，标准输入输出交换 JSON-RPC' },
                { value: 'streamableHttp', label: 'Streamable HTTP —— 远端端点（JSON / SSE 应答）' },
              ]}
            />
          </label>
          {kind === 'stdio' ? (
            <>
              <label className="field">
                <span className="field__label">启动命令</span>
                <input className="field__input mono" value={command} onChange={(e) => setCommand(e.target.value)}
                  placeholder="python3 / npx / node / 绝对路径" aria-label="启动命令" />
                <span className="field__hint">Windows 下 npx/npm 等 .cmd shim 由主进程自动 cmd /c 包装；打包后 npx -g 失效，建议 node_modules/.bin 或绝对路径</span>
              </label>
              <label className="field">
                <span className="field__label">参数（一行一个）</span>
                <textarea className="field__input mono" rows={3} value={argsText} onChange={(e) => setArgsText(e.target.value)}
                  placeholder={'/opt/mcp-servers/local-tools/main.py\n--stdio-mode'} aria-label="参数" />
              </label>
              <label className="field">
                <span className="field__label">工作目录（可选）</span>
                <input className="field__input mono" value={cwd} onChange={(e) => setCwd(e.target.value)}
                  placeholder="/opt/mcp-servers/workspace" aria-label="工作目录" />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span className="field__label">端点 URL</span>
                <input className="field__input mono" value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://your-mcp-service.example.com/mcp" aria-label="端点 URL" />
                <span className="field__hint">仅 http/https；兼容普通 JSON 与 SSE 流式应答；值支持 ${'{uuid}'} 插值</span>
              </label>
              <label className="field">
                <span className="field__label">请求头（一行一个 KEY=VALUE）</span>
                <textarea className="field__input mono" rows={3} value={headersText} onChange={(e) => setHeadersText(e.target.value)}
                  placeholder={'Authorization=Bearer YOUR_TOKEN\nMCP-Protocol-Version=2026-07-28'} aria-label="请求头" />
              </label>
            </>
          )}
          <label className="field">
            <span className="field__label">环境变量（一行一个 KEY=VALUE；stdio 注入子进程）</span>
            <textarea className="field__input mono" rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)}
              placeholder={'API_KEY=xxx\nPYTHONUNBUFFERED=1'} aria-label="环境变量" />
          </label>
          <label className="field">
            <span className="field__label">描述</span>
            <input className="field__input" value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="本地 stdio 模式 MCP 服务…" aria-label="描述" />
          </label>
          <label className="field">
            <span className="field__label">权限档（该 server 全部工具所需最小档位）</span>
            <Select
              value={permission}
              onChange={(v) => setPermission(v as 'readonly' | 'write' | 'exec')}
              options={[
                { value: 'exec', label: '完全（缺省；外部工具 fail-safe 只在满档会话暴露）' },
                { value: 'write', label: '写入' },
                { value: 'readonly', label: '只读（检索类）' },
              ]}
            />
          </label>
          <label className="field">
            <span className="field__label">启用</span>
            <div className="modal__check">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span className="modal__check-label">启用该 server（停用保留配置）</span>
            </div>
          </label>
        </div>
        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={props.onCancel}>取消</button>
          <button className="btn btn--primary" onClick={() => props.onSave(props.original, name, buildEntry())}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/** 导入 JSON 弹窗：粘贴 mcpServers 配置（{mcpServers:{…}} / {servers:{…}} / 裸 map 均可） */
function McpImportDialog(props: {
  onCancel: () => void
  onImport: (entries: Record<string, McpServerEntry>) => void
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      setError(`不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const root = parsed as Record<string, unknown>
    const pickMap = (v: unknown): Record<string, unknown> | null =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    // 形状兼容：{mcpServers:{…}} / {servers:{…}} / 裸 map
    const rawMap = pickMap(root?.mcpServers) ?? pickMap(root?.servers) ?? pickMap(parsed)
    const entries: Record<string, McpServerEntry> = {}
    for (const [name, v] of Object.entries((rawMap ?? {}) as Record<string, unknown>)) {
      const key = name.trim()
      if (!key || FORBIDDEN_KEYS.has(key)) continue // __proto__ 等会走原型 setter，条目静默消失
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const e = v as Record<string, unknown>
      const command = typeof e.command === 'string' ? e.command.trim() : ''
      const url = typeof e.url === 'string' ? e.url.trim() : ''
      if (!command && !url) continue // 主进程 sanitize 同口径：无 command 也无 url 的丢弃
      entries[key] = e as McpServerEntry
    }
    if (Object.keys(entries).length === 0) {
      setError('没有可导入的 server（每项需要 command 或 url）')
      return
    }
    props.onImport(entries)
  }

  return (
    <div className="modal-mask">
      <div ref={trapRef} className="modal modal--wide" role="dialog" aria-modal="true" aria-label="导入 MCP 配置">
        <div className="modal__head">
          <span>导入 MCP 配置（JSON）</span>
          <button className="icon-btn" onClick={props.onCancel} aria-label="关闭"><IconClose size={14} /></button>
        </div>
        <div className="modal__body">
          <label className="field">
            <span className="field__label">粘贴配置（stdio / Streamable HTTP 均可）</span>
            <textarea
              className="field__input mono"
              rows={14}
              value={text}
              onChange={(e) => { setText(e.target.value); setError(null) }}
              placeholder={'{\n  "local-stdio-mcp": { "type": "stdio", "command": "python3", "args": ["..."] },\n  "production-streamable-mcp": { "type": "streamableHttp", "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" } }\n}'}
              aria-label="MCP 配置 JSON"
            />
            <span className="field__hint">
              接受 {'{mcpServers:{…}}'} / {'{servers:{…}}'} / 裸 map；同域同名覆盖，未知字段（options/transport/autoApprove…）原样保留
            </span>
          </label>
          <Notice notice={error ? { kind: 'err', text: error } : null} />
        </div>
        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={props.onCancel}>取消</button>
          <button className="btn btn--primary" onClick={submit} disabled={!text.trim()}>导入</button>
        </div>
      </div>
    </div>
  )
}
