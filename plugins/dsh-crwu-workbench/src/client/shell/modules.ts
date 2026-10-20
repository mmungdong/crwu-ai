import { zhCN } from '../locales/zh-CN.ts'
import type { EnvLampTone } from '../modules/environment/model/status.ts'
import type { EnvironmentRequirement } from '../../shared/environment/model.ts'

/**
 * 工作台的三个模块（纯数据 + 纯判断，可单测）。
 *
 * 顺序就是侧栏那张分组卡上从上到下的顺序，**不要按条件重排**：那张卡是常驻控件，
 * 位置一变用户就得重新找。开发中标记不影响模块入口。
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
  /** Development status shown beside the module entry. */
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

/** Whether the sidebar entry displays the development tag. */
export function isUnderDevelopment(id: ModuleId): boolean {
  return MODULE_META[id].underDevelopment === true
}

// 「首次进入工作台停在哪一页」不在这里：落点现在是一个二级目录节点（审核 / 报告审核），
// 由 `navigation.ts` 的 `defaultNodeOfModule('audit')` 给出，`module-store.envChanged()`
// 在第一次拿到环境结论时用它自动落位（口径不变：通过就直接进报告审核，不通过停在环境信息页）。

/** 侧栏底部入口右侧那枚环境标记的文案（悬停看得见结论，不用先点开）。 */
export function envMarkTitle(tone: EnvLampTone): string {
  if (tone === 'ok') return zhCN.moduleEnvMarkOk
  if (tone === 'bad') return zhCN.moduleEnvMarkBad
  if (tone === 'busy') return zhCN.moduleEnvMarkBusy
  return zhCN.moduleEnvMarkIdle
}
