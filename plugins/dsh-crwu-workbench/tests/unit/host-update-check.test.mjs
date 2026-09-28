/**
 * Host 端更新检查策略（`src/host/update/check.ts`）的单元测试。
 *
 * 这一层决定**能不能查、要不要查、查到的结果算不算数**，全是政策与缓存判据：
 * - 本地开发安装 / Plugin Manager 不可用 / 企业私有源 → 直接 unsupported，绝不打公共源；
 * - 6 小时成功缓存、10 分钟失败退避、手动 force 绕过二者；
 * - 单飞并发：同一实例上并发的检查只读一次 profile、只发现一次；
 * - 失败绝不能伪装成「已是最新」；过期候选不能再授权安装。
 *
 * 全部依赖注入（时钟、profile reader、discovery），**不访问公网、不依赖真实时间、不创建定时器**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { createUpdateChecker } = await import(new URL('src/host/update/check.ts', ROOT).href)
const { UPDATE_SUCCESS_TTL_MS, UPDATE_FAILURE_BACKOFF_MS } = await import(
  new URL('src/shared/update/consts.ts', ROOT).href
)

const NOW = '2026-09-28T10:00:00.000Z'
const NPMMIRROR = 'https://registry.npmmirror.com/'
const NPM = 'https://registry.npmjs.org/'
const PRIVATE = 'https://npm.corp.example.com/'

/** 可推进的注入时钟：所有 TTL / 退避判据都拿它比较，测试里不出现真实定时器。 */
function makeClock(startIso = NOW) {
  let current = new Date(startIso).getTime()
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms
      return new Date(current)
    },
  }
}

/** 计数替身：调用次数是「有没有打上游」的唯一判据。 */
function spy(impl) {
  const calls = []
  const fn = async (...args) => {
    calls.push(args)
    return impl(...args)
  }
  fn.calls = calls
  return fn
}

/** 一次成功的发现（候选比当前版本高，过期时间按注入时钟算）。 */
function availableNow(clock, target = '0.0.12', current = '0.0.11') {
  const at = clock.now()
  return {
    candidate: {
      currentVersion: current,
      targetVersion: target,
      sourceKind: 'npmmirror',
      checkedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + UPDATE_SUCCESS_TTL_MS).toISOString(),
    },
    sources: [
      { kind: 'npmmirror', latestVersion: target },
      { kind: 'npm', latestVersion: target },
    ],
  }
}

/** 手工拼一个发现结果（用于失败归因、单源成功、以及"源与候选自相矛盾"的用例）。 */
const discoveryOf = (sources) => ({ sources })

/** 两个公共源都报同一个失败。 */
const bothFailed = (failure) =>
  discoveryOf([
    { kind: 'npmmirror', failure },
    { kind: 'npm', failure },
  ])

/**
 * 造一个检查器实例。
 *
 * `registries: null` 表示**没有** profile reader（Plugin Manager 不可用）；
 * 其它情况用一个计数替身返回给定 profile。
 */
function createHarness(options = {}) {
  const clock = options.clock ?? makeClock()
  const registries =
    options.registries === null
      ? undefined
      : (options.registries ?? spy(async () => options.profile ?? { registry: NPMMIRROR, fallbackRegistries: [], resolved: NPMMIRROR }))
  const discover = options.discover ?? spy(async () => availableNow(clock))
  const update = createUpdateChecker({
    version: options.version ?? '0.0.11',
    buildKind: options.buildKind ?? 'installed',
    now: clock.now,
    registries,
    discover,
  })
  return { update, clock, registries, discover }
}

/** 公开状态里绝不能出现的东西：私有地址、凭据、底层错误原文。 */
const FORBIDDEN_IN_STATE = [PRIVATE, 'npm.corp.example.com', 'user:pass', 'ECONNREFUSED', 'Error:']

function assertNoForbidden(state, label) {
  const serialized = JSON.stringify(state)
  for (const forbidden of FORBIDDEN_IN_STATE) {
    assert.equal(serialized.includes(forbidden), false, `${label} 不得包含 ${forbidden}`)
  }
  return serialized
}

// ---------------------------------------------------------------------------
// 一、支持门禁：dev / manager / registry 策略
// ---------------------------------------------------------------------------

