import { text } from '../../shared/utils/value.ts'
import type {
  EnvironmentCapabilities,
  EnvironmentIssueView,
  EnvironmentStateView,
  EnvironmentStatus,
  SetupItemView,
} from '../../shared/environment/model.ts'
import { capabilitiesOf, overallStatusOf, requiredTallyOf } from '../../shared/environment/model.ts'
import type { PackageIntegrityCheck, ServiceCheck } from './probe.ts'
import type { WorkspaceView } from '../../shared/types.ts'
import {
  LOCAL_ACCESS_REQUIRED_REASON,
  type LocalAccessConsentView,
} from '../../shared/access/types.ts'

/**
 * 环境事实 → **统一环境模型**（协议 13）。
 *
 * 这一层是本次改造的核心：以前 `blocked: string[]` 一个数组要同时承担四种语义 ——
 * 「谁该处理」（员工 / 管理员 / 系统）、「拦不拦」（阻塞 / 降级）、「拦哪一块」（导航 / 审核 / 交付 /
 * 外部数据）、以及「怎么修」。结果是：
 *
 * - 员工页面上出现「请安装 crwu / dws / ossutil」「未安装 python3」这类**他根本修不了**的话；
 * - iFinD 缺失（可选能力）与氚云未登录（必需）在界面上长得一模一样；
 * - 顶部说「环境就绪」（`allOk`）而通过率说「7/8 通过」（把可选项算进分母）。
 *
 * 现在每一条不是"某一项没配好"而是**一条带归属、带阻塞判据、带处置的 issue**；总状态、能力、
 * 通过率、以及门禁结论全部从 issues 推出来（纯函数在 `shared/environment/model.ts`，可单测）。
 *
 * 三条归属口径（改这里前先读）：
 * 1. **`user`**：员工在环境页上能自己完成的事 —— 选工作空间、授权、氚云 / 钉钉 登录、
 *    填 AK、填 SK。页面必须给他一个按钮或一个输入框。
 * 2. **`admin`**：部署方 / 管理员的事 —— OSS Bucket 未配置（AK 是员工填，但 bucket 由 YAML 定）。
 *    页面只说「向管理员获取 / 联系管理员」，**不给员工派活**。
 * 3. **`system`**：插件包不完整、平台不受支持、DSH 运行时缺失、Tool 未注册。
 *    页面**绝不允许**提示安装二进制、装系统 Python 或改 PATH —— 这些都不是员工能修的。
 */

/** 插件包不完整时的**唯一**一条阻塞文案（三件组件不许各占一项）。 */
export const PACKAGE_BLOCKER = '插件内置组件'

/** `systemHealth.toolRegistry` 的事实：必需 Tool 是否对当前 Agent 可见。 */
export interface ToolRegistryFacts {
  /** 已知缺失的必需 Tool 名（空数组 = 齐备）。 */
  missing: string[]
  /** 是否已经查过。没查过时这一项是「未验证」，不是「故障」。 */
  checked: boolean
}

export interface EnvironmentInput {
  /**
   * 自检**本身**没跑完的原因（空串 = 事实齐全）。
   *
   * 注意与 `platform === ''` 的区别：平台探测不出来是**一个具体的系统事实缺失**
   * （`systemHealth.platform` 那一项），不是"自检崩了"。两者都阻塞，但处置不同 ——
   * 前者有明确的检查项与说明，后者只能说"重新检查 / 找维护者"。
   */
  checkError: string
  platform: string
  workspace: WorkspaceView
  /** 清单里的工作空间偏好名（未识别到时用于提示"没找到某某工作空间"）。 */
  preferWorkspaceTitle: string
  /** 本机访问授权收据：凭据类事实的**总闸**（不是 `granted` 时它们一律不可信）。 */
  localAccess: LocalAccessConsentView
  h3yun: ServiceCheck
  dingtalk: ServiceCheck
  packageIntegrity: PackageIntegrityCheck
  oss: {
    /** 部署配置里有没有 bucket / endpoint（没有就是管理员还没配好）。 */
    configured: boolean
    probe: ServiceCheck
    cred: { exists: boolean; hasSecret: boolean; accessKeyIdMasked: string; path: string }
  }
  ifind: {
    required: boolean
    /** 认证是否通过（`initialize + tools/list` 成功）。 */
    ok: boolean
    /**
     * **是否真的取到数据**（`tools/call` 成功返回内容）。
     *
     * 与 `ok` 分开是刻意的：`ok:true, dataVerified:false` 时员工的结论必须是
     * 「认证通过但没取到数据」，而不是「已认证」。
     */
    dataVerified: boolean
    /** `unconfigured` | `unverified` | `authenticated` | `invalid` | `unreachable`。 */
    state: string
    errorKind: string
    reason: string
    tokenLength: number
  }
  toolRegistry: ToolRegistryFacts
}

