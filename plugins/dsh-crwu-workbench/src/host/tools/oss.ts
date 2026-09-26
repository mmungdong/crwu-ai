import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../shared/utils/value.ts'
import { isSafeSeqNo } from '../../shared/consts.ts'
import { normalizeOss } from '../environment/manifest.ts'
import { shellQuote } from '../environment/probe.ts'
import { requireBundledCommand } from '../platform/command.ts'
import { parseLsEntries, type OssEntry } from '../oss/parse.ts'
import { runShell } from '../shell/run.ts'
import { fileSize, requireCaseDir, requireInsideCase } from './case-dir.ts'
import { failure, renderJson } from './outcome.ts'
import { toolContext, type ToolDeps } from './types.ts'

/**
 * OSS 交付件发布 Tool。
 *
 * 与旧路径的差别：bucket / endpoint / prefix **只从受信配置读**（`config/crwu-workbench.yml`
 * → 运行时清单），模型提交的只有 `caseDir` 与 `seqNo`，或显式列出的交付件相对名。
 * 所以模型无法把交付件传到别的桶、别的路径去。
 *
 * 上传后必须**真的列举一次**核对：目标对象存在、字节数与本地一致且非 0。
 * 只凭退出码判断是本仓踩过的坑（`ossutil` 的 `elapsed` 尾巴就是这类遗漏）。
 *
 * sandbox：OSS 是非凭据操作，走**默认沙箱**，不提权（`AGENTS.md` §4.3）。
 */

/** 默认交付件：HTML 必传，结果 JSON 存在就一并传。 */
export const DEFAULT_HTML_NAME = (seqNo: string): string => `审核意见.${seqNo}.html`
export const DEFAULT_JSON_NAME = (seqNo: string): string => `审核结果.${seqNo}.json`

/**
 * 错误脱敏：签名 URL 的查询串、AK/SK/Token 一律不进模型上下文。
 *
 * 为什么必须做：`ossutil` 的报错里会带请求 URL（含 `Signature`/`OSSAccessKeyId`）甚至
 * 完整的临时凭据。这类文本一旦进会话记录，就等于把凭据写进了可回放的日志。
 */
