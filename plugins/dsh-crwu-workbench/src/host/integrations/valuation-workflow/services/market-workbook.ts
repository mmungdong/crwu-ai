import { TemplateMarketPortError } from '../../../domains/report-evaluation/workflow/ports.ts'
import type { TemplateMarketNodeInput, TemplateMarketFact, TemplateMarketFillTrace, TemplateMarketArtifact } from '../../../../shared/contracts/valuation-template-market.ts'
import type { TemplateMarketPorts } from '../../../domains/report-evaluation/workflow/ports.ts'
import type { TemplateCellRef } from '../../../../shared/contracts/valuation-template.ts'
import { planFilePath } from '../../../domains/report-evaluation/delivery/finalize-facts.ts'
import { validateTemplateMarketOutput } from '../../../domains/report-evaluation/workflow/template-market-contracts.ts'
import { shellInvoke } from '../../../core/platform/shell.ts'
import { ensureDirectory, writeCaseText } from '../../../tools/common/case-files.ts'
import { stagedValuationScript } from '../../../tools/report-evaluation/artifacts.ts'
import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { requireBoundValuationActor, type ValuationServicePrincipal } from './access.ts'
import { readMarketEvidence } from './market-evidence.ts'
import type { HostWorkflowServiceDeps } from './deps.ts'
import { marketCompleted, marketFailure } from '../production/template-market-output.ts'
import { applicableTemplateMarketDispositions, templateMarketConditionsKey } from '../../../domains/report-evaluation/workflow/template-market-dispositions.ts'
import { knowledgeDigest } from '../../../domains/report-evaluation/knowledge/snapshot.ts'
import { randomUUID } from 'node:crypto'

export function buildMarketFillTrace(input: TemplateMarketNodeInput<'fill-template'>): {
  fillTrace: TemplateMarketFillTrace[]; clearRefs: TemplateCellRef[]; limitations: string[]; adoptedCaseIds: string[]
} {
  const plan = input.upstream['collection-plan']?.plan
  const selected = input.upstream['select-cases']?.selectedCaseIds ?? []
  const latest = input.upstream['inspect-details']?.candidates ?? []
  const cases = (input.upstream['search-listings']?.candidates ?? []).map(c => latest.find(d => d.caseId === c.caseId) ?? c)
  const fillTrace: TemplateMarketFillTrace[] = [], clearRefs: TemplateCellRef[] = [], limitations: string[] = []
  const adoptedCaseIds = selected.filter(id => cases.some(c => c.caseId === id && c.status !== 'rejected'))
  if (!plan) return { fillTrace, clearRefs, limitations: ['未取得计算表字段映射'], adoptedCaseIds: [] }
  const dispositions = applicableTemplateMarketDispositions(input.dispositions, { objectId: plan.subject.objectId, templateDigest: plan.template.digest,
    fieldIds: plan.requirements.fields.map(f => f.fieldId), caseIds: adoptedCaseIds, conditions: templateMarketConditionsKey(plan) })
  for (const field of plan.requirements.fields) {
    for (const [index, target] of field.targetRefs.entries()) {
      const caseId = field.owner === 'case' ? adoptedCaseIds[index] ?? null : null
      if (field.owner === 'case' && caseId === null) { clearRefs.push(target); continue }
      const candidate = caseId ? cases.find(c => c.caseId === caseId) : null
      let fact: TemplateMarketFact | undefined = field.owner === 'case' ? candidate?.detailFacts[field.fieldId] ?? candidate?.listFacts[field.fieldId] : input.facts[field.fieldId]
      const assumption = dispositions.find(d => d.kind === 'accept-assumption' && d.scope.fieldIds.includes(field.fieldId)
        && d.assumption?.value !== null && d.assumption?.unit === field.unit)
      if (fact?.status !== 'verified' && assumption?.assumption) {
        fact = { ...assumption.assumption, status: 'assumed', evidenceRefs: [{ sourceId: assumption.acceptedBySubmissionId,
          digest: knowledgeDigest(JSON.stringify(assumption)), location: '用户确认的情景参数' }] }
        limitations.push(`${field.label} 使用用户确认的情景假设，须另行核验`)
      }
      if (!field.owner || field.applicability !== 'applicable' || ['derived', 'calculation'].includes(field.category)
        || !fact || !(fact.status === 'verified' || (fact.status === 'assumed' && assumption)) || fact.value === null || field.unit === undefined || fact.unit !== field.unit) {
        clearRefs.push(target)
        limitations.push(`${caseId ?? '估价对象'}：${field.label} 待核或单位未绑定，保留空白`)
        continue
      }
      const original = plan.template.cells.find(c => c.sheet === target.sheet && c.cell === target.cell)
      if (original?.formula) { limitations.push(`${field.label} 目标为原模板公式，保留公式且不宣称重算`); continue }
      fillTrace.push({ fieldId: field.fieldId, caseId, sheet: target.sheet, cell: target.cell, fact: structuredClone(fact) })
    }
    if (field.owner === 'case' && adoptedCaseIds.length > field.targetRefs.length) limitations.push(`${field.label} 的案例栏不足，超出部分保留于候选表，不擅自扩列`)
  }
  return { fillTrace, clearRefs, limitations, adoptedCaseIds }
}

