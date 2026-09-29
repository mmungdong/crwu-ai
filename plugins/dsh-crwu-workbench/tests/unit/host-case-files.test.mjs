import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 案例目录的本地文件操作（`host/tools/case-files.ts`）。
 *
 * 这里是 2026-09-28 Windows 报错里最隐蔽的一段：旧实现用 `cmd /c mkdir` / `cmd /c del`，
 * 并且**把 Windows 上的任意 mkdir 失败都当成成功**（「目录已存在也会报错」的粗糙兜底）。
 * 后果不是立刻炸，而是「以为目录建好了，下一步写文件才失败」—— 错误归因到完全无关的地方。
 *
 * 2026-09-30 又补上一层：这些命令**必须经 Local Access Broker**（`system.case-directory.write` /
 * `system.case-file.write` / `system.case-file.read`）。裸 `runShell` 拿到的是部署默认沙箱
 * （边界 = 会话 cwd），在员工选定的工作空间里 `mkdir` 会回 `Operation not permitted` ——
 * 而员工本人对那个目录是有写权限的。所以这一份同时钉三件事：方言、失败传播，
 * **以及提权的归属**（只有"创建本轮案例目录"这一条逐次声明 `danger-full-access`）。
 */
const ROOT = new URL('../../', import.meta.url)
// 成功的建 / 删命令要真的作用到内存 fs 上：实现会回读后置条件（见 tests/helpers/shell-effects.mjs）。
const { applyShellEffect, probeAnswer, probeKey } = await import(new URL('tests/helpers/shell-effects.mjs', ROOT).href)
const { makeTestAccess, makeUnauthorizedAccess } = await import(
  new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)
const { makeSandboxedFs, makeSandboxedShell, makeSessionPolicyService } = await import(
  new URL('tests/helpers/fs-sandbox-stub.mjs', ROOT).href)
const { ensureCaseDirectory, ensureDirectory, removeFileIfExists, writeCaseText } = await import(
  new URL('src/host/tools/case-files.ts', ROOT).href)

/**
 * 内存 fs + 记录 shell 请求的最小 ctx。
 *
 * 用**真 Broker**（`makeTestAccess`）而不是替身：这样"这条命令带没带 sandboxPolicy、
 * 操作名与来源对不对"都是真实策略层给出的结论，替身只负责"世界"。
 */
function makeCtx({ dirs = [], files = [], shellResult = { exitCode: 0, stderr: '' }, effects = true } = {}) {
  const directorySet = new Set(dirs)
  const fileSet = new Set(files)
  const commands = []
  const requests = []
  const ctx = {
    commands,
    requests,
    directorySet,
    fileSet,
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => {
            requests.push(request)
            return { ...request, workdir: request.workdir ?? '/default', timeoutMs: 1, stdoutMaxBytes: 1024 }
          },
          async execute(spec) {
            commands.push(spec.command)
            // 只读探测**先于**用例给的 shellResult 回答：探测是"世界"的回答，
            // 与某条业务命令成功/失败无关（否则构造"mkdir 失败"的用例会把探测也一起弄失败，
            // 那就变成了在测探测而不是在测后置条件）。
            const probe = probeAnswer(spec.command, {
              hasDir: (path) => directorySet.has(probeKey(path)),
              hasFile: (path) => fileSet.has(probeKey(path)),
            })
            if (probe !== undefined) {
              return {
                result: async () => ({
                  exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                  stdout: { text: probe, truncated: false }, stderr: { text: '', truncated: false },
                }),
              }
            }
            const result = typeof shellResult === 'function' ? shellResult(spec) : shellResult
            // 只有「真的跑成功了」才模拟副作用；`effects: false` 用来构造
            // 「退出码 0 但文件系统没变」的骗子机器，专门验后置条件。
            if (effects) {
              applyShellEffect(spec.command, result.exitCode, {
                addDir: (path) => directorySet.add(path),
                removeFile: (path) => fileSet.delete(path),
              })
            }
            return {
              result: async () => ({
                exitCode: result.exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                stdout: { text: result.stdout ?? '', truncated: false },
                stderr: { text: result.stderr ?? '', truncated: false },
              }),
            }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) {
            if (directorySet.has(target.targetKey)) return { type: 'directory' }
            if (fileSet.has(target.targetKey)) return { type: 'file' }
            return undefined
          },
        }
      }
      return undefined
    },
  }
  return ctx
}

