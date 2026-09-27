import { zhCN } from '../../locales/zh-CN.ts'
import type { EnvResult } from '../report-audit/api.ts'
import type { SetupItemView } from '../../../shared/environment/model.ts'

/**
 * 环境页的**步骤模型**（纯逻辑，可单测）。
 *
 * ## 为什么要有这一层
 *
 * 旧版把每一项平铺成一长行、从上到下堆叠：员工打开页面看到的是"一列检查结果"，
 * 而不是"我接下来要做什么"。新版是**引导式配置工作区**（左侧步骤导航 + 右侧当前步骤），
 * 于是「有哪几步、每步什么状态、默认停在哪一步」必须有**一份**判据 ——
 * 它不能散在组件的 if 里，否则"默认停在第一项未完成"和"用户选过之后不许抢焦点"
 * 这两条规则就会在别处被重写一遍。
 *
 * ## 两条不许退回去的交互规则
 *
 * 1. **默认停在第一项未完成的步骤**（全部完成时停在最后一项，页面给一句完成摘要）；
 * 2. **用户手动选过之后，后台刷新不得把他切回去** —— 由 `pickStep` 的 `manual` 入参保证：
 *    只要用户选过（`manual !== null`）就无条件用他的选择，哪怕那一步刚刚变成"已完成"。
 */

export type SetupStepKind = 'accounts' | 'oss' | 'ifind' | 'workspace'
export type SetupStepState = 'done' | 'todo' | 'doing'

export interface SetupStepView {
  id: SetupStepKind
  /** 步骤序号（1 起，界面上显示给用户）。 */
  index: number
  title: string
  /** 一句话说清这一步是干什么的。 */
  hint: string
  state: SetupStepState
  /** 给状态标签用的短词（已完成 / 待处理 / 进行中）。 */
  stateText: string
  /** 是不是必需项（自 2026-09-26 起四项都是必需项；保留字段是为了以后加可选步骤）。 */
  required: boolean
}

/** 固定顺序 = 用户的操作顺序，**不按状态重排**（导航位置一变，用户就要重新找）。 */
export const SETUP_STEP_IDS: readonly SetupStepKind[] = ['accounts', 'oss', 'ifind', 'workspace']

/** 四项必需项的 `SetupItemView`（从统一环境模型里取；缺 state 时给空视图）。 */
export interface SetupStepInput {
  authorized: boolean
  h3yun: SetupItemView
  dingtalk: SetupItemView
  oss: SetupItemView
  ifind: SetupItemView
  workspace: SetupItemView
}

const MISSING: SetupItemView = { state: 'unknown', value: '', reason: '', required: true }

/** 从 `EnvResult` 里取出四项必需项；旧宿主没有 `state` 时给空视图（页面另有旧宿主提示）。 */
export function setupStepInput(env: EnvResult, authorized: boolean | undefined): SetupStepInput {
  const setup = env.state?.userSetup
  return {
    authorized: authorized ?? env.trust.credentials,
    h3yun: setup?.h3yun ?? MISSING,
    dingtalk: setup?.dingtalk ?? MISSING,
    oss: setup?.aliyunOss ?? MISSING,
    ifind: setup?.ifind ?? MISSING,
    workspace: setup?.workspace ?? MISSING,
  }
}

function itemDone(item: SetupItemView): boolean {
  return item.state === 'ok' || item.state === 'authenticated'
}

/** 每一步的完成判据（**只读统一环境模型**，页面不再自己算）。 */
export function stepDone(id: SetupStepKind, input: SetupStepInput): boolean {
  if (id === 'accounts') {
    return input.authorized && itemDone(input.h3yun) && itemDone(input.dingtalk)
  }
  if (id === 'oss') return itemDone(input.oss)
  if (id === 'ifind') return itemDone(input.ifind)
  return itemDone(input.workspace)
}

function titleOf(id: SetupStepKind): string {
  if (id === 'accounts') return zhCN.envStepAccounts
  if (id === 'oss') return zhCN.envStepOss
  if (id === 'ifind') return zhCN.envStepIfind
  return zhCN.envStepWorkspace
}

function hintOf(id: SetupStepKind): string {
  if (id === 'accounts') return zhCN.envStepHintAccounts
  if (id === 'oss') return zhCN.envStepHintOss
  if (id === 'ifind') return zhCN.envStepHintIfind
  return zhCN.envStepHintWorkspace
}

/**
 * 步骤清单。
 *
 * `active` 那一步（用户正在看的）在未完成时显示「进行中」—— 这样左侧导航与右侧详情
 * 说的是同一件事（用户不用猜"待处理"和"当前正在处理"是不是一回事）。
 */
export function setupSteps(input: SetupStepInput, active: SetupStepKind | null = null): SetupStepView[] {
  return SETUP_STEP_IDS.map((id, offset) => {
    const done = stepDone(id, input)
    const state: SetupStepState = done ? 'done' : (active === id ? 'doing' : 'todo')
    const stateText = done ? zhCN.envStepDone : (state === 'doing' ? zhCN.envStepDoing : zhCN.envStepTodo)
    return {
      id,
      index: offset + 1,
      title: titleOf(id),
      hint: hintOf(id),
      state,
      stateText,
      required: true,
    }
  })
}

/**
 * 当前该显示哪一步。
 *
 * 优先级：**用户选过就用他选的**（`manual` 不为 null）→ 第一项未完成 → 最后一项。
 * 第二步是本次改造的核心交互要求：后台刷新不许把用户从他看的步骤上抢走。
 */
export function pickStep(steps: readonly SetupStepView[], manual: SetupStepKind | null): SetupStepKind {
  if (manual !== null && steps.some((step) => step.id === manual)) return manual
  const firstTodo = steps.find((step) => step.state !== 'done')
  if (firstTodo !== undefined) return firstTodo.id
  return steps.length === 0 ? 'accounts' : steps[steps.length - 1].id
}

/** 全部完成？页面据此显示一句完成摘要而不是"还需完成 0 项"。 */
export function allStepsDone(steps: readonly SetupStepView[]): boolean {
  return steps.length > 0 && steps.every((step) => step.state === 'done')
}

/**
 * 「最近的**真实验证**时间」。
 *
 * 只认被真的打过外部请求的那两项（iFinD 取数、OSS 列举），取较晚的一个；都没有就返回空串。
 * 它与"最近检查时间"不是一回事：缓存命中时的检查没有真的重新请求，界面不能假装刚刚验过。
 */
export function lastVerifiedAt(env: EnvResult, checkedAt = ''): string {
  // iFinD 的 `checkedAt` 是它自己那次真探的时刻。OSS 的探测结果里没有独立时间戳，但
  // `probeOss` **每次环境校验都会真跑**（没有缓存），所以"OSS 这次通过 + 这次自检的时刻"
  // 就是它的真实验证时刻 —— 只有它在**通过**时才这么取，否则会把"刚检查过"说成"刚验证过"。
  // 旧宿主可能根本没有 `delivery.probe`：缺字段时只认 iFinD 那一个时刻（不是编时间）。
  const ossVerified = env.delivery?.probe?.ok === true ? checkedAt : ''
  const candidates = [env.external?.checkedAt, ossVerified]
    .map((value) => Date.parse(value ?? ''))
    .filter((value) => !Number.isNaN(value))
  if (candidates.length === 0) return ''
  return new Date(Math.max(...candidates)).toISOString()
}
