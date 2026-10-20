import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdtemp, mkdir, stat, realpath, rm, rename, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'
import { WORKBENCH_PROTOCOL } from '../../../src/shared/consts.ts'
import { VALUATION_INPUT_SCHEMA_VERSION } from '../../../src/shared/contracts/valuation-project.ts'
import { buildFrozenInput } from '../../../src/host/domains/report-evaluation/project/contracts.ts'
import { valuationInputDigest } from '../../../src/host/domains/report-evaluation/intake/preview.ts'
import { buildProjectRecord, PROJECT_RECORD_FILE, PROJECT_RECORD_SCHEMA_VERSION } from '../../../src/host/domains/report-evaluation/lifecycle/project-record.ts'

const operationNames = [
  'valuation-workflow-current', 'valuation-workflow-node', 'valuation-workflow-action',
  'valuation-workflow-preview', 'valuation-workflow-cancel', 'valuation-workflow-export',
  'valuation-workflow-load', 'valuation-workflow-clear', 'valuation-workflow-reconcile', 'valuation-workflow-open-artifact',
]

test('production workflow assembly is lazy and every panel operation fails closed before privileged IO', async () => {
  const { createValuationWorkflowHost } = await import('../../../src/host/integrations/valuation-workflow/host.ts')
  const touched = []
  const host = createValuationWorkflowHost({
    ctx: { get: (name) => { touched.push(name); return undefined } }, state: {}, config: {},
    world: { home: async () => { touched.push('home'); return '/synthetic' },
      platform: async () => { touched.push('platform'); return 'darwin-arm64' } },
    access: { authorize: () => ({ ok: false, error: '合成授权未开启', errorClass: 'consent-required' }),
      note() {}, consent: () => ({ granted: false }) }, valuationScopes: new ValuationScopes(),
  })
  assert.deepEqual(touched, [], 'plugin activation must not snapshot optional services or open a database')
  assert.equal(typeof host.runtime.execute, 'function')
  assert.equal(typeof host.prepareHandoff, 'function')
  for (const name of operationNames) {
    assert.equal(typeof host.operations[name], 'function', name)
    const result = await host.operations[name]({ projectId: 'foreign', serialized: '{}' })
    assert.equal(result.ok, false, name)
  }
  assert.deepEqual(touched, [], 'denied requests may not read credentials, workspace or files')
  await host.dispose()
})

