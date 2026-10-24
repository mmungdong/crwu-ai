import type { TemplateMarketNodeId } from '../../../../shared/contracts/valuation-template-market.ts'
/**
 * Closed input parsing for the advanced valuation-workflow panel operations.
 *
 * The panel may only name a business intent: a compiled graph node id, a version,
 * a submission id and field changes, or one artifact kind. This module never sees a
 * path, command, prompt or credential; it rejects an out-of-shape payload before the
 * runtime queue or any filesystem call is reached, and it maps a real compiled node id
 * to the business stage that owns it instead of trusting a suffix.
 */
import type { LocalAccessBroker } from '../../../core/access/broker.ts'
import { openExternalCommand } from '../../../core/platform/shell.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { text } from '../../../../shared/utils/value.ts'
import { planFilePath } from '../../../domains/report-evaluation/delivery/finalize-facts.ts'
import type { ValuationWorkflowRunDTO } from '../../../domains/report-evaluation/workflow/persistence.ts'
import type {
  ValuationWorkflowGraphView,
  ValuationWorkflowStage,
} from '../../../../shared/contracts/valuation-workflow.ts'
import type { WorkflowCalculationReceipt } from './types.ts'
import { isQuestionAnswerShape } from '../../../../shared/contracts/valuation-question-answer.ts'
import type { ValuationQuestionEdit, ValuationQuestionSubmit } from '../../../../shared/contracts/valuation-questionnaire.ts'

export type WorkflowActionKind = 'answer' | 'revise' | 'approve-plan' | 'questions-draft' | 'questions-submit'

export interface ParsedWorkflowAction {
  ok: boolean
  error: string
  action: WorkflowActionKind | ''
  /** Closed payload handed to the runtime; never the raw args. */
  payload: Record<string, unknown> | null
  /** Business stage a revise node maps to; empty for every other action. */
  stage: ValuationWorkflowStage | TemplateMarketNodeId | 'intent' | ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key))
}

function validRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Shared closed transport shape; domain validation still owns question semantics. */
export function parseQuestionEdit(value: unknown, submit: boolean): ValuationQuestionEdit | ValuationQuestionSubmit | null {
  if (!isRecord(value)) return null
  const keys = ['nodeId', 'expectedRevision', 'expectedQuestionVersion', 'answers', 'supplement', 'noteEdits']
  if (submit) keys.push('submissionId')
  if (!hasExactKeys(value, keys)) return null
  const bounded = (input: unknown, max: number): input is string => typeof input === 'string' && input.length <= max
  const identifier = (input: unknown): input is string => bounded(input, 512) && input.trim() !== ''
    && !['__proto__', 'prototype', 'constructor'].includes(input)
  if (!identifier(value.nodeId) || validRevision(value.expectedRevision) === null
    || validRevision(value.expectedQuestionVersion) === null || !bounded(value.supplement, 20_000)
    || !isRecord(value.answers) || Object.keys(value.answers).length > 10000
    || !isRecord(value.noteEdits) || Object.keys(value.noteEdits).length > 10000) return null
  if (submit && !identifier(value.submissionId)) return null
  for (const [id, answer] of Object.entries(value.answers)) {
    if (!identifier(id) || !isQuestionAnswerShape(answer)) return null
  }
  if (!Object.entries(value.noteEdits).every(([id, note]) => identifier(id) && bounded(note, 20_000))) return null
  return JSON.parse(JSON.stringify(value)) as ValuationQuestionEdit | ValuationQuestionSubmit
}

export interface NodeStageResolution {
  ok: boolean
  error: string
  stage: ValuationWorkflowStage | TemplateMarketNodeId | ''
  /** A real compiled node that owns no business stage (router/sentinel) is read-only. */
  readonly: boolean
}

/**
 * Map one exact compiled graph node id to the business stage it owns.
 *
 * Only the actual descriptor decides: a node that is absent is refused (a foreign
 * `x:rights` suffix is not a node), and a present node without a stage is read-only.
 */
export function stageOfCompiledNode(
  graph: ValuationWorkflowGraphView | null,
  nodeId: string,
): NodeStageResolution {
  const id = text(nodeId)
  if (id === '') return { ok: false, error: '缺少要修订的节点标识', stage: '', readonly: false }
  if (graph === null) return { ok: false, error: '实际编译的估值图不可读', stage: '', readonly: false }
  const node = graph.nodes.find((candidate) => candidate.nodeId === id)
  if (node === undefined) return { ok: false, error: '节点不在实际编译的估值图里', stage: '', readonly: false }
  const stage = node.templateMarketNodeId ?? node.stage
  if (stage === undefined) return { ok: false, error: '该节点只读，不能作为修订起点', stage: '', readonly: true }
  return { ok: true, error: '', stage, readonly: false }
}

