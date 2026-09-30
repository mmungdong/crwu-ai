/**
 * 本机访问授权收据的**解析与状态迁移**测试（协议 18 · 子项目 A）。
 *
 * 这一层是整条权限链的判据来源：`env` / `boot` 报的授权状态、门禁放不放行、
 * 界面显示哪张卡，全都从 `localAccessViewOf()` 与 `grantLocalAccess()` / `revokeLocalAccess()`
 * 推出来。所以最容易出的事是「看起来已授权、其实是旧范围」—— 那正好是**静默扩权**。
 *
 * 逐条对着设计文档 §5.2 / §6 A1 的迁移表：
 * | 起始 | 动作 | 落盘 | 内存 |
 * | --- | --- | --- | --- |
 * | missing/outdated/revoked | grant 成功 | 有效收据 | granted |
 * | missing/outdated/revoked | grant 失败 | 旧数据不变 | 不放行 + `ok:false` |
 * | granted | revoke 成功 | 撤销墓碑 | revoked |
 * | granted | revoke 失败 | 旧授权可能还在 | **立即关闭** + `ok:false` + `persist-failed` |
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const {
  localAccessViewOf, grantLocalAccess, revokeLocalAccess, syncLocalAccessConsent,
  localAccessGranted, missingLocalAccessView, readLocalAccessConsent,
} = await import(new URL('src/host/access/consent.ts', ROOT).href)
const {
  LOCAL_ACCESS_CAPABILITIES, LOCAL_ACCESS_SCHEMA_VERSION, isCanonicalLocalAccessRequest,
} = await import(new URL('src/shared/access/types.ts', ROOT).href)
const { consentRecord } = await import(new URL('tests/helpers/local-access-fixture.mjs', ROOT).href)
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)

const GRANTED_AT = '2026-09-28T00:00:00.000Z'

/** 最小 ctx：只提供 `fs`，并且写进去真的能读回来（授权是"先落盘、再回读"的）。 */
function memoryCtx() {
  const files = {}
  const writes = []
  const policies = []
  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) { return files[target.targetKey] === undefined ? undefined : { type: 'file' } },
    async readText(target) { return files[target.targetKey] ?? '' },
    async writeText(target, content, ...rest) {
      writes.push(content)
      policies.push(rest[2])
      files[target.targetKey] = content
      return { operation: 'update', version: 'v', before: null, after: content }
    },
  }
  const originalWrite = fs.writeText
  return {
    files,
    writes,
    policies,
    /**
     * 与 Broker 共享的**活**状态对象。
     *
     * 撤销要在任何 `await` 之前把内存切到关闭态（协议 18 收紧口径），
     * 所以它必须拿到 Broker 正在看的那个对象，而不是一份副本。
     */
    state: { localAccess: missingLocalAccessView() },
    ctx: { get: (name) => (name === 'fs' ? fs : undefined) },
    /** 让写入失败，用来验证「失败时不放行 / 撤销失败也 fail closed」。 */
    failWrites(error = new Error('disk full')) { fs.writeText = async () => { throw error } },
    /** 恢复写入（配合 `failWrites` 造"先失败、后重新允许"的序列）。 */
    restoreWrites() { fs.writeText = originalWrite },
  }
}

// ── 解析：什么算授权、什么不算 ────────────────────────────────────────────────

test('没有收据就是 missing；旧的 trustCredentials:false 同样不是授权', () => {
  assert.equal(localAccessViewOf({}).state, 'missing')
  assert.equal(localAccessViewOf({ trustCredentials: false }).state, 'missing')
  assert.equal(localAccessViewOf({ workspacePath: '/cases/x' }).state, 'missing')
})

test('A-01：旧的 trustCredentials:true 判成 outdated，**绝不是** granted（不许静默扩权）', () => {
  const view = localAccessViewOf({ trustCredentials: true })
  assert.equal(view.state, 'outdated')
  assert.equal(view.schemaVersion, 0)
  assert.deepEqual(view.capabilities, [], '旧布尔值推不出能力清单，所以一个能力都不给')
  // 原因必须说清是"旧版本留下的授权"，员工才知道为什么要重新允许一次。
  assert.match(view.reason, /旧版本/)
  assert.equal(localAccessGranted(view), false)
})

