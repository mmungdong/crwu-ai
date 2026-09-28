import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 凭据文件权限的结构化结论（`host/platform/credential-permission.ts`，协议 17）。
 *
 * 旧形态只有一个 `chmodOk: boolean`，而 Windows 上没有 `chmod`（POSIX 权限位不适用）——
 * 跳过之后只能报 `true`，字段名读起来是「chmod 成功了」。这一份钉住三种结局各自的说法与动作。
 */
const ROOT = new URL('../../', import.meta.url)
const { enforceCredentialPermission, hostStorePermission, parseFileMode } = await import(
  new URL('src/host/platform/credential-permission.ts', ROOT).href)
const { readFileModeCommand } = await import(new URL('src/host/platform/shell.ts', ROOT).href)

/**
 * 记录命令的 shell 替身。
 *
 * `result` 可以是固定结果，也可以是 `(spec) => result` —— 收紧与**回读**是两条命令，
 * 必须能分别作答（回读返回 `600` 才算 `verified`）。
 */
function makeCtx(result = { exitCode: 0, stdout: '600' }) {
  const commands = []
  return {
    commands,
    get(name) {
      if (name !== 'shell') return undefined
      return {
        resolve: (request) => ({ ...request, workdir: request.workdir ?? '/default', timeoutMs: 1, stdoutMaxBytes: 1024 }),
        async execute(spec) {
          commands.push({ command: spec.command, sandboxPolicy: spec.sandboxPolicy })
          const out = typeof result === 'function' ? result(spec) : result
          return {
            result: async () => ({
              exitCode: out.exitCode ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: out.stdout ?? '', truncated: false },
              stderr: { text: out.stderr ?? '', truncated: false },
            }),
          }
        },
      }
    },
  }
}

test('POSIX：chmod 成功**且回读到 600** → verified / posix-0600', async () => {
  const ctx = makeCtx({ exitCode: 0, stdout: '600' })
  const permission = await enforceCredentialPermission(ctx, '/Users/x/.dsh/cred.json', 'darwin-arm64', {
    workdir: '/Users/x', escalate: true,
  })
  assert.deepEqual(permission, { status: 'verified', mechanism: 'posix-0600', message: '' })
  assert.equal(ctx.commands.length, 2, '收紧之后必须回读，不能只信退出码')
  assert.equal(ctx.commands[0].command, 'chmod 600 /Users/x/.dsh/cred.json')
  // BSD 与 GNU 的 stat 参数不同，这条断言同时钉住「用哪个平台的分支」。
  assert.equal(ctx.commands[1].command, 'stat -f %Lp /Users/x/.dsh/cred.json')
  assert.equal(ctx.commands[0].sandboxPolicy?.mode, 'danger-full-access', '读本机凭据目录要提权')
})

test('POSIX：chmod 退出码 0 但**回读不是 600** → failed（文件系统静默忽略 chmod）', async () => {
  const ctx = makeCtx((spec) => (spec.command.startsWith('chmod') ? { exitCode: 0 } : { exitCode: 0, stdout: '644' }))
  const permission = await enforceCredentialPermission(ctx, '/Users/x/.dsh/cred.json', 'linux-x64', { workdir: '/Users/x' })
  assert.equal(permission.status, 'failed', '命令跑过了不等于权限生效了')
  assert.equal(permission.mechanism, 'posix-0600')
  assert.match(permission.message, /回读到的模式是 644/)
  assert.match(permission.message, /期望 600/)
  // GNU 分支用 `stat -c %a`。
  assert.equal(ctx.commands[1].command, 'stat -c %a /Users/x/.dsh/cred.json')
})

test('POSIX：回读命令跑不起来 → failed，不退回「只看 chmod 退出码」', async () => {
  const ctx = makeCtx((spec) => (spec.command.startsWith('chmod') ? { exitCode: 0 } : { exitCode: 1, stderr: 'stat: not found' }))
  const permission = await enforceCredentialPermission(ctx, '/Users/x/cred.json', 'darwin-arm64', { workdir: '/Users/x' })
  assert.equal(permission.status, 'failed')
  assert.match(permission.message, /权限回读失败/)
  assert.match(permission.message, /stat: not found/)
})

