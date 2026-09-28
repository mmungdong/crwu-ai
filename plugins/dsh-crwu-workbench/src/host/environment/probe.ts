import type { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { text } from '../../shared/utils/value.ts'
import { sanitizeOssError, OSS_OUTPUT_LIMIT } from '../oss/sanitize.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { binPlatformDir, bundledBinaryPath, binaryFileName } from '../platform/bin-dir.ts'
import { isWindowsPlatform } from '../platform/detect.ts'
import { packageRootFrom } from '../platform/package-root.ts'
import { runShell, shellUnavailable } from '../shell/run.ts'
import type { EnvManifest, OssSpec, PackagedToolSpec, ServiceSpec } from './manifest-default.ts'
import { quoteArg } from './manifest.ts'

/**
 * 随插件发布的组件（`crwu` / `dws` / `ossutil`）的完整性与 ossutil 的定位。
 *
 * **这一层只认包内**（2026-09-25 改造）：
 * - 只 `stat` 包内 `bin/<平台>/<文件>`，与包内 `bin/manifest.json` 的**字节数**比对；
 * - **不** `command -v`、**不**回退 PATH 上的同名命令、**不**执行 `dws version`；
 * - 缺失时的文案是「插件包不完整 / 平台不受支持」，绝不提示员工去安装命令。
 *
 * 为什么把「执行版本命令」整条去掉：
 * 1. `dws version` 会在二进制旁产生 `.dws/` 状态目录，`bin/` 会整包带走，
 *    `pack:assert:strict` 会把它判成运行残留（发布门禁直接红）；
 * 2. 每次自检都跑三个进程去读版本，本来就是自检里最慢的一段，而版本是否一致是**发布**的事 ——
 *    `bin/manifest.json` 里已经记着 sourceVersion 与 sha256。
 *
 * 为什么**不**在自检里重算 sha256：三个二进制加起来一百多 MB，哈希一次要几百毫秒到数秒；
 * 哈希是发布门禁（`pack:assert:strict` / `bin:check`）的判据，自检只把清单里记的哈希读出来
 * 放进维护者详情，用来做人工对账。
 */

export interface PackagedToolCheck {
  name: string
  label: string
  /** 包内文件名（Windows 平台带 `.exe`）。 */
  file: string
  present: boolean
  sizeBytes: number
  /** 包内 `bin/manifest.json` 里声明的字节数；读不到时是 0。 */
  manifestSizeBytes: number
  /** 包内清单里记的 sha256（**不**在自检里重算）；读不到时是空串。 */
  sha256: string
  expectedVersion: string
  note: string
  ok: boolean
  reason: string
}

/** 插件内置组件的整体检查结果（② 层的唯一数据源）。 */
export interface PackageIntegrityCheck {
  ok: boolean
  /** 当前平台是否有随包发布的组件目录（`BUNDLED_BIN_PLATFORMS`）。 */
  supported: boolean
  platform: string
  packageRoot: string
  manifestPath: string
  manifestFound: boolean
  tools: PackagedToolCheck[]
  note: string
}

/**
 * 单个服务的探测结果（氚云 / 钉钉登录态，以及 OSS 交付探测）。
 *
 * `errorKind` 是给 OSS 的**结构化归因**（2026-09-26）：`credential`（AK 无效）/
 * `permission`（没有目标 Bucket/Prefix 权限）/ `config`（Bucket 或 Endpoint 配错）/
 * `infrastructure`（网络、超时、包内 ossutil 或执行环境故障）。四类的处置完全不同，
 * 压成一句「OSS 连接不可用」会让员工与管理员互相踢皮球。
 */
export interface ServiceCheck {
  id: string
  label: string
  required: boolean
  ok: boolean
  state: string
  detail: string
  /** 归因；不需要归因的服务（氚云 / 钉钉）留空串。 */
  errorKind?: string
  /** 探测目标（`oss://bucket/prefix/` 这类），**不含凭据**；只用于开发者诊断。 */
  target?: string
}

/**
 * iFinD 凭据检查结果（**只回长度与状态，绝不回显**）。
 *
 * `ok` 与 `dataVerified` 必须分开：`ok` 只代表认证通过（`initialize + tools/list`），
 * `dataVerified` 代表**真的取到了一次数据**（`tools/call` 返回非错误、非空内容）。
 * 环境校验的判据是后者 —— 认证过了却取不到数是常见的后置失败（权益 / 配额 / 参数）。
 */
export interface IfindCheck {
  path: string
  required: boolean
  ok: boolean
  /** `unconfigured` | `unverified` | `authenticated` | `invalid` | `unreachable`。 */
  state: string
  /** `credential` | `entitlement` | `infrastructure` | `unconfigured` | `''`。 */
  errorKind: string
  reason: string
  tokenLength: number
  /** 最近一次真实探测的时刻（ISO 串）；没探过是空串。 */
  checkedAt: string
  /** 这次真实探测拿到了几个工具；没探过是 0。 */
  toolCount: number
  /** **真的取到数据了吗**（`tools/call` 成功返回内容）。 */
  dataVerified: boolean
  /** 取数验证用的工具名（没取数时空串）。 */
  dataTool: string
  /** 取数结果的**脱敏**短摘要（最多 300 字符）。 */
  dataSample: string
  /** 「获取 API-Key」的官方入口（界面上的链接）；Host 不代填、不索取。 */
  applyUrl: string
}

/**
 * 把一个参数安全地放进**该平台真实使用的 shell** 的命令串里。
 *
 * POSIX 上就是 `bash -c`：能不加引号就不加（`quoteArg`），需要时用单引号 + `'\''`。
 *
 * **Windows 上是 PowerShell，不是 `cmd.exe`**（DSH 在 Windows 挂 `@deepseek-ai/dsh-pwsh-local`，
 * 整串命令交给 `pwsh -Command`）。所以这里用 PowerShell 的单引号字面量、内部单引号翻倍：
 * 双引号在 PowerShell 里会做 `$` / 反引号插值（路径或 URL 里出现 `$` 就会被当变量展开），
 * 而单引号是纯字面量。cmd 那套 `"…"` + `""` 转义在这里既没必要也不安全。
 *
 * 以引号开头的命令还需要 PowerShell 的调用运算符 `&` —— 那是**命令位置**的事，由下面的
 * `shellInvoke()` 负责；`shellQuote` 只管「一个参数」。
 */
export function shellQuote(value: unknown, platform: string): string {
  if (!isWindowsPlatform(text(platform))) return quoteArg(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 拼一条**可执行文件 + 参数**的命令串（命令位置）。
 *
 * 为什么不能直接 `${shellQuote(exe, platform)} 参数…`（2026-09-28 修，员工在 Windows 上实测报错）：
 * DSH 在 Windows 挂的执行器是 `@deepseek-ai/dsh-pwsh-local`，它把整条命令作为**一个 argv 元素**
 * 交给 `pwsh -NoLogo -NoProfile -NonInteractive -Command <整串>`（该包自己的 README：*the command
 * string is passed as ONE argv element to `-Command`; PowerShell itself parses the text*）。
 * 也就是说插件拼的是 **PowerShell 脚本**，不是 `cmd.exe` 的批处理行。
 *
 * 后果很硬：**以引号开头的 token 在 PowerShell 里是字符串表达式，不是命令调用**。
 *
 * ```text
 * PS> "C:\…\crwu.exe" "h3yun" "session" "status"
 * 表达式或语句中包含意外的标记"h3yun"。
 * ```
 *
 * 员工看到的正是这个：环境页「氚云员工会话」「钉钉认证」两行一起红，因为它们的命令都以包内绝对
 * 路径开头。PowerShell 的调用运算符 `&` 才是「把这段字符串当命令执行」，所以 Windows 上必须写
 * `& 'C:\…\crwu.exe' 'h3yun' 'session' 'status'`。
 *
 * POSIX 上**绝不能**加 `&`：`bash -c` 里它是后台作业，会把前台命令变成异步执行。
 *
 * 所有「第一条 token 是可执行文件」的调用点都必须走这里，而不是自己 join ——
 * `tests/unit/host-shell-fs.test.mjs` 里有静态守卫钉着这一点。
 */
export function shellInvoke(executable: string, args: readonly string[], platform: string): string {
  const parts = [executable, ...args].map((item) => shellQuote(item, platform))
  return isWindowsPlatform(text(platform)) ? `& ${parts.join(' ')}` : parts.join(' ')
}

/**
 * 包内路径：`<包根>` 与 `<包根>/bin/manifest.json`。
 *
 * 为什么不用相对层数硬拼：这份代码在源码形态（`src/host/environment/`，距包根 3 层）与构建产物
 * （`lib/`，距包根 1 层）里都跑，由 `packageRootFrom` 按 `package.json` 定位才是唯一可靠的做法。
 * 导出它是为了让测试与实现比对**同一条**路径，而不是各写一份。
 */
export function packageIntegrityPaths(): { packageRoot: string; manifestPath: string } {
  const packageRoot = packageRootFrom(dirname(fileURLToPath(import.meta.url)))
  return { packageRoot, manifestPath: packageRoot === '' ? '' : join(packageRoot, 'bin', 'manifest.json') }
}

/** 包内 `bin/manifest.json` 里某个平台声明的组件（`size` / `sha256` / `sourceVersion`）。 */
interface BinManifestTool {
  file: string
  size: number
  sha256: string
  sourceVersion: string
}

/** 读包内 `bin/manifest.json` 里某个平台的声明；读不到就返回空表（**不**当成「没有组件」）。 */
function readBinManifest(raw: unknown, platform: string): { found: boolean; tools: Map<string, BinManifestTool> } {
  const tools = new Map<string, BinManifestTool>()
  let parsed: unknown
  try {
    parsed = JSON.parse(text(raw))
  } catch (error) {
    // 不是合法 JSON：调用方按「读不到清单」处理（不完整），不是异常。
    void error
    return { found: false, tools }
  }
  const doc = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const platforms = Array.isArray(doc.platforms) ? doc.platforms : []
  for (const entry of platforms) {
    const row = entry !== null && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    if (text(row.platform) !== platform) continue
    for (const item of Array.isArray(row.tools) ? row.tools : []) {
      const tool = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {}
      const file = text(tool.file)
      if (file === '') continue
      tools.set(text(tool.tool) || file, {
        file,
        size: typeof tool.size === 'number' && Number.isFinite(tool.size) ? tool.size : 0,
        sha256: text(tool.sha256),
        sourceVersion: text(tool.sourceVersion),
      })
    }
    return { found: true, tools }
  }
  return { found: false, tools }
}

/** 「插件包不完整 / 平台不受支持」那一句：三件组件共用，措辞里不许出现「安装命令」。 */
export function packageGapMessage(platform: string, detail: string): string {
  return `插件包不完整 / 平台不受支持：${detail}。`
    + '请重新安装中瑞世联工作台插件，或联系管理员确认插件包是否完整；'
    + `这些组件由插件按包内绝对路径使用（当前平台 ${platform || '未知'}），不从 PATH 上查找，也不由员工单独配置。`
}

/**
 * 检查随包组件：只读文件事实，**一次 shell 都不跑**。
 *
 * 判据（三条都来自包内，互相独立）：
 * 1. 当前平台有随包目录（否则「平台不受支持」）；
 * 2. 文件真的在 `bin/<平台>/` 里；
 * 3. 字节数与包内 `bin/manifest.json` 一致（运行残留 / 安装不完整都会在这里露出来）。
 */
export async function probePackageIntegrity(
  ctx: Context,
  manifest: EnvManifest,
  platform: string,
  options: { url?: string } = {},
): Promise<PackageIntegrityCheck> {
  void options
  const { packageRoot, manifestPath } = packageIntegrityPaths()
  const supported = binPlatformDir(platform) !== ''
  const fs = fileSystem(ctx)

  let manifestFound = false
  const declared = new Map<string, BinManifestTool>()
  if (fs !== undefined && manifestPath !== '') {
    try {
      const parsed = readBinManifest(await fs.readText(await resolveTarget(ctx, manifestPath)), platform)
      manifestFound = parsed.found
      for (const [name, tool] of parsed.tools) declared.set(name, tool)
    } catch (error) {
      // 清单文件不存在 / 文件服务读不到：两种情况都只意味着「无法按清单比对」。
      void error
      manifestFound = false
    }
  }

  const tools: PackagedToolCheck[] = []
  for (const spec of manifest.packaged) {
    tools.push(await checkPackagedTool(ctx, spec, platform, { supported, manifestFound, manifestPath, declared }))
  }

  const failed = tools.filter((tool) => !tool.ok)
  const ok = failed.length === 0
  return {
    ok,
    supported,
    platform,
    packageRoot,
    manifestPath,
    manifestFound,
    tools,
    note: ok
      ? `插件内置组件 ${String(tools.length)}/${String(tools.length)} 完整：`
        + '字节数与包内 bin/manifest.json 一致（sha256 见明细，不在自检里重算）。'
      : (failed[0]?.reason ?? packageGapMessage(platform, '插件内置组件不可用')),
  }
}

/** 单个组件：存在性 + 字节数；理由必须能分辨「平台不受支持」「缺文件」「清单读不到」「字节数不一致」。 */
async function checkPackagedTool(
  ctx: Context,
  spec: PackagedToolSpec,
  platform: string,
  facts: { supported: boolean; manifestFound: boolean; manifestPath: string; declared: Map<string, BinManifestTool> },
): Promise<PackagedToolCheck> {
  const file = binaryFileName(spec.name, platform)
  const entry = facts.declared.get(spec.name)
  const base: PackagedToolCheck = {
    name: spec.name,
    label: spec.label,
    file,
    present: false,
    sizeBytes: 0,
    manifestSizeBytes: entry?.size ?? 0,
    sha256: entry?.sha256 ?? '',
    expectedVersion: spec.expectedVersion,
    note: spec.note,
    ok: false,
    reason: '',
  }
  if (!facts.supported) {
    return { ...base, reason: packageGapMessage(platform, '当前平台没有随包发布的组件目录') }
  }
  const bundled = bundledBinaryPath(platform, spec.name)
  if (bundled === '') {
    return { ...base, reason: packageGapMessage(platform, '当前平台没有随包发布的组件目录') }
  }
  const fs = fileSystem(ctx)
  if (fs === undefined) {
    return { ...base, reason: `无法核对插件包完整性：Host 文件服务不可用（包内路径 ${bundled}）` }
  }
  let info: { type?: string; size?: number } | undefined
  try {
    info = await fs.stat(await resolveTarget(ctx, bundled))
  } catch (error) {
    // 文件不在 / stat 被拒：都只意味着「这个绝对路径现在不可用」。
    void error
    info = undefined
  }
  if (info?.type !== 'file') {
    return { ...base, reason: `插件包不完整：包内缺少 ${bundled}` }
  }
  const sizeBytes = typeof info.size === 'number' && Number.isFinite(info.size) ? info.size : 0
  const present = { ...base, present: true, sizeBytes }
  if (!facts.manifestFound) {
    return { ...present, reason: `插件包不完整：读不到包内清单 ${facts.manifestPath}，无法核对 ${file} 的字节数` }
  }
  if (present.manifestSizeBytes === 0) {
    return { ...present, reason: `插件包不完整：包内清单里没有 ${spec.name} 的字节数，无法核对` }
  }
  if (sizeBytes !== present.manifestSizeBytes) {
    return {
      ...present,
      reason: `插件包不完整：包内 ${file} 的字节数与随包清单不一致（磁盘 ${String(sizeBytes)} / 清单 ${String(present.manifestSizeBytes)}，可能是安装不完整或运行残留）`,
    }
  }
  return { ...present, ok: true, reason: '' }
}

/**
 * ossutil 的定位结果：**只认包内**。
 *
 * `error` 为空表示解析到了绝对路径；否则是非空的失败原因（「插件包不完整 / 平台不受支持」
 * 或「Host 文件服务不可用」）。调用方（`oss/ops.ts`、`oss/auto.ts`）只读这两个字段。
 */
export interface OssutilLookup {
  /** 解析到的路径；没找到时为空串。 */
  path: string
  /** 失败原因；为空表示解析成功。 */
  error: string
}

/** 定位失败时给用户的那句话。文案里不许出现安装指引：这个二进制随插件发布。 */
export function ossutilMissingMessage(lookup: OssutilLookup): string {
  return lookup.error === ''
    ? packageGapMessage('', '没有找到随包发布的 ossutil')
    : lookup.error
}

/**
 * 解析包内 ossutil 的绝对路径。
 *
 * **没有 PATH 回退**（2026-09-25 口径）：回退会让模型在某台机器上看到 `command not found`，
 * 下一步自然就是 `which` / `command -v` / 去搜可执行文件 —— 正是本次改造要消灭的行为。
 * `oss` 参数保留是为了不改调用方签名：清单里的 `ossutil` 命令名已经不再参与解析。
 */
export async function resolveOssutil(
  ctx: Context,
  oss: OssSpec,
  platform: string,
  options: { workdir?: string } = {},
): Promise<OssutilLookup> {
  void oss
  void options
  const bundled = bundledBinaryPath(platform, 'ossutil')
  if (bundled === '') {
    return { path: '', error: packageGapMessage(platform, '当前平台没有随包发布的 ossutil') }
  }
  const fs = fileSystem(ctx)
  if (fs === undefined) {
    return { path: '', error: `无法核对插件包完整性：Host 文件服务不可用（包内路径 ${bundled}）` }
  }
  try {
    const info = await fs.stat(await resolveTarget(ctx, bundled))
    if (info?.type === 'file') return { path: bundled, error: '' }
  } catch (error) {
    // 文件不在 / stat 被拒：都只意味着「这个绝对路径现在不可用」，交给下面的统一文案。
    void error
  }
  return { path: '', error: packageGapMessage(platform, `包内缺少 ${bundled}`) }
}

// ── OSS 真实能力验证（2026-09-26 收紧）─────────────────────────────────────

/** OSS 探测的归因分类。 */
export type OssProbeKind = '' | 'credential' | 'permission' | 'config' | 'infrastructure'

/**
 * 一次真实 OSS 只读验证的请求形状（**完全由受信配置推出，模型与员工都不能提交**）。
 *
 * 导出它有两个目的：① 单测可以对命令字符串逐字断言；② 开发者诊断里能显示"验的是哪个目标"，
 * 而目标里**不含任何凭据**。
 */
export function ossProbeTarget(oss: OssSpec): { bucket: string; prefix: string; target: string } {
  const prefix = oss.prefix.replace(/^\/+|\/+$/g, '')
  const path = prefix === '' ? '' : `${prefix}/`
  return { bucket: oss.bucket, prefix: path, target: `oss://${oss.bucket}/${path}` }
}

/**
 * 端到端唯一的 OSS 真实验证：**用包内 ossutil 对配置好的 bucket + 业务前缀做一次只读列举**。
 *
 * 判据（2026-09-26 收紧）：
 * - 必须打**业务前缀**（`oss://<bucket>/<prefix>/`）而不是桶根：只验桶根证明不了"能写交付件"；
 * - `--limited-num 1`：只要一次请求，空目录也算成功（判据是"请求成功且凭据有权访问该目标"，
 *   不是"一定列到对象"）；
 * - 只用只读 `ls`：**不**为了验证去上传、删除或创建对象；
 * - 只认包内绝对路径（`resolveOssutil`），不回退 PATH、不要员工装 ossutil；
 * - 所有 stdout / stderr 在返回或写日志之前过 `sanitizeOssError`（AK / STS / Signature / 签名 URL）。
 *
 * 归因顺序是刻意的：**先看命令有没有跑起来**（沙箱 / 审批 / 包内缺文件），
 * 再看 HTTP / 服务端错误码。把"命令根本没跑起来"说成"AK 无效"会把员工指去换一份好密钥。
 */
export async function probeOss(
  ctx: Context,
  oss: OssSpec,
  platform: string,
  options: { workdir?: string } = {},
): Promise<ServiceCheck> {
  const { target, prefix } = ossProbeTarget(oss)
  const base: ServiceCheck = {
    id: 'oss', label: '阿里云 OSS（AK 权限）', required: true,
    ok: false, state: '', detail: '', errorKind: '', target,
  }
  if (!oss.enabled) {
    return { ...base, ok: false, state: '未启用', errorKind: 'config', detail: '清单 oss.enabled 为 false' }
  }
  if (oss.bucket === '') {
    return { ...base, ok: false, state: '缺 bucket', errorKind: 'config', detail: '清单 oss.bucket 为空（由管理员在部署配置里设置）' }
  }

  const lookup = await resolveOssutil(ctx, oss, platform, options)
  if (lookup.path === '') {
    // 包内没有 ossutil / 平台不受支持：这是**插件包**的问题，不是「员工没装」。
    return { ...base, ok: false, state: '插件包不完整 / 平台不受支持', errorKind: 'infrastructure', detail: lookup.error }
  }
  const ossutil = lookup.path

  const command = buildOssProbeCommand(oss, ossutil, platform)
  const run = await runShell(ctx, command, {
    timeoutMs: 60_000,
    ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
  })

  // 「命令根本没跑起来」（沙箱后端不可用 / 审批被拒）与「跑完了报 AK 错」是两件事。
  if (shellUnavailable(run)) {
    return {
      ...base, ok: false, state: '无法探测', errorKind: 'infrastructure',
      detail: sanitizeOssError(text(run.error) || text(run.stderr) || '探测命令没有执行'),
    }
  }

  const verdict = classifyOssFailure(
    run.ok,
    sanitizeOssError(text(run.stderr) || text(run.stdout) || text(run.error)),
  )
  if (run.ok) {
    return {
      ...base, ok: true, state: 'AK 正常', errorKind: '',
      detail: `已验证可访问 ${target}${oss.endpoint === '' ? '' : ` @ ${oss.endpoint}`}（只读列举，空目录也算通过）`,
    }
  }
  return { ...base, ok: false, state: verdict.state, errorKind: verdict.kind, detail: verdict.detail }
}

/**
 * 探测命令：**只读 `ls` + 业务前缀 + `--limited-num 1`**。
 *
 * `oss.probeCommand` 仍被尊重（部署方可以换成等价的只读命令），但 `{prefix}` 占位符与默认分支
 * 都指向业务前缀 —— 旧默认（列桶根）证明不了"能写交付件"。跑之前不检查、跑之后才看错误码，
 * 所以它必须自身只读。
 */
export function buildOssProbeCommand(oss: OssSpec, ossutil: string, platform: string): string {
  const { bucket, prefix, target } = ossProbeTarget(oss)
  // `{ossutil}` 占位符替换成**命令位置**的形式（Windows 上带 `&`）：模板里的 `{ossutil}` 就是
  // 可执行文件的位置，直接塞一个引号路径会让 PowerShell 把它当字符串表达式。
  const executable = shellInvoke(ossutil, [], platform)
  if (oss.probeCommand !== '') {
    return oss.probeCommand
      .split('{ossutil}').join(executable)
      .split('{bucket}').join(bucket)
      .split('{prefix}').join(prefix)
      .split('{target}').join(target)
      .split('{endpoint}').join(oss.endpoint)
  }
  const args = [
    'ls', target,
    ...(oss.endpoint === '' ? [] : ['--endpoint', oss.endpoint]),
    // `--limited-num 1` = 最多一次请求；空目录（0 个对象）仍然是成功的列举。
    '--limited-num', '1',
    ...oss.extraArgs,
  ]
  return shellInvoke(ossutil, args, platform)
}

/**
 * OSS 失败 → 人话归因。
 *
 * 四类分开（用户口径：错误要"按凭据、权限、配置、网络分别给人话提示"）：
 * - `credential`：`InvalidAccessKeyId` / `SignatureDoesNotMatch` / `InvalidSecurityToken` / `AccessKeyId is disabled`
 *   → 员工重填 AK；
 * - `permission`：`AccessDenied` / `Forbidden` / `no permission`
 *   → 凭据有效但没有这个 Bucket/Prefix 的权限，找管理员开权限；
 * - `config`：`NoSuchBucket` / `InvalidBucketName` / `Endpoint` 解析失败 / `unknown endpoint`
 *   → 部署配置错了，找管理员；
 * - `infrastructure`：上面都不匹配（网络、DNS、超时、TLS、上游 5xx）
 *   → 稍后重试 / 找管理员排查连通性，**不是** AK 的问题。
 */
export function classifyOssFailure(ok: boolean, raw: string): { state: string; kind: OssProbeKind; detail: string } {
  const detail = clampOssText(raw)
  if (ok) return { state: 'AK 正常', kind: '', detail }
  const lower = raw.toLowerCase()
  if (/invalidaccesskeyid|signaturedoesnotmatch|invalidsaccesskeyid|invalidsecuritytoken|accesskeyid is disabled|accesskeyidisdisabled|invalidaccesskeyid\.notfound/i.test(raw)) {
    return { state: 'AccessKey 无效', kind: 'credential', detail: detail || 'OSS 认为这份 AccessKey 无效或已禁用' }
  }
  if (/accessdenied|forbidden|no permission|denied/i.test(raw)) {
    return { state: 'AccessKey 没有目标权限', kind: 'permission', detail: detail || '凭据有效，但没有该 Bucket / 前缀的访问权限' }
  }
  if (/nosuchbucket|invalidbucketname|unknown endpoint|invalidendpoint|no such host.*oss|endpoint/i.test(lower)) {
    return { state: 'Bucket 或 Endpoint 配置有误', kind: 'config', detail: detail || 'Bucket 或 Endpoint 配置有误（由管理员在部署配置里设置）' }
  }
  return { state: '连接 OSS 失败', kind: 'infrastructure', detail: detail || '无法连接 OSS（网络 / 超时 / 服务不可达）' }
}

/** 探测输出的截断 + 脱敏（**唯一**出口，见 `oss/sanitize.ts`）。 */
function clampOssText(raw: string): string {
  const clean = sanitizeOssError(raw).trim()
  return clean.length <= OSS_OUTPUT_LIMIT ? clean : `${clean.slice(0, OSS_OUTPUT_LIMIT)}…`
}

/** 服务清单本身不探测（氚云/钉钉的登录态由各自的 CLI 决定），这里只做形状归一。 */
export function serviceChecks(services: ServiceSpec[]): ServiceCheck[] {
  return services.map((service) => ({
    id: service.id,
    label: service.label,
    required: service.required,
    ok: false,
    state: '待探测',
    detail: '',
  }))
}