test('1. dev 安装立即 unsupported，既不读 profile 也不打上游', async () => {
  const host = createHarness({ buildKind: 'dev' })
  assert.deepEqual(await host.update.check(), { status: 'unsupported', reason: 'development-install' })

  // force 也不行：安全限制优先于用户的"再查一次"。
  assert.deepEqual(await host.update.check({ force: true }), {
    status: 'unsupported',
    reason: 'development-install',
  })
  assert.equal(host.registries.calls.length, 0)
  assert.equal(host.discover.calls.length, 0)
  assert.equal(host.update.installableCandidate(), undefined)
})

test('2. 没有 profile reader 时 unsupported/manager-unavailable，不打上游', async () => {
  const host = createHarness({ registries: null })
  const state = await host.update.check()

  assert.deepEqual(state, { status: 'unsupported', reason: 'manager-unavailable' })
  assert.equal(host.discover.calls.length, 0)
  assert.deepEqual(await host.update.check({ force: true }), state)
  assert.equal(host.update.installableCandidate(), undefined)
})

test('3. npm 官方 profile 允许检查，并使用 Task 1 的固定两源发现', async () => {
  const host = createHarness({
    profile: { registry: NPM, fallbackRegistries: [], resolved: NPM },
  })
  const state = await host.update.check()

  assert.equal(state.status, 'available')
  assert.equal(host.registries.calls.length, 1)
  assert.equal(host.discover.calls.length, 1)
  // 发现函数的入参只有"当前版本"：检查器不挑选源、也不给源地址。
  assert.deepEqual(host.discover.calls[0], ['0.0.11'])
})

test('4. npmmirror profile 与公共 fallback 都允许检查', async () => {
  for (const profile of [
    { registry: NPMMIRROR, fallbackRegistries: [], resolved: NPMMIRROR },
    { registry: NPMMIRROR, fallbackRegistries: [NPM], resolved: NPMMIRROR },
    { registry: NPM, fallbackRegistries: [NPMMIRROR], resolved: NPM },
  ]) {
    const host = createHarness({ profile })
    const state = await host.update.check()
    assert.equal(state.status, 'available', `profile ${JSON.stringify(profile)} 应当允许检查`)
    assert.equal(host.discover.calls.length, 1)
  }
})

test('5. registry 为 null 时按 resolved 判断 pnpm 实际源', async () => {
  for (const resolved of [NPMMIRROR, NPM]) {
    const host = createHarness({ profile: { registry: null, fallbackRegistries: [], resolved } })
    assert.equal((await host.update.check()).status, 'available', `resolved=${resolved} 应当允许检查`)
    assert.equal(host.discover.calls.length, 1)
  }

  // 显式配置了公共 primary 时，pnpm 自己的配置读不出来（resolved 为 null）不算风险。
  const explicit = createHarness({ profile: { registry: NPM, fallbackRegistries: [], resolved: null } })
  assert.equal((await explicit.update.check()).status, 'available')
})

test('6. 私有 primary registry 禁止检查，且不泄露其地址', async () => {
  const host = createHarness({
    profile: { registry: PRIVATE, fallbackRegistries: [], resolved: PRIVATE },
  })
  const state = await host.update.check()

  assert.deepEqual(state, { status: 'unsupported', reason: 'enterprise-registry' })
  assert.equal(host.discover.calls.length, 0)
  assertNoForbidden(state, 'unsupported 状态')
  assert.equal(host.update.installableCandidate(), undefined)

  // unsupported 不是"网络失败"：不得写进 10 分钟退避，profile 修好后下一次自动检查就要生效。
  assert.equal(host.registries.calls.length, 1)
  await host.update.check()
  assert.equal(host.registries.calls.length, 2)
})

test('7. 私有 resolved（含公共 primary + 私有 resolved）禁止检查', async () => {
  const profiles = [
    { registry: null, fallbackRegistries: [], resolved: PRIVATE },
    { registry: NPMMIRROR, fallbackRegistries: [], resolved: PRIVATE },
    { registry: null, fallbackRegistries: [PRIVATE], resolved: NPMMIRROR },
  ]
  for (const profile of profiles) {
    const host = createHarness({ profile })
    const state = await host.update.check()
    assert.deepEqual(state, { status: 'unsupported', reason: 'enterprise-registry' }, JSON.stringify(profile))
    assert.equal(host.discover.calls.length, 0, '企业私有源不得绕过')
    assertNoForbidden(state, 'unsupported 状态')
  }
})

