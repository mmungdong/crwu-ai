import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { applyShellEffect, probeAnswer } from '../../helpers/shell-effects.mjs'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'

async function fixture() {
  const service = await import('../../../src/host/integrations/valuation-workflow/services/listing-reference.ts')
  const scopes = new ValuationScopes()
  scopes.open({ valuationId: 'project-1', projectId: 'project-1', sessionId: 'parent-1', parentSessionId: 'parent-1',
    casePath: '/workspace/project-1', workspaceId: 'workspace-1', workspacePath: '/workspace', planIds: ['plan-1'], openedAt: 1,
    snapshot: { valuationId: 'project-1', method: 'market', baseDate: '', supplementalPrompt: '', digest: 'sha256:fixture', files: [], frozenAt: '2026-10-17' } })
  const calls = []
  const deps = { ctx: {}, config: {}, valuationScopes: scopes,
    world: { platform: async () => { calls.push('platform'); return 'darwin-arm64' } },
    access: { runShell: async () => { calls.push('shell'); throw new Error('must not start') } },
    python: { check: async () => { calls.push('python'); return { ok: false, state: 'missing-package', path: '', versionText: '', source: 'fixture' } } },
  }
  const principal = { sessionId: 'parent-1', caseDir: '/workspace/project-1', source: 'workflow-runtime', agent: { id: 'parent-1' } }
  return { service, deps, principal, calls }
}

test('template preparation binds the current actor and registered plan before capability or filesystem access', async () => {
  const { service, deps, principal, calls } = await fixture()
  assert.equal(typeof service.prepareListingReferenceTemplate, 'function')
  for (const [input, actor] of [[{ planId: 'plan-1' }, { ...principal, sessionId: 'foreign' }],
    [{ planId: 'foreign' }, principal], [{ planId: '../outside' }, principal]]) {
    const result = await service.prepareListingReferenceTemplate(input, deps, actor)
    assert.equal(result.ok, false)
    assert.deepEqual(calls, [])
  }
})

test('missing Python capability stops template preparation before staging or shell execution', async () => {
  const { service, deps, principal, calls } = await fixture()
  assert.equal(typeof service.prepareListingReferenceTemplate, 'function')
  const result = await service.prepareListingReferenceTemplate({ planId: 'plan-1' }, deps, principal)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.deepEqual(calls, ['python'])
})


async function preparedFixture({ corruptRead = false, failedScript = false } = {}) {
  const f = await fixture()
  const dirs = new Set()
  const files = new Map()
  const reads = []
  const byteReceipt = Buffer.from('PK\x03\x04synthetic-host-byte-receipt')
  const digest = 'sha256:' + createHash('sha256').update(byteReceipt).digest('hex')
  const target = '/workspace/project-1/方案/plan-1/模板/挂牌参考计算表.xlsx'
  const sandbox = { requested: '', resolved: '', ran: '', denied: false, runnerFailed: false }
  f.deps.ctx = { get: (name) => name === 'fs' ? {
    resolve: async (path) => ({ targetKey: path, displayPath: path }),
    writeText: async (target, content) => { files.set(target.targetKey, content); return {} },
    readText: async (target) => { if (!files.has(target.targetKey)) throw new Error('not staged'); return files.get(target.targetKey) },
    readBytes: async (entry) => { reads.push(entry.targetKey); return corruptRead ? Buffer.from('PK\x03\x04changed') : byteReceipt },
  } : undefined }
  f.deps.python.check = async () => ({ ok: true, path: '/synthetic/python', source: 'test', versionText: '3.test' })
  f.deps.access.runShell = async (call, command) => {
    f.calls.push({ call, command })
    if (call.operation === 'python.script.run') {
      if (failedScript) return { ok: false, exitCode: 1, error: '', stderr: 'Bearer synthetic-private-token', sandbox }
      return { ok: true, exitCode: 0, error: '', sandbox, stdout: JSON.stringify({ ok: true, template: {
        fileName: '挂牌参考计算表.xlsx', relativePath: '模板/挂牌参考计算表.xlsx',
        digest, size: byteReceipt.length, verified: true,
        sheetRanges: { 估值结果: 'A1:E5' },
        mapping: [{ field: 'unitPrice', sheet: '估值结果', range: 'B5' }],
        formulaChecks: [{ name: 'synthetic-native-receipt', ok: true }],
      } }) }
    }
    applyShellEffect(command, 0, { addDir: (path) => dirs.add(path), removeFile() {} })
    return { ok: true, exitCode: 0, error: '', sandbox,
      stdout: probeAnswer(command, { hasDir: (path) => dirs.has(path), hasFile: (path) => files.has(path) }) ?? '' }
  }
  return { ...f, reads, digest, target }
}

test('prepared template receipt is bound to Host-read bytes and the exact case-relative plan path', async () => {
  const f = await preparedFixture()
  const result = await f.service.prepareListingReferenceTemplate({ planId: 'plan-1' }, f.deps, f.principal)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(f.reads, [f.target])
  assert.equal(result.template.digest, f.digest)
  assert.equal(result.template.relativePath, '方案/plan-1/模板/挂牌参考计算表.xlsx')
  const pythonCall = f.calls.find((call) => typeof call === 'object' && call.call.operation === 'python.script.run')
  assert.match(pythonCall.command, /--prepare-template/)
  assert.doesNotMatch(pythonCall.command, /--input/)
})

test('changed bytes after native preparation cannot become a verified plan template', async () => {
  const f = await preparedFixture({ corruptRead: true })
  const result = await f.service.prepareListingReferenceTemplate({ planId: 'plan-1' }, f.deps, f.principal)
  assert.equal(result.ok, false)
  assert.equal(result.template, undefined)
  assert.deepEqual(f.reads, [f.target])
})

test('failed native preparation hides raw stderr and never publishes a template', async () => {
  const f = await preparedFixture({ failedScript: true })
  const result = await f.service.prepareListingReferenceTemplate({ planId: 'plan-1' }, f.deps, f.principal)
  assert.equal(result.ok, false)
  assert.equal(result.template, undefined)
  assert.deepEqual(f.reads, [])
  assert.doesNotMatch(JSON.stringify(result), /Bearer|synthetic-private-token/)
})