test('the shipped Host registers the graph control tool and passes the same runtime to handoff and panel operations', async () => {
  const root = new URL('../../../src/host/', import.meta.url)
  const apply = await readFile(new URL('apply.ts', root), 'utf8')
  const register = await readFile(new URL('tools/register.ts', root), 'utf8')
  const operations = await readFile(new URL('operations/report-evaluation.ts', root), 'utf8')
  const handoff = await readFile(new URL('operations/report-evaluation/handoff.ts', root), 'utf8')
  assert.match(apply, /createValuationWorkflowHost\(/)
  assert.match(apply, /workflowRuntime:\s*\w+\.runtime/)
  assert.match(apply, /\.guard\(/, 'the genuine SDK guard must protect graph-owned parents')
  assert.match(register, /valuationWorkflowTools\(deps\)/)
  assert.match(operations, /workflow/)
  assert.match(handoff, /prepareHandoff/, 'the actual dispatch must use the opaque graph command prompt')
})

async function persistedFixture(t) {
  const { createValuationWorkflowHost } = await import('../../../src/host/integrations/valuation-workflow/host.ts')
  const root = await mkdtemp(join(tmpdir(), 'crwu-production-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectId = 'valuation-synthetic'
  const parentSessionId = 'parent-synthetic'
  const casePath = join(root, projectId)
  await mkdir(join(casePath, '资料'), { recursive: true })
  const materialPath = join(casePath, '资料/合成权证.txt')
  const bytes = Buffer.from('北京市合成花园，规划用途公寓，建筑面积100平方米')
  await writeFile(materialPath, bytes)
  const file = { fileId: 'material-001', fileName: '合成权证.txt', archiveRelativePath: '资料/合成权证.txt',
    kind: 'text', sizeBytes: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    createdAt: null, modifiedAt: null, readable: true, duplicateOf: null }
  const inputParts = { projectId, assetType: 'real-estate', methodRequest: 'market', baseDate: null,
    purpose: null, valueType: null, templateFileId: null, supplementalPrompt: '', files: [file] }
  const inputDigest = valuationInputDigest(inputParts)
  const frozen = buildFrozenInput({ ...inputParts, inputDigest })
  const scope = { valuationId: projectId, projectId, previewId: projectId, sessionId: parentSessionId, parentSessionId,
    workspaceId: 'workspace-synthetic', workspacePath: root, casePath, openedAt: 1, planIds: [],
    snapshot: { valuationId: projectId, assetType: 'real-estate', method: 'market', baseDate: '', purpose: '', valueType: '',
      templateFileId: null, supplementalPrompt: '', digest: inputDigest, frozenAt: '2026-10-18',
      files: [{ ...file, relativePath: file.archiveRelativePath }] } }
  const record = buildProjectRecord({ schemaVersion: PROJECT_RECORD_SCHEMA_VERSION, protocolVersion: WORKBENCH_PROTOCOL,
    inputSchemaVersion: VALUATION_INPUT_SCHEMA_VERSION, valuationId: projectId, projectId, previewId: projectId,
    casePath, workspaceId: scope.workspaceId, workspacePath: root, sessionId: parentSessionId, planIds: [], phase: 'queued',
    ...inputParts, inputDigest, createdAt: '2026-10-18T00:00:00Z' })
  await writeFile(join(casePath, PROJECT_RECORD_FILE), JSON.stringify(record))
  await writeFile(join(casePath, '估值输入.json'), JSON.stringify(frozen))
  await writeFile(join(casePath, '交接记录.json'), JSON.stringify({ state: 'dispatched', parentSessionId }))
  const calls = []
  let granted = true
  const parent = { id: parentSessionId, status: 'idle', session: { id: parentSessionId, header: { cwd: root, origin: 'root' } } }
  const workspace = { id: scope.workspaceId, path: root, title: '合成工作区', sessionIds: [parentSessionId] }
  const workspaces = new Map([[workspace.id, workspace]])
  const state = { workspaceId: workspace.id, workspacePath: root, workspaceTitle: workspace.title, workspaceChosen: true, workspaceMissing: false }
  const fs = { resolve: async (path) => { let canonical; try { canonical = await realpath(path) } catch { canonical = path }; return { targetKey: canonical, displayPath: canonical } },
    stat: async (target) => { const info = await stat(target.targetKey); return { type: info.isDirectory() ? 'directory' : 'file', size: info.size } },
    readText: async (target) => readFile(target.targetKey, 'utf8'), readBytes: async (target) => readFile(target.targetKey) }
  const ctx = { get(name) {
    calls.push(name)
    if (name === 'fs') return fs
    if (name === 'workspaceRegistry') return { get: (id) => workspaces.get(id) }
    if (name === 'sessions') return { get: (id) => id === parentSessionId ? parent.session : undefined }
    if (name === 'agents') return { get: (id) => id === parentSessionId ? parent : undefined }
    return undefined
  } }
  const scopes = new ValuationScopes()
  scopes.open(scope)
  const options = { ctx, state, config: {}, valuationScopes: scopes, world: { platform: async () => process.platform },
    access: { authorize(call) { calls.push(call.operation); return { ok: granted, error: granted ? '' : '合成授权已撤销' } }, note() {} } }
  const host = createValuationWorkflowHost(options)
  t.after(() => host.dispose())
  return { host, options, root, casePath, materialPath, projectId, parentSessionId, frozen, scope, calls, parent, workspaces,
    createHost: () => createValuationWorkflowHost({ ...options, valuationScopes: new ValuationScopes() }),
    revoke: () => { granted = false }, receipt: { projectId, parentSessionId, dispatchAccepted: false, reused: false } }
}

test('a prepared graph survives Host reconstruction and export-clear-load without starting any model', async (t) => {
  const f = await persistedFixture(t)
  const prepared = await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  assert.equal(prepared.ok, true, prepared.error)
  assert.match(prepared.prompt, /crwu_valuation_workflow_run/)
  assert.doesNotMatch(prepared.prompt, /skill|合成花园|建筑面积|知识库/)
  assert.ok((await stat(join(f.root, '.crwu/workflows.sqlite'))).isFile())
  const current = await f.host.operations['valuation-workflow-current']({})
  assert.equal(current.projectId, f.projectId)
  assert.equal(current.snapshot, null, 'no business run was started by handoff preparation')
  await f.host.dispose()
  const reopened = f.createHost()
  t.after(() => reopened.dispose())
  const restored = await reopened.operations['valuation-workflow-current']({})
  assert.equal(restored.ok, true, restored.error)
  assert.equal(restored.projectId, f.projectId)
  const exported = await reopened.operations['valuation-workflow-export']({ projectId: f.projectId })
  assert.equal(exported.ok, true, exported.error)
  assert.equal(typeof exported.serialized, 'string')
  assert.equal((await reopened.operations['valuation-workflow-load']({ serialized: '{invalid' })).ok, false)
  assert.equal((await reopened.operations['valuation-workflow-current']({})).projectId, f.projectId)
  const cleared = await reopened.operations['valuation-workflow-clear']({ projectId: f.projectId })
  assert.equal(cleared.ok, true, cleared.error)
  assert.equal((await reopened.operations['valuation-workflow-current']({})).empty, true)
  assert.ok((await stat(f.materialPath)).isFile(), 'clear removes task state, preserving archived materials and deliverables')
  const loaded = await reopened.operations['valuation-workflow-load']({ serialized: exported.serialized })
  assert.equal(loaded.ok, true, loaded.error)
  assert.equal((await reopened.operations['valuation-workflow-current']({})).projectId, f.projectId)
  assert.equal(f.calls.some((name) => ['subagents', 'sessionController'].includes(name)), false)
})

test('loading a graph refuses changed material bytes and leaves the current task empty', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const exported = await f.host.operations['valuation-workflow-export']({ projectId: f.projectId })
  assert.equal(exported.ok, true, exported.error)
  assert.equal((await f.host.operations['valuation-workflow-clear']({ projectId: f.projectId })).ok, true)
  await writeFile(f.materialPath, '篡改后的合成材料')
  assert.equal((await f.host.operations['valuation-workflow-load']({ serialized: exported.serialized })).ok, false)
  assert.equal((await f.host.operations['valuation-workflow-current']({})).empty, true)
})

test('a second current graph is rejected and revoked consent prevents even current-task reads', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const second = await f.host.prepareHandoff({ receipt: { ...f.receipt, projectId: 'foreign-second' }, frozen: { ...f.frozen, projectId: 'foreign-second' } })
  assert.equal(second.ok, false)
  f.revoke()
  const before = f.calls.length
  assert.equal((await f.host.operations['valuation-workflow-current']({})).ok, false)
  assert.deepEqual(f.calls.slice(before), ['system.valuation-workflow.store'])
})

test('changing the selected workspace reads its own task and cannot replace the previous workspace graph', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const other = { id: 'workspace-other', path: join(f.root, 'other-workspace'), title: '另一合成工作区', sessionIds: [] }
  await mkdir(other.path)
  f.workspaces.set(other.id, other)
  const state = f.options.state
  state.workspaceId = other.id
  state.workspacePath = other.path
  state.workspaceTitle = other.title
  const empty = await f.host.operations['valuation-workflow-current']({})
  assert.equal(empty.ok, true, empty.error)
  assert.equal(empty.empty, true)
  state.workspaceId = f.scope.workspaceId
  state.workspacePath = f.root
  const original = await f.host.operations['valuation-workflow-current']({})
  assert.equal(original.projectId, f.projectId)
  assert.equal(f.calls.some((name) => ['subagents', 'sessionController'].includes(name)), false)
})

test('a child session cannot be adopted as the root valuation conversation', async (t) => {
  const f = await persistedFixture(t)
  f.parent.session.header.parentSession = 'foreign-parent'
  const prepared = await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  assert.equal(prepared.ok, false)
  assert.equal((await f.host.operations['valuation-workflow-current']({})).empty, true)
})

test('frozen input content is verified even when a changed file keeps the old digest label', async (t) => {
  const f = await persistedFixture(t)
  const path = join(f.casePath, '估值输入.json')
  const changed = JSON.parse(await readFile(path, 'utf8'))
  changed.baseDate = '2025-01-01'
  await writeFile(path, JSON.stringify(changed))
  const prepared = await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  assert.equal(prepared.ok, false, 'the digest label alone is not content verification')
})

test('a case directory symlink cannot move a valuation outside the selected workspace', { skip: process.platform === 'win32' && 'macOS symlink acceptance; Windows not verified' }, async (t) => {
  const f = await persistedFixture(t)
  const external = await mkdtemp(join(tmpdir(), 'crwu-foreign-project-'))
  t.after(() => rm(external, { recursive: true, force: true }))
  const moved = join(external, f.projectId)
  await rename(f.casePath, moved)
  await symlink(moved, f.casePath, 'dir')
  const prepared = await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  assert.equal(prepared.ok, false)
})

test('a failed second store authorization cannot become a successful empty current task', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const original = f.options.access.authorize
  let decisions = 0
  f.options.access.authorize = () => ({ ok: ++decisions === 1 })
  try {
    const result = await f.host.operations['valuation-workflow-current']({})
    assert.equal(result.ok, false)
    assert.notEqual(result.empty, true)
  } finally { f.options.access.authorize = original }
})

