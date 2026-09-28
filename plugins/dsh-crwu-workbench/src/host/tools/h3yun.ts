import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { text } from '../../shared/utils/value.ts'
import { runCrwu } from '../crwu/run.ts'
import { RECORDS_STDOUT_MAX } from '../h3yun/consts.ts'
import { requireBundledCommand } from '../platform/command.ts'
import { requireCaseDir, requireInsideCase, isRegularFile, fileSize } from './case-dir.ts'
import { TOOL_NAMES } from './consts.ts'
import { clampText, failure, jsonObject, reasonOf, renderJson, type ToolFailure } from './outcome.ts'
import { credentialsTrusted, toolContext, type ToolDeps } from './types.ts'

/**
 * 氚云（H3Yun）业务 Tool。
 *
 * 三个工具对应审核链路的三个动作，**都不是通用逃生口**：模型提交的只有业务标识
 * （`objectId` / `fileId`）与案例目录，argv 由这里按固定模板拼装。
 *
 * **`schemaCode` 不在任何工具的入参里**（2026-09-25）：它是 Host 的基础设施状态，由
 * `H3yunFormResolver` 解析（已缓存零成本、未缓存时全插件只发现一次）。让模型提交它，
 * 就等于让模型去「发现表单」—— 实测后果是子代理重复取数、并在案例目录里翻找材料。
 * 任何 binary / argv / sandbox 参数都不在 schema 里，模型也无法通过参数请求提权
 * （提权只看插件状态里的授权位）。
 *
 * 安全边界（对应技能 `references/00` 与 SKILL.md 的阶段一门禁）：
 * - `files_list` **只回元数据**，不下载、不回显下载 URL（URL 带会话鉴权）；
 * - `file_get` **只允许单附件定向下载**，目标必须落在案例目录内；
 *   本工具**没有**「整单下载」这条路径，也就不存在「失败回退到整单」。
 */

const COMMON_RESULT = {
  ok: { type: 'boolean', required: true, description: '本次工具调用是否成功' },
  errorKind: { type: 'string', required: true, description: '失败类别：input/capability-gap/approval/infrastructure/cancelled/cli/not-found/policy；成功为空串' },
  error: { type: 'string', required: true, description: '失败原因（脱敏后的原文）；成功为空串' },
} as const

/** `crwu h3yun records get` 的应答 → 记录本体（全部字段，原样保留）。 */
function recordOf(payload: unknown): Record<string, JsonValue> | null {
  const doc = jsonObject(payload)
  if (doc === null) return null
  const data = doc.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  return data as Record<string, JsonValue>
}

/**
 * 审核工具专用的 crwu 定位：**受支持平台上必须用包内绝对路径**。
 *
 * 与 `runCrwu` 内部的宽松解析（找不到就回退裸名字）不同：审核链路明确要求
 * 「缺二进制 → capability gap」，因为回退裸名字会让模型看到 `command not found`，
 * 下一步自然就是去搜索 PATH —— 正是本次改造要消灭的行为。
 */
async function requireCrwu(ctx: Context, platform: string): Promise<ToolFailure | null> {
  const resolved = await requireBundledCommand(ctx, platform, 'crwu')
  return resolved.ok ? null : failure(resolved.errorKind, resolved.error)
}

