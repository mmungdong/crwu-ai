/**
 * 本机访问授权（local access consent）的**线协议类型与常量**。
 *
 * ## 为什么要有「版本化授权收据」而不是一个布尔值
 *
 * 旧状态只有一个 `trustCredentials: boolean`。它回答不了三件事：
 * 1. **授的是什么范围** —— 员工同意「读本机凭据」时，插件实际会读氚云钥匙串、写
 *    `~/.ossutilconfig`、写 `~/.dsh/crwu-workbench`；布尔值表达不了这个清单；
 * 2. **什么时候授的** —— 排障时要能对上「授权之后才出现的这个故障」；
 * 3. **范围升级后旧的同意还算不算** —— 布尔值只有 true/false，加一项新能力时
 *    旧机器的 `true` 会被当成「已经同意了新范围」，这是**静默扩权**。
 *
 * 所以授权是一条收据：`schemaVersion` + `grantedAt` + 精确的 capability 集合。
 * 读盘时任何不认识、缺失、多余或重复的能力项都让收据判成 `outdated`（**永不**当成授权），
 * 于是升级范围必然重新询问一次。
 *
 * ## 为什么放在 `shared/`
 *
 * 两侧都要用同一份判据：Host 用它决定放行，Client 用它渲染「允许/撤销」与说明文案。
 * 各写一份的后果是两边对「什么算已授权」的理解迟早漂移 —— 界面显示已授权、Host 实际拒绝。
 *
 * 本文件**不许 import** 任何 Host / Client 专有模块（它要被两边共用、也要能直接单测）。
 */

/** 当前授权收据的 schema 版本。范围或语义变化时必须 +1。 */
export const LOCAL_ACCESS_SCHEMA_VERSION = 1 as const

/**
 * 线协议上的字段名（`boot.permissionSchemaVersion`）。
 *
 * 与 `LOCAL_ACCESS_SCHEMA_VERSION` 是**同一个数**，别名只为了在握手处读起来是「权限说明版本」——
 * 客户端比对的是「我这份界面写的说明，和宿主实际执行的判据是不是同一版」。
 */
export const PERMISSION_SCHEMA_VERSION = LOCAL_ACCESS_SCHEMA_VERSION

/**
 * 工作台需要访问本机的**固定能力清单**（顺序即界面与收据的规范顺序）。
 *
 * 这五项对应「员工看得见的功能」，不是内部实现分类：
 * - `h3yun-credential-store`：操作系统凭据存储里的氚云会话；
 * - `dws-profile`：`%USERPROFILE%\.dws`（钉钉登录态与 DWS 状态目录）；
 * - `oss-config`：`%USERPROFILE%\.ossutilconfig`（交付件回传的 AK/SK）；
 * - `ifind-credential`：`.dsh/crwu-workbench` 下的 iFinD API-Key 与工作台状态；
 * - `system-integration`：打开系统浏览器（登录）、写系统剪贴板、在文件管理器里定位案例目录、
 *   在**员工选定的工作空间**里创建本轮案例目录（`<工作空间>/<流水号>`，插件唯一自动创建的一级目录）。
 */
export const LOCAL_ACCESS_CAPABILITIES = [
  'h3yun-credential-store',
  'dws-profile',
  'oss-config',
  'ifind-credential',
  'system-integration',
] as const

export type LocalAccessCapability = (typeof LOCAL_ACCESS_CAPABILITIES)[number]

/**
 * 授权收据的状态。
 *
 * `missing` / `outdated` / `revoked` 三者的**处置不同**，所以不许压成一个布尔：
 * - `missing`：从没问过 —— 首次打开就走这条；
 * - `outdated`：问过，但那是上一版范围（含旧版 `trustCredentials:true`）—— 要说清「范围变了」；
 * - `revoked`：员工主动撤销 —— 不许再自动弹一次「要不要允许」，要等他点。
 *
 * `persist-failed` 只在**撤销**路径出现：内存里已经关掉（fail closed），但收据没能写进磁盘。
 */
export type LocalAccessConsentState = 'missing' | 'outdated' | 'granted' | 'revoked' | 'persist-failed'

/** 落盘形态（`localAccessConsent` 键）。 */
export interface LocalAccessConsentRecord {
  schemaVersion: typeof LOCAL_ACCESS_SCHEMA_VERSION
  /** 授权时刻（ISO 8601）。撤销墓碑里保留原授权时刻之外的新时刻也无妨，界面只在 granted 时展示。 */
  grantedAt: string
  /** **规范顺序**的完整能力集合；空数组是「已撤销」的墓碑。 */
  capabilities: LocalAccessCapability[]
}

/** 界面上看到的样子（**永远**由 Host 从真实收据推出来，Client 不自己算）。 */
export interface LocalAccessConsentView {
  state: LocalAccessConsentState
  /** 读到的收据版本；没有收据时是 0。 */
  schemaVersion: number
  /** 当前代码要求的收据版本（`LOCAL_ACCESS_SCHEMA_VERSION`）。 */
  requiredSchemaVersion: typeof LOCAL_ACCESS_SCHEMA_VERSION
  /** 授权时刻；非 `granted` 时是空串。 */
  grantedAt: string
  /** 已授权的能力集合（规范顺序）；非 `granted` 时是空数组。 */
  capabilities: LocalAccessCapability[]
  /** 一句话说明「为什么现在是这个状态」（界面原文展示，空串表示无需解释）。 */
  reason: string
}

/**
 * 授权前，凭据类检查项统一使用的原因文案。
 *
 * **一句话，全仓一份**：氚云 / 钉钉 / OSS / iFinD 在未授权时都必须显示它，
 * 不许显示 `未登录` / `密钥错误` / `未找到` —— 那些是**未经探测**的假结论，
 * 会把员工指去重新扫码或换密钥，而真正要做的是先授权。
 */
export const LOCAL_ACCESS_REQUIRED_REASON = '需要先允许工作台访问本机账号和配置'

/** 是不是一个已知的能力取值。 */
export function isLocalAccessCapability(value: unknown): value is LocalAccessCapability {
  return typeof value === 'string' && (LOCAL_ACCESS_CAPABILITIES as readonly string[]).includes(value)
}

/** 规范顺序的能力清单（授权提交与收据落盘都用它，避免各处手写数组顺序）。 */
export function canonicalLocalAccessCapabilities(): LocalAccessCapability[] {
  return [...LOCAL_ACCESS_CAPABILITIES]
}

/**
 * 提交的能力集合是不是**恰好**等于规范集合。
 *
 * 判据刻意严格（缺一、多一、重复、顺序不同都算不匹配）：客户端提交的顺序就是收据的顺序，
 * 于是「界面显示的清单」与「落盘的清单」永远字面一致。被改过的客户端无法提交一个
 * 与界面不同的范围。
 */
export function isCanonicalLocalAccessRequest(value: unknown): value is LocalAccessCapability[] {
  if (!Array.isArray(value) || value.length !== LOCAL_ACCESS_CAPABILITIES.length) return false
  return value.every((item, index) => item === LOCAL_ACCESS_CAPABILITIES[index])
}
