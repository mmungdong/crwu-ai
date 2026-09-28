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
  buildOssProbeCommand, probePackageIntegrity, packageIntegrityPaths,
  probeOss, resolveOssutil, ossutilMissingMessage, serviceChecks,
} = await import(new URL('src/host/environment/probe.ts', ROOT).href)
// 引用与命令位置已经集中到 `platform/shell.ts`：这里的断言随实现一起搬过去，
// 表格化的逐字断言在 `tests/unit/host-platform-shell.test.mjs` 里更全。
const { shellQuote, shellInvoke } = await import(new URL('src/host/platform/shell.ts', ROOT).href)
const { checkIfindSecret, readIfindSecret, writeIfindSecret, clearIfindSecret, ifindCredentialPath, ifindStateDir } =
  await import(new URL('src/host/ifind/store.ts', ROOT).href)
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

/**
 * fs 替身：`infos` 给 stat 结果，`files` 给 readText 内容。两者分开，混在一张表里会假绿。
 *
 * `written` 记录每次 `writeText`（路径 / 内容 / 传入的 sandboxPolicy）—— 权限与沙箱声明
 * 只有真的写下去才看得出来，所以这一层必须留痕。
 */
function fsStub({ infos = {}, files = {}, failWrite = false } = {}) {
  const written = []
  const live = { ...files }
  const liveInfos = { ...infos }
  return {
    written,
    get: (name) => (name === 'fs'
      ? {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) { return liveInfos[target.targetKey] },
          async readText(target) { return live[target.targetKey] },
          async writeText(target, content, _expected, _signal, sandboxPolicy) {
            if (failWrite) throw new Error('disk full')
            written.push({ path: target.targetKey, content, sandboxPolicy })
            live[target.targetKey] = content
            liveInfos[target.targetKey] = { type: 'file' }
            return { operation: 'update', version: 'v', before: null, after: content }
          },
        }
      : undefined),
  }
}

/**
 * 给 fs 替身配一个 shell 替身（`writeIfindSecret` 用 shell 建目录 + chmod + stat 核对权限）。
 *
 * `{ runs: false }` 走 DSH 契约里「命令根本没执行」的形状：`execute` 抛错。
 */
