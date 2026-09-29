import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import type { DwsLocalDoctorView, DwsLocalRepairView } from '../../shared/types.ts'
import type { AccessDiagnostic } from '../access/diagnostics.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import {
  classifyAccessFailure, credentialStoreDeniedIn, lockRelatedIn, type AccessErrorClass,
} from '../access/classify.ts'
import type { LocalAccessSource } from '../access/operations.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import {
  chmodCommand, currentUidCommand, grantModifyAclCommand, readFileModeCommand,
  lockProbeCommand, parseLockProbe, pathWritableCommand, statOwnerModeCommand,
  windowsAclVerdictCommand, windowsModifyProbeCommand,
} from '../platform/shell.ts'
import { isWindowsPlatform } from '../platform/detect.ts'
import { redactPaths } from '../platform/redact.ts'
import { shellUnavailable, type ShellResult } from '../shell/run.ts'
import { runDws } from './run.ts'

/**
 * DWS 本机目录的**只读体检**与**最小权限修复**（协议 18 · 子项目 D2 / D3）。
 *
 * ## 这一层回答什么问题
 *
 * `dws` 打不开 `~/.dws/.data.lock` 时，员工看到的是同一句话，原因却可能是三种：
 * 沙箱写不了（子项目 B 已修）、**真的 NTFS ACL 不对**、锁被别的进程占着。前一种是策略问题，
 * 后两种是操作系统事实 —— 而"操作系统事实"只能靠平台原生检查回答，不能靠猜。
 *
 * ## 三条不许越过的线
 *
 * 1. **目标由插件推导、参数里没有路径**：`<home>/.dws`，`home` 来自 world facts。
 *    调用方提交路径的唯一后果是"把修复权指向任意目录"，所以 RPC 里根本没有这个字段。
 * 2. **只读体检与写入修复是两个操作**：`dws.local.permission` 只读事实，
 *    `dws.local.permission.repair` 才改权限，而且**只给面板**来源 + 显式 `confirm`。
 * 3. **绝不 `chown` / `takeown` / `sudo` / 删锁 / 杀进程**：所有权不对时如实报"要找管理员"，
 *    不是"我们替你拿过来"（设计 §3.4 / §D3）。
 *
 * ## 脱敏
 *
 * 返回体里没有 ACL 条目、账户名、SID、钥匙串条目名、原始 `dws doctor` 输出。
 * `directoryMode` / `lockMode` 只在 POSIX 上是规范化的八进制串，Windows 上恒为空串。
 * 两个布尔拿不到结论时是 `null`（**不是** `false`）—— "不知道"与"不行"的处置完全不同。
 */

export interface DwsLocalDeps {
  ctx: Context
  access: LocalAccessBroker
  home: string
  platform: string
  workdir: string
  source?: LocalAccessSource
  timeoutMs?: number
}

const DWS_DIR_NAME = '.dws'
const DWS_LOCK_NAME = '.data.lock'
/** 体检里那条网络相关的检查要有界：默认 10s 太久，诊断不该让人等。 */
const DOCTOR_TIMEOUT_SEC = 5
const DEFAULT_TIMEOUT_MS = 30_000

function dwsDirectoryOf(home: string, platform: string): string {
  const sep = isWindowsPlatform(platform) ? '\\' : '/'
  const base = home.replace(/[\\/]+$/, '')
  return base === '' ? '' : `${base}${sep}${DWS_DIR_NAME}`
}

/** 路径拼接（只用于**同一个**目录之下的固定名字，不做跨目录遍历）。 */
function childOf(dir: string, name: string, platform: string): string {
  const sep = isWindowsPlatform(platform) ? '\\' : '/'
  return dir === '' ? '' : `${dir}${sep}${name}`
}

/**
 * 一次 `stat` / `lstat` 探测的**三态**结果。
 *
 * `error` 这一态是被用户复查逼出来的：Windows 上 `Access is denied` 会让旧实现
 * （`catch` 一律 `return { exists: false }`）把"读不到"说成"不存在"，于是 doctor 报
 * 「`.dws` 目录不存在，请先登录一次」—— 而实际上目录就在那里，只是我们没权限看。
 * `lstat` 的异常同样被吞掉，于是"无法确认是不是符号链接"被当成"不是符号链接"，
 * 修复流程可能沿着链接去改权限。
 *
 * 所以：`absent` 只能来自 `stat → undefined`；任何抛错都是 `error`，
 * 而 `error` 必须**阻断权限修改**（拿不到事实就不许动手）。
 */
type StatProbe =
  | { state: 'present'; type: string; symlink: boolean }
  | { state: 'absent' }
  | { state: 'error'; reason: string }

async function statOf(deps: DwsLocalDeps, path: string): Promise<StatProbe> {
  const fs = fileSystem(deps.ctx)
  if (fs === undefined) return { state: 'error', reason: 'Host 文件服务不可用' }
  if (path === '') return { state: 'error', reason: '没有可探测的路径' }
  let info
  try {
    const target = await resolveTarget(deps.ctx, path)
    info = await fs.stat(target)
  } catch (error) {
    // 读不到 ≠ 不存在：这是本次要修的那条口径。
    // fs 的错误消息自带绝对路径（`EACCES: permission denied, stat '/Users/x/.dws'`）；
    // 这一条会进 doctor 视图与员工卡片，所以只留错误本身，路径换成 `<路径>`。
    return { state: 'error', reason: `无法探测路径：${redactPaths(error instanceof Error ? error.message : String(error))}` }
  }
  if (info === undefined) return { state: 'absent' }
  // `lstat` 是**不跟随**符号链接的那一面：修复前必须用它拒绝 symlink（§D3）。
  // 它抛错时也归 `error`（不是"不是 symlink"）。
  let link
  try {
    link = await fs.lstat(path)
  } catch (error) {
    return { state: 'error', reason: `无法确认是否为符号链接：${redactPaths(error instanceof Error ? error.message : String(error))}` }
  }
  return { state: 'present', type: text(info.type), symlink: link?.type === 'symlink' }
}

/** 体检里的"存在吗"：三态压成一个 `boolean | null`（`null` = 探测失败，不是"没有"）。 */
function existsOf(probe: StatProbe): boolean | null {
  if (probe.state === 'present') return true
  if (probe.state === 'absent') return false
  return null
}

