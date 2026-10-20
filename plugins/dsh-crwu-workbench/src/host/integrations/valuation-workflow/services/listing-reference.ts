/**
 * Reusable authorized listing-reference build + semantic-validation service.
 *
 * This is the real business I/O behind `crwu_valuation_listing_reference`: it reads
 * the Host-registered fixed plan input, stages the packaged Python assets, runs the
 * builder through the Broker on the configured DSH Python, and verifies the four real
 * outputs. The read-only validator invokes the same builder's `--validate` mode,
 * which re-reads the trace/report/workbook/link semantics instead of trusting stdout
 * or file non-emptiness. The same staged builder also prepares the genuine blank
 * workbook (`--prepare-template`) for the pre-input planning phase.
 */
import { text } from '../../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import type {
  ValuationWorkflowPlanFormulaCheck,
  ValuationWorkflowPlanMapping,
  ValuationWorkflowPlanTemplate,
} from '../../../../shared/contracts/valuation-workflow.ts'
import { fileSystem, isFile, readTextIfExists } from '../../../core/fs/paths.ts'
import { fileSize } from '../../../tools/common/case-dir.ts'
import { ensureDirectory } from '../../../tools/common/case-files.ts'
import { shellInvoke } from '../../../core/platform/shell.ts'
import { classifyRun, failure, jsonObject } from '../../../tools/common/outcome.ts'
import { stagedValuationAsset, stagedValuationScript } from '../../../tools/report-evaluation/artifacts.ts'
import { planFilePath } from '../../../domains/report-evaluation/delivery/finalize-facts.ts'
import { PYTHON_RUNTIME_SOURCE } from '../../../core/runtime/python.ts'
import { LISTING_REFERENCE_ARTIFACTS } from '../../../domains/report-evaluation/assets/realestate/listing-reference.ts'
import { knowledgeDigest } from '../../../domains/report-evaluation/knowledge/snapshot.ts'
import { verifyTemplateWorkbook } from '../../../domains/report-evaluation/knowledge/template-bytes.ts'
import { requireBoundValuationActor, type ValuationServicePrincipal } from './access.ts'
import type { HostWorkflowServiceDeps } from './deps.ts'
import type { ValuationServiceErrorKind } from './errors.ts'

export interface ListingReferenceFile {
  name: string
  exists: boolean
  bytes: number
}

export interface ListingReferenceResult {
  ok: boolean
  errorKind: string
  error: string
  status: string
  caseDir: string
  planId: string
  revision: number
  reused: boolean
  outputs: string[]
  files: ListingReferenceFile[]
  python: { path: string; versionText: string; source: string }
}

export interface ListingReferenceValidationResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  planId: string
  revision: number
  status: string
  outputs: string[]
  checks: Array<{ name: string; ok: boolean; detail: string }>
  python: { path: string; versionText: string; source: string }
}

export interface ListingReferenceServiceInput {
  planId?: unknown
  revision?: unknown
  caseDir?: unknown
}

const INPUT_FILE = '挂牌参考输入.json'
const OUTPUTS = LISTING_REFERENCE_ARTIFACTS
const SCRIPTS = [
  'scripts/build_listing_reference.py',
  'scripts/calculate_market.py',
  'scripts/build_report_data.py',
  'scripts/build_report.py',
  'scripts/evidence_index.py',
] as const
const ASSETS = [
  'schemas/valuation-report-data.schema.json',
  'template/valuation-report.html',
] as const
const RUN_TIMEOUT_MS = 15 * 60_000

export function idleListingReferenceResult(): ListingReferenceResult {
  return {
    ok: false, errorKind: '', error: '', status: '',
    caseDir: '', planId: '', revision: 0, reused: false,
    outputs: [], files: [],
    python: { path: '', versionText: '', source: PYTHON_RUNTIME_SOURCE },
  }
}

function idleValidationResult(): ListingReferenceValidationResult {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', planId: '', revision: 0, status: '',
    outputs: [], checks: [],
    python: { path: '', versionText: '', source: PYTHON_RUNTIME_SOURCE },
  }
}

function revisionOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0
}

