/**
 * Host 端更新发现（`src/host/update/registry.ts`）的单元测试。
 *
 * 这一层是**外部输入边界**：registry 返回的 JSON 是第三方内容，它的字段不能直接进内存、
 * 更不能原样进线协议。每个用例都用注入式 fetch 与注入式时钟，**不访问公网、不依赖真实时间**，
 * 并逐条钉住：固定包名、只认稳定版 SemVer、1 MiB 正文上限（边读边限，**不信 content-length**）、
 * 超时（AbortController）、多源合并用 SemVer 比较（**不是字符串比较**）、只输出规范化安全字段。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { fetchRegistryPackage, discoverLatestVersion } = await import(
  new URL('src/host/update/registry.ts', ROOT).href
)
const { UPDATE_PACKAGE_NAME, UPDATE_SOURCES, UPDATE_MAX_RESPONSE_BYTES, UPDATE_SUCCESS_TTL_MS } = await import(
  new URL('src/shared/update/consts.ts', ROOT).href
)

const NPMMIRROR = { kind: 'npmmirror', registryUrl: 'https://registry.npmmirror.com/', timeoutMs: 3000 }
const NPM = { kind: 'npm', registryUrl: 'https://registry.npmjs.org/', timeoutMs: 5000 }
const NOW = '2026-09-28T10:00:00.000Z'
const CLOCK = () => new Date(NOW)

/** 真实形状的 registry 文档片段；多塞了**不该外泄**的字段，用来证明它们不会被带出去。 */
const packageDocument = (latest, overrides = {}) => ({
  _id: UPDATE_PACKAGE_NAME,
  name: UPDATE_PACKAGE_NAME,
  'dist-tags': { latest, next: '0.0.12-rc.1' },
  versions: { [latest]: { name: UPDATE_PACKAGE_NAME, version: latest } },
  time: {
    created: '2026-09-01T00:00:00.000Z',
    modified: '2026-09-28T03:00:00.000Z',
    [latest]: '2026-09-28T02:00:00.000Z',
  },
  readme: '# dsh-crwu-workbench',
  maintainers: [{ name: 'crwu', email: 'crwu@example.com' }],
  _attachments: {},
  ...overrides,
})

const jsonResponse = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

/** 记录每次请求（地址与 signal），handler 负责应答。 */
function recordingFetch(handler) {
  const requests = []
  const impl = async (url, init = {}) => {
    requests.push({ url: String(url), signal: init.signal })
    return handler(String(url), init)
  }
  impl.requests = requests
  return impl
}

/** 按 registry 主机名分派应答，用来构造「两个源各自不同结果」的场景。 */
function perHostFetch(byHost) {
  return recordingFetch((url) => {
    const host = new URL(url).host
    if (!(host in byHost)) throw new Error(`测试没有为 ${host} 准备应答`)
    return byHost[host]()
  })
}

// ---------------------------------------------------------------------------
// 固定常量
// ---------------------------------------------------------------------------

test('公共源、包名、正文上限与缓存 TTL 都是固定常量', () => {
  assert.equal(UPDATE_PACKAGE_NAME, 'dsh-crwu-workbench')
  assert.deepEqual(
    UPDATE_SOURCES.map((source) => [source.kind, source.registryUrl, source.timeoutMs]),
    [
      ['npmmirror', 'https://registry.npmmirror.com/', 3000],
      ['npm', 'https://registry.npmjs.org/', 5000],
    ],
  )
  assert.equal(UPDATE_MAX_RESPONSE_BYTES, 1024 * 1024)
  assert.equal(UPDATE_SUCCESS_TTL_MS, 6 * 60 * 60 * 1000)
})

// ---------------------------------------------------------------------------
// 单个源的读取与校验
// ---------------------------------------------------------------------------

test('读 dist-tags.latest，并把 time[version] 规范成发布时间', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(packageDocument('0.0.11')))
  const result = await fetchRegistryPackage(NPMMIRROR, { fetch: fetchImpl, now: CLOCK })

  assert.equal(result.ok, true)
  assert.deepEqual(result.metadata, {
    name: 'dsh-crwu-workbench',
    version: '0.0.11',
    publishedAt: '2026-09-28T02:00:00.000Z',
  })
  assert.deepEqual(Object.keys(result).sort(), ['fetchedAt', 'metadata', 'ok'])
  assert.equal(result.fetchedAt, NOW)
  assert.deepEqual(
    fetchImpl.requests.map((request) => request.url),
    ['https://registry.npmmirror.com/dsh-crwu-workbench'],
  )
  assert.ok(fetchImpl.requests[0].signal instanceof AbortSignal, '必须用 AbortController 的 signal 控制超时')
})

