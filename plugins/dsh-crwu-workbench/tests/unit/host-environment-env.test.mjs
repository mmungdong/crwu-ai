/**
 * 环境自检聚合（`env` 操作）的单元测试。
 *
 * 这是面板的入口页，也是所有后续操作的硬门禁。最需要防的是「假绿」：
 * blocked 为空但用户其实干不了活（缺工作空间、平台没识别、插件包不完整）。
 *
 * 2026-09-25 的口径变化（这一版测试盯的就是它们）：
 * - `env` 的返回从 `checks[]` 混装改成 `packageIntegrity` / `runtime` / `services`（授权）/
 *   `delivery`（OSS）/ `external`（iFinD）分区；
 * - 裸 `python3` 不再是检查项，运行时只认 **DSH 自带** 的那一份（能力缺口要如实报）；
 * - 三件随包组件不再各自贡献阻塞项 —— 插件包不完整只算**一个**故障。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { loadEnvironment } = await import(new URL('src/host/environment/ops.ts', ROOT).href)
const { DEFAULT_MANIFEST } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)
const { packageIntegrityPaths } = await import(new URL('src/host/environment/probe.ts', ROOT).href)
const { bundledBinaryPath } = await import(new URL('src/host/platform/bin-dir.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)

const CONFIG = {
  configSource: '/tmp/test-crwu-workbench.yml', caseRoot: '', formName: '报告审核',
  preferWorkspaceTitle: '中瑞世联工作空间',
  // 审核产物那个私有桶由 YAML 提供（内置清单里的 bucket 是空的，否则整条 OSS 链路都是「缺 bucket」）。
  ossBucket: 'bkt', ossPrefix: 'crwu/audit', ossEndpoint: '', ossBaseUrl: '',
  ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true, requireTopLevelParent: true,
}

/** 沙箱后端不可用时 DSH 抛出的那条原文（真实环境逐字抄回，不是编的）。 */
const SANDBOX_DOWN = 'sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined.'

const PATHS = packageIntegrityPaths()
const BUNDLED = (name, platform = 'darwin-arm64') => bundledBinaryPath(platform, name)
const sizeOf = (name) => 1000 + name.length

/** 包内 bin/manifest.json 的内容（三个组件的字节数与自己的文件一致）。 */
function binManifest(platform = 'darwin-arm64', tools = DEFAULT_MANIFEST.packaged.map((spec) => spec.name)) {
  return JSON.stringify({
    schemaVersion: 'crwu.plugin-bin-manifest.v1',
    platforms: [{ platform, tools: tools.map((name) => ({ tool: name, file: name, platform, size: sizeOf(name), sha256: `sha-${name}` })) }],
  })
}

/**
 * 一个 ctx：shell 按命令回放（并记录真的发过哪些命令），fs 同时提供目录、文件与字节数；
 * `workspaceRegistry` / `sessions` 可选。
 */
function makeCtx({ shellLines = {}, shellDown = [], dirs = [], files = {}, infos = {}, entries = [], sessions, packaged = true } = {}) {
  const directories = new Set(dirs)
  const specs = []
  const allInfos = { ...infos }
  if (packaged) {
    for (const spec of DEFAULT_MANIFEST.packaged) allInfos[BUNDLED(spec.name)] = { type: 'file', size: sizeOf(spec.name) }
    files = { [PATHS.manifestPath]: binManifest(), ...files }
  }
  return {
    specs,
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async execute(spec) {
            specs.push(spec)
            // `shellDown` 里的 needle 命中时**抛错**：DSH 契约里 `execute` 只为基础设施故障 reject，
            // 沙箱后端不可用就长这样（真实环境逐字抄回的那条错误）。
            for (const needle of shellDown) {
              if (spec.command.includes(needle)) throw new Error(SANDBOX_DOWN)
            }
            for (const [needle, out] of Object.entries(shellLines)) {
              if (spec.command.includes(needle)) {
                return { result: async () => ({
                  exitCode: out.exitCode ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                  stdout: { text: out.stdout ?? '', truncated: false },
                  stderr: { text: out.stderr ?? '', truncated: false },
                }) }
              }
            }
            return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }) }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) {
            const key = String(target.targetKey).replace(/[\\/]+$/, '')
            if (allInfos[target.targetKey] !== undefined) return allInfos[target.targetKey]
            if (directories.has(key)) return { type: 'directory' }
            return files[target.targetKey] === undefined ? undefined : { type: 'file' }
          },
          async readText(target) { return files[target.targetKey] ?? '' },
          async writeText(target, content) { files[target.targetKey] = content; return { operation: 'update', version: 'v', before: null, after: content } },
        }
      }
      if (name === 'workspaceRegistry') return { list: () => entries }
      if (name === 'sessions') return sessions
      return undefined
    },
  }
}

