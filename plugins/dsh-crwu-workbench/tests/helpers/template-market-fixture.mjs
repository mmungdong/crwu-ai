export const digest = `sha256:${'a'.repeat(64)}`
export const profile = () => ({ templateId: 'residential', digest, relativePath: '材料/住宅.xlsx',
  sheets: [{ name: '测算', rows: 8, columns: 4, mergedRanges: [] }],
  cells: [{ sheet: '测算', cell: 'A2', value: '建筑面积', formula: '' }],
  definedNames: [], coverage: { complete: true, issues: [] } })
export const requirements = () => ({ templateId: 'residential', templateDigest: digest, version: 1,
  fields: [{ owner: 'subject', unit: '㎡', fieldId: 'areaSqm', label: '建筑面积', labelRef: { sheet: '测算', cell: 'A2' },
    targetRefs: [{ sheet: '测算', cell: 'B2' }], category: 'source-fact', applicability: 'applicable',
    criticalFor: ['calculation'], basis: [{ sourceId: 'kb', quote: '取得建筑面积' }] }], questions: [] })
export const source = () => ({ sourceId: 'kb', digest, location: '住宅说明#面积' })
export const fact = (value, unit = '', status = 'verified') => ({ value, unit, status, evidenceRefs: value === null ? [] : [source()] })
export const plan = () => ({ planId: 'collection-1', digest, template: profile(), requirements: requirements(),
  subject: { objectId: 'object-1', useLabel: '住宅', areaSqm: 80 },
  filters: { city: '北京', district: '', community: '合成小区', propertyType: '二手住宅', areaMin: null, areaMax: null },
  priceBasis: 'listing', providers: ['lianjia'],
  budget: { maxPages: 2, maxCandidates: 20, maxDurationMs: 60000 },
  stopRules: ['末页或达到已确认预算后停止'], proposedDispositions: [] })
export const candidate = (caseId = 'case-1') => ({ caseId, providerId: 'lianjia',
  sourceUrl: `https://bj.lianjia.com/ershoufang/${caseId}.html`, sourceRefs: [source()],
  listFacts: { areaSqm: fact(81, '㎡'), unitPrice: fact(60000, '元/㎡'), priceBasis: fact('listing') },
  detailFacts: {}, duplicateRefs: [], status: 'pending', similarities: ['同小区'], differences: [],
  missingFields: [], recommendation: '建议核实', selectionState: 'unselected' })
export const artifact = () => ({ relativePath: '成果/候选案例表.xlsx', digest, bytes: 1024, kind: 'candidates' })
export const output = (data, outcome = 'completed') => ({ outcome, summary: '已完成', data, questions: [], limitations: [], failure: null })
export const scope = () => ({ objectId: 'object-1', templateDigest: digest, fieldIds: ['areaSqm'], caseIds: ['case-1'], conditions: JSON.stringify({ priceBasis: plan().priceBasis, ...plan().filters }) })
export const disposition = () => ({ dispositionId: 'defer-area', kind: 'defer-verification', scope: scope(),
  reason: '先整理已取得资料', assumption: null, acceptedBySubmissionId: 'submit-1' })
export const input = (nodeId = 'materials') => ({ runId: 'run-1', nodeId, candidateVersion: 0, inputVersion: 1, initialInput: null,
  facts: {}, upstream: {}, knowledge: [], capabilities: [], answers: {}, notes: [], dispositions: [] })

export function marketPorts(calls = []) {
  const port = (name, data) => async (input) => { calls.push({ name, input: structuredClone(input) }); return output(typeof data === 'function' ? data(input) : structuredClone(data)) }
  return {
    readTemplates: port('templates', { catalog: [{ templateId: 'residential', relativePath: '材料/住宅.xlsx', digest }],
      profiles: [profile()], instructions: [{ ...source(), body: '取得建筑面积' }],
      technicalStatus: [{ templateId: 'residential', canFill: true, canCalculate: false, reasons: ['公式待核'] }] }),
    readMaterials: port('materials', { subjectFacts: { areaSqm: fact(80, '㎡') }, sourceRefs: [source()], unverifiedFields: [] }),
    plan: port('plan', { plan: plan() }),
    search: port('search', { candidates: [candidate('case-1'), candidate('case-2')], attempts: [],
      budgetUsed: { pages: 1, candidates: 2, durationMs: 50 }, resumeTasks: [], stopReason: 'end' }),
    writeCandidates: port('workbook', input => ({ candidateVersion: input.candidateVersion, caseIds: input.upstream['search-listings']?.candidates.map(c => c.caseId) ?? [], artifact: artifact() })),
    inspectDetails: port('details', input => ({ candidates: input.upstream['search-listings'].candidates.filter(c => input.upstream['select-cases'].selectedCaseIds.includes(c.caseId)),
      attempts: [], updatedArtifact: artifact(), reselectionCaseIds: [] })),
    fillTemplate: port('fill', input => ({ artifacts: [{ ...artifact(), kind: 'workpaper', relativePath: '成果/项目底稿.xlsx' }],
      adoptedCaseIds: input.upstream['select-cases'].selectedCaseIds, fillTrace: [], calculation: null, recalculation: 'not-run' })),
    verifyDelivery: port('verify', input => ({ verifiedArtifacts: input.upstream['fill-template'].artifacts,
      deliveryKind: 'workpaper', unverifiedItems: ['公式未核'], recoveryActions: ['复核原模板公式后补算'] })),
  }
}
