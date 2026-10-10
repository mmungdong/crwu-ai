/**
 * 第 4 层后半（OSS 操作）的单元测试。
 *
 * 三条安全约束是重点，每条都要能反向失败：
 * 1. 不在配置前缀内的 key 一律拒绝（`oss-result` / `oss-link`）；
 * 2. `oss-result` 只回摘要，绝不把完整证据链带出来；
 * 3. 签名链接必须升级成 https（链接里带 bearer 签名，明文等于泄密）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)

const { ossIndex, ossResult, ossLink, ossUpload, ossCredSave, uploadArtifacts, buildConfigContent } = await import(
  new URL('src/host/oss/ops.ts', ROOT).href
)
const { maybeAutoUpload, runUploadWatch } = await import(new URL('src/host/oss/auto.ts', ROOT).href)
const { DEFAULT_MANIFEST } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)
const { manifestFixture } = await import(new URL('tests/helpers/manifest-fixture.mjs', ROOT).href)
const { normalizeAudit } = await import(new URL('src/host/state/registry.ts', ROOT).href)
const { bundledBinaryPath } = await import(new URL('src/host/platform/bin-dir.ts', ROOT).href)

const SEQ = '2026-301705-LX10170'
/** 包内 ossutil 的绝对路径：`resolveOssutil` 只认它（不再回退 PATH）。 */
const BUNDLED_OSSUTIL = bundledBinaryPath('darwin-arm64', 'ossutil')

function manifestWith(patch = {}) {
  return manifestFixture({
    oss: { enabled: true, bucket: 'bkt', prefix: 'crwu/audit', linkMode: 'signed', linkTtl: 3600, autoUpload: true, ...patch },
  })
}

function ossDeps(patch = {}) {
  const commands = []
  const ctx = {
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => { commands.push(request.command); return request },
          async execute(spec) {
            // 权限回读要回一个可解析的模式位：协议 18 起"保存凭据成功"由回读决定
            // （`credentialPermissionSatisfied`），回空的夹具会让每次保存都合理地判失败。
            const modeless = /^stat\s/.test(spec.command)
            const out = modeless
              ? { stdout: `${patch.mode ?? '600'}\n` }
              : (patch.shell === undefined ? { stdout: '' } : patch.shell(spec.command))
            return { result: async () => ({
              exitCode: out.exitCode ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: out.stdout ?? '', truncated: out.truncated === true },
              stderr: { text: out.stderr ?? '', truncated: false },
            }) }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          // 包内 ossutil 一律「在」（`patch.missingOssutil` 可以把它拿掉，用来验插件包不完整那条）：
          // ossutil 只按包内绝对路径解析，PATH 已经不再是判据。
          async stat(target) {
            if (target.targetKey === BUNDLED_OSSUTIL) return patch.missingOssutil === true ? undefined : { type: 'file' }
            return (patch.files ?? {})[target.targetKey] === undefined ? undefined : { type: 'file' }
          },
          async readText(target) { return (patch.files ?? {})[target.targetKey] ?? '' },
          async writeText(target, content, _intent, _version, options) {
            // 第 5 个参数是写盘策略：`~/.ossutilconfig` 在工作区之外，必须逐次声明
            // `danger-full-access`，否则受限沙箱会直接拒绝（员工实测）。
            patch.writes?.push({ path: target.targetKey, content, sandboxPolicy: options })
            // 真实 fs 会落盘，所以后续 readText/stat 必须能看到这次写入。
            patch.files = patch.files ?? {}
            patch.files[target.targetKey] = content
            return { operation: 'update', version: 'v', before: null, after: content }
          },
          async listDir(target) { return (patch.dirs ?? {})[target.targetKey] ?? [] },
        }
      }
      return undefined
    },
  }
  return {
    commands,
    deps: {
      ctx,
      // Broker：每一次 `ossutil` 都会读 `~/.ossutilconfig`，所以全部经它执行（真 Broker，
      // 策略走真实代码；替身只负责"世界"）。
      access: makeTestAccess(ctx, { home: '/Users/x' }).access,
      // 协议 18：`OssDeps` 必须逐次说明"这次是谁发起的"——少了它 Broker 会按
      // `invalid-source` 拒掉（这正是"来源不能靠默认值"的体现）。
      source: patch.source ?? 'panel',
      manifest: patch.manifest ?? manifestWith(),
      platform: 'darwin-arm64',
      home: '/Users/x',
      workdir: async () => '/cases/session',
    },
  }
}