export function sanitizeOssError(value: unknown): string {
  return text(value)
    .replace(/(Signature|OSSAccessKeyId|security-token|AccessKeyId|AccessKeySecret|STS\w*Token)=[^&\s"']+/gi, '$1=<redacted>')
    .replace(/(https?:\/\/[^\s"']*?)\?[^\s"']*/gi, '$1?<redacted>')
    .replace(/\bLTAI[A-Za-z0-9]{8,}\b/g, '<redacted-access-key>')
    .slice(0, 600)
}

interface UploadEntry {
  kind: string
  name: string
  key: string
  ok: boolean
  sizeBytes: number
  exitCode: number | null
  error: string
}

const UPLOAD_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { required: true, type: 'string' },
    name: { required: true, type: 'string' },
    key: { required: true, type: 'string' },
    ok: { required: true, type: 'boolean' },
    sizeBytes: { required: true, type: 'integer' },
    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    error: { required: true, type: 'string' },
  },
  
} as const

export function ossTools(deps: ToolDeps) {
  const ossPublish = defineTool({
    name: 'crwu_audit_oss_publish',
    description: [
      '把案例目录里的审核交付件上传到受信配置的私有 OSS 桶：HTML 必传，结果 JSON 存在就一并传。',
      '上传后真的列举一次核对目标对象与字节数（只凭退出码不算成功）。',
      'bucket / endpoint / 对象前缀都来自受信配置，不接受模型提交；文件必须位于 caseDir 之内。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '案例目录绝对路径（交付件必须位于其内）' },
      seqNo: { type: 'string', required: true, description: '报告流水号，例如 2026-301705-LX10170-BG8746' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: '可选的交付件相对名清单（相对 caseDir）；缺省为 审核意见.<seqNo>.html + 审核结果.<seqNo>.json（后者存在才传）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { required: true, type: 'boolean' },
          errorKind: { required: true, type: 'string' },
          error: { required: true, type: 'string' },
          bucket: { required: true, type: 'string' },
          prefix: { required: true, type: 'string' },
          uploaded: { required: true, type: 'integer' },
          results: { required: true, type: 'array', items: UPLOAD_ITEM_SCHEMA },
        },
        
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const ctx = toolContext(deps.ctx, exec)
      const empty = { bucket: '', prefix: '', uploaded: 0, results: [] as UploadEntry[] }
      const seqNo = text(args.seqNo).trim()
      if (!isSafeSeqNo(seqNo)) {
        return { ...failure('input', `流水号形状不对（不放进 OSS 路径）：${seqNo === '' ? '(空)' : seqNo}`), ...empty }
      }
      const caseCheck = await requireCaseDir(ctx, args.caseDir)
      if (!caseCheck.ok) return { ...caseCheck, ...empty }

      const oss = normalizeOss(deps.state.manifest.oss, deps.state.manifest.oss)
      if (!oss.enabled) return { ...failure('policy', 'OSS 回传未启用（受信配置里 oss.enabled 不是 true）'), ...empty }
      if (oss.bucket === '') return { ...failure('policy', '受信配置缺 oss.bucket'), ...empty }

      const platform = await deps.world.platform()
      const caseDir = caseCheck.path
      // 严格用包内 ossutil：审核链路不做 PATH 搜索（找不到就是 capability gap，不是回退裸名字）。
      const lookup = await requireBundledCommand(ctx, platform, 'ossutil')
      if (!lookup.ok) {
        return { ...failure(lookup.errorKind, lookup.error), ...empty, bucket: oss.bucket, prefix: oss.prefix }
      }
      const ossutil = lookup.path

      // 交付件清单：默认 HTML + 结果 JSON；显式清单里的每一项都要先过案例目录包含检查。
      const requested = Array.isArray(args.files) ? args.files.map((item) => text(item)).filter((item) => item !== '') : []
      const candidates = requested.length > 0
        ? requested
        : [DEFAULT_HTML_NAME(seqNo), DEFAULT_JSON_NAME(seqNo)]

      const results: UploadEntry[] = []
      const prefix = `${oss.prefix}/${seqNo}`
      for (const relative of candidates) {
        const isDefault = requested.length === 0
        const kind = relative.endsWith('.json') ? 'json' : 'html'
        const inside = await requireInsideCase(ctx, caseDir, relative)
        if (!inside.ok) {
          // 默认清单里的可选文件（结果 JSON）不存在时不算失败，如实记「未生成」。
          if (isDefault) continue
          results.push({ kind, name: relative, key: '', ok: false, sizeBytes: 0, exitCode: null, error: inside.error })
          continue
        }
        const local = inside.path
        const size = await fileSize(ctx, local)
        if (size <= 0) {
          if (isDefault) continue
          results.push({ kind, name: relative, key: '', ok: false, sizeBytes: 0, exitCode: null, error: '文件不存在或为空' })
          continue
        }
        const key = `${prefix}/${relative.split('/').pop() ?? relative}`
        const argv = [ossutil, 'cp', '-f', local, `oss://${oss.bucket}/${key}`]
        if (oss.endpoint !== '') argv.push('--endpoint', oss.endpoint)
        for (const extra of oss.extraArgs) argv.push(extra)
        const run = await runShell(ctx, argv.map((item) => shellQuote(item, platform)).join(' '), {
          workdir: caseDir,
          timeoutMs: 180_000,
          signal: exec.signal,
        })
        if (!run.ok) {
          results.push({
            kind, name: relative, key, ok: false, sizeBytes: 0, exitCode: run.exitCode,
            error: sanitizeOssError(run.stderr || run.error || '上传失败'),
          })
          continue
        }
        // 写后校验：列举一次，目标对象必须在、且字节数与本地一致。
        const verify = await verifyObject(ctx, platform, oss.bucket, prefix, key, size, caseDir, ossutil, exec.signal)
        results.push({
          kind, name: relative, key, ok: verify.ok, sizeBytes: verify.sizeBytes, exitCode: run.exitCode,
          error: verify.ok ? '' : verify.error,
        })
      }

      const uploaded = results.filter((item) => item.ok).length
      const failed = results.filter((item) => !item.ok)
      const htmlOk = results.some((item) => item.kind === 'html' && item.ok)
      if (!htmlOk && failed.length === 0) {
        return {
          ...failure('input', '案例目录里没有找到要上传的 HTML 交付件（审核意见.<seqNo>.html）'),
          bucket: oss.bucket, prefix, uploaded, results,
        }
      }
      return {
        ok: failed.length === 0 && uploaded > 0,
        errorKind: failed.length === 0 ? '' as const : 'cli',
        error: failed.length === 0 ? '' : sanitizeOssError(failed.map((item) => `${item.name}：${item.error}`).join('；')),
        bucket: oss.bucket,
        prefix,
        uploaded,
        results,
      }
    },
  })

  return [ossPublish]
}

/** 列举前缀并核对目标对象的字节数。 */
async function verifyObject(
  ctx: Context,
  platform: string,
  bucket: string,
  prefix: string,
  key: string,
  localSize: number,
  workdir: string,
  ossutil: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: boolean; sizeBytes: number; error: string }> {
  const argv = [ossutil, 'ls', `oss://${bucket}/${prefix}/`]
  const run = await runShell(ctx, argv.map((item) => shellQuote(item, platform)).join(' '), {
    workdir,
    timeoutMs: 90_000,
    stdoutMaxBytes: 4 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!run.ok) return { ok: false, sizeBytes: 0, error: `写后列举失败：${sanitizeOssError(run.stderr || run.error)}` }
  const entries: OssEntry[] = parseLsEntries(run.stdout, bucket)
  const hit = entries.find((entry) => entry.key === key)
  if (hit === undefined) return { ok: false, sizeBytes: 0, error: '写后列举里没有目标对象' }
  if (hit.size !== localSize || hit.size === 0) {
    return { ok: false, sizeBytes: hit.size, error: `写后对象字节数不符：local=${localSize}, remote=${hit.size}` }
  }
  return { ok: true, sizeBytes: hit.size, error: '' }
}
