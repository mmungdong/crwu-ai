/**
 * 第 1 层（命令 / 文件 / 平台）的单元测试。
 *
 * 这一层是后面 20+ 个 RPC 的地基，所以每条约束都要能被测出来：
 * 必须走注入的 `ctx.shell`、`escalate` 必须带工作区、`ctx.fs` 返回的是 FsTarget 对象
 * （不许字符串拼接）、平台探测以执行世界为准、`~` 展开按平台选分隔符。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { runShell, commandLine, commandLines } = await import(new URL('src/host/shell/run.ts', ROOT).href)
const { normalizePlatform, isWindowsPlatform } = await import(new URL('src/host/platform/detect.ts', ROOT).href)
const { expandLocal } = await import(new URL('src/host/platform/home.ts', ROOT).href)
const { createWorldFacts } = await import(new URL('src/host/platform/world.ts', ROOT).href)
const { sessionRoot, isFile, isDir, readTextIfExists, fileSystem } = await import(new URL('src/host/fs/paths.ts', ROOT).href)

/** 最小 ctx：`get` 只认给定的服务表。 */
function fakeContext(services = {}) {
  return { get: (name) => services[name] }
}

/** shell 服务替身：记录 resolve 收到的请求，并回放固定结果/异常。 */
function fakeShell({ result, throwOnRun, throwOnResolve } = {}) {
  const resolved = []
  return {
    resolved,
    service: {
      resolve(request) {
        if (throwOnResolve) throw new Error(throwOnResolve)
        resolved.push(request)
        return { ...request, workdir: request.workdir ?? '/default', timeoutMs: request.timeoutMs ?? 1, stdoutMaxBytes: request.stdoutMaxBytes ?? 1, sandboxPolicy: request.sandboxPolicy }
      },
      async execute() {
        if (throwOnRun) throw new Error(throwOnRun)
        return { result: async () => result }
      },
    },
  }
}

const OK_RESULT = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  timeoutMs: 1000,
  stdout: { text: 'hello\n', truncated: false },
  stderr: { text: '', truncated: false },
}

// ── runShell ────────────────────────────────────────────────────────────────

test('runShell reports success only for exit code zero', async () => {
  const shell = fakeShell({ result: OK_RESULT })
  const result = await runShell(fakeContext({ shell: shell.service }), 'crwu version')
  assert.deepEqual(result, {
    ok: true,
    error: '',
    exitCode: 0,
    stdout: 'hello\n',
    stderr: '',
    truncated: false,
    timedOut: false,
    aborted: false,
  })
})

test('runShell surfaces a non-zero exit code with stderr instead of throwing', async () => {
  const shell = fakeShell({
    result: { ...OK_RESULT, exitCode: 3, stderr: { text: 'ossutil: not found', truncated: false } },
  })
  const result = await runShell(fakeContext({ shell: shell.service }), 'ossutil ls')
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 3)
  assert.equal(result.stderr, 'ossutil: not found')
})

test('runShell reports a killed process as a null exit code', async () => {
  const shell = fakeShell({ result: { ...OK_RESULT, exitCode: null, timedOut: true } })
  const result = await runShell(fakeContext({ shell: shell.service }), 'crwu audit')
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, null)
  assert.equal(result.timedOut, true)
})

test('runShell marks truncated output so callers do not parse a partial list', async () => {
  const shell = fakeShell({ result: { ...OK_RESULT, stdout: { text: 'tail…', truncated: true } } })
  const result = await runShell(fakeContext({ shell: shell.service }), 'crwu records')
  assert.equal(result.truncated, true)
})

test('runShell fails loudly when the shell service is missing', async () => {
  const result = await runShell(fakeContext(), 'crwu version')
  assert.equal(result.ok, false)
  assert.match(result.error, /shell 服务不可用/)
})

