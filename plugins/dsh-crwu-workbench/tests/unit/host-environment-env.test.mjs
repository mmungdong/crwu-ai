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
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)

const { loadEnvironment } = await import(new URL('src/host/environment/ops.ts', ROOT).href)
const { DEFAULT_MANIFEST } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)
const { packageIntegrityPaths } = await import(new URL('src/host/environment/probe.ts', ROOT).href)
const { bundledBinaryPath } = await import(new URL('src/host/platform/bin-dir.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)
const { ifindCredentialPath } = await import(new URL('src/host/ifind/store.ts', ROOT).href)
const { makeIfindTransport } = await import(new URL('tests/helpers/ifind-fixture.mjs', ROOT).href)
const { consentConfigJson, grantedConsent, missingConsent } = await import(new URL('tests/helpers/local-access-fixture.mjs', ROOT).href)
const { LOCAL_ACCESS_REQUIRED_REASON } = await import(new URL('src/shared/access/types.ts', ROOT).href)
const zhCNConsentReason = LOCAL_ACCESS_REQUIRED_REASON

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
      // OSS AK 与 iFinD SK 都落在**员工自己的**凭据/状态文件里（不是技能目录、不是插件包）。
      '/Users/x/.ossutilconfig': '[Credentials]\nlanguage=CH\naccessKeyID=AKID12345678\naccessKeySecret=SECRET\n',
      [ifindCredentialPath('/Users/x')]: JSON.stringify({
        auth_token: 'ifind-token-123456',
        verification: {
          ok: true, state: 'authenticated', errorKind: '', error: '', toolCount: 1,
          toolNames: ['get_stock_summary'], protocolVersion: '2026-09',
          checkedAt: '2026-09-29T00:00:00.000Z', dataVerified: true,
          dataTool: 'get_stock_summary', dataSample: '{"ok":true}',
        },
      }),
      '/Users/x/.dsh/crwu-workbench.json': consentConfigJson(),
    },
    ...patch,
  })
}

function contextWithIfindVerification(verification, patch = {}) {
  return healthyContext({
    ...patch,
    files: {
      '/Users/x/.ossutilconfig': '[Credentials]\nlanguage=CH\naccessKeyID=AKID12345678\naccessKeySecret=SECRET\n',
      [ifindCredentialPath('/Users/x')]: JSON.stringify({ auth_token: 'ifind-token-123456', verification }),
      '/Users/x/.dsh/crwu-workbench.json': consentConfigJson(),
    },
  })
}

function verificationFrom({ ok = true, state = 'authenticated', errorKind = '', error = '', dataVerified = true } = {}) {
  return {
    ok, state, errorKind, error, toolCount: 1, toolNames: ['get_stock_summary'],
    protocolVersion: '2026-09', checkedAt: '2026-09-29T00:00:00.000Z', dataVerified,
    dataTool: dataVerified ? 'get_stock_summary' : '', dataSample: dataVerified ? '{"ok":true}' : '',
  }
}

/**
 * 默认的 iFinD 传输替身：**认证明明是好的、也真的取到数据**。
 *
 * 保存凭据或点击「重新验证」时才会调用它；环境自检只读取已经保存的脱敏结论。
 */
function ifindOkTransport() {
  return makeIfindTransport({ tools: ['get_stock_summary'] })
}

