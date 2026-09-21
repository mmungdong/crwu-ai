import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { isWindowsPlatform } from '../platform/detect.ts'
import { expandLocal } from '../platform/home.ts'
import { runShell, shellUnavailable } from '../shell/run.ts'
import type { BinarySpec, EnvManifest, OssSpec, ServiceSpec } from './manifest-default.ts'
import { quoteArg, resolveBinary } from './manifest.ts'
import { parseVersion, satisfies, type SatisfyVerdict } from './version.ts'

/** 单个二进制的探测结果。字段与 legacy 的 `checks[]` 一一对应，界面不需要改。 */
export interface EnvCheck {
  name: string
  command: string
  required: boolean
  note: string
  found: boolean
  path: string
  versionText: string
  actual: string
  expect: string
  ok: boolean
  reason: string
  url: string
  sha256: string
  target: string
}

/** OSS / 氚云 / 钉钉这类「服务」的探测结果。 */
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
 * 探测所有二进制。
 *
 * 做法与 legacy 一致，但每步都有明确用途：
 * 1. 一次 shell 调用把所有命令的绝对路径捞出来（`command -v`），避免 N 次子进程；
 * 2. 命令不在 PATH 时，再由 `fs.stat` 检查清单里写的 `target`（`~/bin/ossutil` 这类）；
 * 3. 只有真的找到了才去跑版本命令，并用 `satisfies` 判定。
 *
 * 「找不到」是 `未安装`，「找到但读不出版本」是另一种失败 —— 两者不能混。
 */
export async function probeEnv(
  ctx: Context,
  manifest: EnvManifest,
  platform: string,
  options: { home?: string; workdir?: string } = {},
): Promise<EnvCheck[]> {
  const entries = manifest.binaries
  const safeCommands = entries
    .map((entry) => text(entry.command))
    .filter((command) => /^[A-Za-z0-9._-]+$/.test(command))

  const paths: Record<string, string> = {}
  // 路径探测这步**自己**没跑起来的原因。它为空才说明「查过了，确实不在 PATH 上」。
  // 生成脚的循环以 `done` 结束，正常跑完必是退出码 0，所以 `!ok` 只可能是沙箱后端不可用 /
  // shell 服务缺失 / 被超时或取消杀掉 —— 这时空结果是「不知道」，不是「没装」。
  let pathProbeError = ''
  if (safeCommands.length > 0) {
    const script = `for b in ${safeCommands.join(' ')}; do p=$(command -v "$b" 2>/dev/null); printf "%s\\t%s\\n" "$b" "$p"; done`
    const result = await runShell(ctx, script, {
      timeoutMs: 30_000,
      ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
    })
    if (!result.ok) pathProbeError = result.error === '' ? '路径探测命令未能正常完成' : result.error
    for (const line of text(result.stdout).split('\n')) {
      const at = line.indexOf('\t')
      if (at > 0) paths[line.slice(0, at)] = line.slice(at + 1).trim()
    }
  }

  const fs = fileSystem(ctx)
  const home = options.home ?? ''
  const isWindows = isWindowsPlatform(platform)
  const checks: EnvCheck[] = []

  /** 组装一条结果，避免两处对象字面量漂移。 */
  const record = (entry: BinarySpec, found: string, versionText: string, verdict: SatisfyVerdict): EnvCheck => ({
    name: entry.name,
    command: entry.command,
    required: entry.required,
    note: entry.note,
    found: found !== '',
    path: found,
    versionText,
    actual: versionText === '' ? '' : (parseVersion(versionText) ?? []).join('.'),
    expect: entry.expect,
    ok: found !== '' && verdict.ok,
    reason: verdict.reason,
    url: entry.url,
    sha256: entry.sha256,
    target: entry.target,
  })

  for (const raw of entries) {
    const entry: BinarySpec = resolveBinary(raw, platform)
    let found = text(paths[entry.command])
    if (found === '' && entry.target !== '') {
      const candidate = expandLocal(entry.target, home, isWindows)
      try {
        const target = await resolveTarget(ctx, candidate)
        const info = fs === undefined ? undefined : await fs.stat(target)
        if (info?.type === 'file') found = text(target.displayPath)
      } catch (error) {
        // 目标不存在等于「没装」，不是异常。
        void error
      }
    }

    // 连 PATH 都没查成（沙箱不可用等）时，「没找到」不构成证据。
    if (found === '' && pathProbeError !== '') {
      checks.push(record(entry, '', '', { ok: false, reason: `无法探测：${pathProbeError}` }))
      continue
    }

    let versionText = ''
    let versionError = ''
    if (found !== '') {
      const args = entry.versionArgs.map((arg) => shellQuote(arg, platform)).join(' ')
      const command = shellQuote(found, platform) + (args === '' ? '' : ` ${args}`)
      const result = await runShell(ctx, command, {
        timeoutMs: 30_000,
        ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
      })
      // 「版本命令根本没执行」（沙箱不可用）与「执行了但输出读不出版本」必须分开报。
      if (shellUnavailable(result)) versionError = result.error
      versionText = `${text(result.stdout)}\n${text(result.stderr)}`.trim().split('\n')[0]?.trim() ?? ''
    }

    const verdict = found === ''
      ? { ok: false, reason: '未安装' }
      : (versionError === ''
          ? satisfies(versionText, entry.expect)
          : { ok: false, reason: `无法执行版本命令：${versionError}` })
    checks.push(record(entry, found, versionText, verdict))
  }
  return checks
}