/** DSH 自带 Python 就绪时主 agent 那个依赖函数会回的形状。 */
function healthyPython(patch = {}) {
  return {
    ok: true, state: 'ok', path: '/opt/dsh/python/bin/python3', versionText: '3.12.3',
    distributions: { openpyxl: '3.1.2', 'python-docx': '1.1.2', pandas: '2.2.2' },
    missingPackages: [], error: '', source: 'DSH 自带（bundled runtime）',
    ...patch,
  }
}

/** 全部就绪：插件包完整、DSH 运行时正常、氚云/钉钉已登录、OSS 可用、iFinD 配好、工作空间选定。 */
function healthyContext(patch = {}) {
  return makeCtx({
    shellLines: {
      'h3yun session status': { stdout: JSON.stringify({ data: { userId: 'u1', expiresAt: '2099-01-01T00:00:00Z' } }) },
      'dws auth status': { stdout: JSON.stringify({ authenticated: true }) },
      ' ls ': { stdout: 'oss://bkt/obj\n' },
    },
    dirs: ['/cases/space'],
    entries: [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }],
    files: {
      '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{"auth_token":"token-123456"}',
      '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}',
    },
    ...patch,
  })
}

function depsOf(ctx, patch = {}) {
  const state = createWorkbenchState({ ...CONFIG, ...(patch.config ?? {}) })
  Object.assign(state, patch.state ?? {})
  return {
    deps: {
      ctx, config: { ...CONFIG, ...(patch.config ?? {}) }, state,
      home: patch.home ?? '/Users/x', platform: patch.platform ?? 'darwin-arm64',
      sessionRoot: async () => '/cases/session',
      // DSH 自带 Python 的解析：主 agent 接线后才会传。缺省给一个就绪的替身；
      // 显式传 `null` 表示「宿主还没接线」，用来验 capability gap。
      ...(patch.pythonRuntime === null
        ? {}
        : { pythonRuntime: patch.pythonRuntime ?? (async () => healthyPython()) }),
      // 「我是谁」的来源：只有传了才会有 me（见身份那条用例）。
      ...(patch.identity === undefined ? {} : { identity: patch.identity }),
    },
    state,
  }
}

test('a healthy environment reports allOk with nothing blocked', async () => {
  const ctx = healthyContext()
  const { deps, state } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})

  assert.equal(result.ok, true)
  assert.equal(result.allOk, true, `不该有 blocked，实际：${result.blocked.join(' / ')}`)
  assert.deepEqual(result.blocked, [])
  assert.equal(result.platform, 'darwin-arm64')
  assert.equal(result.configSource, CONFIG.configSource, '故障对账看的就是这份部署配置来源')
  // 自检顺手把注册表恢复了，并把工作空间采用了。
  assert.equal(state.registryLoaded, true)
  assert.equal(state.workspaceChosen, true)
  assert.equal(state.workspacePath, '/cases/space')
  assert.equal(result.workspace.chosen, true)

  // 六块分区各就各位：插件包 / 运行时 / 授权（氚云+钉钉）/ 交付（OSS）/ 外部（iFinD）/ 工作空间。
  assert.equal(result.packageIntegrity.ok, true)
  assert.deepEqual(result.packageIntegrity.tools.map((tool) => tool.name), ['crwu', 'dws', 'ossutil'])
  assert.equal(result.runtime.ok, true)
  assert.equal(result.runtime.source, 'DSH 自带（bundled runtime）')
  assert.deepEqual(result.services.map((service) => service.id), ['h3yun', 'dingtalk'])
  assert.equal(result.services[0].state, '正常')
  assert.equal(result.services[1].state, '已登录')
  assert.equal(result.delivery.probe.state, 'AK 正常')
  assert.equal(result.delivery.oss.bucket, 'bkt')
  assert.equal(result.delivery.oss.ossutilReady, true)
  assert.equal(result.delivery.ossCred.exists, false)
  assert.equal(result.external.ok, true)
  // 旧的混装字段彻底消失：留着就说明还有一层「PATH 命令」的口径。
  assert.equal('checks' in result, false)
  assert.equal('oss' in result, false)
  assert.equal('ifindKey' in result, false)
})

