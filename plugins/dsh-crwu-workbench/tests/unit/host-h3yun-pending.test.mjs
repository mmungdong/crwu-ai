/**
 * 第 2 层（待审核报告列表）的单元测试。
 *
 * 这一层最容易骗人的是「列表为空」：表单定位失败、应答形状没认出来、stdout 被截断，
 * 三种原因都会表现成空列表。所以每条都要能区分出具体原因。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { loadPending } = await import(new URL('src/host/h3yun/pending.ts', ROOT).href)
const { discoverForm } = await import(new URL('src/host/h3yun/discover.ts', ROOT).href)
const { RECORDS_STDOUT_MAX } = await import(new URL('src/host/h3yun/consts.ts', ROOT).href)

const CONFIG = { caseRoot: '/cases', formName: '报告审核', installDocUrl: '', manifestUrl: '', preferWorkspaceTitle: '', ossBucket: '', ossPrefix: '', ossEndpoint: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true, requireTopLevelParent: true }

function stateOf(patch = {}) {
  return {
    caseRoot: '/cases', workspacePath: '', workspaceTitle: '', workspaceSource: '', workspaceChosen: false,
    parentSessionId: '', trustH3yun: false, formCode: '', formName: '', audits: {},
    activeKey: '', activeChildId: '', activeSince: 0, ...patch,
  }
}

/** 按命令内容回放的 shell 替身；记录每条命令以便断言参数。 */
function shellStub(handler) {
  const commands = []
  const specs = []
  return {
    commands,
    specs,
    ctx: {
      get: (name) => (name === 'shell'
        ? {
            resolve(request) { specs.push(request); return request },
            async run(spec) {
              commands.push(spec.command)
              const out = handler(spec.command)
              return {
                exitCode: out.exitCode ?? 0,
                signal: null,
                timedOut: false,
                aborted: false,
                timeoutMs: 1,
                stdout: { text: out.stdout ?? '', truncated: out.truncated === true },
                stderr: { text: out.stderr ?? '', truncated: false },
              }
            },
          }
        : undefined),
    },
  }
}

const FORMS_JSON = JSON.stringify({ data: { returnData: [{ displayName: '报告审核', nodeType: '210', code: 'FORM-1' }] } })

function rowsJson(rows, total) {
  return JSON.stringify({ data: { returnData: rows, dataCount: total } })
}

// ── 表单定位 ────────────────────────────────────────────────────────────────

test('discoverForm reports the located form code', async () => {
  const shell = shellStub(() => ({ stdout: FORMS_JSON }))
  const found = await discoverForm(shell.ctx, '报告审核', { trusted: true, platform: 'darwin-arm64', sessionRoot: async () => '/cases/session' })
  assert.equal(found.ok, true)
  assert.equal(found.code, 'FORM-1')
  assert.equal(found.name, '报告审核')
  // 中文关键字不在 shell 安全字符集里，会被单引号包起来 —— 这是正确行为。
  assert.match(shell.commands[0], /crwu h3yun forms search --keyword '报告审核'/)
})