test('runShell refuses escalation without a known workspace root', async () => {
  // 无沙箱执行必须绑定工作区，否则会落到服务器 cwd —— legacy 里这条是硬约束。
  const shell = fakeShell({ result: OK_RESULT })
  const result = await runShell(fakeContext({ shell: shell.service }), 'rm -rf x', { escalate: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /未知会话工作区/)
  assert.equal(shell.resolved.length, 0, '被拒绝时不得触碰 shell 服务')
})

test('runShell applies documented defaults and passes reads through', async () => {
  const shell = fakeShell({ result: OK_RESULT })
  await runShell(fakeContext({ shell: shell.service }), 'crwu pending', {})
  const [request] = shell.resolved
  assert.equal(request.command, 'crwu pending')
  assert.equal(request.timeoutMs, 60_000)
  assert.equal(request.stdoutMaxBytes, 65_536)
  assert.equal(request.stdin, undefined)
  assert.equal(request.sandboxPolicy, undefined)
})

test('runShell passes an explicit budget, stdin and escalation policy', async () => {
  const shell = fakeShell({ result: OK_RESULT })
  await runShell(fakeContext({ shell: shell.service }), 'crwu records', {
    workdir: '/cases/x',
    timeoutMs: 90_000,
    escalate: true,
    stdoutMaxBytes: 4 * 1024 * 1024,
    stdinText: 'piped',
  })
  const [request] = shell.resolved
  assert.equal(request.workdir, '/cases/x')
  assert.equal(request.timeoutMs, 90_000)
  assert.equal(request.stdoutMaxBytes, 4 * 1024 * 1024)
  assert.equal(request.stdin, 'piped')
  assert.deepEqual(request.sandboxPolicy, { mode: 'danger-full-access', workspaceRoot: '/cases/x' })
})

test('runShell turns a run-time throw into an error envelope', async () => {
  const shell = fakeShell({ throwOnRun: 'sandbox denied' })
  const result = await runShell(fakeContext({ shell: shell.service }), 'ossutil ls')
  assert.equal(result.ok, false)
  assert.match(result.error, /执行失败：sandbox denied/)
})

test('commandLine and commandLines only trust successful runs', async () => {
  const ok = fakeShell({ result: { ...OK_RESULT, stdout: { text: ' darwin-arm64 \nextra\n', truncated: false } } })
  assert.equal(await commandLine(fakeContext({ shell: ok.service }), 'uname -sm'), 'darwin-arm64')
  assert.deepEqual(await commandLines(fakeContext({ shell: ok.service }), 'list'), ['darwin-arm64', 'extra'])

  const bad = fakeShell({ result: { ...OK_RESULT, exitCode: 1 } })
  assert.equal(await commandLine(fakeContext({ shell: bad.service }), 'nope'), '')
  assert.deepEqual(await commandLines(fakeContext({ shell: bad.service }), 'nope'), [])
})

// ── 平台 ────────────────────────────────────────────────────────────────────

test('normalizePlatform maps the probe outputs we actually use', () => {
  assert.equal(normalizePlatform('darwin-arm64'), 'darwin-arm64')
  assert.equal(normalizePlatform('Darwin arm64'), 'darwin-arm64')
  assert.equal(normalizePlatform('mac-X86_64'), 'darwin-x64')
  assert.equal(normalizePlatform('macos-amd64'), 'darwin-x64')
  assert.equal(normalizePlatform('linux-aarch64'), 'linux-arm64')
  assert.equal(normalizePlatform('linux-x86_64'), 'linux-x64')
  assert.equal(normalizePlatform('win32-x64'), 'win32-x64')
  assert.equal(normalizePlatform('MINGW64_NT-10.0'), '', '认不出的 os 必须返回空串而不是猜')
  assert.equal(normalizePlatform('linux'), 'linux')
  assert.equal(normalizePlatform(''), '')
  assert.equal(normalizePlatform(null), '')
  // 多行输入只看第一行：探测命令可能带警告行。
  assert.equal(normalizePlatform('\nlinux-x64\n'), 'linux-x64')
})

test('isWindowsPlatform only matches win32', () => {
  assert.equal(isWindowsPlatform('win32-x64'), true)
  assert.equal(isWindowsPlatform('darwin-arm64'), false)
  assert.equal(isWindowsPlatform('linux-x64'), false)
})

test('expandLocal expands tilde with the platform separator', () => {
  assert.equal(expandLocal('~', '/Users/x', false), '/Users/x')
  assert.equal(expandLocal('~/bin/ossutil', '/Users/x', false), '/Users/x/bin/ossutil')
  assert.equal(expandLocal('~/bin/ossutil', 'C:\\Users\\x', true), 'C:\\Users\\x\\bin/ossutil')
  assert.equal(expandLocal('~\\bin\\ossutil', 'C:\\Users\\x', true), 'C:\\Users\\x\\bin\\ossutil')
  // 主目录未知时不猜：原样返回，让调用方报「配置路径不可解析」。
  assert.equal(expandLocal('~/bin', '', false), '~/bin')
  assert.equal(expandLocal('/abs/path', '/Users/x', false), '/abs/path')
})

test('world facts probe once and cache per plugin instance', async () => {
  let probes = 0
  const services = {
    shell: {
      resolve: (request) => {
        probes += 1
        return request
      },
      async execute() {
        return { result: async () => ({ ...OK_RESULT, stdout: { text: 'darwin-arm64\n', truncated: false } }) }
      },
    },
    fs: {
      async resolve() {
        return { targetKey: 'k', displayPath: '/cases/session' }
      },
      async stat() {
        return { type: 'directory' }
      },
    },
  }
  const world = createWorldFacts(fakeContext(services))
  // 平台探测的**次数**取决于 Host 事实：受支持平台上它是 `process.platform` + `arch`（不跑 shell），
  // 只有事实不在受支持集合里时才跑一次 `uname -sm`。这里钉的是「按实例缓存」这条不变量，
  // 所以不写死次数，只要求第二次调用不再增加探测。
  const first = await world.platform()
  const afterFirst = probes
  assert.ok(first !== '', '平台事实必须能算出来')
  assert.ok(probes <= 1, `最多探一次，实际 ${String(probes)} 次`)
  assert.equal(await world.platform(), first)
  assert.equal(probes, afterFirst, '第二次调用不得重探')
  assert.equal(await world.home(), (await import('node:os')).homedir())
  assert.equal(await world.workdir(), '/cases/session')
  assert.deepEqual(world.cached().platform, first)
})

// ── 文件与路径 ──────────────────────────────────────────────────────────────

test('sessionRoot reads displayPath from the FsTarget, never string-concatenates', async () => {
  const ctx = fakeContext({
    fs: {
      async resolve(path) {
        assert.equal(path, '.')
        return { targetKey: 'opaque', displayPath: '/cases/session' }
      },
    },
  })
  assert.equal(await sessionRoot(ctx), '/cases/session')
})

test('sessionRoot degrades to an empty string when fs is missing or throws', async () => {
  assert.equal(await sessionRoot(fakeContext()), '')
  assert.equal(await sessionRoot(fakeContext({
    fs: { async resolve() { throw new Error('no cwd') } },
  })), '')
})

test('isFile and isDir distinguish file from directory and swallow missing paths', async () => {
  const ctx = fakeContext({
    fs: {
      async resolve(path) { return { targetKey: path, displayPath: path } },
      async stat(target) {
        if (target.targetKey === '/cases/a') return { type: 'file' }
        if (target.targetKey === '/cases/b') return { type: 'directory' }
        return undefined
      },
    },
  })
  assert.equal(await isFile(ctx, '/cases/a'), true)
  assert.equal(await isDir(ctx, '/cases/a'), false)
  assert.equal(await isDir(ctx, '/cases/b'), true)
  assert.equal(await isFile(ctx, '/cases/missing'), false)
  assert.equal(await isFile(fakeContext(), '/cases/a'), false)
})

test('readTextIfExists returns the text, and an empty string for a missing file', async () => {
  const ctx = fakeContext({
    fs: {
      async resolve(path) { return { targetKey: path, displayPath: path } },
      async readText(target) {
        if (target.targetKey === '/manifest.json') return '{"ok":true}'
        throw new Error('ENOENT')
      },
    },
  })
  assert.equal(await readTextIfExists(ctx, '/manifest.json'), '{"ok":true}')
  assert.equal(await readTextIfExists(ctx, '/missing.json'), '')
  assert.equal(await readTextIfExists(fakeContext(), '/manifest.json'), '')
})

test('fileSystem exposes the optional service without requiring injection', () => {
  assert.equal(fileSystem(fakeContext()), undefined)
  const fs = { resolve: async () => ({}) }
  assert.equal(fileSystem(fakeContext({ fs })), fs)
})
