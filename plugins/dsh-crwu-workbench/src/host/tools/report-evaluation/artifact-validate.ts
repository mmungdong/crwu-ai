import { defineTool } from '@deepseek-ai/dsh-tools'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { isFile } from '../../core/fs/paths.ts'
import { fileSize } from '../common/case-dir.ts'
import { sha256OfBytes } from '../../domains/report-evaluation/intake/manifest.ts'
import { readTextIfExists } from '../../core/fs/paths.ts'
import { requireCaseAccess } from '../../domains/report-audit/case-access.ts'
import { recordValidation } from './record.ts'
import { shellInvoke } from '../../core/platform/shell.ts'
import { classifyRun, clampText, failure, reasonOf, renderJson } from '../common/outcome.ts'
import { callerSession, toolContext, type ToolDeps } from '../common/types.ts'
import { caseScopes } from '../report-audit/case-scopes.ts'
import { PYTHON_RUNTIME_SOURCE } from '../../core/runtime/python.ts'
import { stagedValuationScript, VALUATION_OUTPUT_FILES } from './artifacts.ts'
import { VALUATION_TOOL_NAMES } from './consts.ts'
import type { LocalAccessBroker } from '../../core/access/broker.ts'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * `crwu_valuation_artifact_validate`：**交付前的最后一道门**（协议 32）。
 *
 * ## 两道校验，都必须过
 *
 * | 脚本 | 校验什么 | 为什么不能省 |
 * | --- | --- | --- |
 * | `check_workbook_contract.py` | 七张可见表、无隐藏表、无跨工作簿链接、公式链不断 | 结论数字必须能从底稿重算出来；断链或隐藏表会让"重算"变成"抄一遍" |
 * | `validate_result.py` | 结果 JSON 的结构与**口径**（方法不是 auto、基准日空则登记、挂牌不得当可比、数字不许填 0…） | 这些错读起来完全正常，只有逐条比规则才看得出来 |
 *
 * ## 为什么用**脚本**而不是在 TypeScript 里实现
 *
 * 工作簿契约与结果口径都跟着业务规范走（税率、勾稽、七张表的结构），它们属于技能而不是插件。
 * 脚本随技能发布、可以被业务侧单独审阅与修改；插件只负责**执行、取退出码、把问题原样带回来**。
 *
 * ## 边界
 *
 * 脚本先落到 `<案例目录>/scripts/`（`python.script.run` 只接受案例内的脚本路径，Host 也不开后门）；
 * argv 逐个传参、不经 shell；解释器来自与审核启动同一个 DSH Python 解析器。
 */

interface ValidateArgs {
  caseDir?: unknown
}

interface CheckReport {
  name: string
  script: string
  ok: boolean
  exitCode: number | null
  /** 逐条问题（脚本 stdout 的 FAIL 行）。**原样转述**，不改写。 */
  problems: string[]
  /** 成功行 / 观察（WARN）。 */
  notes: string[]
  stdout: string
  stderr: string
  timedOut: boolean
}

interface ArtifactFile {
  name: string
  exists: boolean
  bytes: number
  digest: string
}

interface ValidateResult {
  ok: boolean
  errorKind: string
  error: string
  caseDir: string
  python: { path: string; versionText: string; source: string }
  artifacts: ArtifactFile[]
  checks: CheckReport[]
  /** 两份校验都没问题时为空。 */
  problems: string[]
}

const SCRIPTS = {
  workbook: 'scripts/check_workbook_contract.py',
  result: 'scripts/validate_result.py',
} as const

function idleResult(): ValidateResult {
  return {
    ok: false, errorKind: '', error: '', caseDir: '',
    python: { path: '', versionText: '', source: PYTHON_RUNTIME_SOURCE },
    artifacts: [], checks: [], problems: [],
  }
}

/** 从脚本输出里挑出 `FAIL` / `WARN` 行（脚本自己定义这两个前缀，这里只做转述）。 */
export function parseCheckOutput(stdout: string): { problems: string[]; notes: string[] } {
  const problems: string[] = []
  const notes: string[] = []
  for (const line of text(stdout).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('FAIL')) problems.push(trimmed.replace(/^FAIL\s*/, ''))
    else if (trimmed.startsWith('WARN')) notes.push(trimmed.replace(/^WARN\s*/, ''))
  }
  return { problems, notes }
}