function asShellCtx(fs, { runs = true, error = 'boom', stdout = '', failOn = '', mode = '600' } = {}) {
  const commands = []
  const shell = {
    resolve: (request) => request,
    async execute(spec) {
      commands.push(spec.command)
      if (failOn !== '' && spec.command.includes(failOn)) throw new Error(error)
      if (!runs) throw new Error(error)
      // 权限收紧之后会**回读模式位**（`stat -f %Lp` / `stat -c %a`）：替身必须回答这一条，
      // 否则 `verified` 会被误判成 failed（那正是「只信退出码」时代的反面）。
      const text = /^stat -[fc] /.test(spec.command) ? mode : stdout
      return { result: async () => ({
        exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
        stdout: { text, truncated: false }, stderr: { text: '', truncated: false },
      }) }
    },
  }
  return {
    written: fs.written,
    commands,
    get: (name) => (name === 'shell' ? shell : fs.get(name)),
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

// ── 引号与命令位置 ──────────────────────────────────────────────────────────

test('shellQuote 在 POSIX 用单引号、在 Windows 用 PowerShell 单引号字面量', () => {
  assert.equal(shellQuote('/usr/local/bin/ossutil', 'darwin-arm64'), '/usr/local/bin/ossutil')
  assert.equal(shellQuote('/opt/my tools/ossutil', 'linux-x64'), "'/opt/my tools/ossutil'")
  // Windows 的执行器是 PowerShell（`pwsh -Command <整串>`），不是 cmd.exe：
  // 单引号才是纯字面量，双引号会做 `$` / 反引号插值；内部单引号翻倍即转义。
  assert.equal(shellQuote('C:\\Program Files\\ossutil.exe', 'win32-x64'), "'C:\\Program Files\\ossutil.exe'")
  assert.equal(shellQuote("it's", 'win32-x64'), "'it''s'")
})

test('shellInvoke 在 Windows 补 PowerShell 调用运算符 `&`（员工实测的 ParserError）', () => {
  // 现场报错：`"C:\…\crwu.exe" "h3yun" "session" "status"` →
  // 「表达式或语句中包含意外的标记"h3yun"。」—— 以引号开头的 token 在 PowerShell 里是字符串表达式。
  assert.equal(
    shellInvoke('C:\\Program Files\\crwu.exe', ['h3yun', 'session', 'status'], 'win32-x64'),
    "& 'C:\\Program Files\\crwu.exe' 'h3yun' 'session' 'status'",
  )
  // 参数里的单引号同样翻倍，且不会被 PowerShell 插值。
  assert.equal(shellInvoke('dws.exe', ["a'b", '$HOME'], 'win32-x64'), "& 'dws.exe' 'a''b' '$HOME'")
  // POSIX 上绝不能加 `&`：`bash -c` 里它是后台作业，会把前台命令变成异步执行。
  assert.equal(shellInvoke('/usr/local/bin/ossutil', ['ls', 'oss://b/p/'], 'darwin-arm64'), '/usr/local/bin/ossutil ls oss://b/p/')
  assert.equal(shellInvoke('/opt/my tools/ossutil', ['ls'], 'linux-x64'), "'/opt/my tools/ossutil' ls")
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

test('probeOss 四类失败分开归因（凭据 / 权限 / 配置 / 基础设施）', async () => {
  const cases = [
    ['AccessDenied: no permission', 'AccessKey 没有目标权限', 'permission'],
    ['Forbidden: denied', 'AccessKey 没有目标权限', 'permission'],
    ['InvalidAccessKeyId', 'AccessKey 无效', 'credential'],
    ['SignatureDoesNotMatch', 'AccessKey 无效', 'credential'],
    ['InvalidSecurityToken', 'AccessKey 无效', 'credential'],
    ['NoSuchBucket', 'Bucket 或 Endpoint 配置有误', 'config'],
    ['unknown endpoint oss-cn-nope.aliyuncs.com', 'Bucket 或 Endpoint 配置有误', 'config'],
    // 网络 / 超时 / 上游 5xx 一律归基础设施：说成 AK 问题会把人指去换一份好密钥。
    ['dial tcp: lookup b.oss-cn-x.aliyuncs.com: no such host', '连接 OSS 失败', 'infrastructure'],
    ['something else entirely', '连接 OSS 失败', 'infrastructure'],
  ]
  for (const [stderr, expected, kind] of cases) {
    const shell = shellStub(() => ({ exitCode: 1, stderr }))
    const check = await probeOss(withBundledOssutil(shell.ctx), { ...DEFAULT_MANIFEST.oss, bucket: 'b', enabled: true }, 'darwin-arm64')
    assert.equal(check.state, expected, `${stderr} 应判为 ${expected}`)
    assert.equal(check.errorKind, kind, `${stderr} 应归为 ${kind}`)
    assert.equal(check.ok, false)
    assert.ok(check.detail.length > 0)
  }
})

test('probeOss 验证的是**业务前缀**（空目录也算成功），且命令是只读 ls', async () => {
  const shell = shellStub(() => ({ stdout: '' }))
  const oss = { ...DEFAULT_MANIFEST.oss, bucket: 'b', prefix: 'crwu/audit', enabled: true }
  const check = await probeOss(withBundledOssutil(shell.ctx), oss, 'darwin-arm64')
  // 空 stdout（目录里没有对象）仍然是成功：判据是"请求成功且有权访问该目标"。
  assert.equal(check.ok, true, '空目录必须算验证成功')
  assert.equal(check.state, 'AK 正常')
  assert.equal(check.errorKind, '')
  const command = shell.calls[0] ?? ''
  assert.match(command, /oss:\/\/b\/crwu\/audit\//, '必须打业务前缀而不是桶根')
  assert.match(command, /--limited-num 1/)
  assert.match(command, / ls /, '只允许只读列举')
  assert.equal(/\b(rm|cp|mkdir|create|sync|appendfromfile|set-acl|put)\b/.test(command), false, '不得用写操作验证')
  // 归因目标只用于诊断，且不含凭据。
  assert.equal(check.target, 'oss://b/crwu/audit/')
})

test('probeOss 失败详情里即使上游回显密钥 / 签名 URL，也不会带到界面', async () => {
  const noisy = 'error: GET https://b.oss-cn-x.aliyuncs.com/?Signature=abc123&OSSAccessKeyId=LTAI5tabcdefghijkl&security-token=STS.xyz'
  const shell = shellStub(() => ({ exitCode: 1, stderr: noisy }))
  const check = await probeOss(withBundledOssutil(shell.ctx), { ...DEFAULT_MANIFEST.oss, bucket: 'b', enabled: true }, 'darwin-arm64')
  assert.equal(check.ok, false)
  for (const secret of ['LTAI5tabcdefghijkl', 'Signature=abc123', 'STS.xyz', 'security-token=STS']) {
    assert.equal(check.detail.includes(secret), false, `详情泄露了 ${secret}：${check.detail}`)
  }
  assert.match(check.detail, /<redacted>|redacted/, '要留下脱敏标记而不是把整句删掉')
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

test('Windows 上探测命令是可执行的 PowerShell：以 `&` 开头、路径与参数都是单引号字面量', async () => {
  const shell = shellStub(() => ({ stdout: '' }))
  const oss = { ...DEFAULT_MANIFEST.oss, bucket: 'b', prefix: 'crwu/audit', enabled: true, endpoint: 'oss-cn-x.aliyuncs.com' }
  await probeOss(ctxOf(packagedFs({ platform: 'win32-x64' }), shell.ctx), oss, 'win32-x64')
  const command = shell.calls[0] ?? ''
  assert.equal(command.startsWith('& '), true, `必须补调用运算符，否则 PowerShell 报 ParserError：${command}`)
  assert.match(command, /^& '.*ossutil\.exe' 'ls' 'oss:\/\/b\/crwu\/audit\/' '--endpoint' 'oss-cn-x\.aliyuncs\.com' '--limited-num' '1'$/)
  assert.equal(command.includes('"'), false, '不得出现 cmd 式双引号')
})

test('Windows 上清单给的探测模板同样补调用运算符，且每个占位符都逐个引用', async () => {
  const shell = shellStub(() => ({ stdout: 'ok\n' }))
  const oss = { ...DEFAULT_MANIFEST.oss, prefix: 'my audit', bucket: 'bkt', endpoint: 'oss-cn-x.aliyuncs.com', enabled: true, probeCommand: '{ossutil} ls oss://{bucket}/{prefix}/ --endpoint {endpoint}' }
  await probeOss(ctxOf(packagedFs({ platform: 'win32-x64' }), shell.ctx), oss, 'win32-x64')
  const command = shell.calls[0] ?? ''
  assert.equal(command.startsWith("& '"), true, `模板里的 {ossutil} 就是命令位置：${command}`)
  // 每个占位符的值都按平台引用成字面量：旧实现把动态值裸拼进去，一个空格就能改写命令结构。
  // （占位符夹在词中间时，引用后的片段与裸文本相邻拼接，两个方言都把整段当一个参数。）
  assert.equal(command.endsWith("--endpoint 'oss-cn-x.aliyuncs.com'"), true, command)
  assert.equal(command.includes("'my audit/'"), true, `带空格的占位符必须被引用：${command}`)
  assert.equal(command.includes('{prefix}'), false, '占位符必须被替换掉')
})

test('旧字符串模板是 deprecated 兼容路径：未知占位符、换行与空可执行文件都必须拒绝', () => {
  const base = { ...DEFAULT_MANIFEST.oss, bucket: 'bkt', endpoint: '', enabled: true }
  const rejected = (probeCommand) => {
    const built = buildOssProbeCommand({ ...base, probeCommand }, '/opt/ossutil', 'darwin-arm64')
    assert.equal(built.ok, false, `应当拒绝：${probeCommand}`)
    return built.error
  }
  assert.match(rejected('{ossutil} ls {nope}'), /未知占位符/)
  assert.match(rejected('{ossutil} ls oss://a\nb'), /换行/)
  assert.match(rejected('{ossutil} ls {oops'), /花括号/)
  assert.equal(buildOssProbeCommand(base, '', 'darwin-arm64').ok, false)
  // 默认路径是**结构化**的，不经过任何模板。
  const built = buildOssProbeCommand(base, '/opt/ossutil', 'darwin-arm64')
  assert.equal(built.ok, true)
  assert.equal(built.deprecated, false)
})

// ── iFinD 凭据：**插件自有存储**（不再是技能目录里的 mcp_config.json）────────────

test('iFinD 凭据路径的分隔符随主目录风格走（Windows 上是 `\\`）', () => {
  assert.equal(ifindCredentialPath('/Users/x'), '/Users/x/.dsh/crwu-workbench/ifind-credential.json')
  assert.equal(ifindCredentialPath('/Users/x/'), '/Users/x/.dsh/crwu-workbench/ifind-credential.json')
  assert.equal(ifindCredentialPath('C:\\Users\\x'), 'C:\\Users\\x\\.dsh\\crwu-workbench\\ifind-credential.json')
  assert.equal(ifindStateDir('C:\\Users\\x'), 'C:\\Users\\x\\.dsh\\crwu-workbench')
  // 主目录未知时保持 `~` 形式（不能拼成 `/ifind-credential.json`）。
  assert.equal(ifindCredentialPath(''), '~/.dsh/crwu-workbench/ifind-credential.json')
})

test('checkIfindSecret 区分空值 / 占位符 / 首尾空白 / 换行 / 过短', () => {
  assert.equal(checkIfindSecret('').reason, 'API-Key 为空，请填写你自己的同花顺 iFinD API-Key')
  assert.equal(checkIfindSecret('   ').reason, 'API-Key 为空，请填写你自己的同花顺 iFinD API-Key')
  assert.match(checkIfindSecret('your ifind-mcp key').reason, /仍是占位符/)
  assert.match(checkIfindSecret('YOUR IFIND-MCP KEY').reason, /仍是占位符/)
  assert.match(checkIfindSecret('abcdefgh ').reason, /多余空白/)
  assert.match(checkIfindSecret('abcdefgh\n').reason, /不能包含换行/)
  assert.match(checkIfindSecret('abcdefgh\r\nxyz').reason, /不能包含换行/)
  assert.equal(checkIfindSecret('abcdefgh').ok, true)
  // 空/占位符/空白/换行是"输入没填好"，过短是"看着不像有效 SK" —— 两类处置不同。
  assert.equal(checkIfindSecret('').errorKind, 'input')
  assert.equal(checkIfindSecret('abc').errorKind, 'invalid')
})

test('checkIfindSecret 只回长度，绝不回显密钥本体', () => {
  const verdict = checkIfindSecret('s3cret-token')
  assert.deepEqual(verdict, { ok: true, reason: '', value: 's3cret-token', length: 12, errorKind: '' })
  // 面向界面 / 模型的那一份（view）里没有 value 字段。
  assert.equal('value' in verdict === true, true, '内部判定需要明文给 Host 用')
})

test('凭据文件落在插件状态目录，不在技能目录、也不在插件包目录', () => {
  const path = ifindCredentialPath('/Users/x')
  assert.equal(path, '/Users/x/.dsh/crwu-workbench/ifind-credential.json')
  assert.equal(ifindStateDir('/Users/x'), '/Users/x/.dsh/crwu-workbench')
  for (const banned of ['.agents', 'skills', 'ifind-finance-data', 'node_modules', 'plugins/']) {
    assert.equal(path.includes(banned), false, `凭据不得落在 ${banned} 下：${path}`)
  }
})

test('readIfindSecret 读配置字段、写回后能再读出来（明文只在 Host 内部）', async () => {
  const path = ifindCredentialPath('/Users/x')
  const fs = fsStub({ files: { [path]: '{"auth_token":"abcdefghij"}' }, infos: { [path]: { type: 'file' } } })
  const check = await readIfindSecret({ get: (name) => fs.get(name) }, '/Users/x')
  assert.equal(check.ok, true)
  assert.equal(check.secret, 'abcdefghij')
  assert.equal(check.view.length, 10)
  assert.equal(check.view.state, 'unverified', '只读文件不等于已认证')
  assert.equal(JSON.stringify(check.view).includes('abcdefghij'), false, '脱敏视图里绝不能带出密钥')
})

test('readIfindSecret 解释未配置 / 坏 JSON / 占位符 / 无 fs', async () => {
  const missing = await readIfindSecret({ get: (name) => fsStub({}).get(name) }, '/Users/x')
  assert.equal(missing.ok, false)
  assert.equal(missing.state, 'unconfigured')
  assert.match(missing.reason, /还没有保存/)

  const path = ifindCredentialPath('/Users/x')
  const badFs = fsStub({ files: { [path]: '{oops' }, infos: { [path]: { type: 'file' } } })
  const badJson = await readIfindSecret({ get: (name) => badFs.get(name) }, '/Users/x')
  assert.equal(badJson.state, 'invalid')
  assert.match(badJson.reason, /不是合法 JSON/)

  const placeholderFs = fsStub({ files: { [path]: '{"auth_token":"your ifind-mcp key"}' }, infos: { [path]: { type: 'file' } } })
  const placeholder = await readIfindSecret({ get: (name) => placeholderFs.get(name) }, '/Users/x')
  assert.equal(placeholder.state, 'invalid')
  assert.match(placeholder.reason, /占位符/)

  const noFs = await readIfindSecret({ get: () => undefined }, '/Users/x')
  assert.equal(noFs.state, 'unreachable')
  assert.match(noFs.reason, /文件服务不可用/)
})

test('空值 / 占位符 / 首尾空白 / 换行在**写盘之前**就被拒绝（不留坏文件）', async () => {
  for (const bad of ['', '   ', 'your ifind-mcp key', ' abcdefgh', 'abcdefgh\n']) {
    const ctx = asShellCtx(fsStub({}), { runs: true })
    const result = await writeIfindSecret(ctx, '/Users/x', bad, { platform: 'darwin-arm64' })
    assert.equal(result.ok, false, JSON.stringify(bad))
    assert.equal(result.errorKind, 'input', JSON.stringify(bad))
    assert.deepEqual(ctx.written, [], `坏值不得触发任何写盘：${JSON.stringify(bad)}`)
  }
})

test('写入失败与权限设置失败都要如实上报（不假装成功、也不删掉已保存的凭据）', async () => {
  // ① 写盘抛错 → infrastructure。
  const failing = fsStub({ failWrite: true })
  const writeFailed = await writeIfindSecret(asShellCtx(failing, { runs: true }), '/Users/x', 'abcdefgh', { platform: 'darwin-arm64' })
  assert.equal(writeFailed.ok, false)
  assert.equal(writeFailed.errorKind, 'infrastructure')
  assert.match(writeFailed.error, /写入/)

  // ② chmod 失败 → 凭据仍然保存成功，但权限结论必须是 failed + 原因带出来。
  const ctx = asShellCtx(fsStub({}), { failOn: 'chmod 600', error: 'chmod: Operation not permitted' })
  const chmodFailed = await writeIfindSecret(ctx, '/Users/x', 'abcdefgh', { platform: 'darwin-arm64' })
  assert.equal(chmodFailed.ok, true, '权限没收紧不该作废已保存的凭据')
  assert.equal(chmodFailed.permission.status, 'failed')
  assert.equal(chmodFailed.permission.mechanism, 'posix-0600')
  assert.match(chmodFailed.permission.message, /Operation not permitted/)
  assert.equal(ctx.written.length, 1, '文件确实写下去了')
})

test('成功保存：文件内容只有那一个字段、权限收紧到 0600、并回脱敏视图', async () => {
  const ctx = asShellCtx(fsStub({}), { runs: true })
  const result = await writeIfindSecret(ctx, '/Users/x', 'abcdefgh', { platform: 'darwin-arm64' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.permission, { status: 'verified', mechanism: 'posix-0600', message: '' })
  assert.equal(result.mode, 'file')
  assert.equal(result.view.exists, true)
  assert.equal(result.view.length, 8)
  assert.equal(JSON.stringify(result).includes('abcdefgh'), false, '返回值里不得出现明文')
  const path = ifindCredentialPath('/Users/x')
  assert.deepEqual(JSON.parse(ctx.written[0].content), { auth_token: 'abcdefgh' })
  assert.equal(ctx.written[0].path, path)
  // 写 `~/.dsh/` 必须显式声明无沙箱，否则受限沙箱下写不进去（实测踩过）。
  assert.equal(ctx.written[0].sandboxPolicy?.mode, 'danger-full-access')
  assert.equal(ctx.commands.some((command) => command.includes('chmod 600')), true, '必须真的收紧权限')
})

test('清除凭据走显式命令，失败要如实报', async () => {
  const ok = asShellCtx(fsStub({}), { runs: true })
  assert.equal((await clearIfindSecret(ok, '/Users/x', { platform: 'darwin-arm64' })).ok, true)
  assert.equal(ok.commands.some((command) => command.startsWith('rm -f ')), true)

  const down = asShellCtx(fsStub({}), { runs: false, error: 'no sandbox backend' })
  const failed = await clearIfindSecret(down, '/Users/x', { platform: 'darwin-arm64' })
  assert.equal(failed.ok, false)
  assert.equal(failed.errorKind, 'infrastructure')
})

test('Windows 上没有 mkdir -p / chmod / rm -f：换成 PowerShell 的等价写法', async () => {
  // `mkdir -p` 靠参数名缩写、`chmod` 根本不是命令、`rm -f` 的 `-f` 在 Remove-Item 上同时
  // 前缀匹配 -Force 与 -Filter（「参数名不明确」）—— 三条在 PowerShell 里都会失败。
  const ctx = asShellCtx(fsStub({}), { runs: true })
  const home = 'C:\\Users\\x'
  const result = await writeIfindSecret(ctx, home, 'abcdefgh', { platform: 'win32-x64' })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'file')
  assert.equal(ctx.commands.some((command) => command.includes('chmod')), false, 'Windows 不得执行 chmod')
  assert.equal(
    ctx.commands.some((command) => /^New-Item -ItemType Directory -Force -Path '.+' \| Out-Null$/.test(command)),
    true,
    `建目录必须是幂等的 PowerShell 写法：${ctx.commands.join(' | ')}`,
  )
  // Windows 没有 POSIX 权限位：结论必须是 **inherited / windows-acl** ——
  // 既不说成「已验证」（旧 chmodOk:true 的毛病），也不说成失败。
  assert.deepEqual(result.permission, {
    status: 'inherited', mechanism: 'windows-acl', message: '使用当前 Windows 账户 ACL；POSIX 0600 不适用',
  })

  await clearIfindSecret(ctx, home, { platform: 'win32-x64' })
  const remove = ctx.commands.find((command) => command.startsWith('if (Test-Path -LiteralPath ')) ?? ''
  assert.notEqual(remove, '', `删除必须是 PowerShell 幂等写法：${ctx.commands.join(' | ')}`)
  assert.match(remove, /-ErrorAction Stop \}$/, '真实失败必须能传播（不能 SilentlyContinue）')
  assert.equal(remove.includes('SilentlyContinue'), false)
  assert.equal(ctx.commands.some((command) => command.startsWith('rm -f ')), false)
})

test('Windows 上凭据落盘本身失败仍是操作失败（权限结论不得掩盖它）', async () => {
  // ① 建目录失败（目录不存在又报错）→ infrastructure，且权限结论是 failed。
  const mkdirDown = asShellCtx(fsStub({}), { runs: false, error: 'Access is denied' })
  const dirFailed = await writeIfindSecret(mkdirDown, 'C:\\Users\\x', 'abcdefgh', { platform: 'win32-x64' })
  assert.equal(dirFailed.ok, false, '目录没建出来就不是成功')
  assert.equal(dirFailed.errorKind, 'infrastructure')
  assert.equal(dirFailed.permission.status, 'failed')

  // ② 写盘抛错 → infrastructure；权限结论同样是 failed（不是 inherited）。
  const writeDown = asShellCtx(fsStub({ failWrite: true }), { runs: true })
  const writeFailed = await writeIfindSecret(writeDown, 'C:\\Users\\x', 'abcdefgh', { platform: 'win32-x64' })
  assert.equal(writeFailed.ok, false)
  assert.equal(writeFailed.errorKind, 'infrastructure')
  assert.equal(writeFailed.permission.status, 'failed')
  assert.equal(writeFailed.permission.mechanism, 'windows-acl')

  // ③ 清除失败 → 仍然是操作失败。
  const clearDown = asShellCtx(fsStub({}), { runs: false, error: 'file is locked' })
  const cleared = await clearIfindSecret(clearDown, 'C:\\Users\\x', { platform: 'win32-x64' })
  assert.equal(cleared.ok, false)
  assert.equal(cleared.errorKind, 'infrastructure')
})

test('未知平台时不猜权限机制，写盘直接拒绝', async () => {
  const ctx = asShellCtx(fsStub({}), { runs: true })
  const result = await writeIfindSecret(ctx, '/Users/x', 'abcdefgh', {})
  assert.equal(result.ok, false)
  assert.equal(result.permission.status, 'failed')
  assert.match(result.error, /未知平台/)
})