/** 跑一条**固定的只读探测**命令并把结果收成事实。 */
async function probe(deps: DwsLocalDeps, command: string, summary: string): Promise<ShellResult | undefined> {
  if (command === '') return undefined
  return deps.access.runShell(
    { operation: 'dws.local.permission', source: deps.source ?? 'panel', workdir: deps.workdir },
    command,
    { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, summary },
  )
}

/**
 * 这条探测**自己**是不是被沙箱拦下了（或压根没跑起来）。
 *
 * ## 为什么必须判这一条（2026-09-29 在真机上抓到）
 *
 * 探测要求的权限是**逐次 `danger-full-access`**。但部署可以把提权降级（或沙箱后端直接不可用），
 * 那时 `test -w ~/.dws` 会**因为沙箱**回"不可写" —— 而真实情况可能完全正常
 * （实测：`~/.dws` 是 `700`、属主就是当前用户，在受限 shell 里 `test -w` 依然回 1）。
 *
 * 把这种结果当成"操作系统权限问题"，就会给员工一个**按下去会改权限**的按钮 ——
 * 而真正的原因在宿主/部署那一层。设计 §P-15 明确要求这一情形报沙箱事实、
 * **不**建议修操作系统权限。
 */
function probeSandboxed(result: ShellResult | undefined): boolean {
  if (result === undefined) return false
  const facts = result.sandbox
  if (facts.denied === true || facts.runnerFailed === true) return true
  // ⚠️ **只能看 `ran`，不能看 `resolved`。**
  //
  // `shell/run.ts` 里 `resolved = spec.sandboxPolicy?.mode` —— 那是**我们自己请求**的模式，
  // 不是执行器答回来的。特权操作的请求恒为 `danger-full-access`，所以 `resolved` 永远是它，
  // 拿它当"真的跑在完全访问下"的证据等于**不检查**（2026-09-29 用真机路径发现：
  // 替身返回的 ShellResult 形状被 `runShell` 忽略，而 `resolved` 恰好补上了那个洞，于是一条
  // 本该"不知道"的探测被当成了操作系统事实）。
  //
  // 只有 `ran`（`ShellRunResult.sandbox.mode`）是执行器真的报回来的。它为空说明这条 DSH
  // 不回模式 —— 那也**不算证据**：两个方向的错不对称，说"不知道"只是少帮一次，
  // 说"是权限问题"会给员工一个按下去真会改权限的按钮（fail closed）。
  return text(facts.ran) !== 'danger-full-access'
}

/** `owner=` / `modify=` 两行（Windows 的 PowerShell 判决脚本输出）。 */
/**
 * Windows ACL 判决 → 有效权限（协议 18 · D）。
 *
 * 输入是 `windowsAclVerdictCommand` 输出的 ACE 行：只有**角色标签**与**权限位掩码**
 *（不含 SID / 账户名 / 域名；数字不是身份）：
 *
 * ```
 * crwu-acl/2
 * owner=True
 * modify-mask=197055
 * ace=allow:self:197055
 * ace=deny:group:1179785
 * ```
 *
 * 数值对得上官方枚举（`FileSystemRights`）：`Modify = ReadAndExecute | Write | Delete = 197055`，
 * 而 `FullControl = 2032127`（2026-09-29 复查指出：之前注释与夹具把 `2032127` 标成 Modify，
 * 那是 FullControl —— 代码本身不硬编码这些位（由 `modify-mask` 给出），但夹具用错值会让
 * "覆盖写位"的算术在测试里失真）。
 *
 * 规则就是 Windows 自己的规则：**只看属于当前令牌的 ACE**（`self` 与 `group`；
 * `other` 与我们无关），**Deny 优先**，且**部分 Deny 也算数** ——
 * 算 `effective = (∪allow) & ~(∪deny)`，再判它是否覆盖 `modify-mask` 里的**写位**。
 * 继承与非继承的 ACE 都在输入里，所以继承天然算数。
 *
 * `modify-mask` 由 .NET 的 `FileSystemRights.Modify` 给出（插件侧不硬编码权限位）；
 * `crwu-acl/1` 是旧的标签格式（`ace=allow:self:modify`），**不认** —— 版本标记就是为了防止
 * 跨版本误读："看不懂"要落成 `null`（不知道），绝不能猜成"可以改"。
 */
export function parseAclVerdict(stdout: string): { owner: boolean | null; modify: boolean | null } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim())
  if (!lines.includes('crwu-acl/2')) return { owner: null, modify: null }
  const ownerLine = lines.find((line) => line.startsWith('owner='))
  const owner = ownerLine === undefined ? null : /true/i.test(ownerLine.slice('owner='.length))
  // `modify-mask` 由 PowerShell 用 .NET 的 `FileSystemRights.Modify` 给出 ——
  // 拿不到它就没法判"完整覆盖"，如实回 `null`（不知道），不许猜。
  const maskLine = lines.find((line) => line.startsWith('modify-mask='))
  const modifyMask = maskLine === undefined ? Number.NaN : Number.parseInt(maskLine.slice('modify-mask='.length), 10)
  if (!Number.isFinite(modifyMask) || modifyMask === 0) return { owner, modify: null }
  const aces = lines
    .filter((line) => line.startsWith('ace='))
    .map((line) => {
      const [kind, role, rights] = line.slice('ace='.length).split(':')
      return { kind: kind ?? '', role: role ?? '', rights: Number.parseInt(rights ?? '', 10) }
    })
    .filter((ace) => Number.isFinite(ace.rights))
  if (aces.length === 0) return { owner, modify: null }
  // 只看属于当前令牌的 ACE：`self`（本人 SID）与 `group`（所属组）。`other` 与我们无关。
  const mine = aces.filter((ace) => ace.role === 'self' || ace.role === 'group')
  // **有效权限 = 我方 Allow 之并集 减去 我方 Deny 之并集**。
  // Deny 优先这条规则在这里天然成立（Deny 的位会被减掉），
  // **部分 Deny**（只 Deny `WriteData` / `Delete` / `(W)`）同样会减掉对应位 ——
  // 旧实现只看"整条 Modify 位集被 Deny"，于是把这种情况误判成可改（2026-09-29 复查的 P2）。
  let allows = 0
  let denies = 0
  for (const ace of mine) {
    if (ace.kind === 'allow') allows |= ace.rights
    else if (ace.kind === 'deny') denies |= ace.rights
  }
  const effective = allows & ~denies
  // 判据是"**所需写权限**是否被完整覆盖"，不是"整条 Modify 位集都还在"：
  // `Modify` 里也含读位，若要求整条位集存活，那么一条只 Deny `ReadData` 的 ACE 会被
  // 判成"不可写" —— 那是另一个方向的错（真能写却说不能，修复入口该出现却不出现）。
  // `WRITE_BITS` 是写/删那几位：WriteData、AppendData、WriteEA、WriteAttributes、
  // DeleteSubdirectoriesAndFiles、Delete。平台说 Modify 是什么由 `modify-mask` 给出，
  // 这里只取其中"写"的那部分。
  const WRITE_BITS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000
  const required = modifyMask & WRITE_BITS
  if (required === 0) return { owner, modify: null }
  return { owner, modify: (effective & required) === required }
}
/** POSIX：`<uid> <mode>`（macOS `stat -f %u %Lp` / GNU `stat -c %u %a`）。 */
function parseOwnerMode(stdout: string): { uid: string; mode: string } {
  const parts = stdout.trim().split(/\s+/)
  return { uid: parts[0] ?? '', mode: parts[1] ?? '' }
}

