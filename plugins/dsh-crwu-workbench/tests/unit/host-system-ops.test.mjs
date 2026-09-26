/**
 * 第 5 层（零碎操作）的单元测试。
 *
 * 重点有两个：
 * 1. **`openPath` 的目录包含检查**：没有它，面板就成了「让宿主机用默认程序打开任意路径」
 *    的入口。要能反向失败 —— 案例根目录之外的文件必须被拒。
 * 2. **提权命令必须带工作目录**：DSH 拒绝无工作区的提权执行，漏传会静默变成「命令失败」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { clipboard, openPath, dwsLogin, relogin, sessionStatus, ossCred } = await import(
  new URL('src/host/system/ops.ts', ROOT).href
)
const { sessionView, isExpired, parseSessionOutput } = await import(new URL('src/host/h3yun/session.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossEndpoint: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600,
  autoUpload: true, requireTopLevelParent: true,
}

/** ctx：shell 记录命令与 spec，fs 提供 stat/contains/readText。 */
function makeCtx({ shell, inside = () => true, files = {}, dirs = [] } = {}) {
  const commands = []
  const specs = []
  const directories = new Set(dirs)
  return {
    commands,
    specs,
    get(name) {
      if (name === 'shell') {
        return {
          resolve(request) { specs.push(request); return request },
          async execute(spec) {
            commands.push(spec.command)
            const out = shell === undefined ? { stdout: '' } : shell(spec.command, spec)
            return { result: async () => ({
              // 注意不能用 `?? 0`：`exitCode: null`（进程被信号杀死）会被当成 0，
              // 于是「超时/被杀」在测试里变成成功。用属性存在性判断。
              exitCode: 'exitCode' in out ? out.exitCode : 0,
              signal: null, timedOut: out.timedOut === true, aborted: false, timeoutMs: 1,
              stdout: { text: out.stdout ?? '', truncated: false },
              stderr: { text: out.stderr ?? '', truncated: false },
            }) }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: String(path).replace(/[\\/]+$/, ''), displayPath: path } },
          async stat(target) {
            if (directories.has(target.targetKey)) return { type: 'directory' }
            return files[target.targetKey] === undefined ? undefined : { type: 'file' }
          },
          async readText(target) { return files[target.targetKey] ?? '' },
          async writeText(target, content) { files[target.targetKey] = content; return { operation: 'update', version: 'v', before: null, after: content } },
          async listDir() { return [] },
          contains(parent, child) { return inside(parent, child) },
        }
      }
      return undefined
    },
  }
}

function depsOf(ctx, patch = {}) {
  const state = { ...createWorkbenchState(CONFIG), workspacePath: '/cases', caseRoot: '/cases', workspaceChosen: true, ...patch.state }
  return { ctx, state, platform: patch.platform ?? 'darwin-arm64', workdir: async () => patch.workdir ?? '/cases/session' }
}

// ── 会话解析 ────────────────────────────────────────────────────────────────

test('sessionView narrows the crwu envelope and tolerates junk', () => {
  assert.deepEqual(sessionView({ data: { userId: 'u1', expiresAt: '2099-01-01T00:00:00Z', expiresIn: '1h' } }),
    { userId: 'u1', expiresAt: '2099-01-01T00:00:00Z', expiresIn: '1h' })
  assert.equal(sessionView({ data: null }), null)
  assert.equal(sessionView({}), null)
  assert.equal(sessionView(null), null)
  assert.equal(parseSessionOutput('{oops'), null)
  assert.equal(parseSessionOutput('{"data":{"userId":"u"}}').userId, 'u')
})

test('isExpired only judges when a parseable expiry is present', () => {
  const now = Date.parse('2026-09-20T00:00:00Z')
  assert.equal(isExpired({ userId: '', expiresAt: '2026-09-19T00:00:00Z', expiresIn: '' }, now), true)
  assert.equal(isExpired({ userId: '', expiresAt: '2026-09-21T00:00:00Z', expiresIn: '' }, now), false)
  // 解析不出时间时不算过期：宁可让用户去试，也不要误报成「未登录」。
  assert.equal(isExpired({ userId: '', expiresAt: 'not-a-date', expiresIn: '' }, now), false)
  assert.equal(isExpired({ userId: '', expiresAt: '', expiresIn: '' }, now), false)
  assert.equal(isExpired(null, now), false)
})

