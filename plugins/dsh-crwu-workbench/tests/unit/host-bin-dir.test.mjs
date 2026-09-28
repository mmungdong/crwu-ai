/**
 * 插件自带二进制目录（`bin/<平台>/`）的定位与优先级。
 *
 * 这一层为什么值得单独测：DSH **没有**任何「把插件里的 bin 挂上 PATH」的机制（四条路都实测堵死，
 * 见 `src/host/platform/bin-dir.ts` 头部清单），所以「员工零安装」这件事全压在
 * 「插件能按平台算出包内绝对路径」这一条上。算错只有两种表现，而且都不响亮：
 * 环境自检谎报「未安装」把员工送去装一个已经装好的东西，或者自带二进制明明在包里却永远用不上。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)

const { BUNDLED_BIN_PLATFORMS, binPlatformDir, binaryFileName, binDirFor, bundledBinaryPath } = await import(
  new URL('src/host/platform/bin-dir.ts', ROOT).href
)
const { packageRootFrom } = await import(new URL('src/host/platform/package-root.ts', ROOT).href)
const { resolveBundledCommand } = await import(new URL('src/host/platform/command.ts', ROOT).href)
const { runCrwu } = await import(new URL('src/host/crwu/run.ts', ROOT).href)
const { probePackageIntegrity, packageIntegrityPaths, resolveOssutil } = await import(new URL('src/host/environment/probe.ts', ROOT).href)
const { DEFAULT_MANIFEST } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)

/** shell 替身：按命令回放 stdout；只实现 0.1.7 的 `execute().result()` 投影。 */
function shellStub(handler) {
  const calls = []
  return {
    calls,
    get: (name) => (name === 'shell'
      ? {
          resolve: (request) => request,
          async execute(spec) {
            calls.push(spec.command)
            const out = handler(spec.command)
            return {
              result: async () => ({
                exitCode: out.exitCode ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                stdout: { text: out.stdout ?? '', truncated: false },
                stderr: { text: out.stderr ?? '', truncated: false },
              }),
            }
          },
        }
      : undefined),
  }
}

/** fs 替身：`infos` 里登记过的路径才算存在；`texts` 给 readText（包内清单）。 */
function fsStub(infos, texts = {}) {
  return {
    get: (name) => (name === 'fs'
      ? {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) { return infos[target.targetKey] },
          async readText(target) { return texts[target.targetKey] },
        }
      : undefined),
  }
}

/** 包内 bin/manifest.json 的内容（声明的字节数由调用方给）。 */
function binManifest(platform, tools) {
  return JSON.stringify({
    schemaVersion: 'crwu.plugin-bin-manifest.v1',
    platforms: [{ platform, tools: tools.map(({ name, size }) => ({ tool: name, file: name, platform, size, sha256: `sha-${name}` })) }],
  })
}

/** 合并多个替身的 ctx。 */
const ctxOf = (...contexts) => ({ get: (name) => contexts.map((ctx) => ctx.get(name)).find((value) => value !== undefined) })

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test('只认发布范围内平台的目录名，其余一律回退 PATH', () => {
  for (const platform of BUNDLED_BIN_PLATFORMS) {
    assert.equal(binPlatformDir(platform), platform)
  }
  // 没有预编译包的平台必须返回空串：调用方据此继续走 PATH，而不是去 stat 一个不存在的目录。
  for (const platform of ['linux-x64', 'darwin-x64', 'linux-arm64', 'win32-arm64', '']) {
    assert.equal(binPlatformDir(platform), '', `${platform} 不在发布范围内，应回退 PATH`)
  }
})

test('Windows 平台的二进制带 .exe，其余不带', () => {
  assert.equal(binaryFileName('crwu', 'win32-x64'), 'crwu.exe')
  assert.equal(binaryFileName('ossutil', 'win32-x64'), 'ossutil.exe')
  assert.equal(binaryFileName('crwu', 'darwin-arm64'), 'crwu')
})

