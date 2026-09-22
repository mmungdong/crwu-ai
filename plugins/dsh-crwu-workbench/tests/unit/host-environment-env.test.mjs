/**
 * 环境自检聚合（`env` 操作）的单元测试。
 *
 * 这是面板的入口页，也是所有后续操作的硬门禁。最需要防的是「假绿」：
 * blocked 为空但用户其实干不了活（缺工作空间、平台没识别、清单没拉到）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { loadEnvironment } = await import(new URL('src/host/environment/ops.ts', ROOT).href)
const { DEFAULT_MANIFEST } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)

const CONFIG = {
  caseRoot: '', formName: '报告审核', installDocUrl: 'https://doc.invalid/install.md', manifestUrl: 'https://x.invalid/m.json',
  preferWorkspaceTitle: '中瑞世联工作空间', ossBucket: '', ossPrefix: '', ossEndpoint: '', ossBaseUrl: '',
  ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true, requireTopLevelParent: true,
}

/** 沙箱后端不可用时 DSH 抛出的那条原文（真实环境逐字抄回，不是编的）。 */
const SANDBOX_DOWN = 'sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined.'

const MANIFEST_JSON = JSON.stringify({
  binaries: [
    { name: 'node', command: 'node', versionArgs: ['--version'], expect: '>=16.7', required: true },
    { name: 'ossutil', command: 'ossutil', versionArgs: ['--version'], required: true, platforms: { 'darwin-arm64': { url: 'https://dl/ossutil.zip', sha256: 'a'.repeat(64), target: '~/bin/ossutil', archive: 'zip', member: 'ossutil' } } },
  ],
  services: [{ id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true }, { id: 'dingtalk', label: '钉钉认证', required: true }, { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true }],
  oss: { enabled: true, bucket: 'bkt', prefix: 'crwu/audit', linkMode: 'signed', linkTtl: 3600, autoUpload: true },
  ifindKey: { required: true, path: '~/.agents/skills/ifind-finance-data/mcp_config.json', field: 'auth_token' },
  workspace: { preferTitle: '中瑞世联工作空间', preferPath: '' },
})

/**
 * 一个 ctx：shell 按命令回放，fs 同时提供目录与文件，workspaceRegistry/sessions 可选。
 */
