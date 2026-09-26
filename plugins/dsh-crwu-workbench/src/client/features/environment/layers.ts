import type { ServiceCheckView } from '../../../shared/types.ts'
import type { EnvResult } from '../report-audit/api.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 环境自检页的**分层规则**（纯函数，组件只渲染）。
 *
 * 为什么单独一个模块：这一页旧的毛病不是"不好看"，是**没有层次** —— 5/5 都通过的工具和
 * "氚云没登录"同权重地堆在一列里，维护者噪声（sha256、清单来源、probe 原文）混在员工视野里，
 * 而且只有 iFinD 给了"怎么配"。分层、排序、状态词、"怎么办"这四件事全是判断，放在组件里
 * 就只能靠人眼看界面来验证，所以抽到这里由单测覆盖。
 *
 * **②..⑥ 五层固定顺序**（员工排查顺序）：
 *   ② 插件内置组件（一个聚合项）/ ③ DSH 脚本运行时 / ④ 登录与凭据授权 / ⑤ OSS 交付配置 / ⑥ 外部数据。
 * ① 案例根目录由 `WorkspaceCard` 承担（它要先于这五层），**不属于** layers。
 *
 * 三件随包组件（crwu / dws / ossutil）合并成**一个**聚合项是刻意的：它们要么一起在包里、
 * 要么一起不在（未装配 / 平台不受支持），各占一行只会让员工以为要分别装三个命令。
 */

export type EnvItemState = 'ok' | 'missing' | 'reauth'
export type EnvLayerId = 'packages' | 'runtime' | 'auth' | 'delivery' | 'external'
/** 该项"怎么配"要用哪种交互；`none` = 已就绪、不需要动。 */
export type EnvFixKind = 'none' | 'packages' | 'runtime' | 'h3yun' | 'dws' | 'oss' | 'ifind'

export interface EnvLayerItem {
  id: string
  /** 显示名（组件与运行时用本地聚合名，服务用 Host 的 label）。 */
  name: string
  state: EnvItemState
  /** 状态词：已就绪 / 未配置 / 能力缺口 / Host 原文（未绑定、未登录、探测失败…）。 */
  stateText: string
  /** 一句人话：它是干什么用的。 */
  purpose: string
  /** 现在是什么情况（聚合计数 / 版本 / AK 掩码 / 连通性）。 */
  meta: string
  /** 没就绪的原因（Host 原文优先，不改写）。 */
  reason: string
  /** 怎么配置（人话）；已就绪时是空串。 */
  fix: string
  fixKind: EnvFixKind
  /** 缺失时会不会阻塞审核（Host 清单里的 `required`）。可选项目只作为诊断信息展示。 */
  required: boolean
  /** 以下三项只进"排查详情"，员工视野里不出现。 */
  expect: string
  detail: string
  note: string
}

export interface EnvLayer {
  id: EnvLayerId
  title: string
  /** 通过数 / 总数，用于 `x/y 已就绪`。 */
  pass: number
  total: number
  /** 本层有没有没就绪的项（决定默认展开还是收成一行）。 */
  needsWork: boolean
  /** 没就绪的项排在最前；同组内保持 Host 给的顺序。 */
  items: EnvLayerItem[]
}

/** 状态词：Host 的 `state` 是外部原始数据（未绑定 / 未登录 / 探测失败），按原样显示更能说明问题。 */
function authStateText(state: string): string {
  if (state === '已过期') return zhCN.envItemReauth
  if (state === '') return zhCN.envItemMissing
  return state
}

/** 没就绪的排在前面（稳定：同组内保持原顺序）。 */
function notReadyFirst(items: EnvLayerItem[]): EnvLayerItem[] {
  return [...items.filter((item) => item.state !== 'ok'), ...items.filter((item) => item.state === 'ok')]
}

/**
 * 汇总一层。
 *
 * **只有必需项参与 `pass` / `total` / `needsWork`。** 可选项缺失不该让这一层显示「0/1 已就绪」
 * 并默认展开 —— 那与 Hero 那句「环境就绪、可以开始审核」自相矛盾，而本仓反复要求的就是
 * 「别把不需要处理的东西说成需要处理」。可选项目仍会出现在展开后的列表里。
 *
 * 一层里一个必需项都没有（例如运行时被标成可选）时退回按全部项目计，免得显示成 `0/0`。
 */
function layerOf(id: EnvLayerId, title: string, items: EnvLayerItem[]): EnvLayer {
  const required = items.filter((item) => item.required)
  const counted = required.length > 0 ? required : items
  const pass = counted.filter((item) => item.state === 'ok').length
  return { id, title, pass, total: counted.length, needsWork: pass < counted.length, items: notReadyFirst(items) }
}

/**
 * ② 插件内置组件：**一个**聚合项。
 *
 * 判据全在 Host 的 `packageIntegrity` 里（包内文件 + 包内清单字节数）；这里只做聚合与文案。
 * 失败时**不许**出现「请安装 crwu / dws / ossutil」—— 它们随插件发布，员工机器上零安装。
 */