test('自检不执行 command -v python3，也不拿 /usr/bin/python3 当就绪依据', async () => {
  // 替身**故意**让 PATH 与系统 python3 都「可用」：只要实现还去看它们，这条就会翻。
  const ctx = healthyContext({
    shellLines: {
      'command -v': { stdout: '/usr/bin/python3\n' },
      '/usr/bin/python3 --version': { stdout: 'Python 3.12.0\n' },
      'h3yun session status': { stdout: JSON.stringify({ data: { expiresAt: '2099-01-01T00:00:00Z' } }) },
      'dws auth status': { stdout: JSON.stringify({ authenticated: true }) },
      ' ls ': { stdout: 'ok\n' },
    },
  })
  // 不传 pythonRuntime：宿主还没接线 → 必须是能力缺口，不是「系统没装 python3」。
  const { deps } = depsOf(ctx, { pythonRuntime: null })
  const result = await loadEnvironment(deps, {})

  const commands = ctx.specs.map((spec) => spec.command).join('\n')
  assert.equal(commands.includes('command -v'), false, `不该跑 command -v：${commands}`)
  assert.equal(commands.includes('python3'), false, `不该跑任何 python3 命令：${commands}`)
  assert.equal(result.runtime.state, 'capability-gap')
  assert.equal(result.runtime.ok, false)
  assert.equal(JSON.stringify(result.runtime).includes('/usr/bin/python3'), false, '系统 python3 不能成为就绪依据')
  assert.equal(JSON.stringify(result.runtime).includes('未安装'), false, 'capability gap 不能说成「未安装」')
  assert.ok(result.blocked.includes('DSH 脚本运行时'), '运行时不可用要如实阻塞')
})

test('不对 dws 执行 version（会在二进制旁落 .dws/ 运行残留，pack:assert 会判成运行残留）', async () => {
  const ctx = healthyContext()
  const { deps } = depsOf(ctx)
  await loadEnvironment(deps, {})

  assert.equal(ctx.specs.length > 0, true, '自检本来就该问氚云/钉钉登录态')
  for (const spec of ctx.specs) {
    assert.equal(spec.command.includes('dws version'), false, `不该执行 dws version：${spec.command}`)
    assert.equal(/\bversion\b/.test(spec.command), false, `内置组件一律不问版本：${spec.command}`)
  }
})

test('DSH Python 缺失 → capability gap，并给出「不需要装系统 Python」的处置', async () => {
  const ctx = healthyContext()
  const { deps } = depsOf(ctx, {
    pythonRuntime: async () => healthyPython({
      ok: false, state: 'capability-gap', path: '', versionText: '', distributions: {},
      error: 'DSH 自带 Python 运行时不可用（bundled runtime 缺失）',
    }),
  })
  const result = await loadEnvironment(deps, {})

  assert.equal(result.runtime.ok, false)
  assert.equal(result.runtime.state, 'capability-gap')
  assert.match(result.runtime.error, /capability|缺失|不可用/)
  assert.equal(result.runtime.source, 'DSH 自带（bundled runtime）')
  assert.equal(result.blocked.filter((item) => item === 'DSH 脚本运行时').length, 1, '运行时只算一个故障')
  assert.equal(result.allOk, false)
})

