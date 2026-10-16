/**
 * Project-level wiring tests for `crwu_valuation_finalize` (protocol 32 / design §11.4).
 *
 * The pure `finalizeProject` helper has its own tests; this file pins the Host-side project close-out:
 *
 * 1. `target=project` reads the authoritative project index and independently runs
 *    `collectPlanFinalizeFacts` + `finalizePlan` for every registered plan before aggregating;
 *    a missing / blocked / partial plan cannot be skipped or reported as a completed project.
 * 2. Only `completed` plan ids enter `aggregatablePlanIds` (interrupted amounts never contribute).
 * 3. Project identity / frozen digest / plan membership mismatches fail closed with no receipt.
 * 4. Only the registered parent session may finalize the project; child sessions are refused.
 * 5. `target=plan` (default) and its revision isolation stay unchanged.
 *
 * Everything uses in-memory fs plus the real gate/collectors; no real case directory is touched.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyShellEffect, probeAnswer, probeKey } from '../../helpers/shell-effects.mjs'
import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { valuationFinalizeTools } = await import(new URL('src/host/tools/report-evaluation/finalize.ts', ROOT).href)
const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)
const { valuationInputDigest } = await import(new URL('src/host/domains/report-evaluation/intake/preview.ts', ROOT).href)
const { FINALIZE_PATHS, planFilePath } = await import(
  new URL('src/host/domains/report-evaluation/delivery/finalize-facts.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const PROJECT_ID = '估值-20261016-100000-aa11'
const CASE_DIR = `${WORKSPACE}/${PROJECT_ID}`
const PROJECT_INDEX = '项目估值方案索引.json'
const RECEIPT_FILE = '项目估值完成回执.json'
const PARENT_SESSION = 'valuation-parent-1'
const CHILD_SESSION = 'valuation-child-1'

/** 冻结输入：指纹由 `valuationInputDigest` 真算，不用手写常量。 */
const FROZEN_INPUT = {
  schemaVersion: 'crwu.valuation.input.v2',
  projectId: PROJECT_ID,
  assetType: 'real-estate',
  methodRequest: 'market',
  baseDate: '',
  purpose: '',
  valueType: '',
  supplementalPrompt: '',
  inputDigest: 'sha256:in',
  files: [],
}
const INPUT_DIGEST = valuationInputDigest({
  assetType: 'real-estate', methodRequest: 'market', baseDate: null, purpose: null,
  valueType: null, supplementalPrompt: '', files: [],
})

const CONFIG = {
  configSource: '', caseRoot: WORKSPACE, preferWorkspaceTitle: '', formName: '报告审核',
  ossBucket: '', ossPrefix: '', ossEndpoint: '', ossBaseUrl: '', ossLinkMode: 'signed',
  ossLinkTtlSeconds: 3600, autoUpload: true, requireTopLevelParent: true,
  valuation: {
    browser: { sitesFile: 'x', requiredSiteIds: [], optionalSiteIds: [], assistLoginChallenge: true },
    knowledge: { mirrorRoot: '', wikiPath: 'w', manifestPath: 'm' },
    // 配置了真实重算程序：完成判定里的"重算可被证伪"这一条才不会被机器探测一票否决。
    recalculation: { enginePath: '/opt/libreoffice/program/soffice' },
  },
}

const json = (value) => JSON.stringify(value, null, 2)