function depsOf(ctx, patch = {}) {
  const state = createWorkbenchState({ ...CONFIG, ...(patch.config ?? {}) })
  Object.assign(state, patch.state ?? {})
  return {
    deps: {
      // 保留 iFinD 手动验证替身；环境自检不会使用它。
      ifindTransport: patch.ifindTransport === null ? undefined : (patch.ifindTransport ?? ifindOkTransport()),
      ctx, config: { ...CONFIG, ...(patch.config ?? {}) }, state,
      // Broker：自检里每一次跨边界的本机访问都由它判（真 Broker，策略走真实代码）。
      access: makeTestAccess(ctx, { state }).access,
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
  // 旧的混装字段彻底消失：留着就说明还有一层「PATH 命令」的口径。
  assert.equal('checks' in result, false)
  assert.equal('oss' in result, false)
  assert.equal('ifindKey' in result, false)
  // OSS AK 与 iFinD API-Key 都配好了，且 iFinD 的**真实取数验证**由替身完成
  // （「已认证」只能由真实探测给出，不许靠"文件在、长度够"推断）。
  assert.equal(result.delivery.ossCred.exists, true)
  assert.equal(result.delivery.ossCred.hasSecret, true)
  // 每次环境校验都**真的取一次数据**：替身回内容 → 认证 + 取数都算过。
  assert.equal(result.external.state, 'authenticated')
  assert.equal(result.external.dataVerified, true, '取到数据才算验证通过')
  assert.equal(result.external.dataTool, 'get_stock_summary')
  // 只有**全部必需项**都通过（含 iFinD 的真实取数验证）才是 ready。
  assert.equal(result.state.status, 'ready')
  assert.equal(result.state.proceed, true)
  assert.equal(result.state.capabilities.auditCore, true)
  assert.equal(result.state.capabilities.delivery, true)
  assert.equal(result.state.capabilities.externalData, true)
  assert.equal(result.state.total, result.state.passed, '通过率只统计必需项，必须自洽')
  assert.equal(result.state.total, 9,
    '必需项 = 包 / 运行时 / 平台 / 工作空间 / 授权 / 氚云 / 钉钉 / OSS / iFinD（iFinD 自 2026-09-26 起必检）')
})

test('iFinD 是必检项：未配置即阻塞，且不是 degraded（2026-09-26 口径）', async () => {
  // 同一套"其它全部健康"的夹具，只把 iFinD 凭据文件拿掉。
  const ctx = healthyContext({ files: {
    '/Users/x/.ossutilconfig': '[Credentials]\nlanguage=CH\naccessKeyID=AKID12345678\naccessKeySecret=S\n',
    '/Users/x/.dsh/crwu-workbench.json': consentConfigJson(),
  } })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})

  assert.equal(result.external.state, 'unconfigured')
  assert.equal(result.external.required, true, '清单里 iFinD 必须是必需项')
  assert.equal(result.state.userSetup.ifind.required, true, '事实层必须标记必需')
  // 阻塞，而且**不是** degraded。
  assert.notEqual(result.state.status, 'degraded', '未配置 iFinD 不得只降级放行')
  assert.equal(result.state.status, 'action-required', '员工自己填 API-Key → action-required')
  assert.equal(result.state.proceed, false, '未通过就不得放行需要环境的页面')
  assert.equal(result.blocked.length > 0, true, '必须产生阻塞项')
  // 能力：global / auditCore / externalData 全关（delivery 依赖 auditCore，也一起关）。
  assert.equal(result.state.capabilities.global, false)
  assert.equal(result.state.capabilities.auditCore, false, 'iFinD 未通过不得放行报告审核')
  assert.equal(result.state.capabilities.externalData, false, 'iFinD 未通过即关闭外部数据能力')
  assert.equal(result.state.capabilities.delivery, false)
  // 进必需项分母，且通过率与结论自洽。
  assert.equal(result.state.total, 9, 'iFinD 必须在必需项分母里')
  assert.equal(result.state.passed < result.state.total, true)
  // issue：blocking，归属 user，双 scope（global 拦导航 + external-data 关能力）。
  const ifindIssues = result.state.issues.filter((issue) => issue.id.startsWith('ifind'))
  assert.equal(ifindIssues.length >= 1, true)
  for (const issue of ifindIssues) {
    assert.equal(issue.blocking, true, `${issue.id} 必须是阻塞项`)
    assert.equal(issue.owner, 'user', '未填写 → 员工自己能修')
    assert.notEqual(issue.action, '')
  }
  assert.deepEqual(ifindIssues.map((issue) => issue.scope).sort(), ['external-data', 'global'],
    'global 让统一导航拦回环境页，external-data 让 auditCore 一起关掉')
})

test('iFinD 三类失败分别派给 user / admin / system', async () => {
  const cases = [
    // 认证被拒（401 / 签名错）→ 员工重填
    ['http401', 'user', /重新填写同花顺 iFinD API-Key/],
    // 权益不足（403 / 无可用取数工具）→ 管理员开通
    ['http403', 'admin', /联系管理员开通同花顺 iFinD 数据权益/],
    // 网络 / 超时 / 协议 → 系统侧，员工和管理员都不该去换密钥
    ['protocol', 'system', /稍后重新验证/],
  ]
  for (const [call, owner, action] of cases) {
    const failed = call === 'http401'
      ? verificationFrom({ ok: false, state: 'invalid', errorKind: 'credential', error: 'API-Key 无效', dataVerified: false })
      : call === 'http403'
        ? verificationFrom({ ok: false, state: 'unverified', errorKind: 'entitlement', error: '联系管理员开通同花顺 iFinD 数据权益', dataVerified: false })
        : verificationFrom({ ok: false, state: 'unreachable', errorKind: 'infrastructure', error: '稍后重新验证', dataVerified: false })
    const { deps } = depsOf(contextWithIfindVerification(failed), { ifindTransport: makeIfindTransport({ tools: ['t'], call }) })
    const result = await loadEnvironment(deps, {})
    const issue = result.state.issues.find((item) => item.id === 'ifind')
    assert.equal(issue.blocking, true, call)
    assert.equal(issue.owner, owner, `${call} → ${issue.owner}（${issue.message}）`)
    assert.match(issue.action, action, call)
    assert.equal(result.state.status, owner === 'admin' ? 'admin-required' : (owner === 'system' ? 'system-blocked' : 'action-required'), call)
  }
})

test('iFinD 认证通过但没取到数据：仍然算未通过（不许放行）', async () => {
  const { deps } = depsOf(contextWithIfindVerification(verificationFrom({ dataVerified: false, errorKind: 'entitlement', error: '权益不足' })), { ifindTransport: makeIfindTransport({ tools: ['t'], call: 'isError' }) })
  const result = await loadEnvironment(deps, {})
  assert.equal(result.external.ok, true, '认证确实是过的')
  assert.equal(result.external.dataVerified, false)
  assert.equal(result.state.userSetup.ifind.state, 'unverified')
  assert.equal(result.state.proceed, false, '认证过但取不到数 = 未通过')
  assert.equal(result.state.capabilities.auditCore, false)
})