/**
 * `stat` 的所有者/模式读取，**形状必须对**才产生结论：形如 `<uid> <mode>`。
 *
 * 为什么不能像 `parseOwnerMode` 那样"拿到什么算什么"：它把第一个 token 当 uid、第二个当 mode，
 * 于是一份**只有模式**的输出（`644`）会被读成"uid=644" —— 与当前账户不等 → 结论变成
 * "这个文件不是你的"，修复直接跳过。那不是安全，是**把可修的问题变成不可修的**
 *（2026-09-29 复查第 3 条时被夹具当场抓到：`.data.lock` 明明是我们的、写得进去，却被跳过）。
 * 形状不对时返回 `null`：**不知道**，不猜。
 */
function parseOwnerModeStrict(stdout: string): { uid: string; mode: string } | null {
  const parts = stdout.trim().split(/\s+/)
  if (parts.length !== 2) return null
  const uid = parts[0] ?? ''
  const mode = parts[1] ?? ''
  if (!/^\d+$/.test(uid)) return null
  if (!/^[0-7]{3,4}$/.test(mode)) return null
  return { uid, mode }
}

/**
 * `dws doctor --json` → **只留下状态词**。
 *
 * 原始输出里有账户名、钥匙串路径、服务名与提示语，一律不出去（§D2）。
 * 我们只保留：整体 pass/fail 计数、失败检查的**名字**、以及 keychain / auth 两项的状态。
 */
export function summarizeDoctorOutput(stdout: string): {
  state: string
  keychain: 'unknown' | 'available' | 'fail'
  authFailed: boolean
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    void error
    return { state: '', keychain: 'unknown', authFailed: false }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: '', keychain: 'unknown', authFailed: false }
  }
  const doc = parsed as { checks?: unknown; summary?: unknown }
  const checks = Array.isArray(doc.checks) ? doc.checks : []
  const failing: string[] = []
  let keychain: 'unknown' | 'available' | 'fail' = 'unknown'
  let authFailed = false
  for (const item of checks) {
    if (item === null || typeof item !== 'object') continue
    const check = item as { name?: unknown; status?: unknown }
    const name = text(check.name)
    const status = text(check.status)
    if (name === 'keychain') keychain = status === 'pass' ? 'available' : 'fail'
    if (name === 'auth' && status !== 'pass') authFailed = true
    if (status !== 'pass' && status !== '') failing.push(name)
  }
  const summary = doc.summary !== null && typeof doc.summary === 'object' && !Array.isArray(doc.summary)
    ? doc.summary as { pass?: unknown; fail?: unknown; warn?: unknown }
    : {}
  const pass = typeof summary.pass === 'number' ? summary.pass : 0
  const fail = typeof summary.fail === 'number' ? summary.fail : 0
  const warn = typeof summary.warn === 'number' ? summary.warn : 0
  // 只给计数与失败检查名（`auth` / `version` 这类固定枚举），不给 message / hint / detail。
  const state = `pass=${pass} fail=${fail} warn=${warn}${failing.length === 0 ? '' : ` failing=${failing.join(',')}`}`
  return { state, keychain, authFailed }
}

/** 凭据存储状态：从 `dws doctor` 的 keychain 检查推。 */
function credentialStoreStateOf(
  keychain: 'unknown' | 'available' | 'fail',
  authFailed: boolean,
): DwsLocalDoctorView['credentialStoreState'] {
  if (keychain === 'available') return authFailed ? 'missing-secret' : 'available'
  if (keychain === 'fail') return 'interaction-denied'
  return 'unknown'
}

/** 从**已脱敏**的 doctor 结论推凭据存储状态（只用在拿不到 doctor 输出时）。 */
function credentialStoreStateFromText(stdout: string): DwsLocalDoctorView['credentialStoreState'] {
  if (credentialStoreDeniedIn(stdout)) return 'interaction-denied'
  if (lockRelatedIn(stdout)) return 'unknown'
  return 'unknown'
}

/**
 * 只读体检。
 *
 * 顺序固定：先看路径存不存在（`fs`，零 shell），再按平台跑权限探测，最后跑一次
 * `dws doctor --json` 拿凭据存储状态。任何一步失败都只影响它自己那一项 ——
 * 体检**永远**返回一个完整视图，不因为某项拿不到就整体失败。
 */
/** DWS 相关操作的共同前缀（`dws.profile.read` / `dws.doctor.read` / `dws.local.permission` …）。 */
const DWS_OPERATION_PREFIX = 'dws.'