// ── clipboard ───────────────────────────────────────────────────────────────

test('clipboard sends the text on stdin, never as an argument', async () => {
  const ctx = makeCtx({ shell: () => ({ stdout: '' }) })
  const result = await clipboard(depsOf(ctx), { text: '请审核这条报告 $(rm -rf /) `id`' })
  assert.equal(result.ok, true)
  // 内容拼进命令行会被 shell 解释 —— 必须走 stdin。
  assert.deepEqual(ctx.specs[0].stdin, '请审核这条报告 $(rm -rf /) `id`')
  assert.equal(ctx.specs[0].command, 'pbcopy')
  assert.equal(ctx.specs[0].command.includes('rm -rf'), false)
})

test('clipboard picks the platform command and refuses empty content', async () => {
  const mac = makeCtx({ shell: () => ({ stdout: '' }) })
  await clipboard(depsOf(mac), { text: 'x' })
  assert.equal(mac.commands[0], 'pbcopy')

  const win = makeCtx({ shell: () => ({ stdout: '' }) })
  await clipboard(depsOf(win, { platform: 'win32-x64' }), { text: 'x' })
  assert.equal(win.commands[0], 'clip')

  const linux = makeCtx({ shell: () => ({ stdout: '' }) })
  await clipboard(depsOf(linux, { platform: 'linux-x64' }), { text: 'x' })
  assert.match(linux.commands[0], /xclip/)

  const empty = makeCtx({ shell: () => ({ stdout: '' }) })
  assert.match((await clipboard(depsOf(empty), { text: '' })).error, /没有内容/)
  assert.equal(empty.commands.length, 0)
})

