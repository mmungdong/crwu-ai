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
import type { RuntimeView, WorkspaceView } from '../../shared/types.ts'

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
/** DSH 自带运行时不可用时的**唯一**一条阻塞文案。 */
export const RUNTIME_BLOCKER = 'DSH 脚本运行时'

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
  trustCredentials: boolean
  h3yun: ServiceCheck
  dingtalk: ServiceCheck
  packageIntegrity: PackageIntegrityCheck
  runtime: RuntimeView
  runtimeRequired: boolean
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
 * iFinD 的五态。**自 2026-09-26 起是必需项**（`required: true`，进必需项分母）。
 *
 * 只有「真的取到一次数据」才给 `ok`：认证通过但没取到数据一律留 `unverified` +
 * 说明，绝不显示成「已认证」—— 那会让员工以为可以取数，真跑审核时才发现不行。
 */
function ifindItem(input: EnvironmentInput): SetupItemView {
  const ifind = input.ifind
  const required = ifind.required === true
  const value = ifind.tokenLength === 0 ? '' : 'API-Key 已保存'
  if (ifind.state === 'unconfigured' || (ifind.ok !== true && ifind.tokenLength === 0)) {
    return item('unconfigured', value, ifind.reason || '还没有填写 iFinD API-Key', required)
  }
  if (ifind.ok === true && ifind.dataVerified !== true) {
    // 认证过了但**没真的取到数据**：这一条必须单独说清 —— 说「已认证」会让人以为能用。
    return item('unverified', value,
      '认证通过，但这次没有真的取到数据：请点「重新验证」再试一次；连续失败请联系管理员确认 iFinD 数据权益', required)
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

function runtimeItem(runtime: RuntimeView, required: boolean): SetupItemView {
  if (runtime.ok === true) return item('ok', runtime.versionText === '' ? 'DSH 自带' : `Python ${runtime.versionText}`, '', required)
  const reason = runtime.missingPackages.length > 0
    ? `DSH 自带运行时缺少必需包：${runtime.missingPackages.join('、')}`
    : (runtime.error || 'DSH 自带脚本运行时不可用')
  return item('invalid', runtime.path, reason, required)
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
  if (!input.trustCredentials) {
    push('consent', 'user', true, 'global', '授权读取本机凭据',
      '授权读取本机凭据（氚云 / 钉钉）：还没授权时读到的「未登录」不可信，所以插件不做猜测，也不谎报')
  }
  if (input.packageIntegrity.ok !== true) {
    push('package', 'system', true, 'global', '重新安装插件或联系管理员',
      `${PACKAGE_BLOCKER}：${input.packageIntegrity.note || '插件包不完整 / 平台不受支持'}`)
  }
  if (input.runtimeRequired && input.runtime.ok !== true) {
    push('runtime', 'system', true, 'global', '联系维护者确认 DSH 运行时',
      input.runtime.missingPackages.length > 0
        ? `${RUNTIME_BLOCKER}：DSH 自带运行时缺少必需包 ${input.runtime.missingPackages.join('、')}`
        : `${RUNTIME_BLOCKER}：DSH 自带脚本运行时不可用（不是系统 Python 的问题，也不由员工安装）`)
  }
  if (input.platform === '') {
    push('platform', 'system', true, 'global', '联系维护者确认运行平台',
      '运行平台未识别：无法核对随包发布的组件')
  }
  if (input.toolRegistry.checked && input.toolRegistry.missing.length > 0) {
    push('tool-registry', 'system', true, 'audit', '重启 profile 或联系维护者',
      `审核需要的 Tool 对当前 Agent 不可见：${input.toolRegistry.missing.join('、')}`)
  }
  if (input.h3yun.required === true && input.h3yun.ok !== true) {
    push('h3yun', 'user', true, 'audit', '扫码登录氚云',
      `${input.h3yun.label || '氚云（H3Yun）员工会话'}：${input.h3yun.state}${input.h3yun.detail === '' ? '' : `（${input.h3yun.detail}）`}`)
  }
  if (input.dingtalk.required === true && input.dingtalk.ok !== true) {
    push('dingtalk', 'user', true, 'audit', '登录钉钉（浏览器或设备码）',
      `${input.dingtalk.label || '钉钉认证'}：${input.dingtalk.state}${input.dingtalk.detail === '' ? '' : `（${input.dingtalk.detail}）`}`)
  }
  // 交付回传（OSS）。**阻塞范围是 global**：交付件回传是工作台的核心能力之一，
  // 缺 AK 时在环境页就拦住并告诉员工"向管理员获取后自己填"，比让他跑完一次审核、
  // 到最后卡在上传更省事（本地交付件仍会留着，不会丢）。
  if (!input.oss.configured) {
    push('oss-config', 'admin', true, 'global',
      '联系管理员配置 OSS Bucket / Endpoint', '部署配置里还没有 OSS Bucket / Endpoint')
  } else if (!input.oss.cred.exists || !input.oss.cred.hasSecret) {
    push('oss-cred', 'user', true, 'global', '填写阿里云 AccessKey（向管理员获取）',
      '还没有填写阿里云 AccessKey，交付件无法回传')
  } else if (input.oss.probe.ok !== true) {
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

  // ⑥ 外部数据（iFinD）。**自 2026-09-26 起是必需项**：未通过即阻塞，且必须**指名**归属 ——
  // 三类原因的处置完全不同，混成一句「iFinD 不可用」会让员工与管理员来回踢皮球：
  // - 没填 / API-Key 无效或过期 → owner=user（员工自己能修）；
  // - 账号没有数据权益 → owner=admin（要管理员开通）；
  // - 网络 / 超时 / 协议 / 上游不可达 → owner=system（员工和管理员都修不了，稍后重试）。
  if (input.ifind.ok !== true || input.ifind.dataVerified !== true) {
    const kind = input.ifind.errorKind
    const unconfigured = input.ifind.tokenLength === 0
    const infrastructure = kind === 'infrastructure' || input.ifind.state === 'unreachable'
    const owner: 'user' | 'admin' | 'system' = kind === 'entitlement'
      ? 'admin'
      : (infrastructure ? 'system' : 'user')
    const action = kind === 'entitlement'
      ? '联系管理员开通 iFinD 数据权益'
      : (infrastructure
        ? '稍后重新验证（iFinD 服务不可达）'
        : (unconfigured ? '填写 iFinD API-Key（向管理员获取）' : '重新填写 iFinD API-Key'))
    const cause = input.ifind.reason || (unconfigured ? '还没有填写 iFinD API-Key' : '未通过真实取数验证')
    // scope 双写（global + external-data）：前者让统一导航把它拦回环境页，后者关掉 auditCore ——
    // 光关外部数据却放行审核是自相矛盾的，审核装配里本来就要取外部数据。
    push('ifind', owner, true, 'global', action, `iFinD API-Key 未通过验证：${cause}`)
    push('ifind-external', owner, true, 'external-data', action, `iFinD 外部数据不可用：${cause}`)
  }
  return issues
}

/** 组装统一环境模型。 */
export function buildEnvironmentState(input: EnvironmentInput): EnvironmentStateView {
  const userSetup = {
    workspace: workspaceItem(input.workspace, input.preferWorkspaceTitle),
    credentialsConsent: item(
      input.trustCredentials ? 'ok' : 'unconfigured',
      '',
      input.trustCredentials ? '' : '还没有授权读取本机凭据',
    ),
    h3yun: serviceItem(input.h3yun),
    dingtalk: serviceItem(input.dingtalk),
    aliyunOss: ossItem(input),
    ifind: ifindItem(input),
  }
  const systemHealth = {
    packageIntegrity: packageItem(input.packageIntegrity),
    dshRuntime: runtimeItem(input.runtime, input.runtimeRequired),
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
