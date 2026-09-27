/**
 * 环境领域的**纯逻辑**：状态取值、阻塞/降级判定、通过率、以及统一门禁。
 *
 * 为什么单独立一份、而且放在 `shared/`：这三件事以前分散在三处 ——
 * Host 的 `env.blocked[]` 字符串数组、Client 的 `envTally()` 计数、以及 `WorkbenchPanel`
 * 里 `env.allOk` 的临时判断。结果是同一时刻能出现两个互相矛盾的结论：
 * 「环境就绪」（allOk，因为 iFinD 可选）与「7/8 通过、还差 1 项」（tally 把可选项也算进去了），
 * 而侧栏子项、报告页门禁、环境页各按自己的口径判断该不该拦人。
 *
 * 现在只有一个模型：
 *
 * 1. **`userSetup` / `systemHealth` / `capabilities` 是事实分区**，取值来自 Host 的真实探测；
 * 2. **`issues[]` 是唯一的"哪里不对"清单**，每项带 `owner`（谁该处理）、`blocking`（拦不拦）、
 *    `scope`（拦哪一块能力）；
 * 3. **总状态由 issues 推出来**（`overallStatusOf`），不再由布尔量拼接；
 * 4. **通过率只统计必需项**（`requiredTallyOf`），所以「环境就绪」与「8/8 通过」永远同时成立，
 *    而只有"非必需的完成项"缺失时才可能是 `degraded`；
 * 5. **导航门禁只有一条规则**（`environmentGate` + `navigateModuleIn`），所有入口共用。
 *
 * 本文件不许 import 任何 Host / Client 专有模块（它是两边共用的纯函数）。
 */

/** 账号 / 密钥 / 工作空间这类**员工自己能修**的东西。 */
export interface UserSetupView {
  workspace: SetupItemView
  credentialsConsent: SetupItemView
  h3yun: SetupItemView
  dingtalk: SetupItemView
  aliyunOss: SetupItemView
  ifind: SetupItemView
}

/**
 * 一条配置项的状态。
 *
 * `unconfigured` / `unverified` / `authenticated` / `invalid` / `unreachable` 五态是**必须**
 * 分开的：OSS 与 iFinD 都要能回答「没填 / 填了没验过 / 验过是好的 / 填错了 / 服务连不上」——
 * 把它们压成一个 `ok: boolean` 就会把「网络不通」说成「密钥错误」，把员工指去换一份好密钥。
 */
export interface SetupItemView {
  /** `ok` | `unconfigured` | `unverified` | `authenticated` | `invalid` | `unreachable` | `unknown`。 */
  state: string
  /** 脱敏后的一句话（AK 掩码 / 密钥长度 / 工作空间路径）；绝不回显密钥本体。 */
  value: string
  /** 不通过的原因（Host 原文优先）；通过时为空串。 */
  reason: string
  /** 这一项是不是当前必需（由环境清单的 `required` 声明，iFinD 自 2026-09-26 起为 true）。 */
  required: boolean
}

/** 插件包 / 运行时 / 平台 / Tool 注册表这类**员工修不了**的东西。 */
export interface SystemHealthView {
  packageIntegrity: SetupItemView
  dshRuntime: SetupItemView
  platform: SetupItemView
  toolRegistry: SetupItemView
}

/** 环境支撑起来的**能力**：门禁按能力判，不按具体检查项判。 */
export interface EnvironmentCapabilities {
  /** 全局导航（除环境页外的一切）。 */
  global: boolean
  /** 报告审核（工作空间 + 授权 + 氚云 + 钉钉 + 包 + 运行时 + 必需 Tool）。 */
  auditCore: boolean
  /** 交付件回传（OSS AK）。 */
  delivery: boolean
  /** 外部数据取数（iFinD）；**自 2026-09-26 起是必需项**，未通过即关闭。 */
  externalData: boolean
}

export interface EnvironmentIssueView {
  id: string
  owner: string
  blocking: boolean
  scope: string
  action: string
  message: string
}

/** 总状态。`ready` / `degraded` 之外一律不放行需要环境的页面。 */
export type EnvironmentStatus =
  | 'unknown'
  | 'checking'
  | 'ready'
  | 'degraded'
  | 'action-required'
  | 'admin-required'
  | 'system-blocked'
  | 'check-failed'