test('openpyxl 缺失 → missing-package，点名缺哪个包，且只算一个运行时故障', async () => {
  const ctx = healthyContext()
  const { deps } = depsOf(ctx, {
    pythonRuntime: async () => healthyPython({ ok: false, state: 'missing-package', missingPackages: ['openpyxl'], error: '' }),
  })
  const result = await loadEnvironment(deps, {})

  assert.equal(result.runtime.ok, false)
  assert.equal(result.runtime.state, 'missing-package')
  assert.deepEqual(result.runtime.missingPackages, ['openpyxl'])
  assert.match(result.runtime.error, /openpyxl/, 'Host 侧也要把缺的包名说出来')
  assert.equal(result.blocked.filter((item) => item === 'DSH 脚本运行时').length, 1)
})

test('运行时解析抛错时如实报 failed，而不是假装就绪', async () => {
  const ctx = healthyContext()
  const { deps } = depsOf(ctx, { pythonRuntime: async () => { throw new Error('boom') } })
  const result = await loadEnvironment(deps, {})
  assert.equal(result.runtime.ok, false)
  assert.equal(result.runtime.state, 'failed')
  assert.match(result.runtime.error, /boom/)
})

test('env 的 refresh 参数原样转给运行时解析（由界面「重新自检」传）', async () => {
  const ctx = healthyContext()
  const calls = []
  const { deps } = depsOf(ctx, { pythonRuntime: async (options) => { calls.push(options); return healthyPython() } })
  await loadEnvironment(deps, { refresh: true })
  await loadEnvironment(deps, {})
  assert.deepEqual(calls, [{ refresh: true }, { refresh: false }])
})

test('插件包不完整只贡献一个阻塞项：三件组件不各占一项', async () => {
  // 包内文件一个都没有（未装配 / 安装不完整），但清单文件在。
  const ctx = healthyContext({ packaged: false })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})

  assert.equal(result.packageIntegrity.ok, false)
  const pluginBlockers = result.blocked.filter((item) => item.includes('插件内置组件'))
  assert.equal(pluginBlockers.length, 1, `插件故障只能算一项，实际：${result.blocked.join(' / ')}`)
  for (const name of ['crwu', 'dws', 'ossutil', 'python3', 'node']) {
    assert.equal(result.blocked.includes(name), false, `${name} 不该再各自占一项`)
  }
  // 包内 ossutil 也因此不可用 → ⑤ 交付那条照旧阻塞（它是独立分区，不是「ossutil 命令」）。
  assert.equal(result.delivery.oss.ossutilReady, false)
  assert.match(result.delivery.probe.state, /插件包不完整|平台不受支持/)
})

test('平台不受支持时：插件包算一个故障，不是三件组件各占一项', async () => {
  const ctx = healthyContext()
  const { deps } = depsOf(ctx, { platform: 'linux-x64' })
  const result = await loadEnvironment(deps, {})
  assert.equal(result.packageIntegrity.supported, false)
  assert.equal(result.blocked.filter((item) => item.includes('插件内置组件')).length, 1)
  assert.equal(result.blocked.includes('运行平台未识别'), false, '识别出来了（linux-x64），只是不受支持')
})

test('a missing workspace blocks everything and is listed first', async () => {
  const lonely = healthyContext({ entries: [] })
  const { deps } = depsOf(lonely)
  const result = await loadEnvironment(deps, {})
  assert.equal(result.allOk, false)
  assert.match(result.blocked[0], /未找到工作空间/)
})

