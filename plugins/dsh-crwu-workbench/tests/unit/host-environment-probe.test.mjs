/**
 * 第 1 层（二进制 / OSS / iFinD 探测）的单元测试。
 *
 * 这一层决定环境自检页显示什么，所以每条「看起来通过但实际不可用」的路径都要反向验：
 * 找不到 ≠ 读不出版本、AK 各类错误的分类、iFinD 密钥的三种失败、Windows 的引号方式。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { DEFAULT_MANIFEST } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)
const { normalizeManifest } = await import(new URL('src/host/environment/manifest.ts', ROOT).href)
const { shellQuote, checkIfindToken, probeEnv, probeOss, resolveOssutil, ossutilMissingMessage, probeIfindKey, serviceChecks } = await import(
  new URL('src/host/environment/probe.ts', ROOT).href
)

/**
 * 按命令内容回放的 shell 替身。
 *
 * handler 返回 `{ runs: false, error }` 时 `run` **抛错** —— 这是 DSH 契约里「命令根本没执行」
 * 的唯一形状（`ShellExecutor.run` 只为基础设施故障 reject：沙箱后端不可用、shell 服务缺失、
 * 审批拒绝）。真实事故就是 macOS 上 `sandbox-exec: sandbox_apply: Operation not permitted`。
 */
function shellStub(handler) {
  const calls = []
  return {
    calls,
    ctx: {
      get: (name) => (name === 'shell'
        ? {
            resolve: (request) => request,
            async run(spec) {
              calls.push(spec.command)
              const result = handler(spec.command)
              if (result.runs === false) throw new Error(result.error)
              return {
                exitCode: result.exitCode ?? 0,
                signal: null,
                timedOut: false,
                aborted: false,
                timeoutMs: 1000,
                stdout: { text: result.stdout ?? '', truncated: false },
                stderr: { text: result.stderr ?? '', truncated: false },
              }
            },
          }
        : undefined),
    },
  }
}

/** 沙箱后端不可用时 DSH 抛出的那条原文（真实环境逐字抄回）。 */
const SANDBOX_DOWN = 'sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined.'

/**
 * fs 替身：`files` 给内容，`infos` 给 stat 结果。
 *
 * 两者必须分开 —— `stat` 返回的是 `{ type }`，把它和文件内容混在一张表里会让
 * `probeIfindKey` 的「不是文件」判断永远命中，测试就会假绿。
 */
function fsStub(files = {}, options = {}) {
  const infos = options.infos ?? Object.fromEntries(Object.keys(files).map((path) => [path, { type: 'file' }]))
  return {
    get: (name) => (name === 'fs'
      ? {
          async resolve(path) {
            return { targetKey: path, displayPath: path }
          },
          async stat(target) {
            if (options.throwOnStat) throw new Error('ENOENT')
            return infos[target.targetKey]
          },
          async readText(target) {
            if (options.throwOnRead) throw new Error('EACCES')
            return files[target.targetKey]
          },
        }
      : undefined),
  }
}

/** 合并多个替身的 ctx。 */
function ctxOf(...contexts) {
  return { get: (name) => contexts.map((ctx) => ctx.get(name)).find((value) => value !== undefined) }
}

// ── 引号 ────────────────────────────────────────────────────────────────────

test('shellQuote uses POSIX quoting on POSIX and double quotes on Windows', () => {
  assert.equal(shellQuote('/usr/local/bin/ossutil', 'darwin-arm64'), '/usr/local/bin/ossutil')
  assert.equal(shellQuote('/opt/my tools/ossutil', 'linux-x64'), "'/opt/my tools/ossutil'")
  // cmd.exe 不认单引号：Windows 上必须换双引号并把内部引号翻倍。
  assert.equal(shellQuote('C:\\Program Files\\ossutil.exe', 'win32-x64'), '"C:\\Program Files\\ossutil.exe"')
  assert.equal(shellQuote('a"b', 'win32-x64'), '"a""b"')
})

// ── iFinD 密钥 ──────────────────────────────────────────────────────────────