test('a refused runtime release prevents clearing the persisted task', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  f.host.runtime.release = () => ({ ok: false, error: '合成活动执行仍持有此项目' })
  const result = await f.host.operations['valuation-workflow-clear']({ projectId: f.projectId })
  assert.equal(result.ok, false)
  assert.equal((await f.host.operations['valuation-workflow-current']({})).projectId, f.projectId)
})

test('an invalid native run DTO cannot replace a valid current task during load', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const exported = await f.host.operations['valuation-workflow-export']({ projectId: f.projectId })
  const bundle = JSON.parse(exported.serialized)
  bundle.current.state.dto = { format: 'invalid-native-run-image' }
  const result = await f.host.operations['valuation-workflow-load']({ serialized: JSON.stringify(bundle) })
  assert.equal(result.ok, false)
  const after = await f.host.operations['valuation-workflow-export']({ projectId: f.projectId })
  assert.equal(JSON.parse(after.serialized).current.state.dto, null)
})

async function openTechnicalStore(f, t) {
  const { openWorkflowStoreSession } = await import('../../../src/host/integrations/valuation-workflow/production/store.ts')
  const session = await openWorkflowStoreSession({ workspaceId: f.scope.workspaceId,
    storePath: join(f.root, '.crwu/workflows.sqlite'), authorize: () => ({ ok: true }) })
  t.after(() => session.close())
  return session
}

