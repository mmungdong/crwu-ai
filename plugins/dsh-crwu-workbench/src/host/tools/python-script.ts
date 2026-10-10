import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { text } from '../../shared/utils/value.ts'
import { isAbsoluteLocalPath, joinLocalPath } from '../../shared/utils/local-path.ts'
import { requireCaseAccess } from '../audit/case-access.ts'
import { shellInvoke } from '../platform/shell.ts'
import { PYTHON_RUNTIME_SOURCE } from '../runtime/python.ts'
import { TOOL_NAMES, type ToolErrorKind } from './consts.ts'
import { clampText, classifyRun, failure, reasonOf, renderJson } from './outcome.ts'
import { callerSession, toolContext, type ToolDeps } from './types.ts'

/**
 * `crwu_run_python_script`：**审核技能脚本的唯一执行入口**（2026-09-30）。
 *
 * ## 为什么必须有这条 Tool（而不是继续靠提示词）
 *
 * 子代理原来的做法是自己拼 `& 'C:\…\python.exe' scripts/x.py`。可是 DSH 的
 * **模型可见 pwsh 工具与插件的 `ctx.shell` 是同一套 Windows sandbox**（`dsh-pwsh-sandbox`
 * 注册为 `ctx.shell`），所以那条命令同样落在 ACL restricted-token runner 里；native 子进程
 * 直接继承 DSH 的管道句柄时会 `0xC0000142` / `EACCES`，重定向到文件却能跑完。
 *
 * 提示词里那份 `Invoke-DshPython` 包装器是"请照做"——**不保证被执行**，也不带退出码、
 * 超时、清理与沙箱事实。把它做成 Host Tool 之后，这几件事由 Host 保证：
 *
 * 1. **路径**：只接受案例目录**之内**的相对路径（绝对路径 / `..` / 空串一律拒绝），
 *    由 `joinLocalPath` 按平台风格拼接；
 * 2. **argv**：参数逐个传给 `shellInvoke`，不经过任何 shell 解析（`$(…)`、`;` 都只是字面量）；
 * 3. **执行**：经 `LocalAccessBroker` 的 `python.script.run`（来源 `audit-tool`、**不提权**）
 *    走到与其它命令同一条 `ctx.shell` seam —— 于是它自动享受
 *    `windowsCaptureCommand` 那层**只在受限沙箱生效**的临时文件捕获；
 * 4. **结论**：`exitCode` / `stdout` / `stderr` / `truncated` / `timedOut` 与
 *    `sandbox{requested,resolved,ran,denied,runnerFailed}` 一起回给模型；DSH Python 解析不到时
 *    如实回 `capability-gap`。
 *
 * ## 边界
 *
 * - **不是通用命令执行器**：可执行文件由 Host 从 `PythonRuntimeResolver` 取（与"审核能不能启动"
 *   用的是同一份缓存），模型提交不了解释器路径，也提交不了沙箱模式或提权开关；
 * - **不提权**：脚本在案例目录里，而案例目录在会话 cwd（工作空间）之内，边界之内不需要
 *   `danger-full-access`。这正是它落在受限沙箱、从而拿到那层捕获的原因。
 */

/** 单次脚本执行的超时。脚本要扫大量材料，给足但不无限（超时由执行器杀进程）。 */
export const PYTHON_SCRIPT_TIMEOUT_MS = 10 * 60_000

/** 回给模型的 stdout / stderr 上限；超出时**明确标注截断**，不静默丢内容。 */
export const PYTHON_SCRIPT_OUTPUT_MAX = 8_000

interface ScriptArgs {
  caseDir?: unknown
  script?: unknown
  scriptArgs?: unknown
}

interface ScriptResult {
  ok: boolean
  errorKind: ToolErrorKind
  error: string
  /** 案例目录内的绝对路径（Host 拼出来的那一条）。 */
  scriptPath: string
  /** 真正传下去的 argv（模型据此确认参数没有被解释器或 shell 改写）。 */
  argv: string[]
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  python: { path: string; versionText: string; source: string }
  sandbox: { requested: string; resolved: string; ran: string; denied: boolean; runnerFailed: boolean }
}

/** 失败时也要把整组字段补全：模型的下一步判据是 `errorKind`，不是"字段缺没缺"。 */
function idleResult(): ScriptResult {
  return {
    ok: false,
    errorKind: '',
    error: '',
    scriptPath: '',
    argv: [],
    exitCode: null,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    python: { path: '', versionText: '', source: PYTHON_RUNTIME_SOURCE },
    sandbox: { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false },
  }
}

