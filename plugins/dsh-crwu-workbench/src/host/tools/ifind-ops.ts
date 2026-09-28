import type { Context } from '@deepseek-ai/cordis'
import { clearIfindSecret, ifindCredentialView, readIfindSecret, writeIfindSecret } from '../ifind/store.ts'
import { defaultIfindTransport, probeIfind, IFIND_SERVER_TYPES, type IfindServerType, type IfindTransport } from '../ifind/mcp.ts'

/**
 * iFinD 的**凭据生命周期**（Host 操作，不是模型可见的 Tool）。
 *
 * 三条边界：
 *
 * 1. **保存 / 清除 / 探测都只经插件 Host**：界面把 SK 交给 `ifind-credential-save`，Host 校验、
 *    写盘、收紧权限、然后**立刻真实探测一次**；界面永远拿不到已保存的明文。
 * 2. **不出现在模型上下文里**：不是 `defineTool` 注册的工具，模型看不到也调不到；
 *    返回值只含状态、错误分类与脱敏信息（长度 / 掩码）。
 * 3. **清除要二次确认**：`ifind-credential-clear` 在 Host 侧要求 `confirm: true`，
 *    而且返回值里明确说"已清除"—— UI 少一次确认不会变成静默删数据。
 */

export interface IfindOpsDeps {
  ctx: Context
  /** 主目录（凭据落在它下面的插件状态目录）。 */
  home: () => Promise<string>
  /** 平台（chmod 命令的引用方式）。 */
  platform: () => Promise<string>
  /** 可注入传输：测试用内存替身，永不访问真实网络。 */
  transport?: IfindTransport
  /** 探测超时（测试用短超时）。 */
  timeoutMs?: number
}

/** 保存结果的**线协议**形状：只有状态、分类与脱敏摘要。 */
export interface IfindSaveResult {
  ok: boolean
  error: string
  /** `input`（SK 本身的问题）| `infrastructure`（写盘/权限/网络）。 */
  errorKind: string
  /** 脱敏视图：路径 + 是否存在 + 状态 + 长度。**没有明文**。 */
  view: { path: string; exists: boolean; state: string; length: number; reason: string }
  /** 权限是否真的收紧到 0600。 */
  chmodOk: boolean
  chmodError: string
  /** 落盘模式：`host`（DSH 凭据服务）或 `file`（插件自有文件）。 */
  mode: string
  /** 保存后立刻做的**真实**探测结果。 */
  probe: IfindProbeView
}

/** 探测结果的线协议形状（脱敏）。 */
export interface IfindProbeView {
  ok: boolean
  /** `unconfigured` | `unverified` | `authenticated` | `invalid` | `unreachable`。 */
  state: string
  /** `credential` | `entitlement` | `infrastructure` | `unconfigured` | `''`。 */
  errorKind: string
  error: string
  toolCount: number
  /** 工具名（不带 schema；模型与界面都不需要完整 schema 才能工作）。 */
  toolNames: string[]
  protocolVersion: string
  checkedAt: string
  /** **真的取到数据了吗**（认证通过 ≠ 能取数，两个结论分开给）。 */
  dataVerified: boolean
  /** 取数用的工具名（证明用的是哪个工具）。 */
  dataTool: string
  /** 取数结果的**脱敏**短摘要。 */
  dataSample: string
}

function probeViewOf(result: Awaited<ReturnType<typeof probeIfind>>): IfindProbeView {
  return {
    ok: result.ok,
    state: result.state,
    errorKind: result.errorKind,
    error: result.error,
    toolCount: result.toolCount,
    toolNames: result.toolNames,
    protocolVersion: result.protocolVersion,
    checkedAt: result.checkedAt,
    dataVerified: result.dataVerified === true,
    dataTool: result.dataTool,
    dataSample: result.dataSample,
  }
}

/** 当前凭据的脱敏视图（不发任何网络请求）。 */
export async function ifindStatus(deps: IfindOpsDeps): Promise<IfindProbeView & { path: string }> {
  const home = await deps.home()
  const view = await ifindCredentialView(deps.ctx, home)
  return {
    ok: view.exists && view.state !== 'invalid',
    // 只读文件是**不**足以说「已认证」的：这里如实回 `unverified`，认证结论只能来自真实探测。
    state: view.state,
    errorKind: view.exists ? '' : 'unconfigured',
    error: view.reason,
    toolCount: 0,
    toolNames: [],
    protocolVersion: '',
    checkedAt: '',
    dataVerified: false,
    dataTool: '',
    dataSample: '',
    path: view.path,
  }
}

