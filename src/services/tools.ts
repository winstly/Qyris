/**
 * 工具执行器：把模型的 function call 落到桌面后端命令上，
 * 并联动左侧文件树 / 编辑器刷新。
 */
import { api } from './desktop'
import { useAppStore } from '@/store/useAppStore'
import { useFileStore } from '@/store/useFileStore'
import { useBuildStore } from '@/store/useBuildStore'
import { useChatStore } from '@/store/useChatStore'
import { useAgentStore } from '@/store/useAgentStore'
import type { SlotState } from '@/store/useBuildStore'
import type { SubTask } from './subagent'
import { joinPath } from '@/utils/path'
import { uid } from '@/utils/id'

const READ_TRUNCATE = 30_000
const LIST_CAP = 500
const RUN_ONCE_TAIL_CHARS = 4000

const PHASE_LABEL: Record<string, string> = {
  idle: '未运行', building: '编译中', deploying: '部署中', running: '运行中', error: '异常',
}

export interface ToolOutcome {
  /** 回传给模型的内容（字符串，OpenAI tool role） */
  result: string
  /** 卡片上的一句话摘要 */
  summary: string
}

/** AI 启动的服务命令沉淀：upsert 进当前项目存档（「全部运行」按钮直接复用，零模型） */
function persistStartCommand(name: string, command: string): void {
  const app = useAppStore.getState()
  if (!app.projectPath) return
  const cur = app.startupCommands
  const next = cur.some((c) => c.name === name)
    ? cur.map((c) => (c.name === name ? { ...c, run: command } : c))
    : [...cur, { name, run: command }]
  void app.setStartupCommands(next)
}

