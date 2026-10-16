/**
 * `crwu_valuation_project_prepare` 的**归属登记**接线测试。
 *
 * 现场：prepare 成功落盘之后，`execution_dispatch` 仍以 policy 拒绝该方案 ——
 * 因为方案集合从未写进本轮 scope。这里钉住四件事：
 *
 * 1. 只有**落盘成功 + 校验通过 + 安全 planId** 才登记该方案；`write:false` / 写失败 /
 *    分组冲突 / 不安全 id 都不授权；
 * 2. 登记是**替换**而不是追加：重跑 prepare 让旧方案立刻失去执行权；
 * 3. 项目记录存在时把同一份方案集合写回记录（指纹重算、冻结字段保留）；记录损坏则 fail closed；
 * 4. 身份与其它估值工具一致：走 `agent.session.id`（只有 `agent.id` 不足以授权）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { valuationProjectPrepareTools } = await import(new URL('src/host/tools/report-evaluation/project.ts', ROOT).href)
const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)
const { PROJECT_RECORD_FILE, PROJECT_RECORD_SCHEMA_VERSION, buildProjectRecord, projectRecordOf } = await import(
  new URL('src/host/domains/report-evaluation/lifecycle/index.ts', ROOT).href)
const { WORKBENCH_PROTOCOL } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { VALUATION_INPUT_SCHEMA_VERSION } = await import(new URL('src/shared/contracts/valuation-project.ts', ROOT).href)
const { canonicalJson } = await import(new URL('src/host/tools/common/snapshot.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261015-100000-aa01'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`
const SESSION_ID = 'valuation-session-1'

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
  valuation: { knowledge: { mirrorRoot: '', manifestPath: '' } },
}

function makeCtx({ writeFails = false } = {}) {
  const directories = new Set([WORKSPACE, CASE_DIR])
  const files = new Map()
  const fsService = {
    async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/, '')
      if (directories.has(key)) return { type: 'directory', version: 'v' }
      return files.has(target.targetKey) ? { type: 'file', size: String(files.get(target.targetKey).length), version: 'v' } : undefined
    },
    async readText(target) { return files.get(target.targetKey) ?? '' },
    async writeText(target, content) {
      if (writeFails) {
        const error = new Error(`cannot write "${String(target.targetKey)}": file access denied`)
        error.code = 'FS_SANDBOX_DENIED'
        throw error
      }
      files.set(target.targetKey, content)
      return { operation: 'create', version: 'v' }
    },
    contains(parent, child) {
      const p = String(parent.displayPath).replace(/[\\/]+$/, '')
      const c = String(child.displayPath)
      return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`)
    },
  }
  return {
    directories, files,
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async execute() {
            return {
              result: async () => ({
                exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
              }),
            }
          },
        }
      }
      return undefined
    },
  }
}

function makeDeps({ ctx = makeCtx() } = {}) {
  const state = {
    ...createWorkbenchState(CONFIG),
    localAccess: grantedConsent(),
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, workspaceTitle: '工作区',
    caseRoot: WORKSPACE,
  }
  const { access } = makeTestAccess(ctx, { state })
  return {
    ctx, state,
    deps: {
      ctx, config: CONFIG, state, access,
      discussionScopes: createDiscussionScopeRegistry(),
      valuationScopes: new ValuationScopes(),
      world: {
        platform: async () => 'darwin-arm64',
        home: async () => '/Users/x',
        workdir: async () => WORKSPACE,
        cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
      },
    },
  }
}

function openValuation(deps, sessionId = SESSION_ID, valuationId = VALUATION_ID) {
  deps.valuationScopes.open({
    valuationId, casePath: `${WORKSPACE}/${valuationId}`, sessionId,
    workspaceId: 'w1', workspacePath: WORKSPACE,
    snapshot: {
      valuationId, method: 'market', baseDate: '', supplementalPrompt: '',
      digest: 'sha256:x', frozenAt: '2026-10-15T00:00:00.000Z', files: [],
    },
    openedAt: 1,
  })
  return sessionId
}

function execOf(sessionId, { withSession = true } = {}) {
  return {
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'),
    name: VALUATION_TOOL_NAMES.projectPrepare, arguments: {},
    signal: new AbortController().signal,
    agent: withSession ? { id: sessionId, session: { id: sessionId } } : { id: sessionId },
    deferContext() {}, concludeTurn() {},
  }
}

const OBJECT = {
  objectId: 'o-1', displayName: '住宅A', propertyType: 'residential',
  registeredUse: '成套住宅', classificationBasis: '不动产权证 / 第3页',
}
const VALID_ARGS = {
  objects: [OBJECT],
  proposals: [{ planId: 'plan-001', title: '方案1', objectIds: ['o-1'], propertyType: 'residential' }],
  methodFacts: { 'plan-001': [{ method: 'market', applicable: true }] },
}

function run(deps, args, exec) {
  return valuationProjectPrepareTools(deps)[0].execute({ caseDir: CASE_DIR, ...args }, exec)
}

function planArgs(planId, objectIds = ['o-1']) {
  return {
    objects: [OBJECT],
    proposals: [{ planId, title: planId, objectIds, propertyType: 'residential' }],
    methodFacts: { [planId]: [{ method: 'market', applicable: true }] },
  }
}

test('落盘成功后本轮方案成为已登记归属', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const result = await run(deps, VALID_ARGS, execOf(sessionId))

  assert.equal(result.ok, true, result.error)
  assert.equal(result.written !== '', true, '落盘成功要给出文件名')
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-001'), true)
})

test('write:false 只校验、不授权', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const result = await run(deps, { ...VALID_ARGS, write: false }, execOf(sessionId))

  assert.equal(result.ok, true, result.error)
  assert.equal(result.written, '')
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-001'), false)
})

test('落盘失败不授权', async () => {
  const { deps } = makeDeps({ ctx: makeCtx({ writeFails: true }) })
  const sessionId = openValuation(deps)
  const result = await run(deps, VALID_ARGS, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-001'), false)
})

test('分组冲突不授权（未归属对象）', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const result = await run(deps, {
    ...VALID_ARGS,
    objects: [OBJECT, { ...OBJECT, objectId: 'o-2', displayName: '住宅B' }],
  }, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-001'), false)
})

test('不安全的 planId 不授权', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  await run(deps, planArgs('../evil'), execOf(sessionId))

  assert.equal(deps.valuationScopes.planOf(sessionId, '../evil'), false)
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-001'), false)
})

test('重复 prepare 替换旧方案集合：旧方案失去授权', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)

  await run(deps, VALID_ARGS, execOf(sessionId))
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-001'), true)

  await run(deps, planArgs('plan-002'), execOf(sessionId))
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-002'), true)
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-001'), false, '重跑后旧方案必须失去执行权')
})

test('另一个项目的方案不会登记到本轮', async () => {
  const { deps } = makeDeps()
  const sessionA = openValuation(deps, SESSION_ID, VALUATION_ID)
  await run(deps, VALID_ARGS, execOf(sessionA))
  assert.equal(deps.valuationScopes.planOf(sessionA, 'plan-001'), true)

  // A second round under another project id shares the same registry.
  openValuation(deps, 'valuation-session-2', '估值-20261015-110000-bb02')
  assert.equal(deps.valuationScopes.planOf('valuation-session-2', 'plan-001'), false, '别的项目不得继承本轮方案')
})

test('身份与其它工具一致：缺 agent.session 时不授权', async () => {
  const { deps } = makeDeps()
  const sessionId = openValuation(deps)
  const result = await run(deps, VALID_ARGS, execOf(sessionId, { withSession: false }))

  assert.equal(result.ok, false)
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-001'), false)
})

test('项目记录存在时写回方案集合（指纹重算、冻结字段保留）', async () => {
  const { deps, ctx } = makeDeps()
  const sessionId = openValuation(deps)
  const before = buildProjectRecord({
    schemaVersion: PROJECT_RECORD_SCHEMA_VERSION,
    protocolVersion: WORKBENCH_PROTOCOL,
    inputSchemaVersion: VALUATION_INPUT_SCHEMA_VERSION,
    valuationId: VALUATION_ID,
    projectId: VALUATION_ID,
    previewId: 'preview-1',
    casePath: CASE_DIR,
    workspaceId: 'w1',
    workspacePath: WORKSPACE,
    sessionId,
    planIds: [],
    phase: 'running',
    assetType: 'real-estate',
    methodRequest: 'market',
    baseDate: null,
    purpose: null,
    valueType: null,
    supplementalPrompt: '原样保留',
    inputDigest: 'sha256:x',
    files: [{
      fileId: 'f-1', fileName: 'a.pdf', archiveRelativePath: 'a.pdf', kind: 'pdf',
      sizeBytes: 3, sha256: 'sha256:y', duplicateOf: null,
    }],
    createdAt: '2026-10-15T00:00:00.000Z',
  })
  ctx.files.set(`${CASE_DIR}/${PROJECT_RECORD_FILE}`, canonicalJson(before))

  const result = await run(deps, VALID_ARGS, execOf(sessionId))
  assert.equal(result.ok, true, result.error)

  const read = projectRecordOf(JSON.parse(ctx.files.get(`${CASE_DIR}/${PROJECT_RECORD_FILE}`)))
  assert.equal(read.ok, true, read.error)
  assert.deepEqual(read.record.planIds, ['plan-001'])
  assert.equal(read.record.recordDigest !== before.recordDigest, true, '方案集合变化后指纹要重算')
  assert.equal(read.record.previewId, 'preview-1')
  assert.equal(read.record.supplementalPrompt, '原样保留')
  assert.equal(read.record.inputDigest, 'sha256:x')
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-001'), true)
})

test('项目记录损坏时 fail closed：不授权、不覆盖、不落盘', async () => {
  const { deps, ctx } = makeDeps()
  const sessionId = openValuation(deps)
  const recordPath = `${CASE_DIR}/${PROJECT_RECORD_FILE}`
  ctx.files.set(recordPath, '{ not json')

  const result = await run(deps, VALID_ARGS, execOf(sessionId))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.equal(deps.valuationScopes.planOf(sessionId, 'plan-001'), false)
  assert.equal(ctx.files.get(recordPath), '{ not json')
  assert.equal([...ctx.files.keys()].some((path) => path.endsWith('项目估值方案索引.json')), false, '拒绝准备时不得落盘方案索引')
})