/**
 * 门禁严格度。
 *
 * `global` = 除环境页外的一切页面；`audit` = 报告审核；`delivery` = 交付回传；
 * `external-data` = 外部数据。
 *
 * 交付与外部数据这两个档位目前没有独立入口（交付在审核链路里、外部数据在审核装配里），
 * 但判据立在这里：以后加"交付管理"页时不必再改一次门禁语义。
 * **iFinD 改为必需项后它已经由 `global` 覆盖** —— 缺 API-Key 时连工作台都进不去，
 * 所以 `external-data` 这一档现在只用于"只看外部数据"的诊断路径。
 *
 * 交付与外部数据这两个档位目前没有独立入口（交付在审核链路里，外部数据在审核装配里），
 * 但判据先立在这里：以后加"交付管理"页时不必再改一次门禁语义。
 */
export type EnvironmentRequirement = 'global' | 'audit' | 'delivery' | 'external-data'

/**
 * 一个被审计的环境视图。
 *
 * 兼容字段（`allOk` / `blocked`）保留：审核提示词、旧客户端与若干既有测试都读它们，
 * 但**语义收窄成"必需项全通过"与"阻塞项文案"**，与模型推出的结论逐字一致（有测试钉住）。
 */
export interface EnvironmentStateView {
  status: EnvironmentStatus
  /** ready/degraded = 可以进入需要环境的页面。 */
  proceed: boolean
  userSetup: UserSetupView
  systemHealth: SystemHealthView
  capabilities: EnvironmentCapabilities
  issues: EnvironmentIssueView[]
  /** 只有必需项：passed / total 与 status 的三个"放行/不放行"结论永远自洽。 */
  passed: number
  total: number
  blocked: string[]
  allOk: boolean
  /** 自检本身没跑完（平台/主目录探测失败）时的原因；正常为空串。 */
  checkError: string
}

/** 只统计必需项的通过率。iFinD 这类可选能力**不参与**分母。 */
export interface EnvironmentTally {
  passed: number
  total: number
  ratio: number
}

/** 除了 ready，其它状态一律不放行 —— 少一个 `proceed` 判断就会静默放行 `check-failed`。 */
export function statusProceedable(status: string): boolean {
  return status === 'ready' || status === 'degraded'
}

/** 需要环境的页面能不能进。**不认识的状态按不可放行处理**（旧宿主 / 缺字段时失败关闭）。 */
export function proceedableOf(view: EnvironmentStateView | null | undefined): boolean {
  if (view === null || view === undefined) return false
  return view.proceed === true && statusProceedable(view.status)
}

/**
 * 环境结论 → 总状态。顺序即优先级：系统故障 > 管理员处置 > 员工处置 > 降级 > 就绪。
 *
 * 「iFinD 缺失 = degraded 而不是 blocked」这条就落在这里：它的 issue `blocking: false`，
 * 于是不会命中前三个分支，只会让总状态从 ready 落到 degraded。
 */
export function overallStatusOf(issues: readonly EnvironmentIssueView[], checked: boolean): EnvironmentStatus {
  if (!checked) return 'unknown'
  const blocking = issues.filter((issue) => issue.blocking === true)
  if (blocking.some((issue) => issue.owner === 'system')) return 'system-blocked'
  if (blocking.some((issue) => issue.owner === 'admin')) return 'admin-required'
  if (blocking.some((issue) => issue.owner === 'user')) return 'action-required'
  if (issues.length > 0) return 'degraded'
  return 'ready'
}

/**
 * 有阻塞 issue 的能力一律 false。
 *
 * **iFinD 的阻塞 issue 在 `global` 与 `external-data` 两个 scope 上**（2026-09-26 起它是必需项）：
 * `global` 让统一导航把它拦回环境页，`external-data` 让 `auditCore` 一起关掉 ——
 * 光关外部数据而放行审核是自相矛盾的（审核装配里就要取外部数据）。
 */
export function capabilitiesOf(issues: readonly EnvironmentIssueView[]): EnvironmentCapabilities {
  const blockingScopes = new Set(
    issues.filter((issue) => issue.blocking === true).map((issue) => issue.scope),
  )
  const auditCore = !blockingScopes.has('global') && !blockingScopes.has('audit')
  return {
    global: !blockingScopes.has('global'),
    auditCore,
    delivery: auditCore && !blockingScopes.has('delivery'),
    externalData: auditCore && !blockingScopes.has('external-data'),
  }
}

/**
 * 通过率。
 *
 * `context` 里的包完整性 / 运行时 / 平台是**三个独立的系统事实**，只在必需时计入分母；
 * 服务、交付与外部数据按各自的 `required` 计入 —— iFinD 自 2026-09-26 起是必需项，
 * 所以它**在分母里**：未通过时 `passed/total` 与 `status` 仍然是同一件事。
 */
