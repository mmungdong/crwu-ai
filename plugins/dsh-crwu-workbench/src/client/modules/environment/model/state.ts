import type { EnvResultView } from '../../../../shared/contracts/environment.ts'
import type { EnvironmentIssueView, EnvironmentStateView, EnvironmentTally } from '../../../../shared/environment/model.ts'
import {
  blockerMessages,
  degradedMessages,
  primaryUserIssue,
  requiredTallyOf,
  statusProceedable,
} from '../../../../shared/environment/model.ts'

/**
 * 环境事实的**派生值**（统一环境模型 + 结论卡）。
 *
 * ## 为什么它属于 environment 模块
 *
 * 这两样只吃**环境事实**，与审核毫无关系。它们原先长在 `modules/report-audit/api.ts` 里，
 * 于是环境页必须反向 import 报告审核门面 —— 方案 §4.1 明确禁止：方向一反，
 * "审核门面改一个字段"就会牵动环境页，而环境页是修复入口，最不该被业务改动波及。
 *
 * 判据本身仍然只有一处：`shared/environment/model.ts`。这里只做"取出来 + 算结论"。
 */

/**
 * 取统一环境模型。
 *
 * 旧宿主不带 `state` 时返回 `null`（界面按"不认识 → 不放行"处理）—— 这正是协议号存在的意义：
 * 界面是新的、宿主是旧的时，宁可拦下来让用户重启 profile，也不能按旧逻辑放行新操作。
 */
export function environmentStateOf(env: EnvResultView | null | undefined): EnvironmentStateView | null {
  if (env === null || env === undefined) return null
  const state = env.state
  if (state === null || state === undefined || typeof state !== 'object') return null
  return state
}

/** 环境页顶部的结论卡需要的全部派生值（一处算清，组件只画）。 */
export interface EnvironmentHeadline {
  status: string
  proceed: boolean
  passed: number
  total: number
  ratio: number
  blockers: string[]
  degraded: string[]
  /** 员工唯一该做的那一件事（系统/管理员故障不给员工派活）。 */
  primary: EnvironmentIssueView | null
}

export function headlineOf(env: EnvResultView | null | undefined): EnvironmentHeadline {
  const state = environmentStateOf(env)
  if (state === null) {
    return {
      status: 'unknown', proceed: false, passed: 0, total: 0, ratio: 0,
      blockers: env?.blocked ?? [], degraded: [], primary: null,
    }
  }
  const tally: EnvironmentTally = requiredTallyOf({ systemHealth: state.systemHealth, userSetup: state.userSetup })
  return {
    status: state.status,
    proceed: statusProceedable(state.status),
    passed: tally.passed,
    total: tally.total,
    ratio: tally.ratio,
    blockers: blockerMessages(state),
    degraded: degradedMessages(state),
    primary: primaryUserIssue(state),
  }
}
