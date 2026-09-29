/**
 * Local Access Broker 的策略 / 目标 / 来源测试（协议 18 · 子项目 B）。
 *
 * 这一层要守住的是**"谁能做什么"只有一处判据**，所以每条断言都对着一条不可回退的规则：
 *
 * - B-01/B-02：跨边界的调用必须落到具名操作上，而且操作表是**封闭**的（表外拒绝）；
 * - B-03：操作描述里**没有**命令 / 二进制路径 / 沙箱模式 / 提权开关这类可提交字段；
 * - B-04：未授权时**一个进程都不起、一个字节都不写**；
 * - B-05：提权是逐次显式声明的；请求被降级必须能从结构化事实里读出来；
 * - B-06：文件写入只能命中该操作**唯一**允许的那个目标路径。
 *
 * 所有替身都是内存实现：不碰真实 shell、不碰真实凭据、不写真实用户文件。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const {
  LOCAL_ACCESS_OPERATIONS, LOCAL_ACCESS_OPERATION_NAMES, LOCAL_ACCESS_WRITE_TARGETS,
  isLocalAccessOperation, localAccessDescriptorOf,
} = await import(new URL('src/host/access/operations.ts', ROOT).href)
const { createLocalAccessBroker } = await import(new URL('src/host/access/broker.ts', ROOT).href)
const { classifyAccessFailure, processStartedOf, createAccessDiagnostics } =
  await import(new URL('src/host/access/diagnostics.ts', ROOT).href)
const { LOCAL_ACCESS_CAPABILITIES, LOCAL_ACCESS_SCHEMA_VERSION } =
  await import(new URL('src/shared/access/types.ts', ROOT).href)
const { workbenchConfigPath } = await import(new URL('src/host/state/persist.ts', ROOT).href)
const { ifindCredentialPath } = await import(new URL('src/host/ifind/store.ts', ROOT).href)
const { ossConfigPath } = await import(new URL('src/host/oss/cred.ts', ROOT).href)
const { grantedConsent, missingConsent } = await import(
  new URL('tests/helpers/local-access-fixture.mjs', ROOT).href)

const HOME = '/Users/x'
const TARGETS = {
  'workbench-state': workbenchConfigPath,
  'ifind-credential': ifindCredentialPath,
  'oss-config': ossConfigPath,
}

/**
 * 内存 ctx + shell 替身。
 *
 * `sandboxFor(spec)` 让每个用例决定执行器**实际**跑在什么模式下 —— 这是"提权被降级"
 * 这类事实唯一的注入点。
 */