test('包根从两种加载深度都能定位（构建产物 1 层、源码 3 层）', () => {
  const fromSource = packageRootFrom(new URL('src/host/platform/', ROOT).pathname)
  const fromBuilt = packageRootFrom(new URL('lib/', ROOT).pathname)
  assert.ok(fromSource.endsWith('dsh-crwu-workbench'), `源码形态实际 ${fromSource}`)
  assert.equal(fromSource, fromBuilt, '两种形态必须落到同一个包根')
})

test('binDirFor 拼 <包根>/bin/<平台>；平台不受支持时为空串', () => {
  const moduleUrl = new URL('src/host/platform/bin-dir.ts', ROOT).href
  assert.ok(binDirFor(moduleUrl, 'darwin-arm64').endsWith(join('bin', 'darwin-arm64')))
  assert.equal(binDirFor(moduleUrl, 'linux-x64'), '', '不支持的平台不得编出一个路径')
})

test('bundledBinaryPath 按平台拼出文件名', () => {
  assert.ok(bundledBinaryPath('darwin-arm64', 'ossutil').endsWith(join('bin', 'darwin-arm64', 'ossutil')))
  assert.ok(bundledBinaryPath('win32-x64', 'ossutil').endsWith(join('bin', 'win32-x64', 'ossutil.exe')))
  assert.equal(bundledBinaryPath('linux-x64', 'ossutil'), '')
})

// ── win32-arm64：没有随包二进制就必须如实拒绝，绝不顶替 x64 ──────────────────

test('win32-arm64 没有随包二进制：路径解析为空、capability gap 不得指向 x64', async () => {
  // 为什么单独钉：arm64 Windows 上跑一份 x64 exe 在多数机器上「看起来能跑」（模拟层），
  // 于是「静默用 x64 顶上」不会立刻报错，却让适用性判断失去意义。策略是**明确不支持**。
  assert.equal(binPlatformDir('win32-arm64'), '')
  assert.equal(bundledBinaryPath('win32-arm64', 'crwu'), '')
  assert.equal(binaryFileName('crwu', 'win32-arm64'), 'crwu.exe', '文件名规则仍按平台给（用于报错文案）')

  const { requireBundledCommand } = await import(new URL('src/host/platform/command.ts', ROOT).href)
  const shell = shellStub(() => ({ stdout: '' }))
  for (const name of ['crwu', 'dws', 'ossutil']) {
    const resolved = await requireBundledCommand(ctxOf(fsStub({}), shell), 'win32-arm64', name)
    assert.equal(resolved.ok, false, `${name} 在 win32-arm64 上必须回 capability gap`)
    assert.equal(resolved.errorKind, 'capability-gap')
    assert.match(resolved.error, /win32-arm64/)
    assert.match(resolved.error, /没有随包发布/)
    assert.equal(resolved.error.includes('win32-x64'), false, '不得在文案里指向另一个架构')
  }
  // 也不许跑任何命令去找替代品（`which` / `command -v` / 搜文件）。
  assert.deepEqual(shell.calls, [])
})

// ── 优先级：只认包内 ────────────────────────────────────────────────────────

test('包内 ossutil 存在时直接命中，不跑任何 PATH 探测', async () => {
  const bundled = bundledBinaryPath('darwin-arm64', 'ossutil')
  const shell = shellStub(() => ({ stdout: '/usr/local/bin/ossutil\n' }))
  const ctx = ctxOf(fsStub({ [bundled]: { type: 'file' } }), shell)

  const found = await resolveOssutil(ctx, DEFAULT_MANIFEST.oss, 'darwin-arm64')
  assert.equal(found.path, bundled, '只认包内绝对路径 —— 版本随包锁定，员工不需要单独装')
  assert.equal(found.error, '')
  assert.deepEqual(shell.calls, [], '包内命中时不该跑任何命令')
})