test('「我是谁」跟着自检一起回来：已授权才问一次，未授权 / 没来源就是空姓名', async () => {
  // 用户口径（2026-09-22）：「这个钉钉 cli 环境监测一遍就可以了，不需要每次切换页面都去调，
  // 本质就是从环境信息把这个人的信息拿到」。所以 identity 只由 env 调用，且**只调一次**。
  let calls = 0
  const identity = async () => {
    calls += 1
    return { name: '杨凡宾', org: '中瑞世联资产评估集团有限公司', userId: '142227076626112869', reason: '' }
  }

  // ① 状态文件里 trustCredentials=true（healthyContext 就是这份）→ 姓名进 me。
  const trusted = depsOf(healthyContext(), { identity })
  const withMe = await loadEnvironment(trusted.deps, {})
  assert.deepEqual(withMe.me, { name: '杨凡宾', org: '中瑞世联资产评估集团有限公司', userId: '142227076626112869' })
  assert.equal(calls, 1, '一次自检只问一次')

  // ② 未授权：**一次都不问**（受限沙箱下 dws 会假报「未登录」，问出来的姓名不可信）。
  const untrustedState = createWorkbenchState(CONFIG)
  untrustedState.trustCredentials = false
  const untrustedCtx = healthyContext({
    shellLines: { 'dws auth status': { stdout: '{"authenticated":true}' } },
    files: {
      '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{"auth_token":"token-123456"}',
      // 状态文件里写着未授权：自检会把它读回 state。
      '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":false}',
    },
  })
  const before = calls
  const untrusted = depsOf(untrustedCtx, { identity })
  const noMe = await loadEnvironment(untrusted.deps, {})
  assert.deepEqual(noMe.me, { name: '', org: '', userId: '' })
  assert.equal(calls, before, '未授权不该去读钥匙串')

  // ③ 没有来源（单测直接调 loadEnvironment）→ 三个空串，而不是崩。
  const bare = depsOf(healthyContext())
  assert.deepEqual((await loadEnvironment(bare.deps, {})).me, { name: '', org: '', userId: '' })
})

test('an unidentified platform is blocked instead of silently picking a wrong package', async () => {
  const { deps } = depsOf(healthyContext(), { platform: '' })
  const result = await loadEnvironment(deps, {})
  assert.equal(result.allOk, false)
  assert.ok(result.blocked.includes('运行平台未识别'))
})

test('a sandbox that cannot run commands is reported as 探测失败, never as 未安装', async () => {
  // 真实事故（第 26 轮，真实 DSH 上）：这台机器的沙箱后端不可用（进程本身已在沙箱内，
  // `sandbox-exec` 无法套娃），所有 shell 调用直接报 SANDBOX_UNAVAILABLE。
  // 旧实现在这台机器上对 node / python3 / dws 报「未安装」—— 人会去装已经装好的东西。
  const ctx = healthyContext({ shellDown: ['h3yun session status', 'dws auth status', ' ls '] })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})

  // 插件包完整性只 stat 文件、不跑命令，所以沙箱挂了它照样能给出真结论。
  assert.equal(result.packageIntegrity.ok, true)
  assert.equal(result.packageIntegrity.tools.every((tool) => tool.ok), true)
  assert.equal(JSON.stringify(result.packageIntegrity).includes('未安装'), false, '组件不许被误报成「未安装」')

  // 服务：状态是「探测失败」，detail 里带真实原因（不是「未绑定 / 未知」）。
  const h3yun = result.services.find((service) => service.id === 'h3yun')
  const dingtalk = result.services.find((service) => service.id === 'dingtalk')
  assert.equal(h3yun.state, '探测失败')
  assert.match(h3yun.detail, /no sandbox backend is usable/)
  // 钉钉：已授权、但命令压根没跑起来 → 如实报「读本机凭据被拦住」（不是「未登录」），
  // 并且**照旧阻塞**：读不到凭据 = 审核链路真的走不通，不能放人进去。
  assert.equal(dingtalk.state, '本机凭据读取被拦住')
  assert.match(dingtalk.detail, /no sandbox backend is usable/)
  assert.ok(result.blocked.includes('钉钉认证'))

  // OSS 实测：命令没跑起来是「无法探测」，不能判成「AK 无效」。
  assert.equal(result.delivery.probe.state, '无法探测')
  assert.match(result.delivery.probe.detail, /no sandbox backend is usable/)
})

test('a missing packaged ossutil does not block as 「ossutil 未安装」 but as 插件包不完整', async () => {
  const ctx = healthyContext({ packaged: false })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})
  assert.match(result.delivery.probe.state, /插件包不完整|平台不受支持/)
  assert.doesNotMatch(result.delivery.probe.detail, /请先安装/)
  assert.equal(result.delivery.oss.ossutilReady, false)
  assert.equal(result.delivery.oss.ossutilPath, '')
})

