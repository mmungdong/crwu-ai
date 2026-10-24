import type { TemplateMarketNodeInput, TemplateMarketNodeOutput, TemplateMarketNodeData, TemplateMarketCandidate, TemplateMarketFact,
  TemplateMarketSourceRef, TemplateMarketAttempt, TemplateMarketPlan } from '../../../../shared/contracts/valuation-template-market.ts'
import type { TemplateMarketPorts } from '../../../domains/report-evaluation/workflow/ports.ts'
import { mergeTemplateMarketCandidates } from '../../../domains/report-evaluation/workflow/template-market-candidates.ts'
import { canonicalListingUrl } from '../../../domains/report-evaluation/market/candidates.ts'
import { knowledgeDigest } from '../../../domains/report-evaluation/knowledge/snapshot.ts'
import { parseSitePage } from '../../../domains/report-evaluation/market/site-parsers.ts'
import { normalizeCase } from '../../../domains/report-evaluation/market/normalize.ts'
import { isMarketProviderId } from '../../../domains/report-evaluation/browser/login-state.ts'
import type { WorkflowMarketDispatchResult } from '../market.ts'
import { marketCompleted, marketFailure } from './template-market-output.ts'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const positive = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
function observed(value: string | number | null, unit: string, refs: TemplateMarketSourceRef[]): TemplateMarketFact {
  return { value, unit, status: value === null || value === '' ? 'missing' : refs.length ? 'verified' : 'missing', evidenceRefs: refs }
}
function rowCandidate(row: Record<string, unknown>, plan: TemplateMarketPlan, refs: TemplateMarketSourceRef[]): TemplateMarketCandidate | null {
  const sourceUrl = canonicalListingUrl(row.url), providerId = text(row.source)
  if (!sourceUrl || !plan.providers.includes(providerId)) return null
  const area = positive(row.building_area), price = positive(row.unit_price)
  const priceBasis = ['listing', '挂牌'].includes(text(row.transaction_type)) ? 'listing' : ['deal', '成交', 'transaction'].includes(text(row.transaction_type)) ? 'transaction' : null
  const differences: string[] = []
  if (text(row.community) && text(row.community) !== plan.filters.community) differences.push(`小区不同：${text(row.community)}`)
  if (area !== null && ((plan.filters.areaMin !== null && area < plan.filters.areaMin) || (plan.filters.areaMax !== null && area > plan.filters.areaMax))) differences.push('建筑面积超出已确认范围')
  if (priceBasis !== null && priceBasis !== plan.priceBasis) differences.push('价格性质不符合已确认口径')
  const listFacts = { areaSqm: observed(area, '㎡', refs), unitPrice: observed(price, '元/㎡', refs),
    totalPrice: observed(positive(row.price), '元', refs), priceBasis: observed(priceBasis, '', refs), community: observed(text(row.community), '', refs),
    propertyType: observed(text(row.purpose), '', refs), publishedAt: observed(text(row.published_at), '', refs), capturedAt: observed(text(row.captured_at), '', refs) }
  const address = text(row.address)
  if (address) Object.assign(listFacts, { address: observed(address, '', refs) })
  const missingFields = Object.entries(listFacts).filter(([, f]) => f.status === 'missing').map(([id]) => id)
  return { caseId: `case-${knowledgeDigest(sourceUrl).slice(-24)}`, providerId, sourceUrl, sourceRefs: refs, listFacts, detailFacts: {}, duplicateRefs: [],
    status: differences.some(s => s.includes('超出') || s.includes('性质不符合')) ? 'rejected' : differences.length ? 'nearby' : 'pending',
    similarities: text(row.community) === plan.filters.community ? ['同小区'] : [], differences, missingFields,
    recommendation: differences.length ? '存在差异，请人工核对' : '列表初筛相近，建议读取详情核实', selectionState: 'unselected' }
}
export interface TemplateMarketEvidenceOptions {
  casePath: () => string
  planId: string
  dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<WorkflowMarketDispatchResult>
  readEvidence(path: string, digest?: string): Promise<{ body: string; digest: string; bytes: number }>
  writeCandidates: TemplateMarketPorts['writeCandidates']
}
function approved(input: TemplateMarketNodeInput): TemplateMarketPlan | null {
  const plan = input.upstream['collection-plan']?.plan
  const confirmation = input.upstream['confirm-plan']
  return plan && confirmation?.accepted && confirmation.planDigest === plan.digest ? plan : null
}
export function createTemplateMarketEvidencePorts(options: TemplateMarketEvidenceOptions): Pick<TemplateMarketPorts, 'search' | 'inspectDetails'> {
  const evidencePath = (path: string): string => path.startsWith(`方案/${options.planId}/`) ? path : path.startsWith('方案/') ? '' : `方案/${options.planId}/${path}`
  return {
    async search(input, signal) {
      const plan = approved(input)
      if (!plan || Object.values(plan.budget).some(n => n === null)) return marketFailure('检索前请确认当前方案和预算')
      const previous = input.upstream['search-listings']
      let candidates = structuredClone(previous?.candidates ?? [])
      const attempts: TemplateMarketAttempt[] = structuredClone(previous?.attempts ?? [])
      const used = { ...(previous?.budgetUsed ?? { pages: 0, candidates: 0, durationMs: 0 }) }
      const tasks = previous ? structuredClone(previous.resumeTasks) : plan.providers.map(providerId => ({ providerId, page: 1 }))
      const started = Date.now(), elapsed = (): number => used.durationMs + Date.now() - started
      let stopReason: TemplateMarketNodeData['search-listings']['stopReason'] = 'end'
      while (tasks.length) {
        if (signal?.aborted) { stopReason = 'cancelled'; break }
        if (used.pages >= plan.budget.maxPages! || candidates.length >= plan.budget.maxCandidates! || elapsed() >= plan.budget.maxDurationMs!) { stopReason = 'budget'; break }
        const task = tasks.shift()!
        const timeout = AbortSignal.timeout(Math.max(1, plan.budget.maxDurationMs! - elapsed()))
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
        let result: WorkflowMarketDispatchResult
        try { result = await options.dispatch('crwu_valuation_market_search', { caseDir: options.casePath(), planId: options.planId,
          city: plan.filters.city, keyword: plan.filters.community, providers: [task.providerId], method: 'market', propertyType: plan.filters.propertyType,
          group: `template-market:${knowledgeDigest(plan.subject.objectId).slice(-20)}`, round: input.inputVersion,
          screenshotRequired: false, startPage: task.page, maxPages: 1, maxAttempts: 1 }, requestSignal) }
        catch { result = { ok: false, errorKind: 'execution', error: '列表检索未完成，请核对来源状态后重试' } }
        used.pages += 1
        const value = record(result.value), provider = (Array.isArray(value.providers) ? value.providers : []).map(record).find(p => p.id === task.providerId)
        const rows = (Array.isArray(value.cases) ? value.cases : []).map(record).filter(r => r.source === task.providerId)
        const pageReport = [...(Array.isArray(provider?.retrievalTasks) ? provider.retrievalTasks : []),
          ...(Array.isArray(value.retrievalTasks) ? value.retrievalTasks : [])].map(record)
          .find(p => p.providerId === task.providerId && p.pageNo === task.page)
        const successful = result.ok && value.ok === true && !!provider && pageReport?.state === 'fetched'
        attempts.push({ providerId: task.providerId, action: 'list', page: task.page, caseId: null,
          state: successful ? 'completed' : signal?.aborted ? 'cancelled' : 'failed', errorKind: successful ? '' : signal?.aborted ? 'cancelled' : 'access',
          reason: successful ? '已读取本页列表；详情尚未采集' : '来源列表未取得，已停止本来源；可修复访问后再补搜', sourceRefs: [] })
        const incoming: TemplateMarketCandidate[] = []
        for (const row of rows) {
          let refs: TemplateMarketSourceRef[] = []
          if (text(row.evidence)) try {
            const evidence = await options.readEvidence(evidencePath(text(row.evidence)))
            refs = [{ sourceId: `list-${knowledgeDigest(text(row.evidence)).slice(-24)}`, digest: evidence.digest, location: evidencePath(text(row.evidence)) }]
          } catch { /* Keep the linked candidate unverified. */ }
          const c = rowCandidate(row, plan, refs)
          if (c) incoming.push(c)
        }
        candidates = mergeTemplateMarketCandidates(candidates, incoming).slice(0, plan.budget.maxCandidates!)
        used.candidates = candidates.length
        const notes = Array.isArray(provider?.notes) ? provider.notes.join(' ') : ''
        if (!successful) stopReason = timeout.aborted && !signal?.aborted ? 'budget' : 'access-gap'
        else if (rows.length && !record(provider?.budget).stoppedBy && !/no-results|没有结果|无结果/.test(notes)) tasks.push({ providerId: task.providerId, page: task.page + 1 })
        if (timeout.aborted && !signal?.aborted) { stopReason = 'budget'; break }
      }
      used.durationMs = elapsed()
      const out = marketCompleted<'search-listings'>({ candidates, attempts, budgetUsed: used, resumeTasks: tasks, stopReason }, '本轮列表候选已保存，尚未读取详情')
      if (stopReason !== 'end') { out.outcome = 'completed-with-limits'; out.limitations = [`本轮检索停止原因：${stopReason}，已保留实际取得的候选`] }
      return out
    },
    async inspectDetails(input, signal) {
      const plan = approved(input), selection = input.upstream['select-cases'], workbook = input.upstream['candidate-workbook']
      const all = input.upstream['search-listings']?.candidates ?? []
      if (!plan || !selection || selection.candidateVersion !== workbook?.candidateVersion || selection.selectedCaseIds.some(id => !all.some(c => c.caseId === id && c.status !== 'rejected'))) return marketFailure('案例选择已过期，请重新选择当前候选')
      const selected = structuredClone(all.filter(c => selection.selectedCaseIds.includes(c.caseId)))
      const attempts: TemplateMarketAttempt[] = [], limitations: string[] = [], reselectionCaseIds: string[] = []
      const failedProviders = new Set<string>()
      for (const c of selected) {
        if (signal?.aborted) break
        if (failedProviders.has(c.providerId)) { limitations.push(`${c.caseId}：同来源访问失败，本轮停止连续重试`); continue }
        c.selectionState = 'selected'
        let result: WorkflowMarketDispatchResult
        try { result = await options.dispatch('crwu_valuation_market_capture', { caseDir: options.casePath(), planId: options.planId, source: c.providerId,
          url: c.sourceUrl, caseId: c.caseId, displayName: c.caseId, maxAttempts: 1 }, signal) }
        catch { result = { ok: false, errorKind: 'execution', error: '详情取证未完成' } }
        const value = record(result.value)
        let verified = false
        if (result.ok && value.ok === true && typeof value.status === 'number' && value.status >= 200 && value.status < 300
          && canonicalListingUrl(value.sourceUrl) === canonicalListingUrl(c.sourceUrl) && typeof value.digest === 'string') {
          try {
            const evidence = await options.readEvidence(evidencePath(text(value.file)), value.digest)
            const ref = { sourceId: `detail-${c.caseId}`, digest: evidence.digest, location: evidencePath(text(value.file)) }
            c.sourceRefs.push(ref)
            if (isMarketProviderId(c.providerId)) {
              const parsed = parseSitePage({ providerId: c.providerId, body: evidence.body, finalUrl: c.sourceUrl })
              const raw = parsed.listings.find(r => canonicalListingUrl(r.url) === canonicalListingUrl(c.sourceUrl))
              if (raw) {
                const n = normalizeCase(raw)
                const detailed = rowCandidate({ source: n.source, url: n.url, community: n.community, building_area: n.buildingArea,
                  unit_price: n.unitPrice, price: n.price, purpose: n.purpose, transaction_type: n.transactionType, captured_at: n.capturedAt, published_at: n.publishedAt }, plan, [ref])
                if (detailed) {
                  c.detailFacts = detailed.listFacts
                  for (const [field, fact] of Object.entries(c.detailFacts)) {
                    const list = c.listFacts[field]
                    if (list?.value !== null && fact.value !== null && list?.value !== fact.value) {
                      c.detailFacts[field] = { ...fact, status: 'conflict' }
                      c.differences.push(`${field}：列表 ${String(list?.value)}；详情 ${String(fact.value)}，待核实`)
                    }
                  }
                  if (detailed.status === 'rejected') { c.status = 'rejected'; reselectionCaseIds.push(c.caseId) }
                }
              } else limitations.push(`${c.caseId}：详情结构未识别，原列表事实保留，请人工核实`)
            }
            verified = true
          } catch { limitations.push(`${c.caseId}：详情证据字节未通过核对，请修复证据后补核`) }
        }
        if (!verified) { failedProviders.add(c.providerId); limitations.push(`${c.caseId}：详情未核实，可更换案例或先交付底稿`) }
        const screenshot = text(value.screenshot), shotDigest = text(value.screenshotDigest)
        let screenshotVerified = false
        if (screenshot && shotDigest) try { await options.readEvidence(evidencePath(screenshot), shotDigest); screenshotVerified = true; c.sourceRefs.push({ sourceId: `screenshot-${c.caseId}`, digest: shotDigest, location: evidencePath(screenshot) }) } catch { /* Recorded below. */ }
        if (!screenshotVerified) limitations.push(`${c.caseId}：截图未取得或未验真，请补充截图后复核`)
        attempts.push({ providerId: c.providerId, action: 'detail', page: null, caseId: c.caseId, state: verified ? 'completed' : 'failed', errorKind: verified ? '' : 'access', reason: verified ? '详情证据已核对' : '详情未核，请补核或换例', sourceRefs: c.sourceRefs.filter(r => r.sourceId.startsWith('detail-')) },
          { providerId: c.providerId, action: 'screenshot', page: null, caseId: c.caseId, state: screenshotVerified ? 'completed' : 'failed', errorKind: screenshotVerified ? '' : 'missing', reason: screenshotVerified ? '截图字节已核对' : '截图未核，可后补截图', sourceRefs: c.sourceRefs.filter(r => r.sourceId.startsWith('screenshot-')) })
      }
      const updated = mergeTemplateMarketCandidates(all, selected).map(c => selected.find(s => s.caseId === c.caseId) ?? c)
      const written = await options.writeCandidates({ ...input, nodeId: 'candidate-workbook', upstream: { ...input.upstream,
        'search-listings': { ...input.upstream['search-listings']!, candidates: updated } } }, signal)
      if (!written.data || written.outcome === 'failed') return marketFailure('详情已取得，候选表更新未完成；请恢复本轮工作簿写入后重试')
      const out = marketCompleted<'inspect-details'>({ candidates: selected, attempts, updatedArtifact: written.data.artifact, reselectionCaseIds }, '已核实所选案例并更新候选表')
      out.limitations = limitations
      if (limitations.length) out.outcome = 'completed-with-limits'
      return out
    },
  }
}
