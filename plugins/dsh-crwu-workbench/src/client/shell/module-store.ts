import * as React from 'react'
import { isModuleId, moduleLabel, requirementOf, requiresEnvironment, type ModuleId } from './modules.ts'
import {
  defaultNodeOfModule,
  firstEnabledChild,
  moduleOfPage,
  nodeById,
  parentOf,
  requirementOfNode,
  requiresEnvironmentOf,
  type NavigationNode,
} from './navigation.ts'
import { navigateModuleIn, type EnvironmentStateView, type NavigateResult } from '../../shared/environment/model.ts'

/**
 * 「现在停在工作台的哪一页」必须**只有一份**。
 *
 * 落点是一个二元组：**一级目录（业务大类）+ 二级目录（该业务下的功能页面）**。
 * 侧栏那张分组卡上的子项、面板里的两级页签、页面正文都读这一份状态 ——
 * 两边各存一份的必然结果就是「侧栏高亮着报告审核、面板里显示环境信息」，
 * 或者「一级目录已经切了、二级目录还停在旧目录」。
 *
 * ## 一次更新里改完一整组
 *
 * 一级目录、二级目录、正文**在同一次 `emit` 里变化**（`landOn` 一处写全）。
 * 这是用户点掉的那个中间态：切一级目录时先改父、再等一次渲染改子，屏幕上会闪过
 * 「父是新的、子是旧的」。这里没有两步，所以那种帧不存在。
 *
 * ## 环境信息不在目录树里
 *
 * `kind: 'env'` 是**外层门禁态**，不是一页目录：环境没就绪时所有入口统一落到它，
 * 环境通过后估值 / 审核页面不再重复展示环境信息（用户 2026-10-13 口径）。
 * `kind: 'empty'` 是「这个一级目录下没有可用页面」（显示「该业务目录暂未开放」）。
 *
 * ## 导航门禁仍然只有一条规则
 *
 * 每个页面节点是否需要环境、要多严，都从 `navigation.ts` 派生（它再派生自 `MODULE_META`），
 * 判据本身仍是 `shared/environment/model.ts` 的纯函数。所有入口 —— 侧栏子项、两级页签、
 * 环境页的「进入报告审核」、报告页内跳转 —— 都走这里，组件不自己判"能不能进"。
 *
 * 检查通过之后只恢复**最近一次**被拦的目标，而且**只在用户没有主动改过去处**的前提下：
 * 用户点任何别的页面（包括环境页）都会把 `pendingNode` 换掉或清掉，绝不把他弹走。
 */

