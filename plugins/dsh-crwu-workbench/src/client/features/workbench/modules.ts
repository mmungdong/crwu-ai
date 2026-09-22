import { zhCN } from '../../locales/zh-CN.ts'
import type { EnvLampTone } from '../environment/status.ts'

/**
 * 工作台的三个模块（纯数据 + 纯判断，可单测）。
 *
 * 顺序就是侧栏那张分组卡上从上到下的顺序，**不要按条件重排**：那张卡是常驻控件，
 * 位置一变用户就得重新找。「报告评估」还没开发，但它照样占一个固定子项 ——
 * 点得开、只给占位说明，用户才知道这里将来有什么。
 */

export type ModuleId = 'eval' | 'audit' | 'env'

/** 侧栏分组卡上子项的固定顺序。 */
export const MODULE_IDS: readonly ModuleId[] = ['eval', 'audit', 'env']

export function isModuleId(value: string): value is ModuleId {
  return value === 'eval' || value === 'audit' || value === 'env'
}

/** 模块名（侧栏子项与面板标题共用）。 */
export function moduleLabel(id: ModuleId): string {
  if (id === 'eval') return zhCN.moduleEval
  if (id === 'audit') return zhCN.moduleAudit
  return zhCN.moduleEnv
}

/**
 * 这个子项是不是还没开发 —— 侧栏要在它旁边画一枚「开发中」小图标（沙漏）。
 *
 * 用户 2026-09-22 的口径：这一处**只给图标、不给文字**（文字版角标看着像功能标签），
 * 结论靠图标的 title / aria-label 说；「开发中」三个字只出现在占位页正文里。
 */
export function isUnderDevelopment(id: ModuleId): boolean {
  return id === 'eval'
}

/**
 * 首次进入工作台时停在哪一页。
 *
 * 口径沿用重构前那条（用户当面确认过）：**环境自检通过就直接进报告审核**，
 * 不通过就停在环境信息页。手动切过模块之后不再自动跳（由模块 store 的 autoEntered 记住），
 * 否则用户刚点回环境页就会被弹走。
 */
export function defaultModule(envOk: boolean): ModuleId {
  return envOk ? 'audit' : 'env'
}

/** 侧栏底部入口右侧那枚环境标记的文案（悬停看得见结论，不用先点开）。 */
export function envMarkTitle(tone: EnvLampTone): string {
  if (tone === 'ok') return zhCN.moduleEnvMarkOk
  if (tone === 'bad') return zhCN.moduleEnvMarkBad
  if (tone === 'busy') return zhCN.moduleEnvMarkBusy
  return zhCN.moduleEnvMarkIdle
}
