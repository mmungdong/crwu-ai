import * as React from 'react'
import { defaultModule, isModuleId, moduleLabel, requirementOf, requiresEnvironment, type ModuleId } from './modules.ts'
import { navigateModuleIn, type EnvironmentStateView, type NavigateResult } from '../../../shared/environment/model.ts'

/**
 * 「现在停在工作台的哪个模块」必须**只有一份**。
 *
 * 以前这份状态长在面板组件内部（`useState`），于是模块只能从面板底部那条切换条上改；
 * 现在三个模块同时是左侧栏里的三个子项、又是面板里的三页，两处都能改，状态就必须上提到
 * 由 `apply()` 创建、同时下发给侧栏入口与面板的 store —— 两边各存一份的必然结果就是
 * 「侧栏高亮着报告审核、面板里显示环境信息」。
 *
 * ## 2026-09-26：导航门禁上提到**这一层**（不只是面板里那一页）
 *
 * 需求原话是「把门禁从 `WorkbenchPanel` 的 audit 页面特判上提到统一导航层」。以前只有
 * 「面板里显示 audit 时」才判环境，于是：侧栏点子项照样切过去、报告页里的跳转照样切过去，
 * 切完再被正文里的拦截屏挡住 —— 用户看到的是"点得进去、进去了说不行"。
 *
 * 现在**所有入口**都走同一个 `navigate(target)`：
 *
 * - `target` 是环境页 → 直接进（它就是修复入口）；
 * - 目标页的元数据 `requiresEnvironment === false` → 直接进；
 * - 需要环境时交给 `navigateModuleIn`（`shared/environment/model.ts` 的纯函数，可单测）：
 *   不通过就**不进入目标页**、记下 `pendingTarget`、落到 `env`，并把原因（含目标页名）带出来。
 *
 * 检查通过之后只恢复**最近一次**被拦的目标，而且**只在用户没有主动改过去处**的前提下：
 * 用户点任何别的页面（包括环境页）都会把 `pendingTarget` 换掉或清掉，绝不把他弹走。
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
  /** 最近一次**被门禁拦下**的目标页；成功进入页面后清空。 */
  pendingTarget: ModuleId | null
  /** 被拦时的原因（人话，含目标页名）；没有拦截时是空串。 */
  gateReason: string
  /** 上一次导航是不是被拦了（面板据此渲染"被挡住"的那一屏）。 */
  blocked: boolean
}

/** 门禁判断需要的环境输入（store 自己不认识 RPC，只认识模型）。 */
export interface ModuleGateInput {
  /** 统一环境模型；`null` = 还没自检（按不可放行处理）。 */
  state: EnvironmentStateView | null
}

export interface ModuleStore {
  get(): ModuleSnapshot
  /**
   * 环境事实变了（自检落地 / 重新检查）。
   *
   * 只在这里决定两件事：第一次拿到结论时自动落位一次；以及**检查通过后恢复**最近一次
   * 被拦下来的目标（`pendingTarget`）。没有 pendingTarget 时什么都不做 —— 不许无条件弹走用户。
   */
  envChanged(input: ModuleGateInput): void
  /**
   * **统一导航入口**：侧栏子项、报告页内跳转、环境页「进入报告审核」、
   * 以及以后新增的页全部调它。
   *
   * 返回这次导航的结论（去了哪、有没有被拦、本来要去哪），供调用方做界面反馈。
   */
  navigate(target: ModuleId, input: ModuleGateInput): NavigateResult
  subscribe(listener: () => void): () => void
}

export function createModuleStore(initial: ModuleId = 'env'): ModuleStore {
  let snapshot: ModuleSnapshot = {
    active: initial, autoEntered: false, selectEpoch: 0, pendingTarget: null, gateReason: '', blocked: false,
  }
  const listeners = new Set<() => void>()

  // 值没变就**不通知**：订阅方按快照重渲染，无脑通知会白白重画。
  const emit = (next: ModuleSnapshot): void => {
    const same = next.active === snapshot.active
      && next.autoEntered === snapshot.autoEntered
      && next.selectEpoch === snapshot.selectEpoch
      && next.pendingTarget === snapshot.pendingTarget
      && next.gateReason === snapshot.gateReason
      && next.blocked === snapshot.blocked
    if (same) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const labelOf = (id: ModuleId): string => moduleLabel(id)

  /** 跑一次纯函数门禁（**唯一**判据，UI 与测试都不许再写一套）。 */
  const gate = (target: ModuleId, input: ModuleGateInput): NavigateResult => {
    if (!isModuleId(target)) return { module: 'env', blocked: false, pending: null, reason: '' }
    return navigateModuleIn(input.state, {
      target,
      requires: requiresEnvironment(target),
      requirement: requirementOf(target),
    }, labelOf)
  }

  return {
    get: () => snapshot,
    envChanged(input) {
      const current = snapshot
      // ① 第一次拿到结论：落位一次（通过 → 报告审核；否则停在环境页）。
      if (!current.autoEntered) {
        const target = defaultModule(input.state?.proceed === true)
        emit({ ...current, active: target, autoEntered: true, blocked: false, gateReason: '' })
        return
      }
      // ② 已经落位过：只有存在"被拦下来的目标"时才可能恢复，且必须现在真的能进。
      const pending = current.pendingTarget
      if (pending === null) return
      const verdict = gate(pending, input)
      if (!verdict.blocked) {
        // 检查通过 → 只恢复最近一次被拦的那一个目标。
        emit({ ...current, active: pending, pendingTarget: null, gateReason: '', blocked: false })
        return
      }
      // 还是进不去：留在环境页，把原因刷新成最新的一条。
      emit({
        ...current,
        active: 'env',
        pendingTarget: pending,
        gateReason: verdict.reason,
        blocked: true,
      })
    },
    navigate(target, input) {
      const current = snapshot
      const verdict = gate(target, input)
      if (verdict.blocked) {
        // 用户主动去别处 = 取消上次的自动恢复意图：这里**覆盖**待恢复目标（或对 `env` 而言
        // 就是清掉它 —— 见下面那个分支），绝不在他改道之后还把他弹回去。
        const pendingNext = verdict.pending === null ? null : verdict.pending
        emit({
          ...current,
          active: 'env',
          autoEntered: true,
          selectEpoch: current.selectEpoch + 1,
          pendingTarget: pendingNext,
          gateReason: pendingNext === null ? '' : verdict.reason,
          blocked: pendingNext !== null,
        })
        return verdict
      }
      emit({
        ...current,
        active: verdict.module,
        autoEntered: true,
        selectEpoch: current.selectEpoch + 1,
        // 成功进入任何页面都清掉待恢复目标：用户已经自己走到想去的地方了。
        pendingTarget: null,
        gateReason: '',
        blocked: false,
      })
      return verdict
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
