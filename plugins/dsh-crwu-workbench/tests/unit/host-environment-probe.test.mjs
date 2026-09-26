/**
 * 环境探测的单元测试：**插件内置组件**、OSS、iFinD。
 *
 * 这一层决定环境自检页显示什么，所以每条「看起来通过但实际不可用」的路径都要反向验。
 * 2026-09-25 的改造把旧的四类混装 `checks[]`（packaged / system runtime / PATH 命令 / 服务）
 * 拆开，这一份测试随之只盯三件事：
 *
 * 1. **插件内置组件只按包内文件核对**：只 stat `bin/<平台>/<文件>` 并比对包内
 *    `bin/manifest.json` 的**字节数**（sha256 从清单读出来放进维护者详情，**不**每次自检重算 ——
 *    三个二进制加起来一百多 MB，哈希是发布门禁的事）；
 * 2. 组件不由 PATH 解析、不跑版本命令、不回退同名命令，缺失时的文案必须说
 *    「插件包不完整 / 平台不受支持」而**不是**让人去安装；
 * 3. ossutil 同理只认包内 —— 它同样没有 PATH 回退。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { DEFAULT_MANIFEST } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)
const { manifestFixture } = await import(new URL('tests/helpers/manifest-fixture.mjs', ROOT).href)
const {
  shellQuote, checkIfindToken, probePackageIntegrity, packageIntegrityPaths,
  probeOss, resolveOssutil, ossutilMissingMessage, probeIfindKey, serviceChecks,
} = await import(new URL('src/host/environment/probe.ts', ROOT).href)
const { bundledBinaryPath } = await import(new URL('src/host/platform/bin-dir.ts', ROOT).href)

/**
 * 按命令内容回放的 shell 替身。
 *
 * handler 返回 `{ runs: false, error }` 时 `execute` **抛错** —— 这是 DSH 契约里「命令根本没执行」
 * 的唯一形状（`ShellExecutor.execute` 与句柄的 `result()` 只为基础设施故障 reject：沙箱后端不可用、
 * shell 服务缺失、审批拒绝）。真实事故就是 macOS 上 `sandbox-exec: sandbox_apply: Operation not permitted`。
 */
function shellStub(handler = () => ({ stdout: '' })) {
  const calls = []
  return {
    calls,
    ctx: {
      get: (name) => (name === 'shell'
        ? {
            resolve: (request) => request,
            async execute(spec) {
              calls.push(spec.command)
              const result = handler(spec.command)
              if (result.runs === false) throw new Error(result.error)
              return { result: async () => ({
                exitCode: result.exitCode ?? 0,
                signal: null,
                timedOut: false,
                aborted: false,
                timeoutMs: 1000,
                stdout: { text: result.stdout ?? '', truncated: false },
                stderr: { text: result.stderr ?? '', truncated: false },
              }) }
            },
          }
        : undefined),
    },
  }
}

/** fs 替身：`infos` 给 stat 结果，`files` 给 readText 内容。两者分开，混在一张表里会假绿。 */
function fsStub({ infos = {}, files = {} } = {}) {
  return {
    get: (name) => (name === 'fs'
      ? {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) { return infos[target.targetKey] },
          async readText(target) { return files[target.targetKey] },
        }
      : undefined),
  }
}

/** 合并多个替身的 ctx。 */
const ctxOf = (...contexts) => ({ get: (name) => contexts.map((ctx) => ctx.get(name)).find((value) => value !== undefined) })

/** 沙箱后端不可用时 DSH 抛出的那条原文（真实环境逐字抄回）。 */
const SANDBOX_DOWN = 'sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined.'

const PATHS = packageIntegrityPaths()
const BUNDLED = (name, platform = 'darwin-arm64') => bundledBinaryPath(platform, name)

/** 一个组件的字节数：每个名字给一个不同的值，便于发现「拿错了哪一项」。 */
const sizeOf = (name) => 1000 + name.length

/**
 * 造一份「装配完整」的包内布局：三个组件文件都在，`bin/manifest.json` 记着它们的字节数。
 *
 * `fileSize` 只改**磁盘上那份文件**的大小（模拟运行残留 / 安装不完整），清单里仍然记标准值 ——
 * 两者分开才能验「按清单比对字节数」这条判据。
 * 注意：**与工作树里是否真的装配过 `bin/` 无关** —— 判据是替身里的文件，CI 上没装配也照样跑。
 */