interface RunScriptOptions {
  ctx: Parameters<typeof stagedValuationScript>[0]['ctx']
  access: LocalAccessBroker
  python: NonNullable<ToolDeps['python']>
  platform: string
  casePath: string
  scriptPath: string
  scriptArgs: string[]
  session?: Session
  signal?: AbortSignal
}

async function runCheck(
  options: RunScriptOptions,
  name: string,
): Promise<{ report: CheckReport; python: ValidateResult['python'] }> {
  const runtime = await options.python.check({})
  const report: CheckReport = {
    name, script: options.scriptPath, ok: false, exitCode: null,
    problems: [], notes: [], stdout: '', stderr: '', timedOut: false,
  }
  if (!runtime.ok) {
    report.problems.push(`DSH 自带 Python 不可用（${runtime.state}）：${runtime.error}`)
    return { report, python: { path: runtime.path, versionText: runtime.versionText, source: runtime.source } }
  }
  const argv = [options.scriptPath, ...options.scriptArgs]
  const run = await options.access.runShell(
    { operation: 'python.script.run', source: 'audit-tool', workdir: options.casePath },
    shellInvoke(runtime.path, argv, options.platform),
    {
      workdir: options.casePath,
      timeoutMs: 5 * 60_000,
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      summary: 'valuation artifact validate',
    },
  )
  report.exitCode = run.exitCode
  report.timedOut = run.timedOut === true
  report.stdout = clampText(run.stdout, 20_000)
  report.stderr = clampText(run.stderr, 8_000)
  const parsed = parseCheckOutput(run.stdout)
  report.problems = [...parsed.problems]
  report.notes = [...parsed.notes]
  const errorKind = classifyRun(run)
  if (errorKind !== '' && report.problems.length === 0) report.problems.push(reasonOf(run))
  report.ok = run.ok && errorKind === '' && report.problems.length === 0
  return { report, python: { path: runtime.path, versionText: runtime.versionText, source: runtime.source } }
}