interface PlanPaths {
  dirRelative: string
  baseRelative: string
  targetDir: string
  baseDir: string
}

function planPathsOf(planId: string, revision: number, casePath: string): PlanPaths | null {
  const dirRelative = planFilePath(planId, '', revision)
  const baseRelative = planFilePath(planId, '', 0)
  if (dirRelative === '' || baseRelative === '') return null
  return {
    dirRelative,
    baseRelative,
    targetDir: joinLocalPath(casePath, dirRelative),
    baseDir: joinLocalPath(casePath, baseRelative),
  }
}

interface StagedRuntime {
  ok: boolean
  errorKind: ValuationServiceErrorKind
  error: string
  scriptPath: string
}

/** Stage the packaged builder scripts/assets case-locally; never touches deliverables. */
async function stageRuntime(
  deps: HostWorkflowServiceDeps,
  actor: ReturnType<typeof requireBoundValuationActor>['actor'],
  casePath: string,
  platform: string,
): Promise<StagedRuntime> {
  const session = actor.session
  const signal = actor.signal
  const scopeOptions = {
    workdir: casePath, platform,
    ...(session === undefined ? {} : { session }),
    ...(signal === undefined ? {} : { signal }),
  }
  for (const dir of ['scripts', 'schemas', 'template']) {
    const made = await ensureDirectory(deps.access, joinLocalPath(casePath, dir), scopeOptions)
    if (made.errorKind !== '' || made.postcondition !== 'directory') {
      return { ok: false, errorKind: 'infrastructure', error: `无法准备案例子目录 ${dir}：${made.error || made.postcondition}`, scriptPath: '' }
    }
  }
  const stageInput = {
    ctx: deps.ctx, casePath,
    ...(session === undefined ? {} : { session }),
    ...(signal === undefined ? {} : { signal }),
  }
  let scriptPath = ''
  for (const relative of SCRIPTS) {
    const staged = await stagedValuationScript({ ...stageInput, relative })
    if (!staged.ok) return { ok: false, errorKind: 'infrastructure', error: staged.error, scriptPath: '' }
    if (relative === SCRIPTS[0]) scriptPath = staged.scriptPath
  }
  for (const relative of ASSETS) {
    const staged = await stagedValuationAsset({ ...stageInput, relative })
    if (!staged.ok) return { ok: false, errorKind: 'infrastructure', error: staged.error, scriptPath: '' }
  }
  return { ok: true, errorKind: '', error: '', scriptPath }
}

interface BoundListing {
  ok: boolean
  errorKind: ValuationServiceErrorKind
  error: string
  base: ListingReferenceResult
  actor: ReturnType<typeof requireBoundValuationActor>['actor']
  planId: string
  revision: number
  paths: PlanPaths | null
}

interface ListingPython {
  ok: boolean
  errorKind: ValuationServiceErrorKind
  error: string
  python: { path: string; versionText: string; source: string }
}

/**
 * Resolve the configured DSH Python before any staging write. Kept after the fixed
 * input verification for the build path, preserving the Tool's original order.
 */
async function resolveListingPython(
  deps: HostWorkflowServiceDeps,
  actor: ReturnType<typeof requireBoundValuationActor>['actor'],
): Promise<ListingPython> {
  const base = idleListingReferenceResult().python
  const pythonResolver = deps.python
  if (pythonResolver === undefined) {
    return {
      ok: false, errorKind: 'capability-gap',
      error: 'DSH 自带 Python 解析器没有装配：请在部署配置里指定可用的 Python 解释器后重试',
      python: base,
    }
  }
  const runtime = await pythonResolver.check({ agent: actor.agent })
  const python = { path: runtime.path, versionText: runtime.versionText, source: runtime.source }
  if (!runtime.ok) {
    return {
      ok: false, errorKind: 'capability-gap',
      error: `DSH 自带 Python 运行时不可用（状态：${text(runtime.state) || 'failed'}）：请在部署配置里指定可用的 Python 解释器后重试`,
      python,
    }
  }
  return { ok: true, errorKind: '', error: '', python }
}

