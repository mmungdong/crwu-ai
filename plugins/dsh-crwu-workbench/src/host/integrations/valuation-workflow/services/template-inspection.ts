import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { isSafeValuationId } from '../../../domains/report-evaluation/scope.ts'
import { isTemplateProfile, type TemplateProfile } from '../../../domains/report-evaluation/workflow/case-collection.ts'
import { shellInvoke } from '../../../core/platform/shell.ts'
import { stagedValuationScript } from '../../../tools/report-evaluation/artifacts.ts'
import { requireBoundValuationActor, type ValuationServiceActor, type ValuationServicePrincipal } from './access.ts'
import type { HostWorkflowServiceDeps } from './deps.ts'
import type { ValuationServiceErrorKind } from './errors.ts'

export interface RegisteredWorkflowTemplate {
  templateId: string
  digest: string
  relativePath: string
}

export interface TemplateInspectionDeps extends HostWorkflowServiceDeps {
  /** Synchronous lookup of a Host-registered receipt, scoped to this actor and plan. */
  resolveTemplate: (templateId: string, planId: string, actor: ValuationServiceActor) => RegisteredWorkflowTemplate | undefined
}

export interface TemplateInspectionResult {
  ok: boolean
  profile?: TemplateProfile
  errorKind: ValuationServiceErrorKind
  error: string
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/^[\\/]|[:\x00-\x1f]/.test(value)
    && value.split(/[\\/]/).every((part) => part !== '' && part !== '.' && part !== '..')
    && /\.xlsx$/i.test(value)
}

const reject = (errorKind: ValuationServiceErrorKind, error: string): TemplateInspectionResult => ({ ok: false, errorKind, error })

/** Inspect only a live actor's registered template; caller paths never reach I/O. */
export async function inspectWorkflowTemplate(
  input: { planId?: unknown; templateId?: unknown },
  deps: TemplateInspectionDeps,
  principal: ValuationServicePrincipal,
): Promise<TemplateInspectionResult> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => key !== 'planId' && key !== 'templateId')
    || typeof input.planId !== 'string' || !isSafeValuationId(input.planId)
    || typeof input.templateId !== 'string' || !isSafeValuationId(input.templateId)) {
    return reject('input', '模板检查仅接受已登记的 planId 和 templateId：请重新选择模板。')
  }
  const bound = requireBoundValuationActor(principal, deps)
  if (!bound.ok) return reject(bound.errorKind, bound.error)
  const actor = bound.actor
  if (!deps.valuationScopes?.planOf(actor.sessionId, input.planId)) {
    return reject('policy', '该方案不属于当前估值会话：请回到本轮方案重新选择。')
  }
  let template: RegisteredWorkflowTemplate | undefined
  try {
    template = deps.resolveTemplate?.(input.templateId, input.planId, actor)
  } catch {
    return reject('infrastructure', '模板登记状态读取失败：请刷新本轮模板后重试。')
  }
  if (template === undefined || template.templateId !== input.templateId || !safeRelativePath(template.relativePath)
    || !/^sha256:[a-f0-9]{64}$/.test(template.digest)) {
    return reject('policy', '未找到本轮有效的模板登记：请重新选择并登记模板。')
  }
  const { templateId, digest, relativePath } = template
  const call = { operation: 'python.script.run', source: 'audit-tool', workdir: actor.caseDir } as const
  const admissionFailure = (): TemplateInspectionResult | undefined => {
    if (principal.signal?.aborted) return reject('cancelled', '模板检查已取消。')
    const live = requireBoundValuationActor(principal, deps)
    const current = deps.resolveTemplate(templateId, input.planId as string, actor)
    if (!live.ok || live.actor.scopeKey !== actor.scopeKey || !deps.valuationScopes?.planOf(actor.sessionId, input.planId as string)
      || current?.templateId !== templateId || current.digest !== digest || current.relativePath !== relativePath) {
      return reject('policy', '本轮模板或会话登记已改变：请重新选择模板后检查。')
    }
    if (!deps.access.authorize?.(call).ok) return reject('policy', '本机访问授权无效或已撤销：请在环境信息中重新确认授权后重试。')
    return undefined
  }
  try {
    let denied = admissionFailure()
    if (denied !== undefined) return denied
    if (deps.python === undefined) return reject('capability-gap', '模板检查未装配 DSH Python：请由管理员检查运行时配置。')
    const runtime = await deps.python.check({ agent: actor.agent })
    if (!runtime.ok) return reject('capability-gap', `模板检查所需 DSH Python/openpyxl 探测未通过（${runtime.state}）：请由管理员修复运行时后重试。`)
    denied = admissionFailure()
    if (denied !== undefined) return denied
    const platform = await deps.world.platform()
    denied = admissionFailure()
    if (denied !== undefined) return denied
    const scopeOptions = {
      ...(actor.agent === undefined ? {} : { agent: actor.agent }),
      ...(actor.session === undefined ? {} : { session: actor.session }),
      ...(actor.signal === undefined ? {} : { signal: actor.signal }),
    }
    const staged = await stagedValuationScript({ ctx: deps.ctx, casePath: actor.caseDir,
      relative: 'scripts/inspect_template.py', ...scopeOptions })
    if (!staged.ok) return reject('infrastructure', '模板检查脚本暂存失败：请由管理员检查插件包和案例写入权限。')
    denied = admissionFailure()
    if (denied !== undefined) return denied
    const run = await deps.access.runShell(
      call,
      shellInvoke(runtime.path, [staged.scriptPath, '--workbook', joinLocalPath(actor.caseDir, relativePath),
        '--template-id', templateId, '--expected-sha256', digest, '--case-root', actor.caseDir], platform),
      { ...scopeOptions, timeoutMs: 120_000, stdoutMaxBytes: 16 * 1024 * 1024, summary: 'valuation template inspection' },
    )
    if (run.aborted || principal.signal?.aborted) return reject('cancelled', '模板检查已取消。')
    if (run.truncated) return reject('file', '模板检查回执超过安全上限被截断，覆盖尚未核实：请拆分过大的模板后重新登记检查。')
    if (!run.ok || run.exitCode !== 0) return reject('file', '模板检查未通过：请确认模板未被替换、格式为有效 xlsx 且仍在本轮案例内，再重新登记。')
    const result = JSON.parse(run.stdout)
    const profile: unknown = result?.profile === null || typeof result?.profile !== 'object'
      ? null : { ...result.profile, relativePath }
    if (result?.ok !== true || !isTemplateProfile(profile) || profile.templateId !== templateId || profile.digest !== digest) {
      return reject('file', '模板检查回执与登记不一致：请重新登记模板并检查。')
    }
    denied = admissionFailure()
    if (denied !== undefined) return denied
    return { ok: true, profile: structuredClone(profile), errorKind: '', error: '' }
  } catch {
    return reject('infrastructure', '模板检查服务执行失败：请由管理员检查文件服务与运行时后重试。')
  }
}