/**
 * 除 ossutil 解析之外，其余命令一律回空 stdout。
 *
 * 2026-09-25 起 ossutil **只按包内绝对路径**解析（`ossDeps` 的 fs 替身让包内那份存在），
 * 所以这里不再需要为 `command -v` 单独回一条路径 —— PATH 已经不是判据了。
 */
const ossutilOnPath = (command) => {
  void command
  return { stdout: '' }
}

/** `sign` 给一条链接、别的命令给空输出（只关心"起没起浏览器进程"的用例用它）。 */
const signedStub = (command) => (command.includes(' sign ')
  ? { stdout: 'https://bkt.oss-cn-x.aliyuncs.com/a?Signature=x\n' }
  : { stdout: '' })

// ── oss-index ───────────────────────────────────────────────────────────────

test('oss-index：一次 ls 就带回 个数/大小/最后写入时间/ETag（不加 --short-format）', async () => {
  // 逐字照 `ossutil help ls` 的长格式样本（默认格式；`--short-format` 才只剩 key）。
  const listing = [
    'LastModifiedTime              Size(B)  StorageClass   ETAG                              ObjectName',
    `2026-09-20 17:41:02 +0800 CST  20481      Standard   7E2F4A7F1AC9D2F0996E8332D5EA5B41  oss://bkt/crwu/audit/${SEQ}/审核意见.${SEQ}.html`,
    `2026-09-20 17:41:03 +0800 CST  9032       Standard   6185CA2E8EB8510A61B3A845EAFE4174  oss://bkt/crwu/audit/${SEQ}/审核结果.${SEQ}.json`,
    'Object Number is: 2',
  ].join('\n')
  const { deps, commands } = ossDeps({ shell: (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: listing }) })
  const result = await ossIndex(deps)
  assert.equal(result.ok, true)
  assert.equal(result.count, 2, '表头与汇总行都不能被当成对象')
  assert.deepEqual(Object.keys(result.items), [SEQ])
  const item = result.items[SEQ]
  assert.equal(item.htmlKey, `crwu/audit/${SEQ}/审核意见.${SEQ}.html`)
  assert.equal(item.jsonKey, `crwu/audit/${SEQ}/审核结果.${SEQ}.json`)
  // **一次列举**就带回了每个对象的大小 / 最后写入时间 / ETag
  const json = item.files.find((file) => file.key === item.jsonKey)
  assert.deepEqual(
    { size: json.size, lastModified: json.lastModified, etag: json.etag },
    { size: 9032, lastModified: '2026-09-20 17:41:03', etag: '6185ca2e8eb8510a61b3a845eafe4174' },
  )
  // 长格式下**不能**再传 --short-format（那会把上面三样丢掉）；ossutil 也不接受 -r。
  const ls = commands.find((command) => command.includes(' ls ')) ?? ''
  assert.equal(ls.includes('--short-format'), false, '长格式才有元数据')
  assert.equal(ls.includes(' -r'), false)
})

test('oss-index：长格式认不出来时退回"只要 key"，清单不能整段丢', async () => {
  // 某些版本/语言下列宽或表头不同：解析不到条目就退回老的 key 解析（少元数据，但清单还在）。
  const listing = [
    `oss://bkt/crwu/audit/${SEQ}/审核意见.${SEQ}.html`,
    'Object Number is: 1',
  ].join('\n')
  const { deps } = ossDeps({ shell: (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: listing }) })
  const result = await ossIndex(deps)
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.items[SEQ].htmlKey, `crwu/audit/${SEQ}/审核意见.${SEQ}.html`)
  assert.deepEqual(result.items[SEQ].files[0], { key: `crwu/audit/${SEQ}/审核意见.${SEQ}.html`, name: `审核意见.${SEQ}.html` })
})

test('oss-index refuses when OSS is disabled, has no bucket, or has no ossutil', async () => {
  const disabled = ossDeps({ manifest: manifestWith({ enabled: false }) })
  assert.match((await ossIndex(disabled.deps)).error, /enabled/)

  const noBucket = ossDeps({ manifest: manifestWith({ bucket: '' }) })
  assert.match((await ossIndex(noBucket.deps)).error, /bucket/)

  // 「没有 ossutil」= **插件包**不完整（不再是「员工没装命令」）。
  const noOssutil = ossDeps({ missingOssutil: true })
  const error = (await ossIndex(noOssutil.deps)).error
  assert.match(error, /ossutil/)
  assert.match(error, /插件包不完整|平台不受支持/)
  assert.doesNotMatch(error, /请先安装/)
})