test('统一环境模型：必需项缺失是 action-required，且归属与处置对得上', async () => {
  // 工作空间没选 + 未授权 + 氚云/钉钉都没登录。
  const ctx = healthyContext({
    entries: [],
    shellLines: {
      'h3yun session status': { exitCode: 1, stderr: 'no session' },
      'dws auth status': { stdout: JSON.stringify({ authenticated: false }) },
      ' ls ': { stdout: 'ok\n' },
    },
    files: {
      '/Users/x/.ossutilconfig': '[Credentials]\nlanguage=CH\naccessKeyID=AKID12345678\naccessKeySecret=S\n',
      '/Users/x/.dsh/crwu-workbench.json': '{}',
    },
  })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})

  assert.equal(result.state.status, 'action-required', '员工自己能修的事 → action-required')
  assert.equal(result.state.proceed, false)
  assert.equal(result.state.capabilities.global, false)
  assert.equal(result.state.capabilities.auditCore, false)
  const owners = new Set(result.state.issues.filter((issue) => issue.blocking).map((issue) => issue.owner))
  assert.deepEqual([...owners], ['user'], '这一组全是员工能修的，不许出现 system / admin')
  for (const issue of result.state.issues.filter((issue) => issue.blocking)) {
    assert.notEqual(issue.action, '', `${issue.id} 必须给一个具体动作`)
  }
  assert.equal(result.state.passed < result.state.total, true)
})

test('统一环境模型：包与运行时故障归 system，页面不派给员工', async () => {
  const ctx = healthyContext({ packaged: false })
  const { deps } = depsOf(ctx, {
    pythonRuntime: async () => healthyPython({ ok: false, state: 'capability-gap', path: '', error: '缺少 bundled runtime' }),
  })
  const result = await loadEnvironment(deps, {})

  assert.equal(result.state.status, 'system-blocked')
  const system = result.state.issues.filter((issue) => issue.blocking && issue.owner === 'system')
  const ids = system.map((issue) => issue.id)
  assert.ok(ids.includes('package'), '包不完整必须是 system')
  assert.ok(ids.includes('runtime'), '运行时不可用必须是 system')
  // 员工**能看见的那两块**（账号连接 / 交付与外部数据）不得提示安装二进制、装系统 Python、改 PATH。
  // 技术细节（包内路径、清单、sha256）本来就在"开发者诊断"里，不受这条约束。
  const employeeVisible = JSON.stringify({
    setup: result.state.userSetup,
    issues: result.state.issues.map((issue) => ({ ...issue, owner: issue.owner })),
  })
  for (const banned of ['请安装', '装 Python', 'export PATH', 'command -v', 'which ', '下载并安装']) {
    assert.equal(employeeVisible.includes(banned), false, `员工可见结论里不得出现「${banned}」：${employeeVisible.slice(0, 400)}`)
  }
})

test('统一环境模型：平台未识别是 system 事实，不是员工任务', async () => {
  const { deps } = depsOf(healthyContext(), { platform: '' })
  const result = await loadEnvironment(deps, {})
  assert.equal(result.state.systemHealth.platform.state, 'invalid')
  assert.equal(result.state.status, 'system-blocked')
  assert.equal(result.state.checkError, '', '平台未识别是具体事实缺失，不是"自检没跑完"')
  const issue = result.state.issues.find((item) => item.id === 'platform')
  assert.equal(issue.owner, 'system')
  assert.equal(issue.blocking, true)
})

test('统一环境模型：OSS 缺 AK 是员工任务，bucket 未配置是管理员任务', async () => {
  // ① bucket 由部署配置提供、AK 由员工填：没填 AK → user。
  const noAk = depsOf(healthyContext({ files: {
    [ifindCredentialPath('/Users/x')]: '{"auth_token":"ifind-token-123456"}',
    '/Users/x/.dsh/crwu-workbench.json': consentConfigJson(),
  } }))
  const first = await loadEnvironment(noAk.deps, {})
  const cred = first.state.issues.find((issue) => issue.id === 'oss-cred')
  assert.equal(cred.owner, 'user')
  assert.equal(cred.blocking, true)
  assert.match(cred.action, /管理员获取|AccessKey/)
  assert.equal(first.state.capabilities.global, false)
  assert.equal(first.state.capabilities.delivery, false)

  // ② 部署配置里没有 bucket → admin，且页面只说"联系管理员"。
  const noBucket = depsOf(healthyContext(), { config: { ossBucket: '' } })
  const second = await loadEnvironment(noBucket.deps, {})
  const config = second.state.issues.find((issue) => issue.id === 'oss-config')
  assert.equal(config.owner, 'admin')
  assert.equal(second.state.status, 'admin-required')
  assert.match(config.action, /管理员/)
})

test('统一环境模型：Tool 未查询时不算必需项，不制造"未就绪"', async () => {
  const { deps } = depsOf(healthyContext())
  const result = await loadEnvironment(deps, {})
  assert.equal(result.state.systemHealth.toolRegistry.state, 'unverified')
  assert.equal(result.state.systemHealth.toolRegistry.required, false)
})

