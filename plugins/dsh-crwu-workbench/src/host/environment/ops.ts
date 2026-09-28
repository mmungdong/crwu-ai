import type { Context } from '@deepseek-ai/cordis'
import { parseJsonLoose } from '../../shared/utils/json.ts'
import { text } from '../../shared/utils/value.ts'
import type { WorkbenchConfig } from '../config/config.ts'
import { applyDeploymentConfig } from '../config/deployment.ts'
import { runCrwu } from '../crwu/run.ts'
import type { WhoamiResult } from '../system/identity.ts'
import { DEFAULT_MANIFEST, DSH_RUNTIME_SOURCE } from './manifest-default.ts'
import { shellInvoke } from '../platform/shell.ts'
import { resolveBundledCommand } from '../platform/command.ts'
import type { EnvManifest } from '../environment/manifest-default.ts'
import {
  probePackageIntegrity, probeOss,
  type IfindCheck, type PackageIntegrityCheck, type ServiceCheck,
} from '../environment/probe.ts'
import { ifindEnvCheck, type IfindProbeCache } from '../ifind/env.ts'
import type { IfindTransport } from '../ifind/mcp.ts'
import { buildEnvironmentState, checkErrorOf, PACKAGE_BLOCKER, RUNTIME_BLOCKER } from './state.ts'
// 兼容再导出：`blocked` 的这两条文案以前从这里导出，宿主测试与诊断脚本仍按这个名字引用。
export { PACKAGE_BLOCKER, RUNTIME_BLOCKER }
import { runShell, shellUnavailable } from '../shell/run.ts'
import { ossConfigPath, readOssCred, type OssCredView } from '../oss/cred.ts'
import type { WorkbenchState } from '../state/types.ts'
import type { EnvironmentStateView } from '../../shared/environment/model.ts'
import type { OssConfigView, RuntimeView, WorkspaceView } from '../../shared/types.ts'
import { ensureRegistry } from '../state/registry.ts'
import { readWorkbenchConfig } from '../state/persist.ts'
import { workspaceView } from '../state/store.ts'
import { ensureWorkspace, sessionWorkspaceInfo } from '../workspace/resolve.ts'
import { auditRootView } from '../audit/root.ts'
import { bundledBinaryPath } from '../platform/bin-dir.ts'

/**
 * 环境自检聚合：面板的入口页，也是所有后续操作的门禁。
 *
 * 聚合顺序是**有依赖的**：先恢复注册表与工作空间（其它操作都依赖它们），再核对插件包完整性、
 * 解析 DSH 自带运行时、探测各项服务与外部数据。返回的 `blocked` 是给界面看的「还差什么」，
 * `allOk` 是硬门禁。
 *
 * 结果按**语义分区**（2026-09-25 改造，协议号 +1）：插件包 / 运行时 / 授权 / 交付 / 外部数据 / 工作空间。
 * 旧的 `checks[]` 把「随包组件」「系统命令」「运行时探针」混成一列，界面只能平铺成命令清单 ——
 * 于是员工会去装 python3、去找 ossutil 的安装包。分区的直接目的就是让**每一类失败有各自的处置**。
 *
 * 两个反直觉但必须保留的规则：
 * 1. **平台未识别也算 blocked**：探测不到平台就没法核对包内组件，硬往下走只会用错二进制；
 * 2. **没有工作空间也算 blocked 且排在最前**：没有它审核产物没有落地目录，
 *   而这条正是为了避免「照搬父会话工作区、把产物写进源码仓库」。
 */

/** 主 agent 提供的 DSH 自带 Python 运行时解析结果；本模块只消费它。 */
export interface PythonRuntimeResult {
  ok: boolean
  /** 'ok' | 'capability-gap' | 'missing-package' | 'failed' */
  state: string
  path: string
  versionText: string
  distributions: Record<string, string>
  missingPackages: string[]
  error: string
  source: string
}