/** 一项事实 → `SetupItemView`（缺省必需）。 */
function item(
  state: string,
  value: string,
  reason: string,
  required = true,
): SetupItemView {
  return { state, value, reason, required }
}

/** 服务项的状态词 → 模型取值。 */
function serviceItem(service: ServiceCheck): SetupItemView {
  const ok = service.ok === true
  const state = ok
    ? 'ok'
    : (service.state === '需要授权' || service.state === '已过期' ? 'unconfigured' : 'invalid')
  return item(state, ok ? service.detail : '', ok ? '' : service.detail, service.required === true)
}

/**
 * OSS 的 AK 五态。
 *
 * 「填了没验过」与「验过是好的」必须分开：`oss-cred-save` 保存后会立刻真探一次，
 * 自检页读到的 `probe.ok` 才是"能用"的证据 —— 只写进 `~/.ossutilconfig` 不等于能上传。
 */
function ossItem(input: EnvironmentInput): SetupItemView {
  const required = input.oss.probe.required === true
  const cred = input.oss.cred
  if (!input.oss.configured) {
    return item('unconfigured', cred.path, '部署配置里还没有 OSS Bucket / Endpoint，需要管理员先配置好（AK 由你填写，Bucket 不由员工设置）', required)
  }
  if (!cred.exists || !cred.hasSecret) {
    return item('unconfigured', cred.accessKeyIdMasked, '还没有填写阿里云 AccessKey（向管理员获取后由你自己填写）', required)
  }
  if (input.oss.probe.ok === true) {
    return item('ok', `${cred.accessKeyIdMasked} · ${input.oss.probe.state}`, '', required)
  }
  // 归因优先用宿主给的结构化 `errorKind`（`probeOss` 的四分类），只有旧宿主没给时才回落到
  // 关键词匹配 ——「网络不通」与「AK 填错」必须分开，否则员工会被指去反复换一份好密钥。
  const kind = input.oss.probe.errorKind ?? ''
  const unreachable = kind === 'infrastructure'
    || /无法探测|不可用|超时|network|timeout/i.test(input.oss.probe.detail)
    || input.oss.probe.state === '无法探测'
  return item(
    unreachable ? 'unreachable' : 'invalid',
    cred.accessKeyIdMasked,
    input.oss.probe.detail || input.oss.probe.state || 'AK 校验未通过',
    required,
  )
}

/**
 * iFinD 的五态。**自 2026-09-30 起是可选数据源**（`ifind.required === false`，不进必需项分母，
 * 未配置/未通过都**不阻塞**环境与报告审核）。
 *
 * 只有「真的取到一次数据」才给 `ok`：认证通过但没取到数据一律留 `unverified` +
 * 说明，绝不显示成「已认证」—— 那会让员工以为可以取数，真跑审核时才发现不行。
 */
function ifindItem(input: EnvironmentInput): SetupItemView {
  const ifind = input.ifind
  const required = ifind.required === true
  const value = ifind.tokenLength === 0 ? '' : 'API-Key 已保存'
  if (ifind.state === 'unconfigured' || (ifind.ok !== true && ifind.tokenLength === 0)) {
    return item('unconfigured', value, ifind.reason || '还没有填写同花顺 iFinD API-Key', required)
  }
  if (ifind.ok === true && ifind.dataVerified !== true) {
    // 认证过了但**没真的取到数据**：这一条必须单独说清 —— 说「已认证」会让人以为能用。
    return item('unverified', value,
      '认证通过，但这次没有真的取到数据：请点「重新验证」再试一次；连续失败请联系管理员确认同花顺 iFinD 数据权益', required)
  }
  if (ifind.ok !== true) {
    const raw = ifind.state === '' ? 'invalid' : ifind.state
    return item(raw === 'authenticated' ? 'unverified' : raw, value, ifind.reason, required)
  }
  return item('ok', value, '', required)
}

function workspaceItem(workspace: WorkspaceView, preferTitle: string): SetupItemView {
  if (workspace.missing) {
    return item('invalid', workspace.path, `已选定的工作空间不存在：${workspace.path}，请重新选择（插件不会自动换到别的工作空间）`)
  }
  if (!workspace.chosen) {
    const named = preferTitle === '' ? '' : `「${preferTitle}」`
    return item('unconfigured', workspace.path, `未找到工作空间${named}，请手动选择`)
  }
  return item('ok', workspace.path, '')
}

