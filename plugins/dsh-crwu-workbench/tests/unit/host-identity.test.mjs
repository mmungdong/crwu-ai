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

const { dwsSelf, readSelfDocument } = await import(new URL('src/host/system/identity.ts', ROOT).href)

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
    async run(spec) {
      commands.push(spec.command)
      if (down !== '' && spec.command.includes(down)) throw new Error('sandbox unavailable')
      return {
        exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
        stdout: { text: stdout, truncated: false },
        stderr: { text: '', truncated: false },
      }
    },
  }
  return {
    commands,
    specs,
    get: (name) => (name === 'shell' ? shell : undefined),
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
  const me = await dwsSelf({ ctx, workdir: async () => '/cases' })
  assert.deepEqual(me, { name: '杨凡宾', org: '中瑞世联资产评估集团有限公司', userId: '142227076626112869', reason: '' })
  assert.equal(ctx.commands.length, 1)
  assert.match(ctx.commands[0], /^dws contact user get-self --format json$/)
  // 读钥匙串的命令必须提权 + 带工作目录（DSH 拒绝无工作区的提权执行）。
  assert.equal(ctx.specs[0].sandboxPolicy.mode, 'danger-full-access')
  assert.equal(ctx.specs[0].workdir, '/cases')
})

test('dwsSelf 失败时降级成空姓名，并把真实原因带回来', async () => {
  // 命令根本没跑起来（沙箱后端不可用）。
  const down = makeCtx({ down: 'dws' })
  const failed = await dwsSelf({ ctx: down, workdir: async () => '/cases' })
  assert.equal(failed.name, '')
  assert.match(failed.reason, /sandbox unavailable/)

  // 跑完了但没登录 → stdout 里没有 orgEmployeeModel。
  const loggedOut = makeCtx({ stdout: '{"success":false,"message":"未登录"}' })
  const none = await dwsSelf({ ctx: loggedOut, workdir: async () => '/cases' })
  assert.equal(none.name, '')
  assert.match(none.reason, /没登录|个人信息/)
})