test('包内没有 ossutil 时**不回退** PATH：如实说插件包不完整', async () => {
  // fs 替身什么都不认：模拟「未装配 / 平台不受支持」。
  // PATH 上有同名命令也不认 —— 旧实现在这里回退，于是模型会看到 `command not found` 之后去搜 PATH。
  const shell = shellStub(() => ({ stdout: '/usr/local/bin/ossutil\n' }))
  const found = await resolveOssutil(ctxOf(fsStub({}), shell), DEFAULT_MANIFEST.oss, 'darwin-arm64')
  assert.equal(found.path, '')
  assert.match(found.error, /插件包不完整/)
  assert.deepEqual(shell.calls, [], '不许再回退到 PATH 上找同名命令')
})

test('probePackageIntegrity 对包内 crwu 报出包内文件与清单字节数，而不是「未安装」', async () => {
  const platform = 'darwin-arm64'
  const bundled = bundledBinaryPath(platform, 'crwu')
  const paths = packageIntegrityPaths()
  const size = 123456
  const ctx = ctxOf(
    fsStub(
      { [bundled]: { type: 'file', size }, [bundledBinaryPath(platform, 'dws')]: { type: 'file', size: 1 }, [bundledBinaryPath(platform, 'ossutil')]: { type: 'file', size: 2 } },
      { [paths.manifestPath]: binManifest(platform, [{ name: 'crwu', size }, { name: 'dws', size: 1 }, { name: 'ossutil', size: 2 }]) },
    ),
  )

  const result = await probePackageIntegrity(ctx, DEFAULT_MANIFEST, platform)
  const crwu = result.tools.find((tool) => tool.name === 'crwu')
  assert.equal(crwu.present, true, '自带二进制在包里，就不能报「未安装」')
  assert.equal(crwu.file, 'crwu')
  assert.equal(crwu.sizeBytes, size)
  assert.equal(crwu.manifestSizeBytes, size)
  assert.equal(crwu.ok, true)
  assert.equal(result.ok, true)
})

// ── 自带命令的绝对路径解析 ──────────────────────────────────────────────────

test('包内有该二进制就用绝对路径；没有（或平台不受支持）就回退按名字调用', async () => {
  const platform = 'darwin-arm64'
  const bundled = bundledBinaryPath(platform, 'crwu')
  assert.equal(await resolveBundledCommand(ctxOf(fsStub({ [bundled]: { type: 'file' } })), platform, 'crwu'), bundled)
  // 回退分支必须留着：SSH / 容器执行世界里宿主上的包内路径根本不存在。
  assert.equal(await resolveBundledCommand(ctxOf(fsStub({})), platform, 'crwu'), 'crwu')
  assert.equal(await resolveBundledCommand(ctxOf(fsStub({})), 'linux-x64', 'crwu'), 'crwu')
})

test('runCrwu 真的用包内绝对路径去起进程（PATH 里没有 crwu 也能跑）', async () => {
  // 实测现场：Finder 启动的桌面端 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
  // 按名字调用得到 `bash: crwu: command not found` —— 「氚云登录」点了没有任何反应。
  const platform = 'darwin-arm64'
  const bundled = bundledBinaryPath(platform, 'crwu')
  const specs = []
  const shell = {
    resolve: (request) => request,
    async execute(spec) {
      specs.push(spec)
      return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }) }
    },
  }
  const ctx = ctxOf(fsStub({ [bundled]: { type: 'file' } }), { get: (n) => (n === 'shell' ? shell : undefined) })
  await runCrwu(ctx, ['crwu', 'h3yun', 'session', 'status'], { trusted: false, platform })
  assert.equal(specs.length, 1)
  assert.equal(specs[0].command, `${bundled} h3yun session status`, '必须换成包内绝对路径')

  // 安全边界不变：非 crwu 的 argv 仍然被拒（换路径发生在白名单校验之后）。
  const denied = await runCrwu(ctx, ['sh', '-c', 'ls'], { trusted: false, platform })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /只允许调用 crwu/)
})