export function requiredTallyOf(view: {
  systemHealth: SystemHealthView
  userSetup: UserSetupView
}): EnvironmentTally {
  const items: SetupItemView[] = [
    view.systemHealth.packageIntegrity,
    view.systemHealth.dshRuntime,
    view.systemHealth.platform,
    view.userSetup.workspace,
    view.userSetup.credentialsConsent,
    view.userSetup.h3yun,
    view.userSetup.dingtalk,
    view.userSetup.aliyunOss,
    view.userSetup.ifind,
  ]
  const required = items.filter((item) => item.required === true)
  const passed = required.filter((item) => item.state === 'ok' || item.state === 'authenticated').length
  return {
    passed,
    total: required.length,
    ratio: required.length === 0 ? 0 : passed / required.length,
  }
}

/**
 * 员工最该做的那一件事：第一条**阻塞的、且归属是 user** 的 issue。
 *
 * 界面顶部只允许一个主动作，所以要有一个确定的"下一步"；系统/管理员故障不给员工派活
 * （它们的动作是「联系管理员 / 重启 profile」）。
 */
export function primaryUserIssue(view: EnvironmentStateView | null | undefined): EnvironmentIssueView | null {
  if (view === null || view === undefined) return null
  return view.issues.find((issue) => issue.blocking === true && issue.owner === 'user') ?? null
}

/** 阻塞项的文案清单（顺序即优先级），给「还差这些」那块用。 */
export function blockerMessages(view: EnvironmentStateView | null | undefined): string[] {
  if (view === null || view === undefined) return []
  return view.issues.filter((issue) => issue.blocking === true).map((issue) => issue.message)
}

/** 非阻塞（降级）项的文案清单。 */
export function degradedMessages(view: EnvironmentStateView | null | undefined): string[] {
  if (view === null || view === undefined) return []
  return view.issues.filter((issue) => issue.blocking !== true).map((issue) => issue.message)
}

// ── 统一门禁 ────────────────────────────────────────────────────────────────

export interface EnvironmentGateResult {
  allowed: boolean
  /** 不放行的原因（人话，含目标页名字）；放行时为空串。 */
  reason: string
  /** 这次判断依据的状态（缺字段时是 `unknown`）。 */
  status: string
}

/** 门禁文案里要用到的模块名；由调用方注入以免 shared 依赖 locale。 */
export interface GateLabels {
  runCheck: string
  /** 目标页名（「报告审核」）。 */
  target: string
}

/**
 * 所有入口共用的门禁判据（**唯一一份**）。
 *
 * `status` 收 `string` 而不是联合类型是刻意的：宿主可能是旧构建，`env.state` 缺字段时
 * 这里必须走「不认识 → 不放行」，而不是因为类型收窄而少写一个分支。
 */
export function environmentGate(
  view: EnvironmentStateView | null | undefined,
  requirement: EnvironmentRequirement,
  labels: GateLabels,
): EnvironmentGateResult {
  const raw = (view as { status?: unknown } | null | undefined)?.status
  const status = typeof raw === 'string' && raw !== '' ? raw : 'unknown'
  if (view === null || view === undefined) {
    return { allowed: false, reason: labels.runCheck, status }
  }
  // `external-data` 走 `capabilities.externalData`：iFinD 是必需项之后，
  // 「只看外部数据」的入口同样要在它没过时被拦住（旧口径是永久放行）。
  if (requirement === 'external-data') {
    const caps = (view as { capabilities?: { externalData?: unknown } }).capabilities
    if (caps?.externalData === true) return { allowed: true, reason: '', status }
    if (statusProceedable(status)) return { allowed: true, reason: '', status }
    const blockers = blockerMessages(view)
    return {
      allowed: false,
      reason: `${labels.target}前，请先完成 iFinD API-Key 验证。${blockers.length === 0 ? '' : `（${blockers.join('；')}）`}`,
      status,
    }
  }

  // 还没自检 / 正在自检：不拦死，但也**不当作已就绪** —— 先去看环境页，由页面把结论跑出来。
  if (status === 'unknown' || status === 'checking') {
    return { allowed: false, reason: labels.runCheck, status }
  }
  if (status === 'check-failed') {
    return { allowed: false, reason: `环境自检没有完成（${view.checkError || '未知原因'}），请先重新检查环境。`, status }
  }
  if (statusProceedable(status)) return { allowed: true, reason: '', status }

  const blockers = blockerMessages(view)
  const detail = blockers.length === 0 ? '' : `：${blockers.join('；')}`
  // 名称里带上目标页名与方括号：整句就是「进入【报告审核】前，请先完成环境配置：…」——
  // 用户一眼能看出"本来要去哪"，测试也按这一句钉住（页面直接把 `reason` 原样显示）。
  const names: Record<Exclude<EnvironmentRequirement, 'external-data'>, string> = {
    global: '使用【工作台】',
    audit: '进入【报告审核】',
    delivery: '使用【交付回传】',
  }
  // iFinD 未通过时把话说具体（用户原话：「进入【报告审核】前，请先完成 iFinD API-Key 验证」）：
  // 只说"请先完成环境配置"会让员工在一长串检查项里找不着该修哪一个。
  // **整句就是它**，不再套一层通用模板 —— 套起来会变成"请先完成环境配置。（…iFinD API-Key 验证。）"，
  // 员工第一眼看到的仍然是一句笼统的话，而那正是这条要消灭的东西。
  if (hasIfindBlocker(view)) {
    const shown = blockers.slice(0, 2).join('；')
    return {
      allowed: false,
      reason: `${names[requirement]}前，请先完成 iFinD API-Key 验证。${shown === '' ? '' : `（${shown}）`}`,
      status,
    }
  }
  return { allowed: false, reason: `${names[requirement]}前，请先完成环境配置${detail}。`, status }
}

