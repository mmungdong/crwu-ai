import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VALUATION_INPUT_SCHEMA_VERSION } from '../../../src/shared/contracts/valuation-project.ts'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'

test('the production runner is lazy and refuses business work outside a genuine active control execution', async () => {
  const { createWorkflowProductionRunner } = await import('../../../src/host/integrations/valuation-workflow/production/runner.ts')
  const touched = []
  const scopes = new ValuationScopes()
  const scope = { valuationId: 'project-1', projectId: 'project-1', sessionId: 'parent-1', parentSessionId: 'parent-1',
    workspaceId: 'workspace-1', workspacePath: '/workspace', casePath: '/workspace/project-1', openedAt: 1, planIds: [],
    snapshot: { valuationId: 'project-1', method: 'market', baseDate: '', supplementalPrompt: '', digest: 'sha256:frozen', files: [], frozenAt: '2026-10-17' } }
  scopes.open(scope)
  const runner = await createWorkflowProductionRunner({ scope, getExecution: () => undefined,
    frozenInput: { schemaVersion: VALUATION_INPUT_SCHEMA_VERSION, projectId: 'project-1', assetType: 'real-estate', methodRequest: 'market', baseDate: null,
      purpose: null, valueType: null, supplementalPrompt: '', files: [], inputDigest: 'sha256:frozen' },
    deps: { ctx: { get: (name) => { touched.push(name); return undefined } }, config: {}, valuationScopes: scopes,
      world: { platform: async () => { touched.push('platform'); return 'darwin-arm64' } },
      access: { authorize: () => { touched.push('authorize'); return { ok: false } } } },
  })
  assert.deepEqual(touched, [])
  assert.equal(typeof runner.service.exportRun, 'function')
  const result = await runner.startInput().then((input) => ({ input }), (error) => ({ error }))
  assert.ok(result.error || result.input?.error, 'material preparation needs the actual control execution, even after restore')
  assert.deepEqual(touched, [], 'no provider, filesystem or broker may be touched without the genuine execution')
  runner.service.dispose()
})

async function preparedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'crwu-production-runner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const casePath = join(root, 'project-cache')
  await mkdir(join(casePath, '资料'), { recursive: true })
  const body = '北京市合成花园，规划用途：公寓；建筑面积100.125平方米；套内面积80平方米'
  const path = join(casePath, '资料/合成权证.txt')
  await writeFile(path, body)
  const sha256 = `sha256:${createHash('sha256').update(body).digest('hex')}`
  const file = { fileId: 'file-1', fileName: '合成权证.txt', relativePath: '资料/合成权证.txt', archiveRelativePath: '资料/合成权证.txt', kind: 'text', sizeBytes: Buffer.byteLength(body), sha256 }
  const scopes = new ValuationScopes()
  const scope = { valuationId: 'project-cache', projectId: 'project-cache', sessionId: 'parent-cache', parentSessionId: 'parent-cache',
    workspaceId: 'workspace-cache', workspacePath: root, casePath, openedAt: 1, planIds: [],
    snapshot: { valuationId: 'project-cache', method: 'market', baseDate: '', supplementalPrompt: '', digest: 'sha256:frozen', files: [file], frozenAt: '2026-10-18' } }
  scopes.open(scope)
  const touched = []
  const exec = { token: Symbol('genuine-test-control'), rootCallId: 'root-cache',
    agent: { id: 'parent-cache', session: { id: 'parent-cache' } }, signal: new AbortController().signal }
  const prepared = { ok: true, errorKind: '', error: '', unverified: [], materials: [{ materialId: 'material-cache',
    fileName: file.fileName, relativePath: file.relativePath, digest: sha256, sizeBytes: file.sizeBytes, fileType: 'text',
    text: body, tables: [], images: [], extractedFields: {}, warnings: [], capabilityGaps: [] }] }
  const options = { scope, getExecution: () => exec, getPrepared: async () => structuredClone(prepared),
    frozenInput: { schemaVersion: VALUATION_INPUT_SCHEMA_VERSION, projectId: 'project-cache', assetType: 'real-estate', methodRequest: 'market', baseDate: null,
      purpose: null, valueType: null, templateFileId: null, supplementalPrompt: '', files: [file], inputDigest: 'sha256:frozen' },
    deps: { ctx: { get: (name) => { touched.push(name); return undefined } }, config: {}, valuationScopes: scopes,
      access: { authorize: () => ({ ok: true }), note() {} }, world: { platform: async () => 'darwin-arm64' } } }
  return { options, path, body, touched, prepared }
}

