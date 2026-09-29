/**
 * DWS 本机目录体检与最小权限修复的测试（协议 18 · 子项目 D2 / D3）。
 *
 * 这几条是"能不能碰操作系统权限"的判据，所以每条都成对写：**该修的修、不该修的绝不碰**。
 * 夹具里所有命令都记流水，断言里既看"回了什么"，也看"到底跑了哪几条命令"——
 * 只断言返回值证明不了"没执行 icacls / chown / 删锁"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { missingConsent } = await import(new URL('../helpers/local-access-fixture.mjs', import.meta.url).href)
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)
const { dwsLocalDoctor, dwsLocalPermissionRepair, summarizeDoctorOutput, parseAclVerdict } = await import(
  new URL('src/host/dws/local.ts', ROOT).href)

const HOME = '/Users/x'

/**
 * 官方 `FileSystemRights` 的两个数值（`Modify = ReadAndExecute | Write | Delete`）：
 *
 * - `Modify = 197055`；
 * - `FullControl = 2032127`。
 *
 * ⚠️ 2026-09-29 用户复查指出：本仓此前把 `2032127` 标成 "Modify" —— 那是 **FullControl**。
 * 实现本身不硬编码权限位（由 PowerShell 的 `modify-mask` 给出），但夹具用错值会让
 * "有效权限是否覆盖所需写位"的算术在测试里失真，所以两个值都要有对照用例。
 */
const MODIFY = 197055
const FULL_CONTROL = 2032127
const DWS_DIR = `${HOME}/.dws`
const LOCK = `${DWS_DIR}/.data.lock`

/** `dws doctor --json` 的真实输出形状（本机实测抄回，账户名/路径已替换成替身值）。 */
const DOCTOR_JSON = JSON.stringify({
  checks: [
    { name: 'auth', status: 'fail', message: '未登录', hint: '运行 dws auth login 进行登录' },
    {
      name: 'keychain',
      status: 'pass',
      message: 'macOS 默认钥匙串可用',
      detail: { account: '某账户', default_keychain: '/Users/x/Library/Keychains/login.keychain-db', platform: 'darwin', service: 'dws-cli' },
    },
    { name: 'network', status: 'pass', message: 'https://mcp.dingtalk.com 可达 (延迟 225ms)' },
    { name: 'version', status: 'fail', message: '无法获取最新版本: GitHub API 请求频率超限' },
  ],
  kind: 'doctor',
  summary: { fail: 2, pass: 2, warn: 0 },
})

const DOCTOR_KEYCHAIN_DENIED = JSON.stringify({
  checks: [
    { name: 'auth', status: 'fail', message: '未登录' },
    { name: 'keychain', status: 'fail', message: '无法访问钥匙串：errSecInteractionNotAllowed (-25308)' },
  ],
  kind: 'doctor',
  summary: { fail: 2, pass: 0, warn: 0 },
})

/**
 * 造一套 deps：fs 只回答"哪些路径存在"，shell 按命令回放并把命令记进 `commands`。
 */
function makeDeps(patch = {}) {
  const commands = []
  /** 每一次 fs 探测（用来断言"未授权时零调用"）。 */
  const fsCalls = []
  const files = new Set(patch.exists ?? [DWS_DIR, LOCK])
  const symlinks = new Set(patch.symlinks ?? [])
  /** 可替换的命令回放（`causeFailure` 会临时接管，制造一次真实的权限失败）。 */
  const shellHolder = { run: patch.shell ?? (() => ({ stdout: '' })) }
  /** 体检第二次跑时要换个回放（`afterShell`）：用来造"命令跑过了但回读对不上"。 */
  const phase = { after: false }
  const sandboxOverride = { value: patch.sandbox ?? undefined }
  const ctx = {
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async execute(spec) {
            commands.push(spec.command)
            // `throwOn`：模拟"命令根本没跑起来"（沙箱后端不可用 → runnerFailed）。
            if (patch.throwOn !== undefined && patch.throwOn.test(spec.command)) {
              throw new Error('sandbox-exec: sandbox_apply: Operation not permitted')
            }
            const reply = shellHolder.run(spec.command, phase.after)
            // **世界在修复命令真的跑过那一刻就变了**：之后的探测必须看到新状态。
            // 用"看到修复命令"来自动切换阶段，而不是让用例手工调 `enterAfterPhase()` ——
            // 手工切换会让**诊断那一次**探测也看到"已修好"，于是连确诊都过不去
            // （2026-09-29 被这条绊了一次：用例自己的时序与真实时序不一致）。
            if (/^(chmod|icacls)\s|^icacls\s/.test(spec.command)) phase.after = true
            return { result: async () => ({
              exitCode: reply.exitCode ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: reply.stdout ?? '', truncated: false },
              stderr: { text: reply.stderr ?? '', truncated: false },
              // ⚠️ 这里必须是**服务形状**（`{ mode, denied, runnerFailed }`）：`shell/run.ts`
              // 读的是 `result.sandbox.mode`，写成 `{ ran }` 会被静默忽略 —— 而 `resolved`
              // 由**请求**（`spec.sandboxPolicy.mode`）补上，于是"执行器到底跑在什么模式下"
              // 这件事被掩盖掉（2026-09-29 踩到：一条本该"不知道"的探测被当成了操作系统事实）。
              sandbox: reply.sandbox ?? sandboxOverride.value ?? (patch.sandboxDown === true
                ? { mode: 'workspace-write', denied: true, runnerFailed: false }
                : { mode: 'danger-full-access', denied: false, runnerFailed: false }),
            }) }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) {
            fsCalls.push(`stat ${String(target.targetKey)}`)
            // 真实的 fs 错误**内嵌路径**（`EACCES: ..., stat '/Users/x/.dws'`）——
            // 夹具也必须带上它，否则"错误里不该出现主目录"那条断言是空的（证伪时抓到过）。
            if (patch.statThrows === true) {
              throw new Error(`EACCES: permission denied, stat '${String(target.targetKey)}'`)
            }
            // 包内 `dws` 二进制必须"在"：`runDws` 只按包内绝对路径解析（不回退裸命令名）。
            if (/[/\\]dws(\.exe)?$/.test(target.targetKey)) return { type: 'file' }
            return files.has(target.targetKey) ? { type: target.targetKey === DWS_DIR ? 'directory' : 'file' } : undefined
          },
          async lstat(path) {
            fsCalls.push(`lstat ${String(path)}`)
            if (patch.lstatThrows === true) throw new Error(`EACCES: permission denied, lstat '${String(path)}'`)
            return symlinks.has(path) ? { type: 'symlink' } : { type: 'file' }
          },
        }
      }
      return undefined
    },
  }
  const access = makeTestAccess(ctx, {
    home: HOME,
    platform: patch.platform ?? 'darwin-arm64',
    // `consent: 'missing'` 造"撤销之后"的世界（未授权）。
    ...(patch.consent === 'missing' ? { consent: missingConsent() } : {}),
  }).access
  return {
    commands,
    /** 让某个路径"消失"（诊断与修复之间状态变了那种情形）。 */
    removePath: (path) => { files.delete(path) },
    commands,
    fsCalls,
    setShell: (run) => { shellHolder.run = run },
    /** 进入"修复之后"的体检阶段（回放函数会收到 `after = true`）。 */
    enterAfterPhase: () => { phase.after = true },
    /** 覆盖所有命令返回的沙箱事实（用来造"拿不到证据"与"被沙箱拦下"）。 */
    setSandbox: (facts) => { sandboxOverride.value = facts },
    /** 取**当前**的回放函数本身（不是包一层实时读引用 —— 那会在替换之后自递归）。 */
    currentShell: () => shellHolder.run,
    deps: {
      ctx,
      access,
      home: HOME,
      platform: patch.platform ?? 'darwin-arm64',
      workdir: HOME,
      source: patch.source ?? 'panel',
    },
  }
}

/**
 * 先制造一次**真实的本机访问失败**：命令跑在完全访问下、沙箱没有拒绝、文本是权限不足。
 *
 * 修复的正向前置（"体检确诊 os-filesystem-permission"）就来自这一条诊断 + 体检的探测 ——
 * 所以每个"应该修"的用例都必须先走这一步，否则就是在没有确诊的情况下动权限。
 */
/** 给**任意操作**记一条诊断（默认失败；`ok: true` 时记一条成功）。 */
async function recordDiagnostic(harness, operation, { ok = false, command = 'dws PROBE-MARKER' } = {}) {
  const previous = harness.currentShell()
  harness.setShell((line) => (
    line.includes('PROBE-MARKER')
      ? (ok ? { exitCode: 0, stdout: '', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'Access is denied.' })
      : previous(line)
  ))
  try {
    await harness.deps.access.runShell(
      { operation, source: 'panel', workdir: HOME },
      command,
      { summary: operation },
    )
  } finally {
    harness.setShell(previous)
  }
}

