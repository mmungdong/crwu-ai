/**
 * 「我是谁」（`dwsSelf`）的单元测试。
 *
 * 面板头部那句「晚上好，某某某」全靠它，而它挂在**环境自检**上（不单独开操作 ——
 * 用户 2026-09-22 口径：「这个钉钉 cli 环境监测一遍就可以了，不需要每次切换页面都去调」）。
 * 要守住三件事：
 * 1. 姓名从 JSON 里取（`result[0].orgEmployeeModel.orgUserName`），不做文本匹配；
 * 2. 提权 + 带工作目录（读钥匙串的命令漏了任一条都会静默失败）；
 * 3. **失败降级成空姓名**（界面据此整句不展示），绝不抛。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)

const { dwsSelf, readSelfDocument } = await import(new URL('src/host/system/identity.ts', ROOT).href)
const { bundledBinaryPath } = await import(new URL('src/host/platform/bin-dir.ts', ROOT).href)

/** `dws contact user get-self --format json` 的真实返回体（本机实测抄回，只截掉无关字段）。 */
const SELF_JSON = JSON.stringify({
  result: [
    {
      isAdmin: false,
      orgEmployeeModel: {
        corpId: 'dinge3ec4caa9d74beddf2c783f7214b6d69',
        depts: [{ deptId: 422583838, deptName: '信息技术部', deptPathName: '北京分公司-信息技术部' }],
        orgName: '中瑞世联资产评估集团有限公司',
        orgUserName: '杨凡宾',
        stateCode: '86',
        userId: '142227076626112869',
      },
    },
  ],
  success: true,
})

/** ctx：shell 按命令回放并记录命令；`down` 命中时抛错（沙箱后端不可用那种基础设施故障）。 */
function makeCtx({ stdout = '', down = '' } = {}) {
  const commands = []
  const specs = []
  const shell = {
    resolve(request) { specs.push(request); return request },
    async execute(spec) {
      commands.push(spec.command)
      if (down !== '' && spec.command.includes(down)) throw new Error('sandbox unavailable')
      return { result: async () => ({
        exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
        stdout: { text: stdout, truncated: false },
        stderr: { text: '', truncated: false },
      }) }
    },
  }
  return {
    commands,
    specs,
    get: (name) => {
      if (name === 'shell') return shell
      if (name === 'fs') {
        // `dwsSelf` 经 `runDws` 执行，而 `runDws` 只认**包内绝对路径**（不回退裸命令名）。
        // 所以这个替身要让包内那份 `dws` "存在"。
        const bundled = bundledBinaryPath('darwin-arm64', 'dws')
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) { return target.targetKey === bundled ? { type: 'file' } : undefined },
        }
      }
      return undefined
    },
    effect: (callback) => { const dispose = callback(); return () => { if (typeof dispose === 'function') dispose() } },
  }
}

test('readSelfDocument 从真实返回体里取出姓名 / 公司 / userId', () => {
  assert.deepEqual(readSelfDocument(JSON.parse(SELF_JSON)), {
    name: '杨凡宾', org: '中瑞世联资产评估集团有限公司', userId: '142227076626112869',
  })
  // 形状不对就是 null（上层据此说"拿不到"，绝不编造姓名）。
  for (const junk of [null, {}, { result: [] }, { result: [{}] }, { result: [{ orgEmployeeModel: {} }] }, '  ']) {
    assert.equal(readSelfDocument(junk), null, `${JSON.stringify(junk)} 不该解析出姓名`)
  }
})

test('dwsSelf 跑的是 get-self，并且把 name/org/userId 收窄出来', async () => {
  const ctx = makeCtx({ stdout: SELF_JSON })
  const me = await dwsSelf({ ctx, access: makeTestAccess(ctx).access, workdir: async () => '/cases', platform: 'darwin-arm64' })
  assert.deepEqual(me, { name: '杨凡宾', org: '中瑞世联资产评估集团有限公司', userId: '142227076626112869', reason: '' })
  assert.equal(ctx.commands.length, 1)
  // 经 `runDws` 之后命令用的是**包内绝对路径**（POSIX 上不需要引号的 token 保持原样），
  // 不再是裸命令名 —— 裸命令名正是 Finder 启动的桌面端上「点了没有任何反应」的原因。
  assert.match(ctx.commands[0], /\/bin\/darwin-arm64\/dws contact user get-self --format json$/)
  assert.equal(ctx.commands[0].startsWith('dws '), false, '不许出现裸命令名')
  // 读钥匙串的命令必须提权 + 带工作目录（DSH 拒绝无工作区的提权执行）。
  assert.equal(ctx.specs[0].sandboxPolicy.mode, 'danger-full-access')
  assert.equal(ctx.specs[0].workdir, '/cases')
})

test('dwsSelf 失败时降级成空姓名，并把真实原因带回来', async () => {
  // 命令根本没跑起来（沙箱后端不可用）。
  const down = makeCtx({ down: 'dws' })
  const failed = await dwsSelf({ ctx: down, access: makeTestAccess(down).access, workdir: async () => '/cases', platform: 'darwin-arm64' })
  assert.equal(failed.name, '')
  assert.match(failed.reason, /sandbox unavailable/)

  // 跑完了但没登录 → stdout 里没有 orgEmployeeModel。
  const loggedOut = makeCtx({ stdout: '{"success":false,"message":"未登录"}' })
  const none = await dwsSelf({ ctx: loggedOut, access: makeTestAccess(loggedOut).access, workdir: async () => '/cases', platform: 'darwin-arm64' })
  assert.equal(none.name, '')
  assert.match(none.reason, /没登录|个人信息/)
})
