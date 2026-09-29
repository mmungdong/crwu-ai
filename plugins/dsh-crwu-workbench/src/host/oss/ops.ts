import type { Context } from '@deepseek-ai/cordis'
import { parseJsonLoose } from '../../shared/utils/json.ts'
import { text } from '../../shared/utils/value.ts'
import { joinLocalPath } from '../../shared/utils/local-path.ts'
import type { EnvManifest, OssSpec } from '../environment/manifest-default.ts'
import { ossutilMissingMessage, probeOss, resolveOssutil } from '../environment/probe.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { openExternalCommand, privateFileMechanism } from '../platform/shell.ts'
import { credentialPermissionSatisfied, enforceCredentialPermission } from '../platform/credential-permission.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { LocalAccessSource } from '../access/operations.ts'
import type { OssExecDeps } from './run.ts'
import { ossConfigPath, readOssCred, type OssCredView } from './cred.ts'
import { runOssutil } from './run.ts'
import {
  groupObjects, isResultJson, joinUrl, parseLsEntries, parseLsObjects, parseSignUrl, stripPrefix,
} from './parse.ts'
import { isSafeSeqNo } from '../../shared/consts.ts'
import { inspectCase } from '../audit/case.ts'
import { auditInfoFromResult } from '../audit/summary.ts'
import type { CredentialPermission } from '../../shared/types.ts'

/**
 * OSS 交付件相关的操作。
 *
 * 三条安全约束贯穿全文件（`AGENTS.md` §4.3），改动前请确认没有破坏：
 * 1. **任何按 key 的操作先过 `stripPrefix`** —— 不在配置前缀内一律拒绝，
 *    否则就是「能读任意 bucket 里任意对象」；
 * 2. **`oss-result` 只回精简摘要**，不把完整证据链塞进列表接口；
 * 3. **签名 URL 要升级成 https** —— 链接里带 bearer 签名，能拿到就能看，不能走明文。
 */

export interface OssDeps {
  ctx: Context
  manifest: EnvManifest
  platform: string
  /** 会话工作目录（命令的默认 workdir）。 */
  workdir: () => Promise<string>
  /** 主目录，用于 resolveOssutil 回退到清单里的安装目标。 */
  home: string
  /** Broker（协议 18）：每一次 `ossutil` 调用都会读 `~/.ossutilconfig`，所以全部经它。 */
  access: LocalAccessBroker
  /**
   * 这次调用是谁发起的。
   *
   * `ossutil` 的每一次调用都必须带上它 —— Broker 按来源判"这个来源配不配做这件事"，
   * 少了它就只能退回一个默认值，而默认值会让"审核子会话发起面板操作"这种事静默通过。
   */
  source: LocalAccessSource
}

/** 统一的执行入口：把 deps 里的 ctx / access / platform / workdir / source 收成一处。 */
async function exec(deps: OssDeps): Promise<OssExecDeps> {
  return {
    ctx: deps.ctx,
    access: deps.access,
    platform: deps.platform,
    workdir: await shellWorkdir(deps),
    source: deps.source,
  }
}

async function shellWorkdir(deps: OssDeps): Promise<string> {
  return await deps.workdir()
}

/** 统一的「前置检查」：OSS 必须启用、有 bucket、ossutil 可用。 */
async function requireOss(deps: OssDeps): Promise<{ ok: true; oss: OssSpec; ossutil: string } | { ok: false; error: string }> {
  const oss = deps.manifest.oss
  if (!oss.enabled) return { ok: false, error: '清单里 oss.enabled 不是 true' }
  if (oss.bucket === '') return { ok: false, error: '清单缺 oss.bucket' }
  const lookup = await resolveOssutil(deps.ctx, oss, deps.platform, {
    workdir: await shellWorkdir(deps),
  })
  if (lookup.path === '') return { ok: false, error: ossutilMissingMessage(lookup) }
  return { ok: true, oss, ossutil: lookup.path }
}

// ── oss-index ───────────────────────────────────────────────────────────────