/** The actual compiled node id that owns one stage; `''` when the descriptor lost it. */
export function compiledNodeIdOfStage(
  graph: ValuationWorkflowGraphView | null,
  stage: ValuationWorkflowStage | TemplateMarketNodeId,
): string {
  if (graph === null) return ''
  return graph.nodes.find((candidate) => candidate.templateMarketNodeId === stage || candidate.stage === stage)?.nodeId ?? ''
}

/**
 * Parse one queued decision from the raw panel args.
 *
 * The returned payload has exactly the keys the runtime queue accepts, with the
 * revise node already mapped to its business stage.
 */
export function parseWorkflowAction(
  args: Record<string, unknown>,
  graph: ValuationWorkflowGraphView | null,
): ParsedWorkflowAction {
  const fail = (error: string): ParsedWorkflowAction => ({ ok: false, error, action: '', payload: null, stage: '' })
  const action = text(args.action)
  if (action !== 'answer' && action !== 'revise' && action !== 'approve-plan'
    && action !== 'questions-draft' && action !== 'questions-submit') {
    return fail('不支持的命令动作')
  }
  const payload = args.payload
  if (!isRecord(payload)) return fail('命令参数必须是对象')
  if (action === 'questions-draft' || action === 'questions-submit') {
    const edit = parseQuestionEdit(payload, action === 'questions-submit')
    if (edit === null) return fail('问卷只接受节点、图版本、问卷版本、回答、补充说明与备注修改')
    const node = graph?.nodes.find((candidate) => candidate.nodeId === edit.nodeId)
    if (node === undefined) return fail('节点不在实际编译的估值图里')
    const stage = node.templateMarketNodeId ?? node.stage ?? (node.nodeId === 'valuation:intent-router' ? 'intent' : '')
    if (stage === '') return fail('该节点不能保存或提交问卷')
    return { ok: true, error: '', action, stage, payload: { ...edit, nodeId: stage } }
  }
  if (action === 'answer') {
    if (!hasExactKeys(payload, ['clarificationId', 'submissionId', 'expectedRevision', 'answers'])) {
      return fail('回答命令只接受待决事项、提交标识、版本与回答')
    }
    const answers = payload.answers
    if (!isRecord(answers) || !Object.values(answers).every((value) => typeof value === 'string')) {
      return fail('回答必须是以字段名为键的文本值')
    }
    const expectedRevision = validRevision(payload.expectedRevision)
    if (expectedRevision === null) return fail('命令必须携带有效版本')
    const clarificationId = text(payload.clarificationId)
    const submissionId = text(payload.submissionId)
    if (clarificationId === '' || submissionId === '') return fail('回答命令缺少待决事项或提交标识')
    return {
      ok: true,
      error: '',
      action,
      stage: '',
      payload: { clarificationId, submissionId, expectedRevision, answers: { ...(answers as Record<string, string>) } },
    }
  }
  if (action === 'approve-plan') {
    if (!hasExactKeys(payload, ['expectedRevision', 'planDigest', 'submissionId'])) {
      return fail('方案确认命令只接受版本、方案摘要与提交标识')
    }
    const expectedRevision = validRevision(payload.expectedRevision)
    if (expectedRevision === null) return fail('命令必须携带有效版本')
    const planDigest = text(payload.planDigest)
    const submissionId = text(payload.submissionId)
    if (planDigest === '' || submissionId === '') return fail('方案确认命令缺少方案摘要或提交标识')
    return {
      ok: true,
      error: '',
      action,
      stage: '',
      payload: { expectedRevision, planDigest, submissionId },
    }
  }
  if (!hasExactKeys(payload, ['nodeId', 'submissionId', 'expectedRevision', 'reason', 'source', 'changes'])) {
    return fail('修订命令只接受节点、提交标识、版本、理由、来源与变更')
  }
  const resolved = stageOfCompiledNode(graph, text(payload.nodeId))
  if (!resolved.ok) return fail(resolved.error)
  const expectedRevision = validRevision(payload.expectedRevision)
  if (expectedRevision === null) return fail('命令必须携带有效版本')
  const submissionId = text(payload.submissionId)
  const reason = text(payload.reason)
  const source = text(payload.source)
  if (submissionId === '' || reason === '' || source === '') {
    return fail('修订命令缺少提交标识、理由或来源')
  }
  if (!Array.isArray(payload.changes) || (payload.changes.length === 0
    && !graph?.nodes.some(node => node.nodeId === text(payload.nodeId) && node.templateMarketNodeId !== undefined))) {
    return fail('修订必须给出变更清单')
  }
  const changes: Array<{ field: string; value: unknown }> = []
  for (const change of payload.changes) {
    if (!isRecord(change) || !hasExactKeys(change, ['field', 'value'])) {
      return fail('修订字段无效')
    }
    const field = text(change.field)
    if (field === '') return fail('修订字段无效')
    changes.push({ field, value: change.value })
  }
  return {
    ok: true,
    error: '',
    action,
    stage: resolved.stage,
    payload: { nodeId: resolved.stage, submissionId, expectedRevision, reason, source, changes },
  }
}