const WORK = { workdir: '/cases/space/S1', platform: 'darwin-arm64' }
/** 案例目录**之内**的操作一律不提权 —— 边界就是子会话自己的工作区。 */
const assertNoEscalation = (ctx) => {
  assert.equal(ctx.requests.every((item) => item.sandboxPolicy === undefined), true,
    '案例目录之内的操作不许申请 danger-full-access')
}

// ── 建目录 ──────────────────────────────────────────────────────────────────

/**
 * 一台**真的会拦人**的沙箱替身。
 *
 * 判据就是 DSH `workspace-write` 的实际语义（`dsh-sandbox` 的 `writableRoots`）：
 * **写**只允许落在工作区根与临时区之内；请求里带了 `sandboxPolicy.mode === 'danger-full-access'`
 * 时执行器直接 spawn 原始 argv，不受这一层约束。
 *
 * 为什么要有这条用例：2026-09-30 的现场是 `mkdir` 拿到部署默认沙箱、在员工选定工作空间里
 * 回 `Operation not permitted`。这条替身把那个现场固定下来 —— 一旦有人把案例目录创建改回
 * 裸 `runShell`（或去掉提权），它会立刻变红。
 */
function makeSandboxedCtx({ workspace = '/Users/x/中瑞世联工作空间', sessionRoot = '/cases/session' } = {}) {
  const commands = []
  const requests = []
  const directories = new Set(['/Users/x', workspace])
  const within = (path, root) => path === root || path.startsWith(`${root}/`)
  const targetOf = (command) => {
    const match = /(?:mkdir -p|New-Item -ItemType Directory -Force -Path) '([^']*)'/.exec(command)
      ?? /if \[ -d '([^']*)' \]/.exec(command)
    return match?.[1] ?? ''
  }
  const ctx = {
    commands,
    requests,
    directories,
    get(name) {
      if (name !== 'shell') return undefined
      return {
        resolve: (request) => {
          requests.push(request)
          return { ...request, workdir: request.workdir ?? sessionRoot, timeoutMs: 1, stdoutMaxBytes: 1024 }
        },
        async execute(spec) {
          commands.push(spec.command)
          const target = targetOf(String(spec.command))
          const escalated = spec.sandboxPolicy?.mode === 'danger-full-access'
          const allowed = escalated || within(target, sessionRoot) || within(target, '/tmp')
          if (!allowed) {
            return {
              result: async () => ({
                exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                stdout: { text: '', truncated: false },
                stderr: { text: `mkdir: ${target}: Operation not permitted`, truncated: false },
                sandbox: { mode: 'workspace-write', denied: true },
              }),
            }
          }
          // 放行：真的建出来（后置条件回读才看得见）。
          if (String(spec.command).startsWith('mkdir')) directories.add(target)
          return {
            result: async () => ({
              exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: probeOf(spec.command, directories, target), truncated: false },
              stderr: { text: '', truncated: false },
              sandbox: { mode: escalated ? 'danger-full-access' : 'workspace-write', denied: false },
            }),
          }
        },
      }
    },
  }
  return ctx
}

/** 沙箱替身的探测回答（只认这一条形状：探测的目标就是 `target`）。 */
function probeOf(command, directories, target) {
  if (!String(command).startsWith('if [ -d')) return ''
  return directories.has(probeKey(target)) ? 'directory' : 'absent'
}