test('oss-index 按流水号查：只列该流水号那一层，命中它自己的交付件', async () => {
  const listing = [
    `oss://bkt/crwu/audit/${SEQ}/审核意见.${SEQ}.html`,
    `oss://bkt/crwu/audit/${SEQ}/审核结果.${SEQ}.json`,
  ].join('\n')
  const { deps, commands } = ossDeps({
    shell: (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: listing }),
  })
  const result = await ossIndex(deps, { seqNo: SEQ })
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.items), [SEQ])
  assert.equal(result.items[SEQ].htmlKey, `crwu/audit/${SEQ}/审核意见.${SEQ}.html`)
  const ls = commands.find((command) => command.includes(' ls ')) ?? ''
  assert.ok(ls.includes(`oss://bkt/crwu/audit/${SEQ}/`), `只该列这个流水号那一层，实际：${ls}`)
})

test('oss-index 按流水号查：不合形状 / 试图越界一律拒绝，且一条命令都不发', async () => {
  // 安全边界：流水号会被拼进 OSS 路径，不校验的话 `../` 能越出配置前缀。
  for (const bad of ['not-a-seq', '2026-301705-../other', '2026-301705-..', '2026-301705-a/b', '2026-301705-a b', 'x'.repeat(200)]) {
    const { deps, commands } = ossDeps({ shell: ossutilOnPath })
    const result = await ossIndex(deps, { seqNo: bad })
    assert.equal(result.ok, false, `应当拒绝：${JSON.stringify(bad)}`)
    assert.match(result.error, /流水号/, `错误要说清是流水号的问题：${result.error}`)
    assert.equal(commands.length, 0, `非法输入不得发出任何命令（${JSON.stringify(bad)}）`)
  }
})

test('oss-index 不传流水号 = 照旧列举整段前缀（既有行为不能被破坏）', async () => {
  const { deps, commands } = ossDeps({ shell: ossutilOnPath })
  await ossIndex(deps, { seqNo: '   ' })
  const ls = commands.find((command) => command.includes(' ls ')) ?? ''
  assert.match(ls, /oss:\/\/bkt\/crwu\/audit\/?(\s|$)/, `空流水号应是整段列举：${ls}`)
  assert.equal(ls.includes('--short-format'), false, '长格式才有元数据')
})

test('oss-index 按流水号查：没找到是 ok:true / 0 条（不是命令失败）', async () => {
  const { deps } = ossDeps({ shell: (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: '' }) })
  const result = await ossIndex(deps, { seqNo: SEQ })
  assert.equal(result.ok, true)
  assert.equal(result.count, 0)
  assert.deepEqual(result.items, {})
})

// ── oss-result ──────────────────────────────────────────────────────────────

test('oss-result rejects a key outside the configured prefix', async () => {
  // 这是安全边界：越界 key 必须拒绝，否则能读任意 bucket 里任意对象。
  const { deps, commands } = ossDeps({ shell: ossutilOnPath })
  const result = await ossResult(deps, { key: 'other/prefix/secret.json' })
  assert.equal(result.ok, false)
  assert.match(result.error, /不在配置的 OSS 前缀内/)
  assert.equal(commands.some((command) => command.includes(' cat ')), false, '越界时不得执行 cat')
})

test('oss-result rejects a non-JSON key before running cat', async () => {
  const { deps, commands } = ossDeps({ shell: ossutilOnPath })
  const result = await ossResult(deps, { key: `crwu/audit/${SEQ}/审核意见.${SEQ}.html` })
  assert.equal(result.ok, false)
  assert.match(result.error, /只允许读取 JSON/)
  assert.equal(commands.some((command) => command.includes(' cat ')), false)
})

test('oss-result tolerates the ossutil stdout footer that real objects always carry', async () => {
  // 真实事故（第 26 轮，真实 OSS 对象）：ossutil v1.7.19 把 `<n>(s) elapsed` 无条件写到 stdout，
  // 于是对**每一个真实对象**的 JSON.parse 都失败 —— 「审核信息」抽屉永远报「不是合法 JSON」。
  // 尾巴文本是实测抄回来的，不是编的。
  const doc = { schemaVersion: '1.6', auditTask: { projectId: 'P1' }, summary: { counts: { high: 2 } } }
  const { deps } = ossDeps({
    shell: (command) => (command.startsWith('command -v')
      ? { stdout: '/usr/local/bin/ossutil\n' }
      : { stdout: `${JSON.stringify(doc)}\n0.104387(s) elapsed\n` }),
  })
  const result = await ossResult(deps, { key: `crwu/audit/${SEQ}/审核结果.${SEQ}.json` })
  assert.equal(result.ok, true, `带 elapsed 尾巴的真实输出必须能解析：${result.error}`)
  assert.equal(result.info.projectId, 'P1')
  assert.equal(result.info.schemaVersion, '1.6')
})

