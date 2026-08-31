/** Electron 主进程入口：生命周期、窗口状态持久化、IPC 注册、退出清理 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setMainWindow } from '../lib/emitter'
import * as fsops from '../lib/fsops'
import * as config from '../lib/config'
import * as watcher from '../lib/watcher'
import * as proc from '../lib/proc'
import * as secrets from '../lib/secrets'
import * as ai from '../lib/ai'
import * as snapshot from '../lib/snapshot'
import * as inspect from '../lib/inspect'
import * as sessions from '../lib/sessions'
import * as skills from '../lib/skills'
import * as projectCreate from '../lib/project-create'

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

let mainWindow: BrowserWindow | null = null

/** 退出清理（幂等）：先杀运行中的子进程树，再停 watcher */
function cleanup(): void {
  proc.killRunningForCleanup()
  void watcher.stopWatchingInternal()
}

function registerIpc(): void {
  const handle = (channel: string, listener: (payload: any) => unknown): void => {
    ipcMain.handle(channel, (_event, payload: any) => listener(payload))
  }

  // 文件系统
  handle('list_dir', (p) => fsops.listDir(p.projectRoot, p.dir))
  handle('search_files', (p) => fsops.searchFiles(p.projectRoot, p.query))
  handle('read_text_file', (p) => fsops.readTextFile(p.projectRoot, p.path))
  handle('write_text_file', (p) => fsops.writeTextFile(p.projectRoot, p.path, p.content))
  handle('create_entry', (p) => fsops.createEntry(p.projectRoot, p.parentDir, p.name, p.isDir))
  handle('rename_entry', (p) => fsops.renameEntry(p.projectRoot, p.path, p.newName))
  handle('delete_entry', (p) => fsops.deleteEntry(p.projectRoot, p.path))
  handle('delete_project_files', (p) => fsops.deleteProjectFiles(p.projectRoot))

  // 文件快照：AI 写文件前的回退点（按对话会话分组）
  handle('snapshot_file', (p) => snapshot.snapshotFile(p.projectRoot, p.sessionId, p.path))
  handle('list_snapshots', (p) => snapshot.listSnapshots(p.projectRoot))
  handle('restore_file', (p) => snapshot.restoreFile(p.projectRoot, p.path))
  handle('restore_session', (p) => snapshot.restoreSession(p.projectRoot, p.sessionId))
  handle('clear_project_snapshots', (p) => snapshot.clearProjectSnapshots(p.projectRoot))

  // 会话历史持久化
  handle('load_session', (p) => sessions.loadSession(p.projectRoot))
  handle('save_session', (p) => sessions.saveSession(p.projectRoot, p.messages))

  // 子进程 / watcher
  handle('run_project', (p) => proc.runProject(p.projectRoot, p.name, p.command))
  handle('run_once', (p) => proc.runOnce(p.projectRoot, p.command))
  handle('stop_project', (p) => proc.stopProject(p?.name))
  handle('start_watching', (p) => watcher.startWatching(p.projectRoot))
  handle('stop_watching', () => watcher.stopWatching())

  // 配置与密钥（刻意无 get_secret：明文 Key 不出主进程）
  handle('get_config', () => config.getConfig())
  handle('merge_config', (p) => config.mergeConfig(p.patch))
  handle('set_secret', (p) => secrets.setSecret(p.key, p.value))
  handle('has_secret', (p) => secrets.hasSecret(p.key))
  handle('delete_secret', (p) => secrets.deleteSecret(p.key))

  // Skills 目录
  handle('scan_skills', (p) => skills.scanSkills(p.dir))
  handle('read_skill', (p) => skills.readSkill(p.dir, p.skillId))
  handle('pick_skills_dir', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Skills 目录',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // 创建项目 / Git
  handle('create_empty_project', (p) => projectCreate.createEmptyProject(p.parentDir, p.name))
  handle('clone_repos', (p) => projectCreate.cloneRepos(p.parentDir, p.repos))
  handle('test_repo', (p) => projectCreate.testRepo(p.url))
  handle('git_repo_info', (p) => projectCreate.gitRepoInfo(p.dir))
  handle('git_checkout', (p) => projectCreate.gitCheckout(p.dir, p.branch))
  handle('pick_parent_dir', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择父目录',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // AI（ai_chat_stream resolve 前持续推 ai-delta 事件）
  handle('ai_chat_stream', (p) => ai.aiChatStream(p.requestId, p.provider, p.baseUrl, p.model, p.messages, p.tools))
  handle('ai_test_connection', (p) => ai.aiTestConnection(p.provider, p.baseUrl, p.model))
  handle('ai_cancel', (p) => ai.aiCancel(p.requestId))

  // 窗口
  handle('pick_directory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择项目目录',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  handle('set_window_title', (p) => {
    mainWindow?.setTitle(String(p.title))
  })
  handle('open_external', (p) => {
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
  handle('start_element_pick', (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      void inspect.startElementPick(mainWindow.webContents, String(p.url ?? ''))
    }
  })
}

function createWindow(): void {
  const state = loadWindowState()
  // 窗口/任务栏图标：dev 用仓库内的 build/icon.png；打包后从 extraResources 取
  // （不设置时 Windows 显示宿主二进制的图标——dev 下就是默认 Electron 图标）
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png')
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 600,
    title: '轻驭',
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (state.maximized) win.maximize()
  mainWindow = win
  setMainWindow(win)

  win.once('ready-to-show', () => win.show())
  // 外链统一走系统默认浏览器（target="_blank" 的 <a> 也经此处）：拒绝弹 Electron 新窗口
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
  // 无应用菜单后失去 Ctrl+Shift+I：F12 兜底切换开发者工具
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
    }
  })
  win.on('close', () => saveWindowState(win))
  win.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']) // electron-vite dev server
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 应用菜单：Windows/Linux 直接去掉（File/Edit/View/Window 对本应用无意义）；
  // macOS 保留精简 role 菜单——其文本编辑快捷键（Cmd+C/V 等）依赖应用菜单存在
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 与 Tauri 行为一致：关窗即退出（含 macOS）
app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  cleanup()
})