function packagedFs({ platform = 'darwin-arm64', present = ['crwu', 'dws', 'ossutil'], fileSize = {}, manifestTools = ['crwu', 'dws', 'ossutil'], withManifest = true } = {}) {
  const infos = {}
  for (const name of present) infos[BUNDLED(name, platform)] = { type: 'file', size: fileSize[name] ?? sizeOf(name) }
  const tools = manifestTools.map((name) => ({ tool: name, file: name, platform, size: sizeOf(name), sha256: `sha-${name}`, sourceVersion: '1.2.3' }))
  const files = withManifest
    ? { [PATHS.manifestPath]: JSON.stringify({ schemaVersion: 'crwu.plugin-bin-manifest.v1', platforms: [{ platform, tools }] }) }
    : {}
  return fsStub({ infos, files })
}

// ── 引号 ────────────────────────────────────────────────────────────────────

test('shellQuote uses POSIX quoting on POSIX and double quotes on Windows', () => {
  assert.equal(shellQuote('/usr/local/bin/ossutil', 'darwin-arm64'), '/usr/local/bin/ossutil')
  assert.equal(shellQuote('/opt/my tools/ossutil', 'linux-x64'), "'/opt/my tools/ossutil'")
  // cmd.exe 不认单引号：Windows 上必须换双引号并把内部引号翻倍。
  assert.equal(shellQuote('C:\\Program Files\\ossutil.exe', 'win32-x64'), '"C:\\Program Files\\ossutil.exe"')
  assert.equal(shellQuote('a"b', 'win32-x64'), '"a""b"')
})

// ── 插件内置组件 ────────────────────────────────────────────────────────────

test('内置组件只按包内文件核对：一次 shell 都不跑，不查 PATH、不问版本', async () => {
  // 连 shell 服务都不给：只要实现里还残留任何 PATH 探测或版本命令，这里立刻炸。
  const ctx = packagedFs({})
  const result = await probePackageIntegrity(ctx, DEFAULT_MANIFEST, 'darwin-arm64')

  assert.equal(result.ok, true)
  assert.equal(result.supported, true)
  assert.equal(result.platform, 'darwin-arm64')
  assert.equal(result.packageRoot, PATHS.packageRoot)
  assert.equal(result.manifestPath, PATHS.manifestPath)
  assert.equal(result.manifestFound, true)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['crwu', 'dws', 'ossutil'])
  for (const tool of result.tools) {
    assert.equal(tool.ok, true, `${tool.name} 应当完整`)
    assert.equal(tool.present, true)
    assert.equal(tool.file, tool.name, 'POSIX 平台的文件名就是工具名')
    assert.equal(tool.sizeBytes, sizeOf(tool.name))
    assert.equal(tool.manifestSizeBytes, sizeOf(tool.name))
    // sha256 来自包内清单（发布门禁算过的），不是自检现场重算的 —— 一百多 MB 不能每次自检都哈希。
    assert.equal(tool.sha256, `sha-${tool.name}`)
    assert.equal(tool.reason, '')
  }
  // 版本要求来自清单常量（dws 有，其余为空），**不执行二进制去问**。
  assert.equal(result.tools.find((tool) => tool.name === 'dws').expectedVersion, '>=0.2.14')
  assert.equal(result.tools.find((tool) => tool.name === 'crwu').expectedVersion, '')
})

test('PATH 上有同名命令也不算数：缺包内文件就是「插件包不完整」，且不提安装', async () => {
  // PATH 探测替身**故意**为每个名字都回一个路径：只有实现还去看 PATH，才会被判成通过。
  const shell = shellStub((command) => (command.includes('crwu') || command.includes('dws') || command.includes('ossutil')
    ? { stdout: '/usr/local/bin/crwu\n' }
    : { stdout: '' }))
  const ctx = ctxOf(packagedFs({ present: ['crwu'] }), shell.ctx)
  const result = await probePackageIntegrity(ctx, DEFAULT_MANIFEST, 'darwin-arm64')

  assert.equal(result.ok, false, '缺两个组件就不能说完整')
  for (const name of ['dws', 'ossutil']) {
    const tool = result.tools.find((entry) => entry.name === name)
    assert.equal(tool.present, false, `${name} 不在包里，PATH 上有也不算`)
    assert.match(tool.reason, /插件包不完整/)
    assert.doesNotMatch(tool.reason, /请安装|下载|PATH 上安装|npm i/)
  }
  // 一次 shell 都不该发（PATH 与版本命令都不再是判据），更不该出现 dws 的任何命令。
  assert.deepEqual(shell.calls, [], `不该跑任何命令，实际：${shell.calls.join(' / ')}`)
})

