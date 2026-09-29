import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { text } from '../../shared/utils/value.ts'
import { joinLocalPath } from '../../shared/utils/local-path.ts'
import { runCrwu } from '../crwu/run.ts'
import { H3YUN_FIELDS, RECORDS_STDOUT_MAX } from '../h3yun/consts.ts'
import { labelOf, pick } from '../h3yun/fields.ts'
import { requireBundledCommand } from '../platform/command.ts'
import { fileSystem, resolveTarget } from '../fs/paths.ts'
import { ensureDirectory } from './case-files.ts'
import { allowedCaseRootOf, requireCaseDir } from './case-dir.ts'
import { callerIdentity, callerParentSessionId, isAuditChild } from '../audit/scope.ts'
import { caseDirOf } from '../../shared/utils/case-dir.ts'
import { TOOL_NAMES } from './consts.ts'
import { clampText, failure, jsonObject, reasonOf, renderJson, type ToolFailure } from './outcome.ts'
import { canonicalJson, digestOf, digestOnly } from './snapshot.ts'
import { credentialsTrusted, toolContext, type ToolDeps } from './types.ts'

/**
 * `crwu_audit_case_bootstrap`：**报告定位与一次取数的唯一交接点**。
 *
 * 背景（用户报的缺陷）：审核启动只把 `objectId` / `seqNo` / `project` 交给子代理，而记录接口
 * 需要 `schemaCode` —— 于是子代理自己去「发现表单、列记录、在案例目录里翻找材料」。
 * `schemaCode` 是 Host 的基础设施状态，不是模型该推断的业务参数；让它去猜，就会重复取数、
 * 甚至在别的流水号目录里找到过期材料。
 *
 * 所以这里把它一次性做完：
 * - `schemaCode` 只来自 Host（`H3yunFormResolver`，已缓存则零成本）；
 * - **按精确 `objectId` 各调一次** `records get` 与 `files list`，把结果**落盘**成输入快照；
 * - 交给模型的只有**紧凑摘要**（路径 + 指纹 + 计数 + 少量路由事实），完整记录不进上下文；
 * - 同一 `attemptId` 只执行一次（重入直接返回上次摘要）；`refresh: true`（重审）才会覆盖。
 *
 * 这里**没有**「列记录 / 搜表单 / 扫案例目录」这三条路：argv 是按固定模板拼的，模型提交的
 * 只有业务标识与案例目录（见 `REQUIRED_AUDIT_TOOLS` 的能力门禁）。
 */

/** 快照目录名与三个固定文件名（子代理读它们，路径写进审核指令）。 */
export const SNAPSHOT_DIR = '输入快照'
export const SNAPSHOT_RECORD_FILE = '报告记录.json'
export const SNAPSHOT_ATTACHMENTS_FILE = '附件清单.json'
export const SNAPSHOT_METADATA_FILE = '快照元数据.json'

/** 记住最近几次快照摘要的条数上限（按 attemptId 去重，避免无界增长）。 */
const CACHE_LIMIT = 8

interface AttachmentRow {
  field: string
  fileId: string
  fileName: string
  fileSize: string
  contentType: string
}

/** 给审核路由用的事实（字段固定，和工具 output schema 一一对应）。 */
export interface RoutingFacts {
  project: string
  business: string
  risk: string
  reviewLevel: string
  reviewState: string
  currentNode: string
  modifiedAt: string
  seqNo: string
  formName: string
}

const EMPTY_ROUTING_FACTS: RoutingFacts = {
  project: '', business: '', risk: '', reviewLevel: '', reviewState: '',
  currentNode: '', modifiedAt: '', seqNo: '', formName: '',
}

interface SnapshotSummary {
  attemptId: string
  objectId: string
  seqNo: string
  schemaCodeDigest: string
  fetchedAt: string
  digest: string
  fieldCount: number
  attachmentCount: number
  /**
   * 本轮快照里登记的附件 id（Host 用它写进审核 scope 的白名单）。
   *
   * 只回**标识符**，不回 `downloadUrl`（那带会话鉴权）。
   */
  attachmentIds: string[]
  snapshotDir: string
  snapshotPath: string
  attachmentsPath: string
  metadataPath: string
  routingFacts: RoutingFacts
  /** true = 同一 attemptId 已有快照，本次没有重新取数。 */
  reused: boolean
}