test('回归：DSH 沙箱下创建案例目录必须成功（提权请求真的发出去了）', async () => {
  const ctx = makeSandboxedCtx()
  const access = makeTestAccess(ctx).access
  const result = await ensureCaseDirectory(access, '/Users/x/中瑞世联工作空间/S1', {
    workspace: '/Users/x/中瑞世联工作空间',
    probeWorkdir: '/cases/session',
    platform: 'darwin-arm64',
  })
  assert.deepEqual([result.ok, result.error], [true, ''], '这正是 2026-09-30 现场失败的那一步')
  const mkdir = ctx.requests.find((item) => String(item.command).startsWith('mkdir'))
  assert.equal(mkdir.sandboxPolicy.mode, 'danger-full-access')
  assert.equal(mkdir.sandboxPolicy.workspaceRoot, '/Users/x/中瑞世联工作空间')
  assert.equal(result.facts.denied, false)
})

test('ensureDirectory 按平台生成命令（POSIX mkdir -p / PowerShell New-Item -Force）', async () => {
  const mac = makeCtx({ dirs: ['/cases/space/S1/输入快照'] })
  const macResult = await ensureDirectory(makeTestAccess(mac).access, '/cases/space/S1/输入快照', WORK)
  assert.deepEqual([macResult.ok, macResult.error], [true, ''])
  assert.equal(mac.commands[0], "mkdir -p '/cases/space/S1/输入快照'")

  const win = makeCtx({ dirs: ['C:\\Case\'s Work\\S1\\输入快照'] })
  const path = "C:\\Case's Work\\S1\\输入快照"
  const winResult = await ensureDirectory(makeTestAccess(win).access, path, { ...WORK, platform: 'win32-x64' })
  assert.deepEqual([winResult.ok, winResult.error], [true, ''])
  assert.equal(win.commands[0], `New-Item -ItemType Directory -Force -Path 'C:\\Case''s Work\\S1\\输入快照' | Out-Null`)
})

test('ensureDirectory 经 Broker：cwd = 案例目录、来源 = audit-tool、**不提权**', async () => {
  const ctx = makeCtx({ dirs: ['/cases/space/S1/输入快照'] })
  await ensureDirectory(makeTestAccess(ctx).access, '/cases/space/S1/输入快照', WORK)
  assert.equal(ctx.requests[0].workdir, '/cases/space/S1', '命令的 cwd 必须是案例目录')
  assertNoEscalation(ctx)
})

test('ensureDirectory 只在「目标已经是目录」时把失败当成功', async () => {
  // 目录已存在（重审会再走一次）：命令报错也不算失败 —— 这就是幂等的判据。
  const exists = makeCtx({ dirs: ['/cases/space/S1'], shellResult: { exitCode: 1, stderr: 'File exists' } })
  const ok = await ensureDirectory(makeTestAccess(exists).access, '/cases/space/S1', WORK)
  assert.deepEqual([ok.ok, ok.error], [true, ''])

  // 目录不存在又报错：**必须**失败。旧实现在 Windows 上无条件返回成功，把故障推到下一步。
  const missingWin = makeCtx({ shellResult: { exitCode: 1, stderr: 'Access is denied' } })
  const failed = await ensureDirectory(makeTestAccess(missingWin).access, 'C:\\x\\S1', { ...WORK, platform: 'win32-x64' })
  assert.equal(failed.ok, false, 'Windows 上 mkdir 失败不得被当成成功')
  assert.match(failed.error, /Access is denied/)
})

test('ensureDirectory 回读后置条件：命令返回 0 但目录不存在也算失败', async () => {
  const liar = makeCtx({ shellResult: { exitCode: 0 }, effects: false })
  const result = await ensureDirectory(makeTestAccess(liar).access, '/cases/space/S1', WORK)
  assert.equal(result.ok, false)
  assert.match(result.error, /创建目录命令返回成功，但目录不存在/)
})

test('ensureDirectory 没有 shell 服务时如实报失败，不假装成功', async () => {
  const ctx = makeCtx()
  ctx.get = () => undefined
  const result = await ensureDirectory(makeTestAccess(ctx).access, '/cases/space/S1', WORK)
  assert.equal(result.ok, false)
})