/** 保存 API-Key → 立刻真实探测（含**真的取一次数据**）。 */
export async function ifindCredentialSave(
  deps: IfindOpsDeps,
  args: Record<string, unknown>,
): Promise<IfindSaveResult> {
  const home = await deps.home()
  const platform = await deps.platform()
  const written = await writeIfindSecret(deps.ctx, home, args.secret, { platform })

  const failedView = (errorKind: string, error: string): IfindSaveResult => ({
    ok: false, error, errorKind, view: written.view,
    chmodOk: written.chmodOk, chmodError: written.chmodError, mode: written.mode,
    probe: { ok: false, state: 'unconfigured', errorKind: errorKind === 'input' ? 'unconfigured' : 'infrastructure',
      error, toolCount: 0, toolNames: [], protocolVersion: '', checkedAt: '',
      dataVerified: false, dataTool: '', dataSample: '' },
  })
  if (!written.ok) return failedView(written.errorKind || 'infrastructure', written.error)

  // 权限没收紧成功：**不作废已保存的凭据**（员工刚填好），但必须如实报告 ——
  // 0600 是这份文件的安全边界，不能静默放过。
  const probe = await probeIfind(deps.transport ?? defaultIfindTransport(), await readSecretFor(deps), {
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  })
  return {
    ok: true,
    error: written.chmodOk ? '' : `凭据已保存，但权限没有收紧到 0600：${written.chmodError}`,
    errorKind: '',
    view: { ...written.view, state: probe.state },
    chmodOk: written.chmodOk,
    chmodError: written.chmodError,
    mode: written.mode,
    probe: probeViewOf(probe),
  }
}

/** 清除 API-Key（要求显式确认）。 */
export async function ifindCredentialClear(
  deps: IfindOpsDeps,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; error: string; cleared: boolean; path: string }> {
  const home = await deps.home()
  const platform = await deps.platform()
  const path = (await ifindCredentialView(deps.ctx, home)).path
  if (args.confirm !== true) {
    return { ok: false, error: '清除同花顺 iFinD API-Key 是不可撤销的操作，需要显式确认（confirm: true）', cleared: false, path }
  }
  const cleared = await clearIfindSecret(deps.ctx, home, { platform })
  return { ok: cleared.ok, error: cleared.error, cleared: cleared.ok, path }
}

/** 只做一次真实探测（保存之后的复检 / 界面上的「重新验证」）。 */
export async function ifindProbe(deps: IfindOpsDeps, args: Record<string, unknown> = {}): Promise<IfindProbeView & { path: string }> {
  const home = await deps.home()
  const view = await ifindCredentialView(deps.ctx, home)
  const secret = await readSecretFor(deps)
  if (secret === '') {
    return {
      ok: false, state: view.state === 'invalid' ? 'invalid' : 'unconfigured',
      errorKind: 'unconfigured', error: view.reason || '还没有保存同花顺 iFinD API-Key',
      toolCount: 0, toolNames: [], protocolVersion: '', checkedAt: '',
      dataVerified: false, dataTool: '', dataSample: '', path: view.path,
    }
  }
  const serverType = typeof args.serverType === 'string' ? args.serverType : 'stock'
  const signal = args.signal instanceof AbortSignal ? args.signal : undefined
  const probe = await probeIfind(deps.transport ?? defaultIfindTransport(), secret, {
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(isServerType(serverType) ? { serverType } : {}),
    ...(signal === undefined ? {} : { signal }),
  })
  return { ...probeViewOf(probe), path: view.path }
}

/** 读明文（只给探测用；**不导出到线协议**）。 */
async function readSecretFor(deps: IfindOpsDeps): Promise<string> {
  const home = await deps.home()
  const result = await readIfindSecret(deps.ctx, home)
  return result.ok ? result.secret : ''
}

function isServerType(value: string): value is IfindServerType {
  return (IFIND_SERVER_TYPES as readonly string[]).includes(value)
}