test('没有可用的 time[version] 时省略发布时间，但版本结论不变', async () => {
  const withoutTime = packageDocument('0.0.11')
  delete withoutTime.time
  const first = await fetchRegistryPackage(NPM, {
    fetch: recordingFetch(() => jsonResponse(withoutTime)),
    now: CLOCK,
  })
  assert.deepEqual(first.metadata, { name: 'dsh-crwu-workbench', version: '0.0.11' })

  const badDate = packageDocument('0.0.11', { time: { '0.0.11': '不是日期' } })
  const second = await fetchRegistryPackage(NPM, {
    fetch: recordingFetch(() => jsonResponse(badDate)),
    now: CLOCK,
  })
  assert.deepEqual(second.metadata, { name: 'dsh-crwu-workbench', version: '0.0.11' })
})

test('包名不一致一律拒绝（同名包才是更新对象）', async () => {
  const result = await fetchRegistryPackage(NPMMIRROR, {
    fetch: recordingFetch(() => jsonResponse(packageDocument('0.0.11', { name: 'other-plugin' }))),
    now: CLOCK,
  })
  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'invalid-metadata')
})

test('versions 里必须有 dist-tags.latest 精确指向的自洽条目', async () => {
  // `versions[latest]` 是设计 §5.2 的"对应版本的基本包信息"：只信 dist-tags.latest 而不看它指向的
  // 条目，结构不一致的文档（latest 指向一个不存在或不属于本包的版本）仍会生成更新候选。
  const versionsOf = (latest, entry) => packageDocument(latest, { versions: { [latest]: entry } })
  const missingVersions = packageDocument('0.0.11')
  delete missingVersions.versions

  const cases = [
    ['缺少顶层 versions', missingVersions],
    ['versions 是数组', packageDocument('0.0.11', { versions: ['0.0.11'] })],
    ['versions 是字符串', packageDocument('0.0.11', { versions: '0.0.11' })],
    ['versions 是 null', packageDocument('0.0.11', { versions: null })],
    ['versions 里没有 latest 条目', packageDocument('0.0.11', { versions: { '0.0.10': { name: UPDATE_PACKAGE_NAME, version: '0.0.10' } } })],
    ['latest 条目是字符串', versionsOf('0.0.11', '0.0.11')],
    ['latest 条目是数组', versionsOf('0.0.11', [])],
    ['latest 条目是 null', versionsOf('0.0.11', null)],
    ['latest 条目 name 是别的包', versionsOf('0.0.11', { name: 'other-plugin', version: '0.0.11' })],
    ['latest 条目缺 name', versionsOf('0.0.11', { version: '0.0.11' })],
    ['latest 条目缺 version', versionsOf('0.0.11', { name: UPDATE_PACKAGE_NAME })],
    ['latest 条目 version 非字符串', versionsOf('0.0.11', { name: UPDATE_PACKAGE_NAME, version: 11 })],
    ['latest 条目 version 非法', versionsOf('0.0.11', { name: UPDATE_PACKAGE_NAME, version: '不是版本号' })],
    ['latest 条目 version 与 latest 不一致', versionsOf('0.0.11', { name: UPDATE_PACKAGE_NAME, version: '0.0.10' })],
    ['latest 条目 version 是 prerelease', versionsOf('0.0.11', { name: UPDATE_PACKAGE_NAME, version: '0.0.11-rc.1' })],
  ]

  for (const [label, document] of cases) {
    const result = await fetchRegistryPackage(NPMMIRROR, {
      fetch: recordingFetch(() => jsonResponse(document)),
      now: CLOCK,
    })
    assert.equal(result.ok, false, `${label} 必须被拒绝`)
    assert.equal(result.failure.kind, 'invalid-metadata', `${label} 的失败分类`)
  }
})

