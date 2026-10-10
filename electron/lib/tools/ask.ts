/**
 * 交互工具：askUserQuestion —— 登记 schema，但**不在主进程执行**（延迟给调用方）。
 *
 * 为什么延迟：
 *   渲染层的提问闭环是「completion.toolCalls 带 askUserQuestion → useChatStore.askUser 置
 *   pendingAsk（卡片由此可交互）→ 用户点 AskUserCard → answerAsk 解析器回填 → 答案作为
 *   tool 消息随下一次 ai_chat_stream 回到主进程」。两条硬事实决定了主进程不能自己挂起等回填：
 *     1. answerAsk 不发任何 IPC——答案只写在渲染层 store（answers/pendingAsk）与下一轮消息历史里，
 *        主进程没有可等的回填通道；
 *     2. AskUserCard 的交互态只认 pendingAsk（isActive = pendingAsk.id === call.id && status==='awaiting-user'），
 *        而 pendingAsk 只能由渲染层工具循环设置。
 *   所以主进程侧「适配现有事件形状」= 本轮含本工具时结束 run、把 toolUse 原样交回
 *   AiCompletion.toolCalls，由渲染层既有流程挂起/回填。runner 不挂起，天然没有「卡死」风险，
 *   也就无需超时兜底（等待发生在渲染层，用户可点卡片、可「停止生成」取消、可关工程解除）。
 *
 * execute 不会被 runner 调用（DEFERRED 语义先于执行判定）；真被调用说明编排走错了，响亮报错。
 */
import type { Tool } from '../model/types'

export const askUserQuestion: Tool = {
  name: 'askUserQuestion',
  description: '当需要用户做选择或补充信息时，向用户提问并等待回答',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '问题文本' },
      options: { type: 'array', items: { type: 'string' }, description: '可选项；不传则用户自由输入' },
    },
    required: ['question'],
  },
  permission: 'readonly',
  async execute() {
    throw new Error('askUserQuestion 由调用方（渲染层 askUser 流程）执行，不会在主进程工具路径中运行')
  },
}

/** 交互工具集 */
export const askTools: Tool[] = [askUserQuestion]