async function causeFailure(harness, patch = {}) {
  // 这一条命令**真的失败**：退出码非 0 + `Access is denied.`，而沙箱事实是完全访问、未被拒。
  // 这正是"平台原生权限问题"能成立的前提（沙箱没拒绝它，它自己就是进不去）。
  const previous = harness.currentShell()
  harness.setShell((command) => (
    command.includes('PERMISSION-DENIED-MARKER')
      ? { exitCode: 1, stdout: patch.stdout ?? '', stderr: patch.stderr ?? 'Access is denied.' }
      : previous(command)
  ))
  try {
    await harness.deps.access.runShell(
      { operation: 'dws.drive.read', source: 'panel', workdir: HOME },
      'dws PERMISSION-DENIED-MARKER',
      { summary: 'dws drive' },
    )
  } finally {
    // 体检自己那几条命令必须回到正常回放：否则"制造失败"会污染整个用例。
    harness.setShell(previous)
  }
}

/** POSIX 默认回放：mode/uid 正常、目录可写、doctor 说"钥匙串可用但未登录"。 */
const posixShell = (command) => {
  if (command.includes('stat ')) return { stdout: '501 700\n' }
  if (command === 'id -u') return { stdout: '501\n' }
  if (command.startsWith('test -w')) return { exitCode: 0, stdout: '' }
  if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
  if (command.includes(' auth status ')) return { stdout: '{"authenticated":false}' }
  return { stdout: '' }
}

// ── D-03 目标由 Host 推导，参数里没有路径 ───────────────────────────────────

test('P2/D2 · 体检的前置条件：没有相关失败 / 失败是别的操作 / 失败是沙箱拦的 → 零调用', async () => {
  // 设计 §D2：the operation runs only after consent and **only after a DWS failure whose
  // structured facts rule out sandbox denial**。这不是省事 —— 体检会读 `~/.dws`、跑
  // `dws doctor`，而"没有失败"或"失败其实是沙箱拦的"时的权限结论都是无的放矢。
  const cases = []

  // ① 完全没有失败诊断。
  const noFailure = makeDeps({ shell: posixShell })
  cases.push({ name: '没有失败', harness: noFailure })

  // ② 最近一次失败是**别的操作**（OSS）—— 它跟 `.dws` 一点关系都没有。
  const otherOp = makeDeps({ shell: posixShell })
  await otherOp.deps.access.runShell(
    { operation: 'oss.remote.read', source: 'panel', workdir: HOME },
    'ossutil ls oss://bucket/prefix/ --endpoint e',
    { summary: 'ossutil ls', timeoutMs: 100 },
  )
  cases.push({ name: '最近失败是 OSS', harness: otherOp })

  // ③④ 最近一次 DWS 失败，但结构化事实说它是沙箱拦下的（denied / 降级）。
  for (const [name, patch] of [['沙箱拒绝', { denied: true }], ['提权被降级', { downgraded: true }]]) {
    const sandboxed = makeDeps({
      shell: posixShell,
      sandbox: patch.denied === true
        ? { mode: 'workspace-write', denied: true, runnerFailed: false }
        : { mode: 'workspace-write', denied: false, runnerFailed: false },
    })
    await causeFailure(sandboxed)
    cases.push({ name, harness: sandboxed })
  }

  for (const item of cases) {
    const commandsBefore = item.harness.commands.length
    const fsBefore = item.harness.fsCalls.length
    const view = await dwsLocalDoctor(item.harness.deps)
    assert.equal(view.ok, false, `${item.name}：必须拒绝`)
    assert.equal(view.directoryExists, null, `${item.name}：不许带回"目录在不在"`)
    assert.equal(view.currentUserCanModify, null, `${item.name}：不许给权限结论`)
    const addedCommands = item.harness.commands.slice(commandsBefore)
    assert.deepEqual(addedCommands, [], `${item.name}：体检不许起任何命令（实际：${addedCommands.join(' · ')}）`)
    // 零 fs 调用同样是判据：判据必须落在**任何** `stat ~/.dws` 之前。
    const addedFs = item.harness.fsCalls.slice(fsBefore)
    assert.deepEqual(addedFs, [], `${item.name}：体检不许 stat 任何路径（实际：${addedFs.join(' · ')}）`)
  }
})

test('D2 · "最近一次失败"的判定细节：成功的 dws 记录不是失败；别的操作的失败不许往回翻', async () => {
  // ① 缓冲区里只有**成功**的 dws 记录（界面自检常常刚跑过一次成功的 `dws auth status`）。
  //    "最近一条 dws 记录"当成失败 → 体检会为一次**成功**做归因；正确行为是拒绝。
  const onlySuccess = makeDeps({ shell: posixShell })
  await recordDiagnostic(onlySuccess, 'dws.drive.read', { ok: true, command: 'dws PROBE-MARKER' })
  const commandsBefore = onlySuccess.commands.length
  const fsBefore = onlySuccess.fsCalls.length
  const refused = await dwsLocalDoctor(onlySuccess.deps)
  assert.equal(refused.ok, false, '没有失败就没有可归因的对象')
  assert.equal(refused.classification, 'not-applicable')
  assert.deepEqual(onlySuccess.commands.slice(commandsBefore), [], '拒绝时不许起任何命令')
  assert.deepEqual(onlySuccess.fsCalls.slice(fsBefore), [], '拒绝时不许 stat 任何路径')

  // ①b 只有一条**访问控制**结果（`invalid-source`：调用方来源不对）→ 同样不算可归因的失败。
  //     这种记录最容易出现在员工刚点完「允许」、或某个调用点写错来源的时候；
  //     它不是"这台机器上的 dws 怎么了"，不该让体检去回答文件权限问题。
  const controlOnly = makeDeps({ shell: posixShell })
  await recordDiagnostic(controlOnly, 'dws.auth.probe', { ok: true, command: 'dws auth status PROBE-MARKER' })
  assert.equal(controlOnly.deps.access.diagnostics()[0]?.errorClass, 'invalid-source', '夹具确实造出了访问控制结果')
  const controlBefore = controlOnly.commands.length
  const controlView = await dwsLocalDoctor(controlOnly.deps)
  assert.equal(controlView.ok, false, '访问控制结果不是可归因的执行失败')
  assert.deepEqual(controlOnly.commands.slice(controlBefore), [], '拒绝时不许起任何命令')

  // ② 有 DWS 失败，但**最近一次失败**是 OSS → 必须拒绝，不许往更早的记录里翻出一条 DWS 失败来用。
  const mixed = makeDeps({ shell: posixShell })
  await causeFailure(mixed)
  await recordDiagnostic(mixed, 'oss.remote.read', { ok: false, command: 'ossutil ls PROBE-MARKER' })
  const mixedBefore = mixed.commands.length
  const mixedView = await dwsLocalDoctor(mixed.deps)
  assert.equal(mixedView.ok, false, '最近失败属于别的操作时必须拒绝')
  assert.deepEqual(mixed.commands.slice(mixedBefore), [], '拒绝时不许起任何命令')

  // ③ 失败之后又有一次**成功**的 dws 调用：真正的失败仍然是最近一次**失败**，体检照常运行。
  const withSuccess = makeDeps({ shell: posixShell })
  await causeFailure(withSuccess)
  await recordDiagnostic(withSuccess, 'dws.drive.read', { ok: true, command: 'dws PROBE-MARKER' })
  const ranBefore = withSuccess.commands.length
  const ran = await dwsLocalDoctor(withSuccess.deps)
  assert.equal(ran.ok, true, `成功记录不该把真正的失败挤掉：${ran.error}`)
  assert.equal(withSuccess.commands.length > ranBefore, true, '体检应当真的跑起来')
})

