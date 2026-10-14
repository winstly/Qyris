/**
 * 记忆双轨打分的共享数学：主进程检索排序与渲染层「重要度」展示同一真源（改参数两处同步生效）。
 * 双轨契约：importance = 语义价值（静态字段，不随时间贬值）；activation = 使用热度（检索/展示时
 * 纯函数计算，零写库）。纯数学模块，不 import node/electron（跨进程共用面约束）。
 */

/** 类别半衰期（天）：未访问 Δt 达 h 时热度减半——event 一周不用即沉，skill 三个月才减半 */
const MEMORY_HALF_LIFE_DAYS: Record<string, number> = {
  summary: 3,
  event: 7,
  fact: 30,
  lesson: 60,
  preference: 90,
  skill: 120,
}

/** 访问饱和系数：κ=3 封顶马太效应（n=3 与 n=100 的热度差 <0.1） */
const MEMORY_SATURATION_K = 3

/** 一天的毫秒数（热度衰减的 Δt 换算） */
const DAY_MS = 86_400_000

/** 未知类别回退半衰期（天） */
const DEFAULT_HALF_LIFE_DAYS = 30

/** 展示用热度下限占比（importance × (下限 + (1-下限)×activation)） */
const DISPLAY_FLOOR = 0.1

/** 使用热度激活度：A = s(n) × 2^(−Δt/h)，值域 (0,1)。
 *  s(n) = (1+n)/(1+n+κ)：写入即 25% 起始热度（防冷启动饿死）；
 *  Δt 基准 last_accessed_at（被使用就强化），从未访问退化为 created_at。 */
export function memoryActivation(
  accessCount: number,
  lastAccessedAt: number | null,
  createdAt: number,
  category: string,
  now: number,
): number {
  const days = Math.max(0, (now - (lastAccessedAt ?? createdAt)) / DAY_MS)
  const n = Math.max(0, accessCount)
  const s = (1 + n) / (1 + n + MEMORY_SATURATION_K)
  const h = MEMORY_HALF_LIFE_DAYS[category] ?? DEFAULT_HALF_LIFE_DAYS
  return s * Math.pow(2, -days / h)
}

/** 展示用「衰减观感重要度」：语义价值 × 热度观感（纯计算，库内 importance 不动） */
export function memoryDisplayImportance(importance: number, activation: number): number {
  return importance * (DISPLAY_FLOOR + (1 - DISPLAY_FLOOR) * activation)
}