test('oss-result returns only a summary, never the full evidence chain', async () => {
  const doc = {
    schemaVersion: '1.0',
    auditTask: { projectId: 'P1', auditTime: '2026-09-20' },
    summary: { overallDecision: '通过', counts: { high: 1 }, narrative: 'x'.repeat(9000) },
    reviewComparison: { status: 'partial', metrics: { total: 10 } },
    // 这两段是必须被丢掉的：完整问题清单与文件轨迹
    findings: [{ id: 'F1', evidence: 'RAW EVIDENCE SHOULD NOT LEAK' }],
    fileTrace: { sourceDigest: 'digest' },
  }
  const { deps } = ossDeps({ shell: (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: JSON.stringify(doc) }) })
  const result = await ossResult(deps, { key: `crwu/audit/${SEQ}/审核结果.${SEQ}.json` })
  assert.equal(result.ok, true)
  const serialized = JSON.stringify(result.info)
  assert.equal(serialized.includes('RAW EVIDENCE SHOULD NOT LEAK'), false, '完整证据链绝不能进列表接口')
  assert.equal(serialized.includes('findings'), false)
  assert.equal(result.info.projectId, 'P1')
  assert.equal(result.info.summary.narrative.length, 4000, 'narrative 必须截断')
})

test('oss-result refuses a truncated or malformed payload instead of guessing', async () => {
  const truncated = ossDeps({ shell: (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: '{"a":1}', truncated: true }) })
  assert.match((await ossResult(truncated.deps, { key: `crwu/audit/${SEQ}/r.json` })).error, /8MB/)

  const malformed = ossDeps({ shell: (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: '{oops' }) })
  assert.match((await ossResult(malformed.deps, { key: `crwu/audit/${SEQ}/r.json` })).error, /不是合法 JSON/)
})

// ── oss-link ────────────────────────────────────────────────────────────────

