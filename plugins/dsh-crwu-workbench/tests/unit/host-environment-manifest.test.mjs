/**
 * 第 1 层（环境清单 / 版本约束）的单元测试。
 *
 * 这一层的规则很容易「看起来对但实际放行」：约束解析不出数字时按「无约束」通过、
 * 实际输出解析不出数字时反而必须失败、空列表必须回退内置而不是变成空。每条都反向验一遍。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { satisfies, parseVersion, compareVersion } = await import(new URL('src/host/environment/version.ts', ROOT).href)
const {
  DEFAULT_MANIFEST,
  OSSUTIL_BASE,
  crwuPlatforms,
  ossutilPlatforms,
} = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)
const {
  quoteArg,
  normalizeOss,
  normalizeManifest,
  loadManifest,
  resolveBinary,
  resolvePlatformEntry,
} = await import(new URL('src/host/environment/manifest.ts', ROOT).href)

// ── 版本 ────────────────────────────────────────────────────────────────────

test('parseVersion reads a version out of noisy command output', () => {
  assert.deepEqual(parseVersion('v22.19.0'), [22, 19, 0])
  assert.deepEqual(parseVersion('Version: 1.7.19'), [1, 7, 19])
  assert.deepEqual(parseVersion('Python 3.11'), [3, 11, 0])
  assert.deepEqual(parseVersion('dws 0.2.14 (build 7)'), [0, 2, 14])
  assert.equal(parseVersion('no version here'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(null), null)
})

test('compareVersion is a three-segment lexicographic comparison', () => {
  assert.equal(compareVersion([1, 2, 3], [1, 2, 3]), 0)
  assert.equal(compareVersion([1, 2, 3], [1, 2, 4]), -1)
  assert.equal(compareVersion([2, 0, 0], [1, 9, 9]), 1)
  assert.equal(compareVersion([1, 10, 0], [1, 9, 0]), 1, '10 必须大于 9（不能按字符串比）')
})

test('satisfies honours each operator', () => {
  assert.deepEqual(satisfies('22.19.0', '>=16.7'), { ok: true, reason: '' })
  assert.deepEqual(satisfies('16.6.0', '>=16.7'), { ok: false, reason: '低于期望 >=16.7' })
  assert.equal(satisfies('0.2.14', '>0.2.14').ok, false)
  assert.equal(satisfies('0.2.15', '>0.2.14').ok, true)
  assert.equal(satisfies('1.7.19', '<=1.7.19').ok, true)
  assert.equal(satisfies('1.7.20', '<=1.7.19').ok, false)
  assert.equal(satisfies('3.11.0', '<4').ok, true)
  assert.equal(satisfies('1.7.19', '1.7.19').ok, true, '无操作符按等号处理')
  assert.equal(satisfies('1.7.20', '1.7.19').ok, false)
})

test('satisfies treats an absent constraint as no constraint', () => {
  assert.deepEqual(satisfies('anything', ''), { ok: true, reason: '' })
  assert.deepEqual(satisfies('anything', '*'), { ok: true, reason: '' })
  // 约束本身解析不出数字 = 清单写错了，但按「没有约束」处理而不是把人挡在门外。
  assert.deepEqual(satisfies('1.0.0', 'latest'), { ok: true, reason: '' })
})

test('satisfies fails when the installed version cannot be read', () => {
  // 「装了但读不到版本」不能算通过：那会让环境自检显示绿而实际不可用。
  const verdict = satisfies('command not found', '>=16.7')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /无法从命令输出解析出版本号/)
})

// ── 清单归一 ────────────────────────────────────────────────────────────────

test('normalizeManifest falls back to the builtin list for empty sections', () => {
  // 远程清单少写 binaries 时必须回退，否则「全部通过」是假的。
  const manifest = normalizeManifest({ schema: 'x', binaries: [], services: [] })
  assert.equal(manifest.binaries.length, DEFAULT_MANIFEST.binaries.length)
  assert.equal(manifest.services.length, DEFAULT_MANIFEST.services.length)
  assert.equal(manifest.schema, 'x')
})

test('normalizeManifest keeps remote overrides and narrows external input', () => {
  const manifest = normalizeManifest({
    binaries: [{ name: 'crwu', expect: '>=1.0', versionArgs: 'nope', required: false, note: 7 }],
    ifindKey: { path: '/custom/mcp.json' },
    oss: { bucket: 'b', prefix: '/crwu/audit/', linkTtl: 'soon' },
    workspace: { preferTitle: '别的空间' },
  })
  const [crwu] = manifest.binaries
  assert.equal(crwu.name, 'crwu')
  assert.equal(crwu.command, 'crwu', 'command 缺失时回落到 name')
  assert.deepEqual(crwu.versionArgs, ['version'], 'versionArgs 不是数组时用默认')
  assert.equal(crwu.required, false)
  assert.equal(crwu.note, '7')
  assert.equal(manifest.ifindKey.path, '/custom/mcp.json')
  assert.equal(manifest.ifindKey.field, 'auth_token')
  assert.equal(manifest.oss.prefix, '/crwu/audit', 'prefix 去掉尾斜杠')
  assert.equal(manifest.oss.linkTtl, 3600, 'TTL 解析不出数字时回默认')
  assert.equal(manifest.workspace.preferTitle, '别的空间')
  assert.equal(manifest.workspace.preferPath, DEFAULT_MANIFEST.workspace.preferPath)
})

test('normalizeManifest drops entries without a name instead of inventing one', () => {
  const manifest = normalizeManifest({ binaries: [{ command: 'ghost' }, { name: 'real' }] })
  assert.deepEqual(manifest.binaries.map((entry) => entry.name), ['real'])
})

test('normalizeOss only accepts the two documented link modes', () => {
  assert.equal(normalizeOss({ linkMode: 'public' }).linkMode, 'public')
  assert.equal(normalizeOss({ linkMode: 'signed' }).linkMode, 'signed')
  assert.equal(normalizeOss({ linkMode: 'PRIVATE' }).linkMode, 'signed', '不认识的模式必须回落到签名 URL')
  assert.equal(normalizeOss({ enabled: 'yes' }).enabled, false, 'enabled 只认严格 true')
  assert.equal(normalizeOss({ autoUpload: false }).autoUpload, false)
  assert.equal(normalizeOss({}).autoUpload, true)
})

// ── 平台选择 ────────────────────────────────────────────────────────────────

test('resolveBinary picks the platform row and keeps the entry default otherwise', () => {
  const ossutil = DEFAULT_MANIFEST.binaries.find((entry) => entry.name === 'ossutil')
  assert.ok(ossutil)
  const mac = resolveBinary(ossutil, 'darwin-arm64')
  assert.match(mac.url, /mac-arm64\.zip$/)
  assert.equal(mac.member, 'ossutil')
  assert.equal(mac.target, '~/bin/ossutil')
  // 没有该平台的行 → 清空下载信息，界面显示「暂无包」而不是给一个错的地址。
  const solaris = resolveBinary(ossutil, 'sunos-sparc')
  assert.equal(solaris.url, '')
  assert.equal(solaris.sha256, '')
})

test('resolveBinary leaves a platform-less entry untouched', () => {
  const node = DEFAULT_MANIFEST.binaries.find((entry) => entry.name === 'node')
  assert.ok(node)
  assert.equal(resolveBinary(node, 'darwin-arm64').name, 'node')
  assert.equal(resolvePlatformEntry(node, 'darwin-arm64'), null)
})

test('the shipped download tables are complete for the platforms we claim', () => {
  const ossutil = ossutilPlatforms()
  for (const key of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
    assert.ok(ossutil[key], `ossutil 缺少 ${key}`)
    assert.equal(ossutil[key].sha256.length, 64, `${key} 的 sha256 长度不对`)
    assert.ok(ossutil[key].url.startsWith(OSSUTIL_BASE), `${key} 的下载源不对`)
  }
  const crwu = crwuPlatforms()
  assert.equal(crwu['darwin-arm64'].target, '~/bin/crwu')
  assert.equal(crwu['win32-x64'].target, '~/bin/crwu.exe')
})

// ── 拉取清单 ────────────────────────────────────────────────────────────────

function shellReturning(result) {
  return { get: (name) => (name === 'shell' ? { resolve: (request) => request, async run() { return result } } : undefined) }
}

const OK = { exitCode: 0, timedOut: false, stdout: { text: '{"binaries":[{"name":"only"}]}', truncated: false }, stderr: { text: '', truncated: false } }

test('loadManifest falls back to the builtin list when no source is configured', async () => {
  const load = await loadManifest({ get: () => undefined }, '')
  assert.equal(load.kind, 'builtin')
  assert.equal(load.loaded, false)
  assert.equal(load.manifest.binaries.length, DEFAULT_MANIFEST.binaries.length)
})

test('loadManifest refuses a local path and explains why', async () => {
  const load = await loadManifest({ get: () => undefined }, '/etc/manifest.json')
  assert.equal(load.kind, 'invalid')
  assert.match(load.error, /必须是 http\(s\) 远程地址/)
})

test('loadManifest pulls and narrows a remote manifest', async () => {
  const load = await loadManifest(shellReturning(OK), 'https://example.invalid/m.json')
  assert.equal(load.loaded, true)
  assert.equal(load.kind, 'url')
  assert.deepEqual(load.manifest.binaries.map((entry) => entry.name), ['only'])
  assert.equal(load.manifest.oss.prefix, 'crwu/audit', '远程没给 oss 时用默认')
})

test('loadManifest degrades to the builtin list and reports the reason', async () => {
  const failed = await loadManifest(shellReturning({ ...OK, exitCode: 22, stderr: { text: 'curl: 404', truncated: false } }), 'https://x.invalid/m.json')
  assert.equal(failed.loaded, false)
  assert.match(failed.error, /404/)
  assert.equal(failed.manifest.binaries.length, DEFAULT_MANIFEST.binaries.length)

  const broken = await loadManifest(shellReturning({ ...OK, stdout: { text: '{oops', truncated: false } }), 'https://x.invalid/m.json')
  assert.equal(broken.loaded, false)
  assert.match(broken.error, /不是合法 JSON/)
})

test('quoteArg only quotes when the value needs it', () => {
  assert.equal(quoteArg('https://a.b/c.json'), 'https://a.b/c.json')
  assert.equal(quoteArg('has space'), "'has space'")
  assert.equal(quoteArg("it's"), "'it'\\''s'")
  assert.equal(quoteArg(''), "''")
})