/** 空视图（未授权 / 平台未知 / 探测失败时都能如实构造一份，不用各处手写字段）。 */
function emptyDoctorView(platform: string): DwsLocalDoctorView {
  return {
    ok: true,
    error: '',
    platform,
    permissionMechanism: 'unknown',
    directoryExists: null,
    lockExists: null,
    ownerMatchesCurrentUser: null,
    currentUserCanModify: null,
    lockWritable: null,
    lockOwnerMatchesCurrentUser: null,
    directoryMode: '',
    lockMode: '',
    credentialStoreState: 'unknown',
    dwsDoctorState: '',
    canDiagnose: false,
    classification: '',
  }
}

/**
 * 取"最近一次**属于 DWS 的**失败"，也是体检的**前置门禁**。
 *
 * 旧实现直接读 `lastDiagnostic()` —— 那是**任意一条**最近诊断：员工刚上传失败（OSS）、
 * 或者刚查过一次氚云，体检就会拿那条失败去开 DWS 修复归因（"确诊了本机文件权限问题"），
 * 而它跟 `.dws` 一点关系都没有。
 *
 * 两条判据（都要满足）：
 * 1. 这条诊断的 operation 是 DWS 的那几个（`dws.*`）；
 * 2. 它是**当前待处理的那条失败** —— 也就是最近一条诊断，没有被更晚的其它操作挤到后面。
 *
 * 第 2 条是刻意的：体检自己也会跑特权命令，所以它必须在**体检开始之前**被取走
 * （`dwsLocalDoctor` 里就是这样），否则拿到的是体检自己的诊断。若最近一条是别的操作的，
 * 我们返回 `null`（"无法归因"）而不是硬认一条旧的。
 */
function recentDwsFailure(deps: DwsLocalDeps): AccessDiagnostic | null {
  // 取"最近一次**失败**"（新的在前）。两个细节都是踩过的：
  //
  // 1. `errorClass === ''` 是**成功**（命令跑完、退出码 0），不是失败。
  //    界面打开时的环境自检常常刚跑过一次成功的 `dws auth status`；如果拿"最新一条 dws 记录"
  //    当失败，体检会跑去给一次**成功**做归因。
  // 2. 判据是"最近一次失败**是不是** DWS 的"，不是"缓冲区里有没有 DWS 失败"：
  //    最近的失败属于 OSS 时，答案必须是"不体检"（用户复查明确要求），
  //    而不是往更早的记录里翻出一条 DWS 失败来用。
  //
  // 3. **访问控制的结果不是"失败"**：`not-authorized` / `invalid-source` 说的是"谁在调"，
  //    不是"这台机器上的 dws 怎么了"。把它们当可归因的失败，会让体检去回答一个
  //    跟文件权限无关的问题（而且这类记录最容易出现在员工刚点完「允许」的那一刻）。
  const newest = deps.access.diagnostics().find(isAttributableFailure)
  if (newest === undefined) return null
  if (!newest.operation.startsWith(DWS_OPERATION_PREFIX)) return null
  return newest
}

/** 访问控制的结果（谁在调），不是可归因的**执行失败**。 */
const ACCESS_CONTROL_CLASSES: ReadonlySet<string> = new Set(['not-authorized', 'invalid-source'])

/**
 * 现在**能不能**做可归因的体检（界面用这个事实决定按钮是否可点，**不由客户端猜**）。
 *
 * 与体检的前置门禁是**同一个判据**：有可归因的 DWS 失败，且它不是沙箱拒绝/降级。
 * 两处必须同源 —— 否则会出现"按钮亮着、点下去被拒"或"按钮灰着、其实能体检"
 *（后者更糟：员工以为功能坏了）。
 */
export function hasAttributableDwsFailure(deps: DwsLocalDeps): boolean {
  const failure = recentDwsFailure(deps)
  if (failure === null) return false
  return failure.errorClass !== 'sandbox-denied' && failure.errorClass !== 'sandbox-downgraded'
}

/** 这条诊断是不是"一次真的失败、可以被归因"：`''` 是成功，访问控制类不是执行失败。 */
function isAttributableFailure(entry: AccessDiagnostic): boolean {
  return entry.errorClass !== '' && !ACCESS_CONTROL_CLASSES.has(entry.errorClass)
}