test('D2 · 界面事实 `hasAttributableDwsFailure` 必须与体检的前置条件**同源**', async () => {
  // 用户 2026-09-29 的决定：能不能体检由 **Host** 给事实（`dwsDiagnosable`），客户端不自己猜。
  // 那两处就必须是同一个判据 —— 否则会出现"按钮亮着、点下去被拒"，
  // 或者更糟的"按钮灰着、其实能体检"（员工以为功能坏了）。
  const { hasAttributableDwsFailure } = await import(new URL('src/host/dws/local.ts', ROOT).href)

  // ① 没有失败 → 不能体检。
  const none = makeDeps({ shell: posixShell })
  assert.equal(hasAttributableDwsFailure(none.deps), false)
  assert.equal((await dwsLocalDoctor(none.deps)).canDiagnose, false)

  // ② 最近失败属于别的操作（OSS）→ 不能体检。
  const other = makeDeps({ shell: posixShell })
  await recordDiagnostic(other, 'oss.remote.read', { ok: false, command: 'ossutil ls PROBE-MARKER' })
  assert.equal(hasAttributableDwsFailure(other.deps), false)
  assert.equal((await dwsLocalDoctor(other.deps)).canDiagnose, false)

  // ③ 只有成功的 dws 记录 → 不能体检。
  const okOnly = makeDeps({ shell: posixShell })
  await recordDiagnostic(okOnly, 'dws.drive.read', { ok: true, command: 'dws PROBE-MARKER' })
  assert.equal(hasAttributableDwsFailure(okOnly.deps), false)

  // ④ 有可归因的 DWS 失败 → 能体检，且体检真的跑起来（`canDiagnose: true`）。
  const some = makeDeps({ shell: posixShell })
  await causeFailure(some)
  assert.equal(hasAttributableDwsFailure(some.deps), true)
  const ran = await dwsLocalDoctor(some.deps)
  assert.equal(ran.canDiagnose, true, '真的跑起来时 canDiagnose 必须是 true')
  assert.equal(ran.ok, true)

  // ⑤ 沙箱降级 → 不能体检（改权限解决不了它）。
  const sandboxed = makeDeps({ sandboxDown: true, shell: posixShell })
  await causeFailure(sandboxed)
  assert.equal(hasAttributableDwsFailure(sandboxed.deps), false)
  assert.equal((await dwsLocalDoctor(sandboxed.deps)).canDiagnose, false)
})

test('D-03 · 体检从主目录推导目标，参数里没有路径；返回体里没有任何身份信息', async () => {
  const harness = makeDeps({ shell: posixShell })
  const { deps, commands } = harness
  // 设计 D2：体检只在「刚刚发生过一次 DWS 失败、且结构化事实排除沙箱」之后运行。
  await causeFailure(harness)
  const view = await dwsLocalDoctor(deps)
  assert.equal(view.ok, true)
  // 只读体检**不许**出现任何写权限的命令。
  for (const command of commands) {
    assert.equal(/chmod|icacls|takeown|chown|rm |del /i.test(command), false, `体检里出现了写命令：${command}`)
  }
  const serialized = JSON.stringify(view)
  for (const forbidden of ['某账户', 'login.keychain-db', 'dws-cli', '未登录', 'dws auth login', 'S-1-5-21', 'message', 'hint']) {
    assert.equal(serialized.includes(forbidden), false, `体检回显了 ${forbidden}`)
  }
  // 状态词是**归一化**的，不是原始输出。
  assert.match(view.dwsDoctorState, /^pass=\d+ fail=\d+ warn=\d+/)
  assert.equal(view.permissionMechanism, 'posix-mode')
  assert.equal(view.directoryMode, '700')
  assert.equal(view.ownerMatchesCurrentUser, true)
  assert.equal(view.currentUserCanModify, true)
  assert.equal(view.credentialStoreState, 'missing-secret', '钥匙串可用但未登录 = 条目不存在')
})

test('summarizeDoctorOutput 只留状态词：原始输出里的账户、路径、服务名一律不出去', () => {
  const summary = summarizeDoctorOutput(DOCTOR_JSON)
  assert.equal(summary.keychain, 'available')
  assert.equal(summary.authFailed, true)
  assert.equal(summary.state, 'pass=2 fail=2 warn=0 failing=auth,version')
  assert.equal(summary.state.includes('未登录'), false)
  // 解析不了就留空（不抛、不编）。
  assert.deepEqual(summarizeDoctorOutput('不是 JSON'), { state: '', keychain: 'unknown', authFailed: false })
})