export interface ParsedWorkflowPreview {
  ok: boolean
  error: string
  nodeId: string
  stage: ValuationWorkflowStage | TemplateMarketNodeId | ''
  expectedRevision: number
  changes: Array<{ field: string; value: unknown }>
}

/** Parse a revision preview: node id, version and the exact proposed field changes. */
export function parseWorkflowPreview(
  args: Record<string, unknown>,
  graph: ValuationWorkflowGraphView | null,
): ParsedWorkflowPreview {
  const failed = (error: string): ParsedWorkflowPreview => ({
    ok: false, error, nodeId: '', stage: '', expectedRevision: -1, changes: [],
  })
  if (!hasExactKeys(args as Record<string, unknown>, ['projectId', 'nodeId', 'expectedRevision', 'changes'])
    && !hasExactKeys(args as Record<string, unknown>, ['nodeId', 'expectedRevision', 'changes'])) {
    return failed('预览只接受节点、版本与变更清单')
  }
  const nodeId = text(args.nodeId)
  const resolved = stageOfCompiledNode(graph, nodeId)
  if (!resolved.ok) return failed(resolved.error)
  const expectedRevision = validRevision(args.expectedRevision)
  if (expectedRevision === null) return failed('预览必须基于有效版本')
  if (!Array.isArray(args.changes) || args.changes.length === 0) return failed('预览没有要更改的字段')
  const changes: Array<{ field: string; value: unknown }> = []
  for (const change of args.changes) {
    if (!isRecord(change) || !hasExactKeys(change, ['field', 'value'])) return failed('预览字段无效')
    const field = text(change.field)
    if (field === '') return failed('预览字段无效')
    changes.push({ field, value: change.value })
  }
  return { ok: true, error: '', nodeId, stage: resolved.stage, expectedRevision, changes }
}

export type WorkflowArtifactKind = 'template' | 'workbook' | 'report' | 'trace' | 'data' | 'candidates' | 'workpaper'

export const WORKFLOW_ARTIFACT_KINDS: readonly WorkflowArtifactKind[] = [
  'template', 'workbook', 'report', 'trace', 'data', 'candidates', 'workpaper',
]

/** Explicit path-like keys a panel may not use; only the closed kind is accepted. */
const PATH_KEYS = ['path', 'relativePath', 'absolutePath', 'file', 'target', 'filename'] as const

export interface ParsedArtifactRequest {
  ok: boolean
  kind: WorkflowArtifactKind | ''
  error: string
}

/** Accept only the closed artifact kind; any path-like argument is refused outright. */
export function parseArtifactRequest(args: Record<string, unknown>): ParsedArtifactRequest {
  for (const key of PATH_KEYS) {
    if (Object.hasOwn(args, key)) return { ok: false, kind: '', error: '只接受文件类别，不接受路径' }
  }
  const kind = text(args.kind)
  if (kind === '') return { ok: false, kind: '', error: '缺少要打开的文件类别' }
  if (!(WORKFLOW_ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, kind: '', error: '不支持的文件类别' }
  }
  return { ok: true, kind: kind as WorkflowArtifactKind, error: '' }
}

/** Closed legacy filename aliases for the four real calculated deliverables. */
const CALCULATED_ALIASES: Record<'workbook' | 'report' | 'trace' | 'data', readonly string[]> = {
  workbook: ['估值底稿.xlsx', '估值底稿.xls'],
  report: ['估值报告.html', '估值报告.htm'],
  trace: ['计算轨迹.json'],
  data: ['估值报告数据.json'],
}

const CALCULATED_LABELS: Record<'workbook' | 'report' | 'trace' | 'data', string> = {
  workbook: '估值底稿',
  report: '估值报告',
  trace: '计算轨迹',
  data: '估值报告数据',
}

export interface ResolvedWorkflowArtifact {
  kind: WorkflowArtifactKind
  label: string
  relativePath: string
  digest: string
  sizeBytes?: number
  /** A controlled reference run discloses that the template is not a formal conclusion. */
  referenceMode: boolean
}

export interface ResolveArtifactInput {
  kind: WorkflowArtifactKind
  dto: ValuationWorkflowRunDTO | null
  receipt: WorkflowCalculationReceipt | null
}