test('a verified prepared cache supplies actual materials, preserves the blank date and keeps run identity independent of sessions', async (t) => {
  const { createWorkflowProductionRunner } = await import('../../../src/host/integrations/valuation-workflow/production/runner.ts')
  const f = await preparedFixture(t)
  const runner = await createWorkflowProductionRunner(f.options)
  t.after(() => runner.service.dispose())
  assert.deepEqual(f.touched, [])
  const input = await runner.startInput()
  assert.ok(input.runId)
  assert.notEqual(input.runId, 'parent-cache')
  assert.equal(input.baseDate, null)
  assert.equal(input.purpose, null)
  assert.equal(input.materials[0].text, f.body)
  assert.equal(input.materials[0].digest, f.prepared.materials[0].digest)
  assert.doesNotMatch(JSON.stringify(input), new RegExp(f.options.scope.workspacePath))
  assert.equal(input.object.areaSqm, null, 'the later source-bound stage adopts the gross-area fact')
  assert.match(input.userInput, /real-estate|房地产/, 'the explicit asset selection must reach intent routing')
  assert.match(input.userInput, /market|市场法/, 'the confirmed method selection must reach planning')
})

test('changed archived bytes cannot reuse a formerly successful prepared cache', async (t) => {
  const { createWorkflowProductionRunner } = await import('../../../src/host/integrations/valuation-workflow/production/runner.ts')
  const f = await preparedFixture(t)
  await writeFile(f.path, '篡改后的材料')
  const runner = await createWorkflowProductionRunner(f.options)
  t.after(() => runner.service.dispose())
  const result = await runner.startInput().then((input) => ({ input }), (error) => ({ error }))
  assert.ok(result.error || result.input?.error, 'cache admission verifies frozen bytes instead of trusting metadata')
  assert.equal(JSON.stringify(result.input ?? {}).includes(f.body), false)
})

test('revoked access prevents prepared-cache reads even inside a genuine control execution', async (t) => {
  const { createWorkflowProductionRunner } = await import('../../../src/host/integrations/valuation-workflow/production/runner.ts')
  const f = await preparedFixture(t)
  let cacheReads = 0
  f.options.getPrepared = async () => { cacheReads += 1; return f.prepared }
  f.options.deps.access.authorize = () => ({ ok: false, error: '合成授权已撤销' })
  const runner = await createWorkflowProductionRunner(f.options)
  t.after(() => runner.service.dispose())
  const result = await runner.startInput().then((input) => ({ input }), (error) => ({ error }))
  assert.ok(result.error || result.input?.error)
  assert.equal(cacheReads, 0)
  assert.deepEqual(f.touched, [])
})

test('a successful prepared cache cannot silently omit a frozen material', async (t) => {
  const { createWorkflowProductionRunner } = await import('../../../src/host/integrations/valuation-workflow/production/runner.ts')
  const f = await preparedFixture(t)
  const body = '补充权属条件，必须作为本轮资料处理'
  const path = '资料/补充条件.txt'
  await writeFile(join(f.options.scope.casePath, path), body)
  const file = { fileId: 'material-extra', fileName: '补充条件.txt', archiveRelativePath: path, relativePath: path,
    kind: 'text', sizeBytes: Buffer.byteLength(body), sha256: `sha256:${createHash('sha256').update(body).digest('hex')}` }
  f.options.frozenInput.files.push(file)
  f.options.scope.snapshot.files.push(file)
  const runner = await createWorkflowProductionRunner(f.options)
  t.after(() => runner.service.dispose())
  const result = await runner.startInput().then((input) => ({ input }), (error) => ({ error }))
  assert.ok(result.error || result.input?.error, 'missing cache coverage must be refreshed or explicitly refused')
})