/**
 * 解析 ossutil 的实际路径：先看 PATH，再落到清单给的安装目标。
 *
 * `error` 区分「探测本身没跑起来」（沙箱不可用 / shell 服务缺失）与「确实没装」：
 * 前者报成「未安装 ossutil，请先安装」会让人去装一个已经装好的东西。
 */
export interface OssutilLookup {
  /** 解析到的路径；没找到时为空串。 */
  path: string
  /** 探测命令没能执行的原因；为空表示探测真的执行过。 */
  error: string
}

/** 定位失败时给用户的那句话：探测失败报真实原因，真的没有才说去安装。 */
export function ossutilMissingMessage(lookup: OssutilLookup): string {
  return lookup.error === '' ? '未找到 ossutil，请先安装' : `无法定位 ossutil：${lookup.error}`
}

export async function resolveOssutil(
  ctx: Context,
  oss: OssSpec,
  platform: string,
  options: { manifest?: EnvManifest; home?: string; workdir?: string } = {},
): Promise<OssutilLookup> {
  const probe = await runShell(ctx, `command -v ${shellQuote(oss.ossutil, platform)} 2>/dev/null || true`, {
    timeoutMs: 15_000,
    ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
  })
  const onPath = text(probe.stdout).trim()
  if (onPath !== '') return { path: onPath, error: '' }

  const entry = options.manifest?.binaries.find((item) => text(item.name) === 'ossutil')
  if (entry !== undefined) {
    const resolved = resolveBinary(entry, platform)
    if (resolved.target !== '') {
      const candidate = expandLocal(resolved.target, options.home ?? '', isWindowsPlatform(platform))
      try {
        const target = await resolveTarget(ctx, candidate)
        const info = await fileSystem(ctx)?.stat(target)
        if (info?.type === 'file') return { path: candidate, error: '' }
      } catch (error) {
        // 目标不存在等于「没装」，不是异常。
        void error
      }
    }
  }

  // PATH 与清单目标都没命中：只有探测命令真的执行过，才能断言「没装」。
  return { path: '', error: probe.ok ? '' : (probe.error || 'ossutil 路径探测命令未能正常完成') }
}

/** 探测 OSS 的 AK 是否真的能列对象 —— 这是「AK 配好了吗」唯一可信的证据。 */
export async function probeOss(
  ctx: Context,
  oss: OssSpec,
  platform: string,
  options: { manifest?: EnvManifest; home?: string; workdir?: string } = {},
): Promise<ServiceCheck> {
  const base = { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true }
  if (!oss.enabled) return { ...base, ok: false, state: '未启用', detail: '清单 oss.enabled 为 false' }
  if (oss.bucket === '') return { ...base, ok: false, state: '缺 bucket', detail: '清单 oss.bucket 为空' }

  const lookup = await resolveOssutil(ctx, oss, platform, options)
  if (lookup.path === '') {
    // 「探测命令没跑起来」不能报成「ossutil 未安装」—— 那会让人去装一个已经装好的东西。
    return lookup.error === ''
      ? { ...base, ok: false, state: 'ossutil 未安装', detail: '请复制安装提示词交给 Agent。' }
      : { ...base, ok: false, state: '无法探测', detail: lookup.error }
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