test('oss-link upgrades a signed http url to https', async () => {
  const { deps } = ossDeps({
    shell: (command) => {
      if (command.startsWith('command -v')) return { stdout: '/usr/local/bin/ossutil\n' }
      if (command.includes(' sign ')) return { stdout: 'http://bkt.oss-cn-x.aliyuncs.com/a?Signature=secret\n' }
      return { stdout: '' }
    },
  })
  const result = await ossLink(deps, { key: `crwu/audit/${SEQ}/审核意见.${SEQ}.html` })
  assert.equal(result.ok, true)
  assert.match(result.url, /^https:\/\//, '带 bearer 签名的链接不能走明文')
})

test('oss-link refuses a key outside the prefix', async () => {
  const { deps, commands } = ossDeps({ shell: ossutilOnPath })
  const result = await ossLink(deps, { key: 'elsewhere/x.html' })
  assert.equal(result.ok, false)
  assert.match(result.error, /不在配置的 OSS 前缀内/)
  assert.equal(commands.some((command) => command.includes(' sign ')), false)
})

test('oss-link uses the public base url when the manifest says public', async () => {
  const { deps } = ossDeps({ manifest: manifestWith({ linkMode: 'public', publicBaseUrl: 'https://cdn.invalid/base/' }) })
  const result = await ossLink(deps, { key: `crwu/audit/${SEQ}/审核意见.${SEQ}.html` })
  assert.equal(result.ok, true)
  assert.match(result.url, /^https:\/\/cdn\.invalid\/base\/crwu\/audit\//)
  assert.equal(result.mode, 'public')
})

test('oss-link refuses public mode without a base url', async () => {
  const { deps } = ossDeps({ manifest: manifestWith({ linkMode: 'public', publicBaseUrl: '' }) })
  assert.match((await ossLink(deps, { key: `crwu/audit/${SEQ}/a.html` })).error, /publicBaseUrl/)
})

// ── 上传 ────────────────────────────────────────────────────────────────────

const CASE_ENTRIES = [
  { type: 'file', name: `审核意见.${SEQ}.html`, target: { targetKey: `x` } },
  { type: 'file', name: `审核结果.${SEQ}.json`, target: { targetKey: `y` } },
]

function uploadDeps(patch = {}) {
  const files = {
    [`/cases/${SEQ}/审核意见.${SEQ}.html`]: 'html',
    [`/cases/${SEQ}/审核结果.${SEQ}.json`]: '{}',
  }
  return ossDeps({
    files,
    dirs: { [`/cases/${SEQ}`]: CASE_ENTRIES },
    shell: (command) => {
      if (command.startsWith('command -v')) return { stdout: '/usr/local/bin/ossutil\n' }
      if (patch.failUpload === true && command.includes(' cp ')) return { exitCode: 1, stderr: 'AccessDenied' }
      return { stdout: 'ok' }
    },
  })
}

test('uploadArtifacts uploads both canonical artifacts under the serial number', async () => {
  const { deps, commands } = uploadDeps()
  const out = await uploadArtifacts(
    deps,
    { path: `/cases/${SEQ}`, htmlFile: `审核意见.${SEQ}.html`, resultFile: `审核结果.${SEQ}.json`, name: SEQ },
    SEQ,
    '/usr/local/bin/ossutil',
    deps.manifest.oss,
  )
  assert.equal(out.ok, true)
  assert.equal(out.prefix, `crwu/audit/${SEQ}`, '对象 key 只用流水号，不按年/月分段')
  const copies = commands.filter((command) => command.includes(' cp '))
  assert.equal(copies.length, 2, 'HTML 与 JSON 都要传')
  assert.match(copies[0], new RegExp(`审核意见\\.${SEQ}\\.html`))
})

test('ossCredSave 的输入校验失败信封按注入平台给机制（Windows 不得报 posix-0600）', async () => {
  const { deps } = ossDeps({})
  const win = await ossCredSave({ ...deps, platform: 'win32-x64' }, { accessKeyId: '', accessKeySecret: '' })
  assert.equal(win.ok, false)
  assert.equal(win.permission.status, 'failed')
  assert.equal(win.permission.mechanism, 'windows-acl', '失败信封也要与平台一致')

  const mac = await ossCredSave({ ...deps, platform: 'darwin-arm64' }, { accessKeyId: 'a', accessKeySecret: 'b\nc' })
  assert.equal(mac.ok, false)
  assert.equal(mac.permission.mechanism, 'posix-0600')
  assert.match(mac.error, /换行/)
})

test('uploadArtifacts 区分本地路径与对象键：本地随平台，对象键永远用 `/`', async () => {
  const { deps, commands } = uploadDeps()
  deps.platform = 'win32-x64'
  const out = await uploadArtifacts(
    deps,
    { path: `C:\\Cases\\${SEQ}`, htmlFile: `审核意见.${SEQ}.html`, resultFile: '', name: SEQ },
    SEQ,
    'C:\\Program Files\\ossutil.exe',
    deps.manifest.oss,
  )
  assert.equal(out.ok, true)
  // Windows 上每个 token 都是单引号字面量，所以不能用 `includes(' cp ')` 找子命令。
  const copy = commands.filter((command) => /['\s]cp['\s]/.test(command)).join('\n')
  assert.notEqual(copy, '', `必须真的发出 cp 命令：${commands.join(' | ')}`)
  // 本地源路径必须是 Windows 风格（历史实现拼成 `C:\Cases/<SEQ>/…`）。
  assert.match(copy, /'C:\\Cases\\[^']*审核意见/)
  // 远端键永远 `/`，且带 `oss://` 前缀。
  assert.match(copy, /'oss:\/\/bkt\/crwu\/audit\//)
  assert.equal(copy.includes('oss://bkt/crwu/audit/' + SEQ), true)
  assert.equal(out.results[0].key, `crwu/audit/${SEQ}/审核意见.${SEQ}.html`)
})

test('uploadArtifacts reports per-file failures instead of a bare false', async () => {
  const { deps } = uploadDeps({ failUpload: true })
  const out = await uploadArtifacts(
    deps,
    { path: `/cases/${SEQ}`, htmlFile: `审核意见.${SEQ}.html`, resultFile: `审核结果.${SEQ}.json`, name: SEQ },
    SEQ,
    '/usr/local/bin/ossutil',
    deps.manifest.oss,
  )
  assert.equal(out.ok, false)
  assert.equal(out.results.length, 2)
  for (const entry of out.results) assert.equal(entry.ok, false)
  assert.match(out.error, /AccessDenied/, '必须把 CLI 的原文带回去，否则用户不知道哪里错了')
})

test('uploadArtifacts refuses a case with no deliverable', async () => {
  const { deps } = uploadDeps()
  const out = await uploadArtifacts(deps, { path: '/cases/x', htmlFile: '', resultFile: '', name: 'x' }, 'x', '/usr/local/bin/ossutil', deps.manifest.oss)
  assert.equal(out.ok, false)
  assert.match(out.error, /没有可回传的交付件/)
})

test('oss-upload writes the outcome back onto the record it was given', async () => {
  const { deps } = uploadDeps()
  const record = { casePath: `/cases/${SEQ}`, uploadedAt: '', uploadError: '', ossPrefix: '' }
  const state = { audits: { [SEQ]: record } }
  const out = await ossUpload(deps, { key: SEQ }, state)
  assert.equal(out.ok, true)
  assert.equal(record.uploadError, '')
  assert.ok(record.uploadedAt !== '', '成功后必须记下上传时间，否则看门狗会一直重传')
  assert.equal(record.ossPrefix, `crwu/audit/${SEQ}`)
})

test('oss-upload refuses a caller-supplied case path that is not in the audit registry', async () => {
  const { deps, commands } = uploadDeps()
  const out = await ossUpload(deps, { casePath: `/cases/${SEQ}`, projectId: 'forged-project' }, { audits: {} })
  assert.equal(out.ok, false)
  assert.match(out.error, /审核记录/)
  assert.equal(commands.some((command) => command.includes(' cp ')), false, '未登记的路径不得触发上传')
})

test('oss-upload explains a missing record path and a disabled OSS', async () => {
  const { deps } = uploadDeps()
  assert.match((await ossUpload(deps, { key: 'missing' }, { audits: {} })).error, /审核记录/)
  assert.match(
    (await ossUpload(deps, { key: SEQ }, { audits: { [SEQ]: { casePath: '', uploadedAt: '', uploadError: '', ossPrefix: '' } } })).error,
    /还没定位到案例目录/,
  )
  const disabled = ossDeps({ manifest: manifestWith({ enabled: false }) })
  assert.match(
    (await ossUpload(disabled.deps, { key: SEQ }, { audits: { [SEQ]: { casePath: '/cases/x', uploadedAt: '', uploadError: '', ossPrefix: '' } } })).error,
    /未启用/,
  )
})

// ── 自动上传 ────────────────────────────────────────────────────────────────

test('maybeAutoUpload skips records that are already uploaded or uploading', async () => {
  const { deps } = uploadDeps()
  const uploaded = { ...normalizeAudit('k', {}), casePath: '/cases/x', uploadedAt: '2026-09-20T00:00:00Z' }
  assert.match((await maybeAutoUpload(deps, uploaded)).error, /无需上传/)
  const inFlight = { ...normalizeAudit('k', {}), casePath: '/cases/x', uploading: true }
  assert.match((await maybeAutoUpload(deps, inFlight)).error, /无需上传/)
})

test('maybeAutoUpload refuses without a case path without stamping a failure', async () => {
  // 「还没有东西可传」不是上传失败：写 uploadError 会让界面给一条尚未出结果的记录挂
  // 「上云失败」徽章。这是相对 legacy 的一处**有意收紧**（见 PORTING.md 差异表）。
  const { deps } = uploadDeps()
  const noPath = { ...normalizeAudit('k', {}), casePath: '' }
  assert.match((await maybeAutoUpload(deps, noPath)).error, /尚未定位案例目录/)
  assert.equal(noPath.uploadError, '', '没有案例目录不算上传失败')

  const missingCase = { ...normalizeAudit('k', {}), casePath: '/cases/gone' }
  const out = await maybeAutoUpload(deps, missingCase)
  assert.equal(out.ok, false)
  assert.match(out.error, /案例目录不可读/)
  assert.equal(missingCase.uploadError, '', '案例目录不可读同样不是上传失败')
  assert.ok(missingCase.uploading !== true, '提前返回后不得留下 uploading，否则再也不会重试')
})

test('maybeAutoUpload uploads and stamps the record', async () => {
  const { deps } = uploadDeps()
  const record = { ...normalizeAudit('k', {}), key: SEQ, casePath: `/cases/${SEQ}` }
  const out = await maybeAutoUpload(deps, record)
  assert.equal(out.ok, true)
  assert.ok(record.uploadedAt !== '')
  assert.equal(record.ossPrefix, `crwu/audit/${SEQ}`)
})

test('runUploadWatch only touches the active or finished records', async () => {
  const { deps } = uploadDeps()
  const running = { ...normalizeAudit('k1', {}), key: 'k1', casePath: `/cases/${SEQ}` }
  const finished = { ...normalizeAudit('k2', {}), key: 'k2', casePath: `/cases/${SEQ}`, ended: true }
  const pending = { ...normalizeAudit('k3', {}), key: 'k3', casePath: `/cases/${SEQ}` }
  const state = { audits: { k1: running, k2: finished, k3: pending }, activeKey: 'k1' }

  const stillPending = await runUploadWatch({ ...deps, state })
  assert.ok(running.uploadedAt !== '', '活动中的那条要传')
  assert.ok(finished.uploadedAt !== '', '已结束的那条要传')
  assert.equal(pending.uploadedAt, '', '既不是活动项、也没结束的不得上传')
  // 剩下那条既不是活动项也没结束 —— 看门狗对它无事可做，所以应当收工；
  // 等它结束时 audit-status 会把它算进来，再启动一轮。
  assert.equal(stillPending, false)
})

test('runUploadWatch reports no pending work once everything is uploaded', async () => {
  const { deps } = uploadDeps()
  const done = { ...normalizeAudit('k', {}), key: 'k', casePath: `/cases/${SEQ}`, uploadedAt: '2026-09-20T00:00:00Z' }
  const pending = await runUploadWatch({ ...deps, state: { audits: { k: done }, activeKey: '' } })
  assert.equal(pending, false, '都传完了就该让看门狗停下')
})

// ── 凭据保存 ────────────────────────────────────────────────────────────────

test('oss-cred-save writes the config, tightens permissions and re-probes', async () => {
  const writes = []
  const { deps, commands } = ossDeps({
    writes,
    shell: (command) => {
      if (command.startsWith('command -v')) return { stdout: '/usr/local/bin/ossutil\n' }
      if (command.includes(' ls ')) return { stdout: 'oss://bkt/obj\n' }
      // 权限收紧之后会**回读模式位**：替身要回答这一条，否则 `verified` 判不出来。
      if (/^stat -[fc] /.test(command)) return { stdout: '600\n' }
      return { stdout: '' }
    },
  })
  const result = await ossCredSave(deps, { accessKeyId: 'AKID1234567890', accessKeySecret: 'SECRET', endpoint: 'oss-cn-x.aliyuncs.com' })
  assert.equal(result.ok, true)
  assert.equal(result.path, '/Users/x/.ossutilconfig')
  assert.equal(result.permission.status, 'verified')
  assert.equal(result.permission.mechanism, 'posix-0600')
  assert.equal(commands.some((command) => command.startsWith('chmod 600')), true, '凭据文件必须收紧到 600')
  // `~/.ossutilconfig` 在**工作区之外**：员工默认的 workspace-write 沙箱下写它会被直接拒绝
  // （实测 `cannot write "C:\Users\<用户>\.ossutilconfig": file access denied under workspace-write mode`）。
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/Users/x/.ossutilconfig')
  assert.equal(writes[0].sandboxPolicy?.mode, 'danger-full-access', '写工作区外的凭据文件必须声明无沙箱')
  assert.equal(writes[0].sandboxPolicy?.workspaceRoot, '/Users/x', '策略要绑 workspaceRoot（DSH 契约）')
  assert.equal(commands.some((command) => /^stat -[fc] /.test(command)), true, '收紧后必须回读模式位')
  const written = writes[0].content
  assert.match(written, /accessKeyID=AKID1234567890/)
  assert.match(written, /accessKeySecret=SECRET/)
  // 返回值里只允许出现脱敏后的 key。
  assert.equal(JSON.stringify({ cred: result.cred }).includes('SECRET'), false)
  assert.equal(result.cred.accessKeyIdMasked, 'AKID****7890')
})

test('P-08/M-04 · 权限回读不是 0600 时，保存**顶层**必须失败（不是"成功但附一条提示"）', async () => {
  // 有的文件系统会**静默忽略** `chmod`：命令退出码 0、模式没变。旧形态回 `ok:true`
  // 只是附一句错误字符串，界面漏看就把"其实没保护住"当成功 —— 用户复查抓到的 P1。
  const writes = []
  const { deps } = ossDeps({
    writes,
    mode: '644',
    shell: (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: '' }),
  })
  const result = await ossCredSave(deps, { accessKeyId: 'AKID1234567890', accessKeySecret: 'SECRET' })
  assert.equal(result.ok, false, '权限没生效就不是保存成功')
  assert.equal(result.permission.status, 'failed')
  assert.match(result.error, /权限/)
  // 已经知道的事实必须一起带回来，员工才知道文件写在哪、下一步该做什么。
  assert.match(result.path, /ossutilconfig$/)
  assert.equal(writes.length >= 1, true, '文件本身是写下去了（失败的是权限后置条件）')
})

test('oss-cred-save 不带 endpoint 时回落到部署配置（YAML 的 oss.protected.endpoint）', async () => {
  const writes = []
  const { deps } = ossDeps({
    writes,
    shell: (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: '' }),
  })
  // 新客户端只送 ID/Secret（表单已删掉 endpoint）；缺了它必须由 Host 从部署配置补，
  // 否则写进 ~/.ossutilconfig 的配置没有 endpoint，后续 upload/ls 全要显式带参。
  deps.manifest.oss.endpoint = 'oss-from-deploy.example.com'
  const result = await ossCredSave(deps, { accessKeyId: 'AK', accessKeySecret: 'S' })
  assert.equal(result.ok, true)
  assert.match(
    writes[0].content,
    /endpoint=oss-from-deploy\.example\.com/,
    '缺 endpoint 时必须回落部署配置，而不是写一条没有 endpoint 的配置',
  )
})