test('平台不受支持时说「平台不受支持」，而不是提示用户安装命令', async () => {
  const ctx = fsStub({})
  const result = await probePackageIntegrity(ctx, DEFAULT_MANIFEST, 'linux-x64')
  assert.equal(result.supported, false)
  assert.equal(result.ok, false)
  for (const tool of result.tools) {
    assert.equal(tool.present, false)
    assert.match(tool.reason, /平台不受支持/)
    assert.doesNotMatch(tool.reason, /请安装|下载/)
  }
})

test('字节数与包内清单不一致 = 不完整（哈希仍取自清单，不在自检里重算）', async () => {
  // 磁盘上是 1007 字节、清单里记的是标准值：模拟「运行残留 / 安装不完整」。
  const result = await probePackageIntegrity(packagedFs({ fileSize: { dws: sizeOf('dws') + 7 } }), DEFAULT_MANIFEST, 'darwin-arm64')
  const dws = result.tools.find((tool) => tool.name === 'dws')
  assert.equal(dws.ok, false)
  assert.equal(dws.present, true)
  assert.equal(dws.sizeBytes, sizeOf('dws') + 7)
  assert.equal(dws.manifestSizeBytes, sizeOf('dws'))
  assert.equal(dws.sha256, 'sha-dws', 'sha256 只从清单读出来')
  assert.match(dws.reason, /字节数/)
  assert.equal(result.ok, false)
})

test('包内清单缺失时如实说不完整，而不是假装通过', async () => {
  const ctx = packagedFs({ withManifest: false })
  const result = await probePackageIntegrity(ctx, DEFAULT_MANIFEST, 'darwin-arm64')
  assert.equal(result.manifestFound, false)
  assert.equal(result.ok, false)
  for (const tool of result.tools) {
    assert.equal(tool.present, true, '文件在不在是独立事实，不因为清单缺失就变成「没有」')
    assert.equal(tool.ok, false)
    assert.equal(tool.sha256, '')
    assert.match(tool.reason, /插件包不完整/)
  }
  assert.match(result.tools[0].reason, /插件包不完整/)
})

test('Host 文件服务不可用时说「无法核对」，不谎报「插件包不完整」', async () => {
  const result = await probePackageIntegrity({ get: () => undefined }, DEFAULT_MANIFEST, 'darwin-arm64')
  assert.equal(result.ok, false)
  assert.equal(result.tools[0].present, false)
  assert.match(result.tools[0].reason, /无法核对/)
})

test('坏掉的包内清单按「读不到」处理，不崩', async () => {
  const ctx = fsStub({ infos: { [BUNDLED('crwu')]: { type: 'file', size: sizeOf('crwu') } }, files: { [PATHS.manifestPath]: '{oops' } })
  const result = await probePackageIntegrity(ctx, DEFAULT_MANIFEST, 'darwin-arm64')
  assert.equal(result.manifestFound, false)
  assert.equal(result.ok, false)
})

test('组件清单为空（清单里没有任何内置组件）时不算故障', async () => {
  const manifest = manifestFixture({ packaged: [] })
  const ctx = fsStub({ files: { [PATHS.manifestPath]: JSON.stringify({ platforms: [] }) } })
  const result = await probePackageIntegrity(ctx, manifest, 'darwin-arm64')
  assert.deepEqual(result.tools, [])
  assert.equal(result.ok, true, '清单没声明组件就没有可缺的项')
})

// ── ossutil：只认包内 ───────────────────────────────────────────────────────

test('resolveOssutil 只认包内；PATH 上有同名命令也不回退', async () => {
  const bundled = BUNDLED('ossutil')
  const present = ctxOf(fsStub({ infos: { [bundled]: { type: 'file' } } }), shellStub(() => ({ stdout: '/usr/local/bin/ossutil\n' })).ctx)
  const found = await resolveOssutil(present, DEFAULT_MANIFEST.oss, 'darwin-arm64')
  assert.deepEqual(found, { path: bundled, error: '' })

  // 包内没有：即使 PATH 探测替身回着路径，也必须报「插件包不完整」。
  const shell = shellStub(() => ({ stdout: '/usr/local/bin/ossutil\n' }))
  const missing = await resolveOssutil(ctxOf(fsStub({}), shell.ctx), DEFAULT_MANIFEST.oss, 'darwin-arm64')
  assert.equal(missing.path, '')
  assert.match(missing.error, /插件包不完整/)
  assert.deepEqual(shell.calls, [], '不该再去 PATH 上找 ossutil')
})