test('8. 私有 fallback 不得被绕过，也不得出现在任何公开状态里', async () => {
  const host = createHarness({
    profile: { registry: NPMMIRROR, fallbackRegistries: [NPM, PRIVATE], resolved: NPMMIRROR },
  })
  const state = await host.update.check()

  assert.deepEqual(state, { status: 'unsupported', reason: 'enterprise-registry' })
  assert.equal(host.discover.calls.length, 0)
  const serialized = assertNoForbidden(state, 'unsupported 状态')
  assert.equal(serialized.includes(NPM), false, '公开状态里也不该出现 registry URL')
})

test('9. registry 为 null 而 resolved 无法确认时 fail closed', async () => {
  const host = createHarness({ profile: { registry: null, fallbackRegistries: [], resolved: null } })
  const state = await host.update.check()

  assert.equal(state.status, 'unsupported')
  assert.equal(state.reason, 'enterprise-registry')
  assert.equal(host.discover.calls.length, 0, '无法确认实际源时不得访问公共源')
})

test('10. 相似域名 / 带凭据 / 非根路径 / 非 HTTP(S) 都不得被当成公共源', async () => {
  const impostors = [
    'https://registry.npmjs.org.evil.example/',
    'https://evil.example/registry.npmjs.org/',
    'https://registry-npmjs-org.evil.example/',
    'https://user:pass@registry.npmjs.org/',
    'https://registry.npmjs.org/some/path/',
    'https://registry.npmjs.org:8443/',
    'http://registry.npmjs.org/',
    'ftp://registry.npmjs.org/',
    'file:///registry/npmjs.org/',
    'registry.npmjs.org',
  ]
  for (const registry of impostors) {
    const host = createHarness({ profile: { registry, fallbackRegistries: [], resolved: registry } })
    const state = await host.update.check()
    assert.equal(state.status, 'unsupported', `${registry} 不得被识别为公共源`)
    assert.equal(state.reason, 'enterprise-registry', registry)
    assert.equal(host.discover.calls.length, 0, registry)
    const serialized = assertNoForbidden(state, registry)
    assert.equal(serialized.includes('user:pass'), false, registry)
  }
})

test('10b. 主机大小写与结尾斜杠不影响公共源识别', async () => {
  for (const registry of ['https://REGISTRY.NPMJS.ORG/', 'https://registry.npmjs.org', 'https://Registry.NpmMirror.com']) {
    const host = createHarness({ profile: { registry, fallbackRegistries: [], resolved: registry } })
    assert.equal((await host.update.check()).status, 'available', registry)
    assert.equal(host.discover.calls.length, 1, registry)
  }
})

// ---------------------------------------------------------------------------
// 二、单飞与缓存
// ---------------------------------------------------------------------------

test('11. 并发检查只读一次 profile、只发现一次，调用者拿到同一结论', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const clock = makeClock()
  const host = createHarness({
    clock,
    discover: spy(async () => {
      await gate
      return availableNow(clock)
    }),
  })

  const first = host.update.check()
  const second = host.update.check()
  assert.deepEqual(host.update.status(), { status: 'checking' }, '上游进行中时状态是 checking')

  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(host.registries.calls.length, 1)
  assert.equal(host.discover.calls.length, 1)
  assert.deepEqual(a, b)
  assert.equal(a.status, 'available')

  // 完成后 inflight 要被清掉：下一次（缓存过期后）检查必须能重新开始。
  clock.advance(UPDATE_SUCCESS_TTL_MS)
  await host.update.check()
  assert.equal(host.registries.calls.length, 2)
  assert.equal(host.discover.calls.length, 2)
})

test('12. available 缓存 6 小时：有效期内不读 profile、不发现；正好到期就刷新', async () => {
  const host = createHarness()
  const first = await host.update.check()
  assert.equal(first.status, 'available')

  host.clock.advance(UPDATE_SUCCESS_TTL_MS - 1000)
  assert.deepEqual(await host.update.check(), first, '有效期内复用同一结论')
  assert.equal(host.registries.calls.length, 1)
  assert.equal(host.discover.calls.length, 1)

  host.clock.advance(1000)
  await host.update.check()
  assert.equal(host.registries.calls.length, 2, '正好满 6 小时必须刷新')
  assert.equal(host.discover.calls.length, 2)
})