test('案例内的非特权命令必须带**调用方会话的策略**（真机 Operation not permitted 的根因）', async () => {
  // 2026-09-30 真机现场（连挂两次）：`mkdir <案例目录>/输入快照` 回
  // `Operation not permitted（解析为 workspace-write · 实际 workspace-write · 沙箱拒绝=是）`，
  // 而案例目录就是审核根会话的 cwd。
  // 根因：DSH 的**执行器不持有会话** —— 请求里不带 `sandboxPolicy` 时它只会用部署默认
  //（进程 cwd）。所以"按调用方的作用域执行"必须体现为**请求里带上那个会话解析出来的策略**。
  // 这条用例用的替身会**真的按策略拦人**（见 tests/helpers/fs-sandbox-stub.mjs）。
  const CASE = '/cases/space/S1'
  const DEFAULT_ROOT = '/work/plugin-default'
  const fs = makeCtx({ dirs: [CASE] }).directorySet
  const shellFs = { dirs: fs, files: new Set() }
  const shell = makeSandboxedShell({ fs: shellFs, defaultRoot: DEFAULT_ROOT })
  const policy = makeSessionPolicyService({ defaultRoot: DEFAULT_ROOT, roots: () => CASE })
  const session = { id: 'session-root-1' }
  const ctx = {
    get(name) {
      if (name === 'shell') return shell.service
      if (name === 'sandboxPolicy') return policy.service
      return undefined
    },
  }
  const access = makeTestAccess(ctx).access

  // ① 不带会话（= 真机那两次的形态）：落到部署默认（进程 cwd）→ 被沙箱拒。
  //    先跑这一支：目录还不存在，所以"命令失败但目标已经是目录"那条幂等退路救不了它。
  const denied = await ensureDirectory(access, `${CASE}/输入快照`, {
    workdir: CASE, platform: 'darwin-arm64',
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.errorKind, 'sandbox')
  assert.match(denied.error, /Operation not permitted/)
  assert.equal(shell.deniedCommands.length, 1, '这一支必须真的被沙箱拦下（否则用例是假的）')
  assert.equal(shellFs.dirs.has(`${CASE}/输入快照`), false, '不该建出任何目录')

  // ② 带会话：请求里带上"这条会话的策略"（边界 = 案例目录）→ 建得出来。
  const ok = await ensureDirectory(access, `${CASE}/输入快照`, {
    workdir: CASE, platform: 'darwin-arm64', session,
  })
  assert.deepEqual([ok.ok, ok.error], [true, ''])
  const declared = shell.requests.filter((request) => String(request.command).startsWith('mkdir')).at(-1)
  assert.equal(declared.sandboxPolicy.workspaceRoot, CASE, '必须把调用方会话解析出来的边界放进请求')
  assert.equal(declared.sandboxPolicy.mode, 'workspace-write', '非特权操作不提权，只对齐边界')
  assert.equal(shell.deniedCommands.length, 1, '带会话这一支不许再被拦')
  assert.equal(shellFs.dirs.has(`${CASE}/输入快照`), true)
})

test('案例内的文本写入必须带**调用方会话的策略**（真机第三次故障：FS_SANDBOX_DENIED）', async () => {
  // 真机现场（2026-09-30 第三次）：`mkdir 输入快照` 已经成功，三个快照 JSON 却写不进去 ——
  // DSH 的 fs 服务和 shell 执行器一样**不持有会话**：
  //   const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()   // → 部署默认（进程 cwd）
  //   throw new FsError('cannot write "…": file access denied under workspace-write mode', 'FS_SANDBOX_DENIED')
  // 于是审核停在「未创建子代理」。这条用例的 fs 替身会**真的按策略拦写**。
  const CASE = '/cases/space/S1'
  const DEFAULT_ROOT = '/work/plugin-default'
  const files = new Map()
  const inner = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat() { return undefined },
    async readText(t) { return files.get(t.targetKey) ?? '' },
    async writeText(t, content) { files.set(t.targetKey, content); return { operation: 'create', version: 'v' } },
  }
  const sandboxed = makeSandboxedFs({ fs: inner, defaultRoot: DEFAULT_ROOT })
  const policy = makeSessionPolicyService({ defaultRoot: DEFAULT_ROOT, roots: () => CASE })
  const session = { id: 'session-root-1' }
  const ctx = {
    get(name) {
      if (name === 'fs') return sandboxed.service
      if (name === 'sandboxPolicy') return policy.service
      return undefined
    },
  }

  // ① 不带会话（= 真机那次的形态）：落到部署默认 → 被沙箱拒，且归因必须是 sandbox。
  const denied = await writeCaseText(ctx, `${CASE}/输入快照/附件清单.json`, '{"a":1}')
  assert.equal(denied.ok, false)
  assert.equal(denied.errorKind, 'sandbox')
  assert.match(denied.error, /file access denied under workspace-write mode/)
  assert.equal(sandboxed.deniedWrites.length, 1, '这一支必须真的被沙箱拦下')
  assert.equal(files.has(`${CASE}/输入快照/附件清单.json`), false)

  // ② 带会话：策略随请求下发（边界 = 案例目录）→ 写进去，且回读核对通过。
  const ok = await writeCaseText(ctx, `${CASE}/输入快照/附件清单.json`, '{"a":1}', { session })
  assert.deepEqual([ok.ok, ok.postcondition, ok.error], [true, 'file', ''])
  assert.equal(files.get(`${CASE}/输入快照/附件清单.json`), '{"a":1}')
  assert.equal(sandboxed.writes.at(-1).policy.workspaceRoot, CASE, '必须把调用方会话解析出来的边界放进这次写入')
  assert.equal(sandboxed.writes.at(-1).policy.mode, 'workspace-write', '非特权写入不提权，只对齐边界')
})