/** 模型不能提交二进制/sandbox 参数；schema 里根本没有这些字段。 */
export function h3yunTools(deps: ToolDeps) {
  const recordGet = defineTool({
    name: TOOL_NAMES.h3yunRecordGet,
    description: [
      '按 objectId 读取一条氚云报告审核记录的**全部字段**（一次取数，不分页、不挑选字段）。',
      '表单 schemaCode 由 Host 自己解析，**不由调用方提交**。',
      '返回规范化记录 JSON（原始字段代码原样保留，不做语义改写）。',
      '审核链路里记录已经在启动前由 crwu_audit_case_bootstrap 取好并落盘：优先读那份输入快照，不要重复取数。',
    ].join(' '),
    parameters: {
      objectId: { type: 'string', required: true, description: '记录 ObjectId' },
      caseDir: { type: 'string', description: '案例目录绝对路径；给了就作为本次命令的工作目录（提权执行必须锚定工作区）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...COMMON_RESULT,
          objectId: { required: true, type: 'string' },
          fieldCount: { required: true, type: 'integer' },
          record: { required: true, type: 'json', description: '记录本体（全部字段）' },
        },
        
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const ctx = toolContext(deps.ctx, exec)
      const objectId = text(args.objectId).trim()
      const base = { objectId, fieldCount: 0, record: {} as Record<string, JsonValue> }
      if (objectId === '') return { ...failure('input', 'objectId 不能为空'), ...base }
      const platform = await deps.world.platform()
      const gap = await requireCrwu(ctx, platform)
      if (gap !== null) return { ...gap, ...base }
      // schemaCode 只来自 Host。定位失败要说得出是哪一步（表单没找到 vs 命令没跑起来）。
      const form = await deps.form.ensure()
      if (!form.ok) {
        const kind = form.error.startsWith('未在氚云定位到表单') ? 'not-found' as const : 'cli' as const
        return { ...failure(kind, form.error), ...base }
      }
      const requested = text(args.caseDir).trim()
      const workdir = requested === '' ? await deps.world.workdir() : requested
      const run = await runCrwu(ctx, ['crwu', 'h3yun', 'records', 'get', '--schema', form.code, '--id', objectId], {
        workdir,
        timeoutMs: 90_000,
        trusted: credentialsTrusted(deps),
        platform,
        stdoutMaxBytes: RECORDS_STDOUT_MAX,
        signal: exec.signal,
      })
      if (!run.ok) {
        return {
          ...failure(run.error !== '' ? 'infrastructure' : 'cli', reasonOf(run)),
          ...base,
        }
      }
      const record = recordOf(run.stdout)
      if (record === null) {
        return { ...failure('cli', `records get 没有返回可解析的记录 JSON：${clampText(run.stdout, 400)}`), ...base }
      }
      return {
        ok: true,
        errorKind: '' as const,
        error: '',
        objectId,
        fieldCount: Object.keys(record).length,
        record,
      }
    },
  })

  const filesList = defineTool({
    name: TOOL_NAMES.h3yunFilesList,
    description: [
      '列出某条氚云记录的**附件元数据**（fileId / 文件名 / 文件大小 / 内容类型 / 所属字段）。',
      '表单 schemaCode 由 Host 自己解析，**不由调用方提交**。',
      '本工具**不下载任何文件**，也不回显带会话鉴权的下载 URL。',
      '审核链路优先读启动时落盘的输入快照（附件清单.json），不要重复列举。',
    ].join(' '),
    parameters: {
      objectId: { type: 'string', required: true, description: '记录 ObjectId' },
      caseDir: { type: 'string', description: '案例目录绝对路径（作为命令工作目录）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...COMMON_RESULT,
          count: { required: true, type: 'integer' },
          files: { required: true,
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                field: { required: true, type: 'string' },
                fileId: { required: true, type: 'string' },
                fileName: { required: true, type: 'string' },
                fileSize: { required: true, type: 'string' },
                contentType: { required: true, type: 'string' },
              },
              
            },
          },
        },
        
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const ctx = toolContext(deps.ctx, exec)
      const objectId = text(args.objectId).trim()
      if (objectId === '') return { ...failure('input', 'objectId 不能为空'), count: 0, files: [] }
      const platform = await deps.world.platform()
      const gap = await requireCrwu(ctx, platform)
      if (gap !== null) return { ...gap, count: 0, files: [] }
      const form = await deps.form.ensure()
      if (!form.ok) {
        const kind = form.error.startsWith('未在氚云定位到表单') ? 'not-found' as const : 'cli' as const
        return { ...failure(kind, form.error), count: 0, files: [] }
      }
      const requested = text(args.caseDir).trim()
      const workdir = requested === '' ? await deps.world.workdir() : requested
      const run = await runCrwu(ctx, ['crwu', 'h3yun', 'files', 'list', '--schema', form.code, '--id', objectId], {
        workdir,
        timeoutMs: 90_000,
        trusted: credentialsTrusted(deps),
        platform,
        stdoutMaxBytes: RECORDS_STDOUT_MAX,
        signal: exec.signal,
      })
      if (!run.ok) {
        return { ...failure(run.error !== '' ? 'infrastructure' : 'cli', reasonOf(run)), count: 0, files: [] }
      }
      const doc = jsonObject(run.stdout)
      const rows = doc !== null && Array.isArray(doc.data) ? doc.data : null
      if (rows === null) {
        return { ...failure('cli', `files list 没有返回附件数组：${clampText(run.stdout, 400)}`), count: 0, files: [] }
      }
      // 只保留元数据：downloadUrl 明确丢弃（它带会话鉴权，不进模型上下文、也不进测试快照）。
      const files = rows.map((row) => {
        const item = row !== null && typeof row === 'object' ? row as Record<string, unknown> : {}
        return {
          field: text(item.field),
          fileId: text(item.fileId),
          fileName: text(item.fileName),
          fileSize: text(item.fileSize),
          contentType: text(item.contentType),
        }
      }).filter((item) => item.fileId !== '')
      return { ok: true, errorKind: '' as const, error: '', count: files.length, files }
    },
  })

  const fileGet = defineTool({
    name: TOOL_NAMES.h3yunFileGet,
    description: [
      '按 fileId **单附件定向下载**氚云记录附件到案例目录内的相对路径。',
      '目标必须落在给定案例目录之下（越界直接拒绝）。',
      '本工具没有「整单下载」路径：一次只取一个附件，失败就是失败，不会退化成批量下载。',
    ].join(' '),
    parameters: {
      fileId: { type: 'string', required: true, description: '附件 fileId（来自 crwu_h3yun_files_list）' },
      caseDir: { type: 'string', required: true, description: '案例目录绝对路径（下载目标必须落在它之下）' },
      relativePath: { type: 'string', required: true, description: '案例目录内的相对目标路径，例如 材料-源/估值报告.pdf' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...COMMON_RESULT,
          fileId: { required: true, type: 'string' },
          path: { required: true, type: 'string' },
          sizeBytes: { required: true, type: 'integer' },
        },
        
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const ctx = toolContext(deps.ctx, exec)
      const fileId = text(args.fileId).trim()
      const caseCheck = await requireCaseDir(ctx, args.caseDir)
      if (!caseCheck.ok) return { ...caseCheck, fileId, path: '', sizeBytes: 0 }
      const target = await requireInsideCase(ctx, caseCheck.path, args.relativePath)
      if (!target.ok) return { ...target, fileId, path: '', sizeBytes: 0 }
      if (fileId === '') return { ...failure('input', 'fileId 不能为空'), fileId, path: '', sizeBytes: 0 }

      const platform = await deps.world.platform()
      const gap = await requireCrwu(ctx, platform)
      if (gap !== null) return { ...gap, fileId, path: '', sizeBytes: 0 }
      const run = await runCrwu(ctx, ['crwu', 'h3yun', 'file', 'get', '--id', fileId, '--out', target.path], {
        workdir: caseCheck.path,
        timeoutMs: 180_000,
        trusted: credentialsTrusted(deps),
        platform,
        signal: exec.signal,
      })
      if (!run.ok) {
        return { ...failure(run.error !== '' ? 'infrastructure' : 'cli', reasonOf(run)), fileId, path: target.path, sizeBytes: 0 }
      }
      if (!await isRegularFile(ctx, target.path)) {
        return { ...failure('cli', `下载命令成功但目标文件不存在：${target.path}`), fileId, path: target.path, sizeBytes: 0 }
      }
      const size = await fileSize(ctx, target.path)
      if (size <= 0) {
        return { ...failure('cli', `下载到的附件字节数为 0：${target.path}`), fileId, path: target.path, sizeBytes: size }
      }
      return { ok: true, errorKind: '' as const, error: '', fileId, path: target.path, sizeBytes: size }
    },
  })

  return [recordGet, filesList, fileGet]
}