function packageItem(integrity: PackageIntegrityCheck): SetupItemView {
  if (integrity.ok === true) return item('ok', `${String(integrity.tools.length)}/${String(integrity.tools.length)} 完整`, '')
  const failed = integrity.tools.filter((tool) => !tool.ok)
  const reason = failed.map((tool) => tool.reason).filter((item) => item !== '').join('；')
    || integrity.note
    || '插件内置组件不可用'
  return item('invalid', integrity.platform, reason)
}

function platformItem(platform: string): SetupItemView {
  if (platform === '') return item('invalid', '', '运行平台未识别，无法核对随包发布的组件')
  return item('ok', platform, '')
}

/**
 * Tool 可见性。
 *
 * **未查询时不算必需项**（`required: false`）：拿不到 Agent 就把它计进分母，会让每一次
 * 「环境就绪」旁边都挂着「N/N-1 通过」—— 这正是本次要消灭的自相矛盾。真正的判据在
 * `audit-start` 的 Host 门禁与能力预检里（那里有确定的 Agent scope）。
 */
function toolRegistryItem(facts: ToolRegistryFacts): SetupItemView {
  if (!facts.checked) {
    return item('unverified', '', '还没有查询 Tool 可见性（发起审核前会自动核对）', false)
  }
  if (facts.missing.length === 0) return item('ok', '必需 Tool 齐备', '')
  return item('invalid', '', `当前 Agent 看不到这些 Tool：${facts.missing.join('、')}`)
}

/**
 * 授权项本身（`userSetup.credentialsConsent`）。
 *
 * 只有一个状态算通过：`granted`。`missing` / `outdated` / `revoked` 都是**员工点一下就能修**的，
 * 所以都归 `unconfigured`（不是 `invalid` —— 员工没做错什么），原因逐态分开。
 */
function consentItem(consent: LocalAccessConsentView): SetupItemView {
  if (consent.state === 'granted') return item('ok', '', '')
  if (consent.state === 'missing') {
    return item('unconfigured', '', '还没有允许工作台访问本机账号和配置')
  }
  return item('unconfigured', '', consent.reason || '需要重新允许一次')
}

/**
 * 凭据类检查项在**未授权**时的统一占位。
 *
 * 判据不来自各探测结果（它们根本没跑），而是「总闸没开」这一个事实：状态一律 `unconfigured`、
 * 原因一律 `LOCAL_ACCESS_REQUIRED_REASON`。这样即使上游实现被改坏、真去探了一遍并带回
 * 「未登录 / 密钥错误 / 未找到」，界面上也不可能出现那些**假结论**。
 */
function consentBlockedItem(required: boolean): SetupItemView {
  return item('unconfigured', '', LOCAL_ACCESS_REQUIRED_REASON, required)
}

/** 未授权时唯一的那条 issue：员工要做的事只有一件 —— 允许一次。 */
function consentIssue(consent: LocalAccessConsentView): {
  id: string
  action: string
  message: string
} {
  if (consent.state === 'missing') {
    return {
      id: 'consent',
      action: '允许工作台访问本机账号和配置',
      message: '还没有允许工作台访问本机账号和配置：允许之后才能读氚云会话、钉钉登录态、'
        + 'OSS 配置与 iFinD API-Key。没允许时读到的「未登录」不可信，所以插件不做猜测。',
    }
  }
  if (consent.state === 'revoked') {
    return {
      id: 'consent-revoked',
      action: '重新允许工作台访问本机账号和配置',
      message: '已撤销对本机账号和配置的访问：需要时在「账号连接」里重新允许一次。',
    }
  }
  if (consent.state === 'persist-failed') {
    return {
      id: 'consent-persist-failed',
      action: '重新允许一次',
      message: consent.reason || '撤消失败：本机访问已关闭，但需要再撤销一次才能写入磁盘。',
    }
  }
  return {
    id: 'consent-outdated',
    action: '按新的范围重新允许一次',
    message: consent.reason || '授权范围已更新：请按新的范围重新允许一次。',
  }
}

/**
 * issues 的固定顺序 = 处置优先级。
 *
 * 工作空间排最前（没有它审核产物没有落地目录），然后是授权、包、运行时、平台、Tool、服务、交付、
 * 外部数据。测试按这个顺序断言，界面也按它排「还差这些」。
 */