export function valuationArtifactValidateTools(deps: ToolDeps) {
  const validate = defineTool({
    name: VALUATION_TOOL_NAMES.artifactValidate,
    description: [
      '交付前的最后一道门：校验本轮的**工作簿契约**（七张可见表、无隐藏表、无跨工作簿链接、公式链不断）',
      '与**结果口径**（方法不是 auto、未指定基准日必须登记、挂牌不得直接作可比实例、数字不许填 0…）。',
      '两份校验都必须通过；不通过时逐条把问题原样带回来。它只读不写（除了把校验脚本落到案例目录的 scripts/）。',
    ].join(' '),
    parameters: {
      caseDir: { type: 'string', required: true, description: '本轮估值案例目录（Host 校验归属）。' },
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
          python: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              path: { type: 'string', required: true },
              versionText: { type: 'string', required: true },
              source: { type: 'string', required: true },
            },
          },
          artifacts: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                exists: { type: 'boolean', required: true },
                bytes: { type: 'integer', required: true },
                digest: { type: 'string', required: true },
              },
            },
          },
          checks: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                script: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
                problems: { type: 'array', required: true, items: { type: 'string' } },
                notes: { type: 'array', required: true, items: { type: 'string' } },
                stdout: { type: 'string', required: true },
                stderr: { type: 'string', required: true },
                timedOut: { type: 'boolean', required: true },
              },
            },
          },
          problems: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },

    async execute(args: ValidateArgs, exec): Promise<ValidateResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleResult()

      const access = await requireCaseAccess(
        ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, caseScopes(deps),
      )
      if (!access.ok) return { ...base, ...access }
      if (access.kind !== 'valuation') {
        return { ...base, ...failure('policy', '这条会话不是本轮估值会话：交付校验只能在估值子会话里进行') }
      }
      const casePath = access.casePath
      const session = callerSession(exec)
      const signal = exec.signal

      // 交付件清单（存在性 + 指纹）：校验之前先如实回答"到底有哪些文件"。
      const artifacts: ArtifactFile[] = []
      for (const name of VALUATION_OUTPUT_FILES) {
        const path = joinLocalPath(casePath, name)
        const exists = await isFile(ctx, path)
        const bytes = exists ? await fileSize(ctx, path) : 0
        const digest = exists && bytes > 0 ? sha256OfBytes(await readTextIfExists(ctx, path)) : ''
        artifacts.push({ name, exists, bytes, digest })
      }
      const deliverable = artifacts.find((item) => item.name === '估值底稿.xlsx')
      const resultFile = artifacts.find((item) => item.name === '估值结果.json')
      const report = artifacts.find((item) => item.name === '估值报告.html')
      const problems: string[] = []
      if (deliverable?.exists !== true) problems.push('缺少交付件：估值底稿.xlsx')
      if (resultFile?.exists !== true) problems.push('缺少交付件：估值结果.json')
      if (report?.exists !== true) problems.push('缺少交付件：估值报告.html')

      if (deps.python === undefined) {
        return {
          ...base,
          ...failure('capability-gap', 'DSH 自带 Python 解析器没有装配：无法执行交付校验脚本'),
          caseDir: casePath, artifacts,
        }
      }

      const platform = await deps.world.platform()
      const options: RunScriptOptions = {
        ctx, access: deps.access, python: deps.python, platform, casePath,
        ...(session === undefined ? {} : { session }),
        ...(signal === undefined ? {} : { signal }),
        scriptPath: '', scriptArgs: [],
      }
      const checks: CheckReport[] = []
      let pythonInfo = base.python

      // ① 工作簿契约：底稿存在才跑（不存在时上面已经记了缺口，再跑脚本只会多一句"找不到"）。
      if (deliverable?.exists === true) {
        const staged = await stagedValuationScript({ ctx, casePath, relative: SCRIPTS.workbook, ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }) })
        if (!staged.ok) problems.push(staged.error)
        else {
          const { report: workbookReport, python } = await runCheck(
            { ...options, scriptPath: staged.scriptPath, scriptArgs: [joinLocalPath(casePath, '估值底稿.xlsx')] },
            '工作簿契约',
          )
          checks.push(workbookReport)
          pythonInfo = python
        }
      }

      // ② 结果口径：报告与底稿一起交给脚本做一致性抽查。
      if (resultFile?.exists === true) {
        const staged = await stagedValuationScript({ ctx, casePath, relative: SCRIPTS.result, ...(session === undefined ? {} : { session }), ...(signal === undefined ? {} : { signal }) })
        if (!staged.ok) problems.push(staged.error)
        else {
          const scriptArgs = [joinLocalPath(casePath, '估值结果.json')]
          if (report?.exists === true) scriptArgs.push('--html', joinLocalPath(casePath, '估值报告.html'))
          if (deliverable?.exists === true) scriptArgs.push('--workbook', joinLocalPath(casePath, '估值底稿.xlsx'))
          const { report: resultReport, python } = await runCheck(
            { ...options, scriptPath: staged.scriptPath, scriptArgs },
            '结果口径',
          )
          checks.push(resultReport)
          pythonInfo = python
        }
      }

      for (const check of checks) {
        for (const problem of check.problems) problems.push(`${check.name}：${problem}`)
      }
      // **校验结论写回轮次**（§9）：完成门槛在宿主侧判，它读得到这条才知道
      // "交付前两道校验都过了"。不写回的话，`completed` 就只能相信模型自己说"我验过了"。
      // 两道校验都跑过才算一次有效结论：脚本没跑成（staged 失败）时 `checks` 会少，
      // 那种情况按"没通过"记 —— 不能把"没跑成"当成"过了"。
      const ranBoth = checks.length === 2
      const passed = problems.length === 0 && ranBoth
      // 写回**尽力而为**：失败不影响校验本身的结论 —— 那只是"完成门槛读不到结论"，
      // 结果是这一轮停在 running（用户看得见），不该把一次成功的校验说成没过。
      // 不打印、也不并进 `problems`：前者引入一条无人消费的日志，后者会让结论自相矛盾。
      recordValidation(deps, exec, passed, problems)
      return {
        ok: problems.length === 0,
        errorKind: problems.length === 0 ? '' : 'input',
        error: problems.length === 0 ? '' : `交付校验未通过（${problems.length} 项）`,
        caseDir: casePath,
        python: pythonInfo,
        artifacts,
        checks,
        problems,
      }
    },
  })

  return [validate]
}
