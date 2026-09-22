import * as React from 'react'
import { defaultModule, type ModuleId } from './modules.ts'

/**
 * 「现在停在工作台的哪个模块」必须**只有一份**。
 *
 * 以前这份状态长在面板组件内部（`useState`），于是模块只能从面板底部那条切换条上改；
 * 现在三个模块同时是左侧栏里的三个子项、又是面板里的三页，两处都能改，状态就必须上提到
 * 由 `apply()` 创建、同时下发给侧栏入口与面板的 store —— 两边各存一份的必然结果就是
 * 「侧栏高亮着报告审核、面板里显示环境信息」。
 *
 * 它同时接管原先那个 `autoEntered` ref 的职责：**环境自检结论只自动落位一次**，
 * 用户手动点过任何一个模块之后，谁都不许再把他弹走。
 */

export interface ModuleSnapshot {
  /** 当前模块。 */
  active: ModuleId
  /** 已经自动落位过、或用户手动选过 → 之后不许再按自检结论弹走用户。 */
  autoEntered: boolean
  /**
   * 用户每次**主动**选模块时 +1（自动落位不加）。
   *
   * 面板靠它清掉上一次的拦截态：用户已经补好环境、再从侧栏点回「报告审核」，
   * 不能还看到那张过期的「自检没过」拦截屏。
   */
  selectEpoch: number
}

export interface ModuleStore {
  get(): ModuleSnapshot
  /** 用户主动选某个模块：同时记住「已经手动选过」，自检结论不得再弹走他。 */
  select(id: ModuleId): void
  /** 环境自检结论落地后自动落位：只生效一次。 */
  autoEnter(envOk: boolean): void
  subscribe(listener: () => void): () => void
}

export function createModuleStore(initial: ModuleId = 'env'): ModuleStore {
  let snapshot: ModuleSnapshot = { active: initial, autoEntered: false, selectEpoch: 0 }
  const listeners = new Set<() => void>()

  // 值没变就**不通知**：订阅方按快照重渲染，无脑通知会白白重画。
  const emit = (next: ModuleSnapshot): void => {
    const same = next.active === snapshot.active
      && next.autoEntered === snapshot.autoEntered
      && next.selectEpoch === snapshot.selectEpoch
    if (same) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  return {
    get: () => snapshot,
    select(id) {
      emit({ ...snapshot, active: id, autoEntered: true, selectEpoch: snapshot.selectEpoch + 1 })
    },
    autoEnter(envOk) {
      if (snapshot.autoEntered) return
      emit({ ...snapshot, active: defaultModule(envOk), autoEntered: true })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * 组件拿 store：`apply()` 会传下来；没传（单测直接渲染组件）就**固定造一份**给这个实例。
 *
 * 写法与面板里 envStatus / build 的兜底完全一致：`useRef` 无条件调用，
 * 创建动作放在 null 判断里 —— 不能写成 `props.modules ?? createModuleStore()`，
 * 那样 store 每次渲染都是新的，订阅会被反复重建。
 */
export function useModuleStore(provided?: ModuleStore): ModuleStore {
  const ref = React.useRef<ModuleStore | null>(null)
  if (ref.current === null) ref.current = provided ?? createModuleStore()
  return ref.current
}

/** 订阅模块状态。用 useState + useEffect，理由与 `useEnvStatus` 相同（产物冒烟用的是极小的 react 替身）。 */
export function useModule(store: ModuleStore): ModuleSnapshot {
  const [snapshot, setSnapshot] = React.useState<ModuleSnapshot>(store.get())
  React.useEffect(() => {
    setSnapshot(store.get())
    return store.subscribe(() => { setSnapshot(store.get()) })
  }, [store])
  return snapshot
}
