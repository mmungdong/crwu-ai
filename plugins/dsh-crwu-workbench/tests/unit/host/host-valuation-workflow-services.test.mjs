/**
 * Reusable valuation service boundary regressions (tests-only).
 *
 * The registered Tools are schema/transport wrappers now; these tests exercise the
 * shared services directly: live scope binding, denial before any broker I/O, and the
 * fact that the Tool entry points delegate instead of duplicating business execution.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { ValuationScopes } = await import(
  new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const access = await import(
  new URL('src/host/integrations/valuation-workflow/services/access.ts', ROOT).href)
const knowledge = await import(
  new URL('src/host/integrations/valuation-workflow/services/knowledge.ts', ROOT).href)
const listing = await import(
  new URL('src/host/integrations/valuation-workflow/services/listing-reference.ts', ROOT).href)
const knowledgeDomain = await import(
  new URL('src/host/domains/report-evaluation/knowledge/index.ts', ROOT).href)

const CASE_DIR = '/cases/space/估值-20261017-120000-aa11'
const OTHER_CASE = '/cases/space/估值-20261017-120000-bb22'
const SESSION = 'valuation-session-1'
const PLAN = 'plan-001'

function scopesWith({ sessionId = SESSION, casePath = CASE_DIR, planIds = [PLAN] } = {}) {
  const scopes = new ValuationScopes()
  scopes.open({
    valuationId: '估值-20261017-120000-aa11',
    projectId: '估值-20261017-120000-aa11',
    casePath,
    sessionId,
    workspaceId: 'w1',
    workspacePath: '/cases/space',
    planIds,
    snapshot: {
      valuationId: '估值-20261017-120000-aa11', method: 'market', baseDate: '',
      supplementalPrompt: '', digest: 'sha256:x', frozenAt: '2026-10-17T00:00:00.000Z', files: [],
    },
    openedAt: 1,
  })
  return scopes
}

function fakeDeps(scopes) {
  const broker = []
  return {
    broker,
    deps: {
      ctx: {},
      config: {},
      world: { platform: async () => 'darwin-arm64' },
      valuationScopes: scopes,
      access: {
        async runShell(call, command) {
          broker.push({ call, command })
          return { ok: false, error: 'must not run in a denial test' }
        },
      },
    },
  }
}

function principal(overrides = {}) {
  return { sessionId: SESSION, caseDir: CASE_DIR, source: 'workflow-runtime', ...overrides }
}

test('actor binding fails closed on an unknown session or a foreign case', () => {
  const scopes = scopesWith()
  const unknown = access.requireBoundValuationActor(principal({ sessionId: 'unknown' }), { valuationScopes: scopes })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.errorKind, 'policy')

  const foreign = access.requireBoundValuationActor(principal({ caseDir: OTHER_CASE }), { valuationScopes: scopes })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.errorKind, 'policy')

  const bound = access.requireBoundValuationActor(principal(), { valuationScopes: scopes })
  assert.equal(bound.ok, true, bound.error)
  assert.equal(bound.actor.caseDir, CASE_DIR)
  assert.equal(bound.actor.projectId, '估值-20261017-120000-aa11')
  assert.deepEqual(bound.actor.planIds, [PLAN])
  assert.match(bound.actor.scopeKey, /估值-20261017-120000-aa11/)
})

test('knowledge service denies an unknown session and an invalid path before broker I/O', async () => {
  const scopes = scopesWith()
  const unknown = fakeDeps(scopes)
  const denied = await knowledge.runKnowledgeMaterialization({}, unknown.deps, principal({ sessionId: 'unknown' }))
  assert.equal(denied.ok, false)
  assert.equal(denied.errorKind, 'policy')
  assert.equal(unknown.broker.length, 0, 'no broker call before the actor is bound')

  const badPath = fakeDeps(scopes)
  const invalid = await knowledge.runKnowledgeMaterialization(
    { wikiPaths: ['../outside.md'] }, badPath.deps, principal(),
  )
  assert.equal(invalid.ok, false)
  assert.equal(invalid.errorKind, 'input')
  assert.equal(badPath.broker.length, 0, 'path validation precedes any I/O')
})

test('listing service denies a missing plan, an unregistered plan and a foreign case before broker I/O', async () => {
  const scopes = scopesWith()

  const noPlan = fakeDeps(scopes)
  const missing = await listing.runListingReference({ planId: '' }, noPlan.deps, principal())
  assert.equal(missing.ok, false)
  assert.equal(missing.errorKind, 'input')
  assert.equal(noPlan.broker.length, 0)

  const unregistered = fakeDeps(scopes)
  const notOwned = await listing.runListingReference({ planId: 'plan-other' }, unregistered.deps, principal())
  assert.equal(notOwned.ok, false)
  assert.equal(notOwned.errorKind, 'policy')
  assert.equal(unregistered.broker.length, 0)

  const foreign = fakeDeps(scopes)
  const wrongCase = await listing.runListingReference(
    { planId: PLAN }, foreign.deps, principal({ caseDir: OTHER_CASE }),
  )
  assert.equal(wrongCase.ok, false)
  assert.equal(wrongCase.errorKind, 'policy')
  assert.equal(foreign.broker.length, 0)
})

test('registered Tools are thin wrappers over the shared services', () => {
  const knowledgeTool = readFileSync(
    new URL('src/host/tools/report-evaluation/knowledge.ts', ROOT), 'utf8')
  const listingTool = readFileSync(
    new URL('src/host/tools/report-evaluation/listing-reference.ts', ROOT), 'utf8')

  assert.match(knowledgeTool, /runKnowledgeMaterialization/)
  assert.match(listingTool, /runListingReference/)
  // No duplicated business execution in the transport layer.
  for (const forbidden of ['materializeKnowledge(', 'python.script.run', 'build_listing_reference.py', 'stagedValuationScript(']) {
    assert.equal(knowledgeTool.includes(forbidden), false, `knowledge Tool must not own ${forbidden}`)
    assert.equal(listingTool.includes(forbidden), false, `listing Tool must not own ${forbidden}`)
  }
  // The services are the only owners of the real business I/O.
  const knowledgeService = readFileSync(
    new URL('src/host/integrations/valuation-workflow/services/knowledge.ts', ROOT), 'utf8')
  const listingService = readFileSync(
    new URL('src/host/integrations/valuation-workflow/services/listing-reference.ts', ROOT), 'utf8')
  assert.match(knowledgeService, /materializeKnowledge\(/)
  assert.match(knowledgeService, /manifestRequested/)
  assert.match(listingService, /python\.script\.run/)
  assert.match(listingService, /--validate/)
})

// ---------------------------------------------------------------------------
// Validator identity and explicit manifest omission
// ---------------------------------------------------------------------------

test('validator rejects a foreign fixed-input project before Python or staging', async () => {
  const scopes = scopesWith()
  let pythonCalls = 0
  const foreign = JSON.stringify({ projectId: 'project-b', planId: PLAN, valuationMode: 'listing-reference' })
  const fs = {
    resolve: async (path) => ({ displayPath: path, targetKey: path }),
    readText: async () => foreign,
    stat: async () => ({ type: 'file', size: 100 }),
    contains: () => true,
  }
  const deps = {
    ctx: { get: (name) => (name === 'fs' ? fs : undefined) },
    config: {},
    world: { platform: async () => 'darwin-arm64' },
    valuationScopes: scopes,
    access: { runShell: async () => { throw new Error('no shell before identity validation') } },
    python: {
      check: async () => {
        pythonCalls += 1
        return { ok: false, state: 'missing', path: '', versionText: '', source: 'synthetic-test' }
      },
    },
  }
  const result = await listing.validateListingReferenceArtifacts({ planId: PLAN }, deps, principal())
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'input', 'foreign fixed input must fail as an identity mismatch')
  assert.equal(pythonCalls, 0, 'foreign project must be denied before Python or staging')
})

function knowledgeCatalog() {
  return {
    spaceName: knowledgeDomain.VALUATION_KNOWLEDGE_SPACE,
    verified: true,
    files: [{
      name: 'wiki.md', path: '01 房地产/wiki.md', extension: 'md',
      updatedAt: '2026-10-17T00:00:00.000Z', body: '# 入口\n正文。\n',
    }],
    folders: ['01 房地产'],
    failures: [],
  }
}

function knowledgeDomainDeps() {
  let manifestCalls = 0
  return {
    get manifestCalls() { return manifestCalls },
    deps: {
      spaceName: knowledgeDomain.VALUATION_KNOWLEDGE_SPACE,
      manifestDir: '',
      loadCatalog: async () => knowledgeCatalog(),
      loadManifest: async () => {
        manifestCalls += 1
        throw new Error('manifest loader must not be called when unrequested')
      },
      readBody: async () => ({ ok: true, body: 'x' }),
      writeSnapshot: async () => ({ ok: true, error: '' }),
      writeIndex: async () => ({ ok: true, error: '' }),
      now: () => new Date('2026-10-17T00:00:00.000Z'),
    },
  }
}

test('an explicitly unrequested manifest is never fetched or reported missing', async () => {
  const domain = knowledgeDomainDeps()
  const manifest = await knowledgeDomain.materializeKnowledge({
    projectId: 'project-a',
    wikiPaths: ['01 房地产/wiki.md'],
    manifestRequested: false,
  }, domain.deps)

  assert.equal(domain.manifestCalls, 0, 'the unrequested manifest loader must not run')
  assert.equal(manifest.ok, true, manifest.error)
  assert.equal(manifest.capabilityGaps.length, 0)
  const warnings = manifest.warnings.join('；')
  assert.match(warnings, /显式声明不读取/)
  assert.doesNotMatch(warnings, /读不到|不可用/)
})

test('omitting the manifest without a Wiki path reports no usable entry, not a failed read', async () => {
  const domain = knowledgeDomainDeps()
  const manifest = await knowledgeDomain.materializeKnowledge({
    projectId: 'project-a',
    manifestRequested: false,
  }, domain.deps)

  assert.equal(domain.manifestCalls, 0)
  assert.equal(manifest.ok, false)
  assert.match(manifest.error, /没有可用的知识入口/)
  assert.doesNotMatch(manifest.error, /读不到/)
})
