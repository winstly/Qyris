/**
 * 提示词/凭据的跨进程契约常量（纯值，不 import node/electron）。
 * 改动即协议变更：渲染层 system 组装、CLI 序列化、主进程解析都在消费这些字面量。
 */

/** 会话摘要块标题：渲染层 system 组装（useChatStore）与 CLI 正文前置（ai-cli.serializeConversation /
 *  ai.ts 单轮形态）必须同字面量——模型与解析侧都按它切节 */
export const SESSION_SUMMARY_HEADING = '【此前会话进展】'

/** 长期记忆块标题（渲染层预格式化后原样透传）：块首匹配用前缀即可（内容里可带限定语） */
export const MEMORY_BLOCK_HEADING = '【长期记忆（供参考，可能过时）】'
/** 解析/泄漏检测侧按前缀认块（标题尾注可变，前缀稳定） */
export const MEMORY_BLOCK_PREFIX = '【长期记忆'

/** 早期对话压缩摘要块标题：渲染层 system 组装与 ai.ts 单轮补头/泄漏检测同字面量 */
export const CONTEXT_SUMMARY_HEADING = '【早期对话摘要（原始历史已压缩）】'
/** 解析/泄漏检测侧按前缀认块 */
export const CONTEXT_SUMMARY_PREFIX = '【早期对话摘要'

/** API Key 在凭据存储中的账户名（渲染层写入 / 主进程读取同键） */
export const SECRET_ACCOUNT = 'api_key'
