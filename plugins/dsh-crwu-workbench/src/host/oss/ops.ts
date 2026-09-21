import type { Context } from '@deepseek-ai/cordis'
import { parseJsonLoose } from '../../shared/utils/json.ts'
import { text } from '../../shared/utils/value.ts'
import type { EnvManifest, OssSpec } from '../environment/manifest-default.ts'
import { ossutilMissingMessage, probeOss, resolveOssutil, shellQuote } from '../environment/probe.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { runShell } from '../shell/run.ts'
import { readOssCred, type OssCredView } from './cred.ts'
import { groupObjects, isResultJson, joinUrl, parseLsObjects, parseSignUrl, stripPrefix } from './parse.ts'
import { inspectCase } from '../audit/case.ts'
import { auditInfoFromResult } from '../audit/summary.ts'

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
    manifest: deps.manifest,
    home: deps.home,
    workdir: await shellWorkdir(deps),
  })
  if (lookup.path === '') return { ok: false, error: ossutilMissingMessage(lookup) }
  return { ok: true, oss, ossutil: lookup.path }
}

function endpointArgs(oss: OssSpec, platform: string): string {
  return oss.endpoint === '' ? '' : ` --endpoint ${shellQuote(oss.endpoint, platform)}`
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
export async function ossIndex(deps: OssDeps): Promise<OssIndexResult> {
  const empty = { bucket: '', prefix: '', count: 0, items: {}, truncated: false }
  const ready = await requireOss(deps)
  if (!ready.ok) return { ok: false, error: ready.error, ...empty }
  const { oss, ossutil } = ready

  const argv = [ossutil, 'ls', `oss://${oss.bucket}/${oss.prefix}/`, '--short-format']
  if (oss.endpoint !== '') argv.push('--endpoint', oss.endpoint)
  const run = await runShell(deps.ctx, argv.map((item) => shellQuote(item, deps.platform)).join(' '), {
    workdir: await shellWorkdir(deps),
    timeoutMs: 90_000,
    stdoutMaxBytes: 4 * 1024 * 1024,
  })
  if (!run.ok) {
    const raw = (text(run.stderr) || text(run.error) || text(run.stdout) || '列举失败').trim()
    return { ok: false, error: raw.slice(0, 400), ...empty }
  }
  const keys = parseLsObjects(run.stdout, oss.bucket)
  return {
    ok: true,
    error: '',
    bucket: oss.bucket,
    prefix: oss.prefix,
    count: keys.length,
    items: groupObjects(keys, oss.prefix),
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
    manifest: deps.manifest,
    home: deps.home,
    workdir: await shellWorkdir(deps),
  })
  if (lookup.path === '') return failed(ossutilMissingMessage(lookup))
  const ossutil = lookup.path

  const argv = [ossutil, 'cat', `oss://${oss.bucket}/${key}`]
  if (oss.endpoint !== '') argv.push('--endpoint', oss.endpoint)
  const run = await runShell(deps.ctx, argv.map((item) => shellQuote(item, deps.platform)).join(' '), {
    workdir: await shellWorkdir(deps),
    timeoutMs: 60_000,
    stdoutMaxBytes: 8 * 1024 * 1024,
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
      manifest: deps.manifest,
      home: deps.home,
      workdir: await shellWorkdir(deps),
    })
    if (lookup.path === '') return failed(ossutilMissingMessage(lookup))
    const ossutil = lookup.path
    const argv = [ossutil, 'sign', cloud, '--timeout', String(oss.linkTtl)]
    if (oss.endpoint !== '') argv.push('--endpoint', oss.endpoint)
    const run = await runShell(deps.ctx, argv.map((item) => shellQuote(item, deps.platform)).join(' '), {
      workdir: await shellWorkdir(deps),
      timeoutMs: 30_000,
    })
    if (!run.ok) return failed((text(run.stderr) || text(run.error) || '签名失败').slice(0, 300))
    url = parseSignUrl(run.stdout)
    if (url === '') return failed(`签名命令没有输出 URL：${text(run.stdout).slice(0, 200)}`)
  }

  // 链接里带 bearer 签名，能拿到就能看 —— 不能走明文。
  if (url.startsWith('http://')) url = `https://${url.slice('http://'.length)}`

  const command = deps.platform.startsWith('darwin')
    ? `open ${shellQuote(url, deps.platform)}`
    : (deps.platform.startsWith('win32')
      ? `cmd /c start "" ${shellQuote(url, deps.platform)}`
      : `xdg-open ${shellQuote(url, deps.platform)}`)
  const opened = await runShell(deps.ctx, command, {
    workdir: await shellWorkdir(deps),
    timeoutMs: 30_000,
    escalate: true,
  })
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
    const local = `${item.path.replace(/\/+$/, '')}/${file.name}`
    const key = `${prefix}/${file.name}`
    const argv = [ossutil, 'cp', '-f', local, `oss://${oss.bucket}/${key}`]
    if (oss.endpoint !== '') argv.push('--endpoint', oss.endpoint)
    for (const extra of oss.extraArgs) argv.push(extra)
    const run = await runShell(deps.ctx, argv.map((item2) => shellQuote(item2, deps.platform)).join(' '), {
      workdir: await shellWorkdir(deps),
      timeoutMs: 180_000,
    })
    results.push({
      kind: file.kind,
      name: file.name,
      key,
      ok: run.ok,
      publicUrl: joinUrl(oss.publicBaseUrl, key),
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

/** 队列外的手动重传：按 key 找到记录，或直接用调用方给的 casePath。 */
export async function ossUpload(
  deps: OssDeps,
  args: Record<string, unknown>,
  state: { audits: Record<string, { casePath: string; uploadedAt: string; uploadError: string; ossPrefix: string }> },
): Promise<UploadResult> {
  const key = text(args.key)
  const record = key === '' ? undefined : state.audits[key]
  const casePath = text(args.casePath) || record?.casePath || ''
  if (casePath === '') {
    return { ok: false, error: '这条审核还没定位到案例目录，无法重传。', bucket: '', prefix: '', results: [] }
  }
  const oss = deps.manifest.oss
  if (!oss.enabled) return { ok: false, error: 'OSS 回传未启用：请在远程清单里把 oss.enabled 设为 true。', bucket: '', prefix: '', results: [] }
  if (oss.bucket === '') return { ok: false, error: 'OSS 回传缺少 bucket。', bucket: '', prefix: '', results: [] }
  const lookup = await resolveOssutil(deps.ctx, oss, deps.platform, {
    manifest: deps.manifest,
    home: deps.home,
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

  const projectId = key !== '' ? key : (text(args.projectId) || item.name)
  const out = await uploadArtifacts(deps, item, projectId, ossutil, oss)
  if (record !== undefined) {
    if (out.ok) {
      record.uploadedAt = new Date().toISOString()
      record.uploadError = ''
      record.ossPrefix = out.prefix
    } else {
      record.uploadError = out.error.slice(0, 300) || '上传失败'
    }
  }
  return out
}

// ── oss-cred-save ───────────────────────────────────────────────────────────

export interface CredSaveResult {
  ok: boolean
  error: string
  path: string
  operation: string
  chmodOk: boolean
  chmodError: string
  probe: Record<string, unknown> | null
  cred: OssCredView | null
}

export async function ossCredSave(deps: OssDeps, args: Record<string, unknown>): Promise<CredSaveResult> {
  const failed = (error: string): CredSaveResult => ({
    ok: false, error, path: '', operation: '', chmodOk: false, chmodError: '', probe: null, cred: null,
  })
  const accessKeyId = text(args.accessKeyId).trim()
  const accessKeySecret = text(args.accessKeySecret).trim()
  if (accessKeyId === '' || accessKeySecret === '') return failed('AccessKey ID 与 AccessKey Secret 都不能为空。')
  // 换行会破坏 ini 结构，等于写到配置文件里一行垃圾。
  if (/[\r\n]/.test(accessKeyId) || /[\r\n]/.test(accessKeySecret)) return failed('凭据不能包含换行。')

  const written = await writeOssCred(deps, {
    accessKeyId,
    accessKeySecret,
    stsToken: text(args.stsToken).trim(),
    endpoint: text(args.endpoint).trim(),
  })
  if (!written.ok) return failed(written.error)

  const probe = await probeOss(deps.ctx, deps.manifest.oss, deps.platform, {
    manifest: deps.manifest,
    home: deps.home,
    workdir: await shellWorkdir(deps),
  })
  return {
    ok: true,
    error: '',
    path: written.path,
    operation: written.operation,
    chmodOk: written.chmodOk,
    chmodError: written.chmodError,
    probe: probe as unknown as Record<string, unknown>,
    cred: await readOssCred(deps.ctx, deps.home),
  }
}

interface WriteCredOutcome {
  ok: boolean
  error: string
  path: string
  operation: string
  chmodOk: boolean
  chmodError: string
}

/** 写 `~/.ossutilconfig`，并把权限收紧到 600。 */
async function writeOssCred(
  deps: OssDeps,
  input: { accessKeyId: string; accessKeySecret: string; stsToken: string; endpoint: string },
): Promise<WriteCredOutcome> {
  const fs = fileSystem(deps.ctx)
  if (fs === undefined) return { ok: false, error: 'Host 文件服务不可用', path: '', operation: '', chmodOk: false, chmodError: '' }
  const path = `${deps.home.replace(/[\\/]+$/, '')}/.ossutilconfig`
  const built = buildConfigContent(input)
  if (!built.ok) return { ok: false, error: built.error, path: '', operation: '', chmodOk: false, chmodError: '' }

  let operation = ''
  try {
    const outcome = await fs.writeText(await resolveTarget(deps.ctx, path), built.content)
    operation = text(outcome?.operation)
  } catch (error) {
    return { ok: false, error: `写入 ${path} 失败：${error instanceof Error ? error.message : String(error)}`, path: '', operation: '', chmodOk: false, chmodError: '' }
  }
  const chmod = await runShell(deps.ctx, `chmod 600 ${shellQuote(path, deps.platform)}`, {
    workdir: await shellWorkdir(deps),
    timeoutMs: 15_000,
  })
  return {
    ok: true,
    error: '',
    path,
    operation,
    chmodOk: chmod.ok,
    chmodError: chmod.ok ? '' : (text(chmod.stderr) || text(chmod.error) || '权限设置失败').slice(0, 200),
  }
}

/** 生成 ossutil 配置内容（`[Credentials]` 段）。 */
export function buildConfigContent(input: { accessKeyId: string; accessKeySecret: string; stsToken: string; endpoint: string }): { ok: boolean; error: string; content: string } {
  const lines = ['[Credentials]', 'language=CH']
  if (input.endpoint !== '') lines.push(`endpoint=${input.endpoint}`)
  lines.push(`accessKeyID=${input.accessKeyId}`, `accessKeySecret=${input.accessKeySecret}`)
  if (input.stsToken !== '') lines.push(`stsToken=${input.stsToken}`)
  return { ok: true, error: '', content: `${lines.join('\n')}\n` }
}
