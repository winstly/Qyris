/**
 * 本地 embedding（transformers.js / onnxruntime WASM，BGE-small-zh，q8 量化，512 维）。
 * 九步配方（已在探针逐条验证，改动前先跑 smoke + 探针）：
 *  ① require('module')._load 屏蔽 onnxruntime-node —— 其原生绑定在本环境 DLL 初始化必炸，
 *     属环境问题而非代码问题，返回空模块让 transformers.js 走 WASM 后端；
 *  ② require transformers 前向 globalThis[Symbol.for('onnxruntime')] 注入 onnxruntime-web
 *     （官方逃生门：强制 WASM 后端，不注入且原生不可用会直接崩）；
 *  ③ env.useWasmCache = false；
 *  ④ env.backends.onnx.wasm.wasmPaths 指向 onnxruntime-web 的 dist 目录 —— Node 动态 import
 *     只认 URL，Windows 裸路径报 ERR_UNSUPPORTED_ESM_URL_SCHEME，必须转 file:/// URL；
 *  ⑤ wasm.numThreads = 1（沙箱环境无多线程支持）；
 *  ⑥ pipeline('feature-extraction', 模型, { dtype:'q8', device:'auto' })，推理时
 *     { pooling:'cls', normalize:true }，输出 512 维；
 *  ⑦ env.remoteHost 指向国内镜像（默认 hf-mirror.com，config.embedRemoteHost 可覆盖）；
 *  ⑧ env.cacheDir 落 <dataDir>/models（模型缓存进数据目录，随迁移走）；
 *  ⑨ 任何加载/推理失败 → 模块置 degraded，返回空结果，检索层降级 FTS-only，绝不抛进对话主链路。
 * 懒初始化：首次 embedTexts 才加载 pipeline；同批重复文本去重共享结果（paid for once 纪律）。
 */
import path from 'node:path'
import { getConfig } from '../config'
import { dataDir } from '../db'

/** 缺省模型（config.embedModel 可覆盖） */
export const DEFAULT_EMBED_MODEL = 'Xenova/bge-small-zh-v1.5'
/** 缺省下载镜像（config.embedRemoteHost 可覆盖） */
export const DEFAULT_EMBED_REMOTE_HOST = 'https://hf-mirror.com'
/** bge-small 输出维度（与 db.ts SCHEMA_VEC 的 FLOAT[512] 对齐，改模型需全量重嵌） */
export const EMBED_DIM = 512