async function bindListing(
  input: ListingReferenceServiceInput,
  deps: HostWorkflowServiceDeps,
  principal: ValuationServicePrincipal,
): Promise<BoundListing> {
  const base = idleListingReferenceResult()
  const planId = text(input.planId).trim()
  if (planId === '') {
    return {
      ok: false, errorKind: 'input', error: '缺少 planId：挂牌参考交付必须针对具体方案。',
      base, actor: requireBoundValuationActor(principal, { valuationScopes: deps.valuationScopes }).actor,
      planId, revision: 0, paths: null,
    }
  }
  const bound = requireBoundValuationActor(principal, { valuationScopes: deps.valuationScopes })
  if (!bound.ok) {
    return { ok: false, errorKind: bound.errorKind, error: bound.error, base, actor: bound.actor, planId, revision: 0, paths: null }
  }
  const actor = bound.actor
  const casePath = actor.caseDir
  const scopes = deps.valuationScopes
  if (scopes === undefined || !scopes.planOf(actor.sessionId, planId)) {
    return {
      ok: false, errorKind: 'policy', error: `方案 ${planId} 不在本轮登记范围：拒绝交付`,
      base, actor, planId, revision: 0, paths: null,
    }
  }
  const revision = revisionOf(input.revision)
  const paths = planPathsOf(planId, revision, casePath)
  if (paths === null) {
    return {
      ok: false, errorKind: 'input', error: `planId 不是单段安全标识：「${planId}」`,
      base, actor, planId, revision, paths: null,
    }
  }
  return { ok: true, errorKind: '', error: '', base, actor, planId, revision, paths }
}

interface FixedInputIdentity {
  ok: boolean
  errorKind: ValuationServiceErrorKind
  error: string
  payload: Record<string, unknown> | null
}

/**
 * Read and verify the Host-registered fixed input identity.
 *
 * Shared by the builder and the read-only validator so both reject a missing,
 * malformed, wrong-mode, wrong-project or wrong-plan input **before** Python or
 * staging. This is the only permitted read before those steps.
 */
async function readFixedInputIdentity(
  deps: HostWorkflowServiceDeps,
  actor: ReturnType<typeof requireBoundValuationActor>['actor'],
  targetDir: string,
  dirRelative: string,
  planId: string,
): Promise<FixedInputIdentity> {
  const inputPath = joinLocalPath(targetDir, INPUT_FILE)
  const raw = await readTextIfExists(deps.ctx, inputPath)
  if (raw.trim() === '') {
    return {
      ok: false, errorKind: 'input', payload: null,
      error: `缺少固定输入 ${joinLocalPath(dirRelative, INPUT_FILE)}：挂牌参考交付不接受调用方给的任意路径`,
    }
  }
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('top-level is not an object')
    payload = parsed as Record<string, unknown>
  } catch {
    return {
      ok: false, errorKind: 'input', payload: null,
      error: `固定输入不是合法 JSON 对象：请检查「${INPUT_FILE}」的语法后重试`,
    }
  }
  if (text(payload.valuationMode) !== 'listing-reference') {
    return { ok: false, errorKind: 'input', payload, error: '固定输入的 valuationMode 必须是 listing-reference' }
  }
  if (text(payload.projectId) !== actor.projectId) {
    return { ok: false, errorKind: 'input', payload, error: '固定输入的 projectId 与本轮估值归属不一致：拒绝交付' }
  }
  if (text(payload.planId) !== planId) {
    return { ok: false, errorKind: 'input', payload, error: '固定输入的 planId 与请求方案不一致：拒绝交付' }
  }
  return { ok: true, errorKind: '', error: '', payload }
}

/**
 * Build the four reference artifacts through the real packaged builder.
 *
 * The fixed input path, script and output directory are Host-derived from the
 * registered plan; the caller cannot submit a path or command.
 */
