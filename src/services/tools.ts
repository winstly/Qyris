/**
 * 工具执行器：把模型的 function call 落到桌面后端命令上，
 * 并联动左侧文件树 / 编辑器刷新。
 */
import { api } from './desktop'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { useBuildStore } from '@/store/useBuildStore'
import { useChatStore } from '@/store/useChatStore'
import type { SlotState } from '@/store/useBuildStore'
import { joinPath } from '@/utils/path'

const READ_TRUNCATE = 30_000
const LIST_CAP = 500

const PHASE_LABEL: Record<string, string> = {
  idle: '未运行', building: '编译中', deploying: '部署中', running: '运行中', error: '异常',
}

export interface ToolOutcome {
  /** 回传给模型的内容（字符串，OpenAI tool role） */
  result: string
  /** 卡片上的一句话摘要 */
  summary: string
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const root = useAppStore.getState().projectPath
  if (!root) {
    return { result: '错误：当前没有打开的项目，请让用户先点击「打开项目」再进行文件操作。', summary: '未打开项目' }
  }

  try {
    switch (name) {
      case 'list_files': {
        const dir = typeof args.dir === 'string' && args.dir.trim() ? args.dir.trim() : '.'
        const nodes = await api.listDir(root, resolve(root, dir))
        if (nodes.length === 0) {
          return { result: `目录 ${dir} 为空（或只包含被忽略的目录，如 node_modules）。`, summary: `${dir} 为空` }
        }
        const lines = nodes
          .slice(0, LIST_CAP)
          .map((n) => `${n.kind === 'folder' ? '[目录]' : '[文件]'} ${n.name}`)
        const result = lines.join('\n') +
          (nodes.length > LIST_CAP ? `\n…（共 ${nodes.length} 项，已截断到前 ${LIST_CAP} 项）` : '')
        return { result, summary: `已列出 ${dir}（${nodes.length} 项）` }
      }

      case 'search_files': {
        const q = String(args.query ?? '').trim()
        if (!q) {
          return { result: '错误：query 不能为空。', summary: '关键字为空' }
        }
        const r = await api.searchFiles(root, q)
        if (r.files.length === 0) {
          return { result: `项目中没有文件名包含「${q}」的文件（node_modules 等目录已跳过）。`, summary: `无匹配「${q}」` }
        }
        const result = r.files.join('\n') +
          (r.truncated ? '\n…（已达 200 条上限，请用更具体的关键字缩小范围）' : '')
        return { result, summary: `找到 ${r.files.length} 个匹配「${q}」的文件` }
      }

      case 'read_file': {
        const display = String(args.path ?? '')
        const path = resolve(root, display)
        const fc = await api.readTextFile(root, path)
        if (fc.isBinary) {
          return { result: `错误：${display} 是二进制文件，无法按文本读取。`, summary: '二进制文件' }
        }
        const lineCount = fc.content.split('\n').length
        let content = fc.content
        if (content.length > READ_TRUNCATE) {
          content = content.slice(0, READ_TRUNCATE) + '\n…（内容过长，已截断）'
        }
        if (fc.truncated) content += '\n…（文件超过 2MB，仅返回前 2MB）'
        return { result: content, summary: `已读取 ${display}（${lineCount} 行）` }
      }

      case 'write_file': {
        const display = String(args.path ?? '')
        const path = resolve(root, display)
        const content = String(args.content ?? '')
        const sessionId = useChatStore.getState().sessionId
        // 写前快照：绑定当前会话，保留会话开始前的原始内容，可整会话回退
        await api.snapshotFile(root, sessionId, path).catch(() => {})
        await api.writeTextFile(root, path, content)
        // 联动刷新：文件树 + 打开的编辑器（未编辑状态下自动重载）
        await useFileStore.getState().notifyExternalChange([path])
        useFileStore.getState().addSnapshot(path, sessionId)
        return {
          result: `已写入 ${display}（${content.split('\n').length} 行），文件树与编辑器已刷新。`,
          summary: `已写入 ${display}`,
        }
      }

      case 'run_project': {
        const command = String(args.command ?? '').trim()
        const name = String(args.name ?? '').trim() || 'default'
        if (!command) {
          return { result: '错误：command 不能为空。', summary: '命令为空' }
        }
        // 每个服务名独立成槽：同名重启只替换该槽，不影响其他已运行的服务
        await useBuildStore.getState().start(name, command)
        return {
          result: `已启动服务「${name}」：${command}。输出实时流入预览面板，稍等片刻后用 get_build_status 查看「${name}」的编译/启动状态（首次编译可能需要几秒到几十秒）。`,
          summary: `已启动 ${name}`,
        }
      }

      case 'get_build_status': {
        const s = useBuildStore.getState()
        const nameArg = String(args.name ?? '').trim()
        // 指定服务名 → 单个服务的三阶段详情 + 日志尾部
        if (nameArg) {
          const key = nameArg.toLowerCase()
          const st = s.slots[key]
          if (!st) {
            const known = s.slotOrder.join('、') || '（无）'
            return { result: `错误：服务「${nameArg}」不存在。当前服务：${known}`, summary: `未知服务 ${nameArg}` }
          }
          return { result: formatSlotDetail(st), summary: `${key}：${PHASE_LABEL[st.phase] ?? st.phase}` }
        }
        // 不指定 → 全部服务的总览（每槽一行）
        if (s.slotOrder.length === 0) {
          return { result: '当前没有任何服务启动记录。', summary: '无服务' }
        }
        const lines = s.slotOrder.map((k) => {
          const st = s.slots[k]
          const url = st.detectedUrl ?? '（未解析）'
          const exit = st.lastExitCode !== null ? ` · exit ${st.lastExitCode}` : ''
          return `- ${k}：${PHASE_LABEL[st.phase] ?? st.phase} · 命令 ${st.command || '（未知）'} · 地址 ${url}${exit}${st.detectedUrls.length > 1 ? `（共 ${st.detectedUrls.length} 个地址）` : ''}`
        })
        const result = `共 ${s.slotOrder.length} 个服务：\n${lines.join('\n')}\n（用 get_build_status 传 name 查看单个服务的三阶段状态与日志尾部）`
        return { result, summary: `${s.slotOrder.length} 个服务` }
      }

      case 'stop_project': {
        const nameArg = String(args.name ?? '').trim()
        if (nameArg) {
          await useBuildStore.getState().stop(nameArg)
          return { result: `已停止服务「${nameArg}」。`, summary: `已停止 ${nameArg}` }
        }
        await useBuildStore.getState().stopAll()
        return { result: '已停止全部服务进程。', summary: '已停止全部进程' }
      }

      case 'load_skill': {
        const skillId = String(args.skill_id ?? '').trim()
        if (!skillId) {
          return { result: '错误：skill_id 不能为空。', summary: 'skill_id 为空' }
        }
        const { skillsDir } = useAppStore.getState()
        if (!skillsDir) {
          return { result: '错误：未配置 Skills 目录。请在设置 → 系统设置中配置。', summary: '未配置 Skills 目录' }
        }
        const content = await api.readSkill(skillsDir, skillId)
        if (content === null) {
          const known = useAppStore.getState().skillMetas.map((m) => m.id).join('、') || '（无）'
          return { result: `错误：Skill「${skillId}」不存在或无法读取。可用 Skills：${known}`, summary: `Skill 不存在：${skillId}` }
        }
        return { result: content, summary: `已加载 Skill：${skillId}` }
      }

      default:
        return { result: `错误：未知工具 ${name}。可用工具：list_files / search_files / read_file / write_file / run_project / get_build_status / stop_project / askUserQuestion / load_skill。`, summary: `未知工具 ${name}` }
    }
  } catch (e) {
    return { result: `工具执行失败：${String(e)}`, summary: '执行失败' }
  }
}