/** 特征提取 pipeline 的最小类型面（transformers.js 实际导出远多于此） */
type Extractor = (
  texts: string[],
  opts: { pooling: 'cls'; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array }>

type EmbedState = 'idle' | 'loading' | 'ready' | 'degraded'

let state: EmbedState = 'idle'
/** 单飞 promise：并发首调只加载一次 pipeline */
let loading: Promise<Extractor> | null = null

/** 测试钩子：强制覆盖就绪状态（smoke 需要在无模型环境下激活向量路）；置 null 恢复真实状态 */
let readyOverride: boolean | null = null
export function setReadyOverride(v: boolean | null): void { readyOverride = v }

/** 是否就绪（pipeline 已成功加载）；检索层只在 ready 时走向量路 */
export function embedReady(): boolean {
  return readyOverride ?? (state === 'ready')
}

/** 是否已进入降级态（加载/推理失败后快速失败，不反复重试下载） */
export function isDegraded(): boolean {
  return state === 'degraded'
}

/** 预热（fire-and-forget）：主进程启动后可调用，让首次检索免模型加载延迟；失败静默降级 */
export async function warmupEmbed(): Promise<boolean> {
  try {
    await loadExtractor()
    return embedReady()
  } catch {
    return false
  }
}

/** 全局嵌入串行队列：单主进程内多工程检索/写入会并发触发 embedTexts，而底层是同一个
 *  WASM pipeline（单飞加载保证唯一）——并发调用在这里排队串行，避免可重入与重复推理。 */
let embedChain: Promise<unknown> = Promise.resolve()

/** 批量嵌入：空输入回空数组；重复文本去重共享；降级态快速失败回 []（调用方按不可用处理）。
 *  并发调用经全局队列串行执行（结果语义与单次调用一致，仅顺序化）。 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const run = embedChain.then(() => embedTextsInner(texts))
  // 链上吞掉拒绝防断链：inner 自身已把失败折算为 []，此处兜底不改变返回值
  embedChain = run.catch(() => {})
  return run
}

async function embedTextsInner(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  if (state === 'degraded') return []
  let extractor: Extractor
  try {
    extractor = await loadExtractor()
  } catch (e) {
    degrade(`模型加载失败：${String(e)}`)
    return []
  }
  try {
    // 去重：同文本只算一次，结果按下标共享
    const unique: string[] = []
    const indexOf = new Map<string, number>()
    for (const t of texts) {
      let i = indexOf.get(t)
      if (i === undefined) {
        i = unique.push(t) - 1
        indexOf.set(t, i)
      }
    }
    const output = await extractor(unique, { pooling: 'cls', normalize: true })
    if (output.dims.length !== 2) throw new Error(`异常输出维度：[${output.dims.join(',')}]`)
    const [rows, dim] = output.dims
    if (rows !== unique.length || dim !== EMBED_DIM) throw new Error(`维度不匹配：期望 ${unique.length}x${EMBED_DIM}，实得 ${output.dims.join('x')}`)
    // 同文本共享同一份结果引用（paid for once：算一次、处处复用，不做逐份拷贝）
    const uniqueVecs = unique.map((_, r) => output.data.slice(r * EMBED_DIM, (r + 1) * EMBED_DIM))
    return texts.map((t) => uniqueVecs[indexOf.get(t) as number])
  } catch (e) {
    degrade(`推理失败：${String(e)}`)
    return []
  }
}

function degrade(reason: string): void {
  state = 'degraded'
  console.warn(`[embed] 降级 FTS-only：${reason}`)
}

/** 懒加载 pipeline（单飞）。①② 的 shim/注入必须发生在首次 require transformers 之前 */
function loadExtractor(): Promise<Extractor> {
  if (state === 'ready' && pipeline) return Promise.resolve(pipeline)
  if (loading) return loading
  state = 'loading'
  loading = (async () => {
    // ① 屏蔽 onnxruntime-node 的原生绑定（require('module')._load 劫持）
    const mod = require('module') as { _load: (request: string, ...rest: unknown[]) => unknown }
    const orig = mod._load
    mod._load = function (this: unknown, request: string, ...rest: unknown[]) {
      if (request === 'onnxruntime-node') return {}
      return orig.call(this, request, ...rest)
    }
    // ② 强制 WASM 后端的官方逃生门（必须在首次 require transformers 之前注入）
    const ort = require('onnxruntime-web')
    ;(globalThis as Record<symbol, unknown>)[Symbol.for('onnxruntime')] = ort
    const transformers = require('@huggingface/transformers') as {
      env: OrtEnv
      pipeline: (task: string, model: string, opts: { dtype: 'q8'; device: 'auto' }) => Promise<Extractor>
    }
    // useWasmCache/remoteHost/cacheDir/backends.onnx.* 都是 transformers.js 的 env
    //（它把 onnxruntime 的开关挂在 env.backends.onnx 下），不是 ort 顶层的 env
    const { env } = transformers
    // ③⑤ WASM 运行时开关
    env.useWasmCache = false
    env.backends.onnx.wasm.numThreads = 1
    // ④ wasm 二进制定位：Node 动态 import 只认 URL（exports 封了 package.json，
    //    需从主入口反推 dist 目录，再转 file:/// URL）
    env.backends.onnx.wasm.wasmPaths = toFileUrl(ortDistDir())
    const cfg = await getConfig()
    // ⑦ 国内镜像（config 可覆盖）
    env.remoteHost = cfg.embedRemoteHost || DEFAULT_EMBED_REMOTE_HOST
    // ⑧ 模型缓存落数据目录
    env.cacheDir = path.join(await dataDir(), 'models')
    // ⑥ q8 量化 + 自动设备
    const extractor = await transformers.pipeline('feature-extraction', cfg.embedModel || DEFAULT_EMBED_MODEL, {
      dtype: 'q8',
      device: 'auto',
    })
    pipeline = extractor
    state = 'ready'
    return extractor
  })()
  return loading
}

let pipeline: Extractor | null = null

interface OrtEnv {
  useWasmCache: boolean
  remoteHost: string
  cacheDir: string
  backends: { onnx: { wasm: { wasmPaths: string; numThreads: number } } }
}

/** dist 目录定位：exports 封死了 package.json 子路径，从 require.resolve 的主入口反推 */
function ortDistDir(): string {
  const entry = require.resolve('onnxruntime-web')
  const entryDir = path.dirname(entry)
  return path.basename(entryDir) === 'dist' ? entryDir : path.join(entryDir, 'dist')
}

/** Windows 裸路径直接塞给动态 import 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME，必须转 file:/// URL */
function toFileUrl(dir: string): string {
  return 'file:///' + dir.split(path.sep).join('/') + '/'
}