test('oss-cred-save refuses empty and newline-carrying credentials', async () => {
  const { deps, commands } = ossDeps({ shell: ossutilOnPath })
  assert.match((await ossCredSave(deps, { accessKeyId: '', accessKeySecret: 'x' })).error, /都不能为空/)
  assert.match((await ossCredSave(deps, { accessKeyId: 'a\nb', accessKeySecret: 'x' })).error, /不能包含换行/)
  assert.equal(commands.some((command) => command.includes('chmod')), false, '被拒绝时不写文件、也不 chmod')
})

test('buildConfigContent omits an empty endpoint and includes an STS token when given', () => {
  const plain = buildConfigContent({ accessKeyId: 'A', accessKeySecret: 'S', stsToken: '', endpoint: '' })
  assert.equal(plain.content.includes('endpoint='), false)
  assert.equal(plain.content.includes('stsToken='), false)
  assert.match(plain.content, /^\[Credentials\]/)
  assert.match(plain.content, /language=CH/)

  const sts = buildConfigContent({ accessKeyId: 'A', accessKeySecret: 'S', stsToken: 'T', endpoint: 'ep' })
  assert.match(sts.content, /endpoint=ep/)
  assert.match(sts.content, /stsToken=T/)
})

test('the shipped default manifest keeps OSS upload off until a bucket is configured', () => {
  // 内置默认清单不能带死 bucket：分发到别的组织时会把交付件传到错的地方。
  assert.equal(DEFAULT_MANIFEST.oss.bucket, '')
  assert.equal(DEFAULT_MANIFEST.oss.prefix, 'crwu/audit')
  assert.equal(DEFAULT_MANIFEST.oss.linkMode, 'signed', '内部材料默认走签名 URL')
})