test('clear stops preparation and rechecks the durable task before clearing its current pointer', async (t) => {
  const f = await persistedFixture(t)
  await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  const session = await openTechnicalStore(f, t)
  await session.beginPreparation()
  let stopped = 0
  f.host.runtime.cancel = async (projectId) => {
    assert.equal(projectId, f.projectId)
    stopped += 1
    await session.recordStartFailure(Object.assign(new Error('用户停止准备'), { errorKind: 'cancelled' }))
    return { ok: true }
  }
  const result = await f.host.operations['valuation-workflow-clear']({ projectId: f.projectId })
  assert.equal(result.ok, true, result.error)
  assert.equal(stopped, 1)
  assert.equal((await f.host.operations['valuation-workflow-current']({})).empty, true)
  assert.equal((await stat(f.materialPath)).isFile(), true, 'clear keeps archived materials')
})

test('clear requests a stop but preserves the current pointer when stopping cannot be confirmed', async (t) => {
  const f = await persistedFixture(t)
  await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  const session = await openTechnicalStore(f, t)
  await session.beginPreparation()
  let attempts = 0
  f.host.runtime.cancel = async () => { attempts += 1; return { ok: false, error: '停止状态尚未确认' } }
  const result = await f.host.operations['valuation-workflow-clear']({ projectId: f.projectId })
  assert.equal(result.ok, false)
  assert.equal(attempts, 1)
  assert.equal((await f.host.operations['valuation-workflow-current']({})).projectId, f.projectId)
})

test('a real preparation child retains occupancy before the first DTO and settlement permits clear', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const session = await openTechnicalStore(f, t)
  await session.journalStarted({ sessionId: 'actual-visual-child', kind: 'stage', operation: 'page-reading',
    nodeId: 'page-reading', stage: 'elements', runId: f.projectId, revision: 1, correlationId: 'page-1' })
  assert.equal((await f.host.operations['valuation-workflow-clear']({ projectId: f.projectId })).ok, false)
  await session.journalSettled({ sessionId: 'actual-visual-child', ok: true, errorKind: '' })
  assert.equal((await f.host.operations['valuation-workflow-clear']({ projectId: f.projectId })).ok, true)
})

test('the journal cannot substitute a helper or earlier revision conversation for the actual node attempt', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const session = await openTechnicalStore(f, t)
  const { createFixturePorts, createStartInput, loadWorkflowService } = await import('../../helpers/valuation-workflow-fixture.mjs')
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(createFixturePorts().ports)
  t.after(() => service.dispose())
  await service.start(createStartInput({ runId: f.projectId }))
  const dto = await service.exportRun(f.projectId)
  dto.revision = 2
  dto.status = 'running'
  dto.active = true
  dto.stages.elements = { ...dto.stages.elements, state: 'running', sessionId: '', attempt: 1, outputs: {} }
  await session.saveRun(dto)
  await session.journalStarted({ sessionId: 'helper-child', kind: 'stage', operation: 'knowledge-selection',
    nodeId: 'knowledge-selection', stage: 'elements', runId: f.projectId, revision: 2, correlationId: 'helper' })
  assert.equal((await session.readState()).dto.stages.elements.sessionId, '')
  await session.journalStarted({ sessionId: 'actual-node-child', kind: 'stage', nodeId: 'elements', stage: 'elements',
    runId: f.projectId, revision: 2, correlationId: `${f.projectId}:elements:1` })
  assert.equal((await session.readState()).dto.stages.elements.sessionId, 'actual-node-child')
  await session.saveRun(dto)
  assert.equal((await session.readState()).dto.stages.elements.sessionId, 'actual-node-child')
  const next = structuredClone(dto)
  next.revision = 3
  next.stages.elements = { ...next.stages.elements, state: 'pending', attempt: 0, sessionId: '' }
  await session.saveRun(next)
  assert.equal((await session.readState()).dto.stages.elements.sessionId, '')
})

test('saved evidence validation uses registered case-relative template and plan-relative capture identities', async () => {
  const { evidenceFilesOf } = await import('../../../src/host/integrations/valuation-workflow/production/project.ts')
  const digest = `sha256:${'a'.repeat(64)}`
  const dto = { observedSamples: [{ evidence: '来源证据/详情.html', digest, bytes: 10,
    screenshot: '推理结果/图片/案例.png', screenshotDigest: digest }], evidencePool: null,
    plan: { template: { relativePath: '方案/plan-1/模板/参考表.xlsx', digest }, sources: [] } }
  const paths = evidenceFilesOf(dto).map((file) => file.relativePath)
  assert.ok(paths.includes('方案/plan-1/模板/参考表.xlsx'))
  assert.ok(paths.includes('方案/plan-1/来源证据/详情.html'))
  assert.ok(paths.includes('方案/plan-1/推理结果/图片/案例.png'))
  assert.equal(paths.includes('来源证据/详情.html'), false)
})

