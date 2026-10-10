/**
 * 本地审核的**交接认领**与**案例门禁**（协议 28）逐条测试。
 *
 * 这一份盯的是安全边界，而不是 UI：
 *
 * 1. 认领的身份只来自 `exec.agent.id`（模型提交不了"我是哪条会话"）；
 * 2. 一条 handoff 只服务**一条**会话（同会话幂等，别的会话拒绝）；
 * 3. 认领之后，`requireCaseAccess` 只认那一份案例目录 —— 别的目录、别的会话、工作空间根
 *    全部拒绝；没认领过的会话照旧走普通会话判据（不会因为多了这一类就放宽）；
 * 4. 任何失败都不许把模型引向"自己去本机找文件"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { localClaimTools } = await import(new URL('src/host/tools/local-claim.ts', ROOT).href)
const { createLocalAuditRegistry } = await import(new URL('src/host/local-audit/handoff.ts', ROOT).href)
const { prepareSnapshot, localAuditCaseDir } = await import(new URL('src/host/local-audit/snapshot.ts', ROOT).href)
const { requireCaseAccess, localDeliveryRefused } = await import(new URL('src/host/audit/case-access.ts', ROOT).href)

/** 内存快照 IO（与 host-local-audit.test.mjs 同一套替身口径）。 */
function memoryIo(options = {}) {
  const files = new Map()
  return {
    files,
    async makeDir() {},
    async copyFile(from, to) {
      if (options.failCopy?.includes(from)) throw new Error('读取失败')
      files.set(to, from)
    },
    async writeText(path, content) { files.set(path, content) },
    async readText(path) {
      const value = files.get(path)
      if (value === undefined) throw new Error('ENOENT')
      return value
    },
    async removeTree() {},
  }
}

/** 只提供 `resolve` 的 fs 替身：守卫判据走 `targetKey` 等值，字符串拼法不影响结论。 */
function fakeFs() {
  return {
    async resolve(path) { return { targetKey: `key:${path}`, displayPath: path } },
    async stat() { return { type: 'directory' } },
    contains() { return true },
  }
}

function ctxWith(fs = fakeFs()) {
  return { get: (name) => (name === 'fs' ? fs : undefined) }
}

const EMPTY_STATE = { audits: {}, auditRoot: undefined }

/** 测试用的已选工作空间（案例目录现在落在它下面）。 */
const WORKSPACE = '/work/中瑞世联工作空间'
const caseOf = (id) => localAuditCaseDir(WORKSPACE, id)

async function claimedRegistry(io, handoffId = 'la-77-abcdef') {
  const registry = createLocalAuditRegistry()
  const snapshot = await prepareSnapshot(handoffId, [
    { sourcePath: '/work/资产清单.xlsx', relativePath: '资产清单.xlsx', name: '资产清单.xlsx', sizeBytes: 2400 },
    { sourcePath: '/work/坏.zip', relativePath: '坏.zip', name: '坏.zip', sizeBytes: 1 },
  ], io, { casePath: caseOf(handoffId) })
  assert.equal(snapshot.ok, true)
  registry.create({ id: handoffId, casePath: snapshot.casePath, files: snapshot.files, skipped: snapshot.skipped })
  return { registry, casePath: snapshot.casePath }
}

function execOf(sessionId) {
  return { callId: 'c1', rootCallId: 'c1', name: 'crwu_audit_local_claim', arguments: {}, signal: undefined, agent: { id: sessionId } }
}

test('认领：成功时回传案例目录、模式与材料清单', async () => {
  const io = memoryIo({ failCopy: ['/work/坏.zip'] })
  const { registry, casePath } = await claimedRegistry(io)
  const tool = localClaimTools({ localAudit: registry, localAuditIo: io })[0]
  const value = await tool.execute({ handoffId: 'la-77-abcdef' }, execOf('session-1'))
  assert.equal(value.ok, true)
  assert.equal(value.caseDir, casePath)
  assert.equal(value.mode, 'local')
  assert.equal(value.fileCount, 1)
  assert.equal(value.skippedCount, 1)
  assert.deepEqual(value.files.map((item) => item.name), ['资产清单.xlsx'])
  assert.deepEqual(value.skipped.map((item) => item.name), ['坏.zip'])
  // 清单里只出现展示名 + 快照内相对路径；**用户原始文件的绝对路径**不许回传。
  // （注意：`caseDir` 本身是绝对路径，而且现在落在员工的工作空间下 —— 它必须给模型，
  //  所以这里只钉"原始来源路径"那两条，不做 `includes('/work/')` 这种粗判。）
  assert.equal(value.files[0].relativePath, '材料-源/资产清单.xlsx')
  for (const source of ['/work/资产清单.xlsx', '/work/坏.zip']) {
    assert.equal(JSON.stringify(value).includes(source), false, `不许回传原始来源路径：${source}`)
  }
})

test('认领：同一条会话重复调用幂等（自动链路先认领，模型随后再调一次）', async () => {
  const io = memoryIo()
  const { registry } = await claimedRegistry(io)
  const tool = localClaimTools({ localAudit: registry, localAuditIo: io })[0]
  const first = await tool.execute({ handoffId: 'la-77-abcdef' }, execOf('session-1'))
  const second = await tool.execute({ handoffId: 'la-77-abcdef' }, execOf('session-1'))
  assert.equal(first.ok, true)
  assert.deepEqual(second, first)
})