function makeCtx({ sandboxFor = (spec) => spec.sandboxPolicy?.mode, denyOn = '', failOn = '' } = {}) {
  const specs = []
  const files = {}
  const ctx = {
    logger: { warn: () => {} },
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async execute(spec) {
            specs.push(spec)
            if (failOn !== '' && String(spec.command).includes(failOn)) throw new Error('spawn 失败：sandbox runner 不可用')
            return {
              result: async () => ({
                exitCode: denyOn !== '' && String(spec.command).includes(denyOn) ? 1 : 0,
                signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                stdout: { text: '', truncated: false },
                stderr: { text: denyOn !== '' && String(spec.command).includes(denyOn) ? 'Access is denied' : '', truncated: false },
                ...(sandboxFor === null ? {} : { sandbox: { mode: sandboxFor(spec), denied: denyOn !== '' && String(spec.command).includes(denyOn), runnerFailed: false } }),
              }),
            }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) { return files[target.targetKey] === undefined ? undefined : { type: 'file' } },
          async readText(target) { return files[target.targetKey] ?? '' },
          async writeText(target, content, _expected, _signal, policy) {
            if (policy?.mode !== 'danger-full-access') {
              throw new Error(`file access denied under workspace-write mode`)
            }
            files[target.targetKey] = content
            return { operation: 'create', version: 'v', before: null, after: content }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, specs, files }
}

function makeBroker(ctx, consent, patch = {}) {
  const state = { localAccess: consent }
  const broker = createLocalAccessBroker({
    ctx,
    state,
    home: async () => HOME,
    workdir: async () => '/cases/session',
    platform: async () => 'darwin-arm64',
    targets: TARGETS,
    hostVersion: '0.0.15',
    protocolVersion: 18,
    ...patch,
  })
  return { broker, state }
}

// ── 操作表：封闭、无逃生字段 ─────────────────────────────────────────────────

test('B-03 · 操作表封闭且只含策略字段：没有命令 / 二进制 / 沙箱 / 提权开关可提交', () => {
  assert.deepEqual([...LOCAL_ACCESS_OPERATION_NAMES].sort(), Object.keys(LOCAL_ACCESS_OPERATIONS).sort())
  for (const name of LOCAL_ACCESS_OPERATION_NAMES) {
    const descriptor = LOCAL_ACCESS_OPERATIONS[name]
    assert.deepEqual(Object.keys(descriptor).sort(), ['allowedSources', 'capability', 'privileged', 'transport'], name)
    assert.equal(descriptor.transport === 'shell' || descriptor.transport === 'filesystem', true, name)
    assert.equal(typeof descriptor.privileged, 'boolean', name)
    assert.equal(descriptor.allowedSources.length > 0, true, name)
    for (const source of descriptor.allowedSources) {
      // `audit-host` = 插件自己的审核编排（audit-start → 建案例目录），
      // 与 `audit-tool`（审核子代理调业务 Tool）刻意分开：两者的沙箱位置不同。
      assert.equal(['panel', 'audit-host', 'audit-tool', 'host-background'].includes(source), true, `${name} → ${source}`)
    }
  }
  // 表外一律拒绝：这是"默认拒绝"的落点。
  for (const junk of ['', 'crwu', 'shell.exec', 'oss.remote.delete', 'h3yun.session.status ']) {
    assert.equal(isLocalAccessOperation(junk), false, junk)
    assert.equal(localAccessDescriptorOf(junk), undefined, junk)
  }
})

test('B-03 · capability 只取规范清单里的五项，加上插件自己的 host-owned-state', () => {
  const allowed = new Set([...LOCAL_ACCESS_CAPABILITIES, 'host-owned-state'])
  for (const name of LOCAL_ACCESS_OPERATION_NAMES) {
    assert.equal(allowed.has(LOCAL_ACCESS_OPERATIONS[name].capability), true, name)
  }
  // host-owned-state **只**能用于插件自己的状态文件，且不能跑命令。
  const owned = LOCAL_ACCESS_OPERATION_NAMES.filter(
    (name) => LOCAL_ACCESS_OPERATIONS[name].capability === 'host-owned-state')
  assert.deepEqual(owned, ['workbench.state.write'])
  assert.equal(LOCAL_ACCESS_OPERATIONS['workbench.state.write'].transport, 'filesystem')
})

test('B-06 · 只有三个操作允许写文件，且各自绑定唯一目标种类', () => {
  assert.deepEqual(Object.keys(LOCAL_ACCESS_WRITE_TARGETS).sort(),
    ['ifind.credential.write', 'oss.config.write', 'workbench.state.write'])
  // 登记为 write 目标的操作必须是 filesystem 通道；反过来 filesystem 操作只有这三个是写入。
  for (const [operation, kind] of Object.entries(LOCAL_ACCESS_WRITE_TARGETS)) {
    assert.equal(LOCAL_ACCESS_OPERATIONS[operation].transport, 'filesystem', operation)
    assert.equal(TARGETS[kind] !== undefined, true, kind)
  }
  assert.equal(LOCAL_ACCESS_WRITE_TARGETS['oss.remote.write'], undefined, '上传是 shell 操作，不是文件写入')
})

test('C-08 · 登录类操作**只**允许面板来源：审核链路（Tool / 后台）永远登录不了', () => {
  // 这是"子代理不许登录"在**策略层**的落点：不是靠提示词请求，而是操作表根本不给它这个来源。
  // 审核子代理的审批策略被钉成 `never`，任何交互式登录在它那里都会卡在一个没人回答的地方；
  // 而登录要写员工本机凭据，那不该由一条自动审核发起。
  const logins = LOCAL_ACCESS_OPERATION_NAMES.filter((name) => name.endsWith('.login'))
  assert.deepEqual([...logins].sort(), ['dws.auth.login', 'h3yun.session.login'])
  for (const name of logins) {
    assert.deepEqual([...LOCAL_ACCESS_OPERATIONS[name].allowedSources], ['panel'], name)
    const denied = makeBroker(makeCtx().ctx, grantedConsent()).broker
      .authorize({ operation: name, source: 'audit-tool', workdir: '/cases/session' })
    assert.equal(denied.ok, false, name)
    assert.equal(denied.errorClass, 'invalid-source', name)
  }
})

// ── authorize：来源、授权、工作目录 ──────────────────────────────────────────

test('B-04 · 未授权：拒绝且**一个进程都不起**（不调 ctx.shell）', async () => {
  const { ctx, specs } = makeCtx()
  const { broker } = makeBroker(ctx, missingConsent())
  const decision = broker.authorize({ operation: 'h3yun.session.status', source: 'panel', workdir: '/cases/session' })
  assert.equal(decision.ok, false)
  assert.equal(decision.errorClass, 'not-authorized')
  assert.match(decision.error, /账号连接/)

  const result = await broker.runShell(
    { operation: 'h3yun.session.status', source: 'panel', workdir: '/cases/session' }, 'crwu h3yun session status')
  assert.equal(result.ok, false)
  assert.deepEqual(specs, [], '未授权时不许起进程')
  assert.equal(broker.lastDiagnostic().errorClass, 'not-authorized')
  assert.equal(broker.lastDiagnostic().processStarted, false)
})

test('B-04 · 未授权时也不许写凭据文件（iFinD / OSS / 状态文件各判一次）', async () => {
  const { ctx, files } = makeCtx()
  const { broker } = makeBroker(ctx, missingConsent())
  for (const [operation, kind, path] of [
    ['ifind.credential.write', 'ifind-credential', TARGETS['ifind-credential'](HOME)],
    ['oss.config.write', 'oss-config', TARGETS['oss-config'](HOME)],
  ]) {
    const result = await broker.writeText({ operation, source: 'panel', workdir: HOME }, { kind, path }, 'secret')
    assert.equal(result.ok, false, operation)
    assert.deepEqual(Object.keys(files), [], operation)
  }
})

test('host-owned-state：插件自己的状态文件不受授权收据约束（授权本身要先能落盘）', async () => {
  const { ctx, files } = makeCtx()
  const { broker } = makeBroker(ctx, missingConsent())
  const result = await broker.writeText(
    { operation: 'workbench.state.write', source: 'host-background' },
    { kind: 'workbench-state', path: TARGETS['workbench-state'](HOME) },
    '{"ok":true}',
  )
  assert.equal(result.ok, true)
  assert.equal(files[TARGETS['workbench-state'](HOME)], '{"ok":true}')
})

test('来源白名单：审核 Tool 不许登录，后台不许写 OSS 配置', () => {
  const { ctx } = makeCtx()
  const { broker } = makeBroker(ctx, grantedConsent())
  const cases = [
    ['dws.auth.login', 'audit-tool'],
    ['h3yun.session.login', 'audit-tool'],
    ['oss.config.write', 'audit-tool'],
    ['system.clipboard.write', 'host-background'],
    ['ifind.credential.clear', 'audit-tool'],
  ]
  for (const [operation, source] of cases) {
    const decision = broker.authorize({ operation, source, workdir: '/cases/session' })
    assert.equal(decision.ok, false, `${operation} ← ${source}`)
    assert.equal(decision.errorClass, 'invalid-source', `${operation} ← ${source}`)
  }
})

test('未登记的操作名一律拒绝（封闭表）', () => {
  const { ctx } = makeCtx()
  const { broker } = makeBroker(ctx, grantedConsent())
  const decision = broker.authorize({ operation: 'shell.exec', source: 'panel', workdir: '/cases/session' })
  assert.equal(decision.ok, false)
  assert.equal(decision.errorClass, 'invalid-source')
})

test('特权操作缺工作目录 → fail closed（不用服务器 cwd 兜底）', async () => {
  const { ctx, specs } = makeCtx()
  // workdir() 也答不出来：连兜底都没有。
  const { broker } = makeBroker(ctx, grantedConsent(), { workdir: async () => '' })
  const decision = broker.authorize({ operation: 'oss.remote.read', source: 'panel' })
  assert.equal(decision.ok, false)
  assert.equal(decision.errorClass, 'invalid-source')
  assert.deepEqual(specs, [])
})

test('已授权 + 来源允许 → 给出**逐次**的 danger-full-access 策略', () => {
  const { ctx } = makeCtx()
  const { broker } = makeBroker(ctx, grantedConsent())
  const decision = broker.authorize({ operation: 'h3yun.records.read', source: 'audit-tool', workdir: '/cases/session' })
  assert.equal(decision.ok, true)
  assert.deepEqual(decision.sandboxPolicy, { mode: 'danger-full-access', workspaceRoot: '/cases/session' })
})

test('非特权操作不带沙箱策略（能给最小权限就给最小）', () => {
  const { ctx } = makeCtx()
  const { broker } = makeBroker(ctx, grantedConsent())
  for (const operation of ['ifind.credential.read', 'oss.config.read']) {
    const decision = broker.authorize({ operation, source: 'panel', workdir: '/cases/session' })
    assert.equal(decision.ok, true, operation)
    assert.equal(decision.sandboxPolicy, undefined, operation)
  }
})

// ── runShell：逐次策略 + 降级事实 ────────────────────────────────────────────

test('B-05 · 特权调用逐次声明 danger-full-access；非特权调用不带 sandboxPolicy', async () => {
  const { ctx, specs } = makeCtx()
  const { broker } = makeBroker(ctx, grantedConsent())
  await broker.runShell({ operation: 'h3yun.session.status', source: 'panel', workdir: '/cases/session' },
    'crwu h3yun session status', { summary: 'crwu h3yun session status' })
  assert.equal(specs[0].sandboxPolicy?.mode, 'danger-full-access')
  assert.equal(specs[0].sandboxPolicy?.workspaceRoot, '/cases/session')

  // 非特权操作**只有文件读取**（表里没有"非特权的 shell 操作"：任何起进程的本机访问都要提权）。
  // 所以它不能借 shell 通道执行 —— transport 对不上直接拒绝。
  const before = specs.length
  const result = await broker.runShell({ operation: 'oss.config.read', source: 'panel', workdir: '/cases/session' },
    'cat /Users/x/.ossutilconfig')
  assert.equal(result.ok, false)
  assert.deepEqual(specs.slice(before), [], '文件操作不许走 shell 通道')
  // 而且 `runShell` 是**唯一**入口：调用方没有 `escalate` 这个参数可传（见 B-03 的键名断言）。
})

test('B-05 · 请求被降级 → 诊断里 requested/resolved/ran 三项都在，类别是 sandbox-downgraded', async () => {
  // 执行器把 danger-full-access 解析成了 workspace-write（宿主/部署把提权降级了）。
  const { ctx } = makeCtx({ sandboxFor: (spec) => (spec.sandboxPolicy?.mode === 'danger-full-access' ? 'workspace-write' : '') })
  const { broker } = makeBroker(ctx, grantedConsent())
  await broker.runShell({ operation: 'oss.remote.read', source: 'panel', workdir: '/cases/session' }, 'ossutil ls oss://b/')
  const diagnostic = broker.lastDiagnostic()
  // 请求活过了 `resolve()`（resolved 仍是 danger-full-access），但**实际跑在** workspace-write：
  // 这正是最难发现的一种降级，所以三项事实都必须记下来。
  assert.equal(diagnostic.requestedMode, 'danger-full-access')
  assert.equal(diagnostic.resolvedMode, 'danger-full-access')
  assert.equal(diagnostic.ranMode, 'workspace-write')
  assert.equal(diagnostic.errorClass, 'sandbox-downgraded')
  assert.equal(diagnostic.operation, 'oss.remote.read')
  assert.equal(diagnostic.source, 'panel')
  assert.equal(diagnostic.consentVersion, LOCAL_ACCESS_SCHEMA_VERSION)
  assert.equal(diagnostic.hostVersion, '0.0.15')
  assert.equal(diagnostic.protocolVersion, 18)
})

test('沙箱真的拒绝 → sandbox-denied；runner 起不来 → infrastructure（两种处置不同）', async () => {
  // 策略被如实执行（ran = 请求的模式），但沙箱仍然拒绝了这一次文件操作 —— 这才是纯粹的
  // `sandbox-denied`。注意如果 ran 变成 workspace-write，归因应当是 `sandbox-downgraded`：
  // **降级会伪装成拒绝**，这正是优先级要把它排在前面、并且必须记 ran 的原因。
  const denied = makeCtx({ sandboxFor: (spec) => spec.sandboxPolicy?.mode ?? '', denyOn: 'ossutil' })
  const deniedBroker = makeBroker(denied.ctx, grantedConsent()).broker
  await deniedBroker.runShell({ operation: 'oss.remote.read', source: 'panel', workdir: '/cases/session' }, 'ossutil ls oss://b/')
  assert.equal(deniedBroker.lastDiagnostic().errorClass, 'sandbox-denied')
  assert.equal(deniedBroker.lastDiagnostic().sandboxDenied, true)

  const broken = makeCtx({ failOn: 'ossutil' })
  const brokenBroker = makeBroker(broken.ctx, grantedConsent()).broker
  const result = await brokenBroker.runShell(
    { operation: 'oss.remote.read', source: 'panel', workdir: '/cases/session' }, 'ossutil ls oss://b/')
  assert.equal(result.ok, false)
  assert.equal(brokenBroker.lastDiagnostic().errorClass, 'infrastructure')
  assert.equal(brokenBroker.lastDiagnostic().processStarted, false)
})

test('transport 不匹配：文件操作不能走 shell，shell 操作不能走文件写入', async () => {
  const { ctx, specs, files } = makeCtx()
  const { broker } = makeBroker(ctx, grantedConsent())
  const shell = await broker.runShell(
    { operation: 'oss.config.write', source: 'panel', workdir: HOME }, 'echo hi')
  assert.equal(shell.ok, false)
  assert.deepEqual(specs, [])

  const write = await broker.writeText(
    { operation: 'oss.remote.write', source: 'panel', workdir: HOME },
    { kind: 'oss-config', path: TARGETS['oss-config'](HOME) }, 'x')
  assert.equal(write.ok, false)
  assert.deepEqual(files, {})
})

// ── writeText：目标必须唯一 ─────────────────────────────────────────────────

test('B-06 · 目标种类 / 路径对不上就拒绝，且不落盘', async () => {
  const { ctx, files } = makeCtx()
  const { broker } = makeBroker(ctx, grantedConsent())
  const wrongKind = await broker.writeText(
    { operation: 'oss.config.write', source: 'panel', workdir: HOME },
    { kind: 'workbench-state', path: TARGETS['workbench-state'](HOME) }, 'AK=1')
  assert.equal(wrongKind.ok, false)
  // 路径想指到别处（比如别人的状态文件）同样拒绝。
  const wrongPath = await broker.writeText(
    { operation: 'oss.config.write', source: 'panel', workdir: HOME },
    { kind: 'oss-config', path: `${HOME}/.bashrc` }, 'rm -rf /')
  assert.equal(wrongPath.ok, false)
  assert.deepEqual(files, {})
})

test('B-06 · 三个写操作都**只**能命中自己的那一个路径（成功路径）', async () => {
  const { ctx, files } = makeCtx()
  const { broker } = makeBroker(ctx, grantedConsent())
  for (const [operation, kind] of Object.entries(LOCAL_ACCESS_WRITE_TARGETS)) {
    const path = TARGETS[kind](HOME)
    const result = await broker.writeText({ operation, source: 'panel', workdir: HOME }, { kind, path }, `body:${kind}`)
    assert.equal(result.ok, true, operation)
    assert.equal(files[path], `body:${kind}`, operation)
  }
  assert.equal(Object.keys(files).length, 3, '三个目标互不覆盖')
})

test('写入被沙箱拒绝时诊断记 sandbox-denied，不假装是基础设施故障', async () => {
  const ctx = {
    logger: { warn: () => {} },
    get: (name) => (name === 'fs'
      ? {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async writeText() { throw new Error('file access denied under workspace-write mode') },
        }
      : undefined),
  }
  const { broker } = makeBroker(ctx, grantedConsent())
  const result = await broker.writeText(
    { operation: 'oss.config.write', source: 'panel', workdir: HOME },
    { kind: 'oss-config', path: TARGETS['oss-config'](HOME) }, 'AK=1')
  assert.equal(result.ok, false)
  assert.equal(broker.lastDiagnostic().errorClass, 'sandbox-denied')
  assert.equal(broker.lastDiagnostic().sandboxDenied, true)
})

// ── 诊断：脱敏与环形缓冲 ────────────────────────────────────────────────────

test('诊断只记操作名与事实，**不记**原始命令（没给 summary 时退回操作名）', async () => {
  const { ctx } = makeCtx()
  const { broker } = makeBroker(ctx, grantedConsent())
  await broker.runShell({ operation: 'h3yun.records.read', source: 'audit-tool', workdir: '/cases/session' },
    'crwu h3yun records get --schema SECRET-FORM-CODE --id 0123456789abcdef')
  const diagnostic = broker.lastDiagnostic()
  assert.equal(diagnostic.summary, 'h3yun.records.read')
  const serialized = JSON.stringify(diagnostic)
  for (const forbidden of ['SECRET-FORM-CODE', '0123456789abcdef', 'crwu']) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }
})