export async function runListingReference(
  input: ListingReferenceServiceInput,
  deps: HostWorkflowServiceDeps,
  principal: ValuationServicePrincipal,
): Promise<ListingReferenceResult> {
  const bound = await bindListing(input, deps, principal)
  if (!bound.ok) {
    return { ...bound.base, caseDir: bound.actor.caseDir, planId: bound.planId, revision: bound.revision, ...failure(bound.errorKind, bound.error) }
  }
  const { actor, planId, revision, paths } = bound
  const base = bound.base
  const casePath = actor.caseDir
  const targetDir = paths?.targetDir ?? ''
  const baseDir = paths?.baseDir ?? ''

  const inputPath = joinLocalPath(targetDir, INPUT_FILE)
  const fixed = await readFixedInputIdentity(deps, actor, targetDir, paths?.dirRelative ?? '', planId)
  if (!fixed.ok) {
    return { ...base, caseDir: casePath, planId, revision, ...failure(fixed.errorKind, fixed.error) }
  }

  // Resolve Python only after the fixed input is verified (preserves Tool ordering).
  const pythonResolved = await resolveListingPython(deps, actor)
  if (!pythonResolved.ok) {
    return {
      ...base, caseDir: casePath, planId, revision, python: pythonResolved.python,
      ...failure(pythonResolved.errorKind, pythonResolved.error),
    }
  }
  const python = pythonResolved.python

  const platform = await deps.world.platform()
  const staged = await stageRuntime(deps, actor, casePath, platform)
  if (!staged.ok) return { ...base, caseDir: casePath, planId, revision, python, ...failure(staged.errorKind, staged.error) }

  const session = actor.session
  const signal = actor.signal
  const scopeOptions = {
    workdir: casePath, platform,
    ...(session === undefined ? {} : { session }),
    ...(signal === undefined ? {} : { signal }),
  }
  const argv = [staged.scriptPath, '--input', inputPath, '--out-dir', targetDir, '--case-root', baseDir]
  const run = await deps.access.runShell(
    { operation: 'python.script.run', source: 'audit-tool', workdir: casePath },
    shellInvoke(python.path, argv, platform),
    { ...scopeOptions, timeoutMs: RUN_TIMEOUT_MS, summary: 'valuation listing reference' },
  )
  const runKind = classifyRun(run)
  if (runKind !== '' || run.ok !== true) {
    const kind = runKind === '' ? 'infrastructure' : runKind
    return {
      ...base, caseDir: casePath, planId, revision, python,
      ...failure(kind, `挂牌参考交付脚本没有成功执行（分类：${kind}，退出码：${String(run.exitCode ?? 'unknown')}）：请检查案例目录与 DSH Python 配置后重试`),
    }
  }
  const scriptStdout = jsonObject(run.stdout)
  const reused = scriptStdout?.reused === true

  const files: ListingReferenceFile[] = []
  const missing: string[] = []
  for (const name of OUTPUTS) {
    const path = joinLocalPath(targetDir, name)
    const exists = await isFile(deps.ctx, path)
    const bytes = exists ? await fileSize(deps.ctx, path) : 0
    files.push({ name, exists, bytes })
    if (!exists || bytes <= 0) missing.push(name)
  }
  if (missing.length > 0) {
    return {
      ...base, caseDir: casePath, planId, revision, python, files,
      ...failure('infrastructure', `缺少产物：${missing.join('、')}`),
    }
  }

  return {
    ok: true, errorKind: '', error: '', status: 'partial',
    caseDir: casePath, planId, revision, reused,
    outputs: [...OUTPUTS], files, python,
  }
}

/**
 * Read-only semantic validation of an already-delivered plan.
 *
 * Invokes the builder's `--validate` mode, which re-reads the workbooks/report/trace
 * and fails on a semantic mismatch. Success requires the script to exit 0 **and**
 * report its structured success; file existence alone is never accepted.
 */