test('checkIfindToken distinguishes empty, placeholder and untrimmed values', () => {
  assert.equal(checkIfindToken('', 'your ifind-mcp key').reason, 'auth_token 为空')
  assert.equal(checkIfindToken('   ', 'your ifind-mcp key').reason, 'auth_token 为空')
  assert.match(checkIfindToken('your ifind-mcp key', 'your ifind-mcp key').reason, /仍是占位符/)
  assert.match(checkIfindToken('YOUR IFIND-MCP KEY', 'your ifind-mcp key').reason, /仍是占位符/)
  assert.match(checkIfindToken(' abc ', 'ph').reason, /首尾空白/)
  assert.equal(checkIfindToken('  abc  '.trim(), 'ph').ok, true)
})

test('checkIfindToken reports the length but never the token itself', () => {
  const verdict = checkIfindToken('s3cret-token', 'ph')
  assert.deepEqual(verdict, { ok: true, reason: '', tokenLength: 12 })
  assert.equal(JSON.stringify(verdict).includes('s3cret'), false, '结果里绝不能带出密钥内容')
})

// ── 二进制探测 ──────────────────────────────────────────────────────────────

test('probeEnv resolves every command path in one shell call and checks versions', async () => {
  const shell = shellStub((command) => {
    if (command.startsWith('for b in ')) {
      return { stdout: 'node\t/usr/local/bin/node\ncrwu\t/Users/x/bin/crwu\ndws\t\npython3\t/usr/bin/python3\nossutil\t\n' }
    }
    if (command.includes('node')) return { stdout: 'v22.19.0\n' }
    if (command.includes('crwu')) return { stdout: 'crwu version 1.4.0\n' }
    if (command.includes('python3')) return { stdout: 'Python 3.11.6\n' }
    return { stdout: '' }
  })
  const checks = await probeEnv(shell.ctx, DEFAULT_MANIFEST, 'darwin-arm64', { home: '/Users/x' })

  assert.deepEqual(checks.map((check) => check.name), ['node', 'crwu', 'dws', 'python3', 'ossutil'])
  const byName = Object.fromEntries(checks.map((check) => [check.name, check]))

  assert.equal(byName.node.ok, true)
  assert.equal(byName.node.path, '/usr/local/bin/node')
  assert.deepEqual(byName.crwu.actual, '1.4.0')
  assert.equal(byName.python3.ok, true)

  // PATH 里没有 → 未安装（而不是「版本读不出来」）。
  assert.equal(byName.dws.found, false)
  assert.equal(byName.dws.reason, '未安装')
  // 一次 shell 调用解决所有 command -v。
  assert.equal(shell.calls.filter((command) => command.startsWith('for b in ')).length, 1)
})

test('probeEnv fails a found binary whose version cannot be read', async () => {
  // 「装了但读不出版本」必须失败：这是环境自检最容易骗过人的一条。
  const shell = shellStub((command) => {
    if (command.startsWith('for b in ')) return { stdout: 'node\t/usr/bin/node\n' }
    return { exitCode: 1, stderr: 'node: bad option\n' }
  })
  const checks = await probeEnv(shell.ctx, DEFAULT_MANIFEST, 'linux-x64')
  const node = checks.find((check) => check.name === 'node')
  assert.equal(node.found, true)
  assert.equal(node.ok, false)
  assert.match(node.reason, /无法从命令输出解析出版本号/)
})

test('probeEnv falls back to the declared install target when the command is not on PATH', async () => {
  const shell = shellStub((command) => {
    if (command.startsWith('for b in ')) return { stdout: '' }
    return { stdout: 'Version: 1.7.19\n' }
  })
  const fs = fsStub({}, { infos: { '/Users/x/bin/ossutil': { type: 'file' } } })
  const checks = await probeEnv(ctxOf(shell.ctx, fs), DEFAULT_MANIFEST, 'darwin-arm64', { home: '/Users/x' })
  const ossutil = checks.find((check) => check.name === 'ossutil')
  assert.equal(ossutil.found, true)
  assert.equal(ossutil.path, '/Users/x/bin/ossutil')
  assert.equal(ossutil.ok, true)
  assert.equal(ossutil.actual, '1.7.19')
})

