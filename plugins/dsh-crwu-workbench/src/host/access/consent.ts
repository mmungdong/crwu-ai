import type { Context } from '@deepseek-ai/cordis'
import {
  LOCAL_ACCESS_CAPABILITIES,
  LOCAL_ACCESS_SCHEMA_VERSION,
  canonicalLocalAccessCapabilities,
  isCanonicalLocalAccessRequest,
  isLocalAccessCapability,
  type LocalAccessCapability,
  type LocalAccessConsentRecord,
  type LocalAccessConsentView,
} from '../../shared/access/types.ts'
import { readWorkbenchConfigResult, writeWorkbenchConfig, type ConfigReadReason } from '../state/persist.ts'
import type { LocalAccessBroker } from './broker.ts'

/**
 * 授权收据的**唯一**读写点：解析、授予、撤销。
 *
 * ## 三条不许退回去的规则
 *
 * 1. **先落盘、再改内存**（授予路径）。旧实现先写 `state.trustCredentials = granted` 再写盘，
 *    而且无论写盘成功与否都回 `ok:true` —— 于是「点了同意、重启又要同意一次」，
 *    界面还说是成功的。现在写盘失败就是 `ok:false` + 内存仍是未授权。
 * 2. **撤销失败也要立刻 fail closed**。撤销是**收紧**权限，写盘失败时反而不能"当没撤"
 *    ——否则员工撤销完还在被读凭据。内存立即关掉，状态标 `persist-failed` 并如实报错。
 * 3. **读盘永不抛错，但也不许把"读不出来"说成"没有授权"**。状态文件坏了不该让面板打不开
 *    （与 `persist.ts` 同一条口径）—— 可是读失败与"从没授权过"是**两句不同的话**：
 *    前者重新允许一次也修不好（写盘同样是读-改-写），把它显示成「需要授权」就是把员工
 *    送进"授权成功、界面永远停在需要授权"的循环。所以读不出来一律 `unreadable`，
 *    `missing` 只留给"真的没有收据"（2026-09-30 复查）。
 *
 * ## 工作台自己的状态文件是**唯一的**提权写例外
 *
 * 收据要落在 `%USERPROFILE%\.dsh\crwu-workbench.json` —— 那在工作区之外，受限沙箱下写不进去。
 * 所以授予/撤销要经 `writeWorkbenchConfig`（它对该**固定路径**逐次声明 `danger-full-access`）。
 * 这个例外不能由任何 RPC 参数或 Agent 工具参数选择目标，也不能扩展到别的文件。
 */

/** 状态文件里收据的键名。 */
export const LOCAL_ACCESS_CONFIG_KEY = 'localAccessConsent'

/** 旧版的单一布尔授权键：只用于识别「旧版授权」，**不再写**。 */
export const LEGACY_TRUST_CONFIG_KEY = 'trustCredentials'

const OUTDATED_REASON = '授权范围已更新：请按上面的清单重新允许一次'
const LEGACY_REASON = '这是旧版本留下的授权（只覆盖读取本机凭据）：授权范围已更新，请重新允许一次'
const REVOKED_REASON = '已撤销授权：本机账号与配置的访问已关闭，需要时再允许一次'
const GRANT_FAILED_REASON = '授权没能写入磁盘：本次运行仍未获得本机访问权限'
const READ_FAILED_REASON = '读不出授权收据（宿主读盘失败）：这不是「没有授权」，重新允许一次也不会改变它。请把这条原因发给维护者。'
const NO_HOME_REASON = '读不出授权收据（探测不到本机主目录）：这不是「没有授权」，重新允许一次也不会改变它。请把这条原因发给维护者。'
const NO_FS_REASON = '读不出授权收据（宿主文件服务不可用）：这不是「没有授权」，重新允许一次也不会改变它。请把这条原因发给维护者。'
const NOT_A_FILE_REASON = '读不出授权收据（那个位置不是一个普通文件）：这不是「没有授权」，重新允许一次也不会改变它。请把这条原因发给维护者。'
const CORRUPT_REASON = '授权收据文件损坏（内容解析不出来）：在上面点一次「允许并继续」即可重建它。'
const PERSIST_FAILED_REASON = '撤销没能写入磁盘：本次运行已经关闭访问，重启后请再撤销一次'
const UNKNOWN_SCHEMA_REASON = '授权记录来自其它版本的插件：请按当前范围重新允许一次'
const UNKNOWN_CAPABILITY_REASON = '授权记录里有本版不认识的能力项：请按当前范围重新允许一次'