test('live native progress stays running while the same persisted mid-flight image needs reconciliation after Host reconstruction', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const session = await openTechnicalStore(f, t)
  const { createFixturePorts, createStartInput, loadWorkflowService } = await import('../../helpers/valuation-workflow-fixture.mjs')
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(createFixturePorts().ports)
  t.after(() => service.dispose())
  await service.start(createStartInput({ runId: f.projectId }))
  const dto = await service.exportRun(f.projectId)
  dto.status = 'running'
  dto.outcome = null
  dto.active = true
  dto.errorKind = ''
  dto.error = ''
  dto.stages.review.state = 'running'
  await session.saveRun(dto)
  const liveSnapshot = { ...await service.get(f.projectId), status: 'running', outcome: null,
    errorKind: '', error: '', stages: dto.stages }
  f.host.runtime.status = async () => ({ phase: 'running', snapshot: liveSnapshot, projectId: f.projectId,
    parentSessionId: f.parentSessionId, occupied: false, error: '' })
  const live = await f.host.operations['valuation-workflow-current']({})
  assert.equal(live.phase, 'running')
  assert.equal(live.snapshot.status, 'running')
  assert.equal(live.progress.status, 'running')
  const cold = f.createHost()
  t.after(() => cold.dispose())
  const reopened = await cold.operations['valuation-workflow-current']({})
  assert.ok(['blocked', 'failed'].includes(reopened.phase))
  assert.equal(reopened.errorKind, 'stop-unknown')
  assert.equal(reopened.parentSessionId, f.parentSessionId)
})


test('panel revision validates the compiled node id and dispatches only its opaque command to the recorded parent', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const session = await openTechnicalStore(f, t)
  const { createFixturePorts, createStartInput, loadWorkflowService } = await import('../../helpers/valuation-workflow-fixture.mjs')
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(createFixturePorts().ports)
  t.after(() => service.dispose())
  await service.start(createStartInput({ runId: f.projectId }))
  const dto = await service.exportRun(f.projectId)
  await session.saveRun(dto)
  const snapshot = await service.get(f.projectId)
  f.host.runtime.status = async () => ({ phase: 'partial', snapshot, projectId: f.projectId,
    parentSessionId: f.parentSessionId, occupied: false, error: '' })
  const calls = []
  const messages = []
  f.parent.followup = (message) => messages.push(message)
  f.host.runtime.queue = (projectId, input) => { calls.push({ projectId, input }); return { ok: true, commandId: 'opaque-synthetic-command' } }
  const payload = { nodeId: 'foreign:rights', expectedRevision: dto.revision, submissionId: 'submission-test',
    reason: '核对资料', source: '用户确认', changes: [{ field: 'areaSqm', value: '101' }] }
  const invalid = await f.host.operations['valuation-workflow-action']({ projectId: f.projectId, action: 'revise', payload })
  assert.equal(invalid.ok, false)
  assert.equal(calls.length, 0)
  assert.equal(messages.length, 0)
  const accepted = await f.host.operations['valuation-workflow-action']({ projectId: f.projectId, action: 'revise',
    payload: { ...payload, nodeId: 'valuation:realestate:rights' } })
  assert.equal(accepted.ok, true, accepted.error)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input.payload.nodeId, 'rights')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.match(JSON.stringify(messages[0]), /opaque-synthetic-command/)
  assert.doesNotMatch(JSON.stringify(messages[0]), /areaSqm|核对资料|用户确认/)
  const retry = await f.host.operations['valuation-workflow-action']({ projectId: f.projectId, action: 'revise',
    payload: { ...payload, nodeId: 'valuation:realestate:rights' } })
  assert.equal(retry.ok, true, retry.error)
  assert.equal(messages.length, 1, 'the same accepted command is not delivered twice')
})

test('a reconstructed pre-business task stays passive and resumes the same native parent only on explicit reconciliation', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const reopened = f.createHost()
  t.after(() => reopened.dispose())
  const messages = []
  f.parent.followup = (message) => messages.push(message)
  const before = await reopened.operations['valuation-workflow-current']({})
  assert.equal(before.parentSessionId, f.parentSessionId)
  assert.equal(messages.length, 0)
  const resumed = await reopened.operations['valuation-workflow-reconcile']({ projectId: f.projectId })
  assert.equal(resumed.ok, true, resumed.error)
  assert.equal(messages.length, 1)
  assert.match(JSON.stringify(messages[0]), /crwu_valuation_workflow_run/)
  assert.equal((await reopened.operations['valuation-workflow-current']({})).parentSessionId, f.parentSessionId)
  assert.equal(messages.length, 1)
})