test('正确的 versions[latest] 通过校验；time 可选，且版本条目原文不进结果', async () => {
  const withTime = packageDocument('0.0.11')
  const withoutTime = packageDocument('0.0.11')
  delete withoutTime.time
  const badTime = packageDocument('0.0.11', { time: { '0.0.11': '不是日期' } })

  const accepted = await fetchRegistryPackage(NPMMIRROR, {
    fetch: recordingFetch(() => jsonResponse(withTime)),
    now: CLOCK,
  })
  assert.equal(accepted.ok, true)
  assert.deepEqual(accepted.metadata, {
    name: UPDATE_PACKAGE_NAME,
    version: '0.0.11',
    publishedAt: '2026-09-28T02:00:00.000Z',
  })

  // `time` 仍然是可选字段：缺失或不可解析只是没有发布时间，不能让合法版本失败。
  for (const [label, document] of [
    ['缺少 time', withoutTime],
    ['time 无效', badTime],
  ]) {
    const result = await fetchRegistryPackage(NPMMIRROR, {
      fetch: recordingFetch(() => jsonResponse(document)),
      now: CLOCK,
    })
    assert.equal(result.ok, true, `${label} 不能导致合法版本失败`)
    assert.deepEqual(Object.keys(result.metadata).sort(), ['name', 'version'], label)
  }

  // 一致性判据是**两边规范化之后**相等，不是逐字比较：条目写成 `v0.0.11` 也指向同一个版本。
  const prefixed = packageDocument('0.0.11', {
    versions: { '0.0.11': { name: UPDATE_PACKAGE_NAME, version: 'v0.0.11' } },
  })
  const normalized = await fetchRegistryPackage(NPMMIRROR, {
    fetch: recordingFetch(() => jsonResponse(prefixed)),
    now: CLOCK,
  })
  assert.equal(normalized.ok, true, '条目 version 规范化后与 latest 相等时必须接受')
  assert.equal(normalized.metadata.version, '0.0.11')

  // 版本条目只用来自洽校验：原文与其中任何其它字段都不进内部结果。
  assert.equal('versions' in accepted.metadata, false)
  assert.equal('dist-tags' in accepted.metadata, false)
  const serialized = JSON.stringify(accepted)
  for (const leaked of ['versions', '0.0.12-rc.1', 'readme', 'maintainers', '_attachments']) {
    assert.equal(serialized.includes(leaked), false, `结果里不得出现 ${leaked}`)
  }
})

test('缺少 latest、latest 不是字符串或不是合法版本时拒绝', async () => {
  const cases = [
    packageDocument('0.0.11', { 'dist-tags': { next: '0.0.12-rc.1' } }),
    packageDocument('0.0.11', { 'dist-tags': { latest: 11 } }),
    packageDocument('0.0.11', { 'dist-tags': {} }),
    packageDocument('0.0.11', { 'dist-tags': 'latest' }),
    packageDocument('0.0.11', { 'dist-tags': { latest: '不是版本号' } }),
    packageDocument('0.0.11', { 'dist-tags': { latest: '0.0' } }),
    [{ name: UPDATE_PACKAGE_NAME }],
  ]
  for (const document of cases) {
    const result = await fetchRegistryPackage(NPMMIRROR, {
      fetch: recordingFetch(() => jsonResponse(document)),
      now: CLOCK,
    })
    assert.equal(result.ok, false, `文档 ${JSON.stringify(document)} 必须被拒绝`)
    assert.equal(result.failure.kind, 'invalid-metadata')
  }
})

test('预发布版本不进入候选（latest 指向 rc 也拒绝）', async () => {
  for (const latest of ['0.0.12-rc.1', '0.0.12-beta', '0.0.12-alpha.2']) {
    const result = await fetchRegistryPackage(NPMMIRROR, {
      fetch: recordingFetch(() => jsonResponse(packageDocument(latest))),
      now: CLOCK,
    })
    assert.equal(result.ok, false, `${latest} 必须被拒绝`)
    assert.equal(result.failure.kind, 'invalid-metadata')
  }
})

test('非法 JSON 与空正文都归类为 invalid-json，且不抛异常', async () => {
  const broken = recordingFetch(() => new Response('{"name":', { status: 200 }))
  const first = await fetchRegistryPackage(NPMMIRROR, { fetch: broken, now: CLOCK })
  assert.equal(first.ok, false)
  assert.equal(first.failure.kind, 'invalid-json')

  const empty = recordingFetch(() => new Response(null, { status: 200 }))
  const second = await fetchRegistryPackage(NPMMIRROR, { fetch: empty, now: CLOCK })
  assert.equal(second.ok, false)
  assert.equal(second.failure.kind, 'invalid-json')
})

test('非 2xx（含 404）判为 http 失败并保留状态码', async () => {
  for (const status of [404, 429, 500, 503]) {
    const result = await fetchRegistryPackage(NPM, {
      fetch: recordingFetch(() => new Response('nope', { status })),
      now: CLOCK,
    })
    assert.equal(result.ok, false, `HTTP ${status} 必须失败`)
    assert.equal(result.failure.kind, 'http')
    assert.equal(result.failure.status, status)
  }
})