export interface OssIndexResult {
  ok: boolean
  error: string
  bucket: string
  prefix: string
  count: number
  items: Record<string, unknown>
  truncated: boolean
}

/**
 * 列举 OSS 上的交付件。
 *
 * `ls` 默认递归列举该前缀下全部对象；它**没有** `-r`（`-d/--directory` 才是「只列一层」），
 * 传 `-r` 会被 ossutil 直接拒绝。stdout 预算放宽到 4MB，否则对象多时会被截断成半个清单。
 */
export async function ossIndex(deps: OssDeps, args: Record<string, unknown> = {}): Promise<OssIndexResult> {
  const empty = { bucket: '', prefix: '', count: 0, items: {}, truncated: false }
  // 传了流水号 = 「按流水号找交付件」：它会被拼进 OSS 路径，所以**先过形状校验**（共享判据）。
  // 不合形状直接拒绝、**一条命令都不发** —— 这是安全边界，不是体验优化。
  const seqNo = text(args.seqNo).trim()
  if (seqNo !== '' && !isSafeSeqNo(seqNo)) {
    return {
      ok: false,
      error: `流水号形状不对：${seqNo}（示例 2026-301705-LX10170-BG8746；只允许字母数字与 - _ .，不能含 /）`,
      ...empty,
    }
  }

  const ready = await requireOss(deps)
  if (!ready.ok) return { ok: false, error: ready.error, ...empty }
  const { oss, ossutil } = ready

  // 前缀隔离：只在配置前缀内再下一层；上面已保证这一段不含 `/`，这里再用既有 stripPrefix 兜一道。
  const listedPrefix = seqNo === '' ? oss.prefix : `${oss.prefix}/${seqNo}`
  if (seqNo !== '' && stripPrefix(`${listedPrefix}/`, oss.prefix) === '') {
    return { ok: false, error: '流水号越出配置的 OSS 前缀', ...empty }
  }

  // **不加 `--short-format`**：`ls` 默认的长格式一次就能给出每个对象的
  // 大小 / 最后写入时间 / ETag，以及总数（`Object Number is: N`）。
  // 那些元数据是"审核结果有没有重新生成过"的客观依据 —— 加 `--short-format` 等于把它们丢掉。
  const argv = [ossutil, 'ls', `oss://${oss.bucket}/${listedPrefix}/`]
  if (oss.endpoint !== '') argv.push('--endpoint', oss.endpoint)
  const run = await runOssutil(await exec(deps), {
    operation: 'oss.remote.read',
    argv,
    timeoutMs: 90_000,
    stdoutMaxBytes: 4 * 1024 * 1024,
    summary: 'ossutil ls（列举交付件）',
  })
  if (!run.ok) {
    const raw = (text(run.stderr) || text(run.error) || text(run.stdout) || '列举失败').trim()
    return { ok: false, error: raw.slice(0, 400), ...empty }
  }
  const entries = parseLsEntries(run.stdout, oss.bucket)
  // 兜底：某些 ossutil 版本 / 语言下长格式的表头与列宽可能认不出来 —— 这时退回"只要 key"的解析，
  // 保证清单本身不丢（只是少了元数据），而不是把整次列举判成失败。
  const list = entries.length > 0 ? entries : parseLsObjects(run.stdout, oss.bucket)
  return {
    ok: true,
    error: '',
    bucket: oss.bucket,
    prefix: oss.prefix,
    count: list.length,
    items: groupObjects(list, oss.prefix),
    truncated: run.truncated,
  }
}

// ── oss-result ──────────────────────────────────────────────────────────────

export interface OssResultResult {
  ok: boolean
  error: string
  key: string
  info: Record<string, unknown> | null
}

