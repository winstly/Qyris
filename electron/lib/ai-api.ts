/**
 * AI Adapter · API 直连 —— 连接测试与 keychain 账户名。
 *
 * 对话补全的协议转换唯一真源在 model/providers/ 各家实现里（Message 归一也在那边），
 * 本模块只做连通性探活，不参与补全。Key 在主进程内解密直用，明文不经过渲染层。
 */
import { getSecretInternal } from './secrets'
import { errorMessage } from './util'

/** keychain 账户名（ai.ts 分发层做 Key 存在性检查时也用此常量，保持单一事实来源） */
export const SECRET_ACCOUNT = 'api_key'
const ANTHROPIC_VERSION = '2023-06-01'

type Json = Record<string, any>

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') // 剥尾斜杠即用，不拼任何路径
}

// ---------------- 连接测试 ----------------

export async function testApiConnection(provider: string, baseUrl: string, model: string): Promise<string> {
  const key = await getSecretInternal(SECRET_ACCOUNT)
  if (!key) throw new Error('尚未配置 API Key')

  const headers = provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
    : { Authorization: `Bearer ${key}` }

  // Anthropic：第三方兼容网关（阿里云/智谱）通常无 /v1/models，改测 /v1/messages 连通性
  if (provider === 'anthropic') {
    let response: Response
    try {
      response = await fetch(`${trimBaseUrl(baseUrl)}/v1/messages`, { method: 'GET', headers })
    } catch (e) {
      throw new Error(`连接失败：${errorMessage(e)}`)
    }
    if (response.status === 404) return '服务返回 404 —— /v1/messages 端点不存在，请检查 Base URL 路径'
    if (response.status === 401 || response.status === 403) return '服务可达，但返回 401/403 —— 请检查 API Key'
    return `连接成功（/v1/messages 端点可达，服务返回 ${response.status}）`
  }

  // OpenAI：验证 /models 模型列表
  let response: Response
  try {
    response = await fetch(`${trimBaseUrl(baseUrl)}/models`, { headers })
  } catch (e) {
    throw new Error(`连接失败：${errorMessage(e)}`)
  }
  if (response.status === 401 || response.status === 403) {
    return '服务可达，但返回 401/403 —— 请检查 API Key'
  }
  if (!response.ok) {
    return `服务返回 ${response.status}（连接成功，模型列表端点可能不可用，直接对话试试）`
  }
  let json: Json
  try {
    json = (await response.json()) as Json
  } catch {
    return '连接成功'
  }
  const data: Json[] = Array.isArray(json?.data) ? json.data : []
  const ids = data.filter((m) => typeof m?.id === 'string').map((m) => m.id)
  if (ids.length === 0) return '连接成功（服务未返回模型列表，直接对话试试）'
  const preview = ids.slice(0, 5).join('、') + (ids.length > 5 ? '...' : '')
  return ids.includes(model)
    ? `连接成功 · 模型列表中包含「${model}」`
    : `连接成功 · 模型列表中未见「${model}」：${preview}`
}