test('probeEnv reports a missing optional binary without failing the whole probe', async () => {
  const shell = shellStub((command) => (command.startsWith('for b in ') ? { stdout: '' } : { stdout: '' }))
  const manifest = normalizeManifest({
    binaries: [{ name: 'extra', command: 'extra', required: false }],
  })
  const checks = await probeEnv(shell.ctx, manifest, 'linux-x64')
  assert.equal(checks.length, 1)
  assert.equal(checks[0].required, false)
  assert.equal(checks[0].ok, false)
  assert.equal(checks[0].reason, '未安装')
})

test('probeEnv only probes commands that are safe identifiers', async () => {
  const shell = shellStub(() => ({ stdout: '' }))
  const manifest = normalizeManifest({
    binaries: [
      { name: 'ok', command: 'ok' },
      { name: 'inject', command: 'ok; rm -rf /' },
    ],
  })
  await probeEnv(shell.ctx, manifest, 'linux-x64')
  const lookup = shell.calls.find((command) => command.startsWith('for b in ')) ?? ''
  assert.match(lookup, /for b in ok;/)
  assert.equal(lookup.includes('rm -rf'), false, '带 shell 元字符的 command 不得进入探测脚本')
})

// ── ossutil 解析与 OSS 探测 ─────────────────────────────────────────────────

test('resolveOssutil prefers PATH and falls back to the manifest target', async () => {
  const onPath = shellStub(() => ({ stdout: '/usr/local/bin/ossutil\n' }))
  assert.deepEqual(
    await resolveOssutil(onPath.ctx, DEFAULT_MANIFEST.oss, 'darwin-arm64', { manifest: DEFAULT_MANIFEST }),
    { path: '/usr/local/bin/ossutil', error: '' },
  )

  const notOnPath = shellStub(() => ({ stdout: '' }))
  const fs = fsStub({}, { infos: { '/Users/x/bin/ossutil': { type: 'file' } } })
  assert.deepEqual(
    await resolveOssutil(ctxOf(notOnPath.ctx, fs), DEFAULT_MANIFEST.oss, 'darwin-arm64', {
      manifest: DEFAULT_MANIFEST,
      home: '/Users/x',
    }),
    { path: '/Users/x/bin/ossutil', error: '' },
  )

  // 两边都没有、而且探测真的执行过 → 空路径且没有错误（界面显示「ossutil 未安装」）。
  assert.deepEqual(
    await resolveOssutil(ctxOf(notOnPath.ctx, fsStub({})), DEFAULT_MANIFEST.oss, 'darwin-arm64', { manifest: DEFAULT_MANIFEST, home: '/Users/x' }),
    { path: '', error: '' },
  )
})

test('resolveOssutil reports a probe that could not run instead of claiming ossutil is missing', async () => {
  // 真实事故：沙箱后端不可用 → `command -v ossutil` 根本没执行 → 旧实现返回空串，
  // 界面于是说「未找到 ossutil，请先安装」，把人送去装一个已经装好的东西。
  const down = shellStub(() => ({ runs: false, error: SANDBOX_DOWN }))
  const lookup = await resolveOssutil(down.ctx, DEFAULT_MANIFEST.oss, 'darwin-arm64', { manifest: DEFAULT_MANIFEST })
  assert.equal(lookup.path, '')
  assert.match(lookup.error, /no sandbox backend is usable/)
  assert.match(ossutilMissingMessage(lookup), /无法定位 ossutil/)
  assert.equal(ossutilMissingMessage({ path: '', error: '' }), '未找到 ossutil，请先安装')
})

