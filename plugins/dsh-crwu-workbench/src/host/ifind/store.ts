import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { joinLocalPath } from '../../shared/utils/local-path.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { mkdirCommand, privateFileMechanism, removeFileCommand } from '../platform/shell.ts'
import { enforceCredentialPermission, hostStorePermission } from '../platform/credential-permission.ts'
import type { CredentialPermission } from '../../shared/types.ts'
import { runShell, shellUnavailable } from '../shell/run.ts'

/**
 * iFinD **API-Key** 的**插件自有凭据存储**。
 *
 * ## 为什么不再读技能目录
 *
 * 改造前令牌取自**上游 iFinD 技能目录**里的 `mcp_config.json` —— 那是第三方技能的私有文件。
 * 让运行时依赖它有三个后果：员工机器上必须先装那个技能；上游改一次格式我们就失联；
 * 而且"把密钥交给 Agent 代填"成了唯一路径（官方指引里就是这么写的，明确不采用）。
 *
 * 现在凭据（页面上的「API-Key」）由插件 Host 自己保管，落在**插件状态目录**：
 * `<home>/.dsh/crwu-workbench/ifind-credential.json`，0600。
 *
 * ## 三条边界（改这个文件前先读）
 *
 * 1. **不放在技能目录、也不放进插件包**：包目录是只读发布物，技能目录归上游；两者都不是
 *    「员工私有状态的落地处」。状态目录与 `crwu-workbench.json` 同级，跨插件重装保留。
 * 2. **返回值只允许是成功状态、错误分类与脱敏信息**：`readIfindSecret` 是唯一能拿到明文的
 *    出口，且只给 Host 内部（Tool / 探测）；面向界面与模型的 `ifindCredentialView` 只回长度。
 * 3. **写之前先校验、写之后收紧权限**：空值 / 占位符 / 首尾空白 / 换行在**写盘之前**就拒绝
 *    （写进去再报错会留下一个坏文件）；权限设置失败**如实上报**（`chmodOk=false`），不假装成功。
 *
 * 优先使用 DSH 的凭据存储服务：宿主若提供 `credentials` 服务（`set` / `get` 形状见
 * `HostCredentialStore`），就走它；当前 DSH 版本没有该服务，所以 `resolveIfindStore()` 会
 * 稳定地落到插件自有文件。判断集中在**一处**，接线时不必改调用方。
 */

/** 插件状态目录名（与 `crwu-workbench.json` 同一层）。 */
export const PLUGIN_STATE_DIR = '.dsh/crwu-workbench'
/** 凭据文件名。 */
export const IFIND_CREDENTIAL_FILE = 'ifind-credential.json'
/** 凭据字段名（保持与上游 `mcp_config.json` 同名字段，便于人工迁移）。 */
export const IFIND_CREDENTIAL_FIELD = 'auth_token'
/** 视为占位符的取值（上游文档里就是这么写的）。 */
export const IFIND_PLACEHOLDER = 'your ifind-mcp key'

/**
 * 凭据文件的绝对路径。
 *
 * 分隔符随主目录风格走（`joinLocalPath`）：这条路径交给 fs 与 shell 两条链路，
 * 混用分隔符在 Windows 上既进不了 `New-Item -Path`，也会被别的程序当转义。
 */
export function ifindCredentialPath(home: string): string {
  if (text(home) === '') return `~/${PLUGIN_STATE_DIR}/${IFIND_CREDENTIAL_FILE}`
  return joinLocalPath(home, PLUGIN_STATE_DIR, IFIND_CREDENTIAL_FILE)
}

/** 状态目录的绝对路径（`mkdir` / 权限收紧用）。 */
export function ifindStateDir(home: string): string {
  if (text(home) === '') return `~/${PLUGIN_STATE_DIR}`
  return joinLocalPath(home, PLUGIN_STATE_DIR)
}

export interface SecretVerdict {
  ok: boolean
  /** 失败原因（人话）；通过时为空串。 */
  reason: string
  /** 清洗后的密钥；校验不通过时为空串。 */
  value: string
  /** 密钥长度（只回长度，绝不回显）。 */
  length: number
  /** 失败归类：`input`（空/占位符/含空白换行）| `invalid`（格式不对）。 */
  errorKind: 'input' | 'invalid' | ''
}

/**
 * 校验一份 API-Key。**五种坏值都必须能分辨**，因为界面要给的处置不同：
 *
 * - 空值 / 全空白 → 「还没有填写」；
 * - 占位符 → 「还是模板里那句话，请替换成你自己的 SK」；
 * - 首尾空白 → 「两侧有多余空格，已清洗」→ 这里直接**拒绝并要求重填**（静默清洗会让员工
 *   以为自己填对了，而复制粘贴带上的空格是最常见的失败原因，说清楚比默默修好更有用）；
 * - 换行（含 `\r`）→ 「不能包含换行」；
 * - 太短 → 格式不对（`invalid`）。
 */
