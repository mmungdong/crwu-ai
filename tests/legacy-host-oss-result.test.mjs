import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'


function shellResult(stdout = '', exitCode = 0) {
  return {
    exitCode,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
    timedOut: false,
  }
}

async function loadHost(options = {}) {
  const source = await readFile(new URL('../legacy/host.js', import.meta.url), 'utf8')
  const handlers = new Map()
  const commands = []
  const manifest = {
    schema: 'crwu.env-manifest.v1',
    binaries: [{ name: 'ossutil', command: 'ossutil', required: true }],
    services: [],
    ifindKey: { required: false, path: '/tmp/unused.json' },
    workspace: { preferTitle: '测试工作空间', preferPath: '/tmp/crwu-cases' },
    oss: {
      enabled: true,
      bucket: 'test-bucket',
      endpoint: 'oss-cn-test.aliyuncs.com',
      prefix: 'crwu/audit',
      ossutil: 'ossutil',
      linkMode: 'signed',
    },
  }
  const auditResult = {
    schemaVersion: '1.2',
    auditTask: {
      projectId: '2026-302584-LX10102-BG8734',
      auditTime: '2026-09-20T14:46:00+08:00',
      engineVersion: 'crwu-audit/1.6',
      reportVersion: '正式报告',
      profile: { stage: '二级复核' },
    },
    summary: {
      overallDecision: 'fail',
      counts: { issuesTotal: 18, high: 2, medium: 6, low: 10, pendingConfirmation: 3 },
      narrative: '测试摘要',
    },
    reviewComparison: {
      status: 'performed',
      metrics: { hitRate: 80, exactHits: 8, partialHits: 4, misses: 3 },
      bands: { overlap: 9, aiOnly: 6, reviewerOnly: 3, divergent: 0 },
      reviewFiles: [{ level: '二级审核', displayName: '二级审核意见.docx', version: '回复件' }],
    },
    fileTrace: { generatedAt: '2026-09-20T14:46:00+08:00', sourceDigest: 'source-digest' },
    issues: [{ title: '不应返回完整问题数组' }],
  }

  const services = {
    shell: {
      resolve(spec) { return spec },
      run(spec) {
        const command = String(spec.command)
        commands.push(command)
        if (command.includes('process.platform+')) return Promise.resolve(shellResult('darwin-arm64\n'))
        if (command.startsWith('curl ')) return Promise.resolve(shellResult(JSON.stringify(manifest)))
        if (command.includes('command -v ossutil')) return Promise.resolve(shellResult('/usr/bin/ossutil\n'))
        if (command.includes('ossutil cat')) return Promise.resolve(shellResult(JSON.stringify(auditResult)))
        if (command.includes('ossutil --version')) return Promise.resolve(shellResult('ossutil version 1.7.19\n'))
        if (command.includes('ossutil ls')) return Promise.resolve(shellResult(options.lsOutput || ''))
        if (command.includes('homedir')) return Promise.resolve(shellResult('/tmp/test-home\n'))
        if (command.includes('h3yun session status')) return Promise.resolve(shellResult('{}'))
        if (command.includes('dws auth status')) return Promise.resolve(shellResult('{"authenticated":true}'))
        return Promise.resolve(shellResult(''))
      },
    },
    fs: {
      resolve(value) { return Promise.resolve({ displayPath: String(value) }) },
      stat(value) {
        return Promise.resolve(String(value.displayPath || value) === '/tmp/crwu-cases'
          ? { type: 'directory' }
          : { type: 'missing' })
      },
      readText() { return Promise.resolve('{}') },
      writeText() { return Promise.resolve({ operation: 'updated' }) },
      contains() { return true },
    },
    workspaceRegistry: { list() { return [{ id: 'ws-1', title: '测试工作空间', path: '/tmp/crwu-cases' }] } },
    sessions: { get() { return undefined } },
    agents: { get() { return undefined } },
    subagents: { list() { return [] }, listChildren() { return Promise.resolve([]) } },
    timer: { interval() { return () => {} } },
  }
  const ctx = { get(name) { return services[name] }, on() { return () => {} } }
  const harness = { handle(name, handler) { handlers.set(name, handler) } }
  const plugin = new Function(
    'ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', source,
  )(
    ctx,
    harness,
    { log() {} },
    globalThis.btoa,
    globalThis.atob,
    globalThis.TextEncoder,
    globalThis.TextDecoder,
  )
  plugin.apply(ctx)
  await handlers.get('workbench:env')({ source: 'https://example.test/manifest.json' })
  commands.length = 0
  return { handlers, commands }
}

test('reads and normalizes exactly one audit result JSON object', async () => {
  const host = await loadHost()
  const readResult = host.handlers.get('workbench:oss-result')
  assert.equal(typeof readResult, 'function')

  const result = await readResult({
    key: 'crwu/audit/2026-302584-LX10102-BG8734/审核结果.2026-302584-LX10102-BG8734.json',
  })

  assert.equal(result.ok, true)
  assert.equal(result.info.projectId, '2026-302584-LX10102-BG8734')
  assert.equal(result.info.stage, '二级复核')
  assert.equal(result.info.summary.counts.high, 2)
  assert.equal(result.info.reviewComparison.reviewFiles[0].level, '二级审核')
  assert.equal('issues' in result.info, false, 'the UI endpoint must not return the full issue array')
  assert.equal(host.commands.filter((command) => command.includes('ossutil cat')).length, 1)
})

test('rejects result keys outside the configured audit prefix before reading OSS', async () => {
  const host = await loadHost()
  const readResult = host.handlers.get('workbench:oss-result')
  assert.equal(typeof readResult, 'function')

  const result = await readResult({ key: 'other/private/result.json' })

  assert.equal(result.ok, false)
  assert.match(result.error, /前缀/)
  assert.equal(host.commands.some((command) => command.includes('ossutil cat')), false)
})

test('rejects cloud links outside the configured audit prefix before signing OSS', async () => {
  const host = await loadHost()
  const openLink = host.handlers.get('workbench:oss-link')
  assert.equal(typeof openLink, 'function')

  const result = await openLink({ key: 'other/private/report.html' })

  assert.equal(result.ok, false)
  assert.match(result.error, /前缀/)
  assert.equal(host.commands.some((command) => command.includes('ossutil sign')), false)
})

test('OSS index selects only canonical audit artifact names', async () => {
  const seqNo = '2026-302584-LX10102-BG8734'
  const prefix = `oss://test-bucket/crwu/audit/${seqNo}/`
  const host = await loadHost({
    lsOutput: [
      `${prefix}审核意见.${seqNo}.html`,
      `${prefix}审核结果.${seqNo}.json`,
      `${prefix}辅助展示.html`,
      `${prefix}调试数据.json`,
    ].join('\n'),
  })

  const result = await host.handlers.get('workbench:oss-index')({})

  assert.equal(result.ok, true)
  assert.equal(result.items[seqNo].htmlKey, `crwu/audit/${seqNo}/审核意见.${seqNo}.html`)
  assert.equal(result.items[seqNo].jsonKey, `crwu/audit/${seqNo}/审核结果.${seqNo}.json`)
})