test('probeEnv does not report 「未安装」 when the PATH probe itself could not run', async () => {
  // 同一台机器上 node / python3 都装着；命令跑不起来时只能说「无法探测」。
  // 旧实现会报 5 条「未安装」，用户会去装已经装好的东西。
  const down = shellStub(() => ({ runs: false, error: SANDBOX_DOWN }))
  const checks = await probeEnv(down.ctx, DEFAULT_MANIFEST, 'darwin-arm64')
  assert.equal(checks.length > 0, true)
  for (const check of checks) {
    assert.equal(check.ok, false)
    assert.match(check.reason, /^无法探测：/)
    assert.notEqual(check.reason, '未安装')
  }
})

test('probeEnv still trusts the manifest target when only PATH lookup failed', async () => {
  // 路径探测跑不起来，但清单里的安装目标能由 fs 证实 —— 那一条仍然要报「已安装」。
  const down = shellStub((command) => (command.startsWith('for b in ')
    ? { runs: false, error: SANDBOX_DOWN }
    : { stdout: 'Version: 1.7.19\n' }))
  const fs = fsStub({}, { infos: { '/Users/x/bin/ossutil': { type: 'file' } } })
  const checks = await probeEnv(ctxOf(down.ctx, fs), DEFAULT_MANIFEST, 'darwin-arm64', { home: '/Users/x' })
  const ossutil = checks.find((check) => check.name === 'ossutil')
  assert.equal(ossutil.found, true)
  assert.equal(ossutil.path, '/Users/x/bin/ossutil')
  assert.equal(ossutil.ok, true)
  const node = checks.find((check) => check.name === 'node')
  assert.match(node.reason, /^无法探测：/)
})

test('probeEnv separates 「版本命令没执行」 from 「版本读不出来」', async () => {
  // 两种情况都是「装了但判定不了」，但原因必须能分辨：一个是环境问题，一个是命令行为问题。
  const shell = shellStub((command) => (command.startsWith('for b in ')
    ? { stdout: 'node\t/usr/bin/node\n' }
    : { runs: false, error: SANDBOX_DOWN }))
  const checks = await probeEnv(shell.ctx, DEFAULT_MANIFEST, 'linux-x64')
  const node = checks.find((check) => check.name === 'node')
  assert.equal(node.found, true)
  assert.equal(node.ok, false)
  assert.match(node.reason, /^无法执行版本命令：/)
  assert.doesNotMatch(node.reason, /无法从命令输出解析出版本号/)
})

test('probeOss refuses to probe without enabled/bucket/ossutil', async () => {
  const idle = shellStub(() => ({ stdout: '' }))
  const disabled = await probeOss(idle.ctx, { ...DEFAULT_MANIFEST.oss, enabled: false }, 'darwin-arm64')
  assert.equal(disabled.state, '未启用')

  const noBucket = await probeOss(idle.ctx, { ...DEFAULT_MANIFEST.oss, bucket: '' }, 'darwin-arm64')
  assert.equal(noBucket.state, '缺 bucket')

  const noOssutil = await probeOss(idle.ctx, { ...DEFAULT_MANIFEST.oss, bucket: 'b' }, 'darwin-arm64', { manifest: DEFAULT_MANIFEST })
  assert.equal(noOssutil.state, 'ossutil 未安装')
  assert.equal(noOssutil.ok, false)

  // 探测没跑起来时，状态不能是「未安装」。
  const down = shellStub(() => ({ runs: false, error: SANDBOX_DOWN }))
  const unreachable = await probeOss(down.ctx, { ...DEFAULT_MANIFEST.oss, bucket: 'b' }, 'darwin-arm64', { manifest: DEFAULT_MANIFEST })
  assert.equal(unreachable.state, '无法探测')
  assert.match(unreachable.detail, /no sandbox backend is usable/)
})