export function checkIfindSecret(raw: unknown, placeholder: unknown = IFIND_PLACEHOLDER): SecretVerdict {
  const value = text(raw)
  const expected = text(placeholder) || IFIND_PLACEHOLDER
  const bad = (reason: string, errorKind: 'input' | 'invalid'): SecretVerdict =>
    ({ ok: false, reason, value: '', length: 0, errorKind })
  if (value === '' || value.trim() === '') return bad('API-Key 为空，请填写你自己的同花顺 iFinD API-Key', 'input')
  if (value.trim().toLowerCase() === expected.toLowerCase()) {
    return bad(`API-Key 仍是占位符「${expected}」，请替换成你自己的 API-Key`, 'input')
  }
  if (/[\r\n]/.test(value)) return bad('API-Key 不能包含换行', 'input')
  if (value !== value.trim()) return bad('API-Key 两侧有多余空白（复制时容易带上），请去掉后重试', 'input')
  if (value.length < 8) return bad('API-Key 长度不足 8 位，看起来不是有效的同花顺 iFinD API-Key', 'invalid')
  return { ok: true, reason: '', value, length: value.length, errorKind: '' }
}

/** 只回长度的脱敏视图。**唯一**允许跨进程传输的凭据描述。 */
export interface IfindCredentialView {
  path: string
  exists: boolean
  /** `unconfigured` | `unverified` | `authenticated` | `invalid` | `unreachable`。 */
  state: string
  /** 明文长度；没配置是 0。 */
  length: number
  reason: string
}

/** Host 可选提供的凭据服务形状（当前 DSH 版本没有；有就走它）。 */
export interface HostCredentialStore {
  get(key: string): Promise<string | undefined> | string | undefined
  set(key: string, value: string): Promise<void> | void
  delete(key: string): Promise<void> | void
}

/** 解析可用的凭据存储：优先 DSH 服务，回落插件自有文件。 */
export function resolveIfindStore(ctx: Context): { kind: 'host' | 'file'; store?: HostCredentialStore } {
  const service = ctx.get('credentials') as HostCredentialStore | undefined
  if (service !== undefined && typeof service.get === 'function' && typeof service.set === 'function') {
    return { kind: 'host', store: service }
  }
  return { kind: 'file' }
}

/** 凭据存储的 key（`credentials` 服务用它；文件形态用文件名）。 */
export const IFIND_CREDENTIAL_KEY = 'crwu-workbench/ifind'

export interface ReadSecretResult {
  ok: boolean
  secret: string
  /** `unconfigured` | `invalid` | `unreachable`。 */
  state: string
  errorKind: 'input' | 'infrastructure' | ''
  reason: string
  /** 供界面与维护者详情展示的脱敏视图。 */
  view: IfindCredentialView
}

/**
 * 读明文（**Host 内部唯一出口**）。
 *
 * 失败时 `secret` 恒为空串，调用方只需看 `ok` / `state` / `errorKind`。任何分支都不得把
 * 文件内容带进 `reason`（文件里就是密钥本身）。
 */
