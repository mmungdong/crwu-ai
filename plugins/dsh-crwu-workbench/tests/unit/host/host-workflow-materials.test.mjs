import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ValuationScopes } from '../../../src/host/domains/report-evaluation/scope.ts'

const load = () => import('../../../src/host/integrations/valuation-workflow/materials.ts')
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'crwu-workflow-materials-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const casePath = join(root, 'project')
  const files = []
  for (const [index, text] of ['用途：公寓；建筑面积86.4平方米', '评估目的：转让；基准日：2026-08-31'].entries()) {
    const relativePath = `资料/${index}/权证.txt`
    const absolutePath = join(casePath, relativePath)
    await mkdir(join(absolutePath, '..'), { recursive: true })
    await writeFile(absolutePath, text, 'utf8')
    const bytes = Buffer.from(text)
    files.push({ fileName: '权证.txt', relativePath, kind: 'text', sizeBytes: bytes.length, sha256: digest(bytes) })
  }
  const scopes = new ValuationScopes()
  scopes.open({
    valuationId: 'project', projectId: 'project', casePath, sessionId: 'parent',
    workspaceId: 'w1', workspacePath: root, openedAt: 1, planIds: [],
    snapshot: { valuationId: 'project', method: 'market', baseDate: '', supplementalPrompt: '', digest: 'sha256:fixture', files, frozenAt: '2026-10-17T00:00:00Z' },
  })
  const calls = { extract: [], probe: [] }
  const exec = { agent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal }
  const deps = {
    ctx: { get: () => undefined }, valuationScopes: scopes,
    python: { check: async (input) => {
      calls.probe.push(input)
      return { ok: true, state: 'ok', path: '/synthetic/python', source: 'fixture', missingPackages: [], distributions: {}, error: '' }
    } },
    world: { platform: async () => process.platform }, access: {},
  }
  const extractor = {
    canHandle: () => true,
    extract: async (input) => {
      calls.extract.push(input)
      return {
        fileName: input.fileName, fileType: 'text', text: await readFile(input.path, 'utf8'),
        tables: [], images: [], extractedFields: {}, warnings: [], capabilityGaps: [],
      }
    },
  }
  return { root, casePath, files, scopes, calls, exec, deps, extractor }
}

test('frozen material bytes, body and identities survive identical display names', async (t) => {
  const f = await fixture(t)
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.materials.length, 2)
  assert.equal(new Set(result.materials.map((material) => material.materialId)).size, 2)
  assert.deepEqual(result.materials.map((material) => material.fileName), ['权证.txt', '权证.txt'])
  assert.deepEqual(result.materials.map((material) => material.digest), f.files.map((file) => file.sha256))
  assert.match(result.materials[0].text, /用途：公寓/)
  assert.match(result.materials[1].text, /评估目的：转让/)
  assert.equal(new Set(f.calls.extract.map((input) => input.fileName)).size, 2,
    'internal extraction outputs need unique keys even when display names match')
  assert.equal(f.calls.probe.length, 1)
  assert.equal(f.calls.probe[0].agent, f.exec.agent)
})

test('changed bytes refuse the entire frozen input before extraction', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.casePath, f.files[1].relativePath), '篡改后的内容', 'utf8')
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'input-changed')
  assert.equal(f.calls.extract.length, 0)
})

test('an unknown caller never probes or extracts files', async (t) => {
  const f = await fixture(t)
  f.exec.agent.id = 'foreign'
  const { prepareWorkflowMaterials } = await load()
  assert.equal((await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)).ok, false)
  assert.equal(f.calls.probe.length, 0)
  assert.equal(f.calls.extract.length, 0)
})

test('a material changed during extraction cannot be published under the frozen digest', async (t) => {
  const f = await fixture(t)
  f.extractor.extract = async (input) => {
    f.calls.extract.push(input)
    await writeFile(input.path, '读取途中改变的内容', 'utf8')
    return { fileName: input.fileName, fileType: 'text', text: '读取途中改变的内容', tables: [], images: [], extractedFields: {}, warnings: [], capabilityGaps: [] }
  }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'input-changed')
  assert.equal(result.materials.some((material) => material.text.includes('读取途中改变的内容')), false)
})

test('a linked file cannot escape the registered case even with matching content', async (t) => {
  const f = await fixture(t)
  const target = join(f.root, 'outside.txt')
  await writeFile(target, await readFile(join(f.casePath, f.files[0].relativePath)))
  const original = join(f.casePath, f.files[0].relativePath)
  await rm(original)
  try { await symlink(target, original) } catch (error) {
    if (error.code === 'EPERM') { t.skip('symlink fixture requires local platform permission'); return }
    throw error
  }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, false)
  assert.equal(f.calls.extract.length, 0)
})