/** 内存 fs + 只读探测成功的 shell（与估值 revision / artifact 工具测试同一套写法）。 */
function makeCtx(seed = {}) {
  const directories = new Set([WORKSPACE, CASE_DIR, `${CASE_DIR}/方案`])
  // Relative seed keys belong to the case directory; keep already-absolute keys as-is and make
  // sure every ancestor directory exists (the tool reads/writes with case-absolute paths).
  const files = new Map()
  const seedDirectory = (path) => {
    const parts = String(path).split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const dir = parts.slice(0, index).join('/')
      if (dir !== '') directories.add(dir)
    }
  }
  for (const [rawKey, value] of Object.entries(seed)) {
    const key = rawKey.startsWith('/') ? rawKey : `${CASE_DIR}/${rawKey}`
    files.set(key, value)
    seedDirectory(key)
  }
  const commands = []
  const shell = {
    resolve: (request) => ({ ...request, workdir: request.workdir ?? WORKSPACE, timeoutMs: 1, stdoutMaxBytes: 1024 }),
    async execute(spec) {
      commands.push(spec.command)
      const probe = probeAnswer(spec.command, {
        hasDir: (path) => directories.has(probeKey(path)),
        hasFile: (path) => files.has(probeKey(path)),
      })
      if (probe !== undefined) {
        return {
          result: async () => ({
            exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
            stdout: { text: probe, truncated: false }, stderr: { text: '', truncated: false },
          }),
        }
      }
      applyShellEffect(spec.command, 0, {
        addDir: (path) => directories.add(probeKey(path)),
        removeFile: (path) => files.delete(path),
      })
      return {
        result: async () => ({
          exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
        }),
      }
    },
  }
  const parentOf = (target) => String(target).replace(/[\\/][^\\/]+$/, '')
  const fs = {
    async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/, '')
      if (directories.has(key)) return { type: 'directory', version: 'v' }
      return files.has(target.targetKey) ? { type: 'file', size: String(files.get(target.targetKey)).length, version: 'v' } : undefined
    },
    async readText(target) { return files.get(target.targetKey) ?? '' },
    async writeText(target, content) {
      const parent = parentOf(target.targetKey)
      if (!directories.has(parent)) {
        const error = new Error(`ENOENT: no such file or directory, open '${String(target.targetKey)}'`)
        error.code = 'ENOENT'
        throw error
      }
      files.set(target.targetKey, content)
      return { operation: 'create', version: 'v' }
    },
    async mkdir(target) { directories.add(String(target.targetKey)); return { version: 'v' } },
    contains(parent, child) {
      const p = String(parent.displayPath).replace(/[\\/]+$/, '')
      const c = String(child.displayPath)
      return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`)
    },
  }
  return {
    files, directories, commands,
    get(name) {
      if (name === 'fs') return fs
      if (name === 'shell') return shell
      return undefined
    },
    effect() { return () => {} },
  }
}

function makeDeps({ ctx = makeCtx(), scopes = new ValuationScopes() } = {}) {
  const state = { ...createWorkbenchState(CONFIG), localAccess: grantedConsent() }
  const { access } = makeTestAccess(ctx, { state })
  const deps = {
    ctx, config: CONFIG, state,
    world: { workdir: async () => WORKSPACE, platform: async () => 'darwin' },
    access,
    discussionScopes: createDiscussionScopeRegistry(),
    valuationScopes: scopes,
    python: undefined,
    screenshot: undefined,
  }
  return { deps, ctx, scopes }
}

function openProject(scopes, sessionId = PARENT_SESSION, overrides = {}) {
  scopes.open({
    valuationId: PROJECT_ID,
    projectId: PROJECT_ID,
    casePath: CASE_DIR,
    sessionId,
    parentSessionId: sessionId,
    workspaceId: 'w1',
    workspacePath: WORKSPACE,
    snapshot: {
      valuationId: PROJECT_ID, method: 'market', baseDate: '', supplementalPrompt: '',
      digest: INPUT_DIGEST, frozenAt: '2026-10-16T00:00:00.000Z', files: [],
    },
    planIds: ['plan-001', 'plan-002'],
    openedAt: 1,
    ...overrides,
  })
  return sessionId
}

function execOf(sessionId, { parentSessionId = '' } = {}) {
  return {
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'),
    name: VALUATION_TOOL_NAMES.finalize, arguments: {},
    signal: new AbortController().signal,
    agent: {
      id: sessionId,
      session: { id: sessionId, header: parentSessionId === '' ? {} : { parentSession: parentSessionId } },
    },
    deferContext() {}, concludeTurn() {},
  }
}

/** 一个方案的完整交付件（内容不必真实：收集器只做形状与存在性判断）。 */
function planDeliverables(planId, objectId) {
  const at = (name) => planFilePath(planId, name)
  return {
    [at(FINALIZE_PATHS.reportData)]: json({
      calculationSteps: [{ stepId: 'step-1', value: '42000' }],
      conclusions: [{
        objectId, valueScope: 'land-and-building', method: 'market',
        unitPrice: '42000', totalValue: '3749760', currency: 'CNY',
        basisRefs: [{ routeId: 'realestate.method.market', snapshotDigest: 'sha256:k' }],
        calculationRef: 'calc-1',
      }],
      workbooks: [{
        workbookId: `wb-${planId}`, relativePath: at(FINALIZE_PATHS.workbook),
        templateId: 'T1', templateDigest: 'sha256:t', objectIds: [objectId],
      }],
    }),
    [at(FINALIZE_PATHS.reportHtml)]: '<html>报告</html>',
    [at(FINALIZE_PATHS.workbook)]: `xlsx-${planId}`,
    [at('模板验真.json')]: json({ templateId: 'T1', digest: 'sha256:t', expectedDigest: 'sha256:t', structureOk: true }),
    [at(FINALIZE_PATHS.screenshotManifest)]: json({
      entries: [{
        caseId: `C-${planId}`, displayName: '样例', provider: 'lianjia',
        sourceUrl: 'https://example.invalid/1', capturedAt: 't',
        relativePath: `推理结果/图片/${planId}.png`, digest: 'sha256:p', validity: 'valid',
      }],
    }),
    [at(FINALIZE_PATHS.artifactManifest)]: json({ ok: true, missing: [] }),
    [at(FINALIZE_PATHS.recalculation)]: json({
      state: 'recalculated', verified: true, reason: '重算提供方执行通过', providerId: 'libreoffice.local', observed: [],
    }),
  }
}

const KNOWLEDGE_INDEX = json({
  entries: [{
    routeId: 'realestate.method.market', nodeName: '02-市场法', digest: 'sha256:k',
    source: 'dws', spaceName: '中瑞世联业务知识库', snapshotFile: '知识快照/02-市场法.md',
    bodyNonEmpty: true, updatedAt: '2026-10-01',
  }],
})

/**
 * 造一个项目：`specs` 里的方案 `complete` 为真才有交付件；
 * `indexPatch` 用来构造项目身份 / 摘要 / 方案清单的异常。
 */
function seedProject(specs, indexPatch = {}) {
  const files = {
    [FINALIZE_PATHS.frozenInput]: json(FROZEN_INPUT),
    [FINALIZE_PATHS.knowledgeIndex]: KNOWLEDGE_INDEX,
  }
  const objects = []
  const plans = []
  for (const spec of specs) {
    objects.push({ objectId: spec.objectId })
    plans.push({ planId: spec.planId, objectIds: [spec.objectId], valuationPath: 'combined' })
    if (spec.complete) Object.assign(files, planDeliverables(spec.planId, spec.objectId))
  }
  files[PROJECT_INDEX] = json({
    schemaVersion: 'crwu.valuation.project.v1',
    projectId: PROJECT_ID,
    inputDigest: INPUT_DIGEST,
    objects,
    plans,
    ...indexPatch,
  })
  return files
}

async function runFinalize(ctx, scopes, args = {}, session = PARENT_SESSION, execOptions = {}) {
  const { deps } = makeDeps({ ctx, scopes })
  const tool = valuationFinalizeTools(deps)[0]
  return await tool.execute({ caseDir: CASE_DIR, ...args }, execOf(session, execOptions))
}

// ── 参数面 / 注册面 ─────────────────────────────────────────────────────────

test('参数面：finalize 显式接受 target（缺省 plan / project），工具名不变', () => {
  const tool = valuationFinalizeTools({ ctx: {}, config: {}, state: {}, world: {}, form: {}, access: {}, discussionScopes: {} })[0]
  assert.equal(tool.name, VALUATION_TOOL_NAMES.finalize)
  const props = tool.parameters.properties ?? tool.parameters
  assert.ok(Object.hasOwn(props, 'target'), 'target 是业务参数，不是命令 / 路径')
  const schema = JSON.stringify(tool.parameters)
  for (const forbidden of ['argv', 'command', 'sandbox', 'binary']) {
    assert.equal(schema.includes(forbidden), false, `参数面不许出现 ${forbidden}`)
  }
})

// ── 项目级完成判定 ─────────────────────────────────────────────────────────

test('项目目标：索引里两个方案只有一个完成 → 项目不 completed，只合计已完成的', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-002', objectId: 'object-002', complete: false },
  ]))
  const scopes = new ValuationScopes()
  openProject(scopes)

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.projectSummary?.present, true, '项目目标要带回项目摘要')
  assert.notEqual(result.projectSummary.status, 'completed',
    '一个方案没有交付件时，项目不能声称完成（单方案完成不能代表两个登记方案）')
  assert.equal(result.projectSummary.perPlan.length, 2, '两个登记方案都要出现在逐方案结论里')
  assert.deepEqual(result.projectSummary.aggregatablePlanIds, ['plan-001'],
    '只有 completed 方案的金额可以合计')
  assert.equal(result.projectSummary.conclusionIncludesBlockedAmount, false)

  const receiptPath = `${CASE_DIR}/${RECEIPT_FILE}`
  assert.equal(ctx.files.has(receiptPath), true, '项目汇总要落盘回执')
  const receipt = JSON.parse(ctx.files.get(receiptPath))
  assert.equal(receipt.projectId, PROJECT_ID)
  assert.equal(receipt.perPlan.length, 2)
  assert.notEqual(receipt.status, 'completed')
})

test('项目目标：两个方案都完成 → completed，回执含两份方案', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-002', objectId: 'object-002', complete: true },
  ]))
  const scopes = new ValuationScopes()
  openProject(scopes)

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.projectSummary?.present, true)
  assert.equal(result.projectSummary.status, 'completed', result.projectSummary.problems?.join('；'))
  assert.deepEqual(result.projectSummary.aggregatablePlanIds, ['plan-001', 'plan-002'])
  assert.deepEqual(result.projectSummary.perPlan, [
    { planId: 'plan-001', status: 'completed' }, { planId: 'plan-002', status: 'completed' },
  ])
  const receipt = JSON.parse(ctx.files.get(`${CASE_DIR}/${RECEIPT_FILE}`))
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.perPlan.length, 2)
})

test('项目目标：某方案被阻断（缺模板）→ 项目不 completed，阻断方案金额不合计', async () => {
  const files = seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-002', objectId: 'object-002', complete: true },
  ])
  // 把 plan-002 的模板验真记录拿掉：该方案被阻断，不能冒充完成。
  delete files[planFilePath('plan-002', '模板验真.json')]
  const ctx = makeCtx(files)
  const scopes = new ValuationScopes()
  openProject(scopes)

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, true, result.error)
  assert.notEqual(result.projectSummary?.status, 'completed')
  assert.deepEqual(result.projectSummary.aggregatablePlanIds, ['plan-001'])
  const blocked = result.projectSummary.perPlan.find((item) => item.planId === 'plan-002')
  assert.equal(blocked.status, 'blocked')
})

// ── fail closed：身份 / 摘要 / 方案清单 ────────────────────────────────────

test('项目目标：按项目索引里每个方案的 valuationPath 核对，不受调用方覆盖', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-002', objectId: 'object-002', complete: true },
  ], {
    plans: [
      { planId: 'plan-001', objectIds: ['object-001'], valuationPath: 'combined' },
      { planId: 'plan-002', objectIds: ['object-002'], valuationPath: 'unresolved' },
    ],
  }))
  const scopes = new ValuationScopes()
  openProject(scopes)

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.notEqual(result.projectSummary?.status, 'completed',
    'unresolved 方案不能按调用方的 combined 冒充完成')
  const second = result.projectSummary.perPlan.find((item) => item.planId === 'plan-002')
  assert.notEqual(second?.status, 'completed')
  assert.deepEqual(result.projectSummary.aggregatablePlanIds, ['plan-001'])
})

test('项目目标：索引里的方案不在本轮登记范围 → 拒绝，不跳过也不落回执', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-999', objectId: 'object-999', complete: true },
  ]))
  const scopes = new ValuationScopes()
  openProject(scopes) // 登记的 planIds 只有 plan-001 / plan-002

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.match(result.error, /plan-999|不属于|登记/)
  assert.equal(ctx.files.has(`${CASE_DIR}/${RECEIPT_FILE}`), false)
})

test('项目目标：不安全的方案 id → 拒绝，不落回执', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: '../plan-002', objectId: 'object-002', complete: true },
  ]))
  const scopes = new ValuationScopes()
  openProject(scopes)

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /方案|id|标识/)
  assert.equal(ctx.files.has(`${CASE_DIR}/${RECEIPT_FILE}`), false)
})

test('项目目标：项目索引里方案 id 重复 → 拒绝，不落回执', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
  ], {
    plans: [
      { planId: 'plan-001', objectIds: ['object-001'], valuationPath: 'combined' },
      { planId: 'plan-001', objectIds: ['object-001'], valuationPath: 'combined' },
    ],
  }))
  const scopes = new ValuationScopes()
  openProject(scopes)

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'input')
  assert.match(result.error, /重复|duplicate/)
  assert.equal(ctx.files.has(`${CASE_DIR}/${RECEIPT_FILE}`), false)
})

test('项目目标：登记过的方案被移出项目索引 → 拒绝（不能只核对留下的那一个）', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
  ], {
    plans: [{ planId: 'plan-001', objectIds: ['object-001'], valuationPath: 'combined' }],
  }))
  const scopes = new ValuationScopes()
  openProject(scopes) // 登记的 planIds 里仍有 plan-002

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /plan-002|索引/)
  assert.equal(ctx.files.has(`${CASE_DIR}/${RECEIPT_FILE}`), false)
})

test('项目目标：项目身份与宿主记录不一致 → 拒绝', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-002', objectId: 'object-002', complete: true },
  ], { projectId: '另一个项目' }))
  const scopes = new ValuationScopes()
  openProject(scopes)

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /项目|projectId|不一致/)
  assert.equal(ctx.files.has(`${CASE_DIR}/${RECEIPT_FILE}`), false)
})

test('项目目标：索引声明的冻结摘要与宿主记录不一致 → 拒绝', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-002', objectId: 'object-002', complete: true },
  ], { inputDigest: 'sha256:tampered' }))
  const scopes = new ValuationScopes()
  openProject(scopes)

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /摘要|inputDigest|不一致/)
  assert.equal(ctx.files.has(`${CASE_DIR}/${RECEIPT_FILE}`), false)
})

// ── 会话归属 ───────────────────────────────────────────────────────────────

test('项目目标：宿主没有登记父会话 → policy 拒绝，不落回执', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-002', objectId: 'object-002', complete: true },
  ]))
  const scopes = new ValuationScopes()
  // parentSessionId 缺失：无法证明调用方是登记的本轮父会话。
  openProject(scopes, PARENT_SESSION, { parentSessionId: '' })

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.match(result.error, /父会话|parentSession|登记/)
  assert.equal(ctx.files.has(`${CASE_DIR}/${RECEIPT_FILE}`), false)
})

test('只有登记为本轮父会话的会话能 finalize 项目；子会话被拒', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-002', objectId: 'object-002', complete: true },
  ]))
  const scopes = new ValuationScopes()
  // 登记的是父会话；子会话有自己的 scope 归属，但不是本轮父会话。
  openProject(scopes, PARENT_SESSION, { parentSessionId: PARENT_SESSION })
  scopes.open({
    valuationId: `${PROJECT_ID}-child`,
    projectId: PROJECT_ID,
    casePath: CASE_DIR,
    sessionId: CHILD_SESSION,
    parentSessionId: PARENT_SESSION,
    workspaceId: 'w1',
    workspacePath: WORKSPACE,
    snapshot: {
      valuationId: PROJECT_ID, method: 'market', baseDate: '', supplementalPrompt: '',
      digest: INPUT_DIGEST, frozenAt: '2026-10-16T00:00:00.000Z', files: [],
    },
    planIds: ['plan-001', 'plan-002'],
    openedAt: 2,
  })

  const result = await runFinalize(ctx, scopes, {
    target: 'project', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  }, CHILD_SESSION, { parentSessionId: PARENT_SESSION })

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.match(result.error, /父会话|只有.*父|project/)
  assert.equal(ctx.files.has(`${CASE_DIR}/${RECEIPT_FILE}`), false)
})

// ── plan 目标 / revision 隔离不变 ──────────────────────────────────────────

test('plan 目标：缺 planId → 输入错误，且不返回项目摘要', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-002', objectId: 'object-002', complete: true },
  ]))
  const scopes = new ValuationScopes()
  openProject(scopes)

  const result = await runFinalize(ctx, scopes, {
    target: 'plan', requestedStatus: 'completed', screenshotRequired: true, valuationPath: 'combined',
  })

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'input')
  assert.equal(result.projectSummary?.present, false)
})

test('plan 目标：初版交付件齐备 → completed；revision=2 读修订目录，不拿方案根顶替', async () => {
  const ctx = makeCtx(seedProject([
    { planId: 'plan-001', objectId: 'object-001', complete: true },
    { planId: 'plan-002', objectId: 'object-002', complete: true },
  ]))
  const scopes = new ValuationScopes()
  openProject(scopes)

  const base = await runFinalize(ctx, scopes, {
    target: 'plan', planId: 'plan-001', requestedStatus: 'completed',
    screenshotRequired: true, valuationPath: 'combined',
  })
  assert.equal(base.ok, true, base.error)
  assert.equal(base.status, 'completed', base.problems?.join('；'))
  assert.equal(base.projectSummary?.present, false, 'plan 目标不带项目摘要')

  const revision = await runFinalize(ctx, scopes, {
    target: 'plan', planId: 'plan-001', revision: 2, requestedStatus: 'completed',
    screenshotRequired: true, valuationPath: 'combined',
  })
  assert.notEqual(revision.status, 'completed', '修订版目录没有交付件，不能借方案根通过')
  assert.equal(revision.projectSummary?.present, false)
})