test('a logged-out service is blocked by its label, and a missing iFinD key too', async () => {
  const ctx = healthyContext({
    shellLines: {
      // 氚云没绑定、钉钉没登录
      'h3yun session status': { exitCode: 1, stderr: 'no session' },
      'dws auth status': { stdout: JSON.stringify({ authenticated: false }) },
      ' ls ': { stdout: 'ok\n' },
    },
    files: { '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}' },
  })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})
  assert.ok(result.blocked.includes('氚云（H3Yun）员工会话'))
  assert.ok(result.blocked.includes('iFinD 密钥'))
  assert.equal(result.services[0].state, '未绑定')
  // 钉钉这条命令现在**自己带无沙箱权限**去问（员工零配置），所以它回的 `authenticated:false`
  // 是真答案 → 如实报「未登录」并计入阻塞。谎报只可能出现在「命令没跑起来」那条路径。
  assert.equal(result.services[1].state, '未登录')
  assert.equal(result.services[1].required, true)
  assert.ok(result.blocked.includes('钉钉认证'), '确认没登录就要拦')
})

test('an expired h3yun session is reported as expired and blocked', async () => {
  const ctx = healthyContext({
    shellLines: {
      'h3yun session status': { stdout: JSON.stringify({ data: { userId: 'u', expiresAt: '2000-01-01T00:00:00Z' } }) },
      'dws auth status': { stdout: JSON.stringify({ authenticated: true }) },
      ' ls ': { stdout: 'ok\n' },
    },
  })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})
  assert.equal(result.services[0].state, '已过期')
  assert.equal(result.services[0].ok, false)
  assert.ok(result.blocked.includes('氚云（H3Yun）员工会话'))
})

test('request arguments cannot replace the configured manifest and protected OSS config wins', async () => {
  const ctx = healthyContext()
  const { deps, state } = depsOf(ctx, { config: {
    ossBucket: 'private-bucket',
    ossPrefix: 'private/audit',
    ossEndpoint: 'oss-cn-test.aliyuncs.com',
    ossBaseUrl: 'https://private-bucket.oss-cn-test.aliyuncs.com',
    ossLinkTtlSeconds: 7200,
    autoUpload: false,
  } })
  const result = await loadEnvironment(deps, { source: 'https://other.invalid/m.json' })
  assert.equal(state.manifest.oss.bucket, 'private-bucket')
  assert.equal(state.manifest.oss.prefix, 'private/audit')
  assert.equal(state.manifest.oss.endpoint, 'oss-cn-test.aliyuncs.com')
  assert.equal(state.manifest.oss.publicBaseUrl, 'https://private-bucket.oss-cn-test.aliyuncs.com')
  assert.equal(state.manifest.oss.linkTtl, 7200)
  assert.equal(state.manifest.oss.autoUpload, false)
  assert.equal(state.manifest.oss.probeCommand, '', '远程清单不能向宿主注入探测命令')
  assert.equal(result.delivery.oss.bucket, 'private-bucket')
})

test('the trust flag is echoed so the panel can render the switch state', async () => {
  const { deps } = depsOf(healthyContext(), { state: { trustCredentials: true } })
  const result = await loadEnvironment(deps, {})
  assert.deepEqual(result.trust, { credentials: true })
  assert.equal(DEFAULT_MANIFEST.workspace.preferTitle, '中瑞世联工作空间')
})