test('explicit continuation cannot start an old parent after its frozen archive bytes changed', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const reopened = f.createHost()
  t.after(() => reopened.dispose())
  const messages = []
  f.parent.followup = (message) => messages.push(message)
  await writeFile(f.materialPath, 'changed-synthetic-archive')
  const result = await reopened.operations['valuation-workflow-reconcile']({ projectId: f.projectId })
  assert.equal(result.ok, false)
  assert.equal(messages.length, 0)
  assert.equal((await reopened.operations['valuation-workflow-current']({})).parentSessionId, f.parentSessionId)
})

test('an unobservable old child cannot be reconciled as stopped or replaced by another conversation', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const technical = await openTechnicalStore(f, t)
  await technical.journalStarted({ sessionId: 'unobservable-synthetic-child', kind: 'stage', operation: 'page-reading',
    nodeId: 'page-reading', stage: 'elements', runId: f.projectId, revision: 1, correlationId: 'page-reading-1' })
  const reopened = f.createHost()
  t.after(() => reopened.dispose())
  const messages = []
  f.parent.followup = (message) => messages.push(message)
  const result = await reopened.operations['valuation-workflow-reconcile']({ projectId: f.projectId })
  assert.equal(result.ok, false)
  assert.equal(messages.length, 0)
  assert.equal((await reopened.operations['valuation-workflow-clear']({ projectId: f.projectId })).ok, false)
  assert.equal((await reopened.operations['valuation-workflow-current']({})).parentSessionId, f.parentSessionId)
})


test('a live decision revalidates frozen material bytes before entering the native command queue', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const session = await openTechnicalStore(f, t)
  const { createFixturePorts, createStartInput, loadWorkflowService } = await import('../../helpers/valuation-workflow-fixture.mjs')
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(createFixturePorts().ports)
  t.after(() => service.dispose())
  await service.start(createStartInput({ runId: f.projectId }))
  const dto = await service.exportRun(f.projectId)
  await session.saveRun(dto)
  const snapshot = await service.get(f.projectId)
  f.host.runtime.status = async () => ({ phase: 'partial', snapshot, projectId: f.projectId,
    parentSessionId: f.parentSessionId, occupied: false, error: '' })
  const queued = []
  f.host.runtime.queue = (...args) => { queued.push(args); return { ok: true, commandId: 'must-not-be-issued' } }
  f.parent.followup = () => { throw new Error('must-not-dispatch') }
  await writeFile(f.materialPath, 'changed-after-preparation')
  const result = await f.host.operations['valuation-workflow-action']({ projectId: f.projectId, action: 'revise', payload: {
    nodeId: 'valuation:realestate:rights', expectedRevision: dto.revision, submissionId: 'changed-input-decision',
    reason: '核实', source: '用户', changes: [{ field: 'areaSqm', value: 101 }],
  } })
  assert.equal(result.ok, false)
  assert.equal(queued.length, 0)
})


test('a loaded task cannot substitute stored workspace and case paths while keeping the selected workspace id', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const exported = await f.host.operations['valuation-workflow-export']({ projectId: f.projectId })
  assert.equal(exported.ok, true, exported.error)
  const bundle = JSON.parse(exported.serialized)
  bundle.current.state.workspacePath = `${f.root}-foreign`
  bundle.current.state.casePath = join(`${f.root}-foreign`, f.projectId)
  const result = await f.host.operations['valuation-workflow-load']({ serialized: JSON.stringify(bundle) })
  assert.equal(result.ok, false)
  const retained = await f.host.operations['valuation-workflow-export']({ projectId: f.projectId })
  assert.equal(JSON.parse(retained.serialized).current.state.workspacePath, f.root)
})


test('an explicit decision on a valid cold stopped graph restores it without rerunning material preparation', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const technical = await openTechnicalStore(f, t)
  const { createFixturePorts, createStartInput, loadWorkflowService } = await import('../../helpers/valuation-workflow-fixture.mjs')
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(createFixturePorts().ports)
  t.after(() => service.dispose())
  await service.start(createStartInput({ runId: f.projectId }))
  const dto = await service.exportRun(f.projectId)
  await technical.saveRun(dto)
  const reopened = f.createHost()
  t.after(() => reopened.dispose())
  const messages = []
  f.parent.followup = (message) => messages.push(message)
  const result = await reopened.operations['valuation-workflow-action']({ projectId: f.projectId, action: 'revise', payload: {
    nodeId: 'valuation:realestate:rights', expectedRevision: dto.revision, submissionId: 'cold-stopped-decision',
    reason: '核实面积', source: '用户确认', changes: [{ field: 'areaSqm', value: 101 }],
  } })
  assert.equal(result.ok, true, result.error)
  assert.equal(messages.length, 1)
  assert.match(JSON.stringify(messages[0]), /crwu_valuation_workflow_run/)
  assert.equal((await reopened.operations['valuation-workflow-current']({})).parentSessionId, f.parentSessionId)
})


test('a resident parent moved outside the selected workspace cannot receive an explicit continuation', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const messages = []
  f.parent.followup = (message) => messages.push(message)
  f.parent.session.header.cwd = `${f.root}-different-workspace`
  const result = await f.host.operations['valuation-workflow-reconcile']({ projectId: f.projectId })
  assert.equal(result.ok, false)
  assert.equal(messages.length, 0)
})

