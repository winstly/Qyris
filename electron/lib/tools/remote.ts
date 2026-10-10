/**
 * 远程部署工具：remote_exec（远端执行）+ remote_upload（SFTP 上传）。
 *
 * 禁止用 run_command 跑 ssh/scp（无 TTY、stdin 已关，密码提示会挂到超时）；SSH 认证
 * 统一收进主进程（ssh.ts 连接 + secrets.ts 凭据），AI 只见 serverName/host，拿不到密码；
 * 危险命令沿用 ssh.ts 的模式表在工具层硬拦截。
 */
import { getConfig, mergeConfig, type DeployServer } from '../config'
import { ensureInside } from '../pathsafety'
import { checkDangerousCommand, execCommand, uploadFile } from '../ssh'
import { isTransientError, withRetry } from '../retry'
import type { Tool } from '../model/types'

const DEFAULT_TIMEOUT_MS = 60_000
const MIN_TIMEOUT_MS = 1_000
/** 与 run_command 同上限：底层无进程树可杀，断连即收口，不会比会话活得更久 */
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 40_000
const OUTPUT_TRUNCATION_MARK = '\n…（输出过长，已截断）'

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('工具入参必须是 JSON 对象')
  }
  return input as Record<string, unknown>
}

function text(rec: Record<string, unknown>, key: string): string {
  const v = rec[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v
}

function optInt(rec: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = rec[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须是数字`)
  const n = Math.trunc(v)
  if (n < min || n > max) throw new Error(`参数 ${key} 需在 ${min}~${max} 之间`)
  return n
}

/**
 * 服务器四级解析：名称 → id → host（含大小写不敏感）→ 唯一兜底。
 * 模型只见过名称/host（部署上下文注入的就是这两样），凭据永不入参。
 */
export async function resolveServer(query: string | undefined): Promise<DeployServer> {
  const servers = (await getConfig()).deployServers ?? []
  if (servers.length === 0) {
    throw new Error('发布 tab 尚未配置服务器：请先在「发布」页添加服务器并保存凭据')
  }
  const q = (query ?? '').trim()
  const listServers = (): string => servers.map((s) => `${s.name}(${s.host})`).join('、')
  if (q) {
    const hit =
      servers.find((s) => s.name === q) ??
      servers.find((s) => s.id === q) ??
      servers.find((s) => s.host === q) ??
      servers.find((s) => `${s.username}@${s.host}` === q) ??
      servers.find((s) => s.name.toLowerCase() === q.toLowerCase()) ??
      servers.find((s) => s.host.toLowerCase() === q.toLowerCase())
    if (hit) return hit
    // 当 host 兜底：唯一服务器时指名错误也放行（模型常把 host 当名称传）
    if (servers.length === 1) return servers[0]
    throw new Error(`无法定位服务器「${q}」。可用：${listServers()}`)
  }
  // 唯一兜底：只配了一台就不逼模型猜名字
  if (servers.length === 1) return servers[0]
  throw new Error(`serverName 未提供且服务器多于一台，请指明。可用：${listServers()}`)
}

/** remotePath 词法校验：远端无法 realpath，绝对路径 + 拒绝 `..` 段是仅有的防线 */
function validateRemotePath(p: string): string {
  const t = p.trim()
  if (!t.startsWith('/')) throw new Error('remotePath 必须是远端绝对路径（以 / 开头）')
  if (t.split('/').includes('..')) throw new Error(`remotePath 不得包含「..」路径段：${t}`)
  return t.replace(/\/+$/, '') || '/'
}

/** 应用服务器信息补丁（纯函数，smoke 直测）：按 id 命中替换，未命中原样返回 */
export function applyServerPatch(
  servers: DeployServer[],
  id: string,
  patch: { tags: string[]; strategy?: DeployServer['strategy']; note?: string },
): DeployServer[] {
  return servers.map((s) =>
    s.id === id
      ? {
          ...s,
          tags: patch.tags,
          ...(patch.strategy ? { strategy: patch.strategy } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
        }
      : s,
  )
}

const remoteExec: Tool = {
  name: 'remote_exec',
  description:
    '在已配置的远程服务器上执行一条命令（发布 tab 服务器清单，SSH 认证由工作台代行），返回退出码与输出。' +
    'serverName 填服务器名称或 host；未提供且只配置了一台时自动使用它。' +
    '⚠️ 不要向用户索取服务器密码——凭据在工作台内，模型不可见。' +
    '危险命令（rm -rf /、mkfs、shutdown、drop database 等）会被直接拦截。' +
    '⚠️ 无 TTY 非交互执行：需要交互确认的安装向导请改用非交互参数。timeoutMs 默认 60000（1s~600000），到点断连收口。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要在远端执行的命令行' },
      serverName: { type: 'string', description: '服务器名称或 host（发布 tab 配置项）；仅一台服务器时可省略' },
      timeoutMs: { type: 'integer', description: '超时毫秒，默认 60000，上限 600000', minimum: 1, maximum: 600000 },
    },
    required: ['command'],
  },
  permission: 'exec',
  async execute(input, ctx) {
    const rec = asRecord(input)
    const command = text(rec, 'command')
    const server = await resolveServer(typeof rec.serverName === 'string' ? rec.serverName : undefined)
    const timeoutMs = optInt(rec, 'timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS

    // 危险命令闸：AI 工具通道没有「用户勾选放行」的 UI 流程，命中即硬拒
    const danger = checkDangerousCommand(command)
    if (danger) {
      return {
        content: `[remote_exec] 已拦截（${server.name}）：${danger}\n如确需执行，请让用户在发布 tab 手动操作。`,
        isError: true,
      }
    }

    if (ctx.signal?.aborted) throw new Error('命令已被取消')

    const token = `tool-remote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    let timedOut = false
    let aborted = false

    // 每次 attempt 各持 handle/timer/listener 并在 settle 时统一回收：
    // 共享 handle 会让上一轮的遗留 timer 把 cancel 打到本轮连接上（误杀重试）；
    // 超时/取消后若对端不回 close，onExit 不会来——必须直接收口，否则工具调用永久挂起。
    // started = exec 通道已打开（命令在服务端已开始执行）：此时任何中断都禁止重发
    const attempt = (): Promise<{ code: number | null; output: string; firstErr: string; started: boolean }> =>
      new Promise((resolve) => {
        let output = ''
        let firstErr = ''
        let started = false
        let settled = false
        let timer: NodeJS.Timeout | null = null
        let onAbort: (() => void) | null = null
        const settle = (r: { code: number | null; output: string; firstErr: string }): void => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          if (onAbort) ctx.signal?.removeEventListener('abort', onAbort)
          resolve({ ...r, started })
        }
        const handle = execCommand(server, command, {
          runId: token,
          onStart: () => { started = true },
          onLine: (stream, line) => {
            if (stream === 'stderr' && !firstErr) firstErr = line
            if (output.length < MAX_OUTPUT_CHARS + OUTPUT_TRUNCATION_MARK.length) {
              output += (output ? '\n' : '') + line
            }
            ctx.onOutput?.(line, stream)
          },
          onExit: (code) => settle({ code, output, firstErr }),
        })
        timer = setTimeout(() => {
          timedOut = true
          handle.cancel()
          settle({ code: null, output, firstErr })
        }, timeoutMs)
        onAbort = () => {
          aborted = true
          handle.cancel()
          settle({ code: null, output, firstErr })
        }
        ctx.signal?.addEventListener('abort', onAbort, { once: true })
      })

    let r = await attempt()
    // 重试分级：仅「连接建立失败（命令从未执行，!started）+ 暂态错误」重试一次。
    // started 后的任何中断（含通道无退出码关闭 code=null）一律不重发：
    // 非幂等命令重发 = 在服务端双倍破坏
    if (!r.started && r.code === null && !aborted && !timedOut && isTransientError(r.firstErr)) {
      r = await attempt()
    }

    const stopReason = aborted ? '已取消' : timedOut ? `超时（>${timeoutMs}ms，连接已断开）` : null
    // isError 语义对齐 run_command：只有「没正常跑完」（超时/取消/连接失败）为 true，
    // 非 0 退出码是远端命令的合法结果，原样回喂模型自纠
    const connectFail = r.code === null && stopReason === null
    if (r.output.length > MAX_OUTPUT_CHARS) r.output = r.output.slice(0, MAX_OUTPUT_CHARS) + OUTPUT_TRUNCATION_MARK
    const header = connectFail
      ? `[remote_exec] ${server.name} 连接/执行失败${r.firstErr ? `：${r.firstErr}` : ''}`
      : `[remote_exec] ${server.name}$ ${command}\nexit: ${stopReason ?? (r.code === 0 ? '0' : `${r.code}（非 0）`)}`
    return {
      content: `${header}\n---\n${r.output || '（无输出）'}`,
      isError: stopReason !== null || connectFail,
    }
  },
}

