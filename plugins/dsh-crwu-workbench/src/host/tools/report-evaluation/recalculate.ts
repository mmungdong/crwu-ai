import { defineTool } from '@deepseek-ai/dsh-tools'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { text } from '../../../shared/utils/value.ts'
import { readTextIfExists } from '../../core/fs/paths.ts'
import { shellInvoke } from '../../core/platform/shell.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { callerIdentity } from '../../domains/report-audit/scope.ts'
import { FINALIZE_PATHS, planFilePath } from '../../domains/report-evaluation/delivery/finalize-facts.ts'
import {
  createWorkbookRecalculator,
  type RecalcProvider,
} from '../../domains/report-evaluation/delivery/recalculation.ts'
import {
  recalcProvidersOf,
  runConfiguredEngine,
  type EngineObservationInput,
} from '../../domains/report-evaluation/delivery/recalculation-engine.ts'
import { ensureDirectory, writeCaseText } from '../common/case-files.ts'
import { canonicalJson } from '../common/snapshot.ts'
import { failure, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { stagedValuationScript } from './artifacts.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'

/**
 * `crwu_valuation_recalculate`：**真正跑一次重算并回读**，由 **Host 写**重算结论（协议 39）。
 *
 * ## 为什么必须是 Host 写这份记录
 *
 * `重算结论.json` 落在方案目录里，**模型写得到**。如果它由模型来写，"重算通过"就只是
 * 一句自我声明；而 `finalize` 会照它把报告抬成 `completed`。所以这里：
 *
 * 1. 引擎路径只来自**部署配置**（模型提交不了）—— 配置为空就直接 `unavailable`，
 *    报告只能交付 `partial`，而不是"你自己声明算过了"；
 * 2. 记录由本 Tool **自己生成并落盘**，`observed` 是**回读脚本读出来的缓存值**，
 *    不是调用方给的期望值；不一致时 `verified: false` 并把逐项差异写进 `mismatches`；
 * 3. `finalize` 那一侧还有一条可证伪判据（探测不到引擎时，任何声称重算成功的记录都判失败）。
 *
 * ## 数值位置来自模板自己的填写说明
 *
 * "哪个格子是单价、哪个是总价"是**业务事实**（跟着模板走），模型按它实际用的模板提交
 * `observations`；这一层只负责执行、回读与逐项比对，不猜位置、不填期望值。
 */

interface RecalculateArgs {
  caseDir?: unknown
  planId?: unknown
  revision?: unknown
  /** 对象 → 数值位置：`[{ objectId, unitPriceCell, totalValueCell }]`。 */
  observations?: unknown
}

interface RecalculateResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  planId: string
  state: string
  reason: string
  providerId: string
  verified: boolean
  observed: Array<{ objectId: string; unitPrice: string | null; totalValue: string | null }>
  mismatches: string[]
  problems: string[]
  recordPath: string
  providers: string[]
}

function idle(): RecalculateResult {
  return {
    ok: false, errorKind: '', error: '', caseDir: '', planId: '', state: 'unavailable', reason: '',
    providerId: '', verified: false, observed: [], mismatches: [], problems: [], recordPath: '',
    providers: [],
  }
}

function observationsOf(value: unknown): EngineObservationInput[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      objectId: text(item.objectId),
      unitPriceCell: text(item.unitPriceCell),
      totalValueCell: text(item.totalValueCell),
    }))
    .filter((item) => item.objectId !== '' && (item.unitPriceCell !== '' || item.totalValueCell !== ''))
}

/** 期望值：从 `估值报告数据.json` 的逐对象结论里取（**调用方提交不了**）。 */
async function expectedOf(
  ctx: Parameters<typeof readTextIfExists>[0],
  caseDir: string,
  relative: string,
  objectIds: readonly string[],
): Promise<Array<{ objectId: string; unitPrice: string | null; totalValue: string | null }>> {
  const raw = await readTextIfExists(ctx, joinLocalPath(caseDir, relative))
  if (raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const document = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : {}
  const conclusions = Array.isArray(document.conclusions) ? document.conclusions : []
  const out: Array<{ objectId: string; unitPrice: string | null; totalValue: string | null }> = []
  for (const item of conclusions) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const objectId = text(row.objectId)
    if (objectId === '' || !objectIds.includes(objectId)) continue
    out.push({
      objectId,
      unitPrice: text(row.unitPrice) === '' ? null : text(row.unitPrice),
      totalValue: text(row.totalValue) === '' ? null : text(row.totalValue),
    })
  }
  return out
}

