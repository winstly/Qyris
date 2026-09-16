/**
 * CancellationToken —— 移植自 vscode src/vs/base/common/cancellation.ts（MIT）。
 * 纪律：所有长操作签名带 `token: CancellationToken`；父 token 级联子 source，
 * 全局取消（停止生成/窗口关闭）自动传播到每个子操作。
 */
import { Emitter, Event } from './event'
import { DisposableStore, IDisposable, toDisposable } from './lifecycle'

export interface CancellationToken {
  /** 是否已取消（只读快照） */
  readonly isCancellationRequested: boolean
  /** 取消时触发（只触发一次；已取消后订阅也会立即收到） */
  readonly onCancellationRequested: Event<void>
}

/** 已取消 token 的订阅事件：setTimeout(0) 异步触发一次（晚订阅也能收到） */
const shortcutEvent: Event<void> = (listener, store) => {
  const handle = setTimeout(listener, 0)
  const d = toDisposable(() => {
    clearTimeout(handle)
  })
  return store?.add(d) ?? d
}

class MutableToken implements CancellationToken {
  private _isCancelled = false
  private _emitter: Emitter<void> | null = null

  public cancel(): void {
    if (!this._isCancelled) {
      this._isCancelled = true
      if (this._emitter) {
        this._emitter.fire(undefined)
        this.disposeEmitter()
      }
    }
  }

  get isCancellationRequested(): boolean {
    return this._isCancelled
  }

  get onCancellationRequested(): Event<void> {
    if (this._isCancelled) return shortcutEvent
    if (!this._emitter) {
      this._emitter = new Emitter<void>()
    }
    return this._emitter.event
  }

  private disposeEmitter(): void {
    this._emitter?.dispose()
    this._emitter = null
  }
}

const cancelledToken: CancellationToken = Object.freeze({
  isCancellationRequested: true,
  onCancellationRequested: shortcutEvent,
})

export namespace CancellationToken {
  /** 复用全局"永不取消"token，避免空操作场景重复造对象 */
  export const None: CancellationToken = Object.freeze({
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  })

  /** 已取消的冻结单例 */
  export const Cancelled: CancellationToken = cancelledToken
}

export class CancellationTokenSource implements IDisposable {
  private _token?: CancellationToken
  private _parentListener?: IDisposable

  constructor(parent?: CancellationToken) {
    this._parentListener = parent?.onCancellationRequested(() => this.cancel())
  }

  get token(): CancellationToken {
    if (!this._token) {
      // 惰性创建：仅在有消费者时才付 Emitter 成本
      this._token = new MutableToken()
    }
    return this._token
  }

  cancel(): void {
    if (!this._token) {
      // 取消先于取 token 发生：直接给冻结单例，取消状态不丢
      this._token = CancellationToken.Cancelled
    } else if (this._token instanceof MutableToken) {
      this._token.cancel()
    }
  }

  dispose(cancelIfNotCancelled = false): void {
    if (cancelIfNotCancelled) this.cancel()
    this._parentListener?.dispose()
    if (!this._token) {
      this._token = CancellationToken.Cancelled
    } else if (this._token instanceof MutableToken) {
      this._token.cancel()
    }
  }
}

/** store 销毁时自动取消（组件卸载即取消该作用域全部在途操作） */
export function cancelOnDispose(store: DisposableStore): CancellationToken {
  const cts = new CancellationTokenSource()
  store.add(cts)
  return cts.token
}