export async function validateListingReferenceArtifacts(
  input: ListingReferenceServiceInput,
  deps: HostWorkflowServiceDeps,
  principal: ValuationServicePrincipal,
): Promise<ListingReferenceValidationResult> {
  const base = idleValidationResult()
  const bound = await bindListing(input, deps, principal)
  if (!bound.ok) {
    return { ...base, caseDir: bound.actor.caseDir, planId: bound.planId, revision: bound.revision, ...failure(bound.errorKind, bound.error) }
  }
  const { actor, planId, revision, paths } = bound
  const casePath = actor.caseDir
  const targetDir = paths?.targetDir ?? ''
  const baseDir = paths?.baseDir ?? ''
  // Reject a missing/malformed/wrong-identity fixed input before Python or staging,
  // using the exact same parser as the builder (no second interpretation).
  const fixed = await readFixedInputIdentity(deps, actor, targetDir, paths?.dirRelative ?? '', planId)
  if (!fixed.ok) {
    return { ...base, caseDir: casePath, planId, revision, ...failure(fixed.errorKind, fixed.error) }
  }
  const pythonResolved = await resolveListingPython(deps, actor)
  if (!pythonResolved.ok) {
    return {
      ...base, caseDir: casePath, planId, revision, python: pythonResolved.python,
      ...failure(pythonResolved.errorKind, pythonResolved.error),
    }
  }
  const python = pythonResolved.python
  const platform = await deps.world.platform()
  const staged = await stageRuntime(deps, actor, casePath, platform)
  if (!staged.ok) {
    return { ...base, caseDir: casePath, planId, revision, python, ...failure(staged.errorKind, staged.error) }
  }
  const session = actor.session
  const signal = actor.signal
  const scopeOptions = {
    workdir: casePath, platform,
    ...(session === undefined ? {} : { session }),
    ...(signal === undefined ? {} : { signal }),
  }
  const argv = [staged.scriptPath, '--validate', '--out-dir', targetDir, '--case-root', baseDir]
  const run = await deps.access.runShell(
    { operation: 'python.script.run', source: 'audit-tool', workdir: casePath },
    shellInvoke(python.path, argv, platform),
    { ...scopeOptions, timeoutMs: RUN_TIMEOUT_MS, summary: 'valuation listing reference validate' },
  )
  const runKind = classifyRun(run)
  const scriptStdout = jsonObject(run.stdout)
  const semanticOk = run.ok === true && runKind === '' && scriptStdout?.ok === true
  const checks = [{
    name: 'builder-semantic-validation',
    ok: semanticOk,
    detail: semanticOk ? 'builder validate passed' : 'builder validate failed or returned no structured success',
  }]
  if (!semanticOk) {
    return {
      ...base, caseDir: casePath, planId, revision, python, checks,
      ...failure(
        runKind === '' ? 'infrastructure' : runKind,
        '挂牌参考语义校验未通过：计算轨迹、报告数据、工作簿与来源链接未通过只读复核，请修复后重试',
      ),
    }
  }
  return {
    ok: true, errorKind: '', error: '', caseDir: casePath, planId, revision, status: 'partial',
    outputs: [...OUTPUTS], checks, python,
  }
}

export interface ListingReferenceTemplateServiceInput {
  planId?: unknown
}

export interface ListingReferenceTemplateResult {
  ok: boolean
  errorKind: string
  error: string
  template?: ValuationWorkflowPlanTemplate
  python?: { path: string; versionText: string; source: string }
}

const TEMPLATE_MAX_BYTES = 8 * 1024 * 1024
const TEMPLATE_DIGEST = /^sha256:[0-9a-f]{64}$/

/** Posix relative XLSX path with no traversal, drive letter, or empty segment. */
function safePreparedRelative(value: string): boolean {
  if (value === '') return false
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false
  return /\.xlsx$/i.test(segments[segments.length - 1] ?? '')
}

/** Keep only a complete mapping whose sheets the prepared workbook actually declares. */
function normalizePreparedMapping(
  raw: unknown,
  sheets: ReadonlySet<string>,
): ValuationWorkflowPlanMapping[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const mapping: ValuationWorkflowPlanMapping[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    const record = item as Record<string, unknown>
    const field = text(record.field).trim()
    const sheet = text(record.sheet).trim()
    const range = text(record.range).trim()
    if (field === '' || sheet === '' || range === '') return null
    if (sheets.size > 0 && !sheets.has(sheet)) return null
    mapping.push({ ...record, field, sheet, range })
  }
  return mapping
}

/** Formula checks are trusted only when every reported check passed. */
function normalizePreparedChecks(raw: unknown): ValuationWorkflowPlanFormulaCheck[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const checks: ValuationWorkflowPlanFormulaCheck[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    const record = item as Record<string, unknown>
    const name = text(record.name).trim()
    if (record.ok !== true || name === '') return null
    checks.push({ ...record, ok: true, name })
  }
  return checks
}