function buildIssues(input: EnvironmentInput): EnvironmentIssueView[] {
  const issues: EnvironmentIssueView[] = []
  const push = (
    id: string,
    owner: 'user' | 'admin' | 'system',
    blocking: boolean,
    scope: 'global' | 'audit' | 'delivery' | 'external-data',
    action: string,
    message: string,
  ): void => { issues.push({ id, owner, blocking, scope, action, message }) }

  if (input.checkError !== '') {
    push('check', 'system', true, 'global', '重新检查环境', `环境自检没有完成：${input.checkError}`)
  }
  if (input.workspace.missing) {
    push('workspace-missing', 'user', true, 'global', '重新选择工作空间', `已选定的工作空间不存在：${input.workspace.path}`)
  } else if (!input.workspace.chosen) {
    const named = input.preferWorkspaceTitle === '' ? '' : `「${input.preferWorkspaceTitle}」`
    push('workspace', 'user', true, 'global', '选择案例根目录', `未找到工作空间${named}，请手动选择`)
  }
  // 本机访问授权是**第一道闸**：没开闸时不报凭据类故障（它们根本没被探过）。
  const granted = input.localAccess.state === 'granted'
  if (!granted) {
    const issue = consentIssue(input.localAccess)
    push(issue.id, 'user', true, 'global', issue.action, issue.message)
  }
  if (input.packageIntegrity.ok !== true) {
    push('package', 'system', true, 'global', '重新安装插件或联系管理员',
      `${PACKAGE_BLOCKER}：${input.packageIntegrity.note || '插件包不完整 / 平台不受支持'}`)
  }
  if (input.platform === '') {
    push('platform', 'system', true, 'global', '联系维护者确认运行平台',
      '运行平台未识别：无法核对随包发布的组件')
  }
  if (input.toolRegistry.checked && input.toolRegistry.missing.length > 0) {
    push('tool-registry', 'system', true, 'audit', '重启 profile 或联系维护者',
      `审核需要的 Tool 对当前 Agent 不可见：${input.toolRegistry.missing.join('、')}`)
  }
  if (granted && input.h3yun.required === true && input.h3yun.ok !== true) {
    push('h3yun', 'user', true, 'audit', '扫码登录氚云',
      `${input.h3yun.label || '氚云（H3Yun）员工会话'}：${input.h3yun.state}${input.h3yun.detail === '' ? '' : `（${input.h3yun.detail}）`}`)
  }
  if (granted && input.dingtalk.required === true && input.dingtalk.ok !== true) {
    push('dingtalk', 'user', true, 'audit', '登录钉钉（浏览器或设备码）',
      `${input.dingtalk.label || '钉钉认证'}：${input.dingtalk.state}${input.dingtalk.detail === '' ? '' : `（${input.dingtalk.detail}）`}`)
  }
  // 交付回传（OSS）。**阻塞范围是 global**：交付件回传是工作台的核心能力之一，
  // 缺 AK 时在环境页就拦住并告诉员工"向管理员获取后自己填"，比让他跑完一次审核、
  // 到最后卡在上传更省事（本地交付件仍会留着，不会丢）。
  //
  // **整条链都在 `granted` 之内**（不是只包第一个分支）：未授权时 OSS 的凭据视图与探测结果
  // 根本没产生（见 `environment/ops.ts`），拿占位值去派活会出现「还没有填写 AccessKey」这种
  // 与真实原因无关的任务。`else if` 挂在被拒绝的 `if` 上会继续往下走 —— 这正是 2026-09-29
  // A-03 测试抓到的那次漏检。
  if (granted && !input.oss.configured) {
    push('oss-config', 'admin', true, 'global',
      '联系管理员配置 OSS Bucket / Endpoint', '部署配置里还没有 OSS Bucket / Endpoint')
  } else if (granted && (!input.oss.cred.exists || !input.oss.cred.hasSecret)) {
    push('oss-cred', 'user', true, 'global', '填写阿里云 AccessKey（向管理员获取）',
      '还没有填写阿里云 AccessKey，交付件无法回传')
  } else if (granted && input.oss.probe.ok !== true) {
    // 四类分开派活（2026-09-26 收紧）：
    // - 凭据无效 → 员工自己重填 AK；
    // - 有凭据但没权限 → 找管理员开 Bucket / 前缀权限；
    // - Bucket / Endpoint 配错 → 管理员改部署配置；
    // - 网络 / 超时 / 包内 ossutil 或执行环境故障 → 系统侧，员工和管理员都不该去换 AK。
    const kind = input.oss.probe.errorKind ?? ''
    const infrastructure = kind === 'infrastructure' || input.oss.probe.state === '无法探测'
    const owner: 'user' | 'admin' | 'system' = infrastructure
      ? 'system'
      : (kind === 'permission' || kind === 'config' ? 'admin' : 'user')
    const action = infrastructure
      ? '稍后重新检查（OSS 连接不可用）'
      : (kind === 'permission'
        ? '联系管理员为本账号开通该 Bucket / 前缀权限'
        : (kind === 'config' ? '联系管理员核对 Bucket / Endpoint 配置' : '核对或重新填写 AccessKey'))
    push('oss-probe', owner, true, 'global', action,
      `OSS 交付不可用：${input.oss.probe.detail || input.oss.probe.state || '探测失败'}`)
  }

  // ⑥ 外部数据（iFinD）。**自 2026-09-30 起是可选数据源**：未通过时只记一条**非阻塞** issue，
  // 只关掉 `capabilities.externalData` —— 基础环境、报告审核都不受影响（`global` / `auditCore` 不动）。
  // 仍然**指名归属**，因为"怎么修"三类完全不同（未配置 → 员工自己填；无权益 → 管理员开通；
  // 网络不可达 → 谁都不用改，稍后重试），界面与审核结果里记的「未检查」原因都要用。
  if (granted && (input.ifind.ok !== true || input.ifind.dataVerified !== true)) {
    const kind = input.ifind.errorKind
    const unconfigured = input.ifind.tokenLength === 0
    const infrastructure = kind === 'infrastructure' || input.ifind.state === 'unreachable'
    const owner: 'user' | 'admin' | 'system' = kind === 'entitlement'
      ? 'admin'
      : (infrastructure ? 'system' : 'user')
    const action = kind === 'entitlement'
      ? '联系管理员开通同花顺 iFinD 数据权益'
      : (infrastructure
        ? '稍后重新验证（同花顺 iFinD 服务不可达）'
        : (unconfigured ? '配置外部数据源（同花顺 iFinD API-Key）' : '重新填写同花顺 iFinD API-Key'))
    const cause = input.ifind.reason || (unconfigured ? '还没有配置外部数据源' : '未通过真实取数验证')
    // ⚠️ `blocking: false` 是这条的**全部要点**：它让总状态落到 `degraded`（可放行）、
    // 通过率分母不含它、统一导航也不拦人；只有 `externalData` 能力被关掉。
    push('ifind', owner, false, 'external-data', action,
      `外部数据核查未就绪（同花顺 iFinD）：${cause}。不影响进入报告审核，涉及外部数据的项目会标记为「未检查」。`)
  }
  return issues
}