/** 环境里有没有"iFinD 这一项没过"这条阻塞（用来把门禁文案说得具体）。 */
export function hasIfindBlocker(view: EnvironmentStateView | null | undefined): boolean {
  const issues = (view as { issues?: unknown } | null | undefined)?.issues
  if (!Array.isArray(issues)) return false
  return issues.some((issue) => {
    const row = issue as { id?: unknown; blocking?: unknown }
    return row.id === 'ifind' && row.blocking === true
  })
}

/** 目标页面需要的环境严格度。**`env` 永远不被门槛拦**（它自己就是修复入口）。 */
export type NavigateTarget = 'env' | 'eval' | 'audit'

export interface NavigateInput {
  target: NavigateTarget
  /** 目标页是否需要环境；缺省按 `target` 推断（`env` 不需要）。 */
  requires?: boolean
  /** 需要的严格度；缺省 `global`。 */
  requirement?: EnvironmentRequirement
}

export interface NavigateResult {
  /** 真正要画的目标页。 */
  module: NavigateTarget
  /** 被拦住了 → `module` 是 `env`。 */
  blocked: boolean
  /** 被拦住时，本来要去的那一页。 */
  pending: NavigateTarget | null
  reason: string
}

/**
 * 导航纯函数：**所有入口都调它**（侧栏子项、报告页内跳转、环境页「进入报告审核」、以后新增的页）。
 *
 * 被拦住时返回 `env`，并把目标页面作为 `pending` 一起返回 —— 恢复逻辑（检查通过后只恢复最近一次
 * 被拦的目标、用户中途主动改了页面就取消恢复）在 store 里，因为它需要跨渲染记住状态。
 */
export function navigateModuleIn(
  view: EnvironmentStateView | null | undefined,
  input: NavigateInput,
  labelOf: (target: NavigateTarget) => string,
): NavigateResult {
  if (input.target === 'env') return { module: 'env', blocked: false, pending: null, reason: '' }
  const requires = input.requires ?? true
  const requirement = input.requirement ?? 'global'
  if (!requires) return { module: input.target, blocked: false, pending: null, reason: '' }

  const gate = environmentGate(view, requirement, {
    // 「先去看环境页」这句里要出现目标页名 —— 用户是从那一页被挡回来的。
    runCheck: `进入【${labelOf(input.target)}】前，请先完成环境检查。`,
    target: labelOf(input.target),
  })
  if (gate.allowed) return { module: input.target, blocked: false, pending: null, reason: '' }
  return {
    module: 'env',
    blocked: true,
    pending: input.target,
    // `environmentGate` 已经把整句话算好了（iFinD 未通过时它会指名 API-Key，用词比通用模板准确）；
    // 这里**只做兜底**：门禁没给理由时才套通用模板。以前无脑套一层，结果是
    // 「请先完成环境配置。（…请先完成 iFinD API-Key 验证。）」—— 第一眼仍然是一句笼统的话。
    reason: gate.reason === ''
      ? `进入【${labelOf(input.target)}】前，请先完成环境配置。`
      : gate.reason,
  }
}