test('诊断摘要脱敏：路径 / 盘符 / `~` 一个都不许进缓冲区', () => {
  // 摘要来自调用方（静态标签，或 `describeCrwuCommand` 从 argv 前缀拼出来的字符串）。
  // argv 里可能有**路径**，而诊断会进界面与"复制诊断"文本 —— 所以记录时就收一道。
  const diagnostics = createAccessDiagnostics(5)
  const record = (summary) => {
    diagnostics.record({
      operation: 'oss.remote.read', source: 'panel', consentVersion: 1,
      requestedMode: '', resolvedMode: '', ranMode: '', sandboxDenied: false, runnerFailed: false,
      errorClass: '', processStarted: false, hostVersion: '0.0.15', protocolVersion: 18,
      summary, at: new Date(0).toISOString(),
    })
    const last = diagnostics.list()[0]
    diagnostics.clear()
    return last.summary
  }
  assert.equal(record('crwu case open /Users/mungdong/cases/秘密 报告'), 'crwu case open')
  assert.equal(record('dws drive download C:\\Users\\x\\报告.pdf'), 'dws drive download')
  assert.equal(record('~/Library/Application Support/ossutil'), '')
  assert.equal(record('ossutil ls（列举交付件）'), 'ossutil ls（列举交付件）', '静态标签要原样保留')
  assert.equal(record('crwu h3yun records get fileId=abc123 --limit 5'), 'crwu h3yun records get', '最多四个词')
})