function packageItem(env: EnvResult): EnvLayerItem {
  const integrity = env.packageIntegrity
  const total = integrity.tools.length
  const ready = integrity.tools.filter((tool) => tool.ok).length
  const ok = integrity.ok === true
  const failed = integrity.tools.filter((tool) => !tool.ok)
  return {
    id: 'packages',
    name: zhCN.envItemPackagesName,
    state: ok ? 'ok' : 'missing',
    stateText: ok ? zhCN.envItemOk : zhCN.envPackagesBroken,
    purpose: zhCN.envPackagesPurpose,
    meta: ok ? `${zhCN.envItemPackagesName} ${String(ready)}/${String(total)} ${zhCN.envPackagesComplete}` : '',
    reason: ok
      ? ''
      : (failed.map((tool) => tool.reason).filter((reason) => reason !== '').join('；') || integrity.note || zhCN.envPackagesBroken),
    fix: ok ? '' : zhCN.envFixPackages,
    fixKind: ok ? 'none' : 'packages',
    required: true,
    expect: '',
    detail: '',
    note: integrity.note,
  }
}

/** ③ 运行时的状态词：能力缺口 / 缺包 / Host 原文三种要能分辨。 */
function runtimeStateText(runtime: EnvResult['runtime']): string {
  if (runtime.state === 'capability-gap') return zhCN.envRuntimeStateGap
  if (runtime.state === 'missing-package') {
    return runtime.missingPackages.length === 0
      ? zhCN.envRuntimeStateMissingPackage
      : `${zhCN.envRuntimeStateMissingPackage}：${runtime.missingPackages.join('、')}`
  }
  if (runtime.state === '') return zhCN.envItemMissing
  return runtime.state
}

/** 依赖包版本：按清单里 `requiredPackages` 的顺序排，其余附在后面。 */
function distributionPairs(runtime: EnvResult['runtime']): Array<[string, string]> {
  const entries = Object.entries(runtime.distributions)
  const order = new Map(runtime.requiredPackages.map((name, index) => [name, index]))
  return entries.sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
}

/**
 * ③ DSH 脚本运行时（Python）。
 *
 * 来源必须明说「DSH 自带」：写成系统 Python 会把员工指去装一份插件根本不会用的解释器，
 * 而 `capability-gap` 的处置是「重启 profile / 找维护者接线」，不是「装 Python」。
 */
function runtimeItem(env: EnvResult): EnvLayerItem {
  const runtime = env.runtime
  const ok = runtime.ok === true
  const pairs = distributionPairs(runtime)
  const meta = runtime.versionText === '' && pairs.length === 0
    ? ''
    : [
        runtime.versionText === '' ? '' : `Python ${runtime.versionText}`,
        ...pairs.map(([name, version]) => `${name} ${version}`),
        `${zhCN.envRuntimeSourceLabel}${runtime.source === '' ? zhCN.envRuntimeName : runtime.source}`,
      ].filter((part) => part !== '').join(' · ')
  const missing = runtime.missingPackages.length === 0
    ? ''
    : `${zhCN.envRuntimeMissingPackages}${runtime.missingPackages.join('、')}`
  return {
    id: 'runtime',
    name: zhCN.envRuntimeName,
    state: ok ? 'ok' : 'missing',
    stateText: ok ? zhCN.envItemOk : runtimeStateText(runtime),
    purpose: runtime.note === '' ? zhCN.envRuntimePurpose : runtime.note,
    meta: ok ? meta : '',
    reason: ok ? '' : (missing || runtime.error || zhCN.envRuntimeStateGap),
    fix: ok ? '' : zhCN.envFixRuntime,
    fixKind: ok ? 'none' : 'runtime',
    required: runtime.required === true,
    expect: runtime.expect,
    detail: ok ? '' : runtime.path,
    note: runtime.note,
  }
}

/** ④ 登录与凭据授权：Host 的 `services`（氚云 / 钉钉）。 */
function authItem(service: ServiceCheckView): EnvLayerItem {
  const ok = service.ok === true
  const purpose = service.id === 'h3yun'
    ? zhCN.envPurposeH3yun
    : (service.id === 'dingtalk' ? zhCN.envPurposeDingtalk : '')
  // 没授权时，"怎么办"就是先授权（其它步骤在授权前都做不了）；授权后才是登录/重登那条路径。
  const fix = service.state === '需要授权'
    ? zhCN.envFixAuthorize
    : (service.id === 'h3yun'
      ? zhCN.envFixH3yun
      : (service.id === 'dingtalk' ? zhCN.envFixDws : zhCN.envFixService))
  return {
    id: `service-${service.id}`,
    name: service.label,
    state: ok ? 'ok' : (service.state === '已过期' ? 'reauth' : 'missing'),
    stateText: ok ? zhCN.envItemOk : authStateText(service.state),
    purpose,
    // 同一个 detail 只出现一次：就绪时当"现在是什么情况"，没就绪时当"为什么没过"
    // （两边都填会在界面上原样重复两遍 —— 实测渲染出来就是这样）。
    meta: ok ? service.detail : '',
    reason: ok ? '' : service.detail,
    fix: ok ? '' : fix,
    fixKind: ok ? 'none' : (service.id === 'h3yun' ? 'h3yun' : (service.id === 'dingtalk' ? 'dws' : 'none')),
    required: service.required === true,
    expect: '',
    detail: service.detail,
    note: '',
  }
}