test('统一环境模型：必需 Tool 不可见是 system 故障（audit 范围）', async () => {
  const { deps } = depsOf(healthyContext(), {
    config: {},
  })
  // 注入一个"必需 Tool 被收窄"的事实。
  const patched = { ...deps, auditTools: async () => ({ missing: ['crwu_audit_ifind_query'], checked: true }) }
  const result = await loadEnvironment(patched, {})
  const issue = result.state.issues.find((item) => item.id === 'tool-registry')
  assert.equal(issue.owner, 'system')
  assert.equal(issue.scope, 'audit')
  assert.equal(result.state.capabilities.auditCore, false)
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
  assert.ok(result.blocked.some((item) => item.startsWith('DSH 脚本运行时')), '运行时不可用要如实阻塞')
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
  assert.equal(result.blocked.filter((item) => item.startsWith('DSH 脚本运行时')).length, 1, '运行时只算一个故障')
  assert.equal(result.state.issues.filter((item) => item.id === 'runtime').length, 1)
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
  assert.equal(result.blocked.filter((item) => item.startsWith('DSH 脚本运行时')).length, 1)
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
  assert.equal(result.blocked.some((item) => item.includes('运行平台未识别')), false, '识别出来了（linux-x64），只是不受支持')
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

  // ① 状态文件里是**新版授权收据**（healthyContext 就是这份）→ 姓名进 me。
  const trusted = depsOf(healthyContext(), { identity })
  const withMe = await loadEnvironment(trusted.deps, {})
  assert.deepEqual(withMe.me, { name: '杨凡宾', org: '中瑞世联资产评估集团有限公司', userId: '142227076626112869' })
  assert.equal(calls, 1, '一次自检只问一次')

  // ② 未授权：**一次都不问**（受限沙箱下 dws 会假报「未登录」，问出来的姓名不可信）。
  const untrustedState = createWorkbenchState(CONFIG)
  untrustedState.localAccess = missingConsent()
  const untrustedCtx = healthyContext({
    shellLines: { 'dws auth status': { stdout: '{"authenticated":true}' } },
    files: {
      '/Users/x/.ossutilconfig': '[Credentials]\nlanguage=CH\naccessKeyID=AKID12345678\naccessKeySecret=SECRET\n',
      [ifindCredentialPath('/Users/x')]: '{"auth_token":"ifind-token-123456"}',
      // 状态文件里写着未授权：自检会把它读回 state。
      '/Users/x/.dsh/crwu-workbench.json': '{}',
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
  assert.ok(result.blocked.some((item) => item.includes('运行平台未识别')))
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
  assert.ok(result.blocked.some((item) => item.includes('钉钉')))

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

test('a logged-out service is blocked by its label, and so is a missing iFinD key', async () => {
  const ctx = healthyContext({
    shellLines: {
      // 氚云没绑定、钉钉没登录
      'h3yun session status': { exitCode: 1, stderr: 'no session' },
      'dws auth status': { stdout: JSON.stringify({ authenticated: false }) },
      ' ls ': { stdout: 'ok\n' },
    },
    files: { '/Users/x/.dsh/crwu-workbench.json': consentConfigJson() },
  })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})
  assert.ok(result.blocked.some((item) => item.includes('氚云')))
  // iFinD 自 2026-09-26 起是必检项：缺失同样进阻塞项（旧口径"缺失不阻塞"已被产品要求覆盖）。
  assert.equal(result.blocked.some((item) => item.includes('iFinD')), true, 'iFinD 缺失必须进阻塞项')
  assert.equal(result.services[0].state, '未绑定')
  // 钉钉这条命令现在**自己带无沙箱权限**去问（员工零配置），所以它回的 `authenticated:false`
  // 是真答案 → 如实报「未登录」并计入阻塞。谎报只可能出现在「命令没跑起来」那条路径。
  assert.equal(result.services[1].state, '未登录')
  assert.equal(result.services[1].required, true)
  assert.ok(result.blocked.some((item) => item.includes('钉钉')), '确认没登录就要拦')
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
  assert.ok(result.blocked.some((item) => item.includes('氚云')))
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

test('the local-access receipt is echoed so the panel can render the consent card state', async () => {
  const { deps } = depsOf(healthyContext(), { state: { localAccess: grantedConsent() } })
  const result = await loadEnvironment(deps, {})
  // 协议 18：`trust: { credentials: boolean }` 被整条收据取代 —— 界面要能显示
  // 「授的是哪个范围、什么时候授的」，布尔值答不了（旧字段不许再回）。
  assert.equal(result.trust, undefined, '旧布尔字段必须消失')
  assert.equal(result.localAccess.state, 'granted')
  assert.deepEqual(result.localAccess.capabilities, grantedConsent().capabilities)
  assert.equal(result.localAccess.requiredSchemaVersion, result.localAccess.schemaVersion)
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
  const unauthorized = await loadEnvironment(depsOf(makeUnauthorizedCtx()).deps, {})
  const dingtalk = unauthorized.services.find((service) => service.id === 'dingtalk')
  assert.equal(dingtalk.state, '需要授权')
  assert.equal(dingtalk.ok, false)
  assert.ok(unauthorized.blocked.some((item) => item.includes('允许工作台访问本机账号和配置')), '未授权必须是阻塞项')
  assert.equal(unauthorized.state.userSetup.credentialsConsent.state, 'unconfigured')
  assert.equal(makeUnauthorizedSpecs().some((spec) => String(spec.command).includes('dws auth status')), false, '未授权不该去问 dws')

  // ② 已授权：凭据类命令自己声明无沙箱权限 → 拿到真结论（这里 fixture 回 authenticated:true）。
  const { deps } = depsOf(ctx, { state: { localAccess: grantedConsent() } })
  const result = await loadEnvironment(deps, {})
  const dwsSpec = specs.find((spec) => String(spec.command).includes('dws auth status'))
  assert.ok(dwsSpec, '授权后应当问过 dws auth status')
  // 这条断言就是缺陷复现：去掉 escalate 时它立刻变红。
  assert.equal(dwsSpec.sandboxPolicy?.mode, 'danger-full-access', '读钥匙串的命令必须声明无沙箱（钥匙串在沙箱外）')
  assert.equal(result.services.find((service) => service.id === 'dingtalk').ok, true)
  assert.equal(result.blocked.some((item) => item.includes('授权读取本机凭据')), false, '授权后授权项消失')
  // OSS 实测**同样要提权**（协议 18 改）：`ossutil` 每一次都会读 `~/.ossutilconfig`，
  // 受限沙箱下读不到就报一个和 AK 无关的错。所以它不是"不需要无沙箱"，而是
  // "本机凭据访问"这一类 —— 旧断言（undefined）在这里是**错的**，改它并写清原因。
  const ossSpec = specs.find((spec) => String(spec.command).includes(' ls '))
  assert.ok(ossSpec, '应当实测过一次 OSS')
  assert.equal(ossSpec.sandboxPolicy?.mode, 'danger-full-access', 'ossutil 会读本机配置，必须声明无沙箱')

  // 反向护栏：**不打凭据**的命令一律不提权（能给最小权限就给最小）——
  // 插件包核对只 stat 包内文件，连命令都不发。
  assert.equal(specs.some((spec) => String(spec.command).includes('dws version')), false, '不得执行 dws version')
})

/**
 * A-03：**授权前零副作用**。
 *
 * 判据是「发生过哪些调用」，不是「文案看起来对不对」：未授权时插件不许起任何读本机凭据的子进程
 * （氚云会话、钉钉登录态、ossutil 读 `%USERPROFILE%\.ossutilconfig`），也不许读 iFinD 凭据文件。
 * 这三件事恰好也是"沙箱里读不到 → 假的未登录 / 密钥错误"的来源。
 */
test('A-03 授权前零副作用：不起凭据子进程、不读凭据文件，且如实说「需要先允许」', async () => {
  const commands = []
  const reads = []
  const ctx = healthyContext()
  const originalGet = ctx.get
  ctx.get = (name) => {
    const value = originalGet(name)
    if (value === undefined) return value
    if (name === 'shell') {
      const inner = value.execute
      return { ...value, execute: async (spec) => { commands.push(String(spec.command)); return inner(spec) } }
    }
    if (name === 'fs') {
      const innerRead = value.readText
      return {
        ...value,
        async readText(target) {
          const key = String(target.targetKey)
          reads.push(key)
          // 未授权：工作台状态文件里**没有**任何收据（其它文件照常，用来证明"不是读不到"）。
          if (key.endsWith('crwu-workbench.json')) return '{}'
          return innerRead(target)
        },
      }
    }
    return value
  }

  // 即使用户点了「重新检查」并携带旧的 `probeIfind` 参数，未授权时也必须一步都不走。
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, { refresh: true, probeIfind: true })

  for (const needle of ['h3yun session', 'dws auth status', 'ossutil']) {
    assert.equal(commands.some((command) => command.includes(needle)), false, `未授权不该发：${needle}`)
  }
  for (const path of [ifindCredentialPath('/Users/x'), '/Users/x/.ossutilconfig']) {
    assert.equal(reads.includes(path), false, `未授权不该读：${path}`)
  }

  // 四项凭据类事实一律是「需要先允许」，**不许**出现未登录 / 密钥错误 / 未找到这类假结论。
  const setup = result.state.userSetup
  for (const key of ['h3yun', 'dingtalk', 'aliyunOss', 'ifind']) {
    assert.equal(setup[key].state, 'unconfigured', key)
    assert.equal(setup[key].reason, zhCNConsentReason, `${key} 的原因必须是授权提示`)
  }
  assert.equal(result.external.state, 'unconfigured')
  assert.equal(result.external.tokenLength, 0, '未授权连密钥长度都不该知道')
  assert.equal(result.delivery.ossCred.exists, false)
  assert.equal(result.delivery.ossCred.hasSecret, false)
  // 未授权时凭据类故障**不许各占一条**：唯一要做的动作是"允许一次"。
  // （授权说明本身会解释「没允许时读到的『未登录』不可信」——所以这条按 issue id 判，
  //  不能拿整句文本做包含式断言。）
  const issueIds = result.state.issues.map((issue) => issue.id)
  assert.equal(issueIds.includes('consent'), true)
  for (const id of ['h3yun', 'dingtalk', 'oss-config', 'oss-cred', 'oss-probe', 'ifind', 'ifind-external']) {
    assert.equal(issueIds.includes(id), false, `未授权不该出现凭据类任务：${id}`)
  }
  assert.deepEqual(result.blocked, [result.state.issues[0].message], '未授权时只有一条阻塞项')

  // 正控：授权前**该做**的检查照常做完了（不是整页失败）。
  assert.equal(result.packageIntegrity.ok, true)
  assert.equal(result.runtime.ok, true)
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

test('氚云探测：未授权就不问（unsandboxed 才拿得到真结论），授权后带无沙箱策略去问', async () => {
  // 员工 2026-09-28 在 Windows 上的原文：
  //   `read H3Yun session from operating system credential store: secret not found in keyring`
  // 受限沙箱（workspace-write）下读不到系统凭据存储，crwu 就会回这句话 —— 那是**假结论**。
  // 面板照着显示成「未登录」，把人指去重新扫码；而真原因是「没授权 / 被沙箱拦」。
  const specs = []
  const ctx = healthyContext({
    shellLines: {
      'h3yun session status': { stdout: JSON.stringify({ data: { userId: 'u1', expiresAt: '2099-01-01T00:00:00Z' } }) },
      ' ls ': { stdout: 'ok\n' },
    },
    files: { '/Users/x/.dsh/crwu-workbench.json': consentConfigJson() },
  })
  const originalGet = ctx.get
  ctx.get = (name) => {
    const value = originalGet(name)
    if (name !== 'shell' || value === undefined) return value
    const inner = value.execute
    return { ...value, execute: async (spec) => { specs.push(spec); return inner(spec) } }
  }

  // ① 未授权：**一条氚云命令都不发**（问了也只能得到假的「没找到」），并如实说是「需要授权」。
  const unauthorized = await loadEnvironment(depsOf(makeUnauthorizedCtx()).deps, {})
  const h3yunUnauthorized = unauthorized.services.find((service) => service.id === 'h3yun')
  assert.equal(h3yunUnauthorized.state, '需要授权')
  assert.equal(h3yunUnauthorized.ok, false)
  assert.match(h3yunUnauthorized.detail, /还没授权/)
  assert.equal(
    makeUnauthorizedSpecs().some((spec) => String(spec.command).includes('h3yun session status')),
    false,
    '未授权不该去问氚云（沙箱里问出来的「没找到」是假结论）',
  )

  // ② 已授权：自己声明无沙箱权限去拿真结论。这条断言就是缺陷复现 ——
  //    去提权白名单里只放行 `session login` 时它立刻变红。
  const { deps } = depsOf(ctx, { state: { localAccess: grantedConsent() } })
  const result = await loadEnvironment(deps, {})
  const sessionSpec = specs.find((spec) => String(spec.command).includes('h3yun session status'))
  assert.ok(sessionSpec, '授权后应当问过 h3yun session status')
  assert.equal(sessionSpec.sandboxPolicy?.mode, 'danger-full-access', '读钥匙串的命令必须声明无沙箱（钥匙串在沙箱外）')
  const h3yun = result.services.find((service) => service.id === 'h3yun')
  assert.equal(h3yun.state, '正常')
  assert.equal(h3yun.ok, true)
})

test('信任本机凭据后确实没登录，仍然如实报未登录并阻塞', async () => {
  const ctx = healthyContext({
    shellLines: {
      'h3yun session status': { stdout: JSON.stringify({ data: { userId: 'u1', expiresAt: '2099-01-01T00:00:00Z' } }) },
      'dws auth status': { stdout: JSON.stringify({ authenticated: false, message: '未登录' }) },
      ' ls ': { stdout: 'ok\n' },
    },
    files: {
      '/Users/x/.agents/skills/ifind-finance-data/mcp_config.json': '{"auth_token":"t"}',
      '/Users/x/.dsh/crwu-workbench.json': consentConfigJson(),
    },
  })
  const { deps } = depsOf(ctx, { state: { localAccess: grantedConsent() } })
  const result = await loadEnvironment(deps, {})

  const dingtalk = result.services.find((service) => service.id === 'dingtalk')
  assert.equal(dingtalk.state, '未登录')
  assert.equal(dingtalk.required, true)
  assert.ok(result.blocked.some((item) => item.includes('钉钉')), '确认过没登录就要拦')
})

test('环境校验只读取已保存的 iFinD 验证结论，普通检查与 refresh 都不打上游', async () => {
  const transport = ifindOkTransport()
  const first = depsOf(healthyContext({ files: {
    '/Users/x/.ossutilconfig': '[Credentials]\nlanguage=CH\naccessKeyID=AKID12345678\naccessKeySecret=SECRET\n',
    [ifindCredentialPath('/Users/x')]: '{"auth_token":"ifind-token-123456"}',
    '/Users/x/.dsh/crwu-workbench.json': consentConfigJson(),
  } }), { ifindTransport: transport })
  const one = await loadEnvironment(first.deps, {})
  assert.equal(one.external.dataVerified, false, '没有手动验证记录时只能是未验证')
  assert.equal(transport.calls.length, 0, '环境校验不得主动请求 iFinD')

  const two = await loadEnvironment(depsOf(healthyContext({ files: {
    '/Users/x/.ossutilconfig': '[Credentials]\nlanguage=CH\naccessKeyID=AKID12345678\naccessKeySecret=SECRET\n',
    [ifindCredentialPath('/Users/x')]: '{"auth_token":"ifind-token-123456"}',
    '/Users/x/.dsh/crwu-workbench.json': consentConfigJson(),
  } }), { ifindTransport: transport }).deps, { refresh: true })
  assert.equal(two.external.dataVerified, false)
  assert.equal(transport.calls.length, 0, '点击重新检查环境也不得主动请求 iFinD')
})

test('iFinD 取数验证失败时：明确归因，且**不**谎报已认证（现在会阻塞）', async () => {
  for (const [call, kind, pattern] of [['isError', 'entitlement', /权益/], ['http401', 'credential', /API-Key/], ['empty', 'infrastructure', /空内容|没有取到/]]) {
    const verification = call === 'isError'
      ? verificationFrom({ dataVerified: false, errorKind: 'entitlement', error: '权益不足' })
      : call === 'http401'
        ? verificationFrom({ ok: false, state: 'invalid', errorKind: 'credential', error: 'API-Key 无效', dataVerified: false })
        : verificationFrom({ dataVerified: false, errorKind: 'infrastructure', error: '没有取到数据', state: 'unreachable' })
    const deps = depsOf(contextWithIfindVerification(verification), { ifindTransport: makeIfindTransport({ tools: ['t'], call }) })
    const result = await loadEnvironment(deps.deps, {})
    assert.equal(result.external.dataVerified, false, call)
    assert.equal(result.external.errorKind, kind, `${call} → ${result.external.errorKind}`)
    assert.match(result.external.reason, pattern, call)
    // 必检项：不通过就阻塞（iFinD 自 2026-09-26 起不再是条件能力）。
    assert.equal(result.blocked.length > 0, true, call)
    assert.equal(result.state.proceed, false, call)
    assert.equal(result.state.capabilities.auditCore, false, call)
    const issue = result.state.issues.find((item) => item.id === 'ifind')
    assert.equal(issue.blocking, true, call)
    assert.match(issue.message, /iFinD API-Key 未通过验证/, call)
  }
})

test('认证通过但没取到数据：状态必须说「未验证」，不能显示成已认证', async () => {
  // `isError` 走的是取数阶段：认证（initialize + tools/list）是好的。
  const deps = depsOf(contextWithIfindVerification(verificationFrom({ dataVerified: false, errorKind: 'entitlement', error: '权益不足' })), { ifindTransport: makeIfindTransport({ tools: ['t'], call: 'isError' }) })
  const result = await loadEnvironment(deps.deps, {})
  assert.equal(result.state.userSetup.ifind.state, 'unverified')
  assert.match(result.state.userSetup.ifind.reason, /取到数据|重新验证/)
  assert.equal(result.external.ok, true, '认证确实是过的（别把它说成认证失败）')
  assert.equal(result.external.dataVerified, false)
})

test('iFinD 是必检项：清单里 required=true（旧口径 required=false 已被覆盖）', async () => {
  assert.equal(DEFAULT_MANIFEST.ifind.required, true, 'iFinD 必须是必需项')
  const ctx = healthyContext({ files: {
    '/Users/x/.ossutilconfig': '[Credentials]\nlanguage=CH\naccessKeyID=AKID12345678\naccessKeySecret=S\n',
    '/Users/x/.dsh/crwu-workbench.json': consentConfigJson(),
  } })
  const { deps } = depsOf(ctx)
  const result = await loadEnvironment(deps, {})
  assert.equal(result.external.ok, false, '缺凭据要如实显示为未配置')
  assert.equal(result.external.required, true)
  assert.equal(result.allOk, false, '缺 iFinD 之后环境整体不再健康')
  assert.equal(result.state.proceed, false)
})

// ── Host 侧能力门禁（带失效策略的快照 + fail closed）─────────────────────────

test('Host 门禁：60s 内复用快照，过期或显式刷新才重跑自检', async () => {
  const { createCapabilityGate } = await import(new URL('src/host/environment/gate.ts', ROOT).href)
  let calls = 0
  const now = { value: 1_000 }
  const gate = createCapabilityGate(async () => {
    calls += 1
    return { ok: true, status: 'ready', proceed: true, issues: [], blocked: [], checkError: '' }
  }, { ttlMs: 60_000, now: () => now.value })

  assert.equal((await gate.snapshot()).state.status, 'ready')
  assert.equal(calls, 1)
  // TTL 内不再问自检（这就是"不为每个操作重跑一遍昂贵自检"）。
  now.value += 30_000
  await gate.snapshot()
  assert.equal(calls, 1)
  // 过期 → 重跑。
  now.value += 40_000
  await gate.snapshot()
  assert.equal(calls, 2)
  // 显式刷新 → 立刻重跑。
  await gate.snapshot({ force: true })
  assert.equal(calls, 3)
  // 并发去重：同时进来的两个操作只跑一次。
  await Promise.all([gate.snapshot({ force: true }), gate.snapshot({ force: true })])
  assert.equal(calls, 4)
  // 授权 / 换空间 / 存凭据之后作废。
  gate.invalidate()
  await gate.snapshot()
  assert.equal(calls, 5)
})

test('Host 门禁：拿不到快照 / 未就绪 / 能力关闭时**一律拒绝**（fail closed）', async () => {
  const { decideCapability } = await import(new URL('src/host/environment/gate.ts', ROOT).href)
  const missing = decideCapability(null, 'auditCore')
  assert.equal(missing.allowed, false)
  assert.match(missing.reason, /重新检查/)

  const blocked = decideCapability({
    at: 0, refresh: false,
    state: { status: 'action-required', proceed: false, capabilities: { global: false, auditCore: false, delivery: false, externalData: true },
      blocked: ['未找到工作空间，请手动选择'], issues: [], checkError: '' },
  }, 'auditCore')
  assert.equal(blocked.allowed, false)
  assert.match(blocked.reason, /未找到工作空间/)

  // degraded（只有 iFinD 缺）→ 放行审核。
  const degraded = decideCapability({
    at: 0, refresh: false,
    state: { status: 'degraded', proceed: true, capabilities: { global: true, auditCore: true, delivery: true, externalData: true },
      blocked: [], issues: [], checkError: '' },
  }, 'auditCore')
  assert.equal(degraded.allowed, true)

  // 自检本身失败 → 不放行。
  const failed = decideCapability({
    at: 0, refresh: false,
    state: { status: 'check-failed', proceed: false, capabilities: { global: false, auditCore: false, delivery: false, externalData: true },
      blocked: [], issues: [], checkError: '主目录探测失败' },
  }, 'global')
  assert.equal(failed.allowed, false)
})

test('Host 门禁的判据表：audit-start 判 auditCore；停止/释放与修复动作不判', async () => {
  const { OPERATION_CAPABILITY, capabilityForOperation } = await import(new URL('src/host/environment/gate.ts', ROOT).href)
  assert.equal(capabilityForOperation('audit-start'), 'auditCore')
  assert.equal(capabilityForOperation('oss-upload'), 'delivery')
  // 安全出口：环境坏了也要能停能放。
  assert.equal(capabilityForOperation('audit-stop'), null)
  assert.equal(capabilityForOperation('audit-release'), null)
  // 修复动作本身：判门禁会形成"配不好就不让配"的死锁。
  for (const op of ['trust', 'workspace', 'oss-cred-save', 'ifind-credential-save']) {
    assert.equal(capabilityForOperation(op), null, op)
  }
  assert.deepEqual(Object.keys(OPERATION_CAPABILITY).sort(), ['audit-start', 'oss-upload'])
})

test('Host 门禁：iFinD 未通过时 audit-start 被拒（页面绕过也没用）', async () => {
  const { createCapabilityGate, decideCapability, capabilityForOperation } =
    await import(new URL('src/host/environment/gate.ts', ROOT).href)
  // 真实自检的结论（iFinD 未填 → 阻塞 + external-data scope 关掉 auditCore）。
  const { deps } = depsOf(healthyContext({ files: {
    '/Users/x/.ossutilconfig': '[Credentials]\nlanguage=CH\naccessKeyID=AKID12345678\naccessKeySecret=S\n',
    '/Users/x/.dsh/crwu-workbench.json': consentConfigJson(),
  } }))
  const env = await loadEnvironment(deps, {})
  assert.equal(env.state.capabilities.auditCore, false)

  const gate = createCapabilityGate(async () => ({
    ok: true, status: env.state.status, proceed: env.state.proceed,
    issues: env.state.issues, blocked: env.blocked, checkError: env.state.checkError,
    state: env.state,
  }), { ttlMs: 60_000 })

  const verdict = await decideCapability(await gate.snapshot(), capabilityForOperation('audit-start'))
  assert.equal(capabilityForOperation('audit-start'), 'auditCore')
  assert.equal(verdict.allowed, false, 'iFinD 未通过时 Host 门禁必须拒绝 audit-start')
  assert.match(verdict.reason, /iFinD|环境/)
})

test('Host 门禁：拿不到凭据时保守拒绝；补齐之后放行', async () => {
  const { decideCapability } = await import(new URL('src/host/environment/gate.ts', ROOT).href)
  // 未填 iFinD → 拒。
  const missing = depsOf(healthyContext({ files: {
    '/Users/x/.ossutilconfig': '[Credentials]\nlanguage=CH\naccessKeyID=AKID12345678\naccessKeySecret=S\n',
    '/Users/x/.dsh/crwu-workbench.json': consentConfigJson(),
  } }))
  const blocked = await loadEnvironment(missing.deps, {})
  assert.equal((await decideCapability({ at: 0, refresh: false, state: blocked.state }, 'auditCore')).allowed, false)
  // 填好并真的取到数据 → 放行。
  const ready = depsOf(healthyContext())
  const ok = await loadEnvironment(ready.deps, {})
  assert.equal((await decideCapability({ at: 0, refresh: false, state: ok.state }, 'auditCore')).allowed, true)
})