/** 未授权视图（`missing`）：首次打开、以及任何「读不出收据」的兜底。 */
export function missingLocalAccessView(reason = ''): LocalAccessConsentView {
  return {
    state: 'missing',
    schemaVersion: 0,
    requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt: '',
    capabilities: [],
    reason,
  }
}

/**
 * **读不出来**视图（`unreadable`）。
 *
 * 与 `missing` 分开是这一态存在的全部理由：磁盘上完全可能躺着一份合法收据，只是这一次
 * 读它失败了。界面据此说"读不出来 + 为什么"，而不是"需要授权 + 再点一次"。
 */
export function unreadableLocalAccessView(reason: string): LocalAccessConsentView {
  return {
    state: 'unreadable',
    schemaVersion: 0,
    requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt: '',
    capabilities: [],
    reason,
  }
}

/** 读盘失败的原因 → 界面原文。逐类分开，且**都不许说成「没有授权」**。 */
export function unreadableReasonOf(reason: ConfigReadReason): string {
  if (reason === 'corrupt') return CORRUPT_REASON
  if (reason === 'no-home') return NO_HOME_REASON
  if (reason === 'no-fs') return NO_FS_REASON
  if (reason === 'not-a-file') return NOT_A_FILE_REASON
  return READ_FAILED_REASON
}

/** 已授权视图。 */
export function grantedLocalAccessView(grantedAt: string): LocalAccessConsentView {
  return {
    state: 'granted',
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt,
    capabilities: canonicalLocalAccessCapabilities(),
    reason: '',
  }
}

/** 内存里的授权状态是不是「已授权」。**唯一**判据，各处不要自己比字符串。 */
export function localAccessGranted(consent: LocalAccessConsentView | undefined): boolean {
  return consent?.state === 'granted'
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 把状态文件解析成授权视图（**纯函数**，可单测）。
 *
 * 判据表（逐条都有对应测试）：
 * - 有 `localAccessConsent` 且 `schemaVersion === 1`：能力集合**恰好**等于规范集合 → `granted`；
 *   空数组 → `revoked`（墓碑）；其余（缺项 / 多项 / 重复 / 顺序不同 / 有未知项 / 版本不同）
 *   → `outdated`。**任何不精确的集合都不是授权**；
 * - 没有收据、但旧键 `trustCredentials: true` → `outdated`：旧同意只覆盖了「读本机凭据」，
 *   不是新范围的授权（**这就是不许静默扩权的那一条**）；
 * - 其余 → `missing`。
 */
export function localAccessViewOf(config: Record<string, unknown>): LocalAccessConsentView {
  const raw = config[LOCAL_ACCESS_CONFIG_KEY]
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>
    const schemaVersion = typeof record.schemaVersion === 'number' ? record.schemaVersion : 0
    if (schemaVersion !== LOCAL_ACCESS_SCHEMA_VERSION) {
      return {
        state: 'outdated',
        schemaVersion,
        requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
        grantedAt: '',
        capabilities: [],
        reason: UNKNOWN_SCHEMA_REASON,
      }
    }
    const rawCapabilities = record.capabilities
    if (!Array.isArray(rawCapabilities)) {
      return outdatedView(schemaVersion, UNKNOWN_CAPABILITY_REASON)
    }
    // 墓碑：版本对、集合空 = 员工主动撤销过。它与「从没授权」的处置不同（不自动弹窗）。
    if (rawCapabilities.length === 0) {
      return {
        state: 'revoked',
        schemaVersion,
        requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
        grantedAt: '',
        capabilities: [],
        reason: REVOKED_REASON,
      }
    }
    const hasUnknown = rawCapabilities.some((item) => !isLocalAccessCapability(item))
    const grantedAt = textOf(record.grantedAt)
    if (hasUnknown || !isCanonicalLocalAccessRequest(rawCapabilities) || grantedAt === '') {
      return outdatedView(schemaVersion, hasUnknown ? UNKNOWN_CAPABILITY_REASON : OUTDATED_REASON)
    }
    return grantedLocalAccessView(grantedAt)
  }
  if (config[LEGACY_TRUST_CONFIG_KEY] === true) {
    return {
      state: 'outdated',
      schemaVersion: 0,
      requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
      grantedAt: '',
      capabilities: [],
      reason: LEGACY_REASON,
    }
  }
  return missingLocalAccessView()
}

