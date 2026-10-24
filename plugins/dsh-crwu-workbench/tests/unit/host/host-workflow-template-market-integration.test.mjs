import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySaver } from '@langchain/langgraph'
import { marketPorts } from '../../helpers/template-market-fixture.mjs'
import { createValuationWorkflowService } from '../../../src/host/domains/report-evaluation/workflow/service.ts'

const start = () => ({ runId: 'v2-integrated', object: { objectId: 'object-1', useLabel: '住宅', areaSqm: 80 },
  initialInput: { userInput: '北京合成小区', assetType: 'real-estate', methodRequest: 'market', purpose: null,
    baseDate: null, valueType: null, templateFileId: null, supplementalPrompt: '', inputDigest: null, files: [] } })
const answer = (snapshot, nodeId, answers, submissionId) => ({ runId: snapshot.runId, nodeId, expectedRevision: snapshot.revision,
  expectedQuestionVersion: snapshot.questionnaire.version, answers, supplement: '', noteEdits: {}, submissionId })
const approval = snapshot => answer(snapshot, 'confirm-plan', { 'confirm-plan:approval': { kind: 'choice', values: ['accept'], supplement: '缺项先留空' } }, 'approve-1')

test('v2 real graph uses the supplied durable saver and persists its waiting boundary', async () => {
  const checkpointer = new MemorySaver(), calls = []
  const service = createValuationWorkflowService({ templateMarket: marketPorts(calls) }, { checkpointer })
  const result = await service.start(start())
  assert.equal(result.snapshot.status, 'waiting-user')
  const tuples = []
  for await (const tuple of checkpointer.list({ configurable: { thread_id: 'v2-integrated' } })) tuples.push(tuple)
  assert.ok(tuples.length > 0, 'the actual v2 invocation must persist LangGraph checkpoints')
  assert.ok(tuples.some(t => t.checkpoint.channel_values.stage === 'confirm-plan'))
  service.dispose()
})

test('changed business input revokes old approval and keeps original input and amendment provenance', async () => {
  const calls = [], service = createValuationWorkflowService({ templateMarket: marketPorts(calls) })
  const started = await service.start(start())
  const approved = await service.submitQuestions(approval(started.snapshot))
  assert.equal(approved.snapshot.templateMarket.currentNode, 'select-cases')
  const revised = await service.revise({ runId: started.snapshot.runId, nodeId: 'collection-plan', expectedRevision: approved.snapshot.revision,
    submissionId: 'revise-purpose', reason: '目的改变', source: '员工明确修订', changes: [{ field: 'purpose', value: '抵押评估' }] })
  assert.equal(revised.snapshot.templateMarket.currentNode, 'confirm-plan')
  assert.equal(revised.snapshot.status, 'waiting-user')
  assert.equal(calls.filter(c => c.name === 'search').length, 1, 'old confirmation cannot authorize the changed purpose')
  assert.deepEqual(revised.snapshot.templateMarket.initialInput, start().initialInput)
  assert.ok(revised.snapshot.revisions.some(r => r.reason === '目的改变' && r.changes.some(c => c.field === 'purpose' && c.after === '抵押评估')))
  const count = revised.snapshot.questionnaire.submissions.length
  const stale = await service.submitQuestions(answer(revised.snapshot, 'select-cases', {}, 'stale-old-node'))
  assert.equal(stale.ok, false)
  assert.equal((await service.get(started.snapshot.runId)).questionnaire.submissions.length, count)
  service.dispose()
})

test('two confirmations carry scoped limits to delivery and only chosen cases reach details', async () => {
  const calls = [], service = createValuationWorkflowService({ templateMarket: marketPorts(calls) })
  const started = await service.start(start())
  const approved = await service.submitQuestions(approval(started.snapshot))
  const submission = answer(approved.snapshot, 'select-cases', {
    'select-cases:caseIds': { kind: 'choice', values: ['case-2'], supplement: '采用第二个案例' },
    'select-cases:searchDecision': { kind: 'choice', values: ['stop'], supplement: '' },
  }, 'select-1')
  const delivered = await service.submitQuestions(submission)
  assert.equal(delivered.snapshot.status, 'partial')
  assert.equal(delivered.snapshot.delivery.formalComplete, false)
  assert.deepEqual(calls.find(c => c.name === 'details').input.upstream['select-cases'].selectedCaseIds, ['case-2'])
  const limits = delivered.snapshot.templateMarket.dispositions
  assert.ok(limits.some(d => d.kind === 'stop-search' && d.acceptedBySubmissionId === 'select-1'))
  assert.ok(calls.find(c => c.name === 'fill').input.dispositions.length > 0)
  assert.equal((await service.submitQuestions(submission)).ok, true)
  assert.equal(calls.filter(c => c.name === 'details').length, 1)
  service.dispose()
})

