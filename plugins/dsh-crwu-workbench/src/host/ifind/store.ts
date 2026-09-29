import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { joinLocalPath } from '../../shared/utils/local-path.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { mkdirCommand, privateFileMechanism, removeFileCommand } from '../platform/shell.ts'
import { credentialPermissionSatisfied, enforceCredentialPermission, hostStorePermission } from '../platform/credential-permission.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { LocalAccessSource } from '../access/operations.ts'
import type { CredentialPermission } from '../../shared/types.ts'
import { shellUnavailable } from '../shell/run.ts'

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
  /** 最近一次用户主动验证的脱敏结论；没有记录时是 unverified。 */
  verification: IfindVerification
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

/** 最近一次**用户主动**验证的脱敏结论；它随凭据一起保存，环境自检只读它。 */
export interface IfindVerification {
  ok: boolean
  state: string
  errorKind: string
  error: string
  toolCount: number
  toolNames: string[]
  protocolVersion: string
  checkedAt: string
  dataVerified: boolean
  dataTool: string
  dataSample: string
}

export function emptyIfindVerification(): IfindVerification {
  return {
    ok: false, state: 'unverified', errorKind: '', error: '', toolCount: 0, toolNames: [],
    protocolVersion: '', checkedAt: '', dataVerified: false, dataTool: '', dataSample: '',
  }
}

function verificationOf(raw: unknown): IfindVerification {
  const empty = emptyIfindVerification()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const value = raw as Record<string, unknown>
  const states = new Set(['unverified', 'authenticated', 'invalid', 'unreachable'])
  const state = text(value.state)
  return {
    ok: value.ok === true,
    state: states.has(state) ? state : 'unverified',
    errorKind: text(value.errorKind),
    error: text(value.error).slice(0, 500),
    toolCount: Number.isInteger(value.toolCount) && Number(value.toolCount) >= 0 ? Number(value.toolCount) : 0,
    toolNames: Array.isArray(value.toolNames) ? value.toolNames.map(text).filter(Boolean).slice(0, 100) : [],
    protocolVersion: text(value.protocolVersion),
    checkedAt: text(value.checkedAt),
    dataVerified: value.dataVerified === true,
    dataTool: text(value.dataTool),
    dataSample: text(value.dataSample).slice(0, 300),
  }
}

function documentOf(secret: string, verification?: IfindVerification): string {
  return `${JSON.stringify({
    [IFIND_CREDENTIAL_FIELD]: secret,
    ...(verification === undefined ? {} : { verification }),
  }, null, 2)}\n`
}

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
export async function readIfindSecret(
  ctx: Context,
  home: string,
  options: { access: LocalAccessBroker; source?: LocalAccessSource; workdir?: string },
): Promise<ReadSecretResult> {
  const path = ifindCredentialPath(home)
  const noVerification = emptyIfindVerification()
  const empty = (state: string, errorKind: 'input' | 'infrastructure', reason: string): ReadSecretResult =>
    ({ ok: false, secret: '', state, errorKind, reason,
      view: { path, exists: false, state, length: 0, reason, verification: noVerification } })

  // **Host 侧门禁**（协议 18 · P-11）：界面把按钮禁掉只是体验，RPC 才是边界。
  // 未授权时 provider / fs / credential store **零调用** —— 撤销之后直接调 RPC 也读不到任何东西。
  const decision = options.access.authorize({
    operation: 'ifind.credential.read',
    source: options.source ?? 'panel',
    workdir: options.workdir ?? home,
  })
  if (!decision.ok) return empty('unconfigured', 'infrastructure', decision.error)

  const resolved = resolveIfindStore(ctx)
  if (resolved.kind === 'host' && resolved.store !== undefined) {
    try {
      const raw = await resolved.store.get(IFIND_CREDENTIAL_KEY)
      const parsed = (() => {
        try { return JSON.parse(raw ?? '') as unknown } catch { return null }
      })()
      const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { [IFIND_CREDENTIAL_FIELD]: raw }
      const verdict = checkIfindSecret(record[IFIND_CREDENTIAL_FIELD])
      if (!verdict.ok) return empty(verdict.errorKind === 'invalid' ? 'invalid' : 'unconfigured', 'input', verdict.reason)
      return {
        ok: true, secret: verdict.value, state: 'unverified', errorKind: '', reason: '',
        view: { path: `credentials:${IFIND_CREDENTIAL_KEY}`, exists: true, state: 'unverified', length: verdict.length, reason: '',
          verification: verificationOf(record.verification) },
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
      view: { path, exists: false, state: 'unconfigured', length: 0, reason, verification: noVerification } }
    }
    raw = await fs.readText(target)
  } catch (error) {
    void error
    const reason = '无法读取同花顺 iFinD 凭据文件'
    return { ok: false, secret: '', state: 'unreachable', errorKind: 'infrastructure', reason,
      view: { path, exists: false, state: 'unreachable', length: 0, reason, verification: noVerification } }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    void error
    const reason = '凭据文件不是合法 JSON，请重新保存一次 SK'
    return { ok: false, secret: '', state: 'invalid', errorKind: 'input', reason,
      view: { path, exists: true, state: 'invalid', length: 0, reason, verification: noVerification } }
  }
  const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const verdict = checkIfindSecret(record[IFIND_CREDENTIAL_FIELD])
  if (!verdict.ok) {
    return { ok: false, secret: '', state: 'invalid', errorKind: 'input', reason: verdict.reason,
      view: { path, exists: true, state: 'invalid', length: 0, reason: verdict.reason, verification: noVerification } }
  }
  const verification = verificationOf(record.verification)
  return {
    ok: true, secret: verdict.value, state: 'unverified', errorKind: '', reason: '',
    view: { path, exists: true, state: 'unverified', length: verdict.length, reason: '', verification },
  }
}