export interface ModuleSnapshot {
  /** 落点类型：正常页面 / 环境信息（不在目录树里）/ 该一级目录下没有可用页面。 */
  kind: 'node' | 'env' | 'empty'
  /** 当前一级目录 id。 */
  parent: string
  /** 当前二级目录 id；`kind !== 'node'` 时是 `null`。 */
  node: string | null
  /** 当前页面对应的模块（侧栏那张分组卡据此高亮）；`empty` 时是 `null`。 */
  active: ModuleId | null
  /** 已经自动落位过、或用户手动选过 → 之后不许再按自检结论弹走用户。 */
  autoEntered: boolean
  /**
   * 用户每次**主动**选目录时 +1（自动落位与"恢复被拦目标"不加）。
   *
   * 面板靠它清掉上一次的拦截态：用户已经补好环境、再点一次目标页，
   * 不能还看到那张过期的「自检没过」拦截屏。
   */
  selectEpoch: number
  /** 最近一次**被门禁拦下**的目标节点；成功进入页面后清空。 */
  pendingNode: string | null
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

/** 一次导航的结论。除共享模型的字段外，多带"目标节点"与"是不是空目录"。 */
export interface NavVerdict extends NavigateResult {
  /** 目标节点（成功进入 / 被拦下来的那一个）；空目录时是 `null`。 */
  node: string | null
  /** 这次点击落到了"该一级目录下没有可用页面"。 */
  empty: boolean
}

export interface ModuleStore {
  get(): ModuleSnapshot
  /**
   * 环境事实变了（自检落地 / 重新检查）。
   *
   * 只在这里决定两件事：第一次拿到结论时自动落位一次；以及**检查通过后恢复**最近一次
   * 被拦下来的目标（`pendingNode`）。没有 pendingNode 时什么都不做 —— 不许无条件弹走用户。
   */
  envChanged(input: ModuleGateInput): void
  /** 侧栏那张分组卡上的模块入口（`eval` / `audit` / `env`）走它。 */
  navigate(target: ModuleId, input: ModuleGateInput): NavVerdict
  /** 点一级目录：立刻换成它的二级目录，并默认选中第一个**可用**页面。 */
  navigateParent(parentId: string, input: ModuleGateInput): NavVerdict
  /** 点二级目录（或代码里精确跳某一页）。 */
  navigateNode(nodeId: string, input: ModuleGateInput): NavVerdict
  /** 进环境信息（不在目录树里，永远放行 —— 它就是修复入口）。 */
  navigateEnv(input: ModuleGateInput): NavVerdict
  subscribe(listener: () => void): () => void
}

/**
 * 首次落位前的一级目录。
 *
 * 空串 = "还没有目录"：环境自检没结论之前正文是等待页 / 环境页，目录条整个不画，
 * 所以这里不需要一个**假**的一级目录（以前借的是全局列表的第一项，那会让"评估"
 * 在还没落位时就看起来像是当前目录）。
 */
const INITIAL_PARENT = ''

const ENV_VERDICT: NavVerdict = { module: 'env', blocked: false, pending: null, reason: '', node: null, empty: false }

export function createModuleStore(initial: ModuleId = 'env'): ModuleStore {
  let snapshot: ModuleSnapshot = {
    // 还没落地：先按环境信息处理（环境自检没结论之前，谈"在哪一页"没有意义）。
    // `active` 只是给侧栏那张分组卡高亮用，`kind`/`node` 才是正文的判据。
    kind: 'env',
    parent: INITIAL_PARENT,
    node: null,
    active: initial,
    autoEntered: false,
    selectEpoch: 0,
    pendingNode: null,
    gateReason: '',
    blocked: false,
  }
  const listeners = new Set<() => void>()

  // 值没变就**不通知**：订阅方按快照重渲染，无脑通知会白白重画。
  const emit = (next: ModuleSnapshot): void => {
    const same = next.kind === snapshot.kind
      && next.parent === snapshot.parent
      && next.node === snapshot.node
      && next.active === snapshot.active
      && next.autoEntered === snapshot.autoEntered
      && next.selectEpoch === snapshot.selectEpoch
      && next.pendingNode === snapshot.pendingNode
      && next.gateReason === snapshot.gateReason
      && next.blocked === snapshot.blocked
    if (same) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  /** 门禁文案里的模块名（只用于兜底：目标页名由节点自己给）。 */
  const labelOf = (id: ModuleId): string => moduleLabel(id)

  /** 跑一次纯函数门禁（**唯一**判据，UI 与测试都不许再写一套）。 */
  const gateOf = (node: NavigationNode, input: ModuleGateInput): NavigateResult => {
    const module = moduleOfPage(node.page)
    if (module === null) {
      // 没有页面的节点（一级目录）不该被当成可进目标：不放行，也不假装有理由。
      return { module: 'env', blocked: false, pending: null, reason: '' }
    }
    return navigateModuleIn(input.state, {
      target: module,
      requires: requiresEnvironmentOf(node),
      requirement: requirementOfNode(node),
      // 门禁文案里要出现**二级目录名**（「进入【报告审核】前…」）：用户是从那一页被挡回来的。
      label: node.label,
    }, labelOf)
  }

  /**
   * 落到某个二级页面：一级目录、二级目录、正文在**同一次 emit** 里一起变。
   *
   * 被拦住时不进目标页，落到环境信息并记下 `pendingNode` —— 恢复逻辑在 `envChanged` 里。
   */
  const landOn = (node: NavigationNode, input: ModuleGateInput, epochBump: boolean): NavVerdict => {
    const current = snapshot
    const parent = parentOf(node.id)
    const parentId = parent?.id ?? current.parent
    const verdict = gateOf(node, input)
    if (verdict.blocked) {
      emit({
        ...current,
        kind: 'env',
        parent: parentId,
        node: null,
        active: 'env',
        autoEntered: true,
        selectEpoch: epochBump ? current.selectEpoch + 1 : current.selectEpoch,
        pendingNode: node.id,
        gateReason: verdict.reason,
        blocked: true,
      })
      return { ...verdict, node: node.id, empty: false }
    }
    emit({
      ...current,
      kind: 'node',
      parent: parentId,
      node: node.id,
      active: moduleOfPage(node.page),
      autoEntered: true,
      selectEpoch: epochBump ? current.selectEpoch + 1 : current.selectEpoch,
      // 成功进入任何页面都清掉待恢复目标：用户已经自己走到想去的地方了。
      pendingNode: null,
      gateReason: '',
      blocked: false,
    })
    return { ...verdict, node: node.id, empty: false }
  }

  /** 进环境信息页（永远是修复入口，不判门禁）。 */
  const landOnEnv = (parentId: string, epochBump: boolean): NavVerdict => {
    const current = snapshot
    emit({
      ...current,
      kind: 'env',
      parent: parentId === '' ? current.parent : parentId,
      node: null,
      active: 'env',
      autoEntered: true,
      selectEpoch: epochBump ? current.selectEpoch + 1 : current.selectEpoch,
      // 用户主动去环境页 = 取消上次的自动恢复意图。
      pendingNode: null,
      gateReason: '',
      blocked: false,
    })
    return ENV_VERDICT
  }

  /** 落到「该业务目录暂未开放」。 */
  const landOnEmpty = (parentId: string): NavVerdict => {
    const current = snapshot
    emit({
      ...current,
      kind: 'empty',
      parent: parentId,
      node: null,
      active: null,
      autoEntered: true,
      selectEpoch: current.selectEpoch + 1,
      pendingNode: null,
      gateReason: '',
      blocked: false,
    })
    return { module: 'env', blocked: false, pending: null, reason: '', node: null, empty: true }
  }

  /** 侧栏那张分组卡上的模块入口 → 默认页面。 */
  const navigateModule = (target: ModuleId, input: ModuleGateInput): NavVerdict => {
    if (!isModuleId(target)) return navigateEnv(input)
    if (target === 'env') return navigateEnv(input)
    const node = defaultNodeOfModule(target)
    if (node === null) return landOnEmpty(snapshot.parent)
    return landOn(node, input, true)
  }

  const navigateEnv = (_input: ModuleGateInput): NavVerdict => landOnEnv(snapshot.parent, true)

  return {
    get: () => snapshot,
    envChanged(input) {
      const current = snapshot
      // ① 第一次拿到结论：落位一次（通过 → 报告审核；否则停在环境页）。
      if (!current.autoEntered) {
        if (input.state?.proceed !== true) {
          emit({ ...current, kind: 'env', node: null, active: 'env', autoEntered: true, blocked: false, gateReason: '' })
          return
        }
        const node = defaultNodeOfModule('audit') ?? defaultNodeOfModule('eval')
        if (node === null) {
          emit({ ...current, kind: 'env', node: null, active: 'env', autoEntered: true })
          return
        }
        landOn(node, input, false)
        return
      }
      // ② 已经落位过：只有存在"被拦下来的目标"时才可能恢复，且必须现在真的能进。
      const pending = nodeById(current.pendingNode)
      if (pending === null) return
      const verdict = gateOf(pending, input)
      if (!verdict.blocked) {
        landOn(pending, input, false)
        return
      }
      // 还是进不去：留在环境页，把原因刷新成最新的一条。
      emit({
        ...current,
        kind: 'env',
        parent: parentOf(pending.id)?.id ?? current.parent,
        node: null,
        active: 'env',
        gateReason: verdict.reason,
        blocked: true,
      })
    },
    navigate: (target, input) => navigateModule(target, input),
    navigateParent(parentId, input) {
      const parent = nodeById(parentId)
      if (parent === null || parent.parentId !== null) {
        // 不认识的一级目录：不改落点，如实返回"没去任何地方"。
        return { module: 'env', blocked: false, pending: null, reason: '', node: null, empty: true }
      }
      const node = firstEnabledChild(parent.id)
      if (node === null) return landOnEmpty(parent.id)
      return landOn(node, input, true)
    },
    navigateNode(nodeId, input) {
      const node = nodeById(nodeId)
      // `enabled: false` 的二级目录**不可进入**：它只是把业务目录的全貌显示出来。
      if (node === null || node.page === null || !node.enabled) {
        return { module: 'env', blocked: false, pending: null, reason: '', node: null, empty: false }
      }
      return landOn(node, input, true)
    },
    navigateEnv,
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

/** 订阅落点状态。用 useState + useEffect，理由与 `useEnvStatus` 相同（产物冒烟用的是极小的 react 替身）。 */
export function useModule(store: ModuleStore): ModuleSnapshot {
  const [snapshot, setSnapshot] = React.useState<ModuleSnapshot>(store.get())
  React.useEffect(() => {
    setSnapshot(store.get())
    return store.subscribe(() => { setSnapshot(store.get()) })
  }, [store])
  return snapshot
}