export interface EnvResult {
  ok: boolean
  /** 部署配置的来源 YAML 路径（清单只有内置一份，故障对账时看的是这份配置）。 */
  configSource: string
  /** ② 插件内置组件（crwu / dws / ossutil）：只按包内文件与包内清单核对。 */
  packageIntegrity: PackageIntegrityCheck
  /** ③ DSH 自带脚本运行时（Python）：不是系统 Python，也不是 PATH 命令。 */
  runtime: RuntimeView
  /** ④ 登录与凭据授权：氚云 + 钉钉（**不含 oss**）。 */
  services: ServiceCheck[]
  /** ⑤ OSS 交付配置：配置视图 + 凭据脱敏视图 + 一次真实连通性探测。 */
  delivery: { oss: OssConfigView; ossCred: OssCredView; probe: ServiceCheck }
  /** ⑥ 外部数据：iFinD 的 **API-Key**（插件自有凭据存储、五态）。 */
  external: IfindCheck
  blocked: string[]
  allOk: boolean
  /**
   * 统一环境模型（协议 13）：状态 / 阻塞 / 归属 / 通过率 / 能力。
   *
   * `blocked` 与 `allOk` 保留给旧调用方，但**由它派生**（`blocked` 就是这里的阻塞项文案，
   * `allOk` 就是"没有阻塞项"）—— 两套结论不可能再打架。
   */
  state: EnvironmentStateView
  home: string
  platform: string
  /**
   * 「信任本插件读取本机凭据」当前是否已授权。
   * 字段名从 `h3yun` 改成 `credentials`（2026-09-22，协议号 +1）：授权范围是**读本机凭据**，
   * 覆盖氚云会话与钉钉登录态，不再只是氚云。
   */
  trust: { credentials: boolean }
  /** ① 案例根目录（工作空间）：不在 `services` 里，是审核产物的落地目录。 */
  workspace: WorkspaceView
  /** 审核子代理挂在哪个会话下（建在选定工作空间里的那个顶层会话）。 */
  auditRoot: ReturnType<typeof auditRootView>
  sessionWorkspace: ReturnType<typeof sessionWorkspaceInfo>
  /**
   * 「我是谁」：面板头部那句「晚上好，某某某」的姓名，来自**同一次自检**里的钉钉 CLI。
   * 三个字段都可能是空串 —— 没授权 / 没登录 / 命令没跑起来时，界面整句不展示。
   */
  me: { name: string; org: string; userId: string }
}

/** 从已探测的 checks 里找出服务是否可用（氚云/钉钉的登录态各由 CLI 决定）。 */
function serviceRequired(manifest: EnvManifest, id: string, fallback: boolean): boolean {
  const hit = manifest.services.find((service) => service.id === id)
  return hit === undefined ? fallback : hit.required
}

export interface EnvDeps {
  ctx: Context
  config: WorkbenchConfig
  state: WorkbenchState
  home: string
  platform: string
  sessionRoot: () => Promise<string>
  /**
   * 「我是谁」的来源（面板头部那句问候的姓名）。
   *
   * 为什么挂在**环境自检**上而不是单独开一个操作（用户 2026-09-22 口径：「这个钉钉 cli 环境监测
   * 一遍就可以了，不需要每次切换页面都去调，本质就是从环境信息把这个人的信息拿到」）：
   * 自检本来就要问一次钉钉登录态，姓名是同一条链路上的副产品；做成独立操作就会出现
   * 「每切一次页面问一次 dws」的浪费。宿主侧把它**只缓存成功结果**，所以反复自检也只跑一次 dws。
   *
   * 缺省（单测直接调 `loadEnvironment`）= 没有这个来源，`me` 就是三个空串。
   */
  identity?: () => Promise<WhoamiResult>
  /**
   * DSH 自带 Python 运行时的解析（**主 agent 接线**）。
   *
   * 可选是刻意的：宿主还没接线时必须如实报 **capability gap**，而不是退回去看系统 `python3` ——
   * 本插件的技能脚本用的是 DSH 自带运行时，系统那一份不是依赖。缺这个函数 = 能力缺口，不是「没装」。
   */
  pythonRuntime?: (options: { refresh: boolean }) => Promise<PythonRuntimeResult>
  /**
   * 必需 Tool 是否对当前 Agent 可见（`missingAuditTools`）。
   *
   * 可选：没有这个来源时 `toolRegistry` 是「未验证」而不是「故障」—— 自检页不该因为
   * 拿不到 Agent 就报一个员工看不懂的阻塞项；真正的硬门禁在 `audit-start` 与能力预检里。
   */
  auditTools?: (options: { refresh: boolean }) => Promise<{ missing: string[]; checked: boolean }>
  /**
   * iFinD 的真实校验传输（测试替身用）。
   *
   * **默认就验**（`host/ifind/env.ts`：每次环境校验都真的取一次数据）；`refresh: true`
   * （界面「重新检查」）会**绕过 30s 缓存**再验一次。缓存只用来兜住面板的反复刷新，
   * 不是"默认不探"——那是 2026-09-26 之前的旧口径。
   */
  ifindTransport?: IfindTransport
  /** iFinD 探测结果的短 TTL 缓存（插件实例级）；不传就不缓存。 */
  ifindProbeCache?: IfindProbeCache
}