test('one environment failure stops the batch and marks remaining files unverified', async (t) => {
  const f = await fixture(t)
  f.extractor.extract = async (input) => {
    f.calls.extract.push(input)
    throw Object.assign(new Error('合成环境故障'), { kind: 'environment' })
  }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, false)
  assert.equal(f.calls.extract.length, 1)
  assert.equal(result.unverified.length, 2)
  for (const file of result.unverified) {
    assert.ok(file.reason)
    assert.ok(file.nextAction)
  }
})

test('a later environment failure retains already verified material jobs', async (t) => {
  const f = await fixture(t)
  const original = f.extractor.extract
  let n = 0
  f.extractor.extract = async (input) => {
    if (++n === 2) throw Object.assign(new Error('合成执行环境故障'), { kind: 'environment' })
    return original(input)
  }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, false)
  assert.equal(result.materials.length, 1)
  assert.match(result.materials[0].text, /用途：公寓/)
  assert.equal(result.unverified.length, 1)
})

test('a file-format failure stays local while other materials can be read', async (t) => {
  const f = await fixture(t)
  const original = f.extractor.extract
  let n = 0
  f.extractor.extract = async (input) => {
    if (++n === 1) throw Object.assign(new Error('合成单份格式故障'), { kind: 'material' })
    return original(input)
  }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, true)
  assert.equal(result.unverified.length, 1)
  assert.ok(result.materials.some((material) => material.text.includes('评估目的：转让')))
})

test('a format-wide capability gap stops matching jobs while other formats remain usable', async (t) => {
  const f = await fixture(t)
  for (const file of f.files) {
    const path = file.relativePath.replace(/\.txt$/, '.pdf')
    await rename(join(f.casePath, file.relativePath), join(f.casePath, path))
    file.relativePath = path
    file.fileName = '权证.pdf'
    file.kind = 'pdf'
  }
  const text = '可读取的文字材料'
  const relativePath = '资料/文字.txt'
  await writeFile(join(f.casePath, relativePath), text)
  f.files.push({ fileName: '文字.txt', relativePath, kind: 'text', sizeBytes: Buffer.byteLength(text), sha256: digest(Buffer.from(text)) })
  const original = f.extractor.extract
  f.extractor.extract = async (input) => {
    if (input.path.endsWith('.pdf')) {
      f.calls.extract.push(input)
      throw Object.assign(new Error('合成 PDF 库缺失'), { kind: 'environment', scope: 'format', format: '.pdf', state: 'missing' })
    }
    return original(input)
  }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, true)
  assert.equal(f.calls.extract.filter((input) => input.path.endsWith('.pdf')).length, 1)
  assert.equal(result.unverified.length, 2)
  assert.ok(result.materials.some((material) => material.text === text))
})

test('environment diagnostics cannot expose raw secret-bearing errors', async (t) => {
  const f = await fixture(t)
  f.deps.python.check = async () => { throw new Error('Bearer synthetic-private-token') }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, false)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-token|Bearer/)
  assert.equal(f.calls.extract.length, 0)
})