interface PreparedTemplateFacts {
  ok: boolean
  errorKind: ValuationServiceErrorKind
  error: string
  template?: ValuationWorkflowPlanTemplate
}

/**
 * Re-read the freshly prepared workbook and bind the descriptor to the real bytes.
 *
 * Python stdout is not evidence on its own: the descriptor's digest, byte count and sheet
 * mapping are all rechecked against the file read back through the Host FS. The mapping is
 * only accepted when it points into a sheet the prepared workbook declares, so the plan wire
 * can never carry a value location foreign to the workbook it is bound to.
 */
async function verifyPreparedTemplate(
  deps: HostWorkflowServiceDeps,
  actor: ReturnType<typeof requireBoundValuationActor>['actor'],
  baseDir: string,
  baseRelative: string,
  raw: unknown,
): Promise<PreparedTemplateFacts> {
  const reject = (error: string): PreparedTemplateFacts => ({ ok: false, errorKind: 'infrastructure', error })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject('模板准备脚本没有返回模板描述：拒绝按未知格式登记模板')
  }
  const descriptor = raw as Record<string, unknown>
  const relative = text(descriptor.relativePath).trim()
  if (!safePreparedRelative(relative)) {
    return reject(`模板准备脚本返回的相对路径不是方案目录内的安全 XLSX 路径：「${relative.slice(0, 200)}」`)
  }
  const digest = text(descriptor.digest).trim()
  if (!TEMPLATE_DIGEST.test(digest)) {
    return reject('模板描述缺少合法的 sha256 指纹：拒绝登记未验真的模板')
  }
  if (descriptor.verified !== true) {
    return reject('模板准备脚本没有声明模板已验真：拒绝登记')
  }
  const size = typeof descriptor.size === 'number' && Number.isFinite(descriptor.size)
    ? Math.trunc(descriptor.size)
    : -1
  if (size <= 0 || size > TEMPLATE_MAX_BYTES) {
    return reject(`模板描述的字节数不合法（${String(descriptor.size)}）：拒绝登记`)
  }
  const sheets = new Set<string>()
  const sheetRanges: Record<string, string> = {}
  const rawRanges = descriptor.sheetRanges
  if (rawRanges !== null && typeof rawRanges === 'object' && !Array.isArray(rawRanges)) {
    for (const [name, range] of Object.entries(rawRanges as Record<string, unknown>)) {
      const value = text(range).trim()
      if (name.trim() === '' || value === '') continue
      sheets.add(name)
      sheetRanges[name] = value
    }
  }
  const mapping = normalizePreparedMapping(descriptor.mapping, sheets)
  if (mapping === null) {
    return reject('模板描述的取值位置映射不完整或指向未知工作表：拒绝登记')
  }
  const formulaChecks = normalizePreparedChecks(descriptor.formulaChecks)
  if (formulaChecks === null) {
    return reject('模板描述的公式检查未全部通过：拒绝登记')
  }
  const fs = fileSystem(deps.ctx)
  if (fs === undefined) {
    return { ok: false, errorKind: 'capability-gap', error: '宿主文件服务不可用：无法读取已准备的计算模板' }
  }
  const caseRelative = `${baseRelative}${relative}`
  let bytes: Uint8Array
  try {
    bytes = await fs.readBytes(await fs.resolve(joinLocalPath(baseDir, relative)), actor.signal, TEMPLATE_MAX_BYTES)
  } catch (error) {
    void error
    return reject(`读不到脚本刚准备的计算模板 ${caseRelative}：拒绝登记未落盘的模板`)
  }
  if (bytes.length !== size) {
    return reject(`已准备的计算模板 ${caseRelative} 的字节数与脚本声明不一致：拒绝登记`)
  }
  if (knowledgeDigest(bytes) !== digest) {
    return reject(`已准备的计算模板 ${caseRelative} 的内容指纹与脚本声明不一致：拒绝登记`)
  }
  const workbook = verifyTemplateWorkbook(bytes, caseRelative)
  if (!workbook.ok) {
    return reject(`已准备的计算模板 ${caseRelative} 不是可用的 XLSX：${workbook.problems.join('；')}`)
  }
  const fileName = text(descriptor.fileName).trim() || (relative.split('/').pop() ?? '')
  return {
    ok: true, errorKind: '', error: '',
    template: {
      fileName,
      // Digest-bound case-relative path; the calculator strips the exact 方案/<planId>/ prefix.
      relativePath: caseRelative,
      digest,
      verified: true,
      mapping,
      formulaChecks,
      size,
      sheetRanges,
    },
  }
}