/**
 * 组装 ③ 层：DSH 自带 Python 运行时。
 *
 * 三件事必须分清（否则界面会说错处置）：
 * - 宿主没接线 / 运行时本身缺失 → `capability-gap`：**不是**员工要装 Python；
 * - 运行时在、缺少必需包 → `missing-package`：要点名缺哪个包；
 * - 解析过程抛错 → `failed`：如实报错，不假装就绪。
 */
async function probePythonRuntime(
  deps: EnvDeps,
  manifest: EnvManifest,
  refresh: boolean,
): Promise<RuntimeView> {
  const spec = manifest.runtime.python
  const base = {
    expect: spec.expect,
    required: spec.required,
    requiredPackages: [...spec.requiredPackages],
    note: spec.note,
  }
  const fail = (state: string, error: string): RuntimeView => ({
    ...base,
    ok: false,
    state,
    path: '',
    versionText: '',
    distributions: {},
    missingPackages: [],
    error,
    source: DSH_RUNTIME_SOURCE,
  })

  if (deps.pythonRuntime === undefined) {
    return fail('capability-gap',
      '宿主没有接线 DSH 自带脚本运行时的解析：本次自检拿不到运行时事实。'
      + '这不是系统 Python 的问题 —— 本插件只使用 DSH 自带运行时，不需要员工安装或配置 PATH；'
      + '请重启 profile，或联系维护者确认宿主侧已接线。')
  }

  let result: PythonRuntimeResult
  try {
    result = await deps.pythonRuntime({ refresh })
  } catch (error) {
    return fail('failed', `运行时解析抛错：${error instanceof Error ? error.message : String(error)}`)
  }

  const state = text(result.state) || (result.ok === true ? 'ok' : 'failed')
  const missingPackages = Array.isArray(result.missingPackages) ? result.missingPackages.map((item) => text(item)).filter((item) => item !== '') : []
  const error = text(result.error) || (state === 'missing-package' && missingPackages.length > 0
    ? `DSH 自带运行时缺少必需包：${missingPackages.join('、')}`
    : '')
  return {
    ...base,
    ok: result.ok === true && state === 'ok',
    state,
    path: text(result.path),
    versionText: text(result.versionText),
    distributions: result.distributions !== null && typeof result.distributions === 'object' ? { ...result.distributions } : {},
    missingPackages,
    error,
    source: text(result.source) || DSH_RUNTIME_SOURCE,
  }
}