/**
 * 只回脱敏视图（界面与模型可见的那一份）。
 *
 * 刻意**不返回明文**：调用方拿不到就不存在"顺手回显一下"的可能。
 */
export async function ifindCredentialView(
  ctx: Context,
  home: string,
  options: { access: LocalAccessBroker; source?: LocalAccessSource; workdir?: string },
): Promise<IfindCredentialView> {
  // 走同一个读函数：**视图也是本机事实**（存在与否、长度），所以要过同一道门禁。
  // 未授权时它不是"没配置"，而是"还没有允许读取" —— 由 `reason` 如实说明。
  return (await readIfindSecret(ctx, home, options)).view
}

export interface WriteSecretResult {
  ok: boolean
  /**
   * `input` 是输入问题，`infrastructure` 是写盘/环境问题，
   * `policy` 是**权限后置条件没成立**（文件写进去了但没被保护住，见 P-09/M-04）。
   */
  errorKind: 'input' | 'infrastructure' | 'policy' | ''
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
    view: { path, exists: false, state: 'unconfigured', length: 0, reason: error, verification: emptyIfindVerification() },
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
  options: { platform?: string; placeholder?: unknown; access: LocalAccessBroker },
): Promise<WriteSecretResult> {
  const path = ifindCredentialPath(home)
  // 平台由调用方注入；先解析，失败信封与权限结论都用同一个值。
  const platform = text(options.platform)
  const verdict = checkIfindSecret(rawSecret, options.placeholder ?? IFIND_PLACEHOLDER)
  if (!verdict.ok) return writeFailure('input', verdict.reason, path, platform)

  const resolved = resolveIfindStore(ctx)
  if (resolved.kind === 'host' && resolved.store !== undefined) {
    // 宿主凭据服务也是「本机凭据」：写之前同样要过门禁（旧实现直接 `store.set`，
    // 未授权也能写进去，等于绕开收据）。
    const decision = options.access.authorize({ operation: 'ifind.credential.write', source: 'panel', workdir: home })
    if (!decision.ok) return writeFailure('input', decision.error, path, platform)
    try {
      await resolved.store.set(IFIND_CREDENTIAL_KEY, documentOf(verdict.value))
      return {
        ok: true, errorKind: '', error: '', dirReady: true, permission: hostStorePermission(), mode: 'host',
        view: { path: `credentials:${IFIND_CREDENTIAL_KEY}`, exists: true, state: 'unverified', length: verdict.length, reason: '', verification: emptyIfindVerification() },
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
  const mkdirRun = await options.access.runShell(
    { operation: 'ifind.credential.permission', source: 'panel', workdir: home },
    mkdirCommand(dir, platform),
    { timeoutMs: 15_000, summary: 'ifind.credential.permission（建目录）' },
  )
  const dirReady = mkdirRun.ok
  if (!dirReady) {
    return writeFailure('infrastructure',
      `创建插件状态目录失败：${text(mkdirRun.stderr) || text(mkdirRun.error) || dir}`.slice(0, 300), path, platform)
  }

  const body = documentOf(verdict.value)
  const written = await options.access.writeText(
    { operation: 'ifind.credential.write', source: 'panel', workdir: home },
    { kind: 'ifind-credential', path },
    body,
  )
  if (!written.ok) {
    return writeFailure('infrastructure', `写入 iFinD 凭据失败：${written.error}`, path, platform)
  }

  // 权限结论由 `enforceCredentialPermission` 统一给出（三条结局各有名字，见 shared/types.ts）。
  const permission = await enforceCredentialPermission({
    access: options.access, operation: 'ifind.credential.permission', path, platform, workdir: home,
  })
  // 权限没成立就不算保存成功（P-09/M-04）：POSIX 上必须**回读**为 0600。
  // 旧形态回 `ok:true` + 一句附带的错误字符串，界面漏看就会把"其实没保护住"当成功。
  if (!credentialPermissionSatisfied(permission)) {
    return {
      ok: false, errorKind: 'policy',
      error: `凭据已写入 ${path}，但权限没有生效：${permission.message}`,
      dirReady, permission, mode: 'file',
      view: { path, exists: true, state: 'unverified', length: verdict.length, reason: permission.message, verification: emptyIfindVerification() },
    }
  }
  return {
    ok: true, errorKind: '', error: '', dirReady, permission, mode: 'file',
    view: { path, exists: true, state: 'unverified', length: verdict.length, reason: '', verification: emptyIfindVerification() },
  }
}

/** 保存一次用户主动探测的脱敏结论；环境自检只读取这份结论，不打远程请求。 */
export async function persistIfindVerification(
  ctx: Context,
  home: string,
  verification: IfindVerification,
  options: { platform?: string; access: LocalAccessBroker },
): Promise<{ ok: boolean; error: string }> {
  const current = await readIfindSecret(ctx, home, { access: options.access, source: 'panel', workdir: home })
  if (!current.ok) return { ok: false, error: current.reason || '没有可更新的同花顺 iFinD 凭据' }
  const resolved = resolveIfindStore(ctx)
  const body = documentOf(current.secret, verification)
  if (resolved.kind === 'host' && resolved.store !== undefined) {
    const decision = options.access.authorize({ operation: 'ifind.credential.write', source: 'panel', workdir: home })
    if (!decision.ok) return { ok: false, error: decision.error }
    try {
      await resolved.store.set(IFIND_CREDENTIAL_KEY, body)
      return { ok: true, error: '' }
    } catch (error) {
      return { ok: false, error: `保存 iFinD 验证结论失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const written = await options.access.writeText(
    { operation: 'ifind.credential.write', source: 'panel', workdir: home },
    { kind: 'ifind-credential', path: ifindCredentialPath(home) },
    body,
  )
  if (!written.ok) return { ok: false, error: `保存 iFinD 验证结论失败：${written.error}` }
  const platform = text(options.platform)
  if (platform !== '') {
    const permission = await enforceCredentialPermission({
      access: options.access, operation: 'ifind.credential.permission', path: ifindCredentialPath(home), platform, workdir: home,
    })
    if (!credentialPermissionSatisfied(permission)) return { ok: false, error: `保存 iFinD 验证结论失败：${permission.message}` }
  }
  return { ok: true, error: '' }
}

/** 清除 SK。**UI 必须二次确认**（这是不可撤销的：清掉之后要重新向管理员申请/回填）。 */
export async function clearIfindSecret(
  ctx: Context,
  home: string,
  options: { platform?: string; access: LocalAccessBroker },
): Promise<{ ok: boolean; errorKind: 'infrastructure' | ''; error: string; mode: 'host' | 'file' }> {
  const resolved = resolveIfindStore(ctx)
  if (resolved.kind === 'host' && resolved.store !== undefined) {
    // 宿主凭据服务的删除同样是跨边界动作：未授权时不许动它（否则就等于绕开收据清凭据）。
    const decision = options.access.authorize({ operation: 'ifind.credential.clear', source: 'panel', workdir: home })
    if (!decision.ok) return { ok: false, errorKind: 'infrastructure', error: decision.error, mode: 'host' }
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
  const result = await options.access.runShell(
    { operation: 'ifind.credential.clear', source: 'panel', workdir: home },
    removeFileCommand(ifindCredentialPath(home), platform),
    { timeoutMs: 15_000, summary: 'ifind.credential.clear' },
  )
  if (!result.ok) {
    return { ok: false, errorKind: 'infrastructure',
      error: `${shellUnavailable(result) ? '清除命令没跑起来：' : '清除失败：'}${text(result.stderr) || text(result.error) || '未知原因'}`.slice(0, 300),
      mode: 'file' }
  }
  return { ok: true, errorKind: '', error: '', mode: 'file' }
}