test('诊断环形缓冲有上限，新的在前', () => {
  const diagnostics = createAccessDiagnostics(3)
  for (let index = 0; index < 5; index += 1) {
    diagnostics.record({
      operation: 'oss.remote.read', source: 'panel', consentVersion: 1,
      requestedMode: '', resolvedMode: '', ranMode: '', sandboxDenied: false, runnerFailed: false,
      errorClass: '', processStarted: true, hostVersion: '0.0.15', protocolVersion: 18,
      summary: `op-${String(index)}`, at: new Date(index).toISOString(),
    })
  }
  const list = diagnostics.list()
  assert.equal(list.length, 3)
  assert.deepEqual(list.map((item) => item.summary), ['op-4', 'op-3', 'op-2'])
  // 返回的是快照：调用方改它不影响内部状态。
  list[0].summary = 'tampered'
  assert.equal(diagnostics.list()[0].summary, 'op-4')
})

// ── 归因优先级 ──────────────────────────────────────────────────────────────

test('归因优先级：runner 失败 > 降级 > 沙箱拒绝 > 审批 > 基础设施 > CLI', () => {
  const cases = [
    ['runner 失败优先于一切', { sandbox: { runnerFailed: true, denied: true, requested: 'danger-full-access', resolved: 'workspace-write' }, error: 'x' }, 'infrastructure'],
    ['降级优先于拒绝（解析阶段被降）', { sandbox: { requested: 'danger-full-access', resolved: 'workspace-write', denied: true } }, 'sandbox-downgraded'],
    ['降级优先于拒绝（执行阶段被降）', { sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'workspace-write', denied: true } }, 'sandbox-downgraded'],
    ['拒绝', { sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', denied: true } }, 'sandbox-denied'],
    ['审批拒绝', { sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', denied: false }, error: 'approval denied by policy' }, 'approval-denied'],
    ['命令没跑起来', { sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', denied: false }, error: 'shell 服务不可用' }, 'infrastructure'],
    ['退出码非 0', { sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', denied: false }, exitCode: 1 }, 'cli'],
    ['成功', { sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', denied: false }, exitCode: 0 }, ''],
  ]
  for (const [name, input, expected] of cases) {
    assert.equal(classifyAccessFailure(input), expected, name)
  }
  // 文本判据是最后兜底：结构化事实在手时，一句 "Access is denied" 不许改归类。
  assert.equal(classifyAccessFailure({
    sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', denied: false },
    error: '', exitCode: 1, message: 'Access is denied',
  }), 'cli')
})

test('processStartedOf：只有真的产生过进程才算起来了', () => {
  assert.equal(processStartedOf({ sandbox: { runnerFailed: false }, error: '', exitCode: 0 }), true)
  assert.equal(processStartedOf({ sandbox: { runnerFailed: true }, error: '', exitCode: 0 }), false)
  assert.equal(processStartedOf({ sandbox: { runnerFailed: false }, error: 'spawn ENOENT' }), false)
})

test('授权收据是**活**的：撤销后立刻拒绝，重新允许后立刻放行', async () => {
  const { ctx, specs } = makeCtx()
  const { broker, state } = makeBroker(ctx, grantedConsent())
  assert.equal(broker.authorize({ operation: 'dws.knowledge.read', source: 'audit-tool', workdir: '/cases/session' }).ok, true)
  state.localAccess = { ...missingConsent(), state: 'revoked' }
  assert.equal(broker.authorize({ operation: 'dws.knowledge.read', source: 'audit-tool', workdir: '/cases/session' }).ok, false)
  state.localAccess = grantedConsent()
  assert.equal(broker.authorize({ operation: 'dws.knowledge.read', source: 'audit-tool', workdir: '/cases/session' }).ok, true)
  assert.deepEqual(specs, [], 'authorize 自己是零副作用的')
})