const remoteUpload: Tool = {
  name: 'remote_upload',
  description:
    '把工程内的一个文件经 SFTP 上传到已配置的远程服务器（发布 tab 服务器清单，认证由工作台代行）。' +
    'localPath 相对工程根（越出工程根会被拒绝）；remotePath 是远端绝对路径（以 / 开头，不得含「..」段）。' +
    'serverName 语义同 remote_exec。需要先建目录时请先用 remote_exec 执行 mkdir -p。',
  inputSchema: {
    type: 'object',
    properties: {
      localPath: { type: 'string', description: '本地文件路径（相对工程根）' },
      remotePath: { type: 'string', description: '远端目标文件绝对路径（以 / 开头）' },
      serverName: { type: 'string', description: '服务器名称或 host；仅一台服务器时可省略' },
    },
    required: ['localPath', 'remotePath'],
  },
  permission: 'exec',
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot
    if (!projectRoot) throw new Error('当前未打开工程，remote_upload 不可用')
    const rec = asRecord(input)
    const localPath = text(rec, 'localPath')
    const remotePath = validateRemotePath(text(rec, 'remotePath'))
    const server = await resolveServer(typeof rec.serverName === 'string' ? rec.serverName : undefined)

    // 本地侧越界防护：与 fs 工具同一道闸（pathsafety 按路径组件逐段比较）
    const localAbs = await ensureInside(projectRoot, localPath)
    // fastPut 是整文件覆盖写（幂等），网络暂态可安全重试；超时/中止经 uploadFile 的兜底收口
    await withRetry(
      () => uploadFile(server, localAbs, remotePath, { timeoutMs: MAX_TIMEOUT_MS, signal: ctx.signal }),
      { label: 'remote_upload', retries: 2, signal: ctx.signal },
    )
    return { content: `[remote_upload] ${localPath} → ${server.name}:${remotePath} 已上传` }
  },
}