test('探针拿不到结论时两个布尔是 null（"不知道"不等于"不行"）', async () => {
  const harness = makeDeps({
    // 权限相关的命令**一条都跑不起来**（沙箱后端不可用那种）：这必须是"不知道"，不是"不行"。
    throwOn: /^(stat|id|test) /,
    shell: (command) => {
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  const { deps } = harness
  // 设计 D2：体检只在「刚刚发生过一次 DWS 失败、且结构化事实排除沙箱」之后运行。
  await causeFailure(harness)
  const view = await dwsLocalDoctor(deps)
  assert.equal(view.ownerMatchesCurrentUser, null)
  assert.equal(view.currentUserCanModify, null)
  assert.equal(view.directoryMode, '')
  assert.equal(view.permissionMechanism, 'posix-mode', '机制是推导出来的，不靠命令成功')
})

test('Windows 命令的结构自检：括号配平、不许出现空语句（本机没有 pwsh，只能先守住结构）', async () => {
  // 这些 PowerShell 是**拼接**出来的（数组 join / 字符串累加），拼错的后果在 macOS 上完全看不见：
  // 解析失败 → stderr → 探测拿不到结论 → 归因退化成"不知道"，而不是报错。
  // 2026-09-29 就是这样在 `lockProbeCommand` 与 `windowsAclVerdictCommand` 里发现
  // `try {;` / `foreach (...) {;` 这种**空语句**（join 的分号落在左花括号后面）。
  const {
    lockProbeCommand, windowsAclVerdictCommand, windowsModifyProbeCommand,
    grantModifyAclCommand, privateFileCommand, readFileModeCommand,
  } = await import(new URL('src/host/platform/shell.ts', ROOT).href)
  // Windows 上**必须**生成命令的那些（少一个，D 层的探测/修复就缺一条腿）。
  const commands = {
    lockProbe: lockProbeCommand('C:\\Users\\x\\.dws\\.data.lock', 'win32-x64'),
    aclVerdict: windowsAclVerdictCommand('C:\\Users\\x\\.dws', 'win32-x64'),
    modifyProbeDirectory: windowsModifyProbeCommand('C:\\Users\\x\\.dws', 'directory', 'win32-x64'),
    modifyProbeFile: windowsModifyProbeCommand('C:\\Users\\x\\.dws\\.data.lock', 'file', 'win32-x64'),
    grantModifyAcl: grantModifyAclCommand('C:\\Users\\x\\.dws', 'win32-x64', { inherit: false }),
  }
  // POSIX 专用的那些在 Windows 上**必须是空**：跑 `chmod` / `stat -f` 只会拿到假结论。
  assert.equal(privateFileCommand('C:\\Users\\x\\.dws\\.data.lock', 'win32-x64'), '', 'chmod 不许出现在 Windows 命令里')
  assert.equal(readFileModeCommand('C:\\Users\\x\\.dws', 'win32-x64'), '', 'stat -f 不许出现在 Windows 命令里')
  // 生成器的**协议版本与字段**必须与 Windows 原生合同（CI 那条）看齐：
  // 合同曾经还在要 `crwu-acl/1` + `modify|partial`，而生成器早已切到 `/2` —— 那种不一致
  // 在本机看不见（没有 pwsh），只会在 CI 上红（用户复查的 P1）。这里把它钉成本地判据。
  assert.match(commands.aclVerdict, /crwu-acl\/2/, 'ACL 判决的协议版本必须是 /2')
  assert.match(commands.aclVerdict, /modify-mask=/, '判决里必须给出 modify-mask')
  assert.match(commands.aclVerdict, /ace=[^']*\$kind/, 'ACE 行必须带角色与权限位掩码')
  assert.equal(/crwu-acl\/1/.test(commands.aclVerdict), false, '不许再回旧协议 /1')

  for (const [name, command] of Object.entries(commands)) {
    assert.equal(typeof command === 'string' && command !== '', true, `${name} 应当生成命令`)
    assert.equal(/\{\s*;/.test(command), false, `${name} 左花括号后面跟了空语句：${command.slice(0, 140)}`)
    assert.equal(/;;/.test(command), false, `${name} 出现连续分号：${command.slice(0, 140)}`)
    assert.equal(/^\s*;/.test(command), false, `${name} 以分号开头：${command.slice(0, 140)}`)
    // 字符串里的括号不计入配平：先按引号剥掉。
    const stripped = command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
    for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
      const left = [...stripped].filter((ch) => ch === open).length
      const right = [...stripped].filter((ch) => ch === close).length
      assert.equal(left, right, `${name} 的 ${open}${close} 不配平（${left} vs ${right}）：${command.slice(0, 140)}`)
    }
    // `try` 必须配 `catch`：只有 try 的脚本在失败时会**静默**吞掉错误。
    if (command.includes('try')) {
      assert.equal(command.includes('catch'), true, `${name} 有 try 没有 catch`)
    }
  }
})

test('Windows 命令的引用纪律：带空格 / 中文 / 单引号的路径必须整段引用，且引号偶数', async () => {
  // 本机没有 pwsh，"路径里有空格/引号时会怎样"只能靠静态判据守住 —— 这一类真的咬过：
  // POSIX 那半的 `stat -f %u %Lp` 曾经漏引号（合同测试跑真命令才抓到）。
  const { lockProbeCommand, windowsAclVerdictCommand, windowsModifyProbeCommand, grantModifyAclCommand, shellQuote, shellInvoke } =
    await import(new URL('src/host/platform/shell.ts', ROOT).href)
  const tricky = "C:\\Users\\张 三\\O'Brien 报告\\.dws\\.data.lock"
  const quoted = shellQuote(tricky, 'win32-x64')
  // 先确认引用本身是 PowerShell 的写法：单引号包裹 + **单引号翻倍**（不是反斜杠转义）。
  assert.equal(quoted, `'C:\\Users\\张 三\\O''Brien 报告\\.dws\\.data.lock'`)

  const commands = {
    lockProbe: lockProbeCommand(tricky, 'win32-x64'),
    aclVerdict: windowsAclVerdictCommand(tricky, 'win32-x64'),
    modifyProbeFile: windowsModifyProbeCommand(tricky, 'file', 'win32-x64'),
    modifyProbeDirectory: windowsModifyProbeCommand(tricky, 'directory', 'win32-x64'),
    grantModifyAcl: grantModifyAclCommand(tricky, 'win32-x64', { inherit: false }),
  }
  for (const [name, command] of Object.entries(commands)) {
    // ① 路径必须以**引用后的形态**出现（裸路径出现就说明漏引号了）。
    assert.equal(command.includes(quoted), true, `${name} 里的路径没有被引用：${command.slice(0, 160)}`)
    assert.equal(command.includes(` ${tricky}`), false, `${name} 里出现了裸路径：${command.slice(0, 160)}`)
    // ② 单引号必须成对：手写转义（`\\'`）会让它变奇数，PowerShell 里那是一个未闭合的字符串。
    const quotes = [...command].filter((ch) => ch === "'").length
    assert.equal(quotes % 2, 0, `${name} 的单引号不成对（${quotes} 个）：${command.slice(0, 160)}`)
  }

  // ③ 命令位置：PowerShell 上第一个 token 必须是 `&`；POSIX 上**绝不能**有（`&` 是后台作业）。
  assert.match(shellInvoke('C:\\Program Files\\crwu.exe', ['a', 'b'], 'win32-x64'), /^& /)
  assert.equal(shellInvoke('C:\\Program Files\\crwu.exe', ['a', 'b'], 'win32-x64').startsWith('& &'), false)
  const posix = shellInvoke('/usr/local/bin/crwu', ['a'], 'darwin-arm64')
  assert.equal(posix.startsWith('&'), false, 'POSIX 上不许加 &（那是后台作业）')
})

test('P1/W-05 · Windows 锁探测：独占打开成功=False、共享冲突=True、ACL 拒绝=Unknown', async () => {
  // Windows 旧实现固定返回空命令 → `lockHeld` 永远不可能为 true → 验收矩阵 W-05 要求的
  // `file-lock` 分类**代码上不可达**（用户复查的 P1）。现在两边都有正向探测。
  const { lockProbeCommand, parseLockProbe } = await import(new URL('src/host/platform/shell.ts', ROOT).href)

  const win = lockProbeCommand('C:\\Users\\x\\.dws\\.data.lock', 'win32-x64')
  assert.notEqual(win, '', 'Windows 必须有锁探测命令')
  assert.match(win, /\[IO\.File\]::Open/, '必须是"独占打开"而不是别的猜测手段')
  assert.match(win, /'Read'/, '只读打开：体检不许写任何字节')
  assert.match(win, /'None'/, 'FileShare.None 才是"有没有别人持有"的判据')
  assert.match(win, /\.Close\(\)/, '句柄必须关掉')
  // 三态结论必须是**规范形态**（`locked=True|False|Unknown`）：Windows 原生合同按这一行解析，
  // 只要求'出现过 locked=' 会让那边在脚本失败（输出为空）时退化成'看不懂 = 没被占用'。
  // 三态结论必须是**规范形态**，而且**三条分支都要有**：Windows 原生合同按这一行解析，
  // 只要有一条写成别的样子，那一种现场就会被合同读成「看不懂」（进而当成「没被占用」）。
  for (const value of ['True', 'False', 'Unknown']) {
    assert.match(win, new RegExp(`locked=${value}`), `缺 locked=${value} 这条结论`)
  }
  // ⚠️ **必须沿 InnerException 解包再读 HResult**（用户复查的 P1）：PowerShell 调用 .NET 方法
  // 抛出的 IOException 会被 `MethodInvocationException` 包住，共享冲突码 32/33 在内层异常里；
  // 读外层 `$_.Exception.HResult` 会让"真的有进程持锁"也落到 Unknown —— W-05 依旧归不了 file-lock。
  assert.match(win, /InnerException/, '锁探测必须沿 InnerException 解包到根异常')
  // 解包循环必须真的会跑：计数器从 0 起、判据有上限、每一步都往里走一层。
  assert.match(win, /\$depth = 0/, '解包循环的计数器要从 0 起（否则一层都不解）')
  assert.match(win, /while \(\$depth -lt \d+\)/, '解包循环要有明确上限')
  assert.match(win, /\$e = \$e\.InnerException/, '每一步要真的往里走一层')
  assert.match(win, /if \(\$null -eq \$e\.InnerException\) \{ break \}/, '到底了就停')
  // HResult 必须从**解包后的** `$e` 上读，而不是外层包装。
  assert.match(win, /\$hr = \$e\.HResult -band 0xFFFF/, 'HResult 要从根异常读')
  assert.equal(/\$_.Exception\.HResult/.test(win), false,
    '不许直接读外层异常的 HResult（那是 MethodInvocationException 的）')
  assert.match(win, /UnauthorizedAccessException/, 'ACL 拒绝要单独识别（不许混成"锁被占用"）')
  assert.match(win, /\$hr -eq 32/, '共享冲突码 32 才算持锁')

  // 三态解析：True / False / Unknown（ACL 拒绝）三件事必须分开。
  assert.equal(parseLockProbe({ exitCode: 0, stdout: 'locked=True\n', error: '' }), true)
  assert.equal(parseLockProbe({ exitCode: 0, stdout: 'locked=False\n', error: '' }), false)
  assert.equal(parseLockProbe({ exitCode: 0, stdout: 'locked=Unknown\n', error: '' }), undefined,
    'ACL 拒绝是权限问题，不许说成"锁被占用"')
  // 命令没跑起来 / 没有 pwsh → 不知道（而不是"没被占用"）。
  assert.equal(parseLockProbe({ exitCode: 127, stdout: '', error: '' }), undefined)
  assert.equal(parseLockProbe({ exitCode: 0, stdout: '', error: 'pwsh 起不来' }), undefined)
  // POSIX 形态不变（退出码 1 + 空输出 = 正向的"没被占用"）。
  assert.equal(parseLockProbe({ exitCode: 1, stdout: '', error: '' }), false)
  assert.equal(parseLockProbe({ exitCode: 0, stdout: '1234\n', error: '' }), true)
  assert.equal(parseLockProbe({ exitCode: 0, stdout: '', error: '' }), false)
})

test('P2 · doctor 路径：原始失败与锁无关时，即使有人持锁也不许报 file-lock', async () => {
  // 用户复查的 P2 在 doctor 路径上的形态：doctor 手里的 `text` 是**本次体检**的输出，
  // 不是原来那次失败的文本。所以它必须用 Broker 记下来的脱敏事实 `lockRelated`；
  // 只看"现在有人持锁"就会把一次认证失败说成文件锁。
  const harness = makeDeps({
    shell: (command) => {
      if (command.includes('lsof')) return { exitCode: 0, stdout: '4321\n' }   // 确实有人持锁
      if (command.includes('stat ')) return { stdout: '501 700\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 0, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  // 原始失败是**认证**类（与锁无关）：这一条记进诊断时 `lockRelated=false`。
  await causeFailure(harness, { stdout: 'not authenticated: please run dws auth login', stderr: 'not authenticated' })
  const view = await dwsLocalDoctor(harness.deps)
  assert.equal(view.lockExists, true)
  assert.notEqual(view.classification, 'file-lock', `无关失败不许归因文件锁：${view.classification}`)

  // 对照：同一台机器、同一次持锁，原始失败**是**锁相关时，必须报 file-lock。
  const lockish = makeDeps({
    shell: (command) => {
      if (command.includes('lsof')) return { exitCode: 0, stdout: '4321\n' }
      if (command.includes('stat ')) return { stdout: '501 700\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 0, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  await causeFailure(lockish, { stderr: 'opening lock file /Users/x/.dws/.data.lock: Access is denied' })
  const lockishView = await dwsLocalDoctor(lockish.deps)
  assert.equal(lockishView.classification, 'file-lock', `锁相关失败 + 持锁必须报 file-lock：${lockishView.classification}`)
})

test('P1/W-05 · Windows：有进程持锁时 doctor 必须判 file-lock（可复现的现场）', async () => {
  const harness = makeDeps({
    platform: 'win32-x64',
    exists: ['C:\\Users\\x\\.dws', 'C:\\Users\\x\\.dws\\.data.lock'],
    shell: (command) => {
      if (command.includes('Get-Acl')) {
        // ACL 说当前账户**有**写权限 —— 说明"写不进去"不是权限问题，只能是锁。
        return { stdout: `crwu-acl/2\nowner=True\nmodify-mask=${MODIFY}\nace=allow:self:${MODIFY}\n` }
      }
      if (command.includes('[IO.File]::Open')) return { stdout: 'locked=True\n' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      if (command.includes('stat ')) return { stdout: '501 755\n' }
      return { stdout: '' }
    },
  })
  await causeFailure(harness, { text: '.data.lock: Access is denied', stderr: '.data.lock: Access is denied' })
  const view = await dwsLocalDoctor({ ...harness.deps, home: 'C:\\Users\\x' })
  assert.equal(view.currentUserCanModify, true, 'ACL 判决说可改')
  assert.equal(view.classification, 'file-lock', `应当是文件锁：${view.classification}`)
})

test('P2 · 锁文件存在 ≠ 锁被占用：没有正向探测就不许判 file-lock', async () => {
  // 残留的锁文件与"真有进程握着它"看着完全一样，而处置完全不同。
  const harness = makeDeps({
    shell: (command) => {
      if (command.includes('stat ')) return { stdout: '501 755\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 0, stdout: '' }
      // 锁探测（`lsof`）**跑不起来**：拿不到结论。
      if (command.startsWith('lsof')) return { exitCode: 127, stderr: 'lsof: command not found', stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  await causeFailure(harness, { text: '.data.lock: Access is denied', stderr: '.data.lock: Access is denied' })
  const view = await dwsLocalDoctor(harness.deps)
  assert.equal(view.lockExists, true, '锁文件确实在')
  assert.notEqual(view.classification, 'file-lock', '文件在 ≠ 被占用：没有正向探测就不许定性')
})

test('P2 · 锁探测明确"没有进程持有"时也不判 file-lock', async () => {
  const harness = makeDeps({
    shell: (command) => {
      if (command.includes('stat ')) return { stdout: '501 755\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 0, stdout: '' }
      // `lsof` 退出码 1 + 空输出 = 正向的"没人持有"。
      if (command.startsWith('lsof')) return { exitCode: 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  await causeFailure(harness, { text: '.data.lock: Access is denied', stderr: '.data.lock: Access is denied' })
  const view = await dwsLocalDoctor(harness.deps)
  assert.notEqual(view.classification, 'file-lock')
})

test('D2 · 员工可见的失败原因里不许出现绝对路径（保留错误本身，路径换成 <路径>）', async () => {
  // `chmod` / fs 的错误消息自带路径；doctor 视图与凭据卡片都会显示它。
  // 按 §4.6 第 3 条，凭据文件路径与主目录只在开发者诊断里展开。
  const { redactPaths } = await import(new URL('src/host/platform/redact.ts', ROOT).href)
  assert.equal(
    redactPaths("chmod: /Users/mungdong/.ossutilconfig: Operation not permitted"),
    'chmod: <路径>: Operation not permitted',
  )
  assert.equal(
    redactPaths("EACCES: permission denied, stat '/Users/mungdong/.dws'"),
    "EACCES: permission denied, stat '<路径>'",
  )
  assert.equal(
    redactPaths('icacls C:\\Users\\张三\\.dws 失败'),
    'icacls <路径> 失败',
  )
  // 错误本身必须留着：丢掉原因比多一个路径更难查。
  assert.match(redactPaths("chmod: /Users/x/.ossutilconfig: Operation not permitted"), /Operation not permitted/)
  assert.match(redactPaths("EACCES: permission denied, stat '/Users/x/.dws'"), /permission denied/)
  // 普通文本 / 命令词原样保留（别把说明文字也换掉）。
  assert.equal(redactPaths('DWS 目录是符号链接：拒绝沿着链接修改权限'), 'DWS 目录是符号链接：拒绝沿着链接修改权限')
  assert.equal(redactPaths('chmod 600 没有回读到预期模式'), 'chmod 600 没有回读到预期模式')
  assert.equal(redactPaths(''), '')

  // 接上真实路径：stat 抛错时 doctor 的 error 里不能出现主目录。
  const harness = makeDeps({ statThrows: true })
  // 设计 D2：体检只在「刚刚发生过一次 DWS 失败、且结构化事实排除沙箱」之后运行。
  await causeFailure(harness)
  const view = await dwsLocalDoctor(harness.deps)
  assert.equal(view.ok, false)
  assert.equal(view.error.includes(HOME), false, `错误里不该出现主目录：${view.error}`)
  assert.equal(view.error.includes('<路径>'), true, `路径应当被换成 <路径>：${view.error}`)
  assert.match(view.error, /permission denied/, '错误本身必须留着（丢掉原因更难查）')
})

test('P1 · `stat` 抛错是"探测失败"，**不许**说成"目录不存在"', async () => {
  // Windows 上 `Access is denied` 会让旧实现（catch 一律 return exists:false）报
  // 「.dws 不存在，请先登录一次」—— 目录就在那里，只是我们看不见。
  const harness = makeDeps({ statThrows: true })
  // 设计 D2：体检只在「刚刚发生过一次 DWS 失败、且结构化事实排除沙箱」之后运行。
  await causeFailure(harness)
  const view = await dwsLocalDoctor(harness.deps)
  assert.equal(view.ok, false)
  assert.equal(view.classification, 'infrastructure')
  assert.match(view.error, /无法确认|探测/)
  assert.notEqual(view.directoryExists, false, '读不到 ≠ 不存在')
  assert.equal(view.directoryExists, null)
})

test('P1 · 确认不了目录类型时**拒绝修权限**（不是"当成不是符号链接"）', async () => {
  const harness = makeDeps({ lstatThrows: true })
  await causeFailure(harness)
  const result = await dwsLocalPermissionRepair(harness.deps, { confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.repaired.length, 0, '拿不到事实就不许动手')
  assert.equal(harness.commands.some((c) => /chmod|icacls/.test(c)), false, '一个改权限的命令都不许发')
})

test('P1 · 未授权时体检**一个 fs / shell 调用都不发**（P-11 的 Host 侧边界）', async () => {
  // 界面把入口挡住只是体验：直接调 RPC 也必须读不到任何本机事实。
  const harness = makeDeps({ consent: 'missing' })
  // 设计 D2：体检只在「刚刚发生过一次 DWS 失败、且结构化事实排除沙箱」之后运行。
  await causeFailure(harness)
  const view = await dwsLocalDoctor(harness.deps)
  assert.equal(view.ok, false)
  assert.equal(view.classification, 'not-authorized')
  assert.match(view.error, /本机访问|允许/)
  assert.equal(harness.commands.length, 0, `未授权不许起任何命令：${harness.commands.join(' · ')}`)
  assert.equal(harness.fsCalls.length, 0, `未授权不许 stat 任何路径：${harness.fsCalls.join(' · ')}`)
  // 视图里也不能泄露"目录在不在"。
  assert.equal(view.directoryExists, null)
  assert.equal(view.lockExists, null)
})

test('P-15 · 探测**自己**被沙箱拦下时：不许说成"操作系统权限问题"（改权限解决不了它）', async () => {
  // 2026-09-29 在真机上抓到：`~/.dws` 是 700、属主就是当前用户，但在**受限 shell** 里
  // `test -w` 依然回 1（沙箱拦的）。把这种结果当成操作系统权限问题，就会给员工一个
  // 按下去真会改权限的按钮 —— 而真正的原因在宿主/部署那一层。
  const harness = makeDeps({
    sandboxDown: true,
    shell: (command) => {
      if (command.includes('stat ')) return { stdout: '501 700\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  const { deps } = harness
  await causeFailure(harness) // 先有一次真实失败（这样才走"重新归因"那条路）
  // causeFailure 用的也是"沙箱被降级"的事实：整体结论应当是沙箱类，不是 os-*。
  const view = await dwsLocalDoctor(deps)
  assert.equal(view.currentUserCanModify, null, '被沙箱拦下的探测只能说"不知道"')
  assert.notEqual(view.classification, 'os-filesystem-permission')
  assert.equal(['sandbox-denied', 'sandbox-downgraded'].includes(view.classification), true,
    `应当报沙箱类结论，实际 ${view.classification}`)
  // 于是修复**不会**被渲染（`repairOffered` 只看 classification），也不会被执行。
  const result = await dwsLocalPermissionRepair(deps, { confirm: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /沙箱|降级|没有确诊/)
  assert.equal(harness.commands.some((c) => /chmod|icacls/.test(c)), false, '沙箱问题绝不许改文件权限')
})

// ── D-04 修复的双前置 ──────────────────────────────────────────────────────

test('D-04 · 参数形状不对时**一条命令都不跑**（确认是必需的，夹带是不允许的）', async () => {
  for (const args of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }, { confirm: true, path: '/tmp' }, { confirm: true, force: true }]) {
    const { deps, commands } = makeDeps({ shell: posixShell })
    const result = await dwsLocalPermissionRepair(deps, args)
    assert.equal(result.ok, false, JSON.stringify(args))
    assert.deepEqual(result.repaired, [])
    assert.match(result.error, /confirm: true/)
    assert.deepEqual(commands, [], `被拒时不许执行任何命令：${JSON.stringify(args)}`)
  }
})

test('D-04 · 没有确诊"本机文件权限问题"时也不动手（哪怕目录确实不可写）', async () => {
  // 目录不可写，但**没有任何** DWS 失败诊断。设计 §D2 的前置条件在这一层更早就拦住了：
  // 体检只在"刚刚发生过一次 DWS 失败"之后才跑，所以这里连确诊都拿不到 ——
  // 拒绝理由就是"还没有可以归因的失败"，而不是笼统的"没有确诊"。
  const { deps, commands } = makeDeps({
    shell: (command) => {
      if (command.includes('stat ')) return { stdout: '501 755\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  const result = await dwsLocalPermissionRepair(deps, { confirm: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有可以归因|没有确诊/)
  assert.equal(commands.some((c) => /chmod|icacls/.test(c)), false)
})

test('D-05 · 结论不是"本机文件权限问题"时绝不改权限（沙箱拒绝 / 所有者不对）', async () => {
  // ① 上一次失败是**沙箱拒绝**（结构化事实说了算）→ 不修，而且一条写命令都不许跑。
  const sandboxDenied = makeDeps({
    sandboxDown: true,
    shell: (command) => {
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      return posixShell(command)
    },
  })
  // 沙箱降级的现场：这条失败的结构化事实说明它是被沙箱拦下的，而不是文件权限。
  await causeFailure(sandboxDenied)
  const denied = await dwsLocalPermissionRepair(sandboxDenied.deps, { confirm: true })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /沙箱/)
  assert.equal(sandboxDenied.commands.some((c) => /chmod|icacls/.test(c)), false, '沙箱问题不许改文件权限')

  // ② 目录不可写但**所有者不是当前账户** → 拒绝，并指向管理员（不做 chown）。
  const wrongOwner = makeDeps({
    shell: (command) => {
      if (command.includes('stat ')) return { stdout: '0 700\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  await causeFailure(wrongOwner)
  const refused = await dwsLocalPermissionRepair(wrongOwner.deps, { confirm: true })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /所有者/)
  assert.deepEqual(refused.repaired, [])
  assert.equal(wrongOwner.commands.some((c) => /chmod|chown|sudo/.test(c)), false, '不许 chown / sudo')
})

// ── D-05 / D-07 真正修的时候：只动该动的 ───────────────────────────────────

test('D-07 · macOS：目录 0700、锁文件 0600，**不** chown、**不**删锁、不碰父目录', async () => {
  const harness = makeDeps({
    shell: (command, after) => {
      const isLock = command.includes('.data.lock')
      if (command.includes('stat ')) {
        // 修复前 755 / 644；修复命令跑过之后回读 700 / 600（真实世界会变，夹具必须跟着变）。
        // ⚠️ 形状必须是 `uid mode`：只回模式会让"属主是谁"读成一个假的 uid（2026-09-29 踩到）。
        if (isLock) return { stdout: after === true ? '501 600\n' : '501 644\n' }
        return { stdout: after === true ? '501 700\n' : '501 755\n' }
      }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: after === true ? 0 : 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      if (command.includes(' auth status ')) return { stdout: '{"authenticated":false}' }
      return { stdout: '' }
    },
  })
  const { deps, commands } = harness
  await causeFailure(harness)
  commands.length = 0
  const result = await dwsLocalPermissionRepair(deps, { confirm: true })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.repaired, ['directory-mode', 'lock-mode'])
  const writes = commands.filter((c) => /chmod|icacls/.test(c))
  assert.equal(writes.length, 2)
  assert.equal(writes[0], `chmod 700 ${DWS_DIR}`)
  assert.equal(writes[1], `chmod 600 ${LOCK}`)
  for (const command of commands) {
    assert.equal(/\bchown\b|takeown|sudo/.test(command), false, `不许改所有权：${command}`)
    assert.equal(command.includes('.data.lock') && /rm |del |unlink/.test(command), false, '不许删锁文件')
    assert.equal(command.includes('/Users/x ') || command.endsWith('/Users/x'), false, '不许动父目录')
  }
  // 修完必须**重新体检**（回读模式就是"修好了没有"的判据）。
  assert.equal(commands.filter((c) => c.includes(' doctor ')).length, 2)
})

test('D-07 · 符号链接一律拒绝（不沿着链接改权限）', async () => {
  const harness = makeDeps({
    symlinks: [DWS_DIR],
    shell: (command) => {
      if (command.includes('stat ')) return { stdout: '501 755\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  const { deps, commands } = harness
  await causeFailure(harness)
  const result = await dwsLocalPermissionRepair(deps, { confirm: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /符号链接/)
  assert.equal(commands.some((c) => /chmod|icacls/.test(c)), false)
})

test('D-03/D-05 · 已经确诊但目录不存在时不修（先让员工完成一次登录）', async () => {
  // 先有"目录在、改不了"的失败诊断（确诊成立），再让它消失 —— 修复必须停在"没有可修复的对象"。
  const harness = makeDeps({
    shell: (command) => {
      if (command.includes('stat ')) return { stdout: '501 755\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  await causeFailure(harness)
  const { deps, commands } = harness
  // 诊断锁定之后再把目录拿掉（模拟"诊断与修复之间状态变了"）。
  harness.removePath(`${HOME}/.dws`)
  const result = await dwsLocalPermissionRepair(deps, { confirm: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /目录不存在/)
  assert.equal(commands.some((c) => /chmod|icacls/.test(c)), false)
})

test('修复的 ok 由**回读**决定：命令退出码 0 但模式没变时必须报失败', async () => {
  // `chmod` 在网络盘 / 只读挂载上会**静默无效**（退出码 0、模式没变）。把"命令跑过了"
  // 说成"修好了"，正是设计 §2 那张表里点名的"把结果报得比事实好"。
  const harness = makeDeps({
    shell: (command, after) => {
      // 修复之后的体检：目录模式仍是 755（chmod 没生效），其余照常。
      if (command.includes('stat ')) return { stdout: after === true ? '501 755\n' : '501 755\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      if (command.includes(' auth status ')) return { stdout: '{"authenticated":false}' }
      return { stdout: '' }
    },
  })
  await causeFailure(harness)
  harness.enterAfterPhase()
  const result = await dwsLocalPermissionRepair(harness.deps, { confirm: true })
  assert.equal(result.repaired.length > 0, true, '命令确实执行了')
  assert.equal(result.ok, false, '回读对不上时必须报失败')
  assert.match(result.error, /回读/)
  assert.equal(result.doctor.directoryMode, '755', '如实带回回读到的模式')
})

test('修复正常时 ok 为真，且回读到的模式就是收紧后的', async () => {
  const harness = makeDeps({
    shell: (command, after) => {
      if (command.includes('stat ')) {
        // 修复前 755；修复命令跑过之后回读 700。
        const isLock = command.includes('.data.lock')
        if (!isLock) return { stdout: after === true ? '501 700\n' : '501 755\n' }
        return { stdout: after === true ? '600\n' : '644\n' }
      }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: after === true ? 0 : 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      if (command.includes(' auth status ')) return { stdout: '{"authenticated":false}' }
      return { stdout: '' }
    },
  })
  await causeFailure(harness)
  // **不**手工切阶段：世界在 `chmod` 真的跑过那一刻才变（夹具自己认那条命令）。
  // 手工切会让"确诊那一次探测"也看到已修好的状态，连确诊都过不去。
  const result = await dwsLocalPermissionRepair(harness.deps, { confirm: true })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.doctor.directoryMode, '700')
  assert.equal(result.doctor.lockMode, '600')
})

test('拿不到"探测自己在完全访问下"的证据时，只能说"不知道"（fail closed）', async () => {
  // DSH 没回 `ran` / `resolved` 时**不许**把探测结论当操作系统事实：
  // 说"不知道"只是少帮一次；说"是权限问题"会给员工一个真会改权限的按钮。
  const harness = makeDeps({
    shell: (command) => {
      if (command.includes('stat ')) return { stdout: '501 755\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  // 服务不回模式 = 拿不到证据（不等于「跑在完全访问下」）。
  harness.setSandbox({ mode: '', denied: false, runnerFailed: false })
  await causeFailure(harness)
  const view = await dwsLocalDoctor(harness.deps)
  assert.equal(view.currentUserCanModify, null, '没有正向证据时不许说"不行"')
  assert.notEqual(view.classification, 'os-filesystem-permission')
})

// ── D-08 钥匙串问题绝不触发文件权限修复 ────────────────────────────────────

test('D-08 · macOS 钥匙串拒绝 → 结论是 os-credential-store，修复被拒', async () => {
  const harness = makeDeps({
    shell: (command) => {
      if (command.includes('stat ')) return { stdout: '501 700\n' }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_KEYCHAIN_DENIED }
      return { stdout: '' }
    },
  })
  const { deps, commands } = harness
  await causeFailure(harness)
  const view = await dwsLocalDoctor(deps)
  assert.equal(view.credentialStoreState, 'interaction-denied')
  assert.equal(view.classification, 'os-credential-store')
  const result = await dwsLocalPermissionRepair(deps, { confirm: true })
  assert.equal(result.ok, false)
  assert.equal(commands.some((c) => /chmod|icacls/.test(c)), false, '钥匙串问题不许改文件权限')
})

// ── Windows 分支：命令形状与"不回身份信息" ─────────────────────────────────

test('P1/P2 · Windows ACL 按**有效权限**算：组权限算数、Deny 优先、**部分 Deny 也算数**', () => {
  // 旧实现有两个洞：只找"当前用户 SID 的 Allow"（组权限看不见），
  // 以及只否决"整条 Modify 位集被 Deny"（部分 Deny 被忽略）。两者都会把"其实写不进去"
  // 判成可改 —— 于是 doctor 报可写、修复入口不出现。
  // 数值取自官方 `FileSystemRights`（见文件顶部的 MODIFY / FULL_CONTROL）。
  const WRITE = 0x116           // WriteData(0x2) | AppendData(0x4) | WriteAttributes(0x100) | WriteEA(0x10)
  const DELETE = 0x10000
  const head = `crwu-acl/2\nowner=True\nmodify-mask=${MODIFY}\n`

  // ① 只有组有 Modify → 有效权限成立（域里最常见的授权方式）。
  assert.deepEqual(parseAclVerdict(`${head}ace=allow:group:${MODIFY}\n`), { owner: true, modify: true })
  // ② 自己 Allow + 组 Deny 整条 Modify → Deny 优先，不成立。
  assert.deepEqual(
    parseAclVerdict(`${head}ace=allow:self:${MODIFY}\nace=deny:group:${MODIFY}\n`),
    { owner: true, modify: false },
  )
  // ③ **部分 Deny**：Allow 了整条 Modify，但 Deny 只覆盖 Write 位 → 依然不成立。
  //    这就是用户复查的 P2（旧实现把这条 Deny 标成 partial 后整个忽略）。
  assert.deepEqual(
    parseAclVerdict(`${head}ace=allow:self:${MODIFY}\nace=deny:self:${WRITE}\n`),
    { owner: true, modify: false },
    '只 Deny 写权限也必须让"可改"不成立',
  )
  // ④ 只 Deny 删除 → 同样不成立。
  assert.deepEqual(
    parseAclVerdict(`${head}ace=allow:self:${MODIFY}\nace=deny:self:${DELETE}\n`),
    { owner: true, modify: false },
  )
  // ④b FullControl 也要走同一套算术（它是真实目录最常见的形态）：
  //     整条 FullControl + 只 Deny 写位 → 依然"不可改"。
  assert.deepEqual(
    parseAclVerdict(`crwu-acl/2\nowner=True\nmodify-mask=${FULL_CONTROL}\nace=allow:self:${FULL_CONTROL}\nace=deny:self:${WRITE}\n`),
    { owner: true, modify: false },
    'FullControl 目录上只 Deny 写位同样要判不可改',
  )
  // ④c 而 FullControl 且**没有任何 Deny** → 可改（不能因为位集更大就判死）。
  assert.deepEqual(
    parseAclVerdict(`crwu-acl/2\nowner=True\nmodify-mask=${FULL_CONTROL}\nace=allow:self:${FULL_CONTROL}\n`),
    { owner: true, modify: true },
  )

  // ⑤ Deny 的是**别的**位（例如只读相关）→ 覆盖仍然成立。
  assert.deepEqual(
    parseAclVerdict(`${head}ace=allow:self:${MODIFY}\nace=deny:self:1\n`),
    { owner: true, modify: true },
  )
  // ⑥ 别人的 Allow 与我们无关。
  assert.deepEqual(parseAclVerdict(`${head}ace=allow:other:${MODIFY}\n`), { owner: true, modify: false })
  // ⑦ 拿不到判决（旧格式 / 缺 modify-mask / 空输出）→ `null` = 不知道，不许当成"可以改"。
  assert.deepEqual(parseAclVerdict('crwu-acl/1\nowner=True\nace=allow:self:modify\n'), { owner: null, modify: null })
  assert.deepEqual(parseAclVerdict(`crwu-acl/2\nowner=True\nace=allow:self:${MODIFY}\n`), { owner: true, modify: null })
  assert.deepEqual(parseAclVerdict(''), { owner: null, modify: null })
})

test('P1 · Windows 修复的回读由**真的写一次**决定（ACE 推断不算数）', async () => {
  // 显式 Deny 还在时，新增 Allow 之后 `icacls` 会回退出码 0；只有真去写才知道没生效。
  const harness = makeDeps({
    platform: 'win32-x64',
    exists: ['C:\\Users\\x\\.dws', 'C:\\Users\\x\\.dws\\.data.lock'],
    shell: (command) => {
      if (command.includes('Get-Acl')) {
        // 确诊：显式 Deny 压掉了当前账户的写权限（旧实现看不见 Deny，会报"能改"）。
        return { stdout: `crwu-acl/2\nowner=True\nmodify-mask=${MODIFY}\nace=allow:self:${MODIFY}\nace=deny:self:${MODIFY}\n` }
      }
      if (command.startsWith('icacls')) return { exitCode: 0, stdout: '已成功处理 1 个文件' }
      // 写实测：目录探测失败（Deny 还在），锁文件探测成功。
      if (command.includes('crwu-write-probe')) return { stdout: 'modify=False' }
      // ⚠️ 两条命令都含 `[IO.File]::Open`（写实测用 'Write'、锁探测用 'Read'），
      // 夹具必须按共享模式区分，否则锁探测会吃掉写实测的回放（踩过一次）。
      if (command.includes("[IO.File]::Open") && command.includes("'Write'")) return { stdout: 'modify=True' }
      if (command.includes("[IO.File]::Open") && command.includes("'Read'")) return { stdout: 'locked=False' }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  await causeFailure(harness)
  // `home` 用 Windows 形态（目录名与 `exists` 里的键逐字对上，否则体检会说"目录不存在"）。
  const result = await dwsLocalPermissionRepair({ ...harness.deps, home: 'C:\\Users\\x' }, { confirm: true })
  assert.equal(result.repaired.length > 0, true, '命令确实执行了')
  assert.equal(result.ok, false, '真去写还是不行 → 不能说修好了')
  // 锁文件那一项探成功、目录那一项失败 → 整次仍判失败（逐项都要成立）。
  assert.equal(harness.commands.some((c) => c.includes('crwu-write-probe')), true, '必须真的建过一次临时文件')
})

test('P1 · `stat` 只回模式（形状不对）时：属主是**不知道**，不许断言"不是当前账户"', async () => {
  // 用户复查第 3 条时被夹具当场抓到的一个真缺陷：`parseOwnerMode` 把第一个 token 当 uid、
  // 第二个当 mode，于是**只有模式**的输出（`644`）被读成"uid=644" → 与当前账户不等 →
  // 结论变成"这个文件不是你的"，修复直接跳过 —— 那不是安全，是把**可修的问题变成不可修的**。
  // 形状不对时唯一诚实的结论是"不知道"（`null`），既不能据此说"是你的"，也不能说"不是你的"。
  const harness = makeDeps({
    shell: (command) => {
      if (command.includes('doctor')) return { stdout: DOCTOR_JSON }
      if (command.startsWith('test -w')) return { exitCode: 1, stdout: '' }
      if (command === 'id -u') return { stdout: '501\n' }
      // 形状不对：只有模式，没有 uid。
      if (command.includes('stat ')) return { stdout: '755\n' }
      if (command.includes('chmod ')) return { exitCode: 0, stdout: '' }
      return { stdout: '' }
    },
  })
  await causeFailure(harness)
  const view = await dwsLocalDoctor(harness.deps)
  assert.equal(view.ownerMatchesCurrentUser, null, '形状不对时属主只能是"不知道"，不许断言"不是本人"')
  assert.equal(view.lockOwnerMatchesCurrentUser, null, '锁文件同理')

  const result = await dwsLocalPermissionRepair(harness.deps, { confirm: true })
  assert.equal(/所有者/.test(result.error), false, `不许因为一次形状不对的读取就拒绝修复：${result.error}`)
  assert.equal(result.skipped.includes('lock-not-owner'), false, '不许因为形状不对就跳过锁文件')
})

test('P1 · 目录正常、只有 `.data.lock` 不可写：体检要确诊，修复只动锁文件（POSIX）', async () => {
  // 用户复查给的现场：`.dws` 目录可写，`.data.lock` 没有被任何进程持有，**只有锁文件**写不进去，
  // DWS 报 `opening lock file ... Access is denied`。旧实现只看目录 → `currentUserCanModify=true`、
  // 没有 `filesystemAccessDenied` → 归因退化成 `cli` → 修复入口永远不出现，最初那道错永远修不掉。
  const harness = makeDeps({
    shell: (command) => {
      if (command.includes('doctor')) return { stdout: DOCTOR_JSON }
      if (command.startsWith('test -w')) {
        // 目录可写；**锁文件**不可写（这就是那一次的现场）。
        return command.includes('.data.lock') ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: '' }
      }
      if (command === 'id -u') return { stdout: '501\n' }
      if (command.includes('stat ')) {
        // 两者属主都是当前账户；模式也已是最小权限（所以问题不在模式，而在"写不进去"）。
        return { stdout: command.includes('.data.lock') ? '501 600\n' : '501 700\n' }
      }
      if (command.includes('lsof')) return { exitCode: 1, stdout: '' }  // 没有任何进程持有
      if (command.includes('chmod ')) return { exitCode: 0, stdout: '' }
      return { stdout: '' }
    },
  })
  await causeFailure(harness)
  const view = await dwsLocalDoctor(harness.deps)
  assert.equal(view.currentUserCanModify, true, '目录本身是可写的')
  assert.equal(view.lockWritable, false, '锁文件自身不可写必须如实报出来')
  assert.equal(view.classification, 'os-filesystem-permission', `应当确诊本机文件权限问题：${view.classification}`)

  // 修复：**只**动锁文件，不许顺手把正常的目录也改一遍。
  const before = harness.commands.length
  const result = await dwsLocalPermissionRepair(harness.deps, { confirm: true })
  const issued = harness.commands.slice(before)
  const writes = issued.filter((command) => /chmod|icacls/.test(command))
  assert.equal(writes.length, 1, `只许有一条写命令：${writes.join(' · ')}`)
  assert.equal(writes[0].includes('.data.lock'), true, `写命令必须指向锁文件：${writes[0]}`)
  assert.equal(writes[0].includes('600'), true, `锁文件目标模式是 600：${writes[0]}`)
  assert.equal(result.repaired.includes('lock-mode'), true, `应当修了锁文件：${JSON.stringify(result.repaired)}`)
  assert.equal(result.repaired.includes('directory-mode'), false, '目录正常就不许改目录')
  assert.deepEqual(result.skipped, ['directory-mode-ok'], `目录应记为"正常、未动"：${JSON.stringify(result.skipped)}`)
})

test('P1 · 目录 ACL 正常、只有锁文件 ACL 不可写：修复只给锁文件授权（Windows）', async () => {
  const harness = makeDeps({
    platform: 'win32-x64',
    exists: ['C:\\Users\\x\\.dws', 'C:\\Users\\x\\.dws\\.data.lock'],
    shell: (command) => {
      if (command.includes('Get-Acl')) {
        // 目录：当前账户有写权限；锁文件：被显式 Deny 压掉写位。
        return command.includes('.data.lock')
          ? { stdout: `crwu-acl/2\nowner=True\nmodify-mask=${MODIFY}\nace=allow:self:${MODIFY}\nace=deny:self:${MODIFY}\n` }
          : { stdout: `crwu-acl/2\nowner=True\nmodify-mask=${MODIFY}\nace=allow:self:${MODIFY}\n` }
      }
      if (command.includes("[IO.File]::Open") && command.includes("'Read'")) return { stdout: 'locked=False\n' }
      if (command.includes("[IO.File]::Open") && command.includes("'Write'")) return { stdout: 'modify=True\n' }
      if (command.includes('doctor')) return { stdout: DOCTOR_JSON }
      if (command.includes('icacls')) return { exitCode: 0, stdout: '' }
      return { stdout: '' }
    },
  })
  await causeFailure(harness)
  const view = await dwsLocalDoctor({ ...harness.deps, home: 'C:\\Users\\x' })
  assert.equal(view.currentUserCanModify, true, '目录 ACL 说可改')
  assert.equal(view.lockWritable, false, '锁文件 ACL 必须单独判')
  assert.equal(view.classification, 'os-filesystem-permission', `应当确诊：${view.classification}`)

  const before = harness.commands.length
  const result = await dwsLocalPermissionRepair({ ...harness.deps, home: 'C:\\Users\\x' }, { confirm: true })
  const issued = harness.commands.slice(before)
  const grants = issued.filter((command) => command.includes('icacls'))
  assert.equal(grants.length, 1, `只许有一条 icacls 授权：${grants.join(' · ')}`)
  assert.equal(grants[0].includes('.data.lock'), true, `授权必须指向锁文件：${grants[0]}`)
  assert.equal(result.repaired.includes('lock-acl'), true, `应当修了锁文件：${JSON.stringify(result.repaired)}`)
  assert.equal(result.repaired.includes('directory-acl'), false, '目录正常就不许改目录')
})

test('D-06 · Windows：走 ACL 判决，返回体里没有 SID / 账户名 / ACL 条目', async () => {
  const harness = makeDeps({
    platform: 'win32-x64',
    exists: [`C:\\Users\\x\\.dws`],
    shell: (command) => {
      // 协议 18 的判决格式：标签化 ACE（不含 SID / 账户名），"Deny 优先"由纯函数复算。
      // `0x1F01BF` = Modify 的位组合（`parseAclVerdict` 里的 MODIFY_BITS）。
      if (command.includes('Get-Acl')) {
        return { stdout: `crwu-acl/2\nowner=True\nmodify-mask=${MODIFY}\nace=allow:other:${MODIFY}\n` }
      }
      if (command.includes(' doctor ')) return { stdout: DOCTOR_JSON }
      return { stdout: '' }
    },
  })
  const { deps, commands } = harness
  // 设计 D2：体检只在「刚刚发生过一次 DWS 失败、且结构化事实排除沙箱」之后运行。
  await causeFailure(harness)
  const view = await dwsLocalDoctor({ ...deps, home: 'C:\\Users\\x' })
  assert.equal(view.permissionMechanism, 'windows-acl')
  assert.equal(view.ownerMatchesCurrentUser, true)
  assert.equal(view.currentUserCanModify, false)
  assert.equal(view.directoryMode, '', 'Windows 没有 POSIX 模式位，必须留空')
  const aclCommand = commands.find((c) => c.includes('Get-Acl'))
  assert.ok(aclCommand.includes('Write-Output'), '判决由脚本自己算，不回原始 ACL')
  assert.equal(JSON.stringify(view).includes('S-1-5-21'), false)
})

test('POSIX 上不会去跑 Windows 的 ACL 判决，反之亦然', async () => {
  const mac = makeDeps({ shell: posixShell })
  // 设计 D2：体检只在「刚刚发生过一次 DWS 失败、且结构化事实排除沙箱」之后运行。
  await causeFailure(mac)
  await dwsLocalDoctor(mac.deps)
  assert.equal(mac.commands.some((c) => c.includes('Get-Acl') || c.includes('icacls')), false)

  const win = makeDeps({
    platform: 'win32-x64',
    exists: ['C:\\Users\\x\\.dws'],
    shell: (command) => (command.includes('Get-Acl')
      ? { stdout: `crwu-acl/2\nowner=True\nmodify-mask=${MODIFY}\nace=allow:self:${MODIFY}\n` }
      : { stdout: DOCTOR_JSON }),
  })
  await causeFailure(win)
  await dwsLocalDoctor({ ...win.deps, home: 'C:\\Users\\x' })
  assert.equal(win.commands.some((c) => /^(stat|id) /.test(c)), false, 'Windows 上不许跑 POSIX stat')
})

test('不支持 / 拿不到主目录的平台：结构化失败，不猜路径', async () => {
  const harness = makeDeps({ shell: posixShell })
  const { deps, commands } = harness
  const view = await dwsLocalDoctor({ ...deps, home: '' })
  assert.equal(view.ok, false)
  assert.equal(view.permissionMechanism, 'unknown')
  assert.deepEqual(commands, [], '推不出目录时一条命令都不许跑')
})