export function valuationRecalculateTools(deps: ToolDeps) {
  const tool = defineTool({
    name: VALUATION_TOOL_NAMES.recalculate,
    description: [
      '用**部署配置的表格计算程序**真正重算一次底稿并回读数值，然后由 Host 写出「重算结论.json」。',
      '没有配置表格计算程序时返回 `unavailable` 并说明报告只能交付 partial —— 它不会替你宣布重算成功。',
      '数值位置由调用方按**模板自己的填写说明**提交（objectId / unitPriceCell / totalValueCell）；',
      '期望值取自 估值报告数据.json，回读值取自重算后的工作簿，两边不一致时 verified 为 false。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
      planId: { type: 'string', required: true, description: '方案 id。' },
      revision: {
        type: 'integer',
        description: '修订版本：> 1 时重算 方案/<planId>/修订/<n>/估值底稿.xlsx，结论也写在该版本目录下。',
      },
      observations: {
        type: 'array',
        description: '对象 → 数值位置：[{ objectId, unitPriceCell, totalValueCell }]（位置形如 `估值结果汇总!J5`）。',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            objectId: { type: 'string', required: true },
            unitPriceCell: { type: 'string', required: true },
            totalValueCell: { type: 'string', required: true },
          },
        },
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
          caseDir: { type: 'string', required: true },
          planId: { type: 'string', required: true },
          state: { type: 'string', required: true, description: 'recalculated / unavailable / failed' },
          reason: { type: 'string', required: true },
          providerId: { type: 'string', required: true },
          verified: { type: 'boolean', required: true, description: '回读数值与报告数据逐项一致才为 true' },
          observed: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                objectId: { type: 'string', required: true },
                unitPrice: { type: 'json', required: true, description: '十进制字符串；读不到是 null（不是 0，也不是空串）' },
                totalValue: { type: 'json', required: true, description: '十进制字符串；读不到是 null' },
              },
            },
          },
          mismatches: { type: 'array', required: true, items: { type: 'string' } },
          problems: { type: 'array', required: true, items: { type: 'string' } },
          recordPath: { type: 'string', required: true, description: 'Host 写出的重算结论路径（相对案例目录）' },
          providers: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (result) => renderJson(result as Record<string, unknown>),
    },
    async execute(args: RecalculateArgs, exec): Promise<RecalculateResult> {
      const ctx = toolContext(deps.ctx, exec)
      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...idle(), ...failure(access.errorKind ?? 'policy', access.error) }
      if (access.kind !== 'valuation') {
        return { ...idle(), ...failure('policy', '这条会话不是本轮估值会话：重算只能在估值子会话里进行') }
      }
      const caseDir = access.casePath
      const planId = text(args.planId).trim()
      const revision = typeof args.revision === 'number' && Number.isFinite(args.revision)
        ? Math.max(0, Math.trunc(args.revision)) : 0
      const planFile = (name: string): string => planFilePath(planId, name, revision)
      if (planFile('') === '') {
        return { ...idle(), caseDir, planId, ...failure('input', `planId 不是单段安全标识：「${planId}」`) }
      }

      const providers: readonly RecalcProvider[] = recalcProvidersOf(deps.config)
      const base: RecalculateResult = {
        ...idle(), caseDir, planId,
        providers: providers.map((item) => item.id),
      }
      const recordRelative = planFile(FINALIZE_PATHS.recalculation)
      const writeRecord = async (payload: Record<string, unknown>): Promise<string> => {
        const written = await writeCaseText(ctx, joinLocalPath(caseDir, recordRelative), canonicalJson(payload))
        return written.ok ? recordRelative : `${recordRelative}（落盘失败：${written.error}）`
      }

      // ① 没有引擎：如实 `unavailable`（**不**写一份"重算过"的记录）。
      if (providers.length === 0) {
        const reason = '本部署没有配置表格计算程序（Excel / LibreOffice）：底稿公式正确，'
          + '但数值未重算，本轮只能交付 partial 并标注「待重算」。'
        const outcome = {
          state: 'unavailable', reason, providerId: '', verified: false,
          observed: [], recalculatedAt: new Date().toISOString(), mismatches: [],
        }
        const recordPath = await writeRecord({ ...outcome, problems: [], producedBy: 'host' })
        return { ...base, ok: true, state: 'unavailable', reason, recordPath }
      }

      const observations = observationsOf(args.observations)
      if (observations.length === 0) {
        return {
          ...base,
          ...failure('input', '没有给出「对象 → 数值位置」：重算要读哪几个格子由模板自己的填写说明决定，HOST 不猜位置'),
        }
      }

      const workbookRelative = planFile('估值底稿.xlsx')
      const workbookAbsolute = joinLocalPath(caseDir, workbookRelative)

      const session = callerSession(exec)
      const signal = exec.signal
      const platform = await deps.world.platform()
      const scratchRelative = planFile('.recalc')
      const scratchAbsolute = joinLocalPath(caseDir, scratchRelative)
      const made = await ensureDirectory(deps.access, scratchAbsolute, {
        workdir: caseDir, platform, ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }),
      })
      if (!made.ok) {
        return { ...base, ...failure('infrastructure', `重算临时目录创建失败：${made.error}`) }
      }
      if (deps.python === undefined) {
        return { ...base, ...failure('capability-gap', 'DSH 自带 Python 解析器没有装配：无法回读重算结果') }
      }
      const staged = await stagedValuationScript({
        ctx, casePath: caseDir, relative: 'scripts/read_workbook_values.py',
        ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }),
      })
      if (!staged.ok) {
        return { ...base, ...failure('infrastructure', `回读脚本落盘失败：${staged.error}`) }
      }
      const runtime = await deps.python.check({})
      if (!runtime.ok) {
        return { ...base, ...failure('capability-gap', `DSH 自带 Python 不可用（${runtime.state}）：${runtime.error}`) }
      }

      const engine = providers[0]
      const scratchName = workbookRelative.split('/').pop() ?? '估值底稿.xlsx'
      const recalculatedAbsolute = joinLocalPath(scratchAbsolute, scratchName)

      const run = await runConfiguredEngine({
        enginePath: text((deps.config.valuation as { recalculation?: { enginePath?: unknown } } | undefined)
          ?.recalculation?.enginePath).trim(),
        workbookAbsolutePath: workbookAbsolute,
        scratchAbsolutePath: scratchAbsolute,
        observations,
      }, {
        recalculatedAbsolutePath: recalculatedAbsolute,
        scriptPath: staged.scriptPath,
        runEngine: async ({ command, workdir }) => {
          const result = await deps.access.runShell(
            { operation: 'system.valuation-recalculation.run', source: 'audit-tool', workdir },
            command,
            {
              workdir,
              timeoutMs: 10 * 60_000,
              ...(session === undefined ? {} : { session }),
              ...(signal === undefined ? {} : { signal }),
              summary: 'valuation workbook recalculation',
            },
          )
          return {
            ok: result.ok === true,
            exitCode: result.exitCode ?? null,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            error: result.ok === true ? '' : '引擎调用没有成功',
          }
        },
        runScript: async ({ scriptPath, scriptArgs }) => {
          const result = await deps.access.runShell(
            { operation: 'python.script.run', source: 'audit-tool', workdir: caseDir },
            shellInvoke(runtime.path, [scriptPath, ...scriptArgs], platform),
            {
              workdir: caseDir,
              timeoutMs: 5 * 60_000,
              ...(session === undefined ? {} : { session }),
              ...(signal === undefined ? {} : { signal }),
              summary: 'valuation workbook read-back',
            },
          )
          return {
            ok: result.ok === true,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            error: result.ok === true ? '' : '回读脚本没有成功',
          }
        },
      }, platform)

      if (!run.ok) {
        const outcome = {
          state: 'failed', reason: run.error, providerId: engine.id, verified: false,
          observed: [], recalculatedAt: new Date().toISOString(), mismatches: [], problems: run.problems,
          producedBy: 'host',
        }
        const recordPath = await writeRecord(outcome)
        return {
          ...base, ok: true, state: 'failed', reason: run.error, providerId: engine.id,
          verified: false, problems: run.problems, recordPath,
        }
      }

      // ② 回读核对：期望值只来自 `估值报告数据.json`（调用方提交不了）。
      const expected = await expectedOf(ctx, caseDir, planFile('估值报告数据.json'), observations.map((item) => item.objectId))
      const recalculator = createWorkbookRecalculator({
        probe: async () => [...providers],
        run: async () => ({ ok: true, observed: run.observed }),
      })
      const outcome = await recalculator.recalculate({
        taskId: planId,
        workbookRelativePath: workbookRelative,
        caseRoot: caseDir,
        expected,
      })
      const recordPath = await writeRecord({
        ...outcome,
        problems: run.problems,
        producedBy: 'host',
        expected,
      })
      return {
        ...base,
        ok: true,
        state: outcome.state,
        reason: outcome.reason,
        providerId: outcome.providerId,
        verified: outcome.verified,
        observed: outcome.observed.map((item) => ({ ...item })),
        mismatches: outcome.mismatches,
        problems: run.problems,
        recordPath,
      }
    },
  })

  void callerIdentity
  return [tool]
}