test('real Host runtime accepts v2 drafts, queued answers and explicit retry intents', async () => {
  const { ValuationScopes } = await import('../../../src/host/domains/report-evaluation/scope.ts')
  const { createValuationWorkflowRuntime } = await import('../../../src/host/integrations/valuation-workflow/runtime.ts')
  const scopes = new ValuationScopes()
  scopes.open({ valuationId: 'p', projectId: 'p', sessionId: 'parent', parentSessionId: 'parent', casePath: '/workspace/p',
    workspaceId: 'w', workspacePath: '/workspace', openedAt: 1 })
  const runtime = createValuationWorkflowRuntime({ scopes, createRunner: async () => ({
    service: createValuationWorkflowService({ templateMarket: marketPorts() }), startInput: async () => start() }) })
  const exec = { token: Symbol('actual'), rootCallId: 'root', agent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal }
  const started = await runtime.execute(runtime.register({ projectId: 'p', parentSessionId: 'parent' }).commandId, exec)
  const { runId, submissionId, ...draft } = approval(started.snapshot)
  const saved = await runtime.saveDraft('p', draft)
  assert.equal(saved.ok, true, saved.error)
  const submitted = { ...approval(saved.snapshot), submissionId: 'queued-v2' }
  delete submitted.runId
  const queued = runtime.queue('p', { action: 'questions-submit', payload: submitted })
  assert.equal(queued.ok, true, queued.error)
  const selected = await runtime.execute(queued.commandId, exec)
  assert.equal(selected.snapshot.templateMarket.currentNode, 'select-cases')
  const retry = runtime.queue('p', { action: 'revise', payload: { nodeId: 'select-cases', expectedRevision: selected.snapshot.revision,
    submissionId: 'retry-v2', reason: '补充当前节点', source: '员工', changes: [{ field: 'promptSupplement', value: '保留现有案例，核对本轮要求' }] } })
  assert.equal(retry.ok, true, retry.error)
  runtime.dispose()
})

test('panel resolves only registered v2 node identities and current workbook artifacts', async () => {
  const { stageOfCompiledNode, resolveWorkflowArtifact } = await import('../../../src/host/integrations/valuation-workflow/production/operations.ts')
  const { workflowGraphView } = await import('../../../src/host/integrations/valuation-workflow/production/view.ts')
  const graph = await workflowGraphView('2')
  assert.equal(stageOfCompiledNode(graph, 'select-cases').stage, 'select-cases')
  assert.equal(stageOfCompiledNode(graph, 'foreign:select-cases').ok, false)
  const { artifact } = await import('../../helpers/template-market-fixture.mjs')
  const dto = { templateMarket: { artifacts: [artifact()], plan: null } }
  assert.equal(resolveWorkflowArtifact({ kind: 'candidates', dto, receipt: null }).artifact?.relativePath, artifact().relativePath)
})

test('drafts saved during a long detail call survive the remaining node receipts', async () => {
  const ports = marketPorts(), original = ports.inspectDetails
  let release, entered
  const running = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  ports.inspectDetails = async (...args) => { entered(); await barrier; return original(...args) }
  const service = createValuationWorkflowService({ templateMarket: ports })
  const started = await service.start(start()), approved = await service.submitQuestions(approval(started.snapshot))
  const pending = service.submitQuestions(answer(approved.snapshot, 'select-cases', {
    'select-cases:caseIds': { kind: 'choice', values: ['case-1'], supplement: '' },
    'select-cases:searchDecision': { kind: 'choice', values: ['stop'], supplement: '' },
  }, 'long-details'))
  await running
  const current = await service.get(started.snapshot.runId)
  const saved = await service.saveDraft({ ...answer(current, 'inspect-details', {}, 'unused'), supplement: '执行期间新增的待核说明' })
  assert.equal(saved.ok, true)
  release()
  const finished = await pending
  assert.equal(finished.snapshot.questionnaire.drafts.find(d => d.nodeId === 'inspect-details')?.supplement, '执行期间新增的待核说明')
  service.dispose()
})