/** 记录本体（`{ data: {...} }` 里的 data），保留全部字段。 */
function recordOf(payload: unknown): Record<string, JsonValue> | null {
  const doc = jsonObject(payload)
  if (doc === null) return null
  const data = doc.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  return data as Record<string, JsonValue>
}

/** 附件元数据（**丢掉** `downloadUrl`：它带会话鉴权，不进快照、不进模型上下文）。 */
function attachmentsOf(payload: unknown): AttachmentRow[] | null {
  const doc = jsonObject(payload)
  if (doc === null || !Array.isArray(doc.data)) return null
  return (doc.data as unknown[]).map((row) => {
    const item = row !== null && typeof row === 'object' ? row as Record<string, unknown> : {}
    return {
      field: text(item.field),
      fileId: text(item.fileId),
      fileName: text(item.fileName),
      fileSize: text(item.fileSize),
      contentType: text(item.contentType),
    }
  }).filter((item) => item.fileId !== '')
}

/**
 * 给审核路由用的少量事实。
 *
 * 只摘「子代理第一步要用到的」那几个字段，**不是**记录副本：完整记录在快照文件里，
 * 需要时由它自己读文件，而不是让模型上下文背着几百个字段。
 */
function routingFactsOf(record: Record<string, JsonValue>, seqNo: string, formName: string): RoutingFacts {
  const value = (keys: string[]): string => text(pick(record, keys))
  return {
    project: value([H3YUN_FIELDS.project]),
    business: value([H3YUN_FIELDS.business]),
    risk: labelOf(pick(record, [H3YUN_FIELDS.risk])),
    reviewLevel: labelOf(pick(record, [H3YUN_FIELDS.reviewLevel])),
    reviewState: labelOf(pick(record, [H3YUN_FIELDS.reviewState])),
    currentNode: labelOf(pick(record, [H3YUN_FIELDS.currentNode])),
    modifiedAt: value(['ModifiedTime', 'modifiedTime', 'CreatedTime', 'createdTime']),
    // 身份已在取数时核对过（`SeqNo` 必须等于请求值），这里不再回退到调用方提交值。
    seqNo: value(['SeqNo', 'seqNo']),
    formName,
  }
}