test('13. up-to-date 同样缓存 6 小时', async () => {
  const clock = makeClock()
  const host = createHarness({
    clock,
    discover: spy(async () =>
      discoveryOf([
        { kind: 'npmmirror', latestVersion: '0.0.11' },
        { kind: 'npm', latestVersion: '0.0.11' },
      ]),
    ),
  })
  const first = await host.update.check()
  assert.deepEqual(first, { status: 'up-to-date', checkedAt: NOW })
  assert.equal(host.update.installableCandidate(), undefined)

  host.clock.advance(UPDATE_SUCCESS_TTL_MS - 1000)
  assert.deepEqual(await host.update.check(), first)
  assert.equal(host.registries.calls.length, 1)
  assert.equal(host.discover.calls.length, 1)
})

test('14. 缓存过期后自动刷新', async () => {
  const host = createHarness()
  await host.update.check()

  host.clock.advance(UPDATE_SUCCESS_TTL_MS + 60_000)
  const refreshed = await host.update.check()
  assert.equal(refreshed.status, 'available')
  assert.equal(host.registries.calls.length, 2)
  assert.equal(host.discover.calls.length, 2)
  assert.equal(refreshed.candidate.checkedAt, host.clock.now().toISOString(), '刷新后 checkedAt 前进')
})

test('15. force 绕过成功缓存', async () => {
  const host = createHarness()
  const first = await host.update.check()

  const forced = await host.update.check({ force: true })
  assert.equal(host.registries.calls.length, 2)
  assert.equal(host.discover.calls.length, 2)
  assert.equal(forced.status, 'available')
  assert.equal(forced.candidate.checkedAt, first.candidate.checkedAt, '同一时刻重复检查结论相同')
})

// ---------------------------------------------------------------------------
// 三、失败退避与旧结果保留
// ---------------------------------------------------------------------------

test('16. 自动检查失败后 10 分钟内不再访问上游，且不伪装成最新版', async () => {
  const host = createHarness({ discover: spy(async () => bothFailed({ kind: 'timeout' })) })
  const first = await host.update.check()
  assert.deepEqual(first, { status: 'error', kind: 'timeout', checkedAt: NOW })

  host.clock.advance(UPDATE_FAILURE_BACKOFF_MS - 1)
  assert.deepEqual(await host.update.check(), first, '退避窗口内复用上一次结论')
  assert.equal(host.registries.calls.length, 1)
  assert.equal(host.discover.calls.length, 1)

  host.clock.advance(2)
  await host.update.check()
  assert.equal(host.discover.calls.length, 2, '越过 10 分钟才允许重试')
})

test('17. force 绕过失败退避', async () => {
  const host = createHarness({ discover: spy(async () => bothFailed({ kind: 'network' })) })
  await host.update.check()

  host.clock.advance(1000)
  await host.update.check({ force: true })
  assert.equal(host.discover.calls.length, 2)
})

test('18. 后台刷新失败保留原候选，checkedAt/expiresAt 一字不改，也不把它变回可安装', async () => {
  const clock = makeClock()
  let mode = 'ok'
  const host = createHarness({
    clock,
    discover: spy(async () => (mode === 'ok' ? availableNow(clock) : bothFailed({ kind: 'timeout' }))),
  })

  const first = await host.update.check()
  assert.equal(first.status, 'available')
  assert.equal(host.update.installableCandidate().targetVersion, '0.0.12')

  clock.advance(UPDATE_SUCCESS_TTL_MS + 1000)
  mode = 'fail'
  const after = await host.update.check()

  assert.deepEqual(after, first, '自动刷新失败时保留旧结论')
  assert.deepEqual(after.candidate, first.candidate)
  assert.equal(after.candidate.checkedAt, first.candidate.checkedAt)
  assert.equal(after.candidate.expiresAt, first.candidate.expiresAt)
  assert.equal(host.discover.calls.length, 2, '确实尝试过刷新')
  assert.equal(host.update.installableCandidate(), undefined, '过期候选不得再授权安装')
})