test('probeOss classifies the AK failures the CLI actually reports', async () => {
  const cases = [
    ['AccessDenied: no permission', 'AK 无权限'],
    ['InvalidAccessKeyId', 'AK 无效'],
    ['SignatureDoesNotMatch', 'AK 无效'],
    ['NoSuchBucket', 'bucket 不存在'],
    ['AK and SK are both empty', 'AK 未配置'],
    ['something else entirely', 'AK 配置有误或不可用'],
  ]
  for (const [stderr, expected] of cases) {
    const shell = shellStub((command) => {
      if (command.startsWith('command -v')) return { stdout: '/usr/local/bin/ossutil\n' }
      return { exitCode: 1, stderr }
    })
    const check = await probeOss(shell.ctx, { ...DEFAULT_MANIFEST.oss, bucket: 'b', enabled: true }, 'darwin-arm64', {
      manifest: DEFAULT_MANIFEST,
    })
    assert.equal(check.state, expected, `${stderr} 应判为 ${expected}`)
    assert.equal(check.ok, false)
    assert.ok(check.detail.length > 0)
  }
})

test('probeOss passes when the AK can list the bucket, and never echoes credentials', async () => {
  const shell = shellStub((command) => {
    if (command.startsWith('command -v')) return { stdout: '/usr/local/bin/ossutil\n' }
    return { stdout: 'oss://b/obj\n' }
  })
  const check = await probeOss(shell.ctx, { ...DEFAULT_MANIFEST.oss, bucket: 'b', enabled: true }, 'darwin-arm64', {
    manifest: DEFAULT_MANIFEST,
  })
  assert.equal(check.ok, true)
  assert.equal(check.state, 'AK 正常')
  const listing = shell.calls.find((command) => command.includes(' ls ')) ?? ''
  assert.match(listing, /--limited-num 1/, '探测只看一个对象，不拉整个 bucket')
})

test('probeOss honours a manifest-provided probe command template', async () => {
  const shell = shellStub((command) => {
    if (command.startsWith('command -v')) return { stdout: '/opt/ossutil\n' }
    return { stdout: 'ok\n' }
  })
  const oss = { ...DEFAULT_MANIFEST.oss, bucket: 'bkt', endpoint: 'oss-cn-x.aliyuncs.com', enabled: true, probeCommand: '{ossutil} ls oss://{bucket}/ --endpoint {endpoint}' }
  const check = await probeOss(shell.ctx, oss, 'darwin-arm64', { manifest: DEFAULT_MANIFEST })
  assert.equal(check.ok, true)
  const call = shell.calls.find((command) => command.includes('--endpoint')) ?? ''
  assert.match(call, /oss:\/\/bkt\//)
  assert.match(call, /oss-cn-x\.aliyuncs\.com/)
})

// ── iFinD 配置 ──────────────────────────────────────────────────────────────

test('probeIfindKey reads the configured field and reports only the length', async () => {
  const fs = fsStub({ '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{"auth_token":"abcdef"}' })
  const check = await probeIfindKey(fs, DEFAULT_MANIFEST, { home: '/Users/x', platform: 'darwin-arm64' })
  assert.equal(check.ok, true)
  assert.equal(check.tokenLength, 6)
  assert.equal(check.path, '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json')
  assert.equal(JSON.stringify(check).includes('abcdef'), false)
})

test('probeIfindKey explains missing file, bad JSON and missing fs', async () => {
  const missing = await probeIfindKey(fsStub({}), DEFAULT_MANIFEST, { home: '/Users/x', platform: 'darwin-arm64' })
  assert.match(missing.reason, /配置文件不存在/)

  const badJson = await probeIfindKey(
    fsStub({ '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{oops' }),
    DEFAULT_MANIFEST,
    { home: '/Users/x', platform: 'darwin-arm64' },
  )
  assert.match(badJson.reason, /不是合法 JSON/)

  const noFs = await probeIfindKey({ get: () => undefined }, DEFAULT_MANIFEST, { home: '/Users/x' })
  assert.match(noFs.reason, /文件服务不可用/)
})

test('serviceChecks normalizes the manifest service list without inventing status', () => {
  const checks = serviceChecks(DEFAULT_MANIFEST.services)
  assert.deepEqual(checks.map((check) => check.id), ['h3yun', 'dingtalk', 'oss'])
  for (const check of checks) {
    assert.equal(check.ok, false, '未探测前不得假装通过')
    assert.equal(check.state, '待探测')
  }
})