async function writeJson(ctx: Context, path: string, payload: unknown): Promise<{ ok: boolean; error: string }> {
  const fs = fileSystem(ctx)
  if (fs === undefined) return { ok: false, error: 'Host 文件服务不可用' }
  try {
    await fs.writeText(await resolveTarget(ctx, path), canonicalJson(payload))
    return { ok: true, error: '' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function bootstrapTools(deps: ToolDeps) {
  /** attemptId → 摘要。挂在工具工厂的闭包里 = 插件实例级（随插件卸载一起释放）。 */
  const cache = new Map<string, SnapshotSummary>()

  const bootstrap = defineTool({
    name: TOOL_NAMES.auditCaseBootstrap,
    description: [
      '把这条报告**精确定位并取一次数**：按 objectId 读完整记录与附件元数据，落盘成案例目录内的输入快照，',
      '并只返回紧凑摘要（路径 / 指纹 / 计数 / 少量路由事实）。',
      '记录接口需要的 schemaCode 由 Host 自己解析，模型不提交、也不能覆盖它。',
      '审核启动前 Host 已经调用过一次；子代理不要重复调用，直接用快照文件。',
    ].join(' '),
    parameters: {
      objectId: { type: 'string', required: true, description: '氚云记录 ObjectId（Host 已经按它定位报告）' },
      seqNo: { type: 'string', required: true, description: '报告流水号（写进快照元数据，用于一致性核对）' },
      caseDir: { type: 'string', required: true, description: '案例目录绝对路径；快照落在它的 输入快照/ 子目录下' },
      attemptId: { type: 'string', description: '本轮审核的 attemptId；由 Host 生成并传入，模型不要自己编' },
      refresh: { type: 'boolean', description: '是否强制重新取数覆盖本轮快照；只由 Host 在重审时传 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '本次工具调用是否成功' },
          errorKind: { type: 'string', required: true, description: '失败类别；成功为空串' },
          error: { type: 'string', required: true, description: '失败原因；成功为空串' },
          attemptId: { type: 'string', required: true },
          objectId: { type: 'string', required: true },
          seqNo: { type: 'string', required: true },
          schemaCodeDigest: { type: 'string', required: true, description: '表单 code 的脱敏指纹（不回显原值）' },
          fetchedAt: { type: 'string', required: true },
          digest: { type: 'string', required: true, description: '本轮输入快照的内容指纹' },
          fieldCount: { type: 'integer', required: true },
          attachmentCount: { type: 'integer', required: true },
          attachmentIds: {
            type: 'array', required: true,
            description: '本轮快照登记的可信附件 id（仅标识符）',
            items: { type: 'string' },
          },
          reused: { type: 'boolean', required: true, description: 'true = 同一 attemptId 已有快照，本次没有重新取数' },
          snapshotDir: { type: 'string', required: true },
          snapshotPath: { type: 'string', required: true, description: `完整记录快照：${SNAPSHOT_DIR}/${SNAPSHOT_RECORD_FILE}` },
          attachmentsPath: { type: 'string', required: true },
          metadataPath: { type: 'string', required: true },
          routingFacts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              project: { type: 'string', required: true },
              business: { type: 'string', required: true },
              risk: { type: 'string', required: true },
              reviewLevel: { type: 'string', required: true },
              reviewState: { type: 'string', required: true },
              currentNode: { type: 'string', required: true },
              modifiedAt: { type: 'string', required: true },
              seqNo: { type: 'string', required: true },
              formName: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const ctx = toolContext(deps.ctx, exec)
      const objectId = text(args.objectId).trim()
      const seqNo = text(args.seqNo).trim()
      const attemptId = text(args.attemptId).trim()
      const empty: SnapshotSummary = {
        attemptId, objectId, seqNo, schemaCodeDigest: '', fetchedAt: '', digest: '',
        fieldCount: 0, attachmentCount: 0, attachmentIds: [], snapshotDir: '', snapshotPath: '', attachmentsPath: '',
        metadataPath: '', routingFacts: { ...EMPTY_ROUTING_FACTS }, reused: false,
      }
      if (objectId === '' || seqNo === '') {
        return { ...failure('input', 'objectId 与 seqNo 都不能为空'), ...empty }
      }
      // **审核子会话不许自己再取一次数**。这条 Tool 是 Host 在创建子代理**之前**用的交接点；
      // 子代理手里已经有本轮输入快照。它的 `caseDir` 虽然被钉死在本轮案例目录，但 `objectId`
      // 仍是提交进来的 —— 不拦的话，子代理可以用**别的** objectId 把别人的记录取进自己的案例目录
      //（与 `crwu_h3yun_record_get` 同一条越界读，2026-09-29 自审发现）。
      // 判据用**身份**（`isAuditChild`）：Host 调用时传的是审核根 Agent，不是任何记录里的 childId。
      if (isAuditChild(deps.state, callerIdentity(exec).childId, await callerParentSessionId(ctx, deps.state, exec))) {
        return { ...failure('policy', '审核子会话不要再取数：本轮记录与附件清单已在输入快照里'), ...empty }
      }
      // 案例目录**由 Host 的约定算出来**（`<工作空间>/<流水号>`），而不是"落在这个工作空间里就行"。
      // 这条 Tool 在创建子代理**之前**由 Host 调用，落盘的是本轮输入快照 —— 只判包含关系时，
      // 一个传错（或被喂错）的 `caseDir` 会把快照写进**别的案例目录**（同一工作空间里到处都是案例）。
      // 与子会话的 `requireAuditScope` 同一条口径：**精确相等**，工作空间根与兄弟案例都不行。
      const caseCheck = await requireCaseDir(ctx, args.caseDir, { allowedRoot: allowedCaseRootOf(deps.state) })
      if (!caseCheck.ok) return { ...caseCheck, ...empty }
      const expectedCase = caseDirOf(deps.state.workspacePath || deps.state.caseRoot, seqNo)
      if (expectedCase === '') {
        return { ...failure('input', '缺少案例目录：请先选定工作空间'), ...empty }
      }
      const expectedCheck = await requireCaseDir(ctx, expectedCase, { allowedRoot: allowedCaseRootOf(deps.state) })
      if (!expectedCheck.ok) return { ...expectedCheck, ...empty }
      const [given, expected] = await Promise.all([
        resolveTarget(ctx, caseCheck.path), resolveTarget(ctx, expectedCheck.path),
      ])
      // `targetKey` 是不透明 ID：只允许等值比较（**不许**拿 `displayPath` 兜底 —— 那是给人看的）。
      if (text(given.targetKey) === '' || given.targetKey !== expected.targetKey) {
        return {
          ...failure('policy', '案例目录必须是本轮的 `<工作空间>/<流水号>`：不许用工作空间根、兄弟案例或子目录'),
          ...empty,
        }
      }

      // 同一 attemptId 且不要求刷新 → 直接复用上一份摘要，**不再取数**。
      const cached = attemptId === '' ? undefined : cache.get(attemptId)
      if (cached !== undefined && args.refresh !== true) {
        return { ok: true, errorKind: '' as const, error: '', ...cached, reused: true }
      }

      const platform = await deps.world.platform()
      const gap = await requireBundled(ctx, platform)
      if (gap !== null) return { ...gap, ...empty }

      // schemaCode 只来自 Host：已缓存就零成本，否则**只发现一次**（并发共享同一个 Promise）。
      const form = await deps.form.ensure()
      if (!form.ok) {
        const kind = form.error.startsWith('未在氚云定位到表单') ? 'not-found' as const : 'cli' as const
        return { ...failure(kind, form.error), ...empty }
      }
      const argvBase = ['crwu', 'h3yun'] as const
      const runOptions = {
        workdir: caseCheck.path,
        timeoutMs: 90_000,
        access: deps.access,
        source: 'audit-tool' as const,
        platform,
        stdoutMaxBytes: RECORDS_STDOUT_MAX,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      }

      // ① 记录：按**精确 objectId** 取一次。
      const recordRun = await runCrwu(ctx, [...argvBase, 'records', 'get', '--schema', form.code, '--id', objectId], runOptions)
      if (!recordRun.ok) return { ...failure(recordRun.error !== '' ? 'infrastructure' : 'cli', reasonOf(recordRun)), ...empty }
      const record = recordOf(recordRun.stdout)
      if (record === null) return { ...failure('cli', `records get 没有返回可解析的记录 JSON：${clampText(recordRun.stdout, 400)}`), ...empty }

      // ①.5 **返回记录的身份核对**（2026-09-29 用户复查的 P1）。
      //
      // `records get --id B` 之"取回了一条记录"不等于"取回的是 B"。此前不看返回记录的
      // `ObjectId` / `SeqNo`，于是公开 RPC 可以用 `seqNo=A, objectId=B` 把 **B 的记录与附件**
      // 写进 **A 的案例目录**，而且（协议 19 起）这套错配还会被 Host 登记成权威 scope。
      // 所以：**在请求附件与任何写盘之前**核对身份；缺字段或不一致一律 fail closed。
      const recordId = text(pick(record, ['ObjectId', 'objectId', 'Id', 'id']))
      const recordSeq = text(pick(record, ['SeqNo', 'seqNo']))
      if (recordId === '' || recordSeq === '') {
        return {
          ...failure('cli', `records get 返回的记录缺少 ObjectId / SeqNo（无法确认它就是要审的那一条）：${clampText(recordRun.stdout, 200)}`),
          ...empty,
        }
      }
      if (recordId !== objectId) {
        return { ...failure('input', '取回的记录不是请求的那一条（ObjectId 不一致）：已终止本次审核'), ...empty }
      }
      if (recordSeq !== seqNo) {
        return { ...failure('input', '取回的记录流水号与请求的不一致：已终止本次审核'), ...empty }
      }

      // ② 附件元数据：同一个 objectId，取一次。
      const filesRun = await runCrwu(ctx, [...argvBase, 'files', 'list', '--schema', form.code, '--id', objectId], runOptions)
      if (!filesRun.ok) return { ...failure(filesRun.error !== '' ? 'infrastructure' : 'cli', reasonOf(filesRun)), ...empty }
      const attachments = attachmentsOf(filesRun.stdout)
      if (attachments === null) return { ...failure('cli', `files list 没有返回附件数组：${clampText(filesRun.stdout, 400)}`), ...empty }

      // ③ 落盘：完整记录 + 附件清单 + 元数据（元数据只放 schemaCode 的**指纹**）。
      // 分隔符随案例目录风格走（Windows 上是 `\`）：这条路径既进提示词与 Tool 返回值，
      // 也是后续 `ctx.fs` / shell 的目标。
      const snapshotDir = joinLocalPath(caseCheck.path, SNAPSHOT_DIR)
      const made = await ensureDirectory(ctx, snapshotDir, { workdir: caseCheck.path, platform, ...(exec.signal === undefined ? {} : { signal: exec.signal }) })
      if (!made.ok) return { ...failure('infrastructure', `创建快照目录失败：${made.error}`), ...empty }

      const fetchedAt = new Date().toISOString()
      const digest = digestOf([canonicalJson(record), canonicalJson(attachments), objectId, seqNo])
      const summary: SnapshotSummary = {
        attemptId,
        objectId,
        seqNo,
        schemaCodeDigest: digestOnly(form.code),
        fetchedAt,
        digest,
        fieldCount: Object.keys(record).length,
        attachmentCount: attachments.length,
        attachmentIds: attachments.map((item) => item.fileId),
        snapshotDir,
        snapshotPath: joinLocalPath(snapshotDir, SNAPSHOT_RECORD_FILE),
        attachmentsPath: joinLocalPath(snapshotDir, SNAPSHOT_ATTACHMENTS_FILE),
        metadataPath: joinLocalPath(snapshotDir, SNAPSHOT_METADATA_FILE),
        routingFacts: routingFactsOf(record, seqNo, form.name),
        reused: false,
      }
      const metadata = {
        schema: 'crwu.audit-input-snapshot.v1',
        attemptId,
        objectId,
        seqNo,
        schemaCodeDigest: summary.schemaCodeDigest,
        formName: form.name,
        fetchedAt,
        digest,
        fieldCount: summary.fieldCount,
        attachmentCount: summary.attachmentCount,
        recordFile: summary.snapshotPath,
        attachmentsFile: summary.attachmentsPath,
      }
      const writes = [
        await writeJson(ctx, summary.snapshotPath, record),
        await writeJson(ctx, summary.attachmentsPath, {
          schema: 'crwu.audit-attachments.v1',
          objectId,
          seqNo,
          fetchedAt,
          count: attachments.length,
          files: attachments,
        }),
        await writeJson(ctx, summary.metadataPath, metadata),
      ]
      const failedWrite = writes.find((item) => !item.ok)
      if (failedWrite !== undefined) {
        return { ...failure('infrastructure', `写输入快照失败：${failedWrite.error}`), ...summary }
      }

      if (attemptId !== '') {
        cache.set(attemptId, summary)
        // 只保留最近若干次：这是进程内的去重缓存，不是历史归档。
        while (cache.size > CACHE_LIMIT) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
      }
      return { ok: true, errorKind: '' as const, error: '', ...summary }
    },
  })

  return [bootstrap]
}

/** 审核工具专用的严格 crwu 定位：缺包内二进制就回 capability gap，绝不回退裸名字。 */
async function requireBundled(ctx: Context, platform: string): Promise<ToolFailure | null> {
  const resolved = await requireBundledCommand(ctx, platform, 'crwu')
  return resolved.ok ? null : failure(resolved.errorKind, resolved.error)
}