export async function readIfindSecret(ctx: Context, home: string): Promise<ReadSecretResult> {
  const path = ifindCredentialPath(home)
  const empty = (state: string, errorKind: 'input' | 'infrastructure', reason: string): ReadSecretResult =>
    ({ ok: false, secret: '', state, errorKind, reason, view: { path, exists: false, state, length: 0, reason } })

  const resolved = resolveIfindStore(ctx)
  if (resolved.kind === 'host' && resolved.store !== undefined) {
    try {
      const raw = await resolved.store.get(IFIND_CREDENTIAL_KEY)
      const verdict = checkIfindSecret(raw)
      if (!verdict.ok) return empty(verdict.errorKind === 'invalid' ? 'invalid' : 'unconfigured', 'input', verdict.reason)
      return {
        ok: true, secret: verdict.value, state: 'unverified', errorKind: '', reason: '',
        view: { path: `credentials:${IFIND_CREDENTIAL_KEY}`, exists: true, state: 'unverified', length: verdict.length, reason: '' },
      }
    } catch (error) {
      return empty('unreachable', 'infrastructure',
        `读取 DSH 凭据存储失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const fs = fileSystem(ctx)
  if (fs === undefined) return empty('unreachable', 'infrastructure', 'Host 文件服务不可用，无法读取同花顺 iFinD 凭据')
  if (home === '') return empty('unreachable', 'infrastructure', '主目录未知，无法定位同花顺 iFinD 凭据文件')

  let raw = ''
  try {
    const target = await resolveTarget(ctx, path)
    const info = await fs.stat(target)
    if (info?.type !== 'file') {
      const reason = '还没有保存同花顺 iFinD API-Key'
      return { ok: false, secret: '', state: 'unconfigured', errorKind: 'input', reason,
        view: { path, exists: false, state: 'unconfigured', length: 0, reason } }
    }
    raw = await fs.readText(target)
  } catch (error) {
    void error
    const reason = '无法读取同花顺 iFinD 凭据文件'
    return { ok: false, secret: '', state: 'unreachable', errorKind: 'infrastructure', reason,
      view: { path, exists: false, state: 'unreachable', length: 0, reason } }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    void error
    const reason = '凭据文件不是合法 JSON，请重新保存一次 SK'
    return { ok: false, secret: '', state: 'invalid', errorKind: 'input', reason,
      view: { path, exists: true, state: 'invalid', length: 0, reason } }
  }
  const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const verdict = checkIfindSecret(record[IFIND_CREDENTIAL_FIELD])
  if (!verdict.ok) {
    return { ok: false, secret: '', state: 'invalid', errorKind: 'input', reason: verdict.reason,
      view: { path, exists: true, state: 'invalid', length: 0, reason: verdict.reason } }
  }
  return {
    ok: true, secret: verdict.value, state: 'unverified', errorKind: '', reason: '',
    view: { path, exists: true, state: 'unverified', length: verdict.length, reason: '' },
  }
}

/**
 * 只回脱敏视图（界面与模型可见的那一份）。
 *
 * 刻意**不返回明文**：调用方拿不到就不存在"顺手回显一下"的可能。
 */
export async function ifindCredentialView(ctx: Context, home: string): Promise<IfindCredentialView> {
  return (await readIfindSecret(ctx, home)).view
}

export interface WriteSecretResult {
  ok: boolean
  /** `credential` 是输入问题，`infrastructure` 是写盘/权限问题。 */
  errorKind: 'input' | 'infrastructure' | ''
  error: string
  /** 脱敏视图（成功后有 `exists=true` 与长度）。 */
  view: IfindCredentialView
  /** 目录创建结果；false 表示落盘可能失败。 */
  dirReady: boolean
  /**
   * 凭据文件的权限结论（结构化，协议 17）：`verified`（POSIX 0600 真的生效）/
   * `inherited`（Windows 继承账户 ACL，POSIX 0600 不适用）/ `failed`（真的没收紧，带原因）。
   * 旧字段 `chmodOk: boolean` 已删除：Windows 上它只能是 `true`，语义是错的。
   */
  permission: CredentialPermission
  /** 落盘模式：`host`（DSH 凭据服务）或 `file`（插件自有文件）。 */
  mode: 'host' | 'file'
}

/**
 * 写盘结果里的失败形状（集中一处，避免每个分支各写一遍）。
 *
 * `mechanism` 由**注入的平台事实**推出（`privateFileMechanism` 是唯一判据，不看 `process.platform`）；
 * 写盘都没成功时它只影响文案口径，`status` 恒为 `failed`。
 */
function writeFailure(
  kind: 'input' | 'infrastructure',
  error: string,
  path: string,
  platform: string,
): WriteSecretResult {
  return {
    ok: false, errorKind: kind, error, dirReady: false,
    permission: { status: 'failed', mechanism: privateFileMechanism(platform), message: error }, mode: 'file',
    view: { path, exists: false, state: 'unconfigured', length: 0, reason: error },
  }
}

/**
 * 保存 SK。
 *
 * 顺序是刻意的：**先校验 → 建目录 → 原子写入 → 收紧权限 → 自查**。
 * - 校验放在最前：坏值不留文件；
 * - `fs.writeText` 由 DSH 后端保证原子替换（临时文件 + rename），所以我们不需要自己写 tmp 文件；
 * - 写 `~/.dsh/` 在受限沙箱下会被拦，所以像状态文件一样显式声明 `danger-full-access`；
 * - 权限用 `chmod 600`，并用 `stat` 回读核对 —— 只跑 chmod 不看结果等于没验证。
 */
export async function writeIfindSecret(
  ctx: Context,
  home: string,
  rawSecret: unknown,
  options: { platform?: string; placeholder?: unknown } = {},
): Promise<WriteSecretResult> {
  const path = ifindCredentialPath(home)
  // 平台由调用方注入；先解析，失败信封与权限结论都用同一个值。
  const platform = text(options.platform)
  const verdict = checkIfindSecret(rawSecret, options.placeholder ?? IFIND_PLACEHOLDER)
  if (!verdict.ok) return writeFailure('input', verdict.reason, path, platform)

  const resolved = resolveIfindStore(ctx)
  if (resolved.kind === 'host' && resolved.store !== undefined) {
    try {
      await resolved.store.set(IFIND_CREDENTIAL_KEY, verdict.value)
      return {
        ok: true, errorKind: '', error: '', dirReady: true, permission: hostStorePermission(), mode: 'host',
        view: { path: `credentials:${IFIND_CREDENTIAL_KEY}`, exists: true, state: 'unverified', length: verdict.length, reason: '' },
      }
    } catch (error) {
      return writeFailure('infrastructure',
        `写入 DSH 凭据存储失败：${error instanceof Error ? error.message : String(error)}`, path, platform)
    }
  }

  if (home === '') return writeFailure('infrastructure', '主目录未知，无法保存同花顺 iFinD 凭据', path, platform)
  const fs = fileSystem(ctx)
  if (fs === undefined) return writeFailure('infrastructure', 'Host 文件服务不可用，无法保存同花顺 iFinD 凭据', path, platform)

  // 平台**由调用方注入**，不再回退 `process.platform`：回退会让单测与真实运行使用不同方言，
  // Windows 分支永远测不到 —— 而这里曾经正是这样漏掉 `cmd` 语义的。拿不到平台事实就不动手：
  // 建目录、权限收紧、路径分隔符全都依赖它。
  if (platform === '') {
    return writeFailure('infrastructure', '未知平台，拒绝在没有平台事实的情况下写凭据', path, platform)
  }
  const dir = ifindStateDir(home)
  const mkdirRun = await runShell(ctx, mkdirCommand(dir, platform), {
    workdir: home, timeoutMs: 15_000, escalate: true,
  })
  const dirReady = mkdirRun.ok
  if (!dirReady) {
    return writeFailure('infrastructure',
      `创建插件状态目录失败：${text(mkdirRun.stderr) || text(mkdirRun.error) || dir}`.slice(0, 300), path, platform)
  }

  const body = `${JSON.stringify({ [IFIND_CREDENTIAL_FIELD]: verdict.value }, null, 2)}\n`
  try {
    await fs.writeText(await resolveTarget(ctx, path), body, undefined, undefined, {
      mode: 'danger-full-access',
      workspaceRoot: home,
    })
  } catch (error) {
    return writeFailure('infrastructure',
      `写入 ${path} 失败：${error instanceof Error ? error.message : String(error)}`, path, platform)
  }

  // 权限结论由 `enforceCredentialPermission` 统一给出（三条结局各有名字，见 shared/types.ts）。
  const permission = await enforceCredentialPermission(ctx, path, platform, { workdir: home, escalate: true })
  return {
    ok: true, errorKind: '', error: '', dirReady, permission, mode: 'file',
    view: { path, exists: true, state: 'unverified', length: verdict.length, reason: '' },
  }
}

/** 清除 SK。**UI 必须二次确认**（这是不可撤销的：清掉之后要重新向管理员申请/回填）。 */
export async function clearIfindSecret(
  ctx: Context,
  home: string,
  options: { platform?: string } = {},
): Promise<{ ok: boolean; errorKind: 'infrastructure' | ''; error: string; mode: 'host' | 'file' }> {
  const resolved = resolveIfindStore(ctx)
  if (resolved.kind === 'host' && resolved.store !== undefined) {
    try {
      await resolved.store.delete(IFIND_CREDENTIAL_KEY)
      return { ok: true, errorKind: '', error: '', mode: 'host' }
    } catch (error) {
      return { ok: false, errorKind: 'infrastructure',
        error: `清除 DSH 凭据存储失败：${error instanceof Error ? error.message : String(error)}`, mode: 'host' }
    }
  }
  if (home === '') return { ok: false, errorKind: 'infrastructure', error: '主目录未知，无法清除同花顺 iFinD 凭据', mode: 'file' }
  const platform = text(options.platform)
  if (platform === '') {
    return { ok: false, errorKind: 'infrastructure', error: '未知平台，拒绝在没有平台事实的情况下清除凭据', mode: 'file' }
  }
  const result = await runShell(ctx, removeFileCommand(ifindCredentialPath(home), platform), {
    workdir: home, timeoutMs: 15_000, escalate: true,
  })
  if (!result.ok) {
    return { ok: false, errorKind: 'infrastructure',
      error: `${shellUnavailable(result) ? '清除命令没跑起来：' : '清除失败：'}${text(result.stderr) || text(result.error) || '未知原因'}`.slice(0, 300),
      mode: 'file' }
  }
  return { ok: true, errorKind: '', error: '', mode: 'file' }
}