test('discoverForm explains a failed search and a missing form differently', async () => {
  const failed = shellStub(() => ({ exitCode: 1, stderr: 'not logged in' }))
  const bad = await discoverForm(failed.ctx, '报告审核', { trusted: true, sessionRoot: async () => '/cases/session' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /not logged in/)

  const noForm = shellStub(() => ({ stdout: JSON.stringify({ data: { returnData: [{ displayName: '别的', nodeType: '999' }] } }) }))
  const missing = await discoverForm(noForm.ctx, '报告审核', { trusted: true, sessionRoot: async () => '/cases/session' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /未在氚云定位到表单/)
})

test('discoverForm surfaces that escalation is available when the keychain blocked it', async () => {
  const shell = shellStub(() => ({ exitCode: 1, stderr: 'failed to access credential store' }))
  const found = await discoverForm(shell.ctx, '报告审核', { trusted: false, sessionRoot: async () => '/cases/session' })
  assert.equal(found.ok, false)
  assert.equal(found.escalateAvailable, true)
})

// ── 列表 ────────────────────────────────────────────────────────────────────

test('loadPending locates the form once and then reuses its code', async () => {
  const shell = shellStub((command) => (command.includes('forms search') ? { stdout: FORMS_JSON } : { stdout: rowsJson([{ ObjectId: 'obj-1', Name: 'X' }], 1) }))
  const state = stateOf()
  const deps = { ctx: shell.ctx, config: CONFIG, state, trusted: true, platform: 'darwin-arm64', sessionRoot: async () => '/cases/session' }

  const first = await loadPending(deps, {})
  assert.equal(first.ok, true)
  assert.equal(state.formCode, 'FORM-1')
  assert.equal(first.formName, '报告审核')
  assert.equal(first.rows.length, 1)

  shell.commands.length = 0
  await loadPending(deps, { page: 2 })
  assert.equal(shell.commands.length, 1, '第二次不得再搜表单')
  assert.match(shell.commands[0], /--schema FORM-1 --page 2 --size 20/)
})

test('loadPending passes the filter only when the query is usable', async () => {
  const shell = shellStub(() => ({ stdout: rowsJson([], 0) }))
  const state = stateOf({ formCode: 'FORM-1', formName: '报告审核' })
  const deps = { ctx: shell.ctx, config: CONFIG, state, trusted: true, platform: 'darwin-arm64', sessionRoot: async () => '/cases/session' }

  await loadPending(deps, { query: '2026-301705-LX10170' })
  assert.match(shell.commands[0], /--filter 'SeqNo Equal '\\''2026-301705-LX10170'\\'''/)

  shell.commands.length = 0
  const rejected = await loadPending(deps, { query: "301705'" })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /不能包含引号或反斜杠/)
  assert.equal(shell.commands.length, 0, '非法检索词不得发到氚云')
})

test('loadPending clamps page/size and never sends NaN', async () => {
  const shell = shellStub(() => ({ stdout: rowsJson([], 0) }))
  const state = stateOf({ formCode: 'FORM-1', formName: '报告审核' })
  const deps = { ctx: shell.ctx, config: CONFIG, state, trusted: true, platform: 'darwin-arm64', sessionRoot: async () => '/cases/session' }

  const clamped = await loadPending(deps, { page: -5, size: 9999 })
  assert.equal(clamped.page, 1)
  assert.equal(clamped.size, 100)
  assert.match(shell.commands[0], /--page 1 --size 100/)

  shell.commands.length = 0
  const nan = await loadPending(deps, { page: 'abc', size: null })
  assert.equal(nan.page, 1)
  assert.equal(nan.size, 20)
})

test('loadPending requests the big stdout budget so a full page is not truncated', async () => {
  const shell = shellStub(() => ({ stdout: rowsJson([], 0) }))
  const state = stateOf({ formCode: 'FORM-1', formName: '报告审核' })
  await loadPending({ ctx: shell.ctx, config: CONFIG, state, trusted: true, platform: 'darwin-arm64', sessionRoot: async () => '/cases/session' }, {})
  assert.equal(shell.specs[0].stdoutMaxBytes, RECORDS_STDOUT_MAX)
})

test('loadPending reports a truncated/failed payload with the CLI reason, not an empty list', async () => {
  const shell = shellStub(() => ({ exitCode: 0, stdout: '{"data":{"returnData":[', truncated: true }))
  const state = stateOf({ formCode: 'FORM-1', formName: '报告审核' })
  const result = await loadPending({ ctx: shell.ctx, config: CONFIG, state, trusted: true, platform: 'darwin-arm64', sessionRoot: async () => '/cases/session' }, {})
  assert.equal(result.ok, false)
  assert.equal(result.rows.length, 0)
  assert.ok(result.error.length > 0, '必须带出原因，否则界面会显示「没有待办」')
})

test('loadPending returns the total and rows from a successful page', async () => {
  const shell = shellStub(() => ({
    stdout: rowsJson([
      { ObjectId: 'a'.repeat(10), Name: '项目一', SeqNo: '2026-301705-LX10170', F0000158: { label: '二级' } },
      { ObjectId: 'b'.repeat(10), Name: '项目二' },
    ], 37),
  }))
  const state = stateOf({ formCode: 'FORM-1', formName: '报告审核' })
  const result = await loadPending({ ctx: shell.ctx, config: CONFIG, state, trusted: true, platform: 'darwin-arm64', sessionRoot: async () => '/cases/session' }, { page: 2, size: 20 })
  assert.equal(result.ok, true)
  assert.equal(result.total, 37)
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0].reviewLevel, '二级')
  assert.equal(result.rows[0].idTail, 'aaaaaaaa')
})
