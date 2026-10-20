import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync, existsSync, unlinkSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'
import { knowledgeDigest } from '../../../src/host/domains/report-evaluation/knowledge/snapshot.ts'
import { PYTHON_RUNTIME_SOURCE } from '../../../src/host/core/runtime/python.ts'
import { applyShellEffect, probeAnswer } from '../../helpers/shell-effects.mjs'

// The explicitly supplied test runtime is capability-probed; no PATH fallback or install.
const python = process.env.CRWU_TEST_PYTHON ?? ''
const script = fileURLToPath(new URL('../../../skills/biz/crwu-biz-valuation-realestate/scripts/build_listing_reference.py', import.meta.url))
const enabled = python !== '' && process.platform !== 'win32'
if (enabled) execFileSync(python, ['-c', 'import openpyxl; import sys; print(sys.version_info.major)'], { stdio: 'pipe' })

async function fixture(t, withMetadata = false) {
  const { createWorkflowCalculationPorts } = await import('../../../src/host/integrations/valuation-workflow/production/calculation.ts')
  const root = await mkdtemp(join(tmpdir(), 'crwu-native-calculation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const planRoot = join(root, '方案/plan-fixture')
  await mkdir(planRoot, { recursive: true })
  const prepared = JSON.parse(execFileSync(python, [script, '--prepare-template', '--out-dir', planRoot, '--case-root', planRoot], { encoding: 'utf8' }))
  assert.equal(prepared.ok, true)
  const template = { ...prepared.template, relativePath: `方案/plan-fixture/${prepared.template.relativePath}` }
  const quote = '相似性及可靠性接近的挂牌报价可以取原始单价算术平均，仅供参考，不作修正和折扣。'
  const policy = { sourceId: 'policy-fixture', spaceName: '合成业务库', path: '合成参考政策.adoc', digest: knowledgeDigest(quote), body: quote }
  const observations = [31000, 33000].map((unitPrice, index) => ({
    sourceId: `fang:https://example.invalid/listing/${index + 1}`, caseId: `case-${index + 1}`, unitPrice,
    listingKind: 'listing', transactionType: '挂牌', sourceUrl: `https://example.invalid/listing/${index + 1}`,
    capturedAt: '2026-10-18T00:00:00Z', provider: 'fang', community: '合成小区', propertyType: '公寓',
    areaSqm: 100, screenshot: '', screenshotDigest: '', screenshotMissing: true,
  }))
  const first = observations[0]
  const plan = { digest: 'sha256:synthetic-approved-plan', revision: 1, ready: true, accepted: true, gaps: [],
    method: 'market', valuationMode: 'listing-reference', algorithm: 'raw-unit-price-arithmetic-mean',
    template, basis: [{ sourceId: policy.sourceId, quote }], limitations: ['合成测试数据，仅用于程序验收'],
    sources: [{ providerId: 'fang', state: 'verified', community: first.community, detailUrl: first.sourceUrl,
      fields: { unitPrice: first.unitPrice, areaSqm: 100, observed: {
        row: { source: 'fang', url: first.sourceUrl, community: first.community, unit_price: first.unitPrice,
          building_area: 100, transaction_type: 'listing', captured_at: first.capturedAt },
        capture: { ok: true, status: 200, bytes: 12, file: '来源证据/合成详情.html', digest: 'sha256:synthetic-html', sourceUrl: first.sourceUrl },
      } }, transactionType: 'listing', evidence: '来源证据/合成详情.html' }],
  }
  const input = { runId: 'run-fixture', revision: 1, objectId: 'object-fixture', operation: 'listing-reference-mean',
    samples: observations.map(({ sourceId, unitPrice }) => ({ sourceId, unitPrice })), observations,
    areaSqm: 100, subject: { useLabel: '公寓', purpose: '', baseDate: '' }, knowledge: [policy],
    evidenceOutput: { assessments: observations.map(({ sourceId }) => ({ sourceId, status: 'qualified',
      reason: '同小区公寓，挂牌报价性质明确', knowledge: { sourceId: policy.sourceId, digest: policy.digest, quote } })) },
    assessment: { mode: 'listing-reference', objectId: 'object-fixture', areaSqm: 100, revision: 1, plan, retrievalAttempts: [] },
  }
  const scopes = new ValuationScopes()
  scopes.open({ valuationId: 'project-fixture', projectId: 'project-fixture', sessionId: 'parent-fixture', parentSessionId: 'parent-fixture',
    casePath: root, workspaceId: 'workspace-fixture', workspacePath: root, openedAt: 1, planIds: ['plan-fixture'],
    snapshot: { valuationId: 'project-fixture', method: 'market', baseDate: '', supplementalPrompt: '', digest: 'sha256:frozen', files: [], frozenAt: '2026-10-18' } })
  const inside = (path) => { assert.equal(relative(root, resolve(path)).startsWith('..'), false); return path }
  const fs = { resolve: async (path) => ({ targetKey: inside(path), displayPath: path }),
    stat: async (target) => { const info = statSync(target.targetKey); return { type: info.isDirectory() ? 'directory' : 'file', size: info.size } },
    writeText: async (target, body) => { await writeFile(target.targetKey, body); return {} },
    readText: async (target) => readFile(target.targetKey, 'utf8'), readBytes: async (target) => readFile(target.targetKey) }
  const shell = async (call, command) => {
    let stdout = ''
    if (call.operation === 'python.script.run') {
      const argv = command.match(/'[^']*'|[^\s]+/g).map((value) => value.startsWith("'") ? value.slice(1, -1) : value)
      assert.equal(argv.shift(), python)
      assert.equal(argv[0], join(root, 'scripts/build_listing_reference.py'))
      stdout = execFileSync(python, argv, { encoding: 'utf8' })
    } else {
      applyShellEffect(command, 0, { addDir: (path) => mkdirSync(inside(path), { recursive: true }),
        removeFile: (path) => { inside(path); if (existsSync(path)) unlinkSync(path) } })
      stdout = probeAnswer(command, { hasDir: (path) => { try { return statSync(path).isDirectory() } catch { return false } },
        hasFile: (path) => { try { return statSync(path).isFile() } catch { return false } } }) ?? ''
    }
    return { ok: true, exitCode: 0, stdout, stderr: '', error: '', sandbox: { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false } }
  }
  const files = []
  if (withMetadata) {
    const body = '合成产权资料：规划用途公寓，建筑面积100平方米'
    await mkdir(join(root, '资料'))
    await writeFile(join(root, '资料/合成产权.txt'), body)
    files.push({ fileId: 'title-file', fileName: '合成产权.txt', archiveRelativePath: '资料/合成产权.txt',
      kind: 'text', sizeBytes: Buffer.byteLength(body), sha256: knowledgeDigest(body), readable: true })
    input.assessment.retrievalAttempts = [{ provider: 'lianjia', outcome: 'failed', stage: 'search', reason: '合成验证码阻断' }]
  }
  let receipt
  const ports = createWorkflowCalculationPorts({ projectId: 'project-fixture', planId: 'plan-fixture', casePath: () => root,
    frozenInput: { projectId: 'project-fixture', inputDigest: 'sha256:frozen', files, methodRequest: 'market',
      valueType: withMetadata ? '市场价值' : null, supplementalPrompt: withMetadata ? '保留公寓原始用途' : '' },
    principal: () => ({ sessionId: 'parent-fixture', caseDir: root, source: 'workflow-runtime' }),
    deps: { ctx: { get: (name) => name === 'fs' ? fs : undefined }, valuationScopes: scopes,
      config: {}, world: { platform: async () => process.platform }, access: { authorize: () => ({ ok: true }), note() {}, runShell: shell },
      python: { check: async () => ({ ok: true, path: python, versionText: 'test capability verified', source: PYTHON_RUNTIME_SOURCE }) } },
    getReceipt: async () => receipt, saveReceipt: async (value) => { receipt = structuredClone(value) },
  })
  return { ports, input, planRoot, receipt: () => receipt }
}

test('native adapter fills the approved table using additional cases and binds its full calculation digest', { skip: !enabled && 'set CRWU_TEST_PYTHON for the macOS/Linux native calculation acceptance' }, async (t) => {
  const f = await fixture(t)
  const result = await f.ports.calculator.compute(f.input)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.unitPrice, 32000)
  assert.equal(result.totalPrice, 3200000)
  const trace = JSON.parse(await readFile(join(f.planRoot, '计算轨迹.json'), 'utf8'))
  assert.equal(f.receipt().inputDigest, trace.inputDigest)
  assert.notEqual(f.receipt().inputDigest, 'sha256:frozen')
  const data = JSON.parse(await readFile(join(f.planRoot, '估值报告数据.json'), 'utf8'))
  assert.equal(data.knowledgeSources[0].sourceId, 'policy-fixture')
  assert.equal(data.knowledgeSources[0].spaceName, '合成业务库')
  assert.equal(data.provisionalResults[0].valueScope ?? null, null, 'an unconfirmed value scope must not be invented')
  assert.match(data.limitations.join('；'), /价值范围|房地范围/)
  const html = await readFile(join(f.planRoot, '估值报告.html'), 'utf8')
  assert.match(html, /合成参考政策/)
  const verified = await f.ports.verification.verify({ runId: 'run-fixture', revision: 2, objectId: 'object-fixture', artifacts: f.receipt().artifacts.map((item) => item.name) })
  assert.equal(verified.ok, true, verified.error)
})

test('native semantic success cannot override a mismatched saved artifact digest', { skip: !enabled && 'set CRWU_TEST_PYTHON for native acceptance' }, async (t) => {
  const f = await fixture(t)
  const result = await f.ports.calculator.compute(f.input)
  assert.equal(result.ok, true, result.error)
  f.receipt().artifacts[0].digest = `sha256:${'0'.repeat(64)}`
  const verified = await f.ports.verification.verify({ runId: 'run-fixture', revision: 2, objectId: 'object-fixture', artifacts: f.receipt().artifacts.map((item) => item.name) })
  assert.equal(verified.ok, false)
})

test('real archived materials, source failures and confirmed metadata survive the complete native report boundary', { skip: !enabled && 'set CRWU_TEST_PYTHON for native acceptance' }, async (t) => {
  const f = await fixture(t, true)
  const result = await f.ports.calculator.compute(f.input)
  assert.equal(result.ok, true, result.error)
  const data = JSON.parse(await readFile(join(f.planRoot, '估值报告数据.json'), 'utf8'))
  assert.equal(data.materials[0].archiveRelativePath, '资料/合成产权.txt')
  assert.equal(data.materials[0].readable, true)
  assert.match(data.materials[0].sha256, /^sha256:[a-f0-9]{64}$/)
  assert.equal(data.retrievalAttempts[0].providerId, 'lianjia')
  assert.equal(data.retrievalAttempts[0].outcome, 'failed')
  assert.match(data.retrievalAttempts[0].reasonCode, /合成验证码阻断/)
  assert.equal(data.methodRequest, 'auto')
  assert.equal(data.valueType, '市场价值')
  assert.equal(data.supplementalPrompt, '保留公寓原始用途')
  assert.equal(data.baseDate, null)
})