/** 按精确 key 读一条审核结果，且**只回摘要**。 */
export async function ossResult(deps: OssDeps, args: Record<string, unknown>): Promise<OssResultResult> {
  const key = text(args.key)
  const failed = (error: string): OssResultResult => ({ ok: false, error, key, info: null })
  if (key === '') return failed('缺少审核结果对象 key')

  const oss = deps.manifest.oss
  if (!oss.enabled) return failed('清单里 oss.enabled 不是 true')
  if (oss.bucket === '') return failed('清单缺 oss.bucket')
  if (stripPrefix(key, oss.prefix) === '') return failed('审核结果对象不在配置的 OSS 前缀内')
  if (!isResultJson(key)) return failed('审核信息只允许读取 JSON 对象')

  const lookup = await resolveOssutil(deps.ctx, oss, deps.platform, {
    workdir: await shellWorkdir(deps),
  })
  if (lookup.path === '') return failed(ossutilMissingMessage(lookup))
  const ossutil = lookup.path

  const argv = [ossutil, 'cat', `oss://${oss.bucket}/${key}`]
  if (oss.endpoint !== '') argv.push('--endpoint', oss.endpoint)
  const run = await runOssutil(await exec(deps), {
    operation: 'oss.remote.read',
    argv,
    timeoutMs: 60_000,
    stdoutMaxBytes: 8 * 1024 * 1024,
    summary: 'ossutil cat（读审核结果）',
  })
  if (!run.ok) {
    const raw = (text(run.stderr) || text(run.error) || '读取审核结果失败').trim()
    return failed(raw.slice(0, 400))
  }
  if (run.truncated) return failed('审核结果 JSON 超过 8MB，已停止读取')

  const doc = parseJsonLoose(run.stdout)
  if (doc === null || typeof doc !== 'object') return failed('审核结果不是合法 JSON')
  return { ok: true, error: '', key, info: auditInfoFromResult(doc) }
}

// ── oss-link ────────────────────────────────────────────────────────────────

export interface OssLinkResult {
  ok: boolean
  error: string
  url: string
  mode: string
  ttl: number
  opened: boolean
  openError: string
}

/** 生成访问链接并用系统默认程序打开。 */
export async function ossLink(deps: OssDeps, args: Record<string, unknown>): Promise<OssLinkResult> {
  const key = text(args.key)
  const failed = (error: string): OssLinkResult => ({ ok: false, error, url: '', mode: '', ttl: 0, opened: false, openError: '' })
  if (key === '') return failed('缺少对象 key')

  const oss = deps.manifest.oss
  if (oss.bucket === '') return failed('清单缺 oss.bucket')
  if (stripPrefix(key, oss.prefix) === '') return failed('对象不在配置的 OSS 前缀内')

  const cloud = `oss://${oss.bucket}/${key}`
  let url = ''
  if (oss.linkMode === 'public') {
    if (oss.publicBaseUrl === '') return failed('清单 linkMode=public 但 publicBaseUrl 为空')
    url = joinUrl(oss.publicBaseUrl, key)
  } else {
    const lookup = await resolveOssutil(deps.ctx, oss, deps.platform, {
      workdir: await shellWorkdir(deps),
    })
    if (lookup.path === '') return failed(ossutilMissingMessage(lookup))
    const ossutil = lookup.path
    const argv = [ossutil, 'sign', cloud, '--timeout', String(oss.linkTtl)]
    if (oss.endpoint !== '') argv.push('--endpoint', oss.endpoint)
    const run = await runOssutil(await exec(deps), {
      operation: 'oss.remote.read',
      argv,
      timeoutMs: 30_000,
      summary: 'ossutil sign（生成链接）',
    })
    if (!run.ok) return failed((text(run.stderr) || text(run.error) || '签名失败').slice(0, 300))
    url = parseSignUrl(run.stdout)
    if (url === '') return failed(`签名命令没有输出 URL：${text(run.stdout).slice(0, 200)}`)
  }

  // 链接里带 bearer 签名，能拿到就能看 —— 不能走明文。
  if (url.startsWith('http://')) url = `https://${url.slice('http://'.length)}`

  const opened = await deps.access.runShell(
    { operation: 'system.browser.open', source: 'panel', workdir: await shellWorkdir(deps) },
    openExternalCommand(url, deps.platform),
    { timeoutMs: 30_000, summary: 'system.browser.open' },
  )
  return {
    ok: true,
    error: '',
    url,
    mode: oss.linkMode,
    ttl: oss.linkTtl,
    opened: opened.ok,
    openError: opened.ok ? '' : (text(opened.stderr) || text(opened.error) || '打开命令未成功').slice(0, 200),
  }
}