export function createMarketWorkbookPort(deps: HostWorkflowServiceDeps, principalOf: () => ValuationServicePrincipal | undefined):
  Pick<TemplateMarketPorts, 'writeCandidates' | 'fillTemplate' | 'verifyDelivery'> {
  const run = async (input: TemplateMarketNodeInput, operation: 'candidates' | 'fill' | 'verify', payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const live = principalOf()
    if (!live) throw new TemplateMarketPortError('没有本轮真实执行，请从当前估值任务重试')
    const combined = signal && live.signal ? AbortSignal.any([signal, live.signal]) : signal ?? live.signal
    const principal = { ...live, ...(combined ? { signal: combined } : {}) }
    const binding = requireBoundValuationActor(principal, deps)
    const plan = input.upstream['collection-plan']?.plan
    if (!binding.ok || !plan || !deps.valuationScopes?.planOf(principal.sessionId, plan.planId)) throw new TemplateMarketPortError('工作簿方案或执行归属已变化，请重新确认本轮方案')
    const call = { operation: 'python.script.run', source: 'audit-tool', workdir: principal.caseDir } as const
    const admit = (): void => {
      const bound = requireBoundValuationActor(principal, deps)
      if (combined?.aborted || !bound.ok || bound.actor.scopeKey !== binding.actor.scopeKey || !deps.access.authorize(call).ok
        || !deps.valuationScopes?.planOf(principal.sessionId, plan.planId)) throw new TemplateMarketPortError('本轮工作簿执行已停止或授权已变化，请恢复当前任务后重试')
    }
    admit()
    if (!deps.python) throw new TemplateMarketPortError('工作簿组件未装配 DSH Python，请管理员检查插件运行时')
    const python = await deps.python.check({ agent: binding.actor.agent })
    if (!python.ok) throw new TemplateMarketPortError(`工作簿 Python/openpyxl ${python.unresolved ? '状态探测失败' : python.state === 'missing-package' ? '已找到运行时但缺少必需包' : python.blockedBySandbox ? '存在但进程被宿主沙箱阻止' : '运行时检查失败'}，请管理员修复 DSH 运行时后重试`)
    admit()
    const platform = await deps.world.platform()
    const scope = { ...(principal.session ? { session: principal.session } : {}), ...(principal.agent ? { agent: principal.agent } : {}), ...(combined ? { signal: combined } : {}) }
    const baseDir = planFilePath(plan.planId, '市场法底稿', input.inputVersion)
    if (!baseDir) throw new TemplateMarketPortError('工作簿方案标识无效，请重新登记本轮方案')
    const outputDir = `${baseDir}/${operation}-${randomUUID()}`
    for (const path of ['scripts', outputDir]) {
      const made = await ensureDirectory(deps.access, joinLocalPath(principal.caseDir, path), { workdir: principal.caseDir, platform, ...scope })
      if (!made.ok || made.postcondition !== 'directory') throw new TemplateMarketPortError('工作簿目录未准备成功，请管理员检查案例目录写入权限')
    }
    admit()
    const staged = await stagedValuationScript({ ctx: deps.ctx, casePath: principal.caseDir, relative: 'scripts/build_market_workpaper.py', ...scope })
    if (!staged.ok) throw new TemplateMarketPortError('工作簿脚本暂存未完成，请管理员检查插件包完整性')
    const inputPath = `${outputDir}/${operation}-input.json`
    const written = await writeCaseText(deps.ctx, joinLocalPath(principal.caseDir, inputPath), `${JSON.stringify({ ...payload, outputDir }, null, 2)}\n`, scope)
    if (!written.ok) throw new TemplateMarketPortError('工作簿输入未保存，请修复本轮案例写入权限后重试')
    admit()
    const result = await deps.access.runShell(call, shellInvoke(python.path, [staged.scriptPath, '--case-root', principal.caseDir, '--input', inputPath, '--operation', operation], platform),
      { ...scope, timeoutMs: 120000, stdoutMaxBytes: 8 * 1024 * 1024, summary: 'valuation market workpaper' })
    admit()
    if (!result.ok || result.exitCode !== 0 || result.truncated) throw new TemplateMarketPortError('工作簿构建或复读校验未通过，请核对模板字节、字段映射与目录权限后重试')
    const parsed: unknown = JSON.parse(result.stdout)
    if (!parsed || typeof parsed !== 'object' || !('ok' in parsed) || parsed.ok !== true || !('data' in parsed) || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) throw new TemplateMarketPortError('工作簿服务回执无效，请管理员核对脚本版本')
    return parsed.data as Record<string, unknown>
  }
  return {
    async writeCandidates(input, signal) {
      const candidates = input.upstream['search-listings']?.candidates ?? []
      const result = await run(input, 'candidates', { candidates }, signal)
      const out = marketCompleted<'candidate-workbook'>({ candidateVersion: input.candidateVersion, caseIds: candidates.map(c => c.caseId), artifact: result.artifact as TemplateMarketArtifact }, '候选案例 Excel 已生成并复读核对')
      if (!validateTemplateMarketOutput('candidate-workbook', out).ok) return marketFailure('候选工作簿回执与当前版本不一致，请重试工作簿节点')
      const principal = principalOf()!
      await readMarketEvidence(deps, principal, out.data!.artifact.relativePath, out.data!.artifact.digest)
      return out
    },
    async fillTemplate(input, signal) {
      const plan = input.upstream['collection-plan']?.plan
      if (!plan) return marketFailure('原模板尚未确认，请先选择本轮计算表')
      const trace = buildMarketFillTrace(input)
      const candidates = input.upstream['search-listings']?.candidates ?? []
      const decision = input.upstream['check-inputs']?.decision
      const limitations = [...trace.limitations, ...(decision?.limitations ?? []), '原模板尚未执行重算；仅交付已填底稿，不能作为正式估值结论']
      const result = await run(input, 'fill', { template: plan.template, ...trace, candidates, limitations }, signal)
      const adoptedCandidates = candidates.map(c => ({ ...c, selectionState: trace.adoptedCaseIds.includes(c.caseId) ? 'adopted' : c.selectionState }))
      const candidateResult = await run(input, 'candidates', { candidates: adoptedCandidates }, signal)
      if (Array.isArray(result.artifacts)) result.artifacts.push(candidateResult.artifact)
      const out = marketCompleted<'fill-template'>(result as unknown as NonNullable<Awaited<ReturnType<TemplateMarketPorts['fillTemplate']>>['data']>, '已保存原模板的项目副本与逐字段填表轨迹')
      out.outcome = 'completed-with-limits'; out.limitations = limitations
      if (!validateTemplateMarketOutput('fill-template', out).ok || out.data?.calculation !== null || out.data.recalculation !== 'not-run') return marketFailure('回填成果未通过字段或计算性质核对，请复核工作簿')
      return out
    },
    async verifyDelivery(input, signal) {
      const plan = input.upstream['collection-plan']?.plan, filled = input.upstream['fill-template']
      if (!plan || !filled || filled.calculation !== null || filled.recalculation !== 'not-run') return marketFailure('交付需要本轮原模板回填底稿与真实填表轨迹')
      const selected = input.upstream['select-cases']?.selectedCaseIds ?? []
      if (filled.adoptedCaseIds.some(id => !selected.includes(id))) return marketFailure('回填采用了未确认的案例，请重新核对案例选择')
      const original = input.upstream['search-listings']?.candidates ?? [], details = input.upstream['inspect-details']
      const candidates = original.map(c => ({ ...(details?.candidates.find(d => d.caseId === c.caseId) ?? c),
        selectionState: filled.adoptedCaseIds.includes(c.caseId) ? 'adopted' as const : c.selectionState }))
      const candidateArtifact = details?.updatedArtifact ?? input.upstream['candidate-workbook']?.artifact
      const artifacts = [...filled.artifacts, ...(!filled.artifacts.some(a => a.kind === 'candidates') && candidateArtifact ? [candidateArtifact] : [])]
      const checked = await run(input, 'verify', { artifacts, template: plan.template, fillTrace: filled.fillTrace, adoptedCaseIds: filled.adoptedCaseIds, candidates }, signal)
      const principal = principalOf()!
      for (const file of artifacts) await readMarketEvidence(deps, principal, file.relativePath, file.digest)
      const unverifiedItems = [...(input.upstream['check-inputs']?.decision.limitations ?? []), ...candidates.filter(c => selected.includes(c.caseId)).flatMap(c => c.missingFields.map(f => `${c.caseId}：${f} 待核`)),
        '原模板重算、专业判断与最终估值结论尚未核实']
      const out = marketCompleted<'validate-delivery'>({ verifiedArtifacts: checked.verifiedArtifacts as TemplateMarketArtifact[], deliveryKind: 'workpaper', unverifiedItems,
        recoveryActions: ['在 Excel 中复核原模板公式与待核字段，补齐证据后按机构流程复核'] }, '已校验候选案例表、原模板回填副本和填表轨迹')
      if (!validateTemplateMarketOutput('validate-delivery', out).ok) return marketFailure('交付回执格式无效，请重新校验本轮成果')
      out.outcome = 'completed-with-limits'; out.limitations = unverifiedItems
      return out
    },
  }
}