test('resolveOssutil 对不受支持的平台说「平台不受支持」，失败文案不提安装', async () => {
  const lookup = await resolveOssutil(fsStub({}), DEFAULT_MANIFEST.oss, 'linux-x64')
  assert.equal(lookup.path, '')
  assert.match(lookup.error, /平台不受支持/)
  for (const message of [lookup.error, ossutilMissingMessage(lookup), ossutilMissingMessage({ path: '', error: '' })]) {
    assert.match(message, /插件包不完整|平台不受支持/)
    assert.doesNotMatch(message, /请先安装|请安装 ossutil|下载/)
  }
})

test('resolveOssutil 在文件服务不可用时说「无法核对」，不说「没有」', async () => {
  const lookup = await resolveOssutil({ get: () => undefined }, DEFAULT_MANIFEST.oss, 'darwin-arm64')
  assert.equal(lookup.path, '')
  assert.match(lookup.error, /无法核对/)
})

// ── OSS 实测 ────────────────────────────────────────────────────────────────

/** 包内 ossutil 就绪的 ctx（OSS 实测的前置条件）。 */
const withBundledOssutil = (...rest) => ctxOf(packagedFs(), ...rest)

test('probeOss refuses to probe without enabled/bucket/ossutil', async () => {
  const idle = withBundledOssutil(shellStub().ctx)
  const disabled = await probeOss(idle, { ...DEFAULT_MANIFEST.oss, enabled: false }, 'darwin-arm64')
  assert.equal(disabled.state, '未启用')

  const noBucket = await probeOss(idle, { ...DEFAULT_MANIFEST.oss, bucket: '' }, 'darwin-arm64')
  assert.equal(noBucket.state, '缺 bucket')

  // 包内没有 ossutil：状态必须说「插件包不完整 / 平台不受支持」，不能是「未安装」。
  const noOssutil = await probeOss(ctxOf(fsStub({})), { ...DEFAULT_MANIFEST.oss, bucket: 'b' }, 'darwin-arm64')
  assert.match(noOssutil.state, /插件包不完整|平台不受支持/)
  assert.equal(noOssutil.ok, false)
  assert.doesNotMatch(noOssutil.detail, /请先安装/)

  // 探测命令没跑起来（沙箱后端不可用）→ 「无法探测」，不是「AK 无效」。
  const down = shellStub(() => ({ runs: false, error: SANDBOX_DOWN }))
  const unreachable = await probeOss(withBundledOssutil(down.ctx), { ...DEFAULT_MANIFEST.oss, bucket: 'b' }, 'darwin-arm64')
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
    const shell = shellStub(() => ({ exitCode: 1, stderr }))
    const check = await probeOss(withBundledOssutil(shell.ctx), { ...DEFAULT_MANIFEST.oss, bucket: 'b', enabled: true }, 'darwin-arm64')
    assert.equal(check.state, expected, `${stderr} 应判为 ${expected}`)
    assert.equal(check.ok, false)
    assert.ok(check.detail.length > 0)
  }
})

test('probeOss passes when the AK can list the bucket, and never echoes credentials', async () => {
  const shell = shellStub(() => ({ stdout: 'oss://b/obj\n' }))
  const check = await probeOss(withBundledOssutil(shell.ctx), { ...DEFAULT_MANIFEST.oss, bucket: 'b', enabled: true }, 'darwin-arm64')
  assert.equal(check.ok, true)
  assert.equal(check.state, 'AK 正常')
  const listing = shell.calls.find((command) => command.includes(' ls ')) ?? ''
  assert.match(listing, /--limited-num 1/, '探测只看一个对象，不拉整个 bucket')
  // 用的必须是**包内绝对路径**，不是裸命令名。
  assert.match(listing, /bin\/darwin-arm64\/ossutil/)
})

test('probeOss honours a manifest-provided probe command template', async () => {
  const shell = shellStub(() => ({ stdout: 'ok\n' }))
  const oss = { ...DEFAULT_MANIFEST.oss, bucket: 'bkt', endpoint: 'oss-cn-x.aliyuncs.com', enabled: true, probeCommand: '{ossutil} ls oss://{bucket}/ --endpoint {endpoint}' }
  const check = await probeOss(withBundledOssutil(shell.ctx), oss, 'darwin-arm64')
  assert.equal(check.ok, true)
  const call = shell.calls.find((command) => command.includes('--endpoint')) ?? ''
  assert.match(call, /oss:\/\/bkt\//)
  assert.match(call, /oss-cn-x\.aliyuncs\.com/)
})

// ── iFinD 配置 ──────────────────────────────────────────────────────────────

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

test('probeIfindKey reads the configured field and reports only the length', async () => {
  const fs = fsStub({ files: { '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{"auth_token":"abcdef"}' }, infos: { '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': { type: 'file' } } })
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
    fsStub({ files: { '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{oops' }, infos: { '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': { type: 'file' } } }),
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