test('an uploaded calculation template is preserved for planning but cannot supply subject facts', async (t) => {
  const { createWorkflowProductionRunner } = await import('../../../src/host/integrations/valuation-workflow/production/runner.ts')
  const f = await preparedFixture(t)
  const body = '合成计算模板样例：建筑面积999平方米，原始用途办公'
  const relativePath = '资料/合成计算表.xlsx'
  await writeFile(join(f.options.scope.casePath, relativePath), body)
  const sha256 = `sha256:${createHash('sha256').update(body).digest('hex')}`
  const file = { fileId: 'template-file', fileName: '合成计算表.xlsx', relativePath, archiveRelativePath: relativePath,
    kind: 'excel', sizeBytes: Buffer.byteLength(body), sha256 }
  f.options.frozenInput.files.push(file)
  f.options.scope.snapshot.files.push(file)
  f.options.frozenInput.templateFileId = file.fileId
  f.options.scope.snapshot.templateFileId = file.fileId
  f.prepared.materials.push({ materialId: 'template-parsed', fileName: file.fileName, relativePath, digest: sha256,
    sizeBytes: file.sizeBytes, fileType: 'excel', text: body, tables: [], images: [], extractedFields: {}, warnings: [], capabilityGaps: [] })
  const runner = await createWorkflowProductionRunner(f.options)
  t.after(() => runner.service.dispose())
  const input = await runner.startInput()
  assert.equal(input.materials.length, 1)
  assert.equal(input.materials[0].text, f.body)
  assert.doesNotMatch(JSON.stringify(input.materials), /999|合成计算表/)
  assert.ok(input.userInput.includes(relativePath), 'the confirmed template identity must reach planning as a user choice')
  assert.ok(input.userInput.includes(sha256), 'the uploaded choice is bound to the actual archived digest')
})

test('removed automatic asset selection is refused instead of inventing an asset class', async (t) => {
  const { createWorkflowProductionRunner } = await import('../../../src/host/integrations/valuation-workflow/production/runner.ts')
  const f = await preparedFixture(t)
  f.options.frozenInput.assetType = 'auto'
  const runner = await createWorkflowProductionRunner(f.options)
  t.after(() => runner.service.dispose())
  await assert.rejects(runner.startInput(), (error) => error.errorKind === 'input-invalid')
})

test('production preserves every frozen entry choice in an independent structured initial snapshot', async (t) => {
  const { createWorkflowProductionRunner } = await import('../../../src/host/integrations/valuation-workflow/production/runner.ts')
  const f = await preparedFixture(t)
  Object.assign(f.options.frozenInput, { purpose: 'synthetic transfer', valueType: 'synthetic market value',
    supplementalPrompt: '  Keep the original apartment use.  ' })
  const runner = await createWorkflowProductionRunner(f.options)
  t.after(() => runner.service.dispose())
  const input = await runner.startInput()
  assert.deepEqual(input.initialInput, {
    userInput: input.userInput, assetType: 'real-estate', methodRequest: 'market', purpose: 'synthetic transfer',
    baseDate: null, valueType: 'synthetic market value', templateFileId: null,
    supplementalPrompt: '  Keep the original apartment use.  ', inputDigest: 'sha256:frozen',
    files: [{ fileId: 'file-1', fileName: '合成权证.txt', relativePath: '资料/合成权证.txt', digest: f.options.frozenInput.files[0].sha256 }],
  })
  assert.ok(input.userInput.includes('synthetic market value'), 'explicit choices must remain source-quotable')
  input.initialInput.files[0].fileName = 'changed by caller'
  assert.equal((await runner.startInput()).initialInput.files[0].fileName, '合成权证.txt')
})
