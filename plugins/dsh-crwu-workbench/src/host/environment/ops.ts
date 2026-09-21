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
  trust: { h3yun: boolean }
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
    trusted: state.trustH3yun,
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
  const dwsRun = await runShell(ctx, 'dws auth status --format json', {
    workdir: await deps.sessionRoot(),
    timeoutMs: 30_000,
  })
  let dwsDoc: Record<string, unknown> | null = null
  try {
    const parsed: unknown = parseJsonLoose(dwsRun.stdout)
    dwsDoc = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch (error) {
    void error
    dwsDoc = null
  }
  services.push({
    id: 'dingtalk',
    label: '钉钉认证',
    required: serviceRequired(manifest, 'dingtalk', true),
    ok: dwsDoc?.authenticated === true,
    state: shellUnavailable(dwsRun) ? '探测失败' : (dwsDoc === null ? '未知' : (dwsDoc.authenticated === true ? '已登录' : '未登录')),
    detail: dwsDoc?.message === undefined ? (text(dwsRun.stderr) || dwsRun.error) : text(dwsDoc.message),
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
    trust: { h3yun: state.trustH3yun },
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
