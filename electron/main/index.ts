/** Electron 主进程入口：多窗口管理、IPC 注册、退出清理 */
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, Tray, nativeImage } from 'electron'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { registerWindow, removeWindow, getAllWindows, emitToAllWindows, broadcastToWindows } from '../lib/emitter'
import * as pet from '../lib/pet'
import { setUnexpectedErrorHandler, isCancellationError } from '../../shared/base/errors'
import { format as logFormat, guardStdioStreams, markStreamBroken } from '../../shared/base/log'
import { mainLog, attachFileLogging } from '../lib/log-file'

// 全局兜底：未捕获异常不崩主进程，统一进日志。
// 三个 handler（unexpected/uncaughtException/unhandledRejection）收敛到 reportUncaught：
// ① 同类去重——同一错误风暴式重抛（如断开的流反复 EIO）每 60s 只记一条，日志不再被同一错刷爆；
// ② EIO/EPIPE 静默 + 熔断日志流——console 写已关闭的 stdio 会异步抛错又进本 handler 自循环，
//    这类错误记一条就够，且此后停写 console（文件日志仍写）。
const recentUncaught = new Map<string, number>()
function reportUncaught(tag: string, e: unknown): void {
  if (isCancellationError(e)) return // vscode onUnexpectedError 语义：取消不是错误
  const msg = logFormat(e)
  if (/\bEIO\b|\bEPIPE\b|ERR_STREAM_DESTROYED|write E(IO|PIPE)/i.test(msg)) {
    markStreamBroken()
    const sig = `stream:${tag}`
    const now = Date.now()
    if ((recentUncaught.get(sig) ?? 0) + 60_000 > now) return
    recentUncaught.set(sig, now)
    mainLog.error(`[${tag}] stdio 流已断（后续 EIO/EPIPE 静默熔断）：${msg}`)
    return
  }
  const sig = `${tag}:${msg.slice(0, 200)}`
  const now = Date.now()
  if ((recentUncaught.get(sig) ?? 0) + 60_000 > now) return
  recentUncaught.set(sig, now)
  mainLog.error(`[${tag}] ${msg}`)
}
guardStdioStreams()
setUnexpectedErrorHandler((e) => reportUncaught('unexpected', e))
process.on('uncaughtException', (e) => reportUncaught('uncaughtException', e))
process.on('unhandledRejection', (reason) => reportUncaught('unhandledRejection', reason))
import * as fsops from '../lib/fsops'
import * as config from '../lib/config'
import * as watcher from '../lib/watcher'
import * as proc from '../lib/proc'
import * as secrets from '../lib/secrets'
import * as ssh from '../lib/ssh'
import * as ptymgr from '../lib/pty'
import { emitToWindow } from '../lib/emitter'
import * as ai from '../lib/ai'
import * as snapshot from '../lib/snapshot'
import * as inspect from '../lib/inspect'
import * as messages from '../lib/messages'
import * as memory from '../lib/memory/service'
import * as memoryAgent from '../lib/memory/agent'
import * as migrate from '../lib/migrate'
import { warmupEmbed } from '../lib/memory/embed'
import { closeDb, dataDir } from '../lib/db'
import * as skills from '../lib/skills'
import * as projectCreate from '../lib/project-create'
import * as git from '../lib/git'
import * as consolebridge from '../lib/consolebridge'
import * as preview from '../lib/preview'

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState {
  try {
    const parsed = JSON.parse(readFileSync(windowStatePath(), 'utf8')) as Partial<WindowState>
    return {
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      width: typeof parsed.width === 'number' ? parsed.width : 1440,
      height: typeof parsed.height === 'number' ? parsed.height : 900,
      maximized: parsed.maximized === true,
    }
  } catch {
    return { width: 1440, height: 900 }
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const state: WindowState = { ...win.getBounds(), maximized: win.isMaximized() }
    mkdirSync(path.dirname(windowStatePath()), { recursive: true })
    writeFileSync(windowStatePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    /* 状态保存失败不阻塞退出 */
  }
}

/** 退出清理（幂等）：先杀运行中的子进程树（含在途 CLI 子进程），再停所有 watcher、关闭 SQLite。
 *  挂在 before-quit 而非 will-quit：与窗口关闭收尾并行，关闭不再排队等清理串行跑完 */
let cleanedUp = false
function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true
  proc.killRunningForCleanup()
  proc.cancelRunOnce()
  void watcher.stopWatching()
  if (tray && !tray.isDestroyed()) tray.destroy()
  void closeDb().catch(() => {})
}

/**
 * fd watchdog：5s 周期统计 /dev/fd 数量 + 句柄分类，只在异常阈值记日志
 * （>2000 个 fd，或较上次 Δ>50——正常期零日志，泄漏期留下增长轨迹）。
 * 1.8 万目录工程的 fd 泄漏是系统级卡死的头号嫌疑，这里是最便宜的观测点。
 * unref：定时器不占应用退出。
 */