test('parseFileMode 只认末尾的八进制串，并归一四位前导 0', () => {
  assert.equal(parseFileMode('600'), '600')
  assert.equal(parseFileMode('600\n'), '600')
  assert.equal(parseFileMode('0600'), '600')
  assert.equal(parseFileMode('  644  '), '644')
  assert.equal(parseFileMode('2600'), '2600', 'setgid 位如实保留，便于对比失败原因')
  assert.equal(parseFileMode(''), '')
  assert.equal(parseFileMode('stat: cannot stat'), '')
  assert.equal(parseFileMode('600 extra'), '', '输出里有别的词就不猜')
})

test('POSIX：chmod 失败 → failed / posix-0600，原因逐字带出（且不再回读）', async () => {
  const ctx = makeCtx({ exitCode: 1, stderr: 'chmod: Operation not permitted' })
  const permission = await enforceCredentialPermission(ctx, '/Users/x/.dsh/cred.json', 'linux-x64', { workdir: '/Users/x' })
  assert.equal(permission.status, 'failed')
  assert.equal(permission.mechanism, 'posix-0600')
  assert.match(permission.message, /Operation not permitted/)
  assert.equal(ctx.commands.length, 1, '第一步就失败了，不该再去回读')
})

test('POSIX：命令根本没跑起来（沙箱/审批）也算 failed，不伪装成功', async () => {
  // `error` 非空 = 命令没有执行（见 shell/run.ts 的 shellUnavailable 契约）。
  const ctx = makeCtx({ exitCode: null, stderr: '', stdout: '' })
  ctx.get = (name) => {
    if (name !== 'shell') return undefined
    return {
      resolve: (request) => ({ ...request, workdir: '/x', timeoutMs: 1, stdoutMaxBytes: 1024 }),
      async execute() { throw new Error('no sandbox backend') },
    }
  }
  const permission = await enforceCredentialPermission(ctx, '/Users/x/cred.json', 'darwin-arm64', { workdir: '/Users/x' })
  assert.equal(permission.status, 'failed')
})

test('Windows：不执行任何命令，如实报 inherited / windows-acl', async () => {
  const ctx = makeCtx({ exitCode: 0 })
  const permission = await enforceCredentialPermission(ctx, 'C:\\Users\\x\\cred.json', 'win32-x64', {
    workdir: 'C:\\Users\\x', escalate: true,
  })
  assert.deepEqual(permission, {
    status: 'inherited', mechanism: 'windows-acl', message: '使用当前 Windows 账户 ACL；POSIX 0600 不适用',
  })
  assert.deepEqual(ctx.commands, [], 'Windows 上没有 chmod / POSIX 模式位：一条命令都不该发')
})

test('DSH 凭据服务托管时也不宣称「已验证」', () => {
  assert.deepEqual(hostStorePermission(), {
    status: 'inherited', mechanism: 'host-store', message: '凭据由 DSH 凭据服务保管，文件权限不适用',
  })
})

test('readFileModeCommand 按 GNU / BSD / Windows 三种分支生成回读命令', () => {
  // `chmod` 会在个别文件系统上静默无效，所以收紧之后必须回读模式位；
  // 而 GNU 与 BSD 的 `stat` 参数不同 —— 这个分歧只允许出现在这里一次。
  assert.equal(readFileModeCommand('/Users/x/cred.json', 'darwin-arm64'), 'stat -f %Lp /Users/x/cred.json')
  assert.equal(readFileModeCommand('/opt/cred.json', 'linux-x64'), 'stat -c %a /opt/cred.json')
  assert.equal(readFileModeCommand("/Users/x/Case's cred.json", 'darwin-arm64'), "stat -f %Lp '/Users/x/Case'\\''s cred.json'")
  // Windows 没有 POSIX 模式位：空串表示「这一项不适用」，调用方不许据此宣称已验证。
  assert.equal(readFileModeCommand('C:\\Users\\x\\cred.json', 'win32-x64'), '')
})