// ── 上传 ────────────────────────────────────────────────────────────────────

export interface UploadFileResult {
  kind: string
  name: string
  key: string
  ok: boolean
  publicUrl: string
  error: string
}

export interface UploadResult {
  ok: boolean
  error: string
  bucket: string
  prefix: string
  results: UploadFileResult[]
}

/** 上传一个案例目录的交付件。 */
export async function uploadArtifacts(
  deps: OssDeps,
  item: { path: string; htmlFile: string; resultFile: string; name: string },
  projectId: string,
  ossutil: string,
  oss: OssSpec,
): Promise<UploadResult> {
  const files: Array<{ kind: string; name: string }> = []
  if (item.htmlFile !== '') files.push({ kind: 'html', name: item.htmlFile })
  if (item.resultFile !== '') files.push({ kind: 'json', name: item.resultFile })
  if (files.length === 0) return { ok: false, error: '没有可回传的交付件', bucket: oss.bucket, prefix: '', results: [] }

  // 对象 key 只用「流水号」：它本身唯一，是唯一的查找键。**不按年/月分段** ——
  // 那两个数字取自审核结果里的业务时间戳，取不到时会静默回退成当前系统时间，
  // 同一条流水号会被拆进不同月份目录。读端按 key 里的流水号模式识别，旧布局仍能读。
  const prefix = `${oss.prefix}/${projectId === '' ? item.name : projectId}`
  const results: UploadFileResult[] = []

  for (const file of files) {
    // **两个概念不能混**：`localPath` 是本地路径（分隔符随平台），`objectKey` 是 OSS 对象键
    // （永远 `/`，见 `stripPrefix` / `groupObjects`）。历史实现用一个 `/` 拼接同时服务两者，
    // 于是 Windows 上本地路径被拼成 `C:\Cases/S1/审核意见.html`。
    const localPath = joinLocalPath(item.path, file.name)
    const objectKey = `${prefix}/${file.name}`
    const argv = [ossutil, 'cp', '-f', localPath, `oss://${oss.bucket}/${objectKey}`]
    if (oss.endpoint !== '') argv.push('--endpoint', oss.endpoint)
    for (const extra of oss.extraArgs) argv.push(extra)
    const run = await runOssutil(await exec(deps), {
      operation: 'oss.remote.write',
      argv,
      timeoutMs: 180_000,
      summary: 'ossutil cp（上传交付件）',
    })
    results.push({
      kind: file.kind,
      name: file.name,
      key: objectKey,
      ok: run.ok,
      publicUrl: joinUrl(oss.publicBaseUrl, objectKey),
      error: run.ok ? '' : (text(run.stderr) || text(run.error) || '上传失败').slice(0, 400),
    })
  }

  const failed = results.filter((entry) => !entry.ok)
  return {
    ok: failed.length === 0,
    error: failed.length === 0 ? '' : failed.map((entry) => `${entry.name}：${entry.error}`).join('；').slice(0, 500),
    bucket: oss.bucket,
    prefix,
    results,
  }
}