test('认领：别的会话拿不到（提示词不能重放）', async () => {
  const io = memoryIo()
  const { registry } = await claimedRegistry(io)
  const tool = localClaimTools({ localAudit: registry, localAuditIo: io })[0]
  assert.equal((await tool.execute({ handoffId: 'la-77-abcdef' }, execOf('session-1'))).ok, true)
  const other = await tool.execute({ handoffId: 'la-77-abcdef' }, execOf('session-2'))
  assert.equal(other.ok, false)
  assert.equal(other.errorKind, 'policy')
  assert.equal(other.caseDir, '')
})

test('认领：过期与未知 id 都指回 Workbench，而不是让模型去本机找文件', async () => {
  const io = memoryIo()
  const { registry } = await claimedRegistry(io)
  const tool = localClaimTools({ localAudit: registry, localAuditIo: io })[0]
  const unknown = await tool.execute({ handoffId: 'la-nope' }, execOf('session-1'))
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /重新选择或准备文件/)
  assert.equal(/本机|目录下|搜索/.test(unknown.error) && !/Workbench/.test(unknown.error), false)
})

test('认领：缺 handoffId 与缺装配各自如实报错（capability-gap，不抛异常）', async () => {
  const io = memoryIo()
  const { registry } = await claimedRegistry(io)
  const tool = localClaimTools({ localAudit: registry, localAuditIo: io })[0]
  // 缺字段由 DSH 的参数校验先挡下（框架行为，抛出 ToolArgsError）；
  // 空白字符串才轮到 execute 里的守卫 —— 两条路径都要有结论，都不能静默。
  await assert.rejects(async () => tool.execute({}, execOf('session-1')), /handoffId/)
  const blank = await tool.execute({ handoffId: '   ' }, execOf('session-1'))
  assert.equal(blank.errorKind, 'input')
  const unwired = localClaimTools({})[0]
  const gap = await unwired.execute({ handoffId: 'la-77-abcdef' }, execOf('session-1'))
  assert.equal(gap.ok, false)
  assert.equal(gap.errorKind, 'capability-gap')
})

test('案例门禁：认领过的会话只能用**本次**的案例目录', async () => {
  const io = memoryIo()
  const { registry, casePath } = await claimedRegistry(io)
  await registry.claim('la-77-abcdef', 'session-1', io)
  const ctx = ctxWith()

  const mine = await requireCaseAccess(ctx, EMPTY_STATE, { peek: () => undefined }, execOf('session-1'), { caseDir: casePath }, registry)
  assert.equal(mine.ok, true)
  assert.equal(mine.kind, 'local')
  assert.equal(mine.casePath, casePath)

  // 不带 caseDir 也放行（走 Host 记录的那一份）。
  const implicit = await requireCaseAccess(ctx, EMPTY_STATE, { peek: () => undefined }, execOf('session-1'), {}, registry)
  assert.equal(implicit.ok, true)

  // 别的案例目录 / 工作空间根 / 兄弟目录一律拒绝 —— 判据是"精确相等"。
  for (const wrong of ['/tmp/other-case', `${casePath}/子目录`, '/cases/space', '/cases/space/2026-1']) {
    const denied = await requireCaseAccess(ctx, EMPTY_STATE, { peek: () => undefined }, execOf('session-1'), { caseDir: wrong }, registry)
    assert.equal(denied.ok, false, `${wrong} 不该被放行`)
    assert.equal(denied.errorKind, 'policy')
  }
})

test('案例门禁：没认领过的会话不会被本地 scope 放行（普通会话判据照旧）', async () => {
  const io = memoryIo()
  const { registry, casePath } = await claimedRegistry(io)
  await registry.claim('la-77-abcdef', 'session-1', io)
  const denied = await requireCaseAccess(
    ctxWith(), EMPTY_STATE, { peek: () => undefined }, execOf('session-2'), { caseDir: casePath }, registry,
  )
  assert.equal(denied.ok, false, '别的会话不能借另一条会话的本地 scope 用案例目录')
})

test('案例门禁：没有本地注册表时，本地案例目录按普通会话判据被拒（fail closed）', async () => {
  const io = memoryIo()
  const { casePath } = await claimedRegistry(io)
  const denied = await requireCaseAccess(
    ctxWith(),
    { audits: {}, auditRoot: undefined, workspacePath: '/cases/space', caseRoot: '/cases/space' },
    { peek: () => undefined },
    execOf('session-1'),
    { caseDir: casePath },
  )
  assert.equal(denied.ok, false)
})

test('交付门禁：本地审核的产物不上传、不回传（提示词是请求，这里才是门禁）', () => {
  assert.equal(localDeliveryRefused({ kind: 'audit' }), null)
  assert.equal(localDeliveryRefused({ kind: 'discussion' }), null)
  assert.equal(localDeliveryRefused({ kind: 'session' }), null)
  const refused = localDeliveryRefused({ kind: 'local' })
  assert.notEqual(refused, null)
  assert.equal(refused.errorKind, 'policy')
  assert.match(refused.error, /不上传 OSS/)
  assert.match(refused.error, /钉钉/)
})