function outdatedView(schemaVersion: number, reason: string): LocalAccessConsentView {
  return {
    state: 'outdated',
    schemaVersion,
    requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt: '',
    capabilities: [],
    reason,
  }
}

export interface LocalAccessConsentDeps {
  ctx: Context
  home: string
  /**
   * Broker（协议 18）：授权收据的落盘也走 `workbench.state.write`。
   *
   * 这是设计文档 §A1 说的那个**窄例外**：`host-owned-state` 不属于员工授予的能力范围，
   * 所以未授权时也能写 —— 否则「允许一次」这个动作本身永远落不了盘。
   */
  access: LocalAccessBroker
  /**
   * 活状态（可选，但**生产必须传**）。
   *
   * 授权/撤销的状态迁移由**本模块**负责，而不是让调用方把返回的 `consent` 无条件写回：
   * 2026-09-29 复查抓到的 P1 就是那么来的 —— 写盘失败时返回了磁盘上的旧 `granted`，
   * 调用方照抄进活状态，一次失败的「重新允许」把 `persist-failed` 重新打开了。
   * 不传也能用（测试与只读路径），但**不传时调用方绝不能把结果写进活状态**。
   */
  state?: { localAccess: LocalAccessConsentView }
}

export interface ConsentOutcome {
  ok: boolean
  error: string
  consent: LocalAccessConsentView
}

/** 读一次磁盘上的收据（不抛错）。 */
export async function readLocalAccessConsent(deps: LocalAccessConsentDeps): Promise<LocalAccessConsentView> {
  const result = await readWorkbenchConfigResult(deps.ctx, deps.home)
  // 读失败**不**等于「没有授权」：反过来把读失败当成已授权才是危险的，所以这里 fail closed。
  // 但 fail closed **不等于含糊**：折叠成 `missing` 就是那条"授权成功、界面永远停在需要授权"
  // 的循环（2026-09-30 复查）—— 读不出来就如实说读不出来。
  if (!result.ok || result.reason === 'corrupt') return unreadableLocalAccessView(unreadableReasonOf(result.reason))
  return localAccessViewOf(result.value)
}

/** 读一次并同步进插件实例状态；返回同一份视图（界面与 Host 判据共用一个事实）。 */
export async function syncLocalAccessConsent(
  deps: LocalAccessConsentDeps & { state: { localAccess: LocalAccessConsentView } },
): Promise<LocalAccessConsentView> {
  const view = await readLocalAccessConsent(deps)
  // **进程内的关闭态优先**：撤销成功之前（或撤销写盘失败之后）磁盘上可能还是上一份授权，
  // 而环境刷新（`env` / `boot`）会走到这里 —— 旧实现会用那份旧授权把访问**重新打开**，
  // 员工看着"已撤销"，实际又放行了（2026-09-29 复查抓到的 P1）。
  //
  // 只有显式重新允许（`grantLocalAccess`）才会清掉这个状态：它先落盘、再改内存，
  // 走的不是这条同步路径。
  const live = deps.state.localAccess
  if (live.state === 'persist-failed' && view.state === 'granted') {
    return live
  }
  deps.state.localAccess = view
  return view
}

/**
 * 授予本机访问。
 *
 * **先写盘、后改内存**：写失败时磁盘与内存都保持原样，并回 `ok:false`。
 * 提交的能力集合必须**恰好**等于规范集合 —— 被改过的客户端无法提交一个与界面不同的范围。
 */