export function pythonScriptTools(deps: ToolDeps) {
  return [defineTool({
    name: TOOL_NAMES.runPythonScript,
    description: [
      '在**本轮案例目录内**运行 DSH 自带 Python 的技能脚本：材料准备、复核、交付脚本都用它。',
      'Host 统一处理 Windows 受限沙箱下原生命令的输出采集、退出码、超时与临时文件清理，'
      + '并把请求/实际的沙箱模式带回结果 —— 不要自己拼 PowerShell 或 `&` 调 Python。',
      'script 必须是案例目录内的相对路径；scriptArgs 逐个作为 argv 传入，不经过 shell 解析。',
    ].join(' '),
    parameters: {
      caseDir: { required: true, type: 'string', description: '本轮案例目录（Host 校验工作空间与案例范围）。' },
      script: {
        required: true, type: 'string',
        description: '案例目录**之内**的脚本相对路径，例如 scripts/review.py。不接受绝对路径与 `..`。',
      },
      scriptArgs: {
        type: 'array', items: { type: 'string' },
        description: '脚本参数（argv，逐个原样传入，不会被 shell 解释）。',
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
          scriptPath: { required: true, type: 'string' },
          argv: { required: true, type: 'array', items: { type: 'string' } },
          // 可空：命令被信号杀掉时拿不到退出码（repo 里可空数字的写法同 dingtalk 的 `exitCode`）。
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          stdout: { required: true, type: 'string' },
          stderr: { required: true, type: 'string' },
          truncated: { required: true, type: 'boolean' },
          timedOut: { required: true, type: 'boolean' },
          python: {
            required: true, type: 'object', additionalProperties: false,
            properties: {
              path: { required: true, type: 'string' },
              versionText: { required: true, type: 'string' },
              source: { required: true, type: 'string' },
            },
          },
          sandbox: {
            required: true, type: 'object', additionalProperties: false,
            properties: {
              requested: { required: true, type: 'string' },
              resolved: { required: true, type: 'string' },
              ran: { required: true, type: 'string' },
              denied: { required: true, type: 'boolean' },
              runnerFailed: { required: true, type: 'boolean' },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: ScriptArgs, exec: ToolRunContext): Promise<ScriptResult> {
      const ctx = toolContext(deps.ctx, exec)
      const base = idleResult()

      // Preserve managed scopes; ordinary sessions use the selected workspace.
      const caseCheck = await requireCaseAccess(ctx, deps.state, deps.discussionScopes, exec, { caseDir: args.caseDir }, deps.localAudit)
      if (!caseCheck.ok) return { ...base, ...caseCheck }

      // ② 脚本路径：只接受案例目录内的相对路径。**拒绝而不是清洗** —— 静默清洗会让调用方
      //    以为拿到了一条它以为的路径（这个文件的历史教训不止一次）。
      const raw = text(args.script).trim()
      if (raw === '') {
        return { ...base, ...failure('input', 'script 不能为空：请给出案例目录内的脚本相对路径') }
      }
      if (isAbsoluteLocalPath(raw)) {
        return { ...base, ...failure('input', `script 必须是案例目录内的相对路径，不接受绝对路径：${raw}`) }
      }
      if (raw.split(/[\\/]+/).includes('..')) {
        return { ...base, ...failure('input', `script 不许含 \`..\`：${raw}`) }
      }
      let scriptPath: string
      try {
        scriptPath = joinLocalPath(caseCheck.casePath, raw)
      } catch (error) {
        return {
          ...base,
          ...failure('input', `script 不是一条可用的案例内路径：${error instanceof Error ? error.message : String(error)}`),
        }
      }

      // ③ 解释器：与审核启动、环境自检**同一个解析器**（同一份缓存）。拿不到就如实报能力缺口，
      //    绝不静默换系统解释器 —— 那会让审核脚本在缺包的运行时上跑出不可信的结果。
      if (deps.python === undefined) {
        return { ...base, ...failure('capability-gap', 'DSH 自带 Python 解析器没有装配：本插件实例不能执行技能脚本') }
      }
      const runtime = await deps.python.check({ agent: exec.agent })
      if (!runtime.ok) {
        return {
          ...base,
          ...failure('capability-gap', `DSH 自带 Python 不可用（${runtime.state}）：${runtime.error}`),
          python: { path: runtime.path, versionText: runtime.versionText, source: runtime.source },
        }
      }

      // ④ 执行：经 Broker 的 `python.script.run`（不提权）走到与其它命令同一条 seam。
      const scriptArgs = (Array.isArray(args.scriptArgs) ? args.scriptArgs : []).map((item) => text(item))
      const platform = await deps.world.platform()
      const argv = [scriptPath, ...scriptArgs]
      const session = callerSession(exec)
      const run = await deps.access.runShell(
        { operation: 'python.script.run', source: 'audit-tool', workdir: caseCheck.casePath },
        shellInvoke(runtime.path, argv, platform),
        {
          workdir: caseCheck.casePath,
          timeoutMs: PYTHON_SCRIPT_TIMEOUT_MS,
          ...(session === undefined ? {} : { session }),
          // 脱敏摘要：进诊断只记用途，不记脚本路径与参数。
          summary: 'python script',
        },
      )
      const errorKind = classifyRun(run)
      return {
        ok: run.ok && errorKind === '',
        errorKind,
        error: errorKind === '' ? '' : reasonOf(run),
        scriptPath,
        argv,
        exitCode: run.exitCode,
        stdout: clampText(run.stdout, PYTHON_SCRIPT_OUTPUT_MAX),
        stderr: clampText(run.stderr, PYTHON_SCRIPT_OUTPUT_MAX),
        truncated: run.truncated === true,
        timedOut: run.timedOut === true,
        python: { path: runtime.path, versionText: runtime.versionText, source: runtime.source },
        sandbox: { ...run.sandbox },
      }
    },
  })]
}