const updateServerTags: Tool = {
  name: 'update_server_tags',
  description:
    '更新发布 tab 服务器的已部署服务标签、部署策略与备注。部署完成后用它登记实际结果（驱动卡片展示与后续部署上下文），' +
    '不要只在回复文本里描述标签。serverName 语义同 remote_exec。',
  inputSchema: {
    type: 'object',
    properties: {
      serverName: { type: 'string', description: '服务器名称或 host；仅一台服务器时可省略' },
      tags: { type: 'array', items: { type: 'string' }, description: '已部署服务标签列表（nginx / nacos / app-server…）；空数组 = 清空' },
      strategy: { type: 'string', description: '部署策略（可选）', enum: ['single', 'microservice', 'cluster'] },
      note: { type: 'string', description: '备注（可选，200 字内）' },
    },
    required: ['tags'],
  },
  permission: 'write',
  async execute(input) {
    const rec = asRecord(input)
    const server = await resolveServer(typeof rec.serverName === 'string' ? rec.serverName : undefined)
    if (!Array.isArray(rec.tags)) throw new Error('参数 tags 必须是字符串数组')
    const tags = [...new Set(rec.tags.map((t) => String(t).trim()).filter(Boolean))]
    if (tags.length > 20) throw new Error('标签最多 20 个')
    if (tags.some((t) => t.length > 40)) throw new Error('单个标签不超过 40 字符')
    let strategy: DeployServer['strategy'] | undefined
    if (rec.strategy !== undefined && rec.strategy !== null) {
      if (rec.strategy !== 'single' && rec.strategy !== 'microservice' && rec.strategy !== 'cluster') {
        throw new Error('strategy 必须是 single / microservice / cluster')
      }
      strategy = rec.strategy
    }
    const note = typeof rec.note === 'string' ? rec.note.slice(0, 200) : undefined
    const cfg = await getConfig()
    const next = applyServerPatch(cfg.deployServers ?? [], server.id, { tags, ...(strategy ? { strategy } : {}), ...(note !== undefined ? { note } : {}) })
    await mergeConfig({ deployServers: next })
    return {
      content:
        `[update_server_tags] ${server.name}（${server.host}）已更新：标签 [${tags.join(', ') || '（清空）'}]` +
        `${strategy ? ` · 策略 ${strategy}` : ''}${note !== undefined ? ' · 备注已更新' : ''}。发布页卡片即时生效。`,
    }
  },
}

/** 远程部署工具集 */
export const remoteTools: Tool[] = [remoteExec, remoteUpload, updateServerTags]
