import type { Context } from '@deepseek-ai/cordis'
import { parseJsonLoose } from '../../shared/utils/json.ts'
import { text } from '../../shared/utils/value.ts'
import type { WorkbenchConfig } from '../config/config.ts'
import { applyDeploymentConfig } from '../config/deployment.ts'
import { runCrwu } from '../crwu/run.ts'
import { loadManifest } from '../environment/manifest.ts'
import type { EnvManifest } from '../environment/manifest-default.ts'
import { probeEnv, probeIfindKey, probeOss, type EnvCheck, type IfindCheck, type ServiceCheck } from '../environment/probe.ts'
import { runShell, shellUnavailable } from '../shell/run.ts'
import { ossConfigPath, readOssCred, type OssCredView } from '../oss/cred.ts'
import type { WorkbenchState } from '../state/types.ts'
import type { WorkspaceView } from '../../shared/types.ts'
import { ensureRegistry } from '../state/registry.ts'
import { readWorkbenchConfig } from '../state/persist.ts'
import { workspaceView } from '../state/store.ts'
import { ensureWorkspace, sessionWorkspaceInfo } from '../workspace/resolve.ts'
import { auditRootView } from '../audit/root.ts'

/**
 * 环境自检聚合：面板的入口页，也是所有后续操作的门禁。
 *
 * 聚合顺序是**有依赖的**：先恢复注册表与工作空间（其它操作都依赖它们），再探测二进制与
 * 各项服务。返回的 `blocked` 是给界面看的「还差什么」，`allOk` 是硬门禁。
 *
 * 两个反直觉但必须保留的规则：
 * 1. **平台未识别也算 blocked**：探测不到平台就没法选对 ossutil 包，硬往下走只会装错二进制；
 * 2. **没有工作空间也算 blocked 且排在最前**：没有它审核产物没有落地目录，
 *    而这条正是为了避免「照搬父会话工作区、把产物写进源码仓库」。
 */

export interface EnvResult {
  ok: boolean
  manifestSource: string
  manifestKind: string
  manifestLoaded: boolean
  manifestError: string
  manifestUpdatedAt: string
  installDocUrl: string
  checks: EnvCheck[]
  ifindKey: IfindCheck
  services: ServiceCheck[]
  blocked: string[]
  allOk: boolean
  home: string
  platform: string
  /**
   * 「信任本插件读取本机凭据」当前是否已授权。
   * 字段名从 `h3yun` 改成 `credentials`（2026-09-22，协议号 +1）：授权范围是**读本机凭据**，
   * 覆盖氚云会话与钉钉登录态，不再只是氚云。
   */
  trust: { credentials: boolean }
  workspace: WorkspaceView
  /** 审核子代理挂在哪个会话下（建在选定工作空间里的那个顶层会话）。 */
  auditRoot: ReturnType<typeof auditRootView>
  sessionWorkspace: ReturnType<typeof sessionWorkspaceInfo>
  oss: Record<string, unknown>
  ossCred: OssCredView
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
}

export async function loadEnvironment(deps: EnvDeps, _args: Record<string, unknown>): Promise<EnvResult> {
  const { ctx, config, state, home, platform } = deps

  const loaded = await loadManifest(ctx, config.manifestUrl, { workdir: await deps.sessionRoot() })
  const manifest = applyDeploymentConfig(loaded.manifest, config)
  state.manifest = manifest

  await ensureRegistry(ctx, home, state)
  // 「信任本插件读取本机凭据」是**一次授权、长期有效**的：从工作台状态文件恢复，
  // 否则员工每次重启 profile 都要重新授权（用户 2026-09-22 口径）。
  state.trustCredentials = (await readWorkbenchConfig(ctx, home)).trustCredentials === true
  await ensureWorkspace(ctx, home, state, {
    preferTitle: config.preferWorkspaceTitle,
    preferPath: manifest.workspace.preferPath,
  })

  const checks = await probeEnv(ctx, manifest, platform, { home })
  const ifindKey = await probeIfindKey(ctx, manifest, { home, platform })
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
  const dwsRun = trustedCredentials
    ? await runShell(ctx, 'dws auth status --format json', {
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
      ? '还没授权读取本机凭据：授权后本插件才能读钉钉登录态、拉氚云待办与回传结果。在 ③ 登录认证 里勾选「信任本插件读取本机凭据」——只需授权一次，长期有效。'
      : (dwsUnconfirmed
        ? `读本机凭据的命令没跑起来：${text(dwsRun?.error) || '未知原因'}。这不是「没登录」—— 你已经授权，仍被拦住说明是 DSH 的沙箱/审批策略在挡，请让部署方放行本插件读取钥匙串。`
        : (dwsDoc?.message === undefined ? (text(dwsRun?.stderr) || text(dwsRun?.error)) : text(dwsDoc.message))),
  })

  const oss = manifest.oss
  const ossProbe = await probeOss(ctx, oss, platform, { manifest, home })
  services.push({ ...ossProbe, required: serviceRequired(manifest, 'oss', true) })

  const declaredIds = manifest.services.map((service) => text(service.id))
  const filtered = declaredIds.length > 0 ? services.filter((service) => declaredIds.includes(service.id)) : services

  const blocked: string[] = []
  if (state.workspaceMissing) {
    // 用户选过的那个目录没了：必须说清是哪一个，并且**不许**悄悄换成清单偏好里的另一个。
    blocked.push(`已选定的工作空间不存在：${state.workspacePath}，请重新选择（插件不会自动换到别的工作空间）`)
  } else if (!state.workspaceChosen) {
    const prefer = manifest.workspace
    blocked.push(`未找到工作空间「${text(prefer.preferTitle)}」，请手动选择`)
  }
  if (platform === '') blocked.push('运行平台未识别')
  // 授权是**硬前置**：没它就读不到本机凭据（氚云待办 / 钉钉登录态 / 结果回传），插件不可用。
  // 放在平台之后、具体检查项之前 —— 它不是一个"某项没配好"，而是"整条链路还没被允许"。
  if (!state.trustCredentials) blocked.push('授权读取本机凭据（氚云 / 钉钉）')
  for (const check of checks) {
    if (check.required && !check.ok) blocked.push(check.name)
  }
  for (const service of filtered) {
    if (service.required && !service.ok) blocked.push(service.label)
  }
  if (ifindKey.required && !ifindKey.ok) blocked.push('iFinD 密钥')

  const ossutilCheck = checks.find((check) => check.name === oss.ossutil)

  return {
    ok: true,
    manifestSource: loaded.source,
    manifestKind: loaded.kind,
    manifestLoaded: loaded.loaded,
    manifestError: loaded.error,
    manifestUpdatedAt: text(manifest.updatedAt),
    installDocUrl: text(manifest.installDocUrl),
    checks,
    ifindKey,
    services: filtered,
    blocked,
    allOk: blocked.length === 0,
    home,
    platform,
    trust: { credentials: state.trustCredentials },
    workspace: workspaceView(state),
    auditRoot: auditRootView(ctx, state),
    sessionWorkspace: sessionWorkspaceInfo(ctx, state),
    oss: {
      ...oss,
      ossutilReady: ossutilCheck !== undefined && ossutilCheck.found,
      probe: ossProbe,
    },
    ossCred: await readOssCred(ctx, home),
  }
}

/** 只给测试与诊断用：把 ossutil 配置路径暴露出来，避免各处重复拼路径。 */
export function configPathFor(home: string): string {
  return ossConfigPath(home)
}