test('all candidates within the approved 200-row budget remain selectable', async () => {
  const { candidate, output, plan } = await import('../../helpers/template-market-fixture.mjs')
  const ports = marketPorts()
  ports.plan = async () => { const p = plan(); p.budget.maxCandidates = 200; return output({ plan: p }) }
  ports.search = async () => output({ candidates: Array.from({ length: 60 }, (_, i) => candidate(`case-${i}`)), attempts: [],
    budgetUsed: { pages: 1, candidates: 60, durationMs: 100 }, resumeTasks: [], stopReason: 'end' })
  const service = createValuationWorkflowService({ templateMarket: ports })
  const started = await service.start(start()), approved = await service.submitQuestions(approval(started.snapshot))
  assert.equal(approved.snapshot.status, 'waiting-user')
  assert.equal(approved.snapshot.questionnaire.questions.find(q => q.field === 'caseIds').options.length, 60)
  service.dispose()
})

test('assumptions require confirmation against the actual selected cases and survive history restore', async () => {
  const { plan } = await import('../../helpers/template-market-fixture.mjs')
  const calls = [], ports = marketPorts(calls), p = plan()
  p.proposedDispositions = [{ dispositionId: 'assume-area', kind: 'accept-assumption',
    scope: { objectId: p.subject.objectId, templateDigest: p.template.digest, fieldIds: ['areaSqm'], caseIds: [], conditions: '' },
    reason: '员工提出面积情景', assumption: { value: 90, unit: '㎡' }, acceptedBySubmissionId: '' }]
  ports.plan = async () => ({ outcome: 'completed', summary: '情景待确认', data: { plan: p }, questions: [], limitations: [], failure: null })
  const service = createValuationWorkflowService({ templateMarket: ports })
  const started = await service.start(start()), approved = await service.submitQuestions(approval(started.snapshot))
  assert.match(approved.snapshot.questionnaire.questions.find(q => q.field === 'assumptions')?.prompt ?? '', /90.*㎡/)
  const delivered = await service.submitQuestions(answer(approved.snapshot, 'select-cases', {
    'select-cases:caseIds': { kind: 'choice', values: ['case-2'], supplement: '' },
    'select-cases:searchDecision': { kind: 'choice', values: ['stop'], supplement: '' },
    'select-cases:assumptions': { kind: 'choice', values: ['accept'], supplement: '' },
  }, 'accept-case-assumptions'))
  const disposition = calls.find(c => c.name === 'fill').input.dispositions.find(d => d.acceptedBySubmissionId === 'accept-case-assumptions' && d.kind === 'accept-assumption')
  assert.deepEqual(disposition.scope.caseIds, ['case-2'])
  const revised = await service.revise({ runId: delivered.snapshot.runId, nodeId: 'collection-plan', expectedRevision: delivered.snapshot.revision,
    submissionId: 'change-after-delivery', reason: '修改用途', source: '员工', changes: [{ field: 'useLabel', value: '公寓' }] })
  assert.ok(revised.snapshot.revisions.some(r => r.templateMarket?.receipts['validate-delivery']?.output))
  service.dispose()
})

test('changing collection conditions through Other clears old search and pagination before new approval', async () => {
  const { plan, output } = await import('../../helpers/template-market-fixture.mjs')
  const calls = [], ports = marketPorts(calls)
  let revision = 0
  ports.plan = async () => { const p = plan(); p.filters.community = revision++ ? '另一个小区' : '合成小区'; p.digest = `sha256:${String(revision).repeat(64)}`; return output({ plan: p }) }
  const service = createValuationWorkflowService({ templateMarket: ports })
  const started = await service.start(start()), approved = await service.submitQuestions(approval(started.snapshot))
  const replanned = await service.submitQuestions(answer(approved.snapshot, 'select-cases', {
    'select-cases:caseIds': { kind: 'other', text: '改成另一个小区' },
    'select-cases:searchDecision': { kind: 'choice', values: ['stop'], supplement: '' },
  }, 'change-community'))
  assert.equal(replanned.snapshot.templateMarket.currentNode, 'confirm-plan')
  assert.equal(replanned.snapshot.templateMarket.receipts['search-listings'], undefined)
  assert.deepEqual(replanned.snapshot.templateMarket.candidates, [])
  const next = await service.submitQuestions({ ...approval(replanned.snapshot), submissionId: 'approve-new-plan' })
  const searches = calls.filter(c => c.name === 'search')
  assert.equal(searches.length, 2)
  assert.equal(searches[1].input.upstream['search-listings'], undefined)
  assert.equal(next.snapshot.templateMarket.plan.filters.community, '另一个小区')
  assert.ok(next.snapshot.revisions.some(r => r.templateMarket?.candidates.length === 2))
  service.dispose()
})