export async function loadEnvironment(deps: EnvDeps, args: Record<string, unknown>): Promise<EnvResult> {
  const { ctx, config, state, home, platform } = deps

  // 清单只有内置一份（远程清单的拉取已随只读 OSS 依赖一起删掉），YAML 的部署值盖在上面。
  const manifest = applyDeploymentConfig(DEFAULT_MANIFEST, config)
  state.manifest = manifest

  await ensureRegistry(ctx, home, state)
  // 「信任本插件读取本机凭据」是**一次授权、长期有效**的：从工作台状态文件恢复，
  // 否则员工每次重启 profile 都要重新授权（用户 2026-09-22 口径）。
  state.trustCredentials = (await readWorkbenchConfig(ctx, home)).trustCredentials === true
  await ensureWorkspace(ctx, home, state, {
    preferTitle: config.preferWorkspaceTitle,
    preferPath: manifest.workspace.preferPath,
  })

  // ② 插件内置组件：只 stat 包内文件 + 比对包内清单的字节数，**一次 shell 都不跑**。
  const packageIntegrity = await probePackageIntegrity(ctx, manifest, platform)
  // ③ DSH 自带运行时：`refresh` 由界面「重新自检」传 true（刷新运行时缓存）。
  const runtime = await probePythonRuntime(deps, manifest, args.refresh === true)
  // ⑥ 外部数据：凭据在插件状态目录（五态）。**每次环境校验都真的验一次**
  // （initialize + tools/list + 真取一次数据）；`refresh`（用户点「重新检查」）绕过 30s 缓存。
  const external = await ifindEnvCheck(ctx, home, {
    probe: true,
    force: args.refresh === true || args.probeIfind === true,
    // 必需与否只由清单一处决定（现为 true）：未通过就是阻塞项。
    required: manifest.ifind.required === true,
    applyUrl: manifest.ifind.applyUrl,
    ...(deps.ifindTransport === undefined ? {} : { transport: deps.ifindTransport }),
    ...(deps.ifindProbeCache === undefined ? {} : { cache: deps.ifindProbeCache }),
  })
  const services: ServiceCheck[] = []

  // 氚云会话：只有 crwu 能回答，所以直接问它。
  const sessionRun = await runCrwu(ctx, ['crwu', 'h3yun', 'session', 'status'], {
    workdir: await deps.sessionRoot(),
    timeoutMs: 20_000,
    trusted: state.trustCredentials,
    platform,
  })
  let sessionData: Record<string, unknown> | null = null
  try {
    const parsed: unknown = parseJsonLoose(sessionRun.stdout)
    const doc = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    sessionData = doc?.data !== null && typeof doc?.data === 'object' ? doc.data as Record<string, unknown> : null
  } catch (error) {
    void error
    sessionData = null
  }
  let expired = false
  if (sessionData?.expiresAt !== undefined) {
    const at = Date.parse(text(sessionData.expiresAt))
    expired = !Number.isNaN(at) && at <= Date.now()
  }
  services.push({
    id: 'h3yun',
    label: '氚云（H3Yun）员工会话',
    required: serviceRequired(manifest, 'h3yun', true),
    ok: sessionData !== null && !expired,
    // 命令没跑起来时，`stdout` 为空是「探测失败」，不是「未绑定」—— 两者的处置完全不同。
    state: shellUnavailable(sessionRun) ? '探测失败' : (sessionData === null ? '未绑定' : (expired ? '已过期' : '正常')),
    detail: sessionData === null
      ? (text(sessionRun.stderr) || sessionRun.error || '未取得会话状态')
      : `userId ${text(sessionData.userId)} · 到期 ${text(sessionData.expiresAt)}`,
  })

  // 钉钉：dws 自带 JSON 输出，直接解析，不要靠文本匹配。
  // 注意 dws 不是 crwu，不能走 runCrwu（那条路会拒绝非 crwu 的 argv）。
  //
  // **授权是硬前置**（用户 2026-09-22 口径）：没授权 → 这条报「需要授权」并且整体阻塞，插件不可用；
  // 已授权 → 凭据类命令自己声明无沙箱权限（`sandboxPolicy`）去问，拿到的是**真结论**。
  //
  // 为什么必须提权：dws 的 token 在系统钥匙串里，受限沙箱下读不到，它会如实回
  // `{"authenticated":false,"message":"未登录"}` —— 实测同一台机器同一时刻：沙箱里 false、
  // 带 `sandboxPolicy: danger-full-access` 时 true。所以「未授权时不许猜」：宁可说需要授权，
  // 也不能报一个假的「未登录」把员工指去重新登录。
  const trustedCredentials = state.trustCredentials === true
  const dwsCommand = await resolveBundledCommand(ctx, platform, 'dws')
  const dwsRun = trustedCredentials
    ? await runShell(ctx, shellInvoke(dwsCommand, ['auth', 'status', '--format', 'json'], platform), {
      workdir: await deps.sessionRoot(),
      timeoutMs: 30_000,
      escalate: true,
    })
    : null
  let dwsDoc: Record<string, unknown> | null = null
  if (dwsRun !== null) {
    try {
      const parsed: unknown = parseJsonLoose(dwsRun.stdout)
      dwsDoc = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch (error) {
      void error
      dwsDoc = null
    }
  }
  const dwsAuthed = dwsDoc?.authenticated === true
  // 已授权、但命令**根本没跑起来**（沙箱后端不可用 / 审批被拒）→ 读不到，也要如实说「被拦住」。
  const dwsUnconfirmed = trustedCredentials && !dwsAuthed && dwsRun !== null && shellUnavailable(dwsRun)
  services.push({
    id: 'dingtalk',
    label: '钉钉认证',
    required: serviceRequired(manifest, 'dingtalk', true),
    ok: dwsAuthed,
    state: !trustedCredentials
      ? '需要授权'
      : (dwsUnconfirmed
        ? '本机凭据读取被拦住'
        : (dwsDoc === null ? '未知' : (dwsAuthed ? '已登录' : '未登录'))),
    detail: !trustedCredentials
      ? '还没授权读取本机凭据：授权后本插件才能读钉钉登录态、拉氚云待办与回传结果。在 ④ 登录与凭据授权 里勾选「信任本插件读取本机凭据」——只需授权一次，长期有效。'
      : (dwsUnconfirmed
        ? `读本机凭据的命令没跑起来：${text(dwsRun?.error) || '未知原因'}。这不是「没登录」—— 你已经授权，仍被拦住说明是 DSH 的沙箱/审批策略在挡，请让部署方放行本插件读取钥匙串。`
        : (dwsDoc?.message === undefined ? (text(dwsRun?.stderr) || text(dwsRun?.error)) : text(dwsDoc.message))),
  })

  // ⑤ OSS 交付配置：配置视图 + 凭据脱敏视图 + 一次真实连通性探测。
  const oss = manifest.oss
  const ossutil = packageIntegrity.tools.find((tool) => tool.name === 'ossutil')
  const ossutilReady = ossutil?.ok === true
  const ossProbe = await probeOss(ctx, oss, platform)
  const delivery = {
    oss: {
      enabled: oss.enabled,
      bucket: oss.bucket,
      endpoint: oss.endpoint,
      prefix: oss.prefix,
      linkMode: oss.linkMode,
      linkTtl: oss.linkTtl,
      autoUpload: oss.autoUpload,
      ossutilReady,
      ossutilPath: ossutilReady ? bundledBinaryPath(platform, 'ossutil') : '',
    },
    ossCred: await readOssCred(ctx, home),
    probe: { ...ossProbe, required: serviceRequired(manifest, 'oss', true) },
  }

  // 必需 Tool 的可见性：拿不到来源就是「未验证」，不编造故障。
  const toolRegistry = deps.auditTools === undefined
    ? { missing: [] as string[], checked: false }
    : await deps.auditTools({ refresh: args.refresh === true })

  // 事实 → 统一环境模型。**所有**结论（状态 / 阻塞 / 归属 / 通过率 / 能力）都在这一处推出，
  // 调用方不再各自拼 `blocked`。
  const workspace = workspaceView(state)
  const envState = buildEnvironmentState({
    // 主目录探测不到 = 连"凭据/状态文件在哪"都不知道，自检**本身**没完成：总状态落到 check-failed，
    // 门禁一律不放行，页面只说「重新检查 / 找维护者」，绝不给员工派活。
    // 平台探测不到是另一回事：它是一个**具体的系统事实缺失**（systemHealth.platform），
    // 有自己的检查项与说明。
    checkError: checkErrorOf([home === '' ? '主目录探测失败' : '']),
    platform,
    workspace,
    preferWorkspaceTitle: config.preferWorkspaceTitle || manifest.workspace.preferTitle,
    trustCredentials: state.trustCredentials,
    h3yun: services[0] ?? { id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true, ok: false, state: '', detail: '' },
    dingtalk: services[1] ?? { id: 'dingtalk', label: '钉钉认证', required: true, ok: false, state: '', detail: '' },
    packageIntegrity,
    runtime,
    runtimeRequired: manifest.runtime.python.required,
    oss: {
      configured: oss.bucket !== '' && oss.enabled,
      probe: { ...ossProbe, required: serviceRequired(manifest, 'oss', true) },
      cred: { exists: delivery.ossCred.exists, hasSecret: delivery.ossCred.hasSecret,
        accessKeyIdMasked: delivery.ossCred.accessKeyIdMasked, path: delivery.ossCred.path },
    },
    ifind: {
      required: manifest.ifind.required === true,
      ok: external.ok,
      dataVerified: external.dataVerified === true,
      state: external.state,
      errorKind: external.errorKind,
      reason: external.reason,
      tokenLength: external.tokenLength,
    },
    toolRegistry,
  })

  // 「我是谁」：**只有员工已授权**才去读（受限沙箱下 dws 会假报「未登录」，问出来的姓名不可信）。
  // 它是钉钉那条链路的副产品，所以直接跟在服务探测之后，失败就是三个空串。
  const me = trustedCredentials ? await (deps.identity?.() ?? Promise.resolve(null)) : null

  return {
    ok: true,
    configSource: config.configSource,
    packageIntegrity,
    runtime,
    services,
    delivery,
    external,
    blocked: envState.blocked,
    allOk: envState.allOk,
    state: envState,
    home,
    platform,
    trust: { credentials: state.trustCredentials },
    workspace,
    auditRoot: auditRootView(ctx, state),
    sessionWorkspace: sessionWorkspaceInfo(ctx, state),
    me: {
      name: me?.name ?? '',
      org: me?.org ?? '',
      userId: me?.userId ?? '',
    },
  }
}

/** 只给测试与诊断用：把 ossutil 配置路径暴露出来，避免各处重复拼路径。 */
export function configPathFor(home: string): string {
  return ossConfigPath(home)
}
