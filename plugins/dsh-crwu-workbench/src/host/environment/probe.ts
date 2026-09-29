import type { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { text } from '../../shared/utils/value.ts'
import { sanitizeOssError, OSS_OUTPUT_LIMIT } from '../oss/sanitize.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { binPlatformDir, bundledBinaryPath, binaryFileName } from '../platform/bin-dir.ts'
import { packageRootFrom } from '../platform/package-root.ts'
import { shellInvoke, shellQuote } from '../platform/shell.ts'
import { shellUnavailable } from '../shell/run.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { LocalAccessSource } from '../access/operations.ts'
import type { EnvManifest, OssSpec, PackagedToolSpec, ServiceSpec } from './manifest-default.ts'

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
  options: { workdir?: string; access: LocalAccessBroker; source?: LocalAccessSource },
): Promise<ServiceCheck> {
  const { target } = ossProbeTarget(oss)
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

  const built = buildOssProbeCommand(oss, ossutil, platform)
  if (!built.ok) {
    // 模板写坏了（未知占位符 / 换行 / 没有可执行文件）—— 这是**部署配置**问题，不是 AK 问题。
    return { ...base, ok: false, state: '探测配置有误', errorKind: 'config', detail: built.error }
  }
  // 经 Broker：**每一次 `ossutil` 都会读 `~/.ossutilconfig`**，所以远端只读动作也算本机凭据访问。
  const run = await options.access.runShell(
    {
      operation: 'oss.remote.read',
      source: options.source ?? 'host-background',
      ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
    },
    built.command,
    { timeoutMs: 60_000, ...(options.workdir === undefined ? {} : { workdir: options.workdir }), summary: 'ossutil ls（探测）' },
  )

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
 * 结构化探测请求：**可执行文件 + 参数**。
 *
 * 这是默认（也是唯一推荐的）探测形状：可执行文件与参数分开交给 `shellInvoke`，由它按平台引用 ——
 * 动态值不可能被当成命令结构的一部分。
 */
export interface OssProbeSpec {
  executable: string
  args: string[]
}

/** 默认探测：**只读 `ls` + 业务前缀 + `--limited-num 1`**，结构化形状。 */
export function ossProbeSpec(oss: OssSpec, ossutil: string): OssProbeSpec {
  const { target } = ossProbeTarget(oss)
  return {
    executable: ossutil,
    args: [
      'ls', target,
      ...(oss.endpoint === '' ? [] : ['--endpoint', oss.endpoint]),
      // `--limited-num 1` = 最多一次请求；空目录（0 个对象）仍然是成功的列举。
      '--limited-num', '1',
      ...oss.extraArgs,
    ],
  }
}

/** 旧字符串模板允许的占位符；出现别的 `{…}` 一律拒绝。 */
export const OSS_PROBE_PLACEHOLDERS = ['ossutil', 'bucket', 'prefix', 'target', 'endpoint'] as const

export type OssProbeCommand =
  | { ok: true; command: string; /** 走的是旧字符串模板（deprecated 兼容路径）。 */ deprecated: boolean }
  | { ok: false; error: string }

/**
 * 生成探测命令。
 *
 * **默认路径是结构化的**（`ossProbeSpec` + `shellInvoke`）：部署配置里不需要、也不应该出现
 * 「一段宿主 shell 脚本」。`oss.probeCommand` 作为 **deprecated 兼容路径**保留，但不再是裸替换：
 *
 * - 只认 `{ossutil}` / `{bucket}` / `{prefix}` / `{target}` / `{endpoint}` 五个占位符，别的一律拒绝；
 * - 每个占位符的值**逐个按平台引用**（`shellQuote`）—— 旧实现是把动态值裸拼进去，
 *   于是 endpoint 里一个空格或 `$` 就能改变命令结构；
 * - `{ossutil}` 是**命令位置**，替换成 `shellInvoke(ossutil, [], platform)`（Windows 上带 `&`）；
 * - 拒绝换行、拒绝替换后仍残留的 `{` / `}`、拒绝空可执行文件。
 *
 * 部署配置是管理员写的，但这仍然是外部输入：它进 shell 前必须过同一套边界。
 */
export function buildOssProbeCommand(oss: OssSpec, ossutil: string, platform: string): OssProbeCommand {
  if (ossutil === '') return { ok: false, error: '探测命令缺少可执行文件（ossutil 解析失败）' }
  if (oss.probeCommand === '') {
    const spec = ossProbeSpec(oss, ossutil)
    return { ok: true, command: shellInvoke(spec.executable, spec.args, platform), deprecated: false }
  }

  const template = oss.probeCommand
  if (template.trim() === '') return { ok: false, error: 'oss.probeCommand 是空白字符串，请留空使用内置只读探测' }
  if (/[\r\n]/.test(template)) return { ok: false, error: 'oss.probeCommand 不能包含换行' }

  const { bucket, prefix, target } = ossProbeTarget(oss)
  const values: Record<string, string> = { ossutil, bucket, prefix, target, endpoint: oss.endpoint }
  const unknown: string[] = []
  const command = template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    if (!Object.hasOwn(values, name)) {
      unknown.push(whole)
      return whole
    }
    // 命令位置要带调用运算符（Windows）；其余位置逐个引用成字面量。
    return name === 'ossutil'
      ? shellInvoke(values[name] as string, [], platform)
      : shellQuote(values[name], platform)
  })
  if (unknown.length > 0) {
    return { ok: false, error: `oss.probeCommand 含未知占位符：${[...new Set(unknown)].join(' ')}（只认 ${OSS_PROBE_PLACEHOLDERS.join(' / ')}）` }
  }
  if (command.includes('{') || command.includes('}')) {
    return { ok: false, error: 'oss.probeCommand 含无法识别的花括号，请只使用 {ossutil} {bucket} {prefix} {target} {endpoint}' }
  }
  return { ok: true, command, deprecated: true }
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