test('reconcile dispatches only an eligible stopped router retry under the same parent', async (t) => {
  const f = await persistedFixture(t)
  assert.equal((await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })).ok, true)
  const technical = await openTechnicalStore(f, t)
  const { createFixturePorts, createStartInput, loadWorkflowService } = await import('../../helpers/valuation-workflow-fixture.mjs')
  const { ports } = createFixturePorts()
  ports.intent = { infer: async () => ({ ok: false, errorKind: 'blocked', error: '合成意图未确认', sessionId: 'actual-old-router' }) }
  const { createValuationWorkflowService } = await loadWorkflowService()
  const service = createValuationWorkflowService(ports)
  t.after(() => service.dispose())
  await service.start(createStartInput({ runId: f.projectId }))
  const dto = await service.exportRun(f.projectId)
  dto.usedSubmissions.push('reconcile-intent-1')
  await technical.saveRun(dto)
  const snapshot = await service.get(f.projectId)
  f.host.runtime.status = async () => ({ phase: 'blocked', snapshot, projectId: f.projectId,
    parentSessionId: f.parentSessionId, occupied: false, error: snapshot.error })
  const queued = [], messages = []
  f.host.runtime.queue = (id, input) => { queued.push({ id, input }); return { ok: true, commandId: 'opaque-router-retry' } }
  f.parent.followup = (message) => messages.push(message)
  const result = await f.host.operations['valuation-workflow-reconcile']({ projectId: f.projectId })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.resumed, true)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].input.action, 'retry-intent')
  assert.ok(!dto.usedSubmissions.includes(queued[0].input.payload.submissionId), 'Host restart must not reuse a persisted submission identity')
  assert.equal(messages.length, 1)
  assert.match(JSON.stringify(messages[0]), /opaque-router-retry/)
  assert.equal((await f.host.operations['valuation-workflow-current']({})).parentSessionId, f.parentSessionId)
})

test('the current protocol reads exact graph generations 43 through 47 without admitting other generations', async (t) => {
  assert.equal(WORKBENCH_PROTOCOL, 49)
  const f = await persistedFixture(t)
  const { verifyProtectedProject } = await import('../../../src/host/integrations/valuation-workflow/production/project.ts')
  const path = join(f.casePath, PROJECT_RECORD_FILE)
  const record = JSON.parse(await readFile(path, 'utf8'))
  const options = { workspacePath: f.root, workspaceId: f.scope.workspaceId, projectId: f.projectId,
    parentSessionId: f.parentSessionId, frozen: f.frozen }
  assert.equal((await verifyProtectedProject(options)).ok, true)
  for (const protocolVersion of [43, 44, 45, 46, 47]) {
    const priorBytes = JSON.stringify(buildProjectRecord({ ...record, protocolVersion }))
    await writeFile(path, priorBytes)
    const compatible = await verifyProtectedProject(options)
    assert.equal(compatible.ok, true, compatible.error)
    assert.equal(await readFile(path, 'utf8'), priorBytes, 'compatibility never rewrites the protected record')
  }
  for (const protocolVersion of [42, WORKBENCH_PROTOCOL + 1]) {
    await writeFile(path, JSON.stringify(buildProjectRecord({ ...record, protocolVersion })))
    assert.equal((await verifyProtectedProject(options)).ok, false)
  }
  await writeFile(path, JSON.stringify(buildProjectRecord({ ...record, protocolVersion: 43,
    inputSchemaVersion: String(Number(record.inputSchemaVersion) - 1) })))
  assert.equal((await verifyProtectedProject(options)).ok, false)
})


test('a settled preparation failure releases only program preparation occupancy', async (t) => {
  const f = await persistedFixture(t)
  await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  const session = await openTechnicalStore(f, t)
  await session.beginPreparation()
  await session.recordStartFailure(Object.assign(new Error('合成运行时探测失败'), { errorKind: 'environment' }))
  const record = await session.read()
  assert.equal(record.state.preparing, false)
  assert.equal(record.status, 'failed')
  assert.equal(record.state.parentSessionId, f.parentSessionId)
})

test('explicit recovery repairs an old terminal environment marker only while the real parent is claimed idle', async (t) => {
  const f = await persistedFixture(t)
  await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  const session = await openTechnicalStore(f, t)
  const original = await session.readState()
  await session.saveInitial({ ...original, preparing: true, phase: 'failed', errorKind: 'environment', error: '合成环境错误' })
  await f.host.dispose()
  const messages = []
  f.parent.inbox = { nextTurn: [], nextStep: [] }
  f.parent.followup = (message) => messages.push(message)
  let claimed = 0
  f.parent.runMaintenance = async (task) => { claimed += 1; return await task(new AbortController().signal) }
  const cold = f.createHost()
  t.after(() => cold.dispose())
  const result = await cold.operations['valuation-workflow-reconcile']({ projectId: f.projectId })
  assert.equal(result.ok, true, result.error)
  assert.equal(claimed, 1)
  assert.equal((await session.readState()).preparing, false)
  assert.equal(messages.length, 1)
  assert.equal((await session.readState()).parentSessionId, f.parentSessionId)
})

