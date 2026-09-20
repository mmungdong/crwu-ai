import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'


function successfulShellResult(stdout = '') {
  return {
    exitCode: 0,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
    timedOut: false,
  }
}

async function loadHost() {
  const source = await readFile(new URL('../legacy/host.js', import.meta.url), 'utf8')
  const handlers = new Map()
  const pendingStarts = []
  let startCalls = 0

  const services = {
    agents: {
      get(id) { return id === 'parent-1' ? { id, status: 'running' } : undefined },
    },
    subagents: {
      list() { return ['spawn'] },
      listChildren() { return Promise.resolve([]) },
      start() {
        startCalls += 1
        return new Promise((resolve) => pendingStarts.push(() => resolve({
          id: `child-${startCalls}`,
          dispose() { return Promise.resolve() },
        })))
      },
    },
    sessions: {
      get(id) {
        if (id !== 'parent-1') return undefined
        return { header: { cwd: '/tmp/crwu-cases', delegationDepth: 0 } }
      },
    },
    workspaceRegistry: { list() { return [] } },
    timer: { interval() { return () => {} } },
    shell: {
      resolve(spec) { return spec },
      run(spec) {
        if (String(spec.command).includes('homedir')) return Promise.resolve(successfulShellResult('/tmp/test-home\n'))
        return Promise.resolve(successfulShellResult())
      },
    },
    fs: {
      resolve(path) { return Promise.resolve({ displayPath: String(path) }) },
      stat() { return Promise.resolve({ type: 'missing' }) },
      readText() { return Promise.resolve('{}') },
      writeText() { return Promise.resolve({ operation: 'updated' }) },
      contains() { return true },
    },
  }
  const ctx = {
    get(name) { return services[name] },
    on() { return () => {} },
  }
  const harness = {
    handle(name, handler) { handlers.set(name, handler) },
  }
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

  await handlers.get('workbench:workspace')({ path: '/tmp/crwu-cases', id: 'ws-1', title: '测试工作空间' })
  await handlers.get('workbench:bind-session')({ sessionId: 'parent-1' })

  return {
    handlers,
    get startCalls() { return startCalls },
    completeNextStart() {
      const complete = pendingStarts.shift()
      assert.ok(complete, 'expected one pending subagent start')
      complete()
    },
  }
}

test('concurrent start requests create only one audit subagent', async () => {
  const host = await loadHost()
  const start = host.handlers.get('workbench:audit-start')
  const args = {
    key: '2026-302584-LX10102-BG8734',
    seqNo: '2026-302584-LX10102-BG8734',
    project: '测试项目',
    objectId: 'obj-1',
  }

  const first = start(args)
  await new Promise((resolve) => setImmediate(resolve))
  const second = start(args)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(host.startCalls, 1, 'second request must be rejected before subagents.start')
  const secondResult = await second
  assert.equal(secondResult.ok, false)
  assert.match(secondResult.error, /正在创建/)

  host.completeNextStart()
  const firstResult = await first
  assert.equal(firstResult.ok, true)
})