test('超时由 AbortController 触发，判为 timeout', async () => {
  let aborted = false
  const hangingFetch = recordingFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        assert.ok(init.signal instanceof AbortSignal, '请求必须带 signal')
        init.signal.addEventListener('abort', () => {
          aborted = true
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
  )
  const result = await fetchRegistryPackage({ ...NPM, timeoutMs: 20 }, { fetch: hangingFetch, now: CLOCK })

  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'timeout')
  assert.equal(aborted, true)
  assert.equal(hangingFetch.requests[0].signal.aborted, true)
})

test('网络错误（未被 abort）与超时分开', async () => {
  const failingFetch = recordingFetch(() => {
    throw new Error('ECONNRESET')
  })
  const result = await fetchRegistryPackage(NPM, { fetch: failingFetch, now: CLOCK })
  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'network')
})

test('正文超过 1 MiB 时边读边停，不依赖 content-length', async () => {
  const chunk = new Uint8Array(64 * 1024)
  let pulled = 0
  const stream = new ReadableStream({
    pull(controller) {
      // 有限流：不设上限的实现会读满 40 块（2.5 MiB）并让下面的断言变红，而不是把测试挂住。
      if (pulled >= 40) {
        controller.close()
        return
      }
      pulled += 1
      controller.enqueue(chunk)
    },
  })
  const fetchImpl = recordingFetch(
    () => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  const result = await fetchRegistryPackage(NPM, { fetch: fetchImpl, now: CLOCK })

  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'too-large')
  assert.ok(pulled <= 20, `超限后必须立刻停止读取（实际读了 ${pulled} 块）`)
})

test('content-length 谎报成小值时，仍按真实字节数判超限', async () => {
  const oversized = new Uint8Array(UPDATE_MAX_RESPONSE_BYTES + 1).fill(0x20)
  const fetchImpl = recordingFetch(
    () =>
      new Response(oversized, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '10' },
      }),
  )
  const result = await fetchRegistryPackage(NPM, { fetch: fetchImpl, now: CLOCK })

  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'too-large')
})

// ---------------------------------------------------------------------------
// 多源合并与结论
// ---------------------------------------------------------------------------

test('两个源都成功时取更高版本，按 SemVer 而不是字符串比较', async () => {
  // 字符串比较会认为 '0.0.9' > '0.0.10'，从而把结论倒过来 —— 这一条就是那种缺陷的证伪用例。
  const fetchImpl = perHostFetch({
    'registry.npmmirror.com': () => jsonResponse(packageDocument('0.0.9')),
    'registry.npmjs.org': () => jsonResponse(packageDocument('0.0.10')),
  })
  const discovery = await discoverLatestVersion('0.0.8', {
    fetch: fetchImpl,
    now: CLOCK,
    sources: [NPMMIRROR, NPM],
  })

  assert.equal(discovery.candidate.targetVersion, '0.0.10')
  assert.equal(discovery.candidate.sourceKind, 'npm')
  assert.deepEqual(
    discovery.sources.map((source) => [source.kind, source.latestVersion]),
    [
      ['npmmirror', '0.0.9'],
      ['npm', '0.0.10'],
    ],
  )
})

test('默认使用两个固定公共源，请求地址只由固定包名拼成', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(packageDocument('0.0.11')))
  const discovery = await discoverLatestVersion('0.0.10', { fetch: fetchImpl, now: CLOCK })

  assert.deepEqual(
    fetchImpl.requests.map((request) => request.url),
    [
      'https://registry.npmmirror.com/dsh-crwu-workbench',
      'https://registry.npmjs.org/dsh-crwu-workbench',
    ],
  )
  assert.equal(discovery.candidate.targetVersion, '0.0.11')
  assert.equal(discovery.candidate.sourceKind, 'npmmirror')
})

test('版本相同时优先 npmmirror，与源的排列顺序无关', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(packageDocument('0.0.11')))
  const discovery = await discoverLatestVersion('0.0.10', {
    fetch: fetchImpl,
    now: CLOCK,
    sources: [NPM, NPMMIRROR],
  })

  assert.equal(discovery.candidate.targetVersion, '0.0.11')
  assert.equal(discovery.candidate.sourceKind, 'npmmirror')
})

test('目标版本等于或低于当前版本时不产生候选，绝不降级', async () => {
  const equal = await discoverLatestVersion('0.0.11', {
    fetch: perHostFetch({
      'registry.npmmirror.com': () => jsonResponse(packageDocument('0.0.11')),
      'registry.npmjs.org': () => jsonResponse(packageDocument('0.0.11')),
    }),
    now: CLOCK,
    sources: [NPMMIRROR, NPM],
  })
  assert.equal(equal.candidate, undefined)
  assert.deepEqual(
    equal.sources.map((source) => source.latestVersion),
    ['0.0.11', '0.0.11'],
  )

  const older = await discoverLatestVersion('0.0.12', {
    fetch: perHostFetch({
      'registry.npmmirror.com': () => jsonResponse(packageDocument('0.0.10')),
      'registry.npmjs.org': () => new Response('nope', { status: 500 }),
    }),
    now: CLOCK,
    sources: [NPMMIRROR, NPM],
  })
  assert.equal(older.candidate, undefined, '镜像源较旧、官方源失败时不能给出降级候选')
  assert.equal(older.sources[1].failure.kind, 'http')
})