test('employee may defer case adoption with a reason and still receive an explicitly limited workpaper', async () => {
  const calls = [], service = createValuationWorkflowService({ templateMarket: marketPorts(calls) })
  const started = await service.start(start()), approved = await service.submitQuestions(approval(started.snapshot))
  assert.equal(approved.snapshot.questionnaire.questions.find(q => q.field === 'caseIds').allowDefer, true)
  const finished = await service.submitQuestions(answer(approved.snapshot, 'select-cases', {
    'select-cases:caseIds': { kind: 'defer', reason: '这些案例尚未核实，先整理空白底稿' },
    'select-cases:searchDecision': { kind: 'choice', values: ['stop'], supplement: '' },
  }, 'defer-cases'))
  assert.equal(finished.snapshot.status, 'partial')
  assert.deepEqual(calls.find(c => c.name === 'details').input.upstream['select-cases'].selectedCaseIds, [])
  assert.ok(finished.snapshot.templateMarket.dispositions.some(d => d.kind === 'defer-verification' && d.reason === '这些案例尚未核实，先整理空白底稿' && d.acceptedBySubmissionId === 'defer-cases'))
  service.dispose()
})

test('initial purpose and date reach template facts and v2 retains real global revision owners', async () => {
  const { workflowGraphView, projectStoredWorkflow } = await import('../../../src/host/integrations/valuation-workflow/production/view.ts')
  const calls = [], service = createValuationWorkflowService({ templateMarket: marketPorts(calls) })
  const request = start(); request.initialInput.purpose = '抵押评估'; request.initialInput.baseDate = '2026-10-21'
  const result = await service.start(request)
  assert.equal(calls.find(c => c.name === 'materials').input.facts.purpose?.value, '抵押评估')
  assert.equal(calls.find(c => c.name === 'materials').input.facts.baseDate?.value, '2026-10-21')
  const graph = await workflowGraphView('2')
  const progress = projectStoredWorkflow({ snapshot: result.snapshot, graph, selectedNodeId: 'confirm-plan' }).progress
  for (const field of ['areaSqm', 'useLabel', 'purpose', 'baseDate']) {
    const entry = progress.globalInputs.find(f => f.field === field)
    assert.equal(entry?.editable, true)
    assert.ok(graph.nodes.some(n => n.nodeId === entry.nodeId))
  }
  assert.equal(progress.globalInputs.find(f => f.field === 'purpose').value, '抵押评估')
  service.dispose()
})

test('saved supplemental notes and choice explanations remain effective during replanning', async () => {
  const { output, plan } = await import('../../helpers/template-market-fixture.mjs')
  const calls = [], ports = marketPorts(calls)
  ports.plan = async input => { calls.push({ name: 'plan', input: structuredClone(input) }); return output({ plan: plan() }) }
  const service = createValuationWorkflowService({ templateMarket: ports })
  const started = await service.start(start())
  const changed = await service.submitQuestions({ ...answer(started.snapshot, 'confirm-plan', {
    'confirm-plan:approval': { kind: 'choice', values: ['amend'], supplement: '小区改成新小区' },
  }, 'explain-replan'), supplement: '请把采集城市改成上海' })
  assert.equal(changed.ok, true)
  const latest = calls.filter(c => c.name === 'plan').at(-1).input
  assert.ok(latest.notes.some(n => n.nodeId === 'confirm-plan' && n.text === '请把采集城市改成上海'))
  assert.equal(latest.answers['confirm-plan:approval'].supplement, '小区改成新小区')
  service.dispose()
})