/**
 * 活状态里的授权视图（**不是**磁盘上的）。
 *
 * 调用方拿它渲染，所以它必须是"这一次运行到底放不放行"的真相：
 * 没有活状态时按未授权（fail closed），而不是去读盘 —— 读盘会拿到磁盘上的旧授权。
 */
function liveLocalAccessView(deps: LocalAccessConsentDeps): LocalAccessConsentView {
  return deps.state?.localAccess ?? missingLocalAccessView()
}

/**
 * **请求本身不合法**（版本对不上 / 能力清单被改过）：什么都不改，如实回报活状态。
 *
 * ⚠️ 这类情况**不是**"授权失败"：落盘可能完全正常，只是这一次请求不算数。
 * 早先的实现把它当成失败处理（返回并落实一个关闭态），后果是
 * **一个旧版界面或一次手工构造的坏请求，就能把已经允许的授权掀掉** —— 那是拿可用性换来的假安全。
 * 坏请求的正确语义是"不产生任何影响"：不改活状态、不碰磁盘。
 *
 * 真正的授权失败（下面 `refuseGrant`）才是 fail closed。
 */
function rejectGrantRequest(deps: LocalAccessConsentDeps, error: string): ConsentOutcome {
  return { ok: false, error, consent: liveLocalAccessView(deps) }
}

/**
 * 授权**尝试**失败（落盘失败 / 回读不符）时的关闭态。
 *
 * 两条不允许退回去的口径：
 * 1. **不能返回磁盘上的旧状态** —— 写盘失败的现场里，磁盘上常常还是撤销之前那份 `granted`；
 * 2. **不能只回一个 `ok:false` 却不改活状态** —— 那样调用方很容易顺手把别的视图写回去。
 *
 * 所以这里既构造 `persist-failed` 视图（"本次运行没有授权，且磁盘状态没变"），
 * 又在传了 `state` 时把它落实。`persist-failed` 这一态还有第二重保护：
 * `syncLocalAccessConsent` 拒绝用磁盘上的 `granted` 覆盖它（见那里的注释）。
 */
function persistFailedLocalAccessView(): LocalAccessConsentView {
  return {
    state: 'persist-failed',
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt: '',
    capabilities: [],
    reason: GRANT_FAILED_REASON,
  }
}

function refuseGrant(
  deps: LocalAccessConsentDeps,
  error: string,
  view: LocalAccessConsentView = persistFailedLocalAccessView(),
): ConsentOutcome {
  if (deps.state !== undefined) deps.state.localAccess = view
  return { ok: false, error, consent: view }
}