export async function dwsLocalDoctor(deps: DwsLocalDeps): Promise<DwsLocalDoctorView> {
  // **⓪ 先过 Host 侧门禁**（协议 18 · P-11）。
  //
  // 体检的第一步就是 `stat ~/.dws` —— 那是本机文件。旧实现在授权之前就先 stat 了：
  // 界面挡住入口，但直接调 RPC 依然能看到"目录在不在、模式是什么"。这条判据必须在
  // **任何 fs / shell 调用之前**（`host-dws-local.test.mjs` 有"未授权 → fs 零调用"的用例）。
  const decision = deps.access.authorize({
    operation: 'dws.local.permission',
    source: deps.source ?? 'panel',
    workdir: deps.workdir,
  })
  if (!decision.ok) {
    return { ...emptyDoctorView(deps.platform), ok: false, error: decision.error, classification: 'not-authorized' }
  }

  // **先把"上一次失败"抓在手里**，再跑任何探测。
  //
  // 体检自己也要跑几条特权命令（`stat` / `id` / `test -w` / `dws doctor`），它们同样是本机访问、
  // 同样会进诊断环形缓冲 —— 于是等体检跑完再读 `lastDiagnostic()` 拿到的会是**体检自己**的某一条，
  // 原来那次真正的失败已经被挤到后面去了（第一版就是这样：确诊永远是空串，
  // `host-dws-local.test.mjs` 的 D-07 用例抓到了它）。
  const platform = deps.platform
  const windows = isWindowsPlatform(platform)
  const dir = dwsDirectoryOf(deps.home, platform)
  const lock = childOf(dir, DWS_LOCK_NAME, platform)
  const view: DwsLocalDoctorView = {
    ...emptyDoctorView(platform),
    permissionMechanism: dir === '' ? 'unknown' : (windows ? 'windows-acl' : 'posix-mode'),
  }
  if (dir === '') {
    return { ...view, ok: false, error: '拿不到主目录：无法推导 DWS 目录（拒绝按任意路径体检）', permissionMechanism: 'unknown' }
  }

  // **② 设计 §D2 的前置条件**：体检只在「刚刚发生过一次 DWS 失败，且结构化事实已经排除
  // 沙箱拒绝」之后才运行。理由不是省事：体检要跑几条特权命令、读 `~/.dws`、执行 `dws doctor`，
  // 而"没有失败"或"失败其实是沙箱拦的"这两种情况下，它给出的任何权限结论都是**无的放矢** ——
  // 甚至会把"沙箱不让读"翻译成"文件权限不对"，正好是这一层要防的事。
  //
  // 判据在**任何 fs / shell 调用之前**（下面紧接着就是 `statOf`）。
  const failure = recentDwsFailure(deps)
  if (failure === null) {
    return {
      ...emptyDoctorView(deps.platform),
      ok: false,
      error: '还没有可以归因的 DWS 失败：请先复现一次（体检只回答"刚才那次为什么失败"）。',
      canDiagnose: false,
      classification: 'not-applicable',
    }
  }
  if (failure.errorClass === 'sandbox-denied' || failure.errorClass === 'sandbox-downgraded') {
    return {
      ...emptyDoctorView(deps.platform),
      ok: false,
      error: '最近一次 DWS 失败是沙箱拦下的：改文件权限解决不了它，体检不会给出权限结论。',
      canDiagnose: false,
      classification: failure.errorClass,
    }
  }

  const dirStat = await statOf(deps, dir)
  const lockStat = await statOf(deps, lock)
  view.directoryExists = existsOf(dirStat)
  view.lockExists = existsOf(lockStat)
  // 探测失败就**到此为止**：拿不到事实时不许往下猜"不存在 / 权限不够 / 磁盘坏了"。
  const probeError = dirStat.state === 'error' ? dirStat : (lockStat.state === 'error' ? lockStat : undefined)
  if (probeError !== undefined) {
    return {
      ...view,
      ok: false,
      error: `无法确认本机 DWS 目录的状态：${probeError.reason}`,
      classification: 'infrastructure',
    }
  }

  // ── 锁占用（**正向探测**，不是"文件在不在"）────────────────────────────────
  // POSIX 用 `lsof`，Windows 用 `FileShare.None` 独占打开（都不写内容）。
  // Windows 上"打不开是因为 ACL"由探测脚本单独报 `Unknown`，不会混成"锁被占用"。
  let lockHeld: boolean | undefined
  if (lockStat.state === 'present') {
    const lockProbe = await probe(deps, lockProbeCommand(lock, platform), 'DWS 锁文件占用探测（只读）')
    if (lockProbe !== undefined && !shellUnavailable(lockProbe) && !probeSandboxed(lockProbe)) {
      lockHeld = parseLockProbe(lockProbe)
    }
  }

  // ── 权限事实 ────────────────────────────────────────────────────────────────
  let filesystemAccessDenied: boolean | undefined
  const lockPresent = lockStat.state === 'present'
  if (dirStat.state === 'present' && windows) {
    const verdict = await probe(deps, windowsAclVerdictCommand(dir, platform), 'dws 目录 ACL 判决（只读）')
    if (verdict !== undefined && !shellUnavailable(verdict) && !probeSandboxed(verdict)) {
      const parsed = parseAclVerdict(verdict.stdout)
      view.ownerMatchesCurrentUser = parsed.owner
      view.currentUserCanModify = parsed.modify
      if (parsed.modify === false) filesystemAccessDenied = true
    }
    // **锁文件自己的 ACL**：原始报错目标就是 `.data.lock`。只看目录会让
    // "目录正常、锁文件不可写"退化成 `cli`，修复入口永远不出现（用户复查的 P1）。
    if (lockPresent) {
      const lockVerdict = await probe(deps, windowsAclVerdictCommand(lock, platform), 'dws 锁文件 ACL 判决（只读）')
      if (lockVerdict !== undefined && !shellUnavailable(lockVerdict) && !probeSandboxed(lockVerdict)) {
        const parsedLock = parseAclVerdict(lockVerdict.stdout)
        view.lockOwnerMatchesCurrentUser = parsedLock.owner
        view.lockWritable = parsedLock.modify
        if (parsedLock.modify === false) filesystemAccessDenied = true
      }
    }
  } else if (dirStat.state === 'present') {
    const ownerMode = await probe(deps, statOwnerModeCommand(dir, platform), 'dws 目录所有者与模式（只读）')
    const uid = await probe(deps, currentUidCommand(platform), '当前 uid（只读）')
    const writable = await probe(deps, pathWritableCommand(dir, platform), 'dws 目录可写探测（只读）')
    // 只有**这条探测自己真的跑在完全访问下**时，它的结论才算操作系统事实。
    const writableIsEvidence = writable !== undefined && !shellUnavailable(writable) && !probeSandboxed(writable)
    if (ownerMode !== undefined && !shellUnavailable(ownerMode) && !probeSandboxed(ownerMode)) {
      const parsed = parseOwnerModeStrict(ownerMode.stdout)
      if (parsed !== null) {
        view.directoryMode = parsed.mode
        if (uid !== undefined && !shellUnavailable(uid)) {
          const mine = uid.stdout.trim()
          if (mine !== '') view.ownerMatchesCurrentUser = parsed.uid === mine
        }
      }
    }
    if (writableIsEvidence) {
      view.currentUserCanModify = writable.exitCode === 0
      if (writable.exitCode !== 0) filesystemAccessDenied = true
    } else if (writable !== undefined && !shellUnavailable(writable)) {
      // 探测被沙箱拦下：如实说"不知道"（`null`），**不**说"不行"。
      view.currentUserCanModify = null
    }
    if (lockPresent) {
      const lockMode = await probe(deps, readFileModeCommand(lock, platform), 'dws 锁文件模式（只读）')
      if (lockMode !== undefined && !shellUnavailable(lockMode)) view.lockMode = lockMode.stdout.trim()
      // **锁文件自己也探一次**（与目录同样口径：只读文件系统探测，不看 `resolved`）：
      // `stat` 拿属主/模式、`test -w` 拿"当前账户能不能写"。只有探测自己真的跑在完全访问下
      // 才算操作系统事实；被沙箱拦下时留 `null`（不知道），**不许**当成"不行"。
      const lockOwner = await probe(deps, statOwnerModeCommand(lock, platform), 'dws 锁文件所有者与模式（只读）')
      if (lockOwner !== undefined && !shellUnavailable(lockOwner) && !probeSandboxed(lockOwner)) {
        const parsedLock = parseOwnerModeStrict(lockOwner.stdout)
        if (parsedLock !== null) {
          view.lockMode = parsedLock.mode
          if (uid !== undefined && !shellUnavailable(uid)) {
            const mine = uid.stdout.trim()
            if (mine !== '') view.lockOwnerMatchesCurrentUser = parsedLock.uid === mine
          }
        }
      }
      const lockWritable = await probe(deps, pathWritableCommand(lock, platform), 'dws 锁文件可写探测（只读）')
      if (lockWritable !== undefined && !shellUnavailable(lockWritable) && !probeSandboxed(lockWritable)) {
        view.lockWritable = lockWritable.exitCode === 0
        if (lockWritable.exitCode !== 0) filesystemAccessDenied = true
      } else if (lockWritable !== undefined && !shellUnavailable(lockWritable)) {
        view.lockWritable = null
      }
    }
  }

  // ── 凭据存储 / DWS 自检 ─────────────────────────────────────────────────────
  const doctor = await runDws(deps.ctx, platform, ['doctor', '--json', '--timeout', String(DOCTOR_TIMEOUT_SEC)], {
    workdir: deps.workdir,
    access: deps.access,
    source: deps.source ?? 'panel',
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  const combined = `${doctor.stdout}\n${doctor.stderr}\n${doctor.error}`
  if (doctor.ok) {
    const summary = summarizeDoctorOutput(doctor.stdout)
    view.dwsDoctorState = summary.state
    view.credentialStoreState = credentialStoreStateOf(summary.keychain, summary.authFailed)
  } else if (doctor.errorKind === 'infrastructure' || doctor.errorKind === 'approval' || doctor.errorKind === 'capability-gap') {
    // 命令根本没跑起来：如实留空，**不**据此说"钥匙串坏了"。
    view.dwsDoctorState = ''
    view.credentialStoreState = 'unknown'
  } else {
    view.dwsDoctorState = 'fail'
    view.credentialStoreState = credentialStoreStateFromText(combined)
  }

  // ── 归因：把结构化事实 + 本次探测的结论交给分类器 ───────────────────────────
  //
  // 平台级那几档要求「实际跑在完全访问下、且沙箱没有拒绝过」；这里的探测就是在完全访问下
  // 做的（操作本身是特权操作），所以探测为真时可以把上一次的 `cli` 升级成 `os-*`。
  // 前置门禁已经保证 `failure` 是"一次可归因的失败"（非空类别、非访问控制、非沙箱），
  // 所以这里**一定**走分类器 —— 早先那个 `else { classification = failure.errorClass }`
  // 分支在前置门禁落地之后就永远不可达了（留着会让人以为还有一条"直接采用失败类别"的路）。
  view.canDiagnose = true
  if (failure !== null) {
    view.classification = classifyAccessFailure({
      platform,
      sandbox: {
        requested: failure.requestedMode,
        resolved: failure.resolvedMode,
        ran: failure.ranMode,
        denied: failure.sandboxDenied,
        runnerFailed: failure.runnerFailed,
      },
      // 诊断里不存退出码：失败且进程起来过 → 按"跑完了但非 0"参与分类。
      exitCode: failure.processStarted ? 1 : null,
      // ⚠️ 这里的 `text` 是**本次体检**的输出，不是原来那次失败的文本 —— 原文本没有落盘
      //（诊断只存类别）。定性靠的是 `probes`（本次平台探测的正向结论），文本只做补充判据。
      text: combined,
      probes: {
        ...(filesystemAccessDenied === undefined ? {} : { filesystemAccessDenied }),
        ...(view.credentialStoreState === 'interaction-denied' ? { credentialStoreDenied: true } : {}),
        ...(view.credentialStoreState === 'missing-secret' ? { credentialStoreMissing: true } : {}),
        // **锁必须有正向探测**：`lockExists` 只是"文件在"，残留锁文件与"真有进程握着"
        // 看着完全一样（设计 §D）。拿不到结论时这一项**不出现**，分类器于是否决 `file-lock`。
        ...(lockHeld === true ? { lockHeld: true } : {}),
        // **并且原始那次失败必须与锁有关**（设计 §D：锁文本 + 正向探测，两者缺一不可）。
        // 这个事实由 Broker 在失败当时算好（只存布尔值，不存文本）——
        // 只看 `lockHeld` 会把"认证失败 + 机器上恰好有人持锁"说成文件锁（用户复查的 P2）。
        lockRelated: failure.lockRelated,
      },
    })
  }
  return view
}

/**
 * 最小权限修复（**必须在面板上二次确认**）。
 *
 * 前置全部在服务端判，不看客户端说了什么：
 * 1. RPC 必须带 `{ confirm: true }`（形状不对直接拒）；
 * 2. 体检必须先确诊 `os-filesystem-permission` —— 沙箱拒绝 / 降级 / 凭据存储 / 认证失败 /
 *    锁 / 所有者不对时**一律不修**（改权限解决不了那些问题，反而会掩盖它们）；
 * 3. 目标只允许 `<home>/.dws` 与它下面的 `.data.lock`，两者都必须是**非符号链接**的实体；
 * 4. 所有者不是当前账户时**不修**（那是管理员的事，我们不做 `chown`）。
 */
export async function dwsLocalPermissionRepair(
  deps: DwsLocalDeps,
  args: Record<string, unknown>,
): Promise<DwsLocalRepairView> {
  /**
   * 早退信封。
   *
   * 注意"没确认"那一支用的是一份**空**体检视图：连只读探测都不许跑。
   * （第一版把体检放在确认之前，于是"没确认"的调用照样执行了一串 `stat` / `id` / `test -w` ——
   * `host-dws-local.test.mjs` 的 D-04 用例抓到了这个形状。）
   */
  const refused = (error: string, doctor: DwsLocalDoctorView | null = null): DwsLocalRepairView => ({
    ok: false,
    error,
    repaired: [], skipped: [], authStatus: '',
    doctor: doctor ?? {
      ...emptyDoctorView(deps.platform),
      ok: false, error, platform: deps.platform,
      directoryExists: false, lockExists: false,
    },
  })

  // ① 参数形状：**只**接受 `{ confirm: true }`。多一个键就是另一种形状，直接拒。
  //
  //    「拒绝每一个其它形状」是设计文档 §D3 的原话，而且是安全要求：这一层一旦容忍
  //    `{ path, confirm: true }` 这种夹带，路径就不再由 Host 推导了。
  if (args.confirm !== true || Object.keys(args).some((key) => key !== 'confirm')) {
    return refused('权限修复只接受 { confirm: true }：这次调用的参数形状不对，未做任何改动')
  }
  if (deps.source !== undefined && deps.source !== 'panel') {
    return refused('权限修复只能从工作台面板发起')
  }

  const before = await dwsLocalDoctor(deps)
  const refuse = (error: string): DwsLocalRepairView => refused(error, before)

  // ① **体检自己拒绝了**（未授权 / 没有可归因的失败 / 最近一次是沙箱拦的 / 推不出目录）：
  //    如实转述它的原因，**不要**换成"目录不存在"那种更笼统的话 —— 那会把
  //    "最近一次失败是沙箱拦下的，改权限没用" 说成 "请先登录一次"，员工就被指错了方向。
  if (!before.ok) return refuse(before.error)

  // ② 所有者不对：**先于**其它判断 —— 这是"要找管理员"这一类，不是"我们替你改"。
  //    放在确诊之后会让它被"结论不是权限问题"掩盖掉，员工就拿不到正确的处置。
  if (before.ownerMatchesCurrentUser === false) {
    return refuse('DWS 目录的所有者不是当前账户：这需要管理员处理，插件不会改变所有权（不执行 chown / takeown）')
  }
  // ③ 没有可修复的对象。放在确诊之前：这是比"结论不是权限问题"更具体、更可操作的答案
  //    （员工该做的是先完成一次登录，而不是去猜权限）。
  if (!before.directoryExists) {
    return refuse('DWS 目录不存在：没有可修复的对象（请先在面板里完成一次钉钉登录）')
  }
  // ④ 这些结论**明确不是**"文件权限问题"：改权限解决不了它们，只会把真正的原因盖掉。
  //    设计 §D3 要求界面在这些情形下不渲染按钮；服务端同样要拒（客户端可以伪造请求）。
  const NOT_A_PERMISSION_PROBLEM: Record<string, string> = {
    'sandbox-denied': '结论是沙箱拒绝：这是宿主/部署策略问题，改文件权限解决不了',
    'sandbox-downgraded': '结论是提权被降级：这是宿主/部署策略问题，改文件权限解决不了',
    'infrastructure': '结论是基础设施故障（命令根本没跑起来）：改文件权限解决不了',
    'os-credential-store': '结论是操作系统凭据存储（钥匙串）：改文件权限解决不了',
    'file-lock': '结论是文件锁被占用：请先关闭正在使用 DWS 的程序，插件不会删锁或结束进程',
    'approval-denied': '结论是审批被拒绝：改文件权限解决不了',
    'not-authorized': '还没有允许工作台访问本机账号和配置：请先在面板里完成「允许」，再重试',
  }
  const blocked = NOT_A_PERMISSION_PROBLEM[before.classification]
  if (blocked !== undefined) return refuse(`${blocked}，未做任何改动`)
  if (before.credentialStoreState === 'interaction-denied' || before.credentialStoreState === 'access-denied') {
    return refuse('结论指向操作系统凭据存储（钥匙串交互/访问被拒）：改文件权限解决不了，未做任何改动')
  }
  // ⑤ **正向确诊**：必须已经由体检证明"这台机器上的路径确实改不了"。
  //
  //    不能只凭"目录不可写"这一点就动手 —— 那也可能是"还没登录"顺带造成的表象。
  //    判据就是体检给出的归因（它已经把上一次失败的结构化事实与本次平台探测合在一起算过）。
  if (before.classification !== 'os-filesystem-permission') {
    return refuse(`当前结论是 ${before.classification || '（无）'}，没有确诊"本机文件权限问题"：未做任何改动`)
  }
  if (before.lockExists && before.currentUserCanModify === false && lockRelatedIn(before.dwsDoctorState)) {
    // 锁被持有是"另一个进程在用"，不是权限问题。
    return refuse('结论指向文件锁被占用：请先关闭正在使用 DWS 的程序，插件不会删除锁文件或结束进程')
  }
  const platform = deps.platform
  const windows = isWindowsPlatform(platform)
  const dir = dwsDirectoryOf(deps.home, platform)
  const lock = childOf(dir, DWS_LOCK_NAME, platform)
  const repaired: string[] = []
  const skipped: string[] = []

  const dirStat = await statOf(deps, dir)
  // 探测失败 → **拒绝动手**（拿不到事实就不许改权限；旧实现会把异常当成"不是符号链接"继续）。
  if (dirStat.state === 'error') return refuse(`无法确认 DWS 目录的状态：${dirStat.reason}`)
  if (dirStat.state === 'present' && dirStat.symlink) return refuse('DWS 目录是符号链接：拒绝沿着链接修改权限')

  // **只修被证明有问题的对象**（用户复查的 P1）：目录一切正常而只有 `.data.lock` 不可写
  //（原始报错正是 `opening lock file ... Access is denied`）时，不许顺手把目录也改一遍。
  // 判据取自**本次体检**（`before`），不看客户端说了什么。
  //
  // 目录：确定不可写 → 修；可写但模式不是目标值（POSIX 的 700）→ 也修（那是设计要的最小权限收紧）；
  //      可写且已是目标值 → **不动**。拿不到结论（`null`）时不猜：不动。
  // 锁文件：确定不可写 → 修；模式不是 600 → 也修；正常 → 不动。
  const dirNeedsRepair = before.currentUserCanModify === false
    || (before.currentUserCanModify === true && before.directoryMode !== '' && before.directoryMode !== '700')
  // 锁文件不是当前账户的 → **不修**（与目录同一条口径：改别人的文件要走管理员）。
  const lockIsOurs = before.lockOwnerMatchesCurrentUser !== false
  const lockNeedsRepair = lockIsOurs && (before.lockWritable === false
    || (before.lockWritable === true && before.lockMode !== '' && before.lockMode !== '600'))

  if (windows) {
    // 只补一条最小 Modify 授权；`icacls /grant` 追加，不动 SYSTEM / Administrators / 继承。
    const grantDir = !dirNeedsRepair
      ? { ok: false, exitCode: 1, stdout: '', stderr: '' }
      : await deps.access.runShell(
      { operation: 'dws.local.permission.repair', source: 'panel', workdir: deps.workdir },
      grantModifyAclCommand(dir, platform, { inherit: true }),
      { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, summary: 'icacls 授予当前账户 Modify（目录）' },
    )
    if (!dirNeedsRepair) skipped.push('directory-acl-ok')
    else if (grantDir.ok && grantDir.exitCode === 0) repaired.push('directory-acl')
    else skipped.push('directory-acl')

    if (before.lockExists === true && lockNeedsRepair) {
      const lockStat = await statOf(deps, lock)
      if (lockStat.state === 'error') skipped.push('lock-acl')
      else if (lockStat.state === 'present' && lockStat.symlink) skipped.push('lock-acl')
      else {
        const grantLock = await deps.access.runShell(
          { operation: 'dws.local.permission.repair', source: 'panel', workdir: deps.workdir },
          grantModifyAclCommand(lock, platform, { inherit: false }),
          { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, summary: 'icacls 授予当前账户 Modify（锁文件）' },
        )
        if (grantLock.ok && grantLock.exitCode === 0) repaired.push('lock-acl')
        else skipped.push('lock-acl')
      }
    } else if (before.lockExists === true) {
      skipped.push(lockIsOurs ? 'lock-acl-ok' : 'lock-not-owner')
    }
  } else {
    const chmodDir = !dirNeedsRepair
      ? { ok: false, exitCode: 1, stdout: '', stderr: '' }
      : await deps.access.runShell(
      { operation: 'dws.local.permission.repair', source: 'panel', workdir: deps.workdir },
      chmodCommand('700', dir, platform),
      { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, summary: 'chmod（dws 目录）' },
    )
    if (!dirNeedsRepair) skipped.push('directory-mode-ok')
    else if (chmodDir.ok && chmodDir.exitCode === 0) repaired.push('directory-mode')
    else skipped.push('directory-mode')

    if (before.lockExists === true && lockNeedsRepair) {
      const lockStat = await statOf(deps, lock)
      if (lockStat.state === 'error') skipped.push('lock-mode')
      else if (lockStat.state === 'present' && lockStat.symlink) skipped.push('lock-mode')
      else {
        const chmodLock = await deps.access.runShell(
          { operation: 'dws.local.permission.repair', source: 'panel', workdir: deps.workdir },
          chmodCommand('600', lock, platform),
          { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, summary: 'chmod（dws 锁文件）' },
        )
        if (chmodLock.ok && chmodLock.exitCode === 0) repaired.push('lock-mode')
        else skipped.push('lock-mode')
      }
    } else if (before.lockExists === true) {
      skipped.push(lockIsOurs ? 'lock-mode-ok' : 'lock-not-owner')
    }
  }

  // ③ 修完**重新体检**（设计 §D3）：不重新读一次就等于把"命令跑过了"说成"修好了"。
  const after = await dwsLocalDoctor(deps)
  const auth = await runDws(deps.ctx, platform, ['auth', 'status', '--format', 'json'], {
    workdir: deps.workdir,
    access: deps.access,
    source: 'panel',
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  const authStatus = auth.ok
    ? (/authenticated"\s*:\s*true/i.test(auth.stdout) ? 'authenticated' : 'not-authenticated')
    : (auth.errorKind === '' ? 'failed' : auth.errorKind)

  // ③ **回读才是"修好了没有"的判据**，不是命令的退出码。
  //
  // `chmod` / `icacls` 退出码 0 而实际没生效的情形真实存在（网络盘、只读挂载、被上层策略覆盖），
  // 所以逐项核对回读结果：修了哪一类，就要看到哪一类的后置条件成立。
  // 只有"命令跑过了"却说成"修好了"，就是设计文档 §2 那张表里点名的"把结果报得比事实好"。
  let aclWriteProbe: boolean | undefined
  if (windows && (repaired.includes('directory-acl') || repaired.includes('lock-acl'))) {
    // 目录：建一个临时文件再删掉；锁文件：以写方式打开一次。两者都能体现组权限、Deny 与继承。
    const dirProbe = repaired.includes('directory-acl')
      ? await deps.access.runShell(
        { operation: 'dws.local.permission.repair', source: 'panel', workdir: deps.workdir },
        windowsModifyProbeCommand(dir, 'directory', platform),
        { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, summary: 'Windows 写权限实测（目录）' },
      )
      : undefined
    const lockProbe = repaired.includes('lock-acl') && before.lockExists === true
      ? await deps.access.runShell(
        { operation: 'dws.local.permission.repair', source: 'panel', workdir: deps.workdir },
        windowsModifyProbeCommand(lock, 'file', platform),
        { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, summary: 'Windows 写权限实测（锁文件）' },
      )
      : undefined
    const verdicts = [dirProbe, lockProbe]
      .filter((item): item is ShellResult => item !== undefined)
      .map((item) => /modify=True/i.test(item.stdout))
    aclWriteProbe = verdicts.length > 0 && verdicts.every((ok) => ok)
  }

  const verified = (() => {
    if (!after.ok) return false
    if (repaired.includes('directory-mode') && after.directoryMode !== '700') return false
    if (repaired.includes('lock-mode') && after.lockMode !== '600') return false
    if (repaired.includes('directory-acl') || repaired.includes('lock-acl')) {
      // Windows 上"ACE 算出来有 Modify"仍然只是**推断**。修复是写操作，所以这里可以、
      // 也应该让系统自己回答：**真的去写一下**。
      if (aclWriteProbe !== true) return false
      if (after.ownerMatchesCurrentUser === false) return false
    }
    return true
  })()

  if (repaired.length === 0) {
    return {
      ok: false,
      error: '权限修复没有产生任何改动（命令被拒或路径不可改）',
      repaired, skipped, doctor: after, authStatus,
    }
  }
  return {
    ok: verified,
    error: verified ? '' : '权限修复命令执行了，但回读的结果与预期不符（权限可能被上层策略覆盖）',
    repaired,
    skipped,
    doctor: after,
    authStatus,
  }
}