test('global current values show adopted material facts when the entry object was incomplete', async () => {
  const { workflowGraphView, projectStoredWorkflow } = await import('../../../src/host/integrations/valuation-workflow/production/view.ts')
  const { fact, output } = await import('../../helpers/template-market-fixture.mjs')
  const ports = marketPorts(); ports.readMaterials = async i => output({ subjectFacts: { ...i.facts, areaSqm: fact(85, '㎡') }, sourceRefs: [], unverifiedFields: [] })
  const service = createValuationWorkflowService({ templateMarket: ports }), request = start(); request.object.areaSqm = null
  const result = await service.start(request)
  const progress = projectStoredWorkflow({ snapshot: result.snapshot, graph: await workflowGraphView('2'), selectedNodeId: 'confirm-plan' }).progress
  assert.equal(progress.globalInputs.find(f => f.field === 'areaSqm').rawValue, 85)
  service.dispose()
})


test('an unknown child stop settles the parent failure and forbids a replacement retry', async () => {
  const ports = marketPorts()
  ports.readTemplates = async () => { throw Object.assign(new Error('synthetic child stop'), { errorKind: 'stop-unknown', sessionId: 'child-still-unknown' }) }
  const service = createValuationWorkflowService({ templateMarket: ports })
  const result = await service.start(start())
  assert.equal(result.snapshot.status, 'failed')
  assert.equal(result.snapshot.templateMarket.status, 'failed')
  assert.ok(result.snapshot.error)
  assert.equal(Object.values(result.snapshot.templateMarket.receipts).some(r => r.state === 'running'), false)
  assert.equal(result.snapshot.errorKind, 'stop-unknown')
  const retried = await service.revise({ runId: result.snapshot.runId, nodeId: 'templates', expectedRevision: result.snapshot.revision,
    submissionId: 'unsafe-retry', changes: [], reason: '员工重试', source: '员工' })
  assert.equal(retried.ok, false)
  assert.equal(retried.errorKind, 'stop-unknown')
  service.dispose()
})

test('explicit retry reruns the failed preparation in the same run without fabricating business changes', async () => {
  const calls = [], ports = marketPorts(calls)
  const read = ports.readTemplates
  let broken = true
  ports.readTemplates = async (...args) => broken
    ? { outcome: 'failed', summary: '模板服务暂时失败', data: null, questions: [], limitations: [],
      failure: { kind: 'system', reason: '模板读取失败', requirements: [], actions: ['修复后重试'] } }
    : read(...args)
  const service = createValuationWorkflowService({ templateMarket: ports })
  const started = await service.start(start())
  assert.equal(started.snapshot.status, 'failed')
  const beforeFacts = structuredClone(started.snapshot.templateMarket.facts)
  const materialsBefore = calls.filter(c => c.name === 'materials').length
  broken = false
  const retry = { runId: started.snapshot.runId, nodeId: 'templates', expectedRevision: started.snapshot.revision,
    submissionId: 'retry-failed-templates', changes: [], reason: '修复模板服务后重试', source: '员工点击重试' }
  const resumed = await service.revise(retry)
  assert.equal(resumed.ok, true, resumed.error)
  assert.equal(resumed.snapshot.runId, started.snapshot.runId)
  assert.equal(resumed.snapshot.status, 'waiting-user')
  assert.equal(resumed.snapshot.templateMarket.currentNode, 'confirm-plan')
  assert.deepEqual(resumed.snapshot.templateMarket.facts, beforeFacts)
  assert.equal(calls.filter(c => c.name === 'materials').length, materialsBefore)
  const count = calls.length
  await service.revise(retry)
  assert.equal(calls.length, count)
  const invalid = await service.revise({ ...retry, expectedRevision: resumed.snapshot.revision, submissionId: 'not-failed-anymore' })
  assert.equal(invalid.ok, false)
  service.dispose()
})


