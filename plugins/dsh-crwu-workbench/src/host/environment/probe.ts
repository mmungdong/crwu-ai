import type { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { binPlatformDir, bundledBinaryPath, binaryFileName } from '../platform/bin-dir.ts'
import { isWindowsPlatform } from '../platform/detect.ts'
import { expandLocal } from '../platform/home.ts'
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

/** 单个随包组件的检查结果。 */
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

/** 单个服务的探测结果（氚云 / 钉钉登录态，以及 OSS 交付探测）。 */
export interface ServiceCheck {
  id: string
  label: string
  required: boolean
  ok: boolean
  state: string
  detail: string
}

export interface IfindCheck {
  path: string
  required: boolean
  ok: boolean
  reason: string
  tokenLength: number
}

/**
 * 按平台选择引用方式。
 *
 * `quoteArg` 产出 POSIX 单引号，在 `cmd.exe` 下无效 —— 版本探测命令会带路径参数，
 * 所以 Windows 上必须换成双引号 + `""` 转义，否则 `ossutil --version` 一定探测失败。
 */
export function shellQuote(value: unknown, platform: string): string {
  if (!isWindowsPlatform(text(platform))) return quoteArg(value)
  const raw = String(value)
  return `"${raw.replace(/"/g, '""')}"`
}

/** 把 `iFinD` 密钥的检查拆出来，便于单测：空值/占位符/首尾空白三种失败都要能分辨。 */
export function checkIfindToken(raw: unknown, placeholder: unknown): { ok: boolean; reason: string; tokenLength: number } {
  const value = text(raw)
  const expected = text(placeholder) || 'your ifind-mcp key'
  if (value.trim() === '') return { ok: false, reason: 'auth_token 为空', tokenLength: 0 }
  if (value.trim().toLowerCase() === expected.toLowerCase()) {
    return { ok: false, reason: `auth_token 仍是占位符 ${expected}`, tokenLength: 0 }
  }
  if (value !== value.trim()) return { ok: false, reason: 'auth_token 含首尾空白，需要清洗', tokenLength: 0 }
  return { ok: true, reason: '', tokenLength: value.length }
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
): Promise<PackageIntegrityCheck> {
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
        + `字节数与包内 bin/manifest.json 一致（sha256 见明细，不在自检里重算）。`
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

/** 探测 OSS 的 AK 是否真的能列对象 —— 这是「AK 配好了吗」唯一可信的证据。 */
export async function probeOss(
  ctx: Context,
  oss: OssSpec,
  platform: string,
  options: { workdir?: string } = {},
): Promise<ServiceCheck> {
  const base = { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true }
  if (!oss.enabled) return { ...base, ok: false, state: '未启用', detail: '清单 oss.enabled 为 false' }
  if (oss.bucket === '') return { ...base, ok: false, state: '缺 bucket', detail: '清单 oss.bucket 为空' }

  const lookup = await resolveOssutil(ctx, oss, platform, options)
  if (lookup.path === '') {
    // 包内没有 ossutil / 平台不受支持：这是**插件包**的问题，不是「员工没装」。
    return { ...base, ok: false, state: '插件包不完整 / 平台不受支持', detail: lookup.error }
  }
  const ossutil = lookup.path

  const endpointArg = oss.endpoint === '' ? '' : ` --endpoint ${shellQuote(oss.endpoint, platform)}`
  const command = oss.probeCommand !== ''
    ? oss.probeCommand
      .split('{ossutil}').join(shellQuote(ossutil, platform))
      .split('{bucket}').join(oss.bucket)
      .split('{endpoint}').join(oss.endpoint)
    : `${shellQuote(ossutil, platform)} ls ${shellQuote(`oss://${oss.bucket}/`, platform)}${endpointArg} --limited-num 1`

  const run = await runShell(ctx, command, {
    timeoutMs: 60_000,
    ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
  })
  const raw = (text(run.stderr) || text(run.stdout) || text(run.error) || '探测失败').trim()

  // 「命令根本没跑起来」（沙箱后端不可用 / 审批被拒）与「跑完了报 AK 错」是两件事：
  // 前者说成「AK 无效」会把人指去换 AK，而真正的问题是执行环境。
  if (shellUnavailable(run)) return { ...base, ok: false, state: '无法探测', detail: raw }

  let state = 'AK 配置有误或不可用'
  if (run.ok) state = 'AK 正常'
  else if (raw.includes('AccessDenied') || raw.includes('denied')) state = 'AK 无权限'
  else if (raw.includes('InvalidAccessKeyId') || raw.includes('SignatureDoesNotMatch')) state = 'AK 无效'
  else if (raw.includes('NoSuchBucket')) state = 'bucket 不存在'
  else if (raw.toLowerCase().includes('both empty')) state = 'AK 未配置'

  return {
    ...base,
    ok: run.ok,
    state,
    detail: run.ok
      ? `AK 可访问 oss://${oss.bucket}/${oss.endpoint === '' ? '' : ` @ ${oss.endpoint}`}`
      : raw.slice(0, 400),
  }
}

/** 读取 iFinD 技能自己的配置文件里的 `auth_token`；只回长度，不回显。 */
export async function probeIfindKey(
  ctx: Context,
  manifest: EnvManifest,
  options: { home?: string; platform?: string },
): Promise<IfindCheck> {
  const spec = manifest.ifindKey
  const platform = options.platform ?? ''
  const path = spec.path.startsWith('~')
    ? expandLocal(spec.path, options.home ?? '', isWindowsPlatform(platform))
    : spec.path
  const out: IfindCheck = { path, required: spec.required, ok: false, reason: '', tokenLength: 0 }
  const fs = fileSystem(ctx)
  if (fs === undefined) {
    out.reason = 'Host 文件服务不可用'
    return out
  }
  try {
    const target = await resolveTarget(ctx, path)
    const info = await fs.stat(target)
    if (info?.type !== 'file') {
      out.reason = '配置文件不存在（技能可能尚未安装）'
      return out
    }
    const raw = await fs.readText(target)
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch (error) {
      void error
      out.reason = '配置文件不是合法 JSON'
      return out
    }
    const record = doc !== null && typeof doc === 'object' ? doc as Record<string, unknown> : {}
    const verdict = checkIfindToken(record[spec.field] ?? record.auth_token, spec.placeholder)
    out.ok = verdict.ok
    out.reason = verdict.reason
    out.tokenLength = verdict.tokenLength
    return out
  } catch (error) {
    out.reason = `读取失败：${error instanceof Error ? error.message : String(error)}`
    return out
  }
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