function normalizeDigest(value: unknown): string {
  const raw = text(value).trim().toLowerCase()
  if (raw === '') return ''
  return raw.startsWith('sha256:') ? raw : `sha256:${raw}`
}

function baseName(relativePath: string): string {
  const parts = text(relativePath).replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? ''
}

/**
 * Resolve one artifact to the exact case-relative path the Host already recorded.
 *
 * A template comes from the current real plan receipt; a calculated output only from
 * the verified calculation receipt. A missing file is reported as absent: no filename
 * is inferred and no "latest review revision" is substituted.
 */
export function resolveWorkflowArtifact(
  input: ResolveArtifactInput,
): { ok: boolean; artifact: ResolvedWorkflowArtifact | null; error: string } {
  const market = input.dto?.templateMarket
  if (market) {
    const template = input.kind === 'template' ? market.plan?.template : null
    const file = market.artifacts.find(a => a.kind === input.kind || (input.kind === 'workbook' && a.kind === 'workpaper'))
    const relativePath = template?.relativePath ?? file?.relativePath
    const digest = template?.digest ?? file?.digest
    if (!relativePath || !digest) return { ok: false, artifact: null, error: '本轮尚未生成或登记这个文件' }
    const labels: Partial<Record<WorkflowArtifactKind, string>> = { template: '计算表模板', candidates: '候选案例表', workpaper: '原模板回填底稿', workbook: '原模板回填底稿', trace: '逐字段填表轨迹' }
    return { ok: true, error: '', artifact: { kind: input.kind, label: labels[input.kind] ?? input.kind, relativePath, digest,
      ...(file ? { sizeBytes: file.bytes } : {}), referenceMode: true } }
  }
  if (input.kind === 'candidates' || input.kind === 'workpaper') return { ok: false, artifact: null, error: '旧版运行没有这类已登记成果' }
  if (input.kind === 'template') {
    const template = input.dto?.plan?.template
    if (template === null || template === undefined) {
      return { ok: false, artifact: null, error: '当前版本没有已登记的方案模板' }
    }
    const relativePath = text(template.relativePath)
    const digest = normalizeDigest(template.digest)
    if (relativePath === '' || digest === '') {
      return { ok: false, artifact: null, error: '方案模板缺少可打开的路径或摘要' }
    }
    return {
      ok: true,
      error: '',
      artifact: {
        kind: 'template',
        label: '方案模板',
        relativePath,
        digest,
        referenceMode: input.dto?.plan?.valuationMode === 'listing-reference',
      },
    }
  }
  const receipt = input.receipt
  if (receipt === null || receipt === undefined) {
    return { ok: false, artifact: null, error: '本轮还没有已校验的计算产物' }
  }
  const aliases = CALCULATED_ALIASES[input.kind]
  const artifact = (receipt.artifacts ?? []).find((candidate) => aliases.includes(text(candidate.name))
    || aliases.includes(baseName(candidate.relativePath)))
  if (artifact === undefined) {
    return { ok: false, artifact: null, error: '这一轮的计算产物里没有这个文件' }
  }
  const relativePath = text(artifact.relativePath)
    || planFilePath(receipt.planId, text(artifact.name), receipt.revision)
  const digest = normalizeDigest(artifact.digest)
  if (relativePath === '' || digest === '') {
    return { ok: false, artifact: null, error: '计算产物缺少可打开的路径或摘要' }
  }
  const sizeBytes = typeof artifact.bytes === 'number' && Number.isFinite(artifact.bytes)
    ? artifact.bytes
    : undefined
  return {
    ok: true,
    error: '',
    artifact: {
      kind: input.kind,
      label: CALCULATED_LABELS[input.kind],
      relativePath,
      digest,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      referenceMode: false,
    },
  }
}

/**
 * Open one Host-derived case file with the system default program.
 *
 * The path is derived from the verified case root, and the broker records the exact
 * `system.case-file.open` call. Raw shell output never reaches the panel.
 */
export async function openCaseFile(input: {
  access: LocalAccessBroker
  platform: string
  workdir: string
  casePath: string
  relativePath: string
}): Promise<{ ok: boolean; error: string }> {
  const absolute = joinLocalPath(input.casePath, input.relativePath)
  try {
    const run = await input.access.runShell(
      { operation: 'system.case-file.open', source: 'panel', workdir: input.workdir },
      openExternalCommand(absolute, input.platform),
      { timeoutMs: 30_000, summary: 'system.case-file.open' },
    )
    return { ok: run.ok, error: run.ok ? '' : '打开文件失败：系统打开命令未成功' }
  } catch {
    return { ok: false, error: '打开文件失败' }
  }
}