test('the production default prepares directories and uses the packaged Python extractor', async (t) => {
  const f = await fixture(t)
  let runs = 0
  const policies = []
  const policySessions = []
  const fs = {
    resolve: async (path) => ({ targetKey: String(path), displayPath: String(path) }),
    stat: async (target) => {
      const info = await stat(target.targetKey).catch(() => null)
      return info === null ? undefined : { type: info.isDirectory() ? 'directory' : 'file', size: info.size, version: 'v1' }
    },
    readText: async (target) => readFile(target.targetKey, 'utf8'),
    writeText: async (target, content, _condition, _signal, policy) => {
      policies.push(policy)
      await writeFile(target.targetKey, content, 'utf8')
      return { operation: 'create', version: 'v1' }
    },
  }
  f.deps.ctx = { get: (name) => name === 'fs' ? fs : name === 'sandboxPolicy' ? {
    resolve: ({ session }) => {
      policySessions.push(session)
      return { mode: 'workspace-write', workspaceRoot: f.root }
    },
  } : undefined }
  f.deps.access = {
    runShell: async (call, command, options) => {
      assert.equal(options.session, f.exec.agent.session)
      let stdout = ''
      if (call.operation === 'system.case-file.write') {
        await mkdir(join(f.casePath, 'scripts'), { recursive: true })
        await mkdir(join(f.casePath, '提取结果'), { recursive: true })
      } else if (call.operation === 'system.case-file.read') {
        stdout = 'directory'
      } else if (call.operation === 'python.script.run') {
        runs += 1
        assert.ok(command.includes('extract_files.py'))
        const out = command.match(/'([^']+\.json)'\s*$/)?.[1]
        assert.ok(out?.startsWith(f.casePath))
        const source = f.files.find((file) => command.includes(join(f.casePath, file.relativePath)))
        assert.ok(source)
        await writeFile(out, JSON.stringify({
          ok: true, fileType: 'text', text: await readFile(join(f.casePath, source.relativePath), 'utf8'),
          tables: [], images: [], extractedFields: {}, warnings: [], capabilityGaps: [],
        }))
      } else {
        assert.fail(`unexpected broker operation ${call.operation}`)
      }
      return { ok: true, exitCode: 0, stdout, stderr: '', error: '', truncated: false, timedOut: false, aborted: false,
        sandbox: { requested: 'workspace-write', resolved: 'workspace-write', ran: 'workspace-write', denied: false, runnerFailed: false } }
    },
  }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec)
  assert.equal(result.ok, true, result.error)
  assert.equal(runs, 2)
  assert.match(result.materials[0].text, /用途：公寓/)
  assert.ok(policies.length > 0)
  assert.ok(policies.every((policy) => policy.mode === 'workspace-write' && policy.workspaceRoot === f.root))
  assert.ok(policySessions.length > 0)
  assert.ok(policySessions.every((session) => session === f.exec.agent.session))
})

test('scanned material uses the visual reader and retains actual page coverage and child sessions', async (t) => {
  const f = await fixture(t)
  const reads = []
  f.extractor.extract = async () => ({ fileName: '权证.pdf', fileType: 'pdf', text: '', tables: [],
    images: [{ path: 'page-1.png', description: '第1页' }], extractedFields: {}, warnings: [], capabilityGaps: ['无文本层'],
    pageCount: 1, pagesWithoutText: 1, pages: [{ index: 1, hasTextLayer: false, chars: 0 }] })
  f.deps.visualReader = { read: async (input) => {
    reads.push(input)
    return { ok: true, text: '第1页：规划用途：公寓；建筑面积：86.4平方米', readPages: [1], sessionIds: ['actual-reading'], uncertainties: [] }
  } }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, true, result.error)
  assert.equal(reads.length, 2)
  assert.match(result.materials[0].text, /86.4/)
  assert.deepEqual(result.materials[0].visualReading.readPages, [1])
  assert.deepEqual(result.materials[0].visualReading.sessionIds, ['actual-reading'])
})

test('changed source bytes during visual reading cannot retain the frozen source identity', async (t) => {
  const f = await fixture(t)
  f.extractor.extract = async () => ({ fileName: '权证.pdf', fileType: 'pdf', text: '', tables: [], images: [{ path: 'page.png' }],
    extractedFields: {}, warnings: [], capabilityGaps: [], pageCount: 1, pages: [{ index: 1, hasTextLayer: false }] })
  f.deps.visualReader = { read: async () => {
    await writeFile(join(f.casePath, f.files[0].relativePath), 'changed during vision')
    return { ok: true, text: '规划用途：公寓', readPages: [1], sessionIds: ['actual-reading'], uncertainties: [] }
  } }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.errorKind, 'input-changed')
  assert.equal(result.materials.length, 0)
})

test('an unknown visual child stop halts material preparation and exposes the child to reconciliation', async (t) => {
  const f = await fixture(t)
  let parsed = 0
  f.extractor.extract = async () => { parsed += 1; return {
    fileName: '权证.pdf', fileType: 'pdf', text: '', tables: [], images: [{ path: 'page.png' }],
    extractedFields: {}, warnings: [], capabilityGaps: [], pageCount: 1, pages: [{ index: 1, hasTextLayer: false }],
  } }
  f.deps.visualReader = { read: async () => ({ ok: false, text: '', readPages: [], uncertainties: [],
    sessionIds: ['unknown-visual-child'], errorKind: 'stop-unknown', error: '合成停止状态未知' }) }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'stop-unknown')
  assert.equal(parsed, 1, 'no later material starts while an unknown child remains')
  assert.deepEqual(result.stopUnknown.sessionIds, ['unknown-visual-child'])
})