test('19. 可安装候选按当前注入时钟重新判过期', async () => {
  const host = createHarness()
  assert.equal(host.update.installableCandidate(), undefined, '还没检查过就没有可安装候选')

  const state = await host.update.check()
  assert.deepEqual(host.update.installableCandidate(), state.candidate)

  host.clock.advance(UPDATE_SUCCESS_TTL_MS - 1000)
  assert.notEqual(host.update.installableCandidate(), undefined, '未过期仍可安装')

  host.clock.advance(1000)
  assert.equal(host.update.installableCandidate(), undefined, '正好到期即失效')

  // unsupported 之后一律没有可安装候选（哪怕上一轮成功过）。
  const switched = createHarness({ profile: { registry: PRIVATE, fallbackRegistries: [], resolved: PRIVATE } })
  await switched.update.check()
  assert.equal(switched.update.installableCandidate(), undefined)
})

// ---------------------------------------------------------------------------
// 四、结论诚实性
// ---------------------------------------------------------------------------

test('20. 两个源都失败必须是 error，不能是 up-to-date', async () => {
  for (const failure of [
    { kind: 'timeout' },
    { kind: 'network' },
    { kind: 'http', status: 500 },
    { kind: 'invalid-json' },
    { kind: 'too-large' },
  ]) {
    const host = createHarness({ discover: spy(async () => bothFailed(failure)) })
    const state = await host.update.check()
    assert.equal(state.status, 'error', JSON.stringify(failure))
    assert.notEqual(state.status, 'up-to-date', JSON.stringify(failure))
  }
})

test('21. 当前版本非法时 fail closed，不得报 up-to-date 也不得给候选', async () => {
  const clock = makeClock()
  // 源"成功"（有的甚至返回了候选），但当前版本不是合法 SemVer → 无法比较 → 必须失败。
  for (const discovery of [
    discoveryOf([
      { kind: 'npmmirror', latestVersion: '0.0.12' },
      { kind: 'npm', latestVersion: '0.0.12' },
    ]),
    availableNow(clock),
  ]) {
    const host = createHarness({ clock, version: 'dev-build', discover: spy(async () => discovery) })
    const state = await host.update.check()
    assert.equal(state.status, 'error')
    assert.equal(state.kind, 'unknown')
    assert.equal(host.update.installableCandidate(), undefined)
  }
})

test('22. 至少一个源成功且最高稳定版不高于当前版本才允许 up-to-date', async () => {
  // 一个源失败、一个源成功且不高于当前版本 → up-to-date。
  const partiallyDegraded = createHarness({
    discover: spy(async () =>
      discoveryOf([
        { kind: 'npmmirror', failure: { kind: 'timeout' } },
        { kind: 'npm', latestVersion: '0.0.11' },
      ]),
    ),
  })
  assert.equal((await partiallyDegraded.update.check()).status, 'up-to-date')

  // 只有预发布版本可用时不算"已是最新"（拿不到合法稳定版 → fail closed）。
  const prereleaseOnly = createHarness({
    discover: spy(async () => discoveryOf([{ kind: 'npm', latestVersion: '0.0.12-rc.1' }])),
  })
  const state = await prereleaseOnly.update.check()
  assert.equal(state.status, 'error')
  assert.equal(state.kind, 'unknown')

  // 源说"有更高版本"却没有候选：发现结果自相矛盾，绝不能报 up-to-date。
  const inconsistent = createHarness({
    discover: spy(async () => discoveryOf([{ kind: 'npm', latestVersion: '0.0.13' }])),
  })
  const inconsistentState = await inconsistent.update.check()
  assert.equal(inconsistentState.status, 'error')
  assert.equal(inconsistentState.kind, 'unknown')

  // 候选不高于当前版本（不可能的发现结果）同样不能变成 available。
  const downgrade = createHarness({
    discover: spy(async () => ({
      candidate: {
        currentVersion: '0.0.11',
        targetVersion: '0.0.10',
        sourceKind: 'npm',
        checkedAt: NOW,
        expiresAt: new Date(new Date(NOW).getTime() + UPDATE_SUCCESS_TTL_MS).toISOString(),
      },
      sources: [{ kind: 'npm', latestVersion: '0.0.10' }],
    })),
  })
  const downgradeState = await downgrade.update.check()
  assert.equal(downgradeState.status, 'error')
  assert.equal(downgrade.update.installableCandidate(), undefined)
})

