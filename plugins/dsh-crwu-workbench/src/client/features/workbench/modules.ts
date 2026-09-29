import { zhCN } from '../../locales/zh-CN.ts'
import type { EnvLampTone } from '../environment/status.ts'
import type { EnvironmentRequirement } from '../../../shared/environment/model.ts'

/**
 * 工作台的三个模块（纯数据 + 纯判断，可单测）。
 *
 * 顺序就是侧栏那张分组卡上从上到下的顺序，**不要按条件重排**：那张卡是常驻控件，
 * 位置一变用户就得重新找。「报告评估」还没开发，但它照样占一个固定子项 ——
 * 点得开、只给占位说明，用户才知道这里将来有什么。
 *
 * ⚠️ 外部数据源（iFinD）**不是**第四个模块（用户口径 2026-09-30）：它是环境信息页**配置列表里的一步**
 * （见 `features/environment/steps.ts`，必检与否用红色星号区分）。外部数据源是可选的，单开一页会读成
 * "又一个要配置的模块"，而它要表达的事实本来就属于环境自检。
 */

export type ModuleId = 'eval' | 'audit' | 'env'

/** 侧栏分组卡上子项的固定顺序。 */
export const MODULE_IDS: readonly ModuleId[] = ['eval', 'audit', 'env']

/**
 * 模块元数据：**页面是否需要环境**在数据里声明一次，不写在各处的 if 里。
 *
 * 需求原话是「在模块元数据中声明页面是否需要环境，例如 `requiresEnvironment`」——
 * 以前这条判据长在 `WorkbenchPanel` 的 audit 分支上，于是只有面板里的那一页受控，
 * 侧栏子项、报告页内跳转、以后新增的页都各有各的判断。
 *
 * `env` 自己**永远不需要环境**：它就是修复入口（外部数据核查区块也在这一页里），
 * 把它也拦住会让用户没有出路。
 */
export interface ModuleMeta {
  id: ModuleId
  /** 进入这一页要不要先过环境门禁。 */
  requiresEnvironment: boolean
  /** 需要多严：`global` 覆盖一切，`audit` 只覆盖报告审核。 */
  requirement: EnvironmentRequirement
  /** 还没开发完（侧栏画小标签、正文画占位页）。 */
  underDevelopment: boolean
}

export const MODULE_META: Record<ModuleId, ModuleMeta> = {
  eval: { id: 'eval', requiresEnvironment: true, requirement: 'global', underDevelopment: true },
  audit: { id: 'audit', requiresEnvironment: true, requirement: 'audit', underDevelopment: false },
  env: { id: 'env', requiresEnvironment: false, requirement: 'global', underDevelopment: false },
}

/** 目标页有没有声明"需要环境"。数据驱动，不按 id 硬编码。 */
export function requiresEnvironment(id: ModuleId): boolean {
  return MODULE_META[id].requiresEnvironment === true
}

/** 目标页需要的严格度。 */
export function requirementOf(id: ModuleId): EnvironmentRequirement {
  return MODULE_META[id].requirement
}


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
  return MODULE_META[id].underDevelopment === true
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