test('clipboard reports a failing command instead of pretending success', async () => {
  const ctx = makeCtx({ shell: () => ({ exitCode: 1, stderr: 'pbcopy: not found' }) })
  const result = await clipboard(depsOf(ctx), { text: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /not found/)
})

// ── open-path：安全边界 ─────────────────────────────────────────────────────

test('openPath refuses a file outside the case root', async () => {
  // 没有这条检查，面板就是「用默认程序打开任意路径」的入口。
  const ctx = makeCtx({
    shell: () => ({ stdout: '' }),
    inside: () => false,
    files: { '/etc/passwd': { type: 'file' } },
  })
  const result = await openPath(depsOf(ctx), { path: '/etc/passwd' })
  assert.equal(result.ok, false)
  assert.match(result.error, /只允许打开案例根目录内的文件/)
  assert.equal(ctx.commands.some((command) => command.startsWith('open')), false, '被拒时不得执行打开命令')
})

test('openPath opens a file inside the case root', async () => {
  const ctx = makeCtx({
    shell: () => ({ stdout: '' }),
    inside: () => true,
    files: { '/cases/S1/审核意见.S1.html': { type: 'file' } },
  })
  const result = await openPath(depsOf(ctx), { path: '/cases/S1/审核意见.S1.html' })
  assert.equal(result.ok, true)
  assert.equal(result.platform, 'darwin-arm64')
  assert.match(ctx.commands[0], /^open /)
})

test('openPath refuses a directory and a missing path', async () => {
  const dir = makeCtx({ shell: () => ({ stdout: '' }), inside: () => true, dirs: ['/cases/S1'] })
  assert.match((await openPath(depsOf(dir), { path: '/cases/S1' })).error, /目标不是文件/)

  const missing = makeCtx({ shell: () => ({ stdout: '' }), inside: () => true })
  assert.match((await openPath(depsOf(missing), { path: '/cases/S1/none.html' })).error, /目标不是文件/)

  const empty = makeCtx({ shell: () => ({ stdout: '' }) })
  assert.match((await openPath(depsOf(empty), { path: '' })).error, /缺少路径/)
})

test('openPath picks the platform opener', async () => {
  const files = { '/cases/a.html': { type: 'file' } }
  const win = makeCtx({ shell: () => ({ stdout: '' }), inside: () => true, files })
  await openPath(depsOf(win, { platform: 'win32-x64' }), { path: '/cases/a.html' })
  assert.match(win.commands[0], /^cmd \/c start/)

  const linux = makeCtx({ shell: () => ({ stdout: '' }), inside: () => true, files })
  await openPath(depsOf(linux, { platform: 'linux-x64' }), { path: '/cases/a.html' })
  assert.match(linux.commands[0], /^xdg-open /)
})

test('every escalated command carries a working directory', async () => {
  // DSH 拒绝「无工作区的提权执行」；漏传会静默变成命令失败。
  const ctx = makeCtx({ shell: () => ({ stdout: '' }), inside: () => true, files: { '/cases/a.html': { type: 'file' } } })
  const deps = depsOf(ctx)
  await clipboard(deps, { text: 'x' })
  await openPath(deps, { path: '/cases/a.html' })
  await dwsLogin(deps, {})
  for (const spec of ctx.specs) {
    assert.equal(spec.sandboxPolicy?.mode, 'danger-full-access', `${spec.command} 应当在沙箱外执行`)
    assert.equal(spec.sandboxPolicy.workspaceRoot, '/cases/session', `${spec.command} 的提权必须绑工作区`)
  }
})

// ── 登录与会话 ──────────────────────────────────────────────────────────────

test('dwsLogin passes --device only when asked and reports the tails', async () => {
  const ctx = makeCtx({ shell: () => ({ stdout: 'x'.repeat(900) + 'TAIL', stderr: 'err' }) })
  const result = await dwsLogin(depsOf(ctx), { device: true })
  assert.equal(result.ok, true)
  assert.match(ctx.commands[0], /dws auth login --device/)
  assert.equal(result.stdoutTail.endsWith('TAIL'), true)
  assert.ok(result.stdoutTail.length <= 600, '只回尾部，避免把整段输出塞进响应')

  const plain = makeCtx({ shell: () => ({ stdout: '' }) })
  await dwsLogin(depsOf(plain), {})
  assert.equal(plain.commands[0].includes('--device'), false)
})

test('dwsLogin surfaces a timeout instead of a silent failure', async () => {
  const ctx = makeCtx({ shell: () => ({ exitCode: null, timedOut: true, stderr: 'timeout' }) })
  const result = await dwsLogin(depsOf(ctx), {})
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
})

test('relogin runs the whitelisted crwu session login and parses the session', async () => {
  const ctx = makeCtx({ shell: () => ({ stdout: JSON.stringify({ data: { userId: 'u1', expiresAt: '2099-01-01T00:00:00Z' } }) }) })
  const result = await relogin(depsOf(ctx))
  assert.equal(result.ok, true)
  assert.match(ctx.commands[0], /^crwu h3yun session login/)
  assert.equal(result.session.userId, 'u1')
})

test('sessionStatus reports the failure reason when crwu cannot answer', async () => {
  const ctx = makeCtx({ shell: () => ({ exitCode: 1, stderr: 'no session' }) })
  const result = await sessionStatus(depsOf(ctx))
  assert.equal(result.ok, false)
  assert.match(result.error, /no session/)
  assert.equal(result.session, null)
})

test('sessionStatus parses a healthy session', async () => {
  const ctx = makeCtx({ shell: () => ({ stdout: JSON.stringify({ data: { userId: 'u9', expiresAt: '2099-01-01T00:00:00Z' } }) }) })
  const result = await sessionStatus(depsOf(ctx))
  assert.equal(result.ok, true)
  assert.equal(result.session.userId, 'u9')
})

// ── oss-cred ────────────────────────────────────────────────────────────────

test('ossCred returns a masked view and never the secret', async () => {
  const files = { '/Users/x/.ossutilconfig': 'accessKeyID=AKID1234567890\naccessKeySecret=TOPSECRET\n' }
  const ctx = makeCtx({ shell: () => ({ stdout: '' }), files })
  const result = await ossCred(depsOf(ctx), '/Users/x')
  assert.equal(result.ok, true)
  assert.equal(result.cred.exists, true)
  assert.equal(result.cred.hasSecret, true)
  assert.equal(result.cred.accessKeyIdMasked, 'AKID****7890')
  assert.equal(JSON.stringify(result).includes('TOPSECRET'), false)
})

test('ossCred reports a missing config without throwing', async () => {
  const ctx = makeCtx({ shell: () => ({ stdout: '' }) })
  const result = await ossCred(depsOf(ctx), '/Users/x')
  assert.equal(result.ok, true)
  assert.equal(result.cred.exists, false)
  assert.equal(result.cred.path, '/Users/x/.ossutilconfig')
})