test('Host projects an interrupted legacy running receipt as failed with its actual error and retry policy', async () => {
  const { projectWorkflowSnapshot } = await import('../../../src/host/domains/report-evaluation/workflow/views.ts')
  const { TEMPLATE_MARKET_NODES } = await import('../../../src/shared/contracts/valuation-template-market.ts')
  const service = createValuationWorkflowService({ templateMarket: marketPorts() })
  const result = await service.start(start())
  const snapshot = structuredClone(result.snapshot)
  snapshot.status = 'failed'; snapshot.outcome = 'failed'; snapshot.error = '本轮执行已中断'; snapshot.errorKind = 'failed'
  snapshot.templateMarket.status = 'running'; snapshot.templateMarket.currentNode = 'templates'
  snapshot.templateMarket.receipts = Object.fromEntries(['templates', 'materials'].map(nodeId => [nodeId,
    { nodeId, state: 'running', attempt: 1, inputVersion: 1, inputs: null, output: null, updatedAt: snapshot.updatedAt }]))
  const graph = { graphId: 'v2-test', version: '2', nodes: TEMPLATE_MARKET_NODES.map(id => ({ nodeId: `graph:${id}`, templateMarketNodeId: id, label: id, state: 'pending', gaps: [] })), edges: [] }
  const projected = projectWorkflowSnapshot({ snapshot, graph, selectedNodeId: 'graph:templates' })
  assert.equal(projected.progress.graph.nodes[0].state, 'failed')
  assert.equal(projected.progress.graph.nodes[1].state, 'failed')
  assert.ok(projected.detail.gaps.includes(snapshot.error))
  assert.equal(projected.detail.failure.reason, snapshot.error)
  assert.equal(projected.progress.market.recovery.retryAllowed, true)
  snapshot.errorKind = 'stop-unknown'
  const unknown = projectWorkflowSnapshot({ snapshot, graph, selectedNodeId: 'graph:templates' })
  assert.equal(unknown.progress.market.recovery.retryAllowed, false)
  service.dispose()
})


test('retry transport accepts an empty market patch and still rejects empty legacy revisions and forged nodes', async () => {
  const { parseWorkflowAction } = await import('../../../src/host/integrations/valuation-workflow/production/operations.ts')
  const { workflowGraphView } = await import('../../../src/host/integrations/valuation-workflow/production/view.ts')
  const graph = await workflowGraphView('2')
  const nodeId = graph.nodes.find(n => n.templateMarketNodeId === 'templates').nodeId
  const args = { action: 'revise', payload: { nodeId, expectedRevision: 1, submissionId: 'retry', reason: '修复后重试', source: '员工', changes: [] } }
  const parsed = parseWorkflowAction(args, graph)
  assert.equal(parsed.ok, true, parsed.error)
  assert.equal(parsed.payload.nodeId, 'templates')
  assert.deepEqual(parsed.payload.changes, [])
  assert.equal(parseWorkflowAction({ ...args, payload: { ...args.payload, nodeId: 'foreign:templates' } }, graph).ok, false)
  const legacy = await workflowGraphView('1')
  assert.equal(parseWorkflowAction({ ...args, payload: { ...args.payload, nodeId: 'valuation:realestate:elements' } }, legacy).ok, false)
})


test('a late parallel preparation cannot overwrite a settled stop-unknown failure', async () => {
  const ports = marketPorts(), original = ports.readMaterials
  let release, entered, finished
  const barrier = new Promise(resolve => { release = resolve })
  const startedMaterial = new Promise(resolve => { entered = resolve })
  const finishedMaterial = new Promise(resolve => { finished = resolve })
  ports.readTemplates = async () => { await startedMaterial; throw Object.assign(new Error('synthetic unknown stop'), { errorKind: 'stop-unknown', sessionId: 'unknown-child' }) }
  ports.readMaterials = async (...args) => { entered(); await barrier; const value = await original(...args); finished(); return value }
  const saved = []
  const service = createValuationWorkflowService({ templateMarket: ports }, { persistence: { save: async image => saved.push(structuredClone(image)) } })
  const failed = await service.start(start())
  assert.equal(failed.snapshot.status, 'failed')
  release()
  await finishedMaterial
  await new Promise(resolve => setTimeout(resolve, 30))
  const latest = await service.get(failed.snapshot.runId)
  assert.equal(latest.status, 'failed')
  assert.equal(latest.errorKind, 'stop-unknown')
  assert.equal(latest.templateMarket.status, 'failed')
  assert.equal(saved.at(-1).status, 'failed')
  const blocked = await service.revise({ runId: latest.runId, nodeId: 'templates', expectedRevision: latest.revision,
    submissionId: 'still-blocked', changes: [], reason: '重试', source: '员工' })
  assert.equal(blocked.errorKind, 'stop-unknown')
  service.dispose()
})