test('23. 底层失败映射到稳定的错误分类', async () => {
  const cases = [
    ['两个源都超时', [{ kind: 'timeout' }, { kind: 'timeout' }], 'timeout'],
    ['两个源都连不上', [{ kind: 'network' }, { kind: 'network' }], 'network'],
    ['上游 HTTP 故障', [{ kind: 'http', status: 500 }, { kind: 'http', status: 502 }], 'network'],
    ['两个源都 404', [{ kind: 'http', status: 404 }, { kind: 'http', status: 404 }], 'not-found'],
    ['404 与 500 混合', [{ kind: 'http', status: 404 }, { kind: 'http', status: 500 }], 'network'],
    ['404 与超时混合', [{ kind: 'http', status: 404 }, { kind: 'timeout' }], 'timeout'],
    ['正文超限', [{ kind: 'too-large' }, { kind: 'too-large' }], 'too-large'],
    ['非法 JSON', [{ kind: 'invalid-json' }, { kind: 'invalid-json' }], 'invalid-metadata'],
    ['元数据非法', [{ kind: 'invalid-metadata' }, { kind: 'invalid-json' }], 'invalid-metadata'],
    ['超限与非法 JSON 混合', [{ kind: 'too-large' }, { kind: 'invalid-json' }], 'too-large'],
  ]
  for (const [label, failures, expected] of cases) {
    const host = createHarness({
      discover: spy(async () =>
        discoveryOf(failures.map((failure, index) => ({ kind: index === 0 ? 'npmmirror' : 'npm', failure }))),
      ),
    })
    const state = await host.update.check()
    assert.equal(state.status, 'error', label)
    assert.equal(state.kind, expected, label)
  }

  // 归因拿不到（源列表为空）与注入的发现函数抛错，都只能归到 unknown。
  const empty = createHarness({ discover: spy(async () => discoveryOf([])) })
  assert.equal((await empty.update.check()).kind, 'unknown')

  const thrown = createHarness({
    discover: spy(async () => {
      throw new Error('ECONNRESET at https://npm.corp.example.com/ token=abc')
    }),
  })
  const thrownState = await thrown.update.check()
  assert.deepEqual(thrownState, { status: 'error', kind: 'unknown', checkedAt: NOW })

  const readerThrown = createHarness({
    registries: spy(async () => {
      throw new Error('pnpm config failed for https://user:pass@npm.corp.example.com/')
    }),
  })
  const readerState = await readerThrown.update.check()
  assert.deepEqual(readerState, { status: 'error', kind: 'unknown', checkedAt: NOW })
})

test('24. 公开状态序列化后不含 registry URL、凭据或底层错误原文', async () => {
  const cases = []
  cases.push(await createHarness({ profile: { registry: PRIVATE, fallbackRegistries: [], resolved: PRIVATE } }).update.check())
  cases.push(await createHarness({ registries: null }).update.check())
  cases.push(await createHarness({ buildKind: 'dev' }).update.check())
  cases.push(await createHarness({ discover: spy(async () => bothFailed({ kind: 'network' })) }).update.check())
  cases.push(
    await createHarness({
      discover: spy(async () => {
        throw new Error('boom https://user:pass@npm.corp.example.com/')
      }),
    }).update.check(),
  )
  cases.push(await createHarness().update.check())

  for (const state of cases) {
    const serialized = assertNoForbidden(state, JSON.stringify(state))
    assert.equal(serialized.includes(NPMMIRROR), false, serialized)
    assert.equal(serialized.includes(NPM), false, serialized)
    // 错误状态只允许这三个字段：没有 message、没有 cause、没有阶段日志。
    if (state.status === 'error') {
      assert.deepEqual(Object.keys(state).sort(), ['checkedAt', 'kind', 'status'])
    }
  }

  // 一次成功的状态里也只能有协议允许的字段。
  const available = await createHarness().update.check()
  assert.deepEqual(Object.keys(available).sort(), ['candidate', 'checkedAt', 'status'])
  assert.deepEqual(Object.keys(available.candidate).sort(), [
    'checkedAt',
    'currentVersion',
    'expiresAt',
    'sourceKind',
    'targetVersion',
  ])
})
