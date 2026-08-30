import { useAppStore } from '@/store/useAppStore'
import { useChatStore } from '@/store/useChatStore'
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
                      // 删除项目文件
                      if (r.checks?.files) {
                        try {
                          await api.deleteProjectFiles(proj.path)
                          console.log('[history] 已删除项目文件：', proj.path)
                        } catch (e) {
                          console.error('[history] 删除项目文件失败：', e)
                        }
                      }
                      removeRecentProject(proj.path)
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