// ── oss-link 的 `open: false`（2026-10-11 用户实测"浏览器很慢"）────────────────
//
// 这条链路原来是两次串行的提权进程：`ossutil sign` 出链接、`open <url>` 拉起浏览器。
// 现在客户端可以只要链接（`open: false`），自己去 `window.open`（桌面端主进程转
// `shell.openExternal` → 系统默认浏览器）—— 宿主这边**一个浏览器进程都不该起**。

test('oss-link with open:false returns the url without launching a browser', async () => {
  const { deps, commands } = ossDeps({ shell: signedStub })
  const result = await ossLink(deps, { key: `crwu/audit/${SEQ}/审核意见.${SEQ}.html`, open: false })
  assert.equal(result.ok, true)
  assert.match(result.url, /^https:\/\//, '链接照旧要有（客户端拿它去开）')
  assert.equal(result.opened, false, '没说"宿主打开了"')
  assert.equal(commands.some((command) => command.includes(' sign ')), true, '签名照旧要做')
  // 判据：不许出现任何"打开外部程序"的命令（macOS 的 open / Windows 的 start / Linux 的 xdg-open）。
  assert.equal(commands.some((command) => /(^|\s)(open|start|xdg-open)\s/.test(command)), false,
    `open:false 不该起浏览器进程：${commands.join(' | ')}`)
})

test('oss-link keeps launching the browser by default (old clients unaffected)', async () => {
  const { deps, commands } = ossDeps({ shell: signedStub })
  const result = await ossLink(deps, { key: `crwu/audit/${SEQ}/审核意见.${SEQ}.html` })
  assert.equal(result.ok, true)
  assert.equal(result.opened, true, '缺省仍然是"宿主打开"（旧界面不会因此变成点了没反应）')
  assert.equal(commands.some((command) => /(^|\s)(open|start|xdg-open)\s/.test(command)), true)
})