export async function grantLocalAccess(
  deps: LocalAccessConsentDeps,
  args: Record<string, unknown>,
): Promise<ConsentOutcome> {
  const capabilities = args.capabilities
  if (args.schemaVersion !== LOCAL_ACCESS_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `权限说明版本不匹配（需要 ${String(LOCAL_ACCESS_SCHEMA_VERSION)}）：界面与宿主不是同一代，请完全退出并重新打开 DeepSeek Harness。`,
      consent: rejectGrantRequest(deps, '权限说明版本不匹配：本次请求不产生任何影响。').consent,
    }
  }
  if (!isCanonicalLocalAccessRequest(capabilities)) {
    return {
      ok: false,
      error: `授权范围与当前版本的固定清单不一致，拒绝授予（需要在界面上按清单整体允许一次）。`,
      consent: rejectGrantRequest(deps, '授权范围与固定清单不一致：本次请求不产生任何影响。').consent,
    }
  }
  // **写盘是读-改-写**：读不出来就写不进去（`writeWorkbenchConfig` 会拒绝覆盖没读到的字段）。
  // 这条前置检查把笼统的"授权没能写入磁盘"换成一句能定位的话 —— 读失败时那句会让人去查
  // 磁盘空间，而真正的问题在读取通道；同时它让活状态停在 `unreadable` 而不是 `persist-failed`。
  const before = await readWorkbenchConfigResult(deps.ctx, deps.home)
  if (!before.ok) {
    const reason = unreadableReasonOf(before.reason)
    return refuseGrant(deps, `${reason}（授权没能完成：读不到也就写不进去，磁盘上的文件保持原样。）`, unreadableLocalAccessView(reason))
  }
  const grantedAt = new Date().toISOString()
  const record: LocalAccessConsentRecord = {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt,
    capabilities: [...capabilities] as LocalAccessCapability[],
  }
  // **同时抹掉旧键**：`trustCredentials` 是历史形态，留着它会让"这个文件里到底哪一个是授权"
  // 出现两个事实源（读取时确实优先看新收据，但调试/复审时那个 `true` 会误导人）。
  // `JSON.stringify` 会把值为 `undefined` 的键整个丢掉，所以这就是"删除"。
  const saved = await writeWorkbenchConfig(deps, {
    [LOCAL_ACCESS_CONFIG_KEY]: record,
    [LEGACY_TRUST_CONFIG_KEY]: undefined,
  })
  if (!saved) {
    // ⚠️ **失败时绝不能返回磁盘上的旧状态**：那里可能还留着"撤销之前"的一份 `granted`
    //（撤销写盘失败时磁盘就是这个样子），调用方一旦采用，一次失败的「重新允许」
    // 就把权限重新打开了。失败 = 本进程**没有**授权，返回的视图必须如实说这件事。
    return refuseGrant(deps, '授权没能写入磁盘（落盘失败）：本次不会获得任何本机访问权限，请检查磁盘空间或文件权限后重试。')
  }
  const current = await readLocalAccessConsent(deps)
  // 回读校验：写成功但内容不对（磁盘只读、被别的实例覆盖）时同样不许放行。
  if (current.state !== 'granted') {
    return refuseGrant(deps, '授权写入后回读不是已授权状态：本次不会获得任何本机访问权限，请重试。')
  }
  // 只有**回读确认已授权**才更新活状态。
  if (deps.state !== undefined) deps.state.localAccess = current
  return { ok: true, error: '', consent: current }
}

/**
 * 撤销本机访问（写一个空能力集合的墓碑）。
 *
 * 与授予相反：**内存先关**。写盘成功 → `revoked`；写盘失败 → 仍然关掉内存，
 * 只是状态标 `persist-failed` 并回 `ok:false`（下次启动磁盘上可能还是旧的授权）。
 */
export async function revokeLocalAccess(
  deps: LocalAccessConsentDeps & { state: { localAccess: LocalAccessConsentView } },
): Promise<ConsentOutcome> {
  // ① **内存先关，而且必须在任何 `await` 之前**。
  //
  // 撤销是**收紧**权限：写盘要几十毫秒（还可能 IO 卡住），那段时间里已经放行的操作
  // 不能继续跑。旧实现把 `state` 的更新留给调用方、且排在 `await writeWorkbenchConfig` 之后 ——
  // 于是"点了撤销"到"真的关掉"之间有一个窗口，写盘失败时窗口一直开着。
  deps.state.localAccess = {
    state: 'persist-failed',
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt: '',
    capabilities: [],
    reason: PERSIST_FAILED_REASON,
  }
  // ② 再写盘。写的是"空能力集合"的墓碑，所以写盘期间即使有并发读，读到的也是关闭态
  //    （`writeWorkbenchConfig` 的读-改-写走的是内存里的 `state`，不重读该字段）。
  const saved = await writeWorkbenchConfig(deps, {
    [LOCAL_ACCESS_CONFIG_KEY]: {
      schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
      grantedAt: new Date().toISOString(),
      capabilities: [] as LocalAccessCapability[],
    },
    // 撤销后磁盘上不许再留旧版的"已信任"标记（同上：单一事实源）。
    [LEGACY_TRUST_CONFIG_KEY]: undefined,
  })
  if (!saved) {
    return {
      ok: false,
      error: '撤销没能写入磁盘：本次运行已经关闭本机访问，但重启后可能恢复 —— 请重新撤销一次。',
      consent: deps.state.localAccess,
    }
  }
  const current = await readLocalAccessConsent(deps)
  deps.state.localAccess = current
  return { ok: true, error: '', consent: current }
}

/** 规范能力清单的再导出，避免调用方从 `shared/` 多处 import 同一份常量。 */
export { LOCAL_ACCESS_CAPABILITIES }