/** 队列外的手动重传：只能按 key 使用 Host 已登记的案例目录。 */
export async function ossUpload(
  deps: OssDeps,
  args: Record<string, unknown>,
  state: { audits: Record<string, { casePath: string; uploadedAt: string; uploadError: string; ossPrefix: string }> },
): Promise<UploadResult> {
  const key = text(args.key)
  const record = key === '' ? undefined : state.audits[key]
  if (record === undefined) {
    return { ok: false, error: '找不到已登记的审核记录，无法重传。', bucket: '', prefix: '', results: [] }
  }
  const casePath = record.casePath
  if (casePath === '') {
    return { ok: false, error: '这条审核还没定位到案例目录，无法重传。', bucket: '', prefix: '', results: [] }
  }
  const oss = deps.manifest.oss
  if (!oss.enabled) return { ok: false, error: 'OSS 回传未启用：请在远程清单里把 oss.enabled 设为 true。', bucket: '', prefix: '', results: [] }
  if (oss.bucket === '') return { ok: false, error: 'OSS 回传缺少 bucket。', bucket: '', prefix: '', results: [] }
  const lookup = await resolveOssutil(deps.ctx, oss, deps.platform, {
    workdir: await shellWorkdir(deps),
  })
  if (lookup.path === '') {
    return { ok: false, error: ossutilMissingMessage(lookup), bucket: '', prefix: '', results: [] }
  }
  const ossutil = lookup.path

  let item = null
  try {
    item = await inspectCase(deps.ctx, await resolveTarget(deps.ctx, casePath))
  } catch (error) {
    void error
    item = null
  }
  if (item === null) return { ok: false, error: `案例目录不可读或不是案例：${casePath}`, bucket: '', prefix: '', results: [] }

  const out = await uploadArtifacts(deps, item, key, ossutil, oss)
  if (out.ok) {
    record.uploadedAt = new Date().toISOString()
    record.uploadError = ''
    record.ossPrefix = out.prefix
  } else {
    record.uploadError = out.error.slice(0, 300) || '上传失败'
  }
  return out
}

// ── oss-cred-save ───────────────────────────────────────────────────────────

export interface CredSaveResult {
  ok: boolean
  error: string
  path: string
  operation: string
  /** 凭据文件的权限结论（协议 17，结构化）：`verified` / `inherited` / `failed`。 */
  permission: CredentialPermission
  probe: Record<string, unknown> | null
  cred: OssCredView | null
}

export async function ossCredSave(deps: OssDeps, args: Record<string, unknown>): Promise<CredSaveResult> {
  // 输入校验发生在权限操作**之前**，但机制字段仍必须与注入的平台一致：
  // 硬编码 `posix-0600` 会让 win32-x64 上的失败信封说错「谁在负责权限」。
  const failed = (error: string): CredSaveResult => ({
    ok: false, error, path: '', operation: '',
    permission: failedPermission(error, deps.platform), probe: null, cred: null,
  })
  const accessKeyId = text(args.accessKeyId).trim()
  const accessKeySecret = text(args.accessKeySecret).trim()
  if (accessKeyId === '' || accessKeySecret === '') return failed('AccessKey ID 与 AccessKey Secret 都不能为空。')
  // 换行会破坏 ini 结构，等于写到配置文件里一行垃圾。
  if (/[\r\n]/.test(accessKeyId) || /[\r\n]/.test(accessKeySecret)) return failed('凭据不能包含换行。')

  // 表单里已经去掉 endpoint 与 STS：新客户端不送这两个字段。
  // endpoint 空着就**回落部署配置**（`config/crwu-workbench.yml` 的 `oss.protected.endpoint`），
  // 否则写进 `~/.ossutilconfig` 的内容会缺 endpoint，后续 upload/ls 全都要显式带参。
  // `stsToken` 继续接受（旧客户端/手工调用仍可传），只是不再由面板填写。
  const requestedEndpoint = text(args.endpoint).trim()
  const endpoint = requestedEndpoint === '' ? text(deps.manifest.oss.endpoint).trim() : requestedEndpoint
  const written = await writeOssCred(deps, {
    accessKeyId,
    accessKeySecret,
    stsToken: text(args.stsToken).trim(),
    endpoint,
  })
  if (!written.ok) {
    // 失败信封要**保留**已经知道的事实（路径 / 操作 / 权限结论）：
    // 员工据此才知道"文件写在哪、权限为什么没通过"，而不是只看到一句话。
    return {
      ok: false, error: written.error, path: written.path, operation: written.operation,
      permission: written.permission, probe: null, cred: null,
    }
  }

  // 保存后**立刻**用这份凭据打一次真实请求（只读 ls，走业务前缀）——**不查缓存**：
  // "文件写下去了"不等于"能用"，所以 `ok` 必须由这次探测的真实结果决定。
  const probe = await probeOss(deps.ctx, deps.manifest.oss, deps.platform, {
    workdir: await shellWorkdir(deps),
    access: deps.access,
    source: 'panel',
  })
  return {
    // 探测失败 = 这次保存没有成功（凭据已落盘，员工可以改完再存）。
    // 旧口径回 `ok: true` + `probe.ok: false`，界面得自己再判一次，漏判就会谎报成功。
    ok: probe.ok,
    error: probe.ok ? '' : (probe.detail || probe.state || 'OSS 验证未通过'),
    path: written.path,
    operation: written.operation,
    permission: written.permission,
    probe: probe as unknown as Record<string, unknown>,
    cred: await readOssCred(deps.ctx, deps.home, { access: deps.access, source: deps.source, workdir: await shellWorkdir(deps) }),
  }
}