/** ⑤ OSS 交付配置：凭据文件（AK）+ Host 的连通性实测。两条都算数：写进文件 ≠ 能用。 */
function deliveryItem(env: EnvResult): EnvLayerItem {
  const delivery = env.delivery
  const cred = delivery.ossCred
  const probe = delivery.probe
  const credReady = cred.exists === true && cred.hasSecret === true
  const connectivityOk = probe?.ok === true
  const ok = credReady && connectivityOk
  const masked = cred.accessKeyIdMasked === '' ? zhCN.envOssCredMissing : cred.accessKeyIdMasked
  const probeState = probe?.state ?? ''
  const file = cred.path === '' ? '~/.ossutilconfig' : cred.path
  const meta = `${file} · AK ${masked}${probeState === '' ? '' : ` · ${probeState}`}`
  const reason = ok
    ? ''
    : (!cred.exists ? zhCN.envOssReasonNoCred : (!cred.hasSecret ? zhCN.envOssReasonNoSecret : (probe?.detail ?? '')))
  return {
    id: 'oss-cred',
    name: zhCN.envItemOssName,
    state: ok ? 'ok' : 'missing',
    stateText: ok ? zhCN.envItemOk : zhCN.envItemMissing,
    purpose: zhCN.envPurposeOss,
    meta,
    reason,
    fix: ok ? '' : zhCN.envFixOss,
    fixKind: ok ? 'none' : 'oss',
    required: probe?.required ?? true,
    expect: '',
    detail: probe?.detail ?? '',
    note: delivery.oss.ossutilReady ? '' : zhCN.envOssOssutilMissing,
  }
}

/** ⑥ 外部数据：同花顺 iFinD 的 auth_token（只回长度，绝不回显）。 */
function externalItem(env: EnvResult): EnvLayerItem {
  const ifind = env.external
  const ok = ifind.ok === true
  const where = ifind.path === '' ? zhCN.envUnset : ifind.path
  return {
    id: 'ifind-token',
    name: zhCN.ifindItemName,
    state: ok ? 'ok' : 'missing',
    stateText: ok ? zhCN.envItemOk : zhCN.envItemMissing,
    purpose: zhCN.envPurposeIfind,
    meta: ok
      ? `${zhCN.envIfindPath} ${where} · ${zhCN.ifindConfigured}${String(ifind.tokenLength)}${zhCN.ifindNoEcho}`
      : `${zhCN.envIfindPath} ${where}`,
    reason: ok ? '' : (ifind.reason === '' ? zhCN.ifindMissing : ifind.reason),
    fix: ok ? '' : `${zhCN.envFixIfind}${where}${zhCN.envFixIfindField}${zhCN.envFixIfindExample}${zhCN.envFixIfindNote}`,
    fixKind: ok ? 'none' : 'ifind',
    required: ifind.required === true,
    expect: '',
    detail: '',
    note: '',
  }
}

/** 五层的完整结构（顺序固定：② 组件 → ③ 运行时 → ④ 授权 → ⑤ 交付 → ⑥ 外部数据）。 */
export function envLayers(env: EnvResult): EnvLayer[] {
  return [
    layerOf('packages', zhCN.envLayerPackages, [packageItem(env)]),
    layerOf('runtime', zhCN.envLayerRuntime, [runtimeItem(env)]),
    layerOf('auth', zhCN.envLayerAuth, env.services.map(authItem)),
    layerOf('delivery', zhCN.envLayerDelivery, [deliveryItem(env)]),
    layerOf('external', zhCN.envLayerExternal, [externalItem(env)]),
  ]
}

export interface EnvLayerSet {
  packages: EnvLayer
  runtime: EnvLayer
  auth: EnvLayer
  delivery: EnvLayer
  external: EnvLayer
}

/**
 * 按 id 取五层。
 *
 * 组件里刻意不走下标（`layers[0]`）：层顺序哪天变了，下标会**静默**画错一层；这里找不到就抛。
 */
export function envLayerSet(env: EnvResult): EnvLayerSet {
  const all = envLayers(env)
  const pick = (id: EnvLayerId): EnvLayer => {
    const hit = all.find((layer) => layer.id === id)
    if (hit === undefined) throw new Error(`envLayers 未返回 ${id} 层`)
    return hit
  }
  return {
    packages: pick('packages'),
    runtime: pick('runtime'),
    auth: pick('auth'),
    delivery: pick('delivery'),
    external: pick('external'),
  }
}

/** 员工视野里"还差什么"的一句话（Hero 用 Host 的权威清单，不自己拼结论）。 */
export function envTodoText(env: EnvResult): string {
  if (env.allOk === true) return zhCN.envHeroOkSub
  if (env.blocked.length === 0) return zhCN.envHeroBadSub
  return `${zhCN.envHeroTodo}${String(env.blocked.length)}${zhCN.envHeroTodoTail}`
}