function makeCtx({ shellLines = {}, shellDown = [], dirs = [], files = {}, entries = [], sessions } = {}) {
  const directories = new Set(dirs)
  return {
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async run(spec) {
            // `shellDown` 里的 needle 命中时**抛错**：DSH 契约里 `run` 只为基础设施故障 reject，
            // 沙箱后端不可用就长这样（真实环境逐字抄回的那条错误）。
            for (const needle of shellDown) {
              if (spec.command.includes(needle)) throw new Error(SANDBOX_DOWN)
            }
            for (const [needle, out] of Object.entries(shellLines)) {
              if (spec.command.includes(needle)) {
                return {
                  exitCode: out.exitCode ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                  stdout: { text: out.stdout ?? '', truncated: false },
                  stderr: { text: out.stderr ?? '', truncated: false },
                }
              }
            }
            return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) {
            const key = String(target.targetKey).replace(/[\\/]+$/, '')
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

/** 全部就绪：清单拉得到、二进制齐、氚云/钉钉已登录、OSS 可用、iFinD 配好、工作空间选定。 */
function healthyContext() {
  return makeCtx({
    shellLines: {
      'curl': { stdout: MANIFEST_JSON },
      'for b in': { stdout: 'node\t/usr/local/bin/node\nossutil\t/usr/local/bin/ossutil\n' },
      '/usr/local/bin/node --version': { stdout: 'v22.19.0\n' },
      '/usr/local/bin/ossutil --version': { stdout: 'Version: 1.7.19\n' },
      'h3yun session status': { stdout: JSON.stringify({ data: { userId: 'u1', expiresAt: '2099-01-01T00:00:00Z' } }) },
      'dws auth status': { stdout: JSON.stringify({ authenticated: true }) },
      'command -v': { stdout: '/usr/local/bin/ossutil\n' },
      ' ls ': { stdout: 'oss://bkt/obj\n' },
    },
    dirs: ['/cases/space'],
    entries: [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }],
    files: {
      '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{"auth_token":"token-123456"}',
      '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}',
    },
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
      // 「我是谁」的来源：只有传了才会有 me（见文件末尾那条用例）。
      ...(patch.identity === undefined ? {} : { identity: patch.identity }),
    },
    state,
  }
}

test('a healthy environment reports allOk with nothing blocked', async () => {
  const { deps, state } = depsOf(healthyContext())
  const result = await loadEnvironment(deps, {})

  assert.equal(result.ok, true)
  assert.equal(result.allOk, true, `不该有 blocked，实际：${result.blocked.join(' / ')}`)
  assert.deepEqual(result.blocked, [])
  assert.equal(result.platform, 'darwin-arm64')
  assert.equal(result.manifestLoaded, true)
  assert.equal(result.manifestKind, 'url')
  // 自检顺手把注册表恢复了，并把工作空间采用了。
  assert.equal(state.registryLoaded, true)
  assert.equal(state.workspaceChosen, true)
  assert.equal(state.workspacePath, '/cases/space')
  assert.equal(result.workspace.chosen, true)
  // 氚云/钉钉/OSS 三项服务都在，且都有明确状态。
  assert.deepEqual(result.services.map((service) => service.id), ['h3yun', 'dingtalk', 'oss'])
  assert.equal(result.services[0].state, '正常')
  assert.equal(result.services[1].state, '已登录')
  assert.equal(result.services[2].state, 'AK 正常')
  assert.equal(result.ifindKey.ok, true)
  assert.equal(result.ossCred.exists, false)
  assert.equal(result.oss.ossutilReady, true)
})

test('a missing workspace blocks everything and is listed first', async () => {
  const ctx = healthyContext()
  // 注册表里没有命中清单偏好的工作空间。
  const lonely = makeCtx({
    shellLines: {
      'curl': { stdout: MANIFEST_JSON },
      'for b in': { stdout: 'node\t/usr/local/bin/node\nossutil\t/usr/local/bin/ossutil\n' },
      '/usr/local/bin/node --version': { stdout: 'v22.19.0\n' },
      '/usr/local/bin/ossutil --version': { stdout: 'Version: 1.7.19\n' },
      'h3yun session status': { stdout: JSON.stringify({ data: { expiresAt: '2099-01-01T00:00:00Z' } }) },
      'dws auth status': { stdout: JSON.stringify({ authenticated: true }) },
      'command -v': { stdout: '/usr/local/bin/ossutil\n' },
      ' ls ': { stdout: 'ok\n' },
    },
    files: {
      '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{"auth_token":"t"}',
      '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}',
    },
  })
  void ctx
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
  const untrustedCtx = makeCtx({
    shellLines: { 'dws auth status': { stdout: '{"authenticated":true}' } },
    dirs: ['/cases/space'],
    entries: [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }],
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

test('a missing binary is blocked by name', async () => {
  const ctx = makeCtx({
    shellLines: {
      'curl': { stdout: MANIFEST_JSON },
      // 只找到 node，ossutil 既不在 PATH 也没有安装目标。
      'for b in': { stdout: 'node\t/usr/local/bin/node\n' },
      '/usr/local/bin/node --version': { stdout: 'v22.19.0\n' },
      'h3yun session status': { stdout: JSON.stringify({ data: { expiresAt: '2099-01-01T00:00:00Z' } }) },
      'dws auth status': { stdout: JSON.stringify({ authenticated: true }) },
      'command -v': { stdout: '' },
      ' ls ': { stdout: '' },
    },
    dirs: ['/cases/space'],
    entries: [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }],
    files: { '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{"auth_token":"t"}', '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}' },
  })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})
  assert.ok(result.blocked.includes('ossutil'))
})

test('a sandbox that cannot run commands is reported as 探测失败, never as 未安装', async () => {
  // 真实事故（第 26 轮，真实 DSH 上）：这台机器的沙箱后端不可用（进程本身已在沙箱内，
  // `sandbox-exec` 无法套娃），所有 shell 调用直接报 SANDBOX_UNAVAILABLE。
  // 旧实现在这台机器上对 node / python3 / dws 报「未安装」—— 人会去装已经装好的东西。
  const ctx = makeCtx({
    shellLines: { 'curl': { stdout: MANIFEST_JSON } },
    shellDown: ['for b in', 'h3yun session status', 'dws auth status', 'command -v'],
    dirs: ['/cases/space'],
    entries: [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }],
    files: { '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}' },
  })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})

  // 二进制：一条都不能说「未安装」。
  assert.equal(result.checks.length > 0, true)
  for (const check of result.checks) {
    assert.notEqual(check.reason, '未安装', `${check.name} 被误报成未安装`)
    assert.match(check.reason, /^无法探测：/)
  }

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

  // OSS：不能报「ossutil 未安装」。
  const oss = result.services.find((service) => service.id === 'oss')
  assert.equal(oss.state, '无法探测')
})

test('a logged-out service is blocked by its label, and a missing iFinD key too', async () => {
  const ctx = makeCtx({
    shellLines: {
      'curl': { stdout: MANIFEST_JSON },
      'for b in': { stdout: 'node\t/usr/local/bin/node\nossutil\t/usr/local/bin/ossutil\n' },
      '/usr/local/bin/node --version': { stdout: 'v22.19.0\n' },
      '/usr/local/bin/ossutil --version': { stdout: 'Version: 1.7.19\n' },
      // 氚云没绑定、钉钉没登录
      'h3yun session status': { exitCode: 1, stderr: 'no session' },
      'dws auth status': { stdout: JSON.stringify({ authenticated: false }) },
      'command -v': { stdout: '/usr/local/bin/ossutil\n' },
      ' ls ': { stdout: 'ok\n' },
    },
    dirs: ['/cases/space'],
    entries: [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }],
    files: { '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}' },
  })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})
  assert.ok(result.blocked.includes('氚云（H3Yun）员工会话'))
  assert.ok(result.blocked.includes('iFinD 密钥'))
  assert.equal(result.services[0].state, '未绑定')
  // 钉钉这条命令现在**自己带无沙箱权限**去问（员工零配置），所以它回的 `authenticated:false`
  // 是真答案 → 如实报「未登录」并计入阻塞。谎报只可能出现在「命令没跑起来」那条路径
  // （见上一条测试：那种情况报「本机凭据读取被拦住」，不阻塞）。
  assert.equal(result.services[1].state, '未登录')
  assert.equal(result.services[1].required, true)
  assert.ok(result.blocked.includes('钉钉认证'), '确认没登录就要拦')
})

