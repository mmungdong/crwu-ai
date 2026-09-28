import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 凭据文件权限的结构化结论（`host/platform/credential-permission.ts`，协议 17）。
 *
 * 旧形态只有一个 `chmodOk: boolean`，而 Windows 上没有 `chmod`（POSIX 权限位不适用）——
 * 跳过之后只能报 `true`，字段名读起来是「chmod 成功了」。这一份钉住三种结局各自的说法与动作。
 */
const ROOT = new URL('../../', import.meta.url)
const { enforceCredentialPermission, hostStorePermission } = await import(
  new URL('src/host/platform/credential-permission.ts', ROOT).href)

/** 记录命令的 shell 替身：`result` 决定这次命令的结局。 */
function makeCtx(result = { exitCode: 0, stderr: '' }) {
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

test('POSIX：chmod 成功 → verified / posix-0600（真的跑了命令）', async () => {
  const ctx = makeCtx({ exitCode: 0 })
  const permission = await enforceCredentialPermission(ctx, '/Users/x/.dsh/cred.json', 'darwin-arm64', {
    workdir: '/Users/x', escalate: true,
  })
  assert.deepEqual(permission, { status: 'verified', mechanism: 'posix-0600', message: '' })
  assert.equal(ctx.commands.length, 1)
  assert.equal(ctx.commands[0].command, 'chmod 600 /Users/x/.dsh/cred.json')
  assert.equal(ctx.commands[0].sandboxPolicy?.mode, 'danger-full-access', '读本机凭据目录要提权')
})

test('POSIX：chmod 失败 → failed / posix-0600，原因逐字带出', async () => {
  const ctx = makeCtx({ exitCode: 1, stderr: 'chmod: Operation not permitted' })
  const permission = await enforceCredentialPermission(ctx, '/Users/x/.dsh/cred.json', 'linux-x64', { workdir: '/Users/x' })
  assert.equal(permission.status, 'failed')
  assert.equal(permission.mechanism, 'posix-0600')
  assert.match(permission.message, /Operation not permitted/)
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
  assert.deepEqual(ctx.commands, [], 'Windows 上没有 chmod：一条命令都不该发')
})

test('DSH 凭据服务托管时也不宣称「已验证」', () => {
  assert.deepEqual(hostStorePermission(), {
    status: 'inherited', mechanism: 'host-store', message: '凭据由 DSH 凭据服务保管，文件权限不适用',
  })
})
