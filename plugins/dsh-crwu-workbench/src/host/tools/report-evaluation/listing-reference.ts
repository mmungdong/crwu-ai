import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { isFile, readTextIfExists } from '../../core/fs/paths.ts'
import { fileSize } from '../common/case-dir.ts'
import { ensureDirectory } from '../common/case-files.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'
import { shellInvoke } from '../../core/platform/shell.ts'
import { classifyRun, failure, jsonObject, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { stagedValuationAsset, stagedValuationScript } from './artifacts.ts'
import { planFilePath } from '../../domains/report-evaluation/delivery/finalize-facts.ts'
import { PYTHON_RUNTIME_SOURCE } from '../../core/runtime/python.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'

/**
 * `crwu_valuation_listing_reference`: the **one-call** delivery for listing references.
 *
 * Boundaries:
 * - Parameter surface is only `caseDir / planId / revision`; the input path, script and output dir
 *   are Host-derived from the registered plan.
 * - Only the current valuation session and a registered `planId` are accepted; otherwise fail closed.
 * - The fixed input's `valuationMode` / `projectId` / `planId` must match the Host scope.
 * - One `python.script.run` through the Broker on the configured DSH Python; scripts are staged
 *   case-local first.
 * - All four outputs must really exist and be non-empty; stdout is advisory and never replaces the
 *   file checks.
 * - Status is always `partial`; no path returns `completed`.
 */

interface ListingReferenceArgs {
  caseDir?: unknown
  planId?: unknown
  revision?: unknown
}

interface ListingReferenceFile {
  name: string
  exists: boolean
  bytes: number
}

interface ListingReferenceResult {
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

const INPUT_FILE = '挂牌参考输入.json'
const OUTPUTS = ['计算轨迹.json', '估值底稿.xlsx', '估值报告数据.json', '估值报告.html'] as const
/** Sibling dependencies that the packaged script imports itself. */
const SCRIPTS = [
  'scripts/build_listing_reference.py',
  'scripts/calculate_market.py',
  'scripts/build_report_data.py',
  'scripts/build_report.py',
  'scripts/evidence_index.py',
] as const
/** Schema and report template that the script resolves by skill-relative layout. */
const ASSETS = [
  'schemas/valuation-report-data.schema.json',
  'template/valuation-report.html',
] as const
const RUN_TIMEOUT_MS = 15 * 60_000

function idleResult(): ListingReferenceResult {
  return {
    ok: false, errorKind: '', error: '', status: '',
    caseDir: '', planId: '', revision: 0, reused: false,
    outputs: [], files: [],
    python: { path: '', versionText: '', source: PYTHON_RUNTIME_SOURCE },
  }
}

export function valuationListingReferenceTools(deps: ToolDeps) {
  const tool = defineTool({
    name: VALUATION_TOOL_NAMES.listingReference,
    description: [
      '挂牌参考的**一次性交付**：读本方案的固定输入',
      `（\`方案/<planId>\` 或 \`修订/<n>\` 下的 \`${INPUT_FILE}\`），`,
      '经配置好的 DSH Python 跑一次打包脚本，产出 计算轨迹 / 估值底稿 /',
      `估值报告数据 / 估值报告。四个产物都必须真实存在且非空，状态只可能是 partial。`,
      '输入路径、脚本与输出目录全部由 Host 从已登记方案派生，调用方提交不了任意路径或命令。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      planId: { type: 'string', required: true, description: '已登记到本轮的方案 id（输入与产物按方案隔离）。' },
      revision: {
        type: 'integer',
        description: '修订版本：> 1 时读 / 写 方案/<planId>/修订/<n>/；缺省 / 1 = 方案根。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errorKind: { type: 'string', required: true },
          error: { type: 'string', required: true },
          status: { type: 'string', required: true },
          caseDir: { type: 'string', required: true },
          planId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          reused: { type: 'boolean', required: true },
          outputs: { type: 'array', required: true, items: { type: 'string' } },
          files: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                exists: { type: 'boolean', required: true },
                bytes: { type: 'integer', required: true },
              },
            },
          },
          python: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              path: { type: 'string', required: true },
              versionText: { type: 'string', required: true },
              source: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args: ListingReferenceArgs, exec): Promise<ListingReferenceResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleResult()

      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...access }
      if (access.kind !== 'valuation') {
        return { ...base, ...failure('policy', '这条会话不是本轮估值会话：挂牌参考交付只能在估值子会话里进行') }
      }
      const casePath = access.casePath

      const planId = text(args.planId).trim()
      if (planId === '') {
        return { ...base, caseDir: casePath, ...failure('input', '缺少 planId：挂牌参考交付必须针对具体方案。') }
      }

      const childId = callerIdentity(exec).childId
      const scopes = deps.valuationScopes
      const scope = scopes?.scopeOf(childId)
      if (scopes === undefined || scope === undefined) {
        return {
          ...base, caseDir: casePath, planId,
          ...failure('policy', '这条会话没有本轮估值的案例归属：拒绝登记范围之外的交付'),
        }
      }
      if (!scopes.planOf(childId, planId)) {
        return { ...base, caseDir: casePath, planId, ...failure('policy', `方案 ${planId} 不在本轮登记范围：拒绝交付`) }
      }

      const revision = typeof args.revision === 'number' && Number.isFinite(args.revision)
        ? Math.max(0, Math.trunc(args.revision)) : 0
      const dirRelative = planFilePath(planId, '', revision)
      const baseRelative = planFilePath(planId, '', 0)
      if (dirRelative === '' || baseRelative === '') {
        return { ...base, caseDir: casePath, planId, ...failure('input', `planId 不是单段安全标识：「${planId}」`) }
      }
      const targetDir = joinLocalPath(casePath, dirRelative)
      const baseDir = joinLocalPath(casePath, baseRelative)

      // Fixed input + Host-owned identity: verified before any staging or process I/O.
      const inputPath = joinLocalPath(targetDir, INPUT_FILE)
      const raw = await readTextIfExists(ctx, inputPath)
      if (raw.trim() === '') {
        return {
          ...base, caseDir: casePath, planId, revision,
          ...failure('input', `缺少固定输入 ${joinLocalPath(dirRelative, INPUT_FILE)}：挂牌参考交付不接受调用方给的任意路径`),
        }
      }
      let payload: Record<string, unknown>
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('top-level is not an object')
        payload = parsed as Record<string, unknown>
      } catch {
        return {
          ...base, caseDir: casePath, planId, revision,
          ...failure('input', `固定输入不是合法 JSON 对象：请检查「${INPUT_FILE}」的语法后重试`),
        }
      }
      if (text(payload.valuationMode) !== 'listing-reference') {
        return { ...base, caseDir: casePath, planId, revision, ...failure('input', '固定输入的 valuationMode 必须是 listing-reference') }
      }
      const expectedProject = text(scope.projectId) || text(scope.valuationId)
      if (text(payload.projectId) !== expectedProject) {
        return {
          ...base, caseDir: casePath, planId, revision,
          ...failure('input', '固定输入的 projectId 与本轮估值归属不一致：拒绝交付'),
        }
      }
      if (text(payload.planId) !== planId) {
        return { ...base, caseDir: casePath, planId, revision, ...failure('input', '固定输入的 planId 与请求方案不一致：拒绝交付') }
      }

      const pythonResolver = deps.python
      if (pythonResolver === undefined) {
        return {
          ...base, caseDir: casePath, planId, revision,
          ...failure('capability-gap', 'DSH 自带 Python 解析器没有装配：请在部署配置里指定可用的 Python 解释器后重试'),
        }
      }
      // Resolve the runtime before any staging write: an unavailable interpreter is a capability
      // gap, not something to discover after the case directory has been touched.
      const runtime = await pythonResolver.check({ agent: exec.agent })
      const python = { path: runtime.path, versionText: runtime.versionText, source: runtime.source }
      if (!runtime.ok) {
        return {
          ...base, caseDir: casePath, planId, revision,
          ...failure('capability-gap', `DSH 自带 Python 运行时不可用（状态：${text(runtime.state) || 'failed'}）：请在部署配置里指定可用的 Python 解释器后重试`),
        }
      }

      const platform = await deps.world.platform()
      const session = callerSession(exec)
      const signal = exec.signal
      const scopeOptions = {
        workdir: casePath, platform,
        ...(session === undefined ? {} : { session }),
        ...(signal === undefined ? {} : { signal }),
      }

      for (const dir of ['scripts', 'schemas', 'template']) {
        const made = await ensureDirectory(deps.access, joinLocalPath(casePath, dir), scopeOptions)
        if (made.errorKind !== '' || made.postcondition !== 'directory') {
          return {
            ...base, caseDir: casePath, planId, revision,
            ...failure('infrastructure', `无法准备案例子目录 ${dir}：${made.error || made.postcondition}`),
          }
        }
      }

      const stageInput = {
        ctx, casePath,
        ...(session === undefined ? {} : { session }),
        ...(signal === undefined ? {} : { signal }),
      }
      let scriptPath = ''
      for (const relative of SCRIPTS) {
        const staged = await stagedValuationScript({ ...stageInput, relative })
        if (!staged.ok) {
          return { ...base, caseDir: casePath, planId, revision, ...failure('infrastructure', staged.error) }
        }
        if (relative === SCRIPTS[0]) scriptPath = staged.scriptPath
      }
      for (const relative of ASSETS) {
        const staged = await stagedValuationAsset({ ...stageInput, relative })
        if (!staged.ok) {
          return { ...base, caseDir: casePath, planId, revision, ...failure('infrastructure', staged.error) }
        }
      }

      const argv = [scriptPath, '--input', inputPath, '--out-dir', targetDir, '--case-root', baseDir]
      const run = await deps.access.runShell(
        { operation: 'python.script.run', source: 'audit-tool', workdir: casePath },
        shellInvoke(runtime.path, argv, platform),
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
      // The script self-report is advisory only; truthfulness is still enforced by the file checks.
      const scriptStdout = jsonObject(run.stdout)
      const reused = scriptStdout?.reused === true

      const files: ListingReferenceFile[] = []
      const missing: string[] = []
      for (const name of OUTPUTS) {
        const path = joinLocalPath(targetDir, name)
        const exists = await isFile(ctx, path)
        const bytes = exists ? await fileSize(ctx, path) : 0
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
    },
  })

  return [tool]
}