export async function executeTool(name: string, args: Record<string, unknown>, cardId = ''): Promise<ToolOutcome> {
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

      case 'run_once': {
        const command = String(args.command ?? '').trim()
        if (!command) {
          return { result: '错误：command 不能为空。', summary: '命令为空' }
        }
        // cancelToken：无卡片 id 时（子 agent 路径）现配一个，保证在途进程可被「停止生成」硬中断
        const out = await api.runOnce(root, command, cardId || uid())
        const ok = out.code === 0
        const tail = (out.output || '（无输出）').slice(0, RUN_ONCE_TAIL_CHARS)
        return {
          result: ok
            ? `命令执行成功（exit 0）。输出（尾部）：\n${tail}`
            : `命令执行失败（exit ${out.code ?? -1}）。输出（尾部）：\n${tail}`,
          summary: ok ? `已执行 ${command}` : `失败（exit ${out.code}）`,
        }
      }

      case 'report_start_commands': {
        const arr = Array.isArray(args.services) ? args.services : []
        const services = (arr as Record<string, unknown>[])
          .map((s) => ({ name: String(s?.name ?? '').trim(), run: String(s?.run ?? '').trim() }))
          .filter((s) => s.name && s.run)
        if (services.length === 0) {
          return { result: '错误：services 不能为空，每项需包含 name（服务名）与 run（启动命令）。', summary: '启动清单为空' }
        }
        await useAppStore.getState().setStartupCommands(services)
        const list = services.map((s) => `- ${s.name}：${s.run}`).join('\n')
        return {
          result: `已保存 ${services.length} 个服务的启动命令：\n${list}\n用户可在预览面板点击「全部运行」直接启动（无需再次识别）。`,
          summary: `已保存 ${services.length} 条启动命令`,
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
        // 启动命令沉淀进存档（fire-and-forget）：AI 直接启动的服务也会被「全部运行」按钮记住
        persistStartCommand(name, command)
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

      case 'verify_start': {
        const command = String(args.command ?? '').trim()
        const name = String(args.name ?? '').trim() || 'default'
        if (!command) {
          return { result: '错误：command 不能为空。', summary: '命令为空' }
        }
        const existing = useBuildStore.getState().slots[name.toLowerCase()]
        if (existing?.processAlive) {
          return {
            result: `错误：服务「${name}」已在运行中，无法重复验证。请先 stop_project 停止该服务再验证。`,
            summary: `${name} 运行中`,
          }
        }
        const outcome = await verifyStartup(name, command)
        persistStartCommand(name, command)
        return outcome
      }

      case 'dispatch_subtasks': {
        const arr = Array.isArray(args.tasks) ? args.tasks : []
        const TIERS: readonly string[] = ['main', 'thinking', 'fast', 'middle', 'heavy']
        const tasks: SubTask[] = (arr as Record<string, unknown>[])
          .map((t) => ({
            title: String(t?.title ?? '').trim(),
            instruction: String(t?.instruction ?? '').trim(),
            tier: String(t?.tier ?? 'main').trim(),
          }))
          .filter((t) => t.title && t.instruction)
          .map((t) => ({
            ...t,
            // 未知档位字符串回退 main（modelForTier 亦有兜底）
            tier: (TIERS.includes(t.tier) ? t.tier : 'main') as SubTask['tier'],
          }))
        if (tasks.length === 0) {
          return { result: '错误：tasks 不能为空，每项需包含 title（标题）与 instruction（完整指令）。', summary: '子任务清单为空' }
        }
        // 动态 import：subagent 依赖本模块的 executeTool，避免静态循环依赖
        const sub = await import('./subagent')
        // 先建线程批次（卡片面板立即出现 pending 列表），再并行执行
        const threadIds = useAgentStore.getState().createBatch(
          cardId,
          tasks.map((t) => ({ title: t.title, tier: t.tier ?? 'main', model: sub.modelForTier(t.tier) })),
        )
        const { results, total } = await sub.runSubtasks(tasks, threadIds)
        // 子 agent 独立记账的 token 总账，汇总进主对话用量展示
        useChatStore.setState((s) => ({
          usage: {
            ...s.usage,
            agents: {
              input: (s.usage.agents?.input ?? 0) + total.input,
              output: (s.usage.agents?.output ?? 0) + total.output,
            },
          },
        }))
        // 结果经 agent state 传递：主上下文只收摘要（单条截断），全文留在各 agent 线程可查
        const RESULT_CAP = 1500
        const body = results
          .map((r, i) => {
            const text = r.text.length > RESULT_CAP
              ? r.text.slice(0, RESULT_CAP) + '\n…（已截断，全文见对应 agent 视图）'
              : r.text
            return `## 子任务 ${i + 1}：${r.title} [${r.status === 'done' ? '完成' : r.status === 'cancelled' ? '已取消' : '异常'}]（模型：${r.model}）\n${text}`
          })
          .join('\n\n')
        const result = `共 ${results.length} 个子任务已并行执行（完整过程与结果全文存于各 agent 线程，可在对话面板切换查看）。结果摘要：\n\n${body}`
        return { result, summary: `已执行 ${results.length} 个子任务` }
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
        return { result: `错误：未知工具 ${name}。可用工具：list_files / search_files / read_file / write_file / run_once / report_start_commands / run_project / verify_start / get_build_status / stop_project / dispatch_subtasks / askUserQuestion / load_skill。`, summary: `未知工具 ${name}` }
    }
  } catch (e) {
    return { result: `工具执行失败：${String(e)}`, summary: '执行失败' }
  }
}

// ---------- 启动验证（构建通过后的「能启动」确认） ----------

const VERIFY_TIMEOUT = 90_000
const VERIFY_POLL = 500
const VERIFY_PROBE_INTERVAL = 2000

/** 启动冒烟验证：启动服务 → 轮询状态（异常退出即失败）→ 解析到地址后 HTTP 探测确认 → 自动停止。
 *  无 HTTP 地址但出现监听信号的服务（如 Java 后端）按启动信号判通过（无法探测是客观限制，如实标注）。 */
async function verifyStartup(name: string, command: string): Promise<ToolOutcome> {
  const key = name.trim().toLowerCase() || 'default'
  await useBuildStore.getState().start(name, command)
  const deadline = Date.now() + VERIFY_TIMEOUT
  let tail: string[] = []
  let lastProbeAt = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, VERIFY_POLL))
    if (useChatStore.getState().cancelled) {
      await useBuildStore.getState().stop(name)
      return { result: '启动验证已取消（用户停止生成），验证进程已停止。', summary: '验证取消' }
    }
    const st = useBuildStore.getState().slots[key]
    if (!st) break
    tail = st.logs.slice(-15).map((l) => `${l.stream === 'stderr' ? '[err]' : '[out]'} ${l.line}`)
    if (st.phase === 'error') {
      await useBuildStore.getState().stop(name)
      return {
        result: `启动验证失败：进程异常退出（编译通过但启动失败，常见原因：端口被占用、配置缺失、依赖不完整）。\n错误输出：\n${st.errorText || tail.join('\n')}`,
        summary: `${key} 启动失败`,
      }
    }
    if (st.phase === 'running') {
      if (st.detectedUrl) {
        // 输出正则只是第一道信号：HTTP 探测确认真正可服务（限频，避免轮询打爆服务）
        if (Date.now() - lastProbeAt >= VERIFY_PROBE_INTERVAL) {
          lastProbeAt = Date.now()
          const ok = await api.checkUrl(st.detectedUrl).catch(() => false)
          if (ok) {
            await useBuildStore.getState().stop(name)
            return {
              result: `启动验证通过：服务已监听 ${st.detectedUrl}，HTTP 探测成功。验证进程已自动停止，服务命令已沉淀，用户可在预览面板一键启动。`,
              summary: `${key} 启动验证通过`,
            }
          }
        }
      } else {
        // 无可探测地址但有监听信号：按信号判通过，如实标注探测限制
        await useBuildStore.getState().stop(name)
        return {
          result: `启动验证通过（按输出中的启动信号判定）：服务已进入运行阶段但未解析到 HTTP 地址，未能做探测确认。验证进程已自动停止。`,
          summary: `${key} 启动验证通过`,
        }
      }
    }
  }
  await useBuildStore.getState().stop(name)
  return {
    result: `启动验证失败：${VERIFY_TIMEOUT / 1000}s 内未确认服务可用（未解析到可探测的服务地址，或 HTTP 探测始终失败）。\n最近输出：\n${tail.join('\n') || '（无输出）'}`,
    summary: `${key} 启动验证失败`,
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