/** 组装统一环境模型。 */
export function buildEnvironmentState(input: EnvironmentInput): EnvironmentStateView {
  const granted = input.localAccess.state === 'granted'
  const userSetup = {
    workspace: workspaceItem(input.workspace, input.preferWorkspaceTitle),
    credentialsConsent: consentItem(input.localAccess),
    // 四项凭据类事实在未授权时**一律**是「需要先允许」：上面那些探测根本没发生，
    // 拿它们的结果（或"没有结果"）当结论都会指向错误的处置。
    h3yun: granted ? serviceItem(input.h3yun) : consentBlockedItem(input.h3yun.required === true),
    dingtalk: granted ? serviceItem(input.dingtalk) : consentBlockedItem(input.dingtalk.required === true),
    aliyunOss: granted ? ossItem(input) : consentBlockedItem(input.oss.probe.required === true),
    ifind: granted ? ifindItem(input) : consentBlockedItem(input.ifind.required === true),
  }
  const systemHealth = {
    packageIntegrity: packageItem(input.packageIntegrity),
    platform: platformItem(input.platform),
    toolRegistry: toolRegistryItem(input.toolRegistry),
  }

  const issues = buildIssues(input)
  const checked = input.checkError === ''
  const status: EnvironmentStatus = overallStatusOf(issues, checked)
  const capabilities: EnvironmentCapabilities = capabilitiesOf(issues)
  const tally = requiredTallyOf({ systemHealth, userSetup })
  const blocked = issues.filter((issue) => issue.blocking === true).map((issue) => issue.message)

  return {
    status,
    proceed: status === 'ready' || status === 'degraded',
    userSetup,
    systemHealth,
    capabilities,
    issues,
    passed: tally.passed,
    total: tally.total,
    blocked,
    allOk: blocked.length === 0,
    checkError: input.checkError,
  }
}

/** 平台 / 主目录探测失败时的一句话（写进 `state.checkError`）。 */
export function checkErrorOf(messages: readonly string[]): string {
  return messages.map((message) => text(message)).filter((message) => message !== '').join('；')
}
