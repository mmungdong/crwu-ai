import type { Context } from '@deepseek-ai/cordis'
import { emptyIfindVerification, ifindCredentialView, type IfindVerification } from './store.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { LocalAccessSource } from '../access/operations.ts'
import { missingLocalAccessView } from '../access/consent.ts'
import type { IfindCheck } from '../environment/probe.ts'

/**
 * 把 iFinD 凭据的事实**翻译成环境自检的一项**。
 *
 * 三条硬规则：
 *
 * 1. **环境校验只读最近一次用户主动验证**：这里不访问 iFinD 远程服务；保存 API-Key 或点击
 *    「重新验证」时才会由 `ifind-ops.ts` 主动探测并保存脱敏结论。
 * 2. **验证 = 真的取一次数据**，不是只走 `initialize + tools/list`：认证通过不代表账号能取数
 *    （配额、权益、参数校验都可能失败）。结论分两截：`ok`（认证）与 `dataVerified`（真的拿到数据）。
 * 3. **iFinD 是必需项**（2026-09-26 产品口径覆盖了旧的 OPT-006-R1 · F-008）：`required` 直接
 *    来自环境清单（`crwu.env-manifest.v4` 的 `ifind.required`，现为 `true`），未通过就是阻塞项 ——
 *    进必需项分母、关闭 global / auditCore / externalData 能力、并让统一导航拦回环境页。
 *
 * 环境自检会被面板反复触发（打开面板、切模块、授权后刷新、点「重新检查」），
 * 它只能读取凭据文件里最近一次的脱敏结论，不能把这些 UI 动作解释成用户授权的远程探测。
 */

export interface IfindEnvOptions {
  /** 保留线兼容字段；环境校验永远不主动探测。 */
  probe?: boolean
  /** 保留线兼容字段；仅用户主动验证操作才会发起探测。 */
  force?: boolean
  signal?: AbortSignal
  /** 清单声明的 `ifind.required`（现为 true）；缺省按 true 处理（必需项是当前产品口径）。 */
  required?: boolean
  /**
   * Broker（协议 18）：读凭据/打外部取数之前必须过 Host 侧授权门禁。
   *
   * 不传时用一个**恒拒绝**的空 Broker：这条链路默认是关的，漏传只会读到"未授权"，
   * 不会静默放行（fail closed，而不是"没传就当允许"）。
   */
  access?: LocalAccessBroker
  /** 这次校验是谁发起的（默认 `panel`）。 */
  source?: LocalAccessSource
  /** 「获取 API-Key」的官方入口（从清单带过来，只用于界面上的链接）。 */
  applyUrl?: string
}

/** 一次探测结论 → 环境自检的一项（脱敏：只回长度、工具数与一小段数据摘要）。 */
function checkOf(view: Awaited<ReturnType<typeof ifindCredentialView>>, probe: IfindVerification,
                 applyUrl: string, required: boolean): IfindCheck {
  return {
    path: view.path,
    required,
    ok: probe.ok,
    // 认证通过但**没取到数据**时必须落到 `unverified`：界面上"未验证"是琥珀色、
    // 并给出"点重新验证 / 找管理员确认权益"的处置；`unreachable` 会被读成服务故障。
    // `errorKind` 仍然如实保留（credential / entitlement / infrastructure），所以归因不会丢。
    state: probe.ok && probe.dataVerified !== true ? 'unverified' : probe.state,
    errorKind: probe.errorKind === 'unconfigured' ? '' : probe.errorKind,
    reason: probe.error,
    tokenLength: view.length,
    checkedAt: probe.checkedAt,
    toolCount: probe.toolCount,
    dataVerified: probe.dataVerified,
    dataTool: probe.dataTool,
    dataSample: probe.dataSample,
    applyUrl,
  }
}

/**
 * 恒拒绝的空 Broker：**只为"没注入 Broker"这条路径准备**。
 *
 * 它让"忘了注入授权判据"变成"读不到凭据"，而不是"静默放行" —— 两个方向的错不对称。
 */
function missingAccessBroker(): LocalAccessBroker {
  const denied = (): { ok: false; error: string; errorClass: 'not-authorized' } =>
    ({ ok: false, error: '本机访问尚未允许（环境自检没有注入授权判据）', errorClass: 'not-authorized' })
  return {
    authorize: denied,
    async runShell() {
      return {
        ok: false, error: '本机访问尚未允许（环境自检没有注入授权判据）', exitCode: null,
        stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false,
        sandbox: { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false },
      }
    },
    async writeText() { return { ok: false, error: '本机访问尚未允许（环境自检没有注入授权判据）' } },
    async startShell() {
      return {
        ok: false,
        error: '本机访问尚未允许（环境自检没有注入授权判据）',
        sandbox: { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false },
      }
    },
    // 恒拒绝的空 Broker 不走 shell 也不写文件，所以没有需要留痕的非 shell 事实。
    note: () => undefined,
    consent: () => missingLocalAccessView(),
    diagnostics: () => [],
    lastDiagnostic: () => null,
  }
}

export async function ifindEnvCheck(
  ctx: Context,
  home: string,
  options: IfindEnvOptions = {},
): Promise<IfindCheck> {
  const view = await ifindCredentialView(ctx, home, {
    access: options.access ?? missingAccessBroker(), source: options.source ?? 'panel', workdir: home,
  })
  const required = options.required !== false
  const base: IfindCheck = {
    path: view.path,
    required,
    ok: false,
    state: view.exists ? (view.state === 'invalid' ? 'invalid' : 'unverified') : 'unconfigured',
    errorKind: '',
    reason: view.reason,
    tokenLength: view.length,
    checkedAt: '',
    toolCount: 0,
    dataVerified: false,
    dataTool: '',
    dataSample: '',
    applyUrl: options.applyUrl ?? '',
  }
  if (!view.exists) {
    return { ...base, state: 'unconfigured', reason: view.reason || '还没有保存同花顺 iFinD API-Key', errorKind: '' }
  }
  if (view.state === 'invalid') {
    return { ...base, state: 'invalid', errorKind: 'credential', reason: view.reason }
  }
  // 环境检查只读取保存时或用户点击「重新验证」时写入的脱敏结论。
  // 这里绝不读取明文，也不访问 iFinD 远程服务；普通检查、refresh、切换模块都只是本地读取。
  const verification = view.verification ?? emptyIfindVerification()
  if (verification.checkedAt === '') return base
  return checkOf(view, verification, options.applyUrl ?? '', required)
}