test('当前版本不是合法 SemVer 时不给候选（fail closed）', async () => {
  for (const broken of ['dev', '0.0.10.1', '', 'v']) {
    const discovery = await discoverLatestVersion(broken, {
      fetch: recordingFetch(() => jsonResponse(packageDocument('0.0.11'))),
      now: CLOCK,
    })
    assert.equal(discovery.candidate, undefined, `当前版本 ${JSON.stringify(broken)} 必须 fail closed`)
    // 归因仍然保留：界面可以据此说"上次检查过，但版本号无法判断"。
    assert.equal(discovery.sources[0].latestVersion, '0.0.11')
  }
})

test('当前版本本身是预发布版时仍可更新到正式版（开发安装由 buildKind 拦，不看版本串）', async () => {
  const discovery = await discoverLatestVersion('0.0.11-rc.1', {
    fetch: recordingFetch(() => jsonResponse(packageDocument('0.0.11'))),
    now: CLOCK,
  })
  assert.equal(discovery.candidate.targetVersion, '0.0.11')
  assert.equal(discovery.candidate.currentVersion, '0.0.11-rc.1')
})

test('单个源失败不会抹掉另一个源的成功结果', async () => {
  const discovery = await discoverLatestVersion('0.0.10', {
    fetch: perHostFetch({
      'registry.npmmirror.com': () => new Response('bad gateway', { status: 502 }),
      'registry.npmjs.org': () => jsonResponse(packageDocument('0.0.11')),
    }),
    now: CLOCK,
    sources: [NPMMIRROR, NPM],
  })

  assert.equal(discovery.candidate.targetVersion, '0.0.11')
  assert.equal(discovery.candidate.sourceKind, 'npm')
  assert.equal(discovery.sources[0].failure.kind, 'http')
  assert.equal(discovery.sources[0].failure.status, 502)
  assert.equal(discovery.sources[1].latestVersion, '0.0.11')
})

test('两个源都失败时没有候选，只保留归因', async () => {
  const discovery = await discoverLatestVersion('0.0.10', {
    fetch: perHostFetch({
      'registry.npmmirror.com': () => new Response('x', { status: 500 }),
      'registry.npmjs.org': () => new Response('{"name":', { status: 200 }),
    }),
    now: CLOCK,
    sources: [NPMMIRROR, NPM],
  })

  assert.equal(discovery.candidate, undefined)
  assert.deepEqual(
    discovery.sources.map((source) => source.failure.kind),
    ['http', 'invalid-json'],
  )
})

test('候选只带规范化安全字段：过期时间由注入时钟推出，且不含任何 registry 内容', async () => {
  const discovery = await discoverLatestVersion('0.0.10', {
    fetch: perHostFetch({
      'registry.npmmirror.com': () => jsonResponse(packageDocument('0.0.12')),
      'registry.npmjs.org': () => jsonResponse(packageDocument('0.0.11')),
    }),
    now: CLOCK,
    sources: [NPMMIRROR, NPM],
  })

  assert.deepEqual(Object.keys(discovery.candidate).sort(), [
    'checkedAt',
    'currentVersion',
    'expiresAt',
    'publishedAt',
    'sourceKind',
    'targetVersion',
  ])
  assert.equal(discovery.candidate.checkedAt, NOW)
  assert.equal(discovery.candidate.expiresAt, '2026-09-28T16:00:00.000Z')

  const serialized = JSON.stringify(discovery)
  for (const forbidden of [
    'registry.npmmirror.com',
    'registry.npmjs.org',
    'readme',
    '_attachments',
    'maintainers',
    'authorization',
    'token',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `候选与归因里不得出现 ${forbidden}`)
  }
})

test('候选允许省略发布时间，但其余字段不变', async () => {
  const document = packageDocument('0.0.12')
  delete document.time
  const discovery = await discoverLatestVersion('0.0.10', {
    fetch: recordingFetch(() => jsonResponse(document)),
    now: CLOCK,
  })

  assert.deepEqual(Object.keys(discovery.candidate).sort(), [
    'checkedAt',
    'currentVersion',
    'expiresAt',
    'sourceKind',
    'targetVersion',
  ])
})