// ── 创建本轮案例目录（唯一允许自动创建的一级目录） ───────────────────────────

test('ensureCaseDirectory 逐次声明 danger-full-access，边界 = 员工选定的工作空间', async () => {
  const ctx = makeCtx({ dirs: ['/Users/x/中瑞世联工作空间'] })
  const result = await ensureCaseDirectory(makeTestAccess(ctx).access, '/Users/x/中瑞世联工作空间/S1', {
    workspace: '/Users/x/中瑞世联工作空间',
    probeWorkdir: '/cases/session',
    platform: 'darwin-arm64',
  })
  assert.deepEqual([result.ok, result.error, result.errorKind], [true, '', ''])
  const escalated = ctx.requests.filter((item) => item.sandboxPolicy !== undefined)
  assert.equal(escalated.length > 0, true, '创建案例目录必须申请提权，否则受限沙箱下必然 Operation not permitted')
  for (const request of escalated) assert.equal(request.sandboxPolicy.mode, 'danger-full-access')
  // 建目录那一条的边界**只能是员工选定的工作空间**；存在性探测的锚点是一个确定存在的目录
  //（会话 cwd）—— 拿一个可能不存在的工作空间当 cwd 会让"目录不存在"与"沙箱没放行"塌成一句话。
  const mkdirRequest = ctx.requests.find((item) => String(item.command).startsWith('mkdir'))
  assert.equal(mkdirRequest.sandboxPolicy.workspaceRoot, '/Users/x/中瑞世联工作空间')
  const probeRequests = ctx.requests.filter((item) => String(item.command).startsWith('if ['))
  assert.equal(probeRequests.length, 2, '工作空间与案例目录都要回读')
  assert.equal(probeRequests[0].sandboxPolicy.workspaceRoot, '/cases/session', '存在性探测锚在确定存在的目录上')
  assert.equal(probeRequests[1].sandboxPolicy.workspaceRoot, '/Users/x/中瑞世联工作空间', '后置条件回读锚在工作空间')
  assert.equal(ctx.commands.some((command) => command.startsWith("mkdir -p '/Users/x/中瑞世联工作空间/S1'")), true)
  // 事实要能带回去（诊断里回答「请求了什么、实际跑在什么下」）。
  assert.equal(result.facts.operation, 'system.case-directory.write')
  assert.equal(result.facts.source, 'audit-host')
  assert.equal(result.facts.requested, 'danger-full-access')
  assert.equal(result.facts.resolved, 'danger-full-access', '解析回来的模式也是提权模式')
  assert.equal(result.facts.processStarted, true, '进程真的起来了（计划里那个 `ran` 布尔）')
  assert.equal(result.postcondition, 'directory', '后置条件回读的结论要带回来')
})