/** 单个服务槽的三阶段（编译/部署/运行）拆分汇报 + 日志尾部 */
function formatSlotDetail(st: SlotState): string {
  let build: string, deploy: string, run: string
  switch (st.phase) {
    case 'building':
      build = '进行中'; deploy = '未开始'; run = '未开始'
      break
    case 'deploying':
      build = '已完成'; deploy = '进行中'; run = '未开始'
      break
    case 'running':
      build = '已完成'; deploy = '已完成'
      run = st.detectedUrl ? `运行中（${st.detectedUrl}）` : '运行中（尚未解析到服务地址）'
      break
    case 'error':
      build = '异常'; deploy = '未开始'; run = '未开始'
      break
    default:
      build = '未开始'; deploy = '未开始'; run = '未开始'
  }
  const lines = [
    `服务：${st.name}`,
    `编译阶段：${build}`,
    `部署阶段：${deploy}`,
    `运行阶段：${run}`,
    st.detectedUrls.length > 0
      ? `服务地址（${st.detectedUrls.length} 个）：\n${st.detectedUrls.map((u) => `- ${u}`).join('\n')}`
      : '',
    `命令：${st.command || '（未设置）'}`,
    st.lastExitCode !== null ? `上次退出码：${st.lastExitCode}` : (st.processAlive ? '进程存活中' : '进程未启动'),
    st.phase === 'error' ? `错误信息：${st.errorText || '（无）'}` : '',
  ].filter(Boolean)
  const tail = st.logs.slice(-30)
    .map((l) => `${l.stream === 'stderr' ? '[err]' : '[out]'} ${l.line}`)
    .join('\n')
  return lines.join('\n') + (tail ? `\n最近输出（尾部 ${tail.split('\n').length} 行）：\n${tail}` : '\n（暂无进程输出）')
}

/** 相对路径 → 项目内绝对路径；绝对路径原样返回（后端仍有越界校验兜底） */
function resolve(root: string, p: string): string {
  if (!p) return root
  if (/^([a-zA-Z]:[\\/]|\/)/.test(p)) return p
  return joinPath(root, p)
}