interface WriteCredOutcome {
  ok: boolean
  error: string
  path: string
  operation: string
  permission: CredentialPermission
}

/** 写 `~/.ossutilconfig`，并把权限收紧到 600（Windows 上如实报「继承账户 ACL」）。 */
async function writeOssCred(
  deps: OssDeps,
  input: { accessKeyId: string; accessKeySecret: string; stsToken: string; endpoint: string },
): Promise<WriteCredOutcome> {
  const path = ossConfigPath(deps.home)
  const built = buildConfigContent(input)
  if (!built.ok) return { ok: false, error: built.error, path: '', operation: '', permission: failedPermission(built.error, deps.platform) }

  // `~/.ossutilconfig` 在**工作区之外**：受限沙箱（workspace-write）下写它会被拦 ——
  // 实测报 `cannot write "…\.ossutilconfig": file access denied under workspace-write mode`
  // （2026-09-28，Windows）。协议 18 起这件事只有一条路径：Broker 的 `oss.config.write`
  // （逐次声明策略 + 目标路径逐字比对）。
  const written = await deps.access.writeText(
    { operation: 'oss.config.write', source: 'panel', workdir: await shellWorkdir(deps) },
    { kind: 'oss-config', path },
    built.content,
  )
  if (!written.ok) {
    return { ok: false, error: `写入 OSS 配置失败：${written.error}`, path: '', operation: '', permission: failedPermission(written.error, deps.platform) }
  }
  const operation = 'create'
  // 权限结论由 `enforceCredentialPermission` 统一给出（三条结局各有名字，见 shared/types.ts）：
  // Windows 上报 `inherited / windows-acl`，POSIX 上失败或成功都如实说。
  const permission = await enforceCredentialPermission({
    access: deps.access, operation: 'oss.config.permission', path, platform: deps.platform,
    workdir: await shellWorkdir(deps),
  })
  // 权限没成立就不算保存成功（P-08/M-04）：POSIX 上必须**回读**为 0600。
  // 只跑 chmod 不看结果、却回 `ok:true`，会让一次"其实没保护住"的保存被当成成功。
  if (!credentialPermissionSatisfied(permission)) {
    return {
      ok: false,
      error: `凭据已写入 ${path}，但权限没有生效：${permission.message}`,
      path,
      operation,
      permission,
    }
  }
  return {
    ok: true,
    error: '',
    path,
    operation,
    permission,
  }
}

/** 写盘都没走到权限那一步时的失败信封（mechanism 与平台一致，status 恒为 failed）。 */
function failedPermission(message: string, platform: string): CredentialPermission {
  return { status: 'failed', mechanism: privateFileMechanism(platform), message }
}

/** 生成 ossutil 配置内容（`[Credentials]` 段）。 */
export function buildConfigContent(input: { accessKeyId: string; accessKeySecret: string; stsToken: string; endpoint: string }): { ok: boolean; error: string; content: string } {
  const lines = ['[Credentials]', 'language=CH']
  if (input.endpoint !== '') lines.push(`endpoint=${input.endpoint}`)
  lines.push(`accessKeyID=${input.accessKeyId}`, `accessKeySecret=${input.accessKeySecret}`)
  if (input.stsToken !== '') lines.push(`stsToken=${input.stsToken}`)
  return { ok: true, error: '', content: `${lines.join('\n')}\n` }
}