test('ensureCaseDirectory 工作空间不存在时**不建目录**，并给出「重新选择」的话', async () => {
  const ctx = makeCtx({ dirs: [] })
  const result = await ensureCaseDirectory(makeTestAccess(ctx).access, '/Users/x/工作空间/S1', {
    workspace: '/Users/x/工作空间',
    probeWorkdir: '/cases/session',
    platform: 'darwin-arm64',
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'missing')
  assert.equal(result.postcondition, 'unknown', '没走到后置条件回读')
  assert.match(result.error, /所选工作空间不存在/)
  assert.match(result.error, /重新选择一个已有目录/)
  assert.deepEqual(ctx.commands.filter((command) => command.startsWith('mkdir')), [], '工作空间不成立就不该建案例目录')
})

test('ensureCaseDirectory 未授权时一个进程都不起（policy，而不是「mkdir 失败」）', async () => {
  const ctx = makeCtx({ dirs: ['/Users/x/工作空间'] })
  const result = await ensureCaseDirectory(makeUnauthorizedAccess(ctx).access, '/Users/x/工作空间/S1', {
    workspace: '/Users/x/工作空间',
    probeWorkdir: '/cases/session',
    platform: 'darwin-arm64',
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.equal(result.facts.processStarted, false, '未授权时进程根本没起来')
  assert.deepEqual(ctx.commands, [], '未授权不许起进程')
})

test('ensureCaseDirectory 被沙箱拦下时归类为 sandbox，并把请求/实际模式说清楚', async () => {
  // `effects: false`：沙箱拒绝的那一次当然没有副作用，后置条件回读必须是 `absent`。
  const ctx = makeCtx({ dirs: ['/Users/x/工作空间'], effects: false })
  const inner = ctx.get('shell')
  // 沙箱真的拒了：判据只允许是结构化事实（`ShellRunResult.sandbox.denied`），
  // 不是错误文本里有没有写"权限"（§D5）。
  const shell = {
    resolve: inner.resolve,
    async execute(spec) {
      const result = await inner.execute(spec)
      if (!String(spec.command).startsWith('mkdir')) return result
      return {
        result: async () => ({
          ...(await result.result()),
          exitCode: 1,
          stderr: { text: 'mkdir: Operation not permitted', truncated: false },
          sandbox: { mode: 'workspace-write', denied: true },
        }),
      }
    },
  }
  const access = makeTestAccess({ get: (name) => (name === 'shell' ? shell : undefined) }).access
  const result = await ensureCaseDirectory(access, '/Users/x/工作空间/S1', {
    workspace: '/Users/x/工作空间',
    probeWorkdir: '/cases/session',
    platform: 'darwin-arm64',
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'sandbox')
  assert.match(result.error, /danger-full-access/)
  assert.match(result.error, /操作 system\.case-directory\.write/)
  assert.equal(result.facts.denied, true)
})

test('ensureCaseDirectory 提权被**降级**时如实报告实际策略（最难发现的一种）', async () => {
  // 现场形态：我们请求了 `danger-full-access`，但执行器 `resolve()` 回来的是
  // `workspace-write` —— 请求活过了策略解析、却在执行时被降级。判据是**结构化事实**
  // （requested ≠ resolved），不是错误文本里有没有写"权限"。
  const ctx = makeCtx({ dirs: ['/Users/x/工作空间'], effects: false })
  const inner = ctx.get('shell')
  const shell = {
    resolve: (request) => {
      ctx.requests.push(request)
      const downgraded = request.sandboxPolicy === undefined
        ? {}
        : { sandboxPolicy: { ...request.sandboxPolicy, mode: 'workspace-write' } }
      return { ...request, ...downgraded, workdir: request.workdir ?? '/default', timeoutMs: 1, stdoutMaxBytes: 1024 }
    },
    execute: inner.execute,
  }
  const access = makeTestAccess({ get: (name) => (name === 'shell' ? shell : undefined) }).access
  const result = await ensureCaseDirectory(access, '/Users/x/工作空间/S1', {
    workspace: '/Users/x/工作空间',
    probeWorkdir: '/cases/session',
    platform: 'darwin-arm64',
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'sandbox')
  assert.equal(result.facts.requested, 'danger-full-access')
  assert.equal(result.facts.resolved, 'workspace-write', '实际解析出来的模式必须带回去')
  assert.match(result.error, /danger-full-access/)
})

test('ensureCaseDirectory 沙箱放行但操作系统拒绝写入时归类为 permission', async () => {
  const ctx = makeCtx({
    dirs: ['/Users/x/工作空间'],
    shellResult: (spec) => (String(spec.command).startsWith('mkdir')
      ? { exitCode: 1, stderr: 'mkdir: /Users/x/工作空间/S1: Permission denied' }
      : { exitCode: 0, stderr: '' }),
  })
  const result = await ensureCaseDirectory(makeTestAccess(ctx).access, '/Users/x/工作空间/S1', {
    workspace: '/Users/x/工作空间',
    probeWorkdir: '/cases/session',
    platform: 'darwin-arm64',
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'permission')
  assert.match(result.error, /目录所有者/)
})

// ── 删除 ────────────────────────────────────────────────────────────────────

test('removeFileIfExists 在文件本来就不在时不发删除命令（幂等）', async () => {
  const ctx = makeCtx()
  const result = await removeFileIfExists(makeTestAccess(ctx).access, '/cases/space/S1/审核结果.json', WORK)
  assert.deepEqual([result.ok, result.error], [true, ''])
  assert.deepEqual(ctx.commands.filter((command) => command.startsWith('rm ')), [],
    '不存在就没有可删的东西，一条删除命令也不该发')
  assertNoEscalation(ctx)
})

test('removeFileIfExists 拒绝目录，并按平台生成删除命令', async () => {
  const asDir = makeCtx({ dirs: ['/cases/space/S1/输入快照'] })
  const refused = await removeFileIfExists(makeTestAccess(asDir).access, '/cases/space/S1/输入快照', WORK)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /不是普通文件/)

  const mac = makeCtx({ files: ['/cases/space/S1/审核结果.S1.json'] })
  const macResult = await removeFileIfExists(makeTestAccess(mac).access, '/cases/space/S1/审核结果.S1.json', WORK)
  assert.deepEqual([macResult.ok, macResult.error], [true, ''])
  // 含中文的路径不在 POSIX 安全白名单里 —— 必须引用（不加引号会被词法拆分 / 被 glob 解释）。
  assert.equal(mac.commands.find((command) => command.startsWith('rm ')), "rm -f -- '/cases/space/S1/审核结果.S1.json'")
})

test('removeFileIfExists 传播真实失败，并用后置条件抓住「命令成功但文件还在」', async () => {
  const denied = makeCtx({
    files: ['/cases/space/S1/a.json'],
    shellResult: (spec) => (String(spec.command).startsWith('rm ')
      ? { exitCode: 1, stderr: 'Permission denied' }
      : { exitCode: 0, stderr: '' }),
  })
  const failed = await removeFileIfExists(makeTestAccess(denied).access, '/cases/space/S1/a.json', WORK)
  assert.equal(failed.ok, false, '权限 / 占用类失败必须传播')
  assert.match(failed.error, /Permission denied/)

  // 命令返回 0，但替身 fs 里文件还在 —— 说明删除没生效，不能报成功。
  const liar = makeCtx({ files: ['/cases/space/S1/b.json'], shellResult: { exitCode: 0 }, effects: false })
  const still = await removeFileIfExists(makeTestAccess(liar).access, '/cases/space/S1/b.json', WORK)
  assert.equal(still.ok, false)
  assert.match(still.error, /文件仍然存在/)
})

test('removeFileIfExists 在 Windows 上用 PowerShell 幂等删除且失败可传播', async () => {
  const ctx = makeCtx({ files: ["C:\\Case's Work\\S1\\old.json"] })
  const path = "C:\\Case's Work\\S1\\old.json"
  const result = await removeFileIfExists(makeTestAccess(ctx).access, path, { ...WORK, platform: 'win32-x64' })
  assert.deepEqual([result.ok, result.error], [true, ''])
  const remove = ctx.commands.find((command) => command.includes('Remove-Item'))
  assert.equal(
    remove,
    "if (Test-Path -LiteralPath 'C:\\Case''s Work\\S1\\old.json') { Remove-Item -LiteralPath 'C:\\Case''s Work\\S1\\old.json' -Force -ErrorAction Stop }",
  )
  assert.equal(String(remove).includes('SilentlyContinue'), false)
})

// ── 探测的三态：不存在 / 存在 / **查不出来** ─────────────────────────────────
//
// 2026-09-28 复查发现的 P2：原来把 `resolve/stat` 的所有异常都当成「文件不存在」，
// 于是 `Access denied` 会被回报成「删除成功」；删除后的回读同样把异常折叠成「不存在」，
// 后置条件因此形同虚设。现在探测走 shell（`test -d` / `Test-Path`），
// 「命令没跑起来」与「明确 absent」仍然必须分开。

/** 探测命令的形状（与 `platform/shell.ts` 的 `pathProbeCommand` 对应）。 */
const isProbe = (command) => String(command).startsWith('if [') || String(command).startsWith('if (Test-Path')

/** 直接给一个只回答探测的 shell 替身（其余命令一律"成功但什么都不做"）。 */
function probeOnlyShell(answers) {
  let calls = 0
  return {
    resolve: (request) => ({ ...request, workdir: request.workdir ?? '/default', timeoutMs: 1, stdoutMaxBytes: 1024 }),
    async execute(spec) {
      const text = isProbe(spec.command) ? (answers[calls++] ?? '') : ''
      const exitCode = isProbe(spec.command) && answers[calls - 1] === 'FAIL' ? 1 : 0
      return {
        result: async () => ({
          exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
          stdout: { text: text === 'FAIL' ? '' : text, truncated: false },
          stderr: { text: '', truncated: false },
        }),
      }
    },
  }
}

test('探测命令失败 → 按基础设施失败上报，不回报成功', async () => {
  const shell = probeOnlyShell(['FAIL'])
  const access = makeTestAccess({ get: (name) => (name === 'shell' ? shell : undefined) }).access
  const result = await removeFileIfExists(access, '/cases/space/S1/a.json', WORK)
  assert.equal(result.ok, false, '探测没有结论时不得当成「没有这个文件」')
  assert.match(result.error, /无法确认目标状态/)
})

test('删除后回读没有结论 → 不能报成功（后置条件无从判定）', async () => {
  // 第一次探测：文件在；删除命令"成功"；第二次探测：没有结论。
  // ⚠️ 替身必须**只造一次**：放在 `get()` 回调里会让每次取 shell 都拿到一个新的计数器。
  const shell = probeOnlyShell(['file', ''])
  const access = makeTestAccess({ get: (name) => (name === 'shell' ? shell : undefined) }).access
  const result = await removeFileIfExists(access, '/cases/space/S1/b.json', WORK)
  assert.equal(result.ok, false)
  assert.match(result.error, /无法确认目标是否已删除/)
})

test('建目录后回读没有结论 → 不能报成功', async () => {
  const shell = probeOnlyShell([''])
  const access = makeTestAccess({ get: (name) => (name === 'shell' ? shell : undefined) }).access
  const result = await ensureDirectory(access, '/cases/space/S1', WORK)
  assert.equal(result.ok, false)
  assert.match(result.error, /无法确认目录是否已创建/)
})

test('建目录成功但同名目标是文件 → 如实报「不是目录」', async () => {
  // `effects: false`：这里的 shell 替身不模拟文件系统变化，用一个「同名文件已存在」的
  // 假机器来验后置条件的分支。
  const ctx = makeCtx({ files: ['/cases/space/S1'], effects: false })
  const result = await ensureDirectory(makeTestAccess(ctx).access, '/cases/space/S1', WORK)
  assert.equal(result.ok, false)
  assert.match(result.error, /不是目录/)
})