/**
 * Prepare the genuine blank listing-reference workbook for a registered plan.
 *
 * This is the pre-input (phase-1) counterpart of {@link runListingReference}: it never reads
 * the fixed input and needs only a live-bound actor and a registered plan. It reuses the same
 * staged packaged builder through the same Broker operation in `--prepare-template` mode,
 * writes under the Host-derived base plan directory, then re-reads the bytes and verifies the
 * digest / ZIP shape / byte count / sheet mapping before exposing the template on the plan wire.
 */
export async function prepareListingReferenceTemplate(
  input: ListingReferenceTemplateServiceInput,
  deps: HostWorkflowServiceDeps,
  principal: ValuationServicePrincipal,
): Promise<ListingReferenceTemplateResult> {
  const bound = await bindListing(input, deps, principal)
  if (!bound.ok) return { ok: false, errorKind: bound.errorKind, error: bound.error }
  const { actor, planId, paths } = bound
  const baseDir = paths?.baseDir ?? ''
  const baseRelative = paths?.baseRelative ?? ''
  if (baseDir === '' || baseRelative === '') {
    return { ok: false, errorKind: 'input', error: `planId 不是单段安全标识：「${planId}」` }
  }
  // Resolve the configured DSH Python before any staging write (same toolchain as the builder).
  const pythonResolved = await resolveListingPython(deps, actor)
  if (!pythonResolved.ok) {
    return {
      ok: false, errorKind: pythonResolved.errorKind, error: pythonResolved.error,
      python: pythonResolved.python,
    }
  }
  const python = pythonResolved.python
  const platform = await deps.world.platform()
  const session = actor.session
  const signal = actor.signal
  const scopeOptions = {
    workdir: actor.caseDir, platform,
    ...(session === undefined ? {} : { session }),
    ...(signal === undefined ? {} : { signal }),
  }
  // The template lands under the Host-derived base plan directory; it must exist first.
  const made = await ensureDirectory(deps.access, baseDir, scopeOptions)
  if (made.errorKind !== '' || made.postcondition !== 'directory') {
    return {
      ok: false, errorKind: 'infrastructure',
      error: `无法准备方案目录 ${baseRelative}：挂牌参考计算表模板无法落点`, python,
    }
  }
  const staged = await stageRuntime(deps, actor, actor.caseDir, platform)
  if (!staged.ok) return { ok: false, errorKind: staged.errorKind, error: staged.error, python }
  const argv = [staged.scriptPath, '--prepare-template', '--out-dir', baseDir, '--case-root', baseDir]
  const run = await deps.access.runShell(
    { operation: 'python.script.run', source: 'audit-tool', workdir: actor.caseDir },
    shellInvoke(python.path, argv, platform),
    { ...scopeOptions, timeoutMs: RUN_TIMEOUT_MS, summary: 'valuation listing reference template' },
  )
  const runKind = classifyRun(run)
  const stdout = jsonObject(run.stdout)
  if (runKind !== '' || run.ok !== true || stdout === null || stdout.ok !== true) {
    const kind = runKind === '' ? 'infrastructure' : runKind
    return {
      ok: false, errorKind: kind,
      error: `挂牌参考计算表模板没有成功准备（分类：${kind}，退出码：${String(run.exitCode ?? 'unknown')}）：请检查案例目录与 DSH Python 配置后重试`,
      python,
    }
  }
  const verified = await verifyPreparedTemplate(deps, actor, baseDir, baseRelative, stdout.template)
  if (!verified.ok) return { ok: false, errorKind: verified.errorKind, error: verified.error, python }
  return { ok: true, errorKind: '', error: '', template: verified.template, python }
}