test('规范收据 → granted，并保留授权时刻与规范能力顺序', () => {
  const view = localAccessViewOf({ localAccessConsent: consentRecord(GRANTED_AT) })
  assert.equal(view.state, 'granted')
  assert.equal(view.grantedAt, GRANTED_AT)
  assert.equal(view.schemaVersion, LOCAL_ACCESS_SCHEMA_VERSION)
  assert.deepEqual(view.capabilities, [...LOCAL_ACCESS_CAPABILITIES])
  assert.equal(localAccessGranted(view), true)
})

test('版本不同 / 缺项 / 多项 / 重复 / 顺序不同 / 缺时刻，一律 outdated（任何不精确的集合都不是授权）', () => {
  const base = consentRecord(GRANTED_AT)
  const cases = [
    ['版本不同', { ...base, schemaVersion: 2 }, /其它版本/],
    ['版本缺失', { ...base, schemaVersion: undefined }, /其它版本/],
    ['缺一项', { ...base, capabilities: base.capabilities.slice(0, 4) }, /重新允许/],
    ['多一个已知项（重复）', { ...base, capabilities: [...base.capabilities, base.capabilities[0]] }, /重新允许/],
    ['顺序不同', { ...base, capabilities: [...base.capabilities].reverse() }, /重新允许/],
    ['不认识的项', { ...base, capabilities: [...base.capabilities.slice(0, 4), 'read-everything'] }, /不认识/],
    ['能力不是数组', { ...base, capabilities: 'all' }, /不认识/],
    ['缺授权时刻', { ...base, grantedAt: '' }, /重新允许/],
  ]
  for (const [name, record, pattern] of cases) {
    const view = localAccessViewOf({ localAccessConsent: record })
    assert.equal(view.state, 'outdated', name)
    assert.deepEqual(view.capabilities, [], `${name}：outdated 时不许带回任何能力`)
    assert.match(view.reason, pattern, name)
    assert.equal(localAccessGranted(view), false, name)
  }
})

test('空能力集合是**撤销墓碑**：状态是 revoked，不是 missing（不自动再问一次）', () => {
  const view = localAccessViewOf({
    localAccessConsent: { schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION, grantedAt: GRANTED_AT, capabilities: [] },
  })
  assert.equal(view.state, 'revoked')
  assert.equal(localAccessGranted(view), false)
  assert.match(view.reason, /已撤销/)
})

test('isCanonicalLocalAccessRequest：只接受**逐字**等于规范清单的提交', () => {
  assert.equal(isCanonicalLocalAccessRequest([...LOCAL_ACCESS_CAPABILITIES]), true)
  for (const bad of [
    undefined, null, 'all', [],
    [...LOCAL_ACCESS_CAPABILITIES].slice(0, 4),
    [...LOCAL_ACCESS_CAPABILITIES, 'evil'],
    [...LOCAL_ACCESS_CAPABILITIES].reverse(),
    [...LOCAL_ACCESS_CAPABILITIES, LOCAL_ACCESS_CAPABILITIES[0]],
  ]) {
    assert.equal(isCanonicalLocalAccessRequest(bad), false, JSON.stringify(bad))
  }
})

test('missingLocalAccessView 是 fail-closed 初值：missing、无能力、版本是当前版本', () => {
  const view = missingLocalAccessView()
  assert.equal(view.state, 'missing')
  assert.deepEqual(view.capabilities, [])
  assert.equal(view.requiredSchemaVersion, LOCAL_ACCESS_SCHEMA_VERSION)
  assert.equal(localAccessGranted(view), false)
  assert.equal(localAccessGranted(undefined), false, 'undefined（旧状态对象）也必须按未授权处理')
})

// ── 读不出来 ≠ 没有授权（2026-09-30 复查） ───────────────────────────────────

/** 五种「收据读不出来」的现场（真机上的每一种都真发生过，只是以前全被折叠成 missing）。 */
function readFailureCtx(kind) {
  const base = (patch) => ({
    get: () => ({
      async resolve(path) { return { targetKey: path, displayPath: path } },
      async stat() { return { type: 'file' } },
      async readText() { return '{}' },
      ...patch,
    }),
  })
  if (kind === 'no-fs') return { get: () => undefined }
  if (kind === 'stat') return base({ async stat() { throw new Error('boom') } })
  if (kind === 'read') return base({ async readText() { throw new Error('EIO') } })
  if (kind === 'resolve') return base({ async resolve() { throw new Error('bad path') } })
  return base({ async stat() { return { type: 'directory' } } })
}

