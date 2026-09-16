/**
 * 异步工具集 —— 移植自 vscode src/vs/base/common/async.ts（MIT，精选）。
 * 与 Qyris 场景的对应关系：
 * - SequencerByKey：同工程/同文件的命令排队（run_once 去重串行）
 * - Limiter / Queue：并发上限（AI 子任务、子进程池）
 * - Delayer：防抖（保存/搜索输入）
 * - DeferredPromise：命令式 resolve/reject（等子进程就绪、跨模块完结通知）
 * - raceCancellationError：任意 promise 挂 token，取消即抛
 * - AsyncIterableSource：AI 流式输出的推/拉适配
 */
import { CancellationError, isCancellationError } from './errors'
import type { CancellationToken } from './cancellation'

/** 同 key 串行、空闲自清：key 相同的任务排队执行，不同 key 互不阻塞 */
export class SequencerByKey<TKey> {
  private m = new Map<TKey, Promise<unknown>>()

  queue<T>(key: TKey, task: () => Promise<T>): Promise<T> {
    const previous = this.m.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => { /* 前一任务失败不阻塞后一任务 */ })
      .then(task)
      .finally(() => {
        if (this.m.get(key) === next) this.m.delete(key)
      })
    this.m.set(key, next)
    return next
  }

  get size(): number {
    return this.m.size
  }
}

/** 并发上限 N 的任务池 */
export class Limiter<T> {
  private _size = 0
  private _queue: Array<{ task: () => Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }> = []
  private _onDrained?: () => void

  constructor(private readonly maxDegreeOfParalellism: number, onDrained?: () => void) {
    this._onDrained = onDrained
  }

  get size(): number {
    return this._size + this._queue.length
  }

  get pending(): number {
    return this._queue.length
  }

  queue(factory: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._queue.push({ task: factory, resolve, reject })
      this._drain()
    })
  }

  private _drain(): void {
    while (this._size < this.maxDegreeOfParalellism && this._queue.length > 0) {
      const { task, resolve, reject } = this._queue.shift()!
      this._size++
      task()
        .then(resolve, reject)
        .finally(() => {
          this._size--
          if (this._queue.length > 0) {
            this._drain()
          } else if (this._size === 0) {
            this._onDrained?.()
          }
        })
    }
  }
}

/** 并发为 1 的队列（严格串行） */
export class Queue<T> extends Limiter<T> {
  constructor(onDrained?: () => void) {
    super(1, onDrained)
  }
}

/** 微任务延迟常量：保留占位，当前无使用场景（vscode 有，此处刻意不抄） */

/** 防抖：等调用方"停手" delay 毫秒后才真正执行；等待期内再次 trigger 只重置计时 */
export class Delayer<C> {
  private timeout: ReturnType<typeof setTimeout> | null = null
  private completion: DeferredPromise<void> | null = null
  private promise: Promise<C> | null = null

  constructor(public readonly defaultDelay: number) {}

  public trigger(task: () => Promise<C>, delay: number = this.defaultDelay): Promise<C> {
    this.cancelTimeout()
    if (!this.completion) {
      this.completion = new DeferredPromise<void>()
      this.promise = this.completion.p.then(() => {
        this.completion = null
        return task()
      })
    }
    this.timeout = setTimeout(() => this.completion?.complete(), delay)
    return this.promise as Promise<C>
  }

  public cancel(): void {
    this.cancelTimeout()
    this.completion?.cancel()
    this.completion = null
  }

  private cancelTimeout(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
  }
}

/** 命令式完结的 Promise：可从外部 resolve/reject，重复 settle 为 no-op */
export class DeferredPromise<T> {
  private _resolve!: (value: T) => void
  private _reject!: (err: unknown) => void
  readonly p: Promise<T> = new Promise<T>((resolve, reject) => {
    this._resolve = resolve
    this._reject = reject
  })

  public isSettled = false

  public complete(value: T): void {
    if (this.isSettled) return
    this.isSettled = true
    this._resolve(value)
  }

  public cancel(): void {
    if (this.isSettled) return
    this.isSettled = true
    this._reject(new CancellationError())
  }

  public error(err: unknown): void {
    if (this.isSettled) return
    this.isSettled = true
    this._reject(err)
  }
}

/** 任意 promise 挂 token：取消即抛 CancellationError（原 promise 结果被丢弃） */
export async function raceCancellationError<T>(promise: Promise<T>, token: CancellationToken): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ref = token.onCancellationRequested(() => {
      ref.dispose()
      reject(new CancellationError())
    })
    promise.then(
      (result) => {
        ref.dispose()
        resolve(result)
      },
      (err) => {
        ref.dispose()
        reject(err)
      },
    )
  })
}

/** 挂 token 的 sleep：token 取消立即返回 false（true=睡满），替代轮询式取消检查 */
export function sleepInterruptible(ms: number, token?: CancellationToken): Promise<boolean> {
  if (token?.isCancellationRequested) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const ref = token?.onCancellationRequested(() => {
      if (timer !== null) clearTimeout(timer)
      ref?.dispose()
      resolve(false)
    })
    timer = setTimeout(() => {
      ref?.dispose()
      resolve(true)
    }, ms)
  })
}

/** 推/拉适配：producer 持续 push，consumer for-await；提前 push 的事件先缓冲不丢 */
export class AsyncIterableSource<T> {
  private _queue: T[] = []
  private _state: 'running' | 'ended' | 'error' = 'running'
  private _error: unknown = undefined
  private _wakeup: (() => void) | null = null

  /** 生产侧：推入一条（ended 后静默丢弃） */
  emitOne(value: T): void {
    if (this._state !== 'running') return
    this._queue.push(value)
    this._wakeup?.()
  }

  /** 生产侧：正常结束 */
  end(): void {
    if (this._state !== 'running') return
    this._state = 'ended'
    this._wakeup?.()
  }

  /** 生产侧：以错误结束（取消用 cancel） */
  error(err: unknown): void {
    if (this._state !== 'running') return
    this._state = 'error'
    this._error = err
    this._wakeup?.()
  }

  /** 生产侧：以取消结束（消费者按正常结束处理） */
  cancel(): void {
    this.error(new CancellationError())
  }

  [Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    const self = this
    async function* gen(): AsyncGenerator<T, void, undefined> {
      let i = 0
      while (true) {
        if (i < self._queue.length) {
          yield self._queue[i++]
          continue
        }
        if (self._state === 'error') {
          if (isCancellationError(self._error)) return
          throw self._error
        }
        if (self._state === 'ended') return
        await new Promise<void>((resolve) => (self._wakeup = resolve))
      }
    }
    return gen()
  }
}