test('an expired h3yun session is reported as expired and blocked', async () => {
  const ctx = makeCtx({
    shellLines: {
      'curl': { stdout: MANIFEST_JSON },
      'for b in': { stdout: 'node\t/n\nossutil\t/o\n' },
      '/n --version': { stdout: 'v22.0.0\n' },
      '/o --version': { stdout: 'Version: 1.7.19\n' },
      'h3yun session status': { stdout: JSON.stringify({ data: { userId: 'u', expiresAt: '2000-01-01T00:00:00Z' } }) },
      'dws auth status': { stdout: JSON.stringify({ authenticated: true }) },
      'command -v': { stdout: '/o\n' },
      ' ls ': { stdout: 'ok\n' },
    },
    dirs: ['/cases/space'],
    entries: [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }],
    files: { '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{"auth_token":"t"}', '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}' },
  })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})
  assert.equal(result.services[0].state, '已过期')
  assert.equal(result.services[0].ok, false)
  assert.ok(result.blocked.includes('氚云（H3Yun）员工会话'))
})

test('a failed manifest fetch is surfaced with its reason while the page still renders', async () => {
  const ctx = makeCtx({
    shellLines: {
      'curl': { exitCode: 22, stderr: 'curl: (22) 404' },
      'for b in': { stdout: '' },
      'h3yun session status': { exitCode: 1, stderr: 'no session' },
      'dws auth status': { stdout: '' },
      'command -v': { stdout: '' },
    },
    files: { '/Users/x/.dsh/crwu-workbench.json': '{"trustCredentials":true}' },
  })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})
  assert.equal(result.ok, true, '清单拉不到也要能渲染页面')
  assert.equal(result.manifestLoaded, false)
  assert.match(result.manifestError, /404/)
  assert.equal(result.manifestSource, 'https://x.invalid/m.json')
  // 回退到内置清单后，blocked 里必须出现内置清单要求的那些二进制。
  assert.ok(result.blocked.includes('crwu'))
  assert.ok(result.blocked.includes('dws'))
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
  assert.equal(result.manifestSource, 'https://x.invalid/m.json')
  assert.equal(state.manifest.oss.bucket, 'private-bucket')
  assert.equal(state.manifest.oss.prefix, 'private/audit')
  assert.equal(state.manifest.oss.endpoint, 'oss-cn-test.aliyuncs.com')
  assert.equal(state.manifest.oss.publicBaseUrl, 'https://private-bucket.oss-cn-test.aliyuncs.com')
  assert.equal(state.manifest.oss.linkTtl, 7200)
  assert.equal(state.manifest.oss.autoUpload, false)
  assert.equal(state.manifest.oss.probeCommand, '', '远程清单不能向宿主注入探测命令')
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
    const inner = value.run
    return {
      ...value,
      run: async (spec) => {
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
  // 反向护栏：探二进制/版本这类命令**不能**跟着提权（能给最小权限就给最小）。
  const versionSpec = specs.find((spec) => String(spec.command).includes('--version'))
  assert.ok(versionSpec, '应当探过二进制版本')
  assert.equal(versionSpec.sandboxPolicy, undefined, '探版本不需要无沙箱')
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
    const inner = value.run
    return { ...value, run: async (spec) => { specs.push(spec); return inner(spec) } }
  })(ctx.get)
  makeUnauthorizedSpecs.specs = specs
  return ctx
}
function makeUnauthorizedSpecs() { return makeUnauthorizedSpecs.specs ?? [] }
makeUnauthorizedSpecs.specs = []

test('信任本机凭据后确实没登录，仍然如实报未登录并阻塞', async () => {
  const ctx = makeCtx({
    shellLines: {
      'curl': { stdout: MANIFEST_JSON },
      'for b in': { stdout: 'node\t/n\nossutil\t/o\n' },
      '/n --version': { stdout: 'v22.19.0\n' },
      '/o --version': { stdout: 'Version: 1.7.19\n' },
      'h3yun session status': { stdout: JSON.stringify({ data: { userId: 'u1', expiresAt: '2099-01-01T00:00:00Z' } }) },
      'dws auth status': { stdout: JSON.stringify({ authenticated: false, message: '未登录' }) },
      'command -v': { stdout: '/o\n' },
      ' ls ': { stdout: 'ok\n' },
    },
    dirs: ['/cases/space'],
    entries: [{ id: 'w1', path: '/cases/space', title: '中瑞世联工作空间' }],
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
