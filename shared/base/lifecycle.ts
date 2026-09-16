/**
 * Disposable 生命周期纪律 —— 移植自 vscode src/vs/base/common/lifecycle.ts（MIT）。
 * 核心思想：一个作用域一个 DisposableStore，销毁时只 dispose 一个 store；
 * 向已 dispose 的 store 再 add 会立即释放新项并告警（防"复活泄漏"）。
 */

import { onUnexpectedError } from './errors'

export interface IDisposable {
  dispose(): void
}

export function isDisposable<E>(obj: E | IDisposable): obj is E & IDisposable {
  return !!obj && typeof (obj as IDisposable).dispose === 'function'
}

export function toDisposable(fn: () => void): IDisposable {
  const self: IDisposable = {
    dispose: () => {
      fn()
    },
  }
  return self
}

/** 一次性组合多个 disposable（按序释放） */
export function combinedDisposable(disposables: IDisposable[]): IDisposable {
  const toDispose = disposables.slice()
  return toDisposable(() => {
    for (const d of toDispose.reverse()) {
      try {
        d.dispose()
      } catch (e) {
        onUnexpectedError(e)
      }
    }
  })
}

export class DisposableStore implements IDisposable {
  static DISABLE_DISPOSED_WARNING = false

  private _toDispose = new Set<IDisposable>()
  private _isDisposed = false

  /** 释放全部并标记本 store 已死；之后 add 的项会被立即释放 */
  public dispose(): void {
    if (this._isDisposed) return
    this._isDisposed = true
    this.clear()
  }

  /** 丢弃全部已注册项（不标记已死，store 可继续使用） */
  public clear(): void {
    if (this._toDispose.size === 0) return
    const toDispose = [...this._toDispose]
    this._toDispose.clear()
    for (const d of toDispose.reverse()) {
      try {
        d.dispose()
      } catch (e) {
        onUnexpectedError(e)
      }
    }
  }

  public add<T extends IDisposable>(o: T): T {
    if (!o) return o
    if (this._isDisposed) {
      if (!DisposableStore.DISABLE_DISPOSED_WARNING) {
        console.warn(new Error('向已 dispose 的 DisposableStore 注册项 —— 立即释放').stack)
      }
      o.dispose()
      return o
    }
    this._toDispose.add(o)
    return o
  }

  /** 移除但不 dispose（所有权移交调用方，如父子转移） */
  public deleteAndLeak(o: IDisposable): void {
    if (!this._toDispose.has(o)) return
    this._toDispose.delete(o)
  }
}

export abstract class Disposable implements IDisposable {
  private readonly _store = new DisposableStore()

  protected _register<T extends IDisposable>(o: T): T {
    this._store.add(o)
    return o
  }

  dispose(): void {
    this._store.dispose()
  }
}

/** 换值自动 dispose 旧值 —— "当前持有的唯一资源"语义 */
export class MutableDisposable<T extends IDisposable = IDisposable> implements IDisposable {
  private _value?: T
  private _isDisposed = false

  get value(): T | undefined {
    return this._isDisposed ? undefined : this._value
  }

  set value(value: T | undefined) {
    if (this._isDisposed || value === this._value) return
    this._value?.dispose()
    this._value = value
  }

  /** 清空并返回旧值（所有权移交调用方） */
  public clear(): T | undefined {
    const value = this._value
    this._value = undefined
    return value
  }

  dispose(): void {
    this._isDisposed = true
    this._value?.dispose()
    this._value = undefined
  }
}

/** 按 key 管理子资源生命周期（每会话/每文件一个 watcher 的场景） */
export class DisposableMap<K, V extends IDisposable = IDisposable> implements IDisposable {
  private _store = new Map<K, V>()
  private _isDisposed = false

  dispose(): void {
    if (this._isDisposed) return
    this._isDisposed = true
    for (const v of this._store.values()) v.dispose()
    this._store.clear()
  }

  get(key: K): V | undefined {
    return this._store.get(key)
  }

  set(key: K, value: V): void {
    if (this._isDisposed) {
      value.dispose()
      return
    }
    this._store.get(key)?.dispose()
    this._store.set(key, value)
  }

  /** 删除并释放 */
  deleteAndDispose(key: K): void {
    this._store.get(key)?.dispose()
    this._store.delete(key)
  }

  /** 删除但保留（所有权移交调用方） */
  deleteAndLeak(key: K): void {
    this._store.delete(key)
  }

  keys(): IterableIterator<K> {
    return this._store.keys()
  }

  get isDisposed(): boolean {
    return this._isDisposed
  }
}
