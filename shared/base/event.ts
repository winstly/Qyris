/**
 * Event/Emitter —— 移植自 vscode src/vs/base/common/event.ts（MIT，精简版）。
 * 核心思想：
 * - Event<T> 是"可订阅函数"，可直接调用订阅，天然支持组合子（map/filter/...）
 * - 订阅者异常统一进 onUnexpectedError，一个 listener 抛错不炸其他 listener
 * - 泄漏防护：超过阈值的订阅数告警（提示订阅点栈）
 * - onWillAddFirstListener / onDidRemoveLastListener 钩子：
 *   "有人订阅才连接源事件"（零 listener 时零开销）
 */
import { onUnexpectedError } from './errors'
import { DisposableStore, IDisposable, toDisposable } from './lifecycle'

export type Listener<T> = (e: T) => void

export interface Event<T> {
  (listener: Listener<T>, store?: DisposableStore): IDisposable
  maxListeners?: number
}

export interface EmitterOptions {
  /** 本 emitter 的标识（泄漏告警定位用） */
  readonly name?: string
  /** 首个 listener 添加时回调（懒连接源事件） */
  readonly onWillAddFirstListener?: () => void
  /** 最后一个 listener 移除时回调（断开源事件） */
  readonly onDidRemoveLastListener?: void | (() => void)
  /** 泄漏告警阈值（默认取全局值） */
  readonly leakThreshold?: number
}

/** 全局泄漏告警阈值（0 关闭）；个别 emitter 可用 options.leakThreshold 覆盖 */
let globalLeakThreshold = 128

export function setGlobalLeakWarningThreshold(threshold: number): void {
  globalLeakThreshold = threshold
}

export class Emitter<T> implements IDisposable {
  private readonly _options?: EmitterOptions
  private _listeners: Set<Listener<T>> | null = null
  private _event?: Event<T>
  private _isDisposed = false

  constructor(options?: EmitterOptions) {
    this._options = options
  }

  get event(): Event<T> {
    if (!this._event) {
      const event = ((listener: Listener<T>, store?: DisposableStore): IDisposable => {
        if (this._isDisposed) {
          return toDisposable(() => {})
        }
        this._listeners ??= new Set()
        const isFirst = this._listeners.size === 0
        this._listeners.add(listener)

        // 泄漏防护：订阅数达到阈值时告警（带订阅点栈，便于定位）
        const threshold = this._options?.leakThreshold ?? globalLeakThreshold
        if (threshold > 0 && this._listeners.size === threshold) {
          console.warn(
            `[event] Emitter${this._options?.name ? `(${this._options.name})` : ''} ` +
            `订阅数达到 ${threshold}，疑似泄漏。订阅点栈：\n${new Error().stack}`,
          )
        }

        if (isFirst) {
          this._options?.onWillAddFirstListener?.()
        }
        const remove = toDisposable(() => {
          if (!this._listeners) return
          const wasLast = this._listeners.size === 1
          this._listeners.delete(listener)
          if (wasLast) {
            this._options?.onDidRemoveLastListener?.()
          }
        })
        return store?.add(remove) ?? remove
      }) as Event<T>
      event.maxListeners = this._options?.leakThreshold ?? globalLeakThreshold
      this._event = event
    }
    return this._event
  }

  get hasListeners(): boolean {
    return this._listeners !== null && this._listeners.size > 0
  }

  /** 派发事件；listener 抛错进 onUnexpectedError，不影响其余 listener */
  fire(event: T): void {
    if (!this._listeners || this._listeners.size === 0) return
    // 拷贝后遍历：fire 期间的新订阅不收本批、退订不影响本批（vscode 同语义）
    for (const listener of [...this._listeners]) {
      try {
        listener.call(undefined, event)
      } catch (e) {
        onUnexpectedError(e)
      }
    }
  }

  dispose(): void {
    if (this._isDisposed) return
    this._isDisposed = true
    this._listeners = null
  }
}

// ---------- 组合子 ----------

/** 只触发一次 */
export function once<T>(event: Event<T>): Event<T> {
  return (listener, store) => {
    const shared = new DisposableStore()
    const wrapper = (e: T): void => {
      shared.dispose()
      listener(e)
    }
    const d = event(wrapper, shared)
    return store?.add(d) ?? d
  }
}

/** 映射 */
export function map<I, O>(event: Event<I>, mapFn: (i: I) => O): Event<O> {
  return (listener, store) => {
    const d = event((e) => listener(mapFn(e)))
    return store?.add(d) ?? d
  }
}

/** 过滤 */
export function filter<T>(event: Event<T>, predicate: (e: T) => boolean): Event<T> {
  return (listener, store) => {
    const d = event((e) => {
      if (predicate(e)) listener(e)
    })
    return store?.add(d) ?? d
  }
}

/** 仅订阅副作用（返回的 disposable 只用于退订） */
export function forEach<T>(event: Event<T>, each: (e: T) => void): IDisposable {
  return event(each)
}

/** 值不变不触发（记住上次值，首次必触发） */
export function latch<T>(event: Event<T>, equals: (a: T, b: T) => boolean = Object.is): Event<T> {
  let firstCall = true
  let cache: T
  return filter(event, (value) => {
    const shouldEmit = firstCall || !equals(cache, value)
    firstCall = false
    cache = value
    return shouldEmit
  })
}

/** 转发到另一个 emitter */
export function forward<T>(from: Event<T>, to: Emitter<T>): IDisposable {
  return from((e) => to.fire(e))
}

/** 任一源事件触发即触发 */
export function any<T>(...events: Event<T>[]): Event<T> {
  return (listener, store) => {
    const shared = new DisposableStore()
    for (const e of events) {
      shared.add(e((v) => listener(v)))
    }
    return store?.add(shared) ?? shared
  }
}

/**
 * 微任务边界聚合：一轮同步内多次 fire 只在微任务里派发一次（流式 UI 批渲染的关键）。
 * merge 决定挂起期间的值如何合并（默认"取最新"）。
 */
export class MicrotaskEmitter<T> implements IDisposable {
  private readonly _emitter: Emitter<T>
  private readonly _merge: (a: T | undefined, b: T) => T
  private _hasPending = false
  private _lastEvent: T | undefined
  private _scheduled = false

  constructor(merge?: (a: T | undefined, b: T) => T) {
    this._emitter = new Emitter<T>()
    this._merge = merge ?? ((_a, b) => b)
  }

  get event(): Event<T> {
    return this._emitter.event
  }

  fire(event: T): void {
    this._lastEvent = this._hasPending ? this._merge(this._lastEvent, event) : event
    this._hasPending = true
    if (this._scheduled || !this._emitter.hasListeners) return
    this._scheduled = true
    queueMicrotask(() => {
      this._scheduled = false
      this.flush()
    })
  }

  /** 立即派发挂起的事件（同步冲刷） */
  flush(): void {
    if (!this._hasPending) return
    const e = this._lastEvent as T
    this._lastEvent = undefined
    this._hasPending = false
    this._emitter.fire(e)
  }

  dispose(): void {
    this._emitter.dispose()
  }
}