test('old preparation occupancy stays held when the actual parent has pending input', async (t) => {
  const f = await persistedFixture(t)
  await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  const session = await openTechnicalStore(f, t)
  await session.saveInitial({ ...await session.readState(), preparing: true, phase: 'failed', errorKind: 'environment', error: '合成环境错误' })
  await f.host.dispose()
  f.parent.inbox = { nextTurn: [{}], nextStep: [] }
  f.parent.followup = () => { throw new Error('must-not-dispatch') }
  f.parent.runMaintenance = () => { throw new Error('must-not-claim') }
  const cold = f.createHost()
  t.after(() => cold.dispose())
  const result = await cold.operations['valuation-workflow-reconcile']({ projectId: f.projectId })
  assert.equal(result.ok, false)
  assert.equal((await session.readState()).preparing, true)
})


test('a failed preparation with an unsettled native child cannot release writer occupancy', async (t) => {
  const f = await persistedFixture(t)
  await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  const session = await openTechnicalStore(f, t)
  await session.beginPreparation()
  await session.journalStarted({ sessionId: 'actual-unsettled-child', kind: 'stage', operation: 'page-reading',
    nodeId: 'page-reading', stage: 'elements', runId: f.projectId, revision: 1, correlationId: 'page-1' })
  await session.recordStartFailure(Object.assign(new Error('合成环境错误'), { errorKind: 'environment' }))
  assert.equal((await session.readState()).preparing, true)
  assert.equal((await f.host.operations['valuation-workflow-clear']({ projectId: f.projectId })).ok, false)
})


test('explicit retry after a settled resident pregraph failure sends a fresh command to the same parent', async (t) => {
  const f = await persistedFixture(t)
  const prepared = await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  assert.equal(prepared.ok, true)
  const commandId = /commandId=([^。]+)/.exec(prepared.prompt)[1]
  const result = await f.host.runtime.execute(commandId, { agent: f.parent, token: Symbol('control'), rootCallId: 'root-control', signal: new AbortController().signal })
  assert.equal(result.ok, false)
  assert.equal((await f.host.runtime.status(f.projectId)).phase, 'failed')
  const messages = []
  f.parent.inbox = { nextTurn: [], nextStep: [] }
  f.parent.followup = (message) => messages.push(message)
  f.parent.runMaintenance = async (task) => await task(new AbortController().signal)
  const retry = await f.host.operations['valuation-workflow-reconcile']({ projectId: f.projectId })
  assert.equal(retry.ok, true, retry.error)
  assert.notEqual(retry.commandId, commandId, 'a settled failed command result cannot become a new attempt')
  assert.equal(messages.length, 1)
  assert.equal((await f.host.operations['valuation-workflow-current']({ projectId: f.projectId })).parentSessionId, f.parentSessionId)
})


test('an aborted idle maintenance claim does not repair or dispatch the old graph', async (t) => {
  const f = await persistedFixture(t)
  await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
  const session = await openTechnicalStore(f, t)
  await session.saveInitial({ ...await session.readState(), preparing: true, phase: 'failed', errorKind: 'environment', error: '合成环境错误' })
  await f.host.dispose()
  f.parent.inbox = { nextTurn: [], nextStep: [] }
  f.parent.followup = () => { throw new Error('must-not-dispatch') }
  f.parent.runMaintenance = async (task) => { const c = new AbortController(); c.abort(); return await task(c.signal) }
  const cold = f.createHost()
  t.after(() => cold.dispose())
  const result = await cold.operations['valuation-workflow-reconcile']({ projectId: f.projectId })
  assert.equal(result.ok, false)
  assert.equal((await session.readState()).preparing, true)
})


test('clear refuses a replaced task identity after awaiting stop', async (t) => {
  for (const field of ['runId', 'parentSessionId']) {
    await t.test(field, async (t) => {
      const f = await persistedFixture(t)
      await f.host.prepareHandoff({ receipt: f.receipt, frozen: f.frozen })
      const session = await openTechnicalStore(f, t)
      await session.beginPreparation()
      const replacement = `replacement-${field}`
      let released = 0
      f.host.runtime.release = () => { released += 1; return { ok: true } }
      f.host.runtime.cancel = async () => {
        await session.recordStartFailure(Object.assign(new Error('stopped'), { errorKind: 'cancelled' }))
        const settled = await session.readState()
        await session.saveInitial({ ...settled, [field]: replacement })
        return { ok: true }
      }
      const result = await f.host.operations['valuation-workflow-clear']({ projectId: f.projectId })
      assert.equal(result.ok, false, 'a late clear must not remove a replacement task')
      assert.equal(released, 0, 'the new owner must not be released')
      const retained = await session.readState()
      assert.ok(retained, 'replacement current pointer must remain')
      assert.equal(retained[field], replacement)
    })
  }
})
