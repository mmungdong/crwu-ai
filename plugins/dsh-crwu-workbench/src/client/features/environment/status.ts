import * as React from 'react'
import { workbenchApi, type EnvResult } from '../report-audit/api.ts'

/**
 * 环境自检的**共享状态**。
 *
 * 为什么要一个 store，而不是各组件各自 `useState`：环境状态有两个消费者，而且它们必须
 * **看到同一个结论** ——
 *
 * 1. 会话头右上角的状态灯（绿/红）：它要在面板没打开时也能亮；
 * 2. 工作台面板：它用这个结论做门禁（不通过就不给进报告审核）。
 *
 * 两边各拉一次的话，同一时刻会出现「灯是红的、面板说就绪」这种自相矛盾的画面，而且
 * 自检本身要跑 shell 命令（探二进制、问氚云/钉钉、列一次 OSS），一次就够贵了。
 *
 * 生命周期：store **由 `apply()` 创建**并随 props 下发，不是模块顶层单例 ——
 * 模块顶层保存可变运行状态是仓规禁止的（插件卸载后状态还在）。
 */

export interface EnvSnapshot {
  /** 最近一次成功的结果；从没成功过时是 null。 */
  env: EnvResult | null
  /** 有一次自检在跑。 */
  busy: boolean
  /** 最近一次失败的原因（成功后被清空）。 */
  error: string
  /** 最近一次成功的时刻（ISO 串），界面用来说明「这结论有多新」。 */
  checkedAt: string
}

export interface EnvStatusStore {
  get(): EnvSnapshot
  /** 订阅变化；返回解除订阅的函数（组件卸载时必须调用）。 */
  subscribe(listener: () => void): () => void
  /** 跑一次自检。并发的调用共享同一次请求，不会把 shell 探测打两遍。 */
  refresh(source?: string): Promise<EnvResult | null>
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createEnvStatusStore(): EnvStatusStore {
  let snapshot: EnvSnapshot = { env: null, busy: false, error: '', checkedAt: '' }
  const listeners = new Set<() => void>()
  let inflight: Promise<EnvResult | null> | null = null

  const emit = (): void => {
    // 复制一份再遍历：监听器里可能会解除订阅（React 的重渲染就是这样）。
    for (const listener of [...listeners]) listener()
  }

  const patch = (next: Partial<EnvSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    emit()
  }

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh(source) {
      // 并发去重：会话头的灯与面板几乎同时挂载时，只应该有一次真实自检。
      if (inflight !== null) return inflight
      patch({ busy: true, error: '' })
      inflight = workbenchApi.env(source === undefined ? {} : { source })
        .then((env) => {
          patch({ env, busy: false, error: '', checkedAt: new Date().toISOString() })
          return env
        })
        .catch((cause: unknown) => {
          // 失败**不清空**上一次的结果：灯保持上一次的真实颜色，比变成「不知道」有用。
          patch({ busy: false, error: describe(cause) })
          return null
        })
        .finally(() => { inflight = null })
      return inflight
    },
  }
}

/** 订阅 store 的 React hook（React 18 的 useSyncExternalStore 语义，手写以便测试替身也能跑）。 */
export function useEnvStatus(store: EnvStatusStore): EnvSnapshot {
  // 初值直接取快照（不用惰性初始化函数）：本仓的构建产物冒烟用的是一个极小的 react 替身，
  // 它的 useState 不认函数式初值 —— 少一个只有真机才会踩的坑。
  const [snapshot, setSnapshot] = React.useState<EnvSnapshot>(store.get())
  React.useEffect(() => {
    // 订阅前先同步一次：两次 render 之间 store 可能已经变了。
    setSnapshot(store.get())
    return store.subscribe(() => { setSnapshot(store.get()) })
  }, [store])
  return snapshot
}

/** 状态灯的语义。`idle` 保留给「还没查过且没在查」的极少见状态。 */
export type EnvLampTone = 'ok' | 'bad' | 'busy' | 'idle'

export function envLampOf(snapshot: EnvSnapshot): EnvLampTone {
  if (snapshot.env === null) {
    if (snapshot.error !== '') return 'bad'
    return snapshot.busy ? 'busy' : 'idle'
  }
  // 有一次自检在跑时先亮黄：结论还没出来就继续显示上一次的绿/红会骗人
  // （重新自检的那几秒里，界面上到底是不是「现在这个结论」必须看得出来）。
  if (snapshot.busy) return 'busy'
  return snapshot.env.allOk === true ? 'ok' : 'bad'
}

export interface EnvTally {
  /** 参与计数的检查项总数（二进制 + 服务 + iFinD + 工作空间 + 平台）。 */
  total: number
  passed: number
  /** 通过率，0~1；没有检查项时是 0。 */
  ratio: number
}

/** 通过率只用于展示；**门禁判断一律看 `env.allOk`**（那是 Host 给的权威结论）。 */
export function envTally(env: EnvResult | null): EnvTally {
  if (env === null) return { total: 0, passed: 0, ratio: 0 }
  const results = [
    ...env.checks.map((check) => check.ok === true),
    ...env.services.map((service) => service.ok === true),
    env.ifindKey.ok === true,
    env.workspace.chosen === true,
    env.platform !== '',
  ]
  const passed = results.filter((ok) => ok).length
  return { total: results.length, passed, ratio: results.length === 0 ? 0 : passed / results.length }
}