function startFdWatchdog(): void {
  let last = -1
  const timer = setInterval(() => {
    let fdCount = -1
    try {
      fdCount = readdirSync('/dev/fd').length
    } catch { /* Windows 无 /dev/fd 或读不到：跳过 fd 计数 */ }
    const handles = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : []
    const byType = new Map<string, number>()
    for (const h of handles) byType.set(h, (byType.get(h) ?? 0) + 1)
    const delta = last >= 0 && fdCount >= 0 ? fdCount - last : 0
    const metric = fdCount >= 0 ? fdCount : handles.length
    if (metric > 2000 || Math.abs(delta) > 50) {
      mainLog.warn(
        `[fd-watchdog] fd=${fdCount} Δ=${delta} handles=${handles.length} {${[...byType].map(([k, v]) => `${k}:${v}`).join(' ')}}`,
      )
    }
    if (fdCount >= 0) last = fdCount
  }, 5000)
  timer.unref()
}

function registerIpc(): void {
  // IPC 慢调用埋点：>100ms 才记（正常调用不进日志，只在异常阈值留线索）。
  // 「点了没反应」类卡死排查时，先看这里定位是哪个 channel 在堵
  const ipcStats = new Map<string, { count: number; slow: number; maxMs: number }>()
  const handle = (channel: string, listener: (event: Electron.IpcMainInvokeEvent, payload: any) => unknown): void => {
    ipcMain.handle(channel, async (event, payload: any) => {
      const t0 = Date.now()
      try {
        return await listener(event, payload)
      } finally {
        const ms = Date.now() - t0
        if (ms > 100) {
          const st = ipcStats.get(channel) ?? { count: 0, slow: 0, maxMs: 0 }
          st.count++
          st.slow++
          st.maxMs = Math.max(st.maxMs, ms)
          ipcStats.set(channel, st)
          mainLog.warn(`[ipc] 慢调用 ${channel} ${ms}ms（累计慢 ${st.slow} 次 / 峰值 ${st.maxMs}ms）`)
        }
      }
    })
  }

  // 文件系统（projectRoot 来自渲染层，主进程做 ensureInside 校验）
  handle('list_dir', (_e, p) => fsops.listDir(p.projectRoot, p.dir))
  handle('list_dir_batch', (_e, p) => fsops.listDirBatch(p.projectRoot, p.dirs))
  handle('search_files', (_e, p) => fsops.searchFiles(p.projectRoot, p.query))
  handle('grep_files', (_e, p) =>
    fsops.grepFiles(p.projectRoot, String(p?.pattern ?? ''), {
      glob: p?.glob ?? undefined,
      maxResults: p?.maxResults ?? undefined,
      caseSensitive: p?.caseSensitive === true,
    }))
  handle('read_text_file', (_e, p) => fsops.readTextFile(p.projectRoot, p.path))
  handle('write_text_file', (_e, p) =>
    fsops.writeTextFile(p.projectRoot, p.path, p.content, {
      expectedMtimeMs: p?.expectedMtimeMs ?? null,
      force: p?.force === true,
    }))
  handle('edit_text_file', (_e, p) => fsops.editTextFile(p.projectRoot, p.path, p.oldString, p.newString))
  handle('create_entry', (_e, p) => fsops.createEntry(p.projectRoot, p.parentDir, p.name, p.isDir))
  handle('rename_entry', (_e, p) => fsops.renameEntry(p.projectRoot, p.path, p.newName))
  handle('delete_entry', (_e, p) => fsops.deleteEntry(p.projectRoot, p.path))
  handle('copy_entry', (_e, p) => fsops.copyEntry(p.projectRoot, p.srcPath, p.destDir))
  handle('move_entry', (_e, p) => fsops.moveEntry(p.projectRoot, p.srcPath, p.destDir))
  handle('delete_project_files', (_e, p) => {
    // 真超时：fsp.rm 在 EBUSY 下可能卡住重试很久，前端 30s flag 杀不掉 IPC。
    // 主进程侧用 AbortSignal.timeout 强制 reject，保证前端一定能收到响应。
    return Promise.race([
      fsops.deleteProjectFiles(p.projectRoot),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('删除超时（15s），文件被其他程序占用。请关闭占用程序后手动删除，或重启电脑后重试。')), 15_000),
      ),
    ])
  })

  // 文件快照（v2：版本快照 + diff 预览 + 定点回退）
  handle('snapshot_file', (_e, p) => snapshot.snapshotFile(p.projectRoot, p.sessionId, p.path, { version: p?.version === true }))
  handle('list_snapshots', (_e, p) => snapshot.listSnapshots(p.projectRoot))
  handle('snapshot_versions', (_e, p) => snapshot.listFileSnapshotVersions(p.projectRoot, p.path))
  handle('snapshot_read', (_e, p) => snapshot.readSnapshotContent(p.projectRoot, p.sessionId, p.path, p?.versionKey ?? null))
  handle('snapshot_diff', (_e, p) => snapshot.snapshotDiff(p.projectRoot, p.sessionId, p.path, p?.versionKey ?? null))
  handle('snapshot_restore_at', (_e, p) => snapshot.restoreSnapshotAt(p.projectRoot, p.sessionId, p.path, p?.versionKey ?? null))
  handle('restore_file', (_e, p) => snapshot.restoreFile(p.projectRoot, p.path))
  handle('restore_session', (_e, p) => snapshot.restoreSession(p.projectRoot, p.sessionId))
  handle('clear_project_snapshots', (_e, p) => snapshot.clearProjectSnapshots(p.projectRoot))

  // 会话消息持久化（SQLite）
  handle('messages_recent', (_e, p) => messages.messagesRecent(p.projectRoot, p.limit))
  handle('save_current_session', (_e, p) => messages.saveCurrentSession(p.projectRoot, p.sessionId))
  handle('messages_before', (_e, p) => messages.messagesBefore(p.projectRoot, p.sessionId, p.beforeSeq, p.limit))
  handle('message_append', (_e, p) => messages.messageAppend(p.projectRoot, p.sessionId, p.message))
  handle('message_patch', (_e, p) => messages.messagePatch(p.projectRoot, p.sessionId, p.id, p.patch))
  handle('messages_truncate', (_e, p) => messages.messagesTruncate(p.projectRoot, p.sessionId, p.afterSeq))
  handle('project_data_delete', (_e, p) => messages.projectDataDelete(p.projectRoot))
  handle('save_session_tokens', (_e, p) => messages.saveSessionTokens(p.projectRoot, p.sessionId, p.tokens))
  handle('load_session_tokens', (_e, p) => messages.loadSessionTokens(p.projectRoot, p.sessionId))

  // 记忆（检索底座：FTS + 向量混合；写入由 P2 mem agent 负责，此处仅管理通道）
  handle('memory_list', (_e, p) => memory.memoryList(p.projectRoot, p.includeArchived === true))
  handle('memory_search', (_e, p) =>
    memory.memorySearch(String(p.query ?? ''), p.projectRoot, p.topK, p.includeArchived === true))
  handle('memory_update', (_e, p) => memory.memoryUpdate(p.id, p.patch))
  handle('memory_delete', (_e, p) => memory.memoryDelete(p.id))
  handle('memory_move_scope', (_e, p) => memory.memoryMoveScope(p.id, p.target, p.projectRoot))
  handle('memory_clear', (_e, p) => memory.memoryClear(p.scope, p.projectRoot))
  handle('memory_stats', () => memory.memoryStats())
  // P3 备份通道（对话框绑定调用方窗口）
  handle('memory_export', (e, p) =>
    memory.memoryExport(p.scope, p.projectRoot ?? undefined, BrowserWindow.fromWebContents(e.sender)))
  handle('memory_import', (e) =>
    memory.memoryImport(BrowserWindow.fromWebContents(e.sender)))

  // mem agent（P2 记忆蒸馏管线：滚动/收尾/手动触发 + 会话摘要 + lesson；游标与频控在主进程）
  handle('memory_session_context', async (_e, p) => ({
    summary: await memory.sessionSummary(String(p.projectRoot ?? ''), String(p.sessionId ?? '')),
  }))
  handle('memory_maybe_extract', (_e, p) =>
    memoryAgent.memoryMaybeExtract(String(p.projectRoot ?? ''), String(p.sessionId ?? '')))
  handle('session_ended', (_e, p) =>
    memoryAgent.sessionEnded(String(p.projectRoot ?? ''), String(p.sessionId ?? '')))
  handle('memory_run_now', (_e, p) => memoryAgent.memoryRunNow(String(p.projectRoot ?? '')))
  handle('memory_extracting', (_e, p) => memoryAgent.isExtracting(String(p.projectRoot ?? '')))
  handle('note_lesson', (_e, p) =>
    memory.noteLesson(String(p.projectRoot ?? ''), String(p.sessionId ?? ''), p.lesson))

  // 存储位置（设置项：当前路径显示 / 选择目录 + 迁移）
  handle('get_data_dir', () => dataDir())
  handle('select_data_dir', (e) => migrate.selectDataDir(BrowserWindow.fromWebContents(e.sender)))
  handle('migrate_data_dir', (_e, p) => migrate.migrateDataDir(String(p?.dir ?? '')))

  // 子进程 / watcher（windowId 用于事件定向路由）
  handle('run_project', (e, p) => proc.runProject(p.projectRoot, p.name, p.command, e.sender.id))
  handle('run_once', (_e, p) => proc.runOnce(p.projectRoot, p.command, p.token))
  handle('run_once_cancel', (_e, p) => proc.cancelRunOnce(p?.token))

  // ---------- 发布 tab（SSH 部署运维） ----------
  const deployExecHandles = new Map<string, ssh.ExecHandle>()
  handle('deploy:list_servers', async () => (await config.getConfig()).deployServers ?? [])
  handle('deploy:save_server', async (_e, p) => {
    const servers = (await config.getConfig()).deployServers ?? []
    const idx = servers.findIndex((x) => x.id === p?.server?.id)
    const next = [...servers]
    if (idx >= 0) next[idx] = p.server
    else next.push(p.server)
    await config.mergeConfig({ deployServers: next })
    return next
  })
  handle('deploy:delete_server', async (_e, p) => {
    const id = String(p?.serverId ?? '')
    const servers = ((await config.getConfig()).deployServers ?? []).filter((x) => x.id !== id)
    await config.mergeConfig({ deployServers: servers })
    await secrets.deleteSecret(`ssh:${id}`).catch(() => {})
    return servers
  })
  handle('deploy:set_credential', async (_e, p) => {
    await secrets.setSecret(`ssh:${String(p?.serverId ?? '')}`, String(p?.secret ?? ''))
  })
  handle('deploy:has_credential', async (_e, p) => secrets.hasSecret(`ssh:${String(p?.serverId ?? '')}`))
  handle('deploy:delete_credential', async (_e, p) => secrets.deleteSecret(`ssh:${String(p?.serverId ?? '')}`))
  handle('deploy:test_connection', async (_e, p) => {
    const servers = (await config.getConfig()).deployServers ?? []
    const server = servers.find((x) => x.id === p?.serverId)
    if (!server) return { ok: false, error: '服务器不存在' }
    return ssh.testConnection(server)
  })
  handle('deploy:exec', async (e, p) => {
    const serverId = String(p?.serverId ?? '')
    const command = String(p?.command ?? '')
    const runId = String(p?.runId ?? `run-${Date.now()}`)
    // 危险命令闸（主进程强制）：未签发放行 token 直接拒绝
    const danger = ssh.checkDangerousCommand(command)
    if (danger && p?.allowDangerous !== true) {
      return { blocked: true, reason: danger, exitCode: null }
    }
    const servers = (await config.getConfig()).deployServers ?? []
    const server = servers.find((x) => x.id === serverId)
    if (!server) return { blocked: false, exitCode: null, error: '服务器不存在' }
    const winId = e.sender.id
    return await new Promise((resolve) => {
      const handle = ssh.execCommand(server, command, {
        runId,
        onLine: (stream, line) => emitToWindow(winId, 'deploy:output', { runId, stream, line }),
        onExit: (code) => {
          deployExecHandles.delete(runId)
          emitToWindow(winId, 'deploy:exit', { runId, code })
          resolve({ blocked: false, exitCode: code })
        },
      })
      deployExecHandles.set(runId, handle)
    })
  })
  handle('deploy:exec_cancel', (_e, p) => {
    const runId = String(p?.runId ?? '')
    deployExecHandles.get(runId)?.cancel()
    deployExecHandles.delete(runId)
  })

  // ---------- 终端 tab（PTY） ----------
  handle('pty_create', (e, p) => ptymgr.createPty(String(p?.termId ?? `term-${Date.now()}`), e.sender.id, {
    cols: Number(p?.cols) || 80,
    rows: Number(p?.rows) || 24,
    cwd: p?.cwd ? String(p.cwd) : undefined,
  }))
  handle('pty_input', (_e, p) => ptymgr.inputPty(String(p?.termId ?? ''), String(p?.data ?? '')))
  handle('pty_resize', (_e, p) => ptymgr.resizePty(String(p?.termId ?? ''), Number(p?.cols) || 80, Number(p?.rows) || 24))
  handle('pty_kill', (_e, p) => ptymgr.killPty(String(p?.termId ?? '')))

  handle('stop_project', (_e, p) => proc.stopProject(p?.projectRoot ?? null, p?.name ?? null))
  handle('check_url', (_e, p) => proc.checkUrlHealthy(String(p?.url ?? '')))
  // 预览控制台
  handle('preview_console_attach', (_e, p) => consolebridge.setConsoleFilter(p?.url ? String(p.url) : null))
  handle('preview_set_url', async (_e, p) => preview.setPreviewUrl(String(p?.url ?? '')))
  handle('preview_bounds', async (_e, p) => preview.setPreviewBounds(p as { x: number; y: number; width: number; height: number }))
  handle('preview_reload', async () => preview.reloadPreview())
  handle('preview_clear_cache', async () => preview.clearPreviewCache())
  handle('preview_devtools', async () => preview.previewOpenDevTools())
  handle('preview_execute_js', async (_e, p) => preview.previewExecuteJs(String(p?.code ?? '')))
  handle('preview_visible', async (_e, p) => preview.setPreviewVisible(p?.visible !== false))
  handle('preview_console_history', () => consolebridge.consoleHistory())
  // 端口占用查询
  handle('port_owner', (_e, p) => proc.portOwner(Number(p?.port)))
  // 多窗口 watcher：传入 windowId
  handle('start_watching', (e, p) => watcher.startWatching(p.projectRoot, e.sender.id))
  handle('stop_watching', (e) => watcher.stopWatchingForWindow(e.sender.id))
  handle('stop_watching_project', (e, p) => watcher.stopProjectWatching(p.projectRoot, e.sender.id))

  // 配置与密钥
  handle('get_config', () => config.getConfig())
  handle('merge_config', (_e, p) => config.mergeConfig(p.patch))
  // 密钥增删后广播 config:changed：另一窗口（桌宠面板无 SettingsDialog）据此刷新 hasApiKey
  handle('set_secret', async (_e, p) => {
    await secrets.setSecret(p.key, p.value)
    emitToAllWindows('config:changed', ['secrets'])
  })
  handle('has_secret', (_e, p) => secrets.hasSecret(p.key))
  handle('delete_secret', async (_e, p) => {
    await secrets.deleteSecret(p.key)
    emitToAllWindows('config:changed', ['secrets'])
  })

  // Skills 目录
  handle('scan_skills', (_e, p) => skills.scanSkillsDirs(p.dirs))
  handle('read_skill', (_e, p) => skills.readSkillFromDirs(p.dirs, p.skillId))
  handle('pick_skills_dir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Skills 目录',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  // 项目级 Skill CRUD
  handle('project_skill_import_zip', (_e, p) => skills.importSkillFromZip(p.dir, p.zipPath))
  handle('project_skill_import_dir', (_e, p) => skills.importSkillFromDir(p.dir, p.srcDir))
  handle('project_skill_delete', (_e, p) => skills.deleteProjectSkill(p.dir, p.skillId))
  handle('project_skill_pick_zip', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Skill ZIP 包',
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  handle('project_skill_pick_dir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Skill 目录',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // 创建项目 / Git
  handle('create_empty_project', (_e, p) => projectCreate.createEmptyProject(p.parentDir, p.name))
  handle('clone_repos', (_e, p) => projectCreate.cloneRepos(p.parentDir, p.repos, {
    onProgress: (info) => emitToAllWindows('clone:progress', info),
  }))
  handle('clone_cancel', () => projectCreate.cancelClones())
  handle('test_repo', (_e, p) => projectCreate.testRepo(p.url))
  handle('git_repo_info', (_e, p) => projectCreate.gitRepoInfo(p.dir))
  handle('git_checkout', (_e, p) => projectCreate.gitCheckout(p.dir, p.branch))
  // Git 工作区
  handle('git_status', (_e, p) => git.gitStatus(p.dir))
  handle('git_is_repo_root', (_e, p) => git.gitIsRepoRoot(p.dir))
  handle('git_diff', (_e, p) => git.gitDiff(p.dir, p.path, p.staged === true))
  handle('git_add', (_e, p) => git.gitAdd(p.dir, p.paths))
  handle('git_unstage', (_e, p) => git.gitUnstage(p.dir, p.paths ?? []))
  handle('git_commit', (_e, p) => git.gitCommit(p.dir, String(p.message ?? '')))
  handle('git_pull', (_e, p) => git.gitPull(p.dir))
  handle('git_fetch', (_e, p) => git.gitFetch(p.dir))
  handle('git_push', (_e, p) => git.gitPush(p.dir))
  handle('git_discard', (_e, p) => git.gitDiscard(p.dir, p.paths ?? []))
  handle('pick_parent_dir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    // 同 pick_directory：alwaysOnTop 窗口先取消置顶再弹原生对话框
    const wasAlwaysOnTop = win.isAlwaysOnTop()
    if (wasAlwaysOnTop) win.setAlwaysOnTop(false)
    try {
      const result = await dialog.showOpenDialog(win, {
        title: '选择父目录',
        properties: ['openDirectory'],
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    } finally {
      if (wasAlwaysOnTop) win.setAlwaysOnTop(true)
    }
  })

  // AI（windowId 绑定到发起请求的窗口，用于事件定向路由；opts 透传 CLI 记忆反哺通道——
  //  sessionSummary/memoryBlock，缺此一跳 CLI 模式的记忆注入会整体断供）
  handle('ai_chat_stream', (e, p) =>
    Promise.resolve(
      ai.aiChatStream(p.requestId, p.provider, p.baseUrl, p.model, p.messages, p.tools, p.dispatchMode, p.projectRoot, e.sender.id, p.opts ?? undefined),
    ).then(
      (r) => {
        // 镜像管道：请求收场广播给其余窗口（镜像侧据此收口状态并从库校正）
        broadcastToWindows('chat:request-done', { requestId: p.requestId, projectRoot: p.projectRoot ?? null, hasError: false }, e.sender.id)
        return r
      },
      (err) => {
        broadcastToWindows('chat:request-done', { requestId: p.requestId, projectRoot: p.projectRoot ?? null, hasError: true }, e.sender.id)
        throw err
      },
    ))
  handle('ai_test_connection', (_e, p) => ai.aiTestConnection(p.provider, p.baseUrl, p.model, p.dispatchMode, p.cliCommand))
  handle('ai_cancel', (_e, p) => ai.aiCancel(p.requestId))

  // 跨窗口项目同步：发起窗口 send → 主进程广播给其余窗口
  ipcMain.on('project:changed', (e, p: { projectPath: string | null; openProjects: string[]; closedProject?: string | null }) => {
    broadcastToWindows('project:changed', p, e.sender.id)
  })

  // 桌宠视频路径解析：打包后用 file:// 指向 asarUnpack 解包的 MP4，dev 用相对路径
  handle('pet:resolve-video', (_e, filename: string) => {
    if (app.isPackaged) {
      // asarUnpack 解包到 app.asar.unpacked/out/renderer/pet/
      return `file://${path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'renderer', 'pet', filename)}`
    }
    // dev 模式：Vite dev server 的 public 目录
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) return `${rendererUrl}/pet/${filename}`
    return filename
  })

  // 窗口（对话框绑定到调用方窗口）
  handle('pick_directory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    // alwaysOnTop 窗口（桌宠面板）会盖住原生对话框 → 用户看到"点了没反应"。
    // 弹窗期间临时取消置顶，结束后恢复。
    const wasAlwaysOnTop = win.isAlwaysOnTop()
    if (wasAlwaysOnTop) win.setAlwaysOnTop(false)
    try {
      const result = await dialog.showOpenDialog(win, {
        title: '选择项目目录',
        properties: ['openDirectory'],
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    } finally {
      if (wasAlwaysOnTop) win.setAlwaysOnTop(true)
    }
  })
  handle('pick_key_file', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const wasAlwaysOnTop = win.isAlwaysOnTop()
    if (wasAlwaysOnTop) win.setAlwaysOnTop(false)
    try {
      const result = await dialog.showOpenDialog(win, {
        title: '选择 SSH 私钥文件',
        properties: ['openFile'],
        filters: [
          { name: '私钥文件', extensions: ['pem', 'key', 'ppk', ''] },
          { name: '全部文件', extensions: ['*'] },
        ],
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    } finally {
      if (wasAlwaysOnTop) win.setAlwaysOnTop(true)
    }
  })
  handle('set_window_title', (e, p) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.setTitle(String(p.title))
  })
  // 窗口三键（自绘标题栏，作用于发送者所在窗口——主窗口与 pet 面板通用）。
  // 关闭走 win.close()：命中 close 事件的 preventDefault 分流（ask/minimize/quit），
  // 与系统 X 完全同路径，不会绕过 ClosePromptDialog。
  handle('win_minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  handle('win_toggle_maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  handle('win_request_close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  handle('open_external', (_e, p) => {
    const url = String(p.url ?? '')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`非法 URL：${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`仅允许 http/https 链接：${url}`)
    }
    return shell.openExternal(url)
  })
  handle('open_in_explorer', (_e, { filePath }: { filePath: string }) => {
    return shell.showItemInFolder(filePath)
  })
  // 桌宠（注入主窗口/退出动作，右键菜单用；quitApp 先置放行位再退，不与 close 拦截死缠）
  pet.registerPetIpc({
    openMain: () => showMainWindow(),
    quitApp: () => {
      quitting = true
      app.quit()
    },
  })
  ipcMain.on('pet:move-by', (e, dx: number, dy: number) => {
    // 渲染层来的 TS 类型标注只是编译期的：IPC 载荷必须运行时校验，
    // 否则字符串会拼接进坐标、NaN 会把窗口打到无效位置
    const ix = Number(dx)
    const iy = Number(dy)
    if (!Number.isFinite(ix) || !Number.isFinite(iy)) return
    const petWin = BrowserWindow.fromWebContents(e.sender)
    if (petWin && !petWin.isDestroyed()) {
      const [x, y] = petWin.getPosition()
      petWin.setPosition(x + ix, y + iy)
      // 面板实时跟随拖动：开着面板拖桌宠时，面板贴着图标走而不是停在原地
      pet.repositionPanelIfVisible()
    }
  })
  // 主窗口生命周期：关闭询问回调（挂起中才受理，超时兜底已收口）+ 桌宠面板「打开主窗口」入口
  ipcMain.on('app:close-resolve', (_e, p: { action?: string; remember?: boolean }) => {
    if (!closePromptPending) return
    closePromptPending = false
    closeAskVisible = false
    const action = p?.action === 'quit' ? 'quit' : 'minimize'
    if (p?.remember === true) void config.mergeConfig({ closeAction: action })
    if (action === 'quit') {
      quitting = true
      app.quit()
      return
    }
    if (mainWin && !mainWin.isDestroyed()) mainWin.minimize()
  })
  // 对话镜像 relay：发起窗口的用户消息/收尾/清空 → 其余全部窗口（桌宠面板 ↔ 主窗口同一场对话）
  ipcMain.on('chat:mirror-relay', (e, p) => broadcastToWindows('chat:mirror', p, e.sender.id))
  // 主题 relay：主题存渲染层 zustand（各窗口各一份），不广播就只有发起窗口变了——
  // 桌宠面板/桌宠是独立窗口，必须靠这条才能跟着切
  ipcMain.on('theme:set', (e, p) => broadcastToWindows('theme:changed', String(p?.theme ?? 'system'), e.sender.id))

  handle('start_element_pick', (e) => {
    // 定向回传发起窗口：拾取只在主窗口预览发起，广播会让面板收到别的窗口选中的元素
    void inspect.startElementPick(preview.getPreviewWebContents(), e.sender.id)
  })
}

/** 窗口位置偏移：新窗口相对上一个主窗口偏移 40px（桌宠/面板小窗口不参与布局计算） */
function nextWindowOffset(): { x: number; y: number } {
  const wins = getAllWindows().filter((w) => !pet.isPetFamilyWindowId(w.id))
  if (wins.length === 0) return { x: NaN, y: NaN }
  const last = wins[wins.length - 1]
  const bounds = last.getBounds()
  return { x: bounds.x + 40, y: bounds.y + 40 }
}

/** 主窗口引用：桌宠面板「打开主窗口」与关闭拦截的 hide 都需要定向操作 */
let mainWin: BrowserWindow | null = null
/** 系统托盘（模块级持有防 GC） */
let tray: Tray | null = null
/** app.quit() 进行中：放行所有窗口 close，避免关闭拦截把退出也拦下来 */
let quitting = false
/** 关闭询问弹窗挂起中：防重复触发；渲染层超时未响应时兜底 */
let closePromptPending = false
/** 询问弹窗已展示：此时的再次关闭才视为「确认退出」（pending 只代表 requestClose 在途，弹窗未必已弹出） */
let closeAskVisible = false

/** 主窗口关闭（已 preventDefault）：按配置分流。
 *  ask=推给渲染层弹询问框；minimize=最小化到任务栏保留桌宠；quit=退出整个应用。
 *  渲染层 10s 无响应按最小化兜底——宁可窗口藏起来可找回，不可让应用凭空失联。 */
async function requestClose(win: BrowserWindow): Promise<void> {
  // pending 置位提前到 getConfig await 之前：防双击 X 并发进两次询问流
  if (closePromptPending) return
  closePromptPending = true
  const cfg = await config.getConfig()
  if (cfg.closeAction === 'minimize') {
    closePromptPending = false
    // minimize 而非 hide：hide 会把任务栏图标一起藏掉，程序「缩小」后只剩托盘小图；
    // 最小化保留任务栏图标（点击还原），桌宠与托盘行为不变
    win.minimize()
    return
  }
  if (cfg.closeAction === 'quit') {
    closePromptPending = false
    quitting = true
    app.quit()
    return
  }
  closeAskVisible = true
  win.webContents.send('app:close-request')
  setTimeout(() => {
    if (!closePromptPending) return
    closePromptPending = false
    closeAskVisible = false
    // 兜底隐藏前必须通知渲染层收起询问框：否则窗口找回后残留的对话框
    // 按钮会打在已收口的 pending 位上，点了没反应
    if (!win.isDestroyed()) {
      win.webContents.send('app:close-cancel')
      win.minimize()
    }
  }, 10_000)
}

/** 把主窗口带到前台；窗口已被销毁（异常路径）时重建 */
function showMainWindow(): void {
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.show()
    mainWin.focus()
    return
  }
  createWindow()
}

/** 创建主窗口（渲染层 boot 时读取配置自动恢复上次项目） */
function createWindow(): void {
  const state = loadWindowState()
  const offset = nextWindowOffset()
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png')
  const win = new BrowserWindow({
    x: Number.isFinite(offset.x) ? offset.x : state.x,
    y: Number.isFinite(offset.y) ? offset.y : state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 600,
    title: '轻驭',
    icon: iconPath,
    show: false,
    // 无边框 + 自绘标题栏（AppTopbar）：视觉统一、按钮可扩展、跨平台一致。
    // resize 边仍由系统提供；顶栏 -webkit-app-region:drag 承担移动/双击最大化。
    frame: false,
    backgroundColor: '#06070a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (state.maximized && getAllWindows().filter((w) => !pet.isPetFamilyWindowId(w.id)).length === 0) win.maximize()
  registerWindow(win)
  mainWin = win
  preview.setPreviewHost(win)

  // 窗口可见性诊断：创建后打 bounds + 所在显示器——「窗口开在屏外/黑屏」类问题的定位前置
  try {
    const b = win.getBounds()
    const d = screen.getDisplayMatching(b)
    mainLog.info(`[win] created bounds=${JSON.stringify(b)} display=${d.id} ${d.bounds.width}x${d.bounds.height} scale=${d.scaleFactor}`)
  } catch { /* 显示器信息获取失败不阻塞建窗 */ }

  win.once('ready-to-show', () => {
    win.show()
    win.focus() // ready-to-show 后抢一次焦点：任务栏恢复/多显示器下不抢会落在别的窗口后面
  })
  // load 失败兜底：不兜就是黑屏无线索（dev server 未起 / 文件损坏 / 路径错）
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return
    mainLog.error(`[win] did-fail-load code=${code} desc=${desc} url=${url}`)
  })
  consolebridge.attachConsoleCapture(win)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(url)
        return { action: 'deny' }
      }
    } catch {
      /* 非 URL 放行默认行为 */
    }
    return { action: 'allow' }
  })
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
    }
  })
  // 最大化状态推送：自绘标题栏按钮图标（maximize ⇄ restore）跟切
  const sendWindowState = () => {
    if (!win.isDestroyed()) win.webContents.send('app:window-state', { maximized: win.isMaximized() })
  }
  win.on('maximize', sendWindowState)
  win.on('unmaximize', sendWindowState)
  win.on('close', (e) => {
    saveWindowState(win)
    if (quitting) return
    if (closeAskVisible) {
      // 询问弹窗展示中的再次关闭请求 = 确认退出（否则弹窗常驻，再点 X 无响应）。
      // 只认弹窗已弹出的形态：requestClose 仍在读配置的间隙不算，避免双击 X 直接退出
      closeAskVisible = false
      closePromptPending = false
      quitting = true
      app.quit()
      return
    }
    // 关闭行为由主进程接管（ask/minimize/quit），不允许默认销毁——桌宠还活着时窗口必须可找回
    e.preventDefault()
    void requestClose(win)
  })
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
    removeWindow(win)
    pet.clearWindowChatState(win.id)
    void watcher.stopWatchingForWindow(win.id)
    ptymgr.killAllForWindow(win.id)
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const fileUrl = path.join(__dirname, '../renderer/index.html')
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(fileUrl)
  }
}

app.whenReady().then(async () => {
  // 文件日志就绪（此前日志进 BufferLogger 缓冲，此刻回放）
  attachFileLogging()
  mainLog.info('[boot] 轻驭主进程启动')
  // fd 泄漏观测（5s 周期，只在异常阈值记）
  startFdWatchdog()
  // macOS：保证 dock 图标常驻（菜单栏/全屏退出后窗口可找回；非 darwin 无 dock）
  if (process.platform === 'darwin') app.dock?.show()
  // 配置变更广播：任一窗口/主进程写配置后，所有窗口收到变化的顶层键
  config.onConfigChanged((keys) => {
    emitToAllWindows('config:changed', [...keys])
  })

  // 清理上次异常退出遗留的服务进程树（异步校验命令行，不再阻塞启动）
  try {
    const killed = await proc.cleanupOrphanServices()
    if (killed > 0) mainLog.info(`[cleanup] 已清理 ${killed} 个上次遗留的服务进程`)
  } catch { /* 清理失败不阻塞启动 */ }

  // 嵌入模型预热 + 蒸馏 token 恢复 + 记忆维护作业（fire-and-forget 不阻塞启动）：
  //  预热成功后跑指纹自愈（不符 → 全量重嵌）；衰减/归档作业 boot 调度（30s 首跑 + 每 6h）
  void warmupEmbed().then((ready) => {
    if (ready) void memory.maybeStartReembedJob().catch((e) => mainLog.warn(`[memory] 重嵌自愈失败：${String(e)}`))
  })
  void memory.loadDistillTokens().catch(() => {})
  memory.startDecayJob()

  // 应用菜单
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]))
  } else {
    Menu.setApplicationMenu(null)
  }
  registerIpc()
  createWindow()
  // 桌宠：主窗口就绪后创建透明置顶小窗口
  pet.createPetWindow()
  // 启动即应用「隐藏桌宠」偏好（窗口仍创建——隐藏而非跳过创建，设置里可随时恢复）
  void config.getConfig().then((c) => { if (c.petHidden === true) pet.setPetHidden(true) })
  // 系统托盘：主窗口隐藏后可通过托盘找回；右键菜单提供全局操作入口
  const trayIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png')
  try {
    let trayIcon = nativeImage.createFromPath(trayIconPath)
    // macOS 菜单栏图标缩放到 18px（不设 Template——彩色图标设 Template 会变全白不可见）
    if (process.platform === 'darwin') {
      trayIcon = trayIcon.resize({ width: 18, height: 18 })
    }
    tray = new Tray(trayIcon)
    tray.setToolTip('轻驭')
    const buildTrayMenu = (): Menu => Menu.buildFromTemplate([
      { label: '打开工作台', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出应用', click: () => { quitting = true; app.quit() } },
    ])
    tray.setContextMenu(buildTrayMenu())
    // 左键单击打开主窗口（Windows/Linux）
    tray.on('click', () => showMainWindow())
    mainLog.info('[boot] 系统托盘已创建')
  } catch (e) {
    mainLog.warn(`[boot] 系统托盘创建失败：${String(e)}`)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 所有窗口关闭后退出
app.on('window-all-closed', () => {
  app.quit()
})

// 退出序列开始：放行所有窗口的 close 拦截，保证 ask/minimize 拦截不会卡死退出；
// 清理同时在此启动（与窗口收尾并行，幂等守卫兜底）
app.on('before-quit', () => {
  quitting = true
  cleanup()
})

app.on('will-quit', () => {
  cleanup()
})
