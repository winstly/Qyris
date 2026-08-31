import { useAppStore } from '@/store/useAppStore'
import { useChatStore } from '@/store/useChatStore'
import { useFileStore } from '@/store/useFileStore'
import { useBuildStore } from '@/store/useBuildStore'
import { api } from '@/services/desktop'
import { IconClock, IconFolder, IconTrash } from '@/components/common/icons'
import { basename } from '@/utils/path'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 历史工程 Tab：展示最近打开过的项目列表 */
export function HistoryTab() {
  const recentProjects = useAppStore((s) => s.recentProjects)
  const openProject = useAppStore((s) => s.openProject)
  const removeRecentProject = useAppStore((s) => s.removeRecentProject)
  const showConfirm = useAppStore((s) => s.showConfirm)
  const projectPath = useAppStore((s) => s.projectPath)

  if (recentProjects.length === 0) {
    return (
      <div className="history">
        <div className="emptystate">
          <div className="emptystate__icon"><IconClock size={22} /></div>
          <div className="emptystate__title">暂无历史工程</div>
          <div className="emptystate__text">打开一个项目后，这里会记录你的访问历史。</div>
        </div>
      </div>
    )
  }

  return (
    <div className="history">
      <div className="history__list">
        {recentProjects.map((proj) => {
          const isActive = proj.path === projectPath
          return (
            <div
              key={proj.path}
              className={`history__item ${isActive ? 'history__item--active' : ''}`}
              onClick={() => { if (!isActive) void openProject(proj.path) }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isActive) void openProject(proj.path) }}
            >
              <div className="history__item-icon">
                <IconFolder size={15} />
              </div>
              <div className="history__item-info">
                <span className="history__item-name">{proj.name}</span>
                <span className="history__item-path mono">{proj.path}</span>
              </div>
              <span className="history__item-time">{timeAgo(proj.lastOpened)}</span>
              <button
                className="history__item-delete"
                onClick={(e) => {
                  e.stopPropagation()
                  void showConfirm(
                    '移除历史记录',
                    `确定要将「${basename(proj.path)}」从历史记录中移除吗？`,
                    [
                      { id: 'session', label: '同时删除对话历史（不可恢复）' },
                      { id: 'files', label: '同时删除项目文件（不可恢复）' },
                    ],
                    { holdOpen: true, confirmingText: '删除中…' },
                  ).then(async (result) => {
                    const r = result as { confirmed?: boolean; checks?: Record<string, boolean> } | boolean | null
                    if (r && typeof r === 'object' && 'confirmed' in r && r.confirmed) {
                      // 删除对话历史
                      if (r.checks?.session) {
                        if (isActive) {
                          useChatStore.getState().clear()
                        } else {
                          try { await api.saveSession(proj.path, []) } catch { /* 忽略 */ }
                        }
                      }
                      // 删除项目文件（holdOpen：此期间确认框显示「删除中…」，完成后才关闭）
                      let filesFailed = false
                      let filesError = ''
                      if (r.checks?.files) {
                        try {
                          if (isActive) {
                            // 正在打开的项目：先停 watcher 与子进程，释放 Windows 目录句柄，
                            // 否则 fs.rm 删根目录会 EBUSY/EPERM（句柄占用的经典问题）
                            await api.stopWatching().catch(() => {})
                            await api.stopProject().catch(() => {})
                          }
                          await api.deleteProjectFiles(proj.path)
                          // 清空该路径的挂档数据：同路径重建项目时不允许旧数据复活
                          // （启动命令：旧命令重跑必炸；快照：回退会把旧内容覆盖到新项目上）
                          await useAppStore.getState().clearStartupCommands(proj.path)
                          await api.clearProjectSnapshots(proj.path).catch(() => {})
                          if (isActive) {
                            // 工作区复位：文件树/编辑器/服务槽回到「未打开项目」状态
                            useFileStore.getState().reset()
                            useBuildStore.getState().reset()
                            useAppStore.setState({ projectPath: null, projectName: '' })
                            void api.setWindowTitle('轻驭').catch(() => {})
                          }
                        } catch (e) {
                          // 删除失败必须告知并保留历史条目（可重试），静默吞掉 = 假装删掉了
                          filesFailed = true
                          filesError = String(e)
                        }
                      }
                      // 先关确认框再弹错误提示（两者共用同一个 dialog 槽，顺序反了 alert 会被杀掉）
                      useAppStore.getState().closeDialog()
                      if (filesFailed) {
                        void useAppStore.getState().showAlert('删除项目文件失败', filesError)
                      } else {
                        removeRecentProject(proj.path)
                      }
                    } else if (r === true) {
                      removeRecentProject(proj.path)
                    }
                  })
                }}
                aria-label={`移除 ${proj.name}`}
                title="从历史中移除"
              >
                <IconTrash size={12} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
