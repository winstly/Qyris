/**
 * AI 编译公共流程：守卫（API Key / 目标工程忙）+ 覆盖确认 + 定向 send。
 * PreviewTab（当前工程 / AI 全部编译）与 ProjectsTab（工程行内单编译）共用。
 * 编译目标 = targetPath，经 useChatStore.send 定向通道发起，不切换当前工作区。
 */
import { useAppStore } from '@/store/useAppStore'
import { useStartupStore } from '@/store/useStartupStore'
import { useChatStore } from '@/store/useChatStore'
import { basename } from '@/utils/path'
import { toast } from '@/components/common/Toast'
import { isCliAgentMode } from '../../shared/ai-mode'

export type AiCompileResult = 'ok' | 'busy' | 'declined' | 'fail'

/** 对指定工程发起一轮 AI 编译（探测技术栈 → 装依赖/验证编译 → 提交启动命令）。
 *  interactive=false 供批量走：不弹逐工程确认/提示，守卫不过只返回结果不弹窗。
 *  send 会 await 整个 agent 轮次，resolve 即该工程编译结束。 */
export async function aiCompileProject(targetPath: string, interactive = true): Promise<AiCompileResult> {
  const app = useAppStore.getState()
  const cliMode = isCliAgentMode(app.settings.dispatchMode)
  if (!app.hasApiKey && !cliMode) {
    if (interactive) toast.info('尚未配置 API Key', '点击左侧栏底部的设置图标，配置 Base URL 与 API Key 后即可使用 AI 编译。')
    return 'declined'
  }
  const archived = useStartupStore.getState().startupCommandsMap[targetPath] ?? []
  if (interactive && archived.length > 0) {
    const ok = await app.showConfirm('AI 重新编译', '将重新调用 AI 识别启动命令，已识别的命令会被覆盖。继续？')
    if (ok !== true) return 'declined'
  }
  const slice = useChatStore.getState().byProject[targetPath]
  if (slice && slice.status !== 'idle' && slice.status !== 'error') {
    if (interactive) toast.info('AI 正忙', '该工程的上一条消息还在处理中，请稍候。')
    return 'busy'
  }
  const prompt = cliMode
    ? '这是 AI 编译阶段：请探测当前项目的技术栈，需要时安装依赖 / 验证编译，然后为每个需要长期运行的服务取一个简短英文服务名（各不重复），逐个验证启动命令能真正启动（验证通过即停止进程），全部通过后在回复最后一行用 [[START_COMMANDS: [{"name":"portal","run":"npm run dev","url":"http://localhost:5173"}]]] 格式提交。'
    : '这是 AI 编译阶段：请探测当前项目的技术栈，需要时用 run_once 安装依赖 / 验证编译，然后为每个需要长期运行的服务取一个简短英文服务名（各不重复），逐个用 verify_start 验证启动命令能真正启动，全部通过后用 report_start_commands 提交启动命令清单。'
  const sent = await useChatStore.getState().send(prompt, { projectStart: true }, targetPath)
  return sent ? 'ok' : 'fail'
}

/** AI 全部编译：串行编译所有已打开工程（互不并发，避免多 agent 会话互踩）。
 *  忙/失败的工程不中断后续，逐个完成后 Toast 汇报，收尾汇总跳过清单。 */
export async function aiCompileAllOpen(): Promise<void> {
  const targets = useAppStore.getState().openProjects
  if (targets.length === 0) return
  // 任一目标已有存档命令即整体确认一次（覆盖不可逆，批量不逐工程追问）
  if (targets.some((p) => (useStartupStore.getState().startupCommandsMap[p] ?? []).length > 0)) {
    const ok = await useAppStore.getState().showConfirm(
      'AI 全部编译',
      `将逐个对 ${targets.length} 个已打开工程调用 AI 识别启动命令，已识别的命令会被覆盖。继续？`,
    )
    if (ok !== true) return
  }
  const busy: string[] = []
  const failed: string[] = []
  const declined: string[] = []
  for (const p of targets) {
    const r = await aiCompileProject(p, false)
    if (r === 'ok') {
      const n = (useStartupStore.getState().startupCommandsMap[p] ?? []).length
      toast.ok(
        'AI 编译完成',
        n > 0 ? `「${basename(p)}」已识别 ${n} 个服务` : `「${basename(p)}」未识别到启动命令`,
      )
    } else if (r === 'busy') {
      busy.push(basename(p))
    } else if (r === 'fail') {
      failed.push(basename(p))
    } else {
      // declined：批量（interactive=false）下唯一来源是未配置 API Key——不汇报则整轮无声空转
      declined.push(basename(p))
    }
  }
  if (busy.length > 0) toast.info('部分工程已跳过', `会话进行中：${busy.join('、')}`)
  if (declined.length > 0) toast.info('部分工程未发起', `未配置 API Key：${declined.join('、')}`)
  if (failed.length > 0) toast.err('部分工程编译失败', `未能发送编译任务：${failed.join('、')}`)
}