test('B-01：读不出来是 unreadable，**不是** missing（否则界面把员工指去"再授权一次"）', async () => {
  for (const kind of ['no-fs', 'stat', 'read', 'resolve', 'not-a-file']) {
    const ctx = readFailureCtx(kind)
    const view = await readLocalAccessConsent({ ctx, home: '/Users/x', access: makeTestAccess(ctx).access })
    assert.equal(view.state, 'unreadable', kind)
    assert.deepEqual(view.capabilities, [], `${kind}：读不出来时一个能力都不给`)
    assert.equal(localAccessGranted(view), false, kind)
    // 原因必须**明说**它不等于"没有授权"：否则员工还是会去再授权一次。
    assert.match(view.reason, /不是「没有授权」/, kind)
  }

  // 内容损坏：同样是 unreadable，但它**可以**靠重新允许一次重建。
  const corrupt = memoryCtx()
  corrupt.files['/Users/x/.dsh/crwu-workbench.json'] = '{oops'
  const corruptView = await readLocalAccessConsent({
    ctx: corrupt.ctx, home: '/Users/x', access: makeTestAccess(corrupt.ctx).access,
  })
  assert.equal(corruptView.state, 'unreadable')
  assert.match(corruptView.reason, /重建/)

  // 主目录未知：**绝不**退化成 `~/.dsh/…` 那条相对路径（它会伪装成"从没授权过"）。
  const noHomeMem = memoryCtx()
  const noHome = await readLocalAccessConsent({
    ctx: noHomeMem.ctx, home: '', access: makeTestAccess(noHomeMem.ctx).access,
  })
  assert.equal(noHome.state, 'unreadable')
  assert.match(noHome.reason, /主目录/)
})

test('B-02：读失败时 grant 既不许动磁盘、也不许报成"落盘失败"（活状态是 unreadable）', async () => {
  // ① 内容损坏：可以重建 —— 重新允许一次必须真的修好它。
  const corrupt = memoryCtx()
  corrupt.files['/Users/x/.dsh/crwu-workbench.json'] = '{oops'
  const rebuilt = await grantLocalAccess(
    { ctx: corrupt.ctx, home: '/Users/x', access: makeTestAccess(corrupt.ctx).access },
    { schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION, capabilities: [...LOCAL_ACCESS_CAPABILITIES] },
  )
  assert.equal(rebuilt.ok, true, rebuilt.error)
  assert.equal(rebuilt.consent.state, 'granted')

  // ② 真读失败：写盘是读-改-写，读不到就写不进去 —— ok:false、磁盘一字不动、活状态是 unreadable。
  const broken = memoryCtx()
  const before = JSON.stringify({ workspacePath: '/cases/keep-me' })
  broken.files['/Users/x/.dsh/crwu-workbench.json'] = before
  const originalGet = broken.ctx.get
  broken.ctx.get = (name) => {
    const value = originalGet(name)
    if (name !== 'fs' || value === undefined) return value
    return { ...value, async stat() { throw new Error('boom') } }
  }
  const refused = await grantLocalAccess(
    { ctx: broken.ctx, home: '/Users/x', access: makeTestAccess(broken.ctx).access, state: broken.state },
    { schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION, capabilities: [...LOCAL_ACCESS_CAPABILITIES] },
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.consent.state, 'unreadable', '读失败不是"落盘失败"：混淆会让人去查磁盘空间')
  assert.equal(broken.state.localAccess.state, 'unreadable', '活状态也要落在 unreadable')
  assert.match(refused.error, /不是「没有授权」/)
  assert.equal(broken.files['/Users/x/.dsh/crwu-workbench.json'], before, '读不到就一个字都不许改')
  assert.deepEqual(broken.writes, [], '一次写入都不该发生')
})

// ── 迁移：先落盘后放行 / 撤销失败也 fail closed ──────────────────────────────