test('钉钉探测：未授权就说需要授权（绝不谎报未登录）；授权后带无沙箱策略去拿真结论', async () => {
  const ctx = healthyContext()
  const specs = []
  // `makeCtx` 的 `get('shell')` 每次都新建一个对象，所以要包 `get` 本身，而不是改返回值的属性。
  const originalGet = ctx.get
  ctx.get = (name) => {
    const value = originalGet(name)
    if (name !== 'shell' || value === undefined) return value
    const inner = value.execute
    return {
      ...value,
      execute: async (spec) => {
        specs.push(spec)
        return inner(spec)
      },
    }
  }

  // ① 未授权：**不去猜**登录态（沙箱里读钥匙串只会得到假的「未登录」），直接报「需要授权」，
  //    授权项进 blocked（硬门禁），dws 探测压根不发。
  const unauthorized = await loadEnvironment(depsOf(makeUnauthorizedCtx())[0] ?? depsOf(makeUnauthorizedCtx()).deps, {})
  const dingtalk = unauthorized.services.find((service) => service.id === 'dingtalk')
  assert.equal(dingtalk.state, '需要授权')
  assert.equal(dingtalk.ok, false)
  assert.ok(unauthorized.blocked.includes('授权读取本机凭据（氚云 / 钉钉）'), '未授权必须是阻塞项')
  assert.equal(makeUnauthorizedSpecs().some((spec) => String(spec.command).includes('dws auth status')), false, '未授权不该去问 dws')

  // ② 已授权：凭据类命令自己声明无沙箱权限 → 拿到真结论（这里 fixture 回 authenticated:true）。
  const { deps } = depsOf(ctx, { state: { trustCredentials: true } })
  const result = await loadEnvironment(deps, {})
  const dwsSpec = specs.find((spec) => String(spec.command).includes('dws auth status'))
  assert.ok(dwsSpec, '授权后应当问过 dws auth status')
  // 这条断言就是缺陷复现：去掉 escalate 时它立刻变红。
  assert.equal(dwsSpec.sandboxPolicy?.mode, 'danger-full-access', '读钥匙串的命令必须声明无沙箱（钥匙串在沙箱外）')
  assert.equal(result.services.find((service) => service.id === 'dingtalk').ok, true)
  assert.equal(result.blocked.includes('授权读取本机凭据（氚云 / 钉钉）'), false, '授权后授权项消失')
  // 反向护栏：插件包核对与 OSS 实测这类命令**不能**跟着提权（能给最小权限就给最小）。
  const ossSpec = specs.find((spec) => String(spec.command).includes(' ls '))
  assert.ok(ossSpec, '应当实测过一次 OSS')
  assert.equal(ossSpec.sandboxPolicy, undefined, 'OSS 实测不需要无沙箱')
})

/** 未授权的 ctx（配置文件里没有授权标记）+ 记录它发出的 shell 请求。 */
function makeUnauthorizedCtx() {
  const specs = []
  const ctx = healthyContext()
  ctx.get = ((original) => (name) => {
    const value = original(name)
    if (name !== 'shell' || value === undefined) {
      if (name === 'fs' && value !== undefined) {
        return {
          ...value,
          async readText() { return '{}' },
        }
      }
      return value
    }
    const inner = value.execute
    return { ...value, execute: async (spec) => { specs.push(spec); return inner(spec) } }
  })(ctx.get)
  makeUnauthorizedSpecs.specs = specs
  return ctx
}
function makeUnauthorizedSpecs() { return makeUnauthorizedSpecs.specs ?? [] }
makeUnauthorizedSpecs.specs = []

test('信任本机凭据后确实没登录，仍然如实报未登录并阻塞', async () => {
  const ctx = healthyContext({
    shellLines: {
      'h3yun session status': { stdout: JSON.stringify({ data: { userId: 'u1', expiresAt: '2099-01-01T00:00:00Z' } }) },
      'dws auth status': { stdout: JSON.stringify({ authenticated: false, message: '未登录' }) },
      ' ls ': { stdout: 'ok\n' },
    },
    files: {
      '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{"auth_token":"t"}',
      '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}',
    },
  })
  const { deps } = depsOf(ctx, { state: { trustCredentials: true } })
  const result = await loadEnvironment(deps, {})

  const dingtalk = result.services.find((service) => service.id === 'dingtalk')
  assert.equal(dingtalk.state, '未登录')
  assert.equal(dingtalk.required, true)
  assert.ok(result.blocked.includes('钉钉认证'), '确认过没登录就要拦')
})