test('material cancellation cannot erase an unresolved visual child identity', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  f.exec.signal = controller.signal
  f.extractor.extract = async () => ({ fileName: '权证.pdf', fileType: 'pdf', text: '', tables: [],
    images: [{ path: 'page.png' }], extractedFields: {}, warnings: [], capabilityGaps: [] })
  f.deps.visualReader = { read: async () => {
    controller.abort()
    return { ok: false, text: '', readPages: [], uncertainties: [], sessionIds: ['cancelled-but-running'], errorKind: 'stop-unknown' }
  } }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.errorKind, 'stop-unknown')
  assert.deepEqual(result.stopUnknown.sessionIds, ['cancelled-but-running'])
})


test('material runtime discovery receives the genuine controlled execution', async (t) => {
  const f = await fixture(t)
  f.exec.token = Symbol('outer-registry')
  f.exec.rootCallId = 'root-workflow'
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, true, result.error)
  assert.equal(f.calls.probe[0].execution, f.exec)
})


test('missing PDF Python support uses native page rendering before actual visual reading', async (t) => {
  const f = await fixture(t)
  const { ExtractionFailure } = await import('../../../src/host/domains/report-evaluation/intake/python-extractor.ts')
  const scope = f.scopes.get('project')
  scope.snapshot.files.splice(1)
  scope.snapshot.files[0].fileName = '合成.pdf'
  scope.snapshot.files[0].kind = 'pdf'
  f.extractor.extract = async () => { throw new ExtractionFailure('environment', 'synthetic missing PDF library', { scope: 'format', format: '.pdf', state: 'missing' }) }
  let renders = 0
  f.deps.pdfRenderer = { render: async () => { renders += 1; return { ok: true, extracted: { fileName: '合成.pdf', fileType: 'pdf', text: '', tables: [], images: [{ path: 'native-pages/page.png', description: '#第1页' }], extractedFields: {}, warnings: [], capabilityGaps: [], pageCount: 1, capabilities: { pdfRender: true } } } } }
  f.deps.visualReader = { read: async (input) => ({ ok: true, text: '合成公寓，建筑面积86.4平方米', readPages: [1], sessionIds: ['actual-visual-child'], uncertainties: [] }) }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, true, result.error)
  assert.equal(renders, 1)
  assert.match(result.materials[0].text, /86.4/)
  assert.deepEqual(result.materials[0].visualReading.readPages, [1])
})

test('native rendering supplies the real page count when the parser reports zero unknown pages', async (t) => {
  const f = await fixture(t)
  const scope = f.scopes.get('project')
  scope.snapshot.files.splice(1)
  scope.snapshot.files[0].fileName = '合成.pdf'
  scope.snapshot.files[0].kind = 'pdf'
  f.extractor.extract = async () => ({ fileName: '合成.pdf', fileType: 'pdf', text: '', tables: [], images: [],
    extractedFields: {}, warnings: [], capabilityGaps: ['PDF parser missing'], pageCount: 0, capabilities: { pdfRender: false } })
  f.deps.pdfRenderer = { render: async () => ({ ok: true, extracted: { fileName: '合成.pdf', fileType: 'pdf', text: '',
    tables: [], images: [{ path: 'native-pages/page.png', description: '#第1页图片#1' }], extractedFields: {}, warnings: [],
    capabilityGaps: [], pageCount: 1, capabilities: { pdfRender: true } } }) }
  f.deps.visualReader = { read: async () => ({ ok: true, text: '合成公寓，建筑面积86.4平方米', readPages: [1],
    sessionIds: ['actual-page-child'], uncertainties: [] }) }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.materials[0].pageCount, 1)
})

test('an unreadable PDF surfaces the actual native child failure instead of a generic format instruction', async (t) => {
  const f = await fixture(t)
  f.scopes.get('project').snapshot.files.splice(1)
  f.extractor.extract = async () => ({ fileName: '合成.pdf', fileType: 'pdf', text: '', tables: [],
    images: [{ path: 'page.png' }], extractedFields: {}, warnings: [], capabilityGaps: [] })
  f.deps.visualReader = { read: async () => ({ ok: false, text: '', readPages: [], sessionIds: [], uncertainties: [],
    errorKind: 'missing', error: '没有可用的隔离子代理 provider：合成接口差异' }) }
  const { prepareWorkflowMaterials } = await load()
  const result = await prepareWorkflowMaterials(f.deps, f.exec, f.extractor)
  assert.equal(result.ok, false)
  assert.match(result.error, /隔离子代理 provider/)
})