test('grant 成功：先落盘再回读 → granted；提交的清单与时刻进磁盘', async () => {
  const { ctx, files, writes, policies } = memoryCtx()
  const result = await grantLocalAccess({ ctx, home: '/Users/x', access: makeTestAccess(ctx).access }, {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  assert.equal(result.ok, true)
  assert.equal(result.consent.state, 'granted')
  assert.equal(writes.length, 1)
  const onDisk = JSON.parse(files['/Users/x/.dsh/crwu-workbench.json'])
  assert.deepEqual(onDisk.localAccessConsent.capabilities, [...LOCAL_ACCESS_CAPABILITIES])
  assert.equal(typeof onDisk.localAccessConsent.grantedAt, 'string')
  assert.equal(onDisk.trustCredentials, undefined, '新代码不再写旧布尔键')
  // 工作台状态文件在工作区之外：受限沙箱下不逐次声明策略就写不进去（实测踩过）。
  assert.equal(policies[0]?.mode, 'danger-full-access')
})

test('A-01 · 升级场景：文件里只有旧版 `trustCredentials: true` 时，授予之后旧键必须被抹掉', async () => {
  // 真实现场（2026-09-29 在用户机器上核过）：`~/.dsh/crwu-workbench.json` 里有
  // `trustCredentials: true` 而没有 `localAccessConsent`。新版把它判成 `outdated`
  //（**不是** granted —— 不许静默扩权）；员工重新允许一次之后，磁盘上不该再留着那个旧键，
  // 否则"这个文件里哪一个是授权"就有了两个事实源。
  assert.equal(localAccessViewOf({ trustCredentials: true }).state, 'outdated')

  const mem = memoryCtx()
  // 文件形状照**真实现场**来（2026-09-29 在用户机器上核过）：旧信任标记 + 一批审核记录 +
  // 工作空间 + 占用锁。断言的是"合并写入**只**碰授权那一个字段"，
  // 而不是"恰好 workspacePath 还在"——后者挡不住"顺手抹掉 audits"这种回归。
  const realShape = {
    trustCredentials: true,
    workspacePath: '/cases/keep-me',
    auditRoot: { sessionId: 's-1', title: '某项目', workspacePath: '/cases/keep-me', usable: true },
    activeKey: '2026-301705-LX10170-BG8746',
    activeChildId: 'child-1',
    audits: {
      '2026-301705-LX10170-BG8746': {
        key: '2026-301705-LX10170-BG8746', casePath: '/cases/keep-me/案例', uploadedAt: '',
        uploadError: '', ossPrefix: '',
      },
      '2026-301705-LX10170-BG8747': {
        key: '2026-301705-LX10170-BG8747', casePath: '/cases/keep-me/案例2', uploadedAt: '',
        uploadError: '', ossPrefix: '',
      },
    },
  }
  mem.files['/Users/x/.dsh/crwu-workbench.json'] = JSON.stringify(realShape)
  const granted = await grantLocalAccess(
    { ctx: mem.ctx, home: '/Users/x', access: makeTestAccess(mem.ctx).access },
    { schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION, capabilities: [...LOCAL_ACCESS_CAPABILITIES] },
  )
  assert.equal(granted.ok, true, granted.error)
  const onDisk = JSON.parse(mem.files['/Users/x/.dsh/crwu-workbench.json'])
  assert.equal('trustCredentials' in onDisk, false, '旧键必须被抹掉（单一事实源）')
  assert.equal(onDisk.localAccessConsent.capabilities.length, LOCAL_ACCESS_CAPABILITIES.length)
  // **其余字段逐字节不变**：消失的键只有旧信任标记，新增的只有新收据。
  const beforeKeys = Object.keys(realShape).sort()
  const afterKeys = Object.keys(onDisk).sort()
  assert.deepEqual(afterKeys, [...beforeKeys.filter((k) => k !== 'trustCredentials'), 'localAccessConsent'].sort(),
    `键集合被改动了：${JSON.stringify(removedOf(realShape, onDisk))}`)
  for (const key of beforeKeys) {
    if (key === 'trustCredentials') continue
    assert.deepEqual(onDisk[key], realShape[key], `${key} 必须逐字节保留`)
  }

  // 撤销之后同样不许留旧键。
  const revoked = await revokeLocalAccess({
    ctx: mem.ctx, home: '/Users/x', state: { localAccess: granted.consent },
    access: makeTestAccess(mem.ctx).access,
  })
  assert.equal(revoked.ok, true, revoked.error)
  const afterRevoke = JSON.parse(mem.files['/Users/x/.dsh/crwu-workbench.json'])
  assert.equal('trustCredentials' in afterRevoke, false)
  assert.deepEqual(afterRevoke.localAccessConsent.capabilities, [])
})

test('A-02：grant 落盘失败 → ok:false、磁盘不变、内存不放行（特权操作仍然不可用）', async () => {
  const mem = memoryCtx()
  // 磁盘上先放一份「上一版范围的旧收据」：写失败时它必须**原样保留**，不能被半个新记录覆盖。
  const before = JSON.stringify({
    localAccessConsent: { schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION, grantedAt: GRANTED_AT, capabilities: [] },
    workspacePath: '/cases/keep-me',
  })
  mem.files['/Users/x/.dsh/crwu-workbench.json'] = before
  mem.failWrites()

  const result = await grantLocalAccess({ ctx: mem.ctx, home: '/Users/x', access: makeTestAccess(mem.ctx).access }, {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /磁盘/)
  assert.equal(mem.files['/Users/x/.dsh/crwu-workbench.json'], before, '写失败不许改动磁盘')
  // ⚠️ **不许返回磁盘上的旧状态**（2026-09-29 复查的 P1）：写盘失败的现场里，磁盘上常常
  // 还是"撤销之前"那份 `granted`，调用方一旦采用，一次失败的「重新允许」就把权限打开了。
  // 返回的必须是**本进程的关闭态**：`persist-failed`，且能力集合为空。
  assert.equal(result.consent.state, 'persist-failed')
  assert.equal(localAccessGranted(result.consent), false)
  assert.deepEqual(result.consent.capabilities, [])
  assert.equal(result.consent.state === 'granted', false, '写盘失败绝不返回 granted')
})

test('grant 提交被改过的范围：ok:false、活状态不变、一个字节都不写', async () => {
  const { ctx, writes } = memoryCtx()
  for (const args of [
    { schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION, capabilities: [...LOCAL_ACCESS_CAPABILITIES].slice(0, 3) },
    { schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION, capabilities: [...LOCAL_ACCESS_CAPABILITIES, 'evil'] },
    { schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION },
    { schemaVersion: 7, capabilities: [...LOCAL_ACCESS_CAPABILITIES] },
  ]) {
    // 这一条**先真的允许一次**，再发坏请求：坏请求不许把已授权的状态掀掉，也不许动磁盘。
    const state = { localAccess: missingLocalAccessView() }
    const access = makeTestAccess(ctx, { state }).access
    const good = await grantLocalAccess({ ctx, home: '/Users/x', state, access }, {
      schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
      capabilities: [...LOCAL_ACCESS_CAPABILITIES],
    })
    assert.equal(good.ok, true, good.error)
    const writesBefore = writes.length

    const result = await grantLocalAccess({ ctx, home: '/Users/x', state, access }, args)
    assert.equal(result.ok, false, JSON.stringify(args))
    // **坏请求不产生任何影响**：返回的是活状态（真相），不是编出来的关闭态；
    // Broker 照旧放行；磁盘一个字节没动。
    // （早先的实现把"请求不合法"与"落盘失败"混在一起，于是一个旧版界面或手工构造的坏请求
    //   就能把已经允许的授权掀掉 —— 拿可用性换来的假安全。）
    assert.equal(result.consent.state, 'granted', '返回的必须是活状态，不是编出来的关闭态')
    assert.equal(localAccessGranted(state.localAccess), true, '坏请求不许改动活状态')
    assert.equal(
      access.authorize({ operation: 'oss.config.read', source: 'panel', workdir: '/Users/x' }).ok,
      true,
      '坏请求之后 Broker 照旧放行',
    )
    assert.equal(writes.length, writesBefore, `坏请求不许写盘：${JSON.stringify(args)}`)
  }
  // 整个用例只应该有"允许一次"那四下写（四次循环各一次）。
  assert.equal(writes.length, 4, '被拒的提交不许落盘')
})

test('revoke 成功：写空能力集合的墓碑 → revoked', async () => {
  const { ctx, files, state } = memoryCtx()
  await grantLocalAccess({ ctx, home: '/Users/x', access: makeTestAccess(ctx).access }, {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  const result = await revokeLocalAccess({ ctx, home: '/Users/x', state, access: makeTestAccess(ctx).access })
  assert.equal(result.ok, true)
  assert.equal(result.consent.state, 'revoked')
  const onDisk = JSON.parse(files['/Users/x/.dsh/crwu-workbench.json'])
  assert.equal(onDisk.localAccessConsent.schemaVersion, LOCAL_ACCESS_SCHEMA_VERSION)
  assert.deepEqual(onDisk.localAccessConsent.capabilities, [])
})

test('A-05：revoke 落盘失败 → 仍然立刻关闭（persist-failed + ok:false）', async () => {
  const mem = memoryCtx()
  await grantLocalAccess({ ctx: mem.ctx, home: '/Users/x', access: makeTestAccess(mem.ctx).access }, {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  mem.failWrites()
  const result = await revokeLocalAccess({ ctx: mem.ctx, home: '/Users/x', state: mem.state, access: makeTestAccess(mem.ctx).access })
  assert.equal(result.ok, false)
  // 撤销是**收紧**权限：写盘失败时反而不能"当没撤"——否则员工撤销完还在被读凭据。
  assert.equal(result.consent.state, 'persist-failed')
  assert.equal(localAccessGranted(result.consent), false)
  assert.match(result.error, /重启后/)
})

test('P1 · 撤销写盘**进行中**就已经关闭访问（并发调用不许放行）', async () => {
  // 撤销是收紧权限：写盘要几十毫秒（还可能 IO 卡住），那段时间里已经放行的操作不能继续跑。
  // 旧实现把内存更新排在 `await writeWorkbenchConfig` 之后 —— 于是有一个窗口一直开着。
  const mem = memoryCtx()
  await grantLocalAccess({ ctx: mem.ctx, home: '/Users/x', access: makeTestAccess(mem.ctx).access }, {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  // 让写盘**挂在半路**：拿到一个"正在撤销"的世界，然后在这个世界里问"还能读凭据吗"。
  let release = () => {}
  const blocked = new Promise((resolve) => { release = () => { resolve(undefined) } })
  const originalWrite = mem.ctx.get('fs').writeText
  mem.ctx.get('fs').writeText = async (...args) => { await blocked; return await originalWrite(...args) }

  const revoking = revokeLocalAccess({ ctx: mem.ctx, home: '/Users/x', state: mem.state, access: makeTestAccess(mem.ctx).access })
  // 此刻写盘还没回来 —— 访问必须已经关了。
  assert.equal(localAccessGranted(mem.state.localAccess), false, '写盘期间就必须是关闭态')
  assert.equal(mem.state.localAccess.state, 'persist-failed')
  release()
  const result = await revoking
  assert.equal(result.ok, true)
  assert.equal(result.consent.state, 'revoked')
})

test('P1 · 撤销写盘失败之后，环境刷新**不能**把旧授权重新采纳回来', async () => {
  // 现场：撤销失败 → 客户端环境刷新 → `syncLocalAccessConsent` 从磁盘读回**上一份**授权
  // → 进程内又变成 granted。员工看着"已撤销"，实际又放行了。
  const mem = memoryCtx()
  await grantLocalAccess({ ctx: mem.ctx, home: '/Users/x', access: makeTestAccess(mem.ctx).access }, {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  // 磁盘上确实留着那份授权（模拟"写盘失败，旧内容还在"）。
  assert.equal(JSON.parse(mem.files['/Users/x/.dsh/crwu-workbench.json']).localAccessConsent.capabilities.length > 0, true)

  mem.failWrites()
  const revoked = await revokeLocalAccess({ ctx: mem.ctx, home: '/Users/x', state: mem.state, access: makeTestAccess(mem.ctx).access })
  assert.equal(revoked.ok, false)
  assert.equal(localAccessGranted(mem.state.localAccess), false)

  // 环境刷新走的就是这个函数（`env` / `boot` 都会调）。
  const synced = await syncLocalAccessConsent({ ctx: mem.ctx, home: '/Users/x', state: mem.state, access: makeTestAccess(mem.ctx).access })
  assert.equal(localAccessGranted(synced), false, '刷新之后仍然必须是关闭态')
  assert.equal(synced.state, 'persist-failed')
  assert.equal(localAccessGranted(mem.state.localAccess), false)

  // 显式重新允许才是唯一能重新打开的动作（它先落盘、再改内存）。
  mem.restoreWrites()
  const regranted = await grantLocalAccess({ ctx: mem.ctx, home: '/Users/x', access: makeTestAccess(mem.ctx).access }, {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  assert.equal(regranted.ok, true)
  mem.state.localAccess = regranted.consent
  assert.equal(localAccessGranted(mem.state.localAccess), true)
  const after = await syncLocalAccessConsent({ ctx: mem.ctx, home: '/Users/x', state: mem.state, access: makeTestAccess(mem.ctx).access })
  assert.equal(localAccessGranted(after), true, '显式重新允许之后，刷新应当保持已允许')
})

test('P1 · 撤销写盘失败之后，一次**失败**的「重新允许」不许把权限打开', async () => {
  // 用户复查给的复现序列（2026-09-29）：
  //   磁盘上原来是有效授权 → 撤销写盘失败（进程内进 persist-failed）→
  //   员工点「重新允许一次」，磁盘仍不可写 → grant 写失败，
  //   但旧实现从磁盘读回**撤销之前那份 granted** 并返回，调用方无条件写进活状态 → Broker 又放行。
  const mem = memoryCtx()
  const state = { localAccess: missingLocalAccessView() }
  // ⚠️ Broker 必须与用例**共用同一个 state 对象**（`makeTestAccess` 默认自己造一个
  // 已授权的 state —— 那样第 ④ 步永远会放行，断言就成了空的）。
  const access = makeTestAccess(mem.ctx, { state }).access

  // ① 磁盘上先有一份**有效授权**。
  const granted = await grantLocalAccess({ ctx: mem.ctx, home: '/Users/x', state, access }, {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  assert.equal(granted.ok, true, granted.error)
  assert.equal(localAccessGranted(state.localAccess), true)

  // ② 撤销时磁盘不可写：进程内必须立刻关闭（墓碑）。
  mem.failWrites()
  const revoked = await revokeLocalAccess({ ctx: mem.ctx, home: '/Users/x', state, access })
  assert.equal(revoked.ok, false)
  assert.equal(localAccessGranted(state.localAccess), false, '撤销失败也必须立刻关闭')

  // ③ 重新允许，磁盘**仍然**不可写。
  const regrant = await grantLocalAccess({ ctx: mem.ctx, home: '/Users/x', state, access }, {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  assert.equal(regrant.ok, false)
  assert.equal(regrant.consent.state === 'granted', false, '写盘失败绝不能返回 granted')
  assert.equal(localAccessGranted(state.localAccess), false, '活状态必须仍是关闭的')

  // ④ Broker 必须继续拒绝：这是"权限有没有被重新打开"的最终判据。
  const decision = access.authorize({ operation: 'oss.config.read', source: 'panel', workdir: '/Users/x' })
  assert.equal(decision.ok, false, '撤销+重新允许都写盘失败时，Broker 不许放行')
  assert.equal(decision.errorClass, 'not-authorized')

  // ⑤ env / boot 走的同步路径也不能把它救回来（磁盘上确实还留着旧授权）。
  const synced = await syncLocalAccessConsent({ ctx: mem.ctx, home: '/Users/x', state, access })
  assert.equal(localAccessGranted(synced), false, '同步不许用磁盘旧授权覆盖关闭态')
  assert.equal(localAccessGranted(state.localAccess), false)
})

test('读盘失败（fs 服务缺失）按未授权处理：fail closed，不抛错，且说清是"读不出来"', async () => {
  const ctx = { get: () => undefined }
  const granted = await grantLocalAccess({ ctx, home: '/Users/x', access: makeTestAccess(ctx).access }, {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  })
  assert.equal(granted.ok, false)
  // fs 不可用 = 既读不回来、也落不了盘 = 本次运行没有授权；**不是**"磁盘上原来什么样就返回什么样"。
  // 状态是 `unreadable`（读失败）而**不是** `persist-failed`（写失败）：后者是"写完才失败"的现场，
  // 那里磁盘上常常还留着撤销之前那份 `granted`；这里的失败发生在读到任何东西之前。
  assert.equal(granted.consent.state, 'unreadable')
  assert.match(granted.error, /不是「没有授权」/)
  assert.equal(localAccessGranted(granted.consent), false)
})

/** 失败信息里带上"到底哪些键消失了"，比一个 false 好查。 */
function removedOf(before, after) {
  return Object.keys(before).filter((key) => !(key in after))
}
