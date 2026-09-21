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

const { ossIndex, ossResult, ossLink, ossUpload, ossCredSave, uploadArtifacts, buildConfigContent } = await import(
  new URL('src/host/oss/ops.ts', ROOT).href
)
const { maybeAutoUpload, runUploadWatch } = await import(new URL('src/host/oss/auto.ts', ROOT).href)
const { DEFAULT_MANIFEST } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)
const { normalizeManifest } = await import(new URL('src/host/environment/manifest.ts', ROOT).href)
const { normalizeAudit } = await import(new URL('src/host/state/registry.ts', ROOT).href)

const SEQ = '2026-301705-LX10170'

function manifestWith(patch = {}) {
  return normalizeManifest({
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
          async run(spec) {
            const out = patch.shell === undefined ? { stdout: '' } : patch.shell(spec.command)
            return {
              exitCode: out.exitCode ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: out.stdout ?? '', truncated: out.truncated === true },
              stderr: { text: out.stderr ?? '', truncated: false },
            }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) { return (patch.files ?? {})[target.targetKey] === undefined ? undefined : { type: 'file' } },
          async readText(target) { return (patch.files ?? {})[target.targetKey] ?? '' },
          async writeText(target, content) {
            patch.writes?.push({ path: target.targetKey, content })
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
      manifest: patch.manifest ?? manifestWith(),
      platform: 'darwin-arm64',
      home: '/Users/x',
      workdir: async () => '/cases/session',
    },
  }
}

/** 让 resolveOssutil 在 PATH 上找到 ossutil。 */
const ossutilOnPath = (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: '' })

// ── oss-index ───────────────────────────────────────────────────────────────

test('oss-index groups objects and reports the count', async () => {
  const listing = [
    `oss://bkt/crwu/audit/${SEQ}/审核意见.${SEQ}.html`,
    `oss://bkt/crwu/audit/${SEQ}/审核结果.${SEQ}.json`,
    'Object Number is: 2',
  ].join('\n')
  const { deps, commands } = ossDeps({ shell: (command) => (command.startsWith('command -v') ? { stdout: '/usr/local/bin/ossutil\n' } : { stdout: listing }) })
  const result = await ossIndex(deps)
  assert.equal(result.ok, true)
  assert.equal(result.count, 2, '汇总行不能被当成对象')
  assert.deepEqual(Object.keys(result.items), [SEQ])
  // 没有 -r：ossutil 不接受它，传了会被直接拒绝。
  const ls = commands.find((command) => command.includes(' ls ')) ?? ''
  assert.match(ls, /--short-format/)
  assert.equal(ls.includes(' -r'), false)
})

test('oss-index refuses when OSS is disabled, has no bucket, or has no ossutil', async () => {
  const disabled = ossDeps({ manifest: manifestWith({ enabled: false }) })
  assert.match((await ossIndex(disabled.deps)).error, /enabled/)

  const noBucket = ossDeps({ manifest: manifestWith({ bucket: '' }) })
  assert.match((await ossIndex(noBucket.deps)).error, /bucket/)

  const noOssutil = ossDeps({ shell: () => ({ stdout: '' }) })
  assert.match((await ossIndex(noOssutil.deps)).error, /ossutil/)
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
      return { stdout: '' }
    },
  })
  const result = await ossCredSave(deps, { accessKeyId: 'AKID1234567890', accessKeySecret: 'SECRET', endpoint: 'oss-cn-x.aliyuncs.com' })
  assert.equal(result.ok, true)
  assert.equal(result.path, '/Users/x/.ossutilconfig')
  assert.equal(result.chmodOk, true)
  assert.equal(commands.some((command) => command.startsWith('chmod 600')), true, '凭据文件必须收紧到 600')
  const written = writes[0].content
  assert.match(written, /accessKeyID=AKID1234567890/)
  assert.match(written, /accessKeySecret=SECRET/)
  // 返回值里只允许出现脱敏后的 key。
  assert.equal(JSON.stringify({ cred: result.cred }).includes('SECRET'), false)
  assert.equal(result.cred.accessKeyIdMasked, 'AKID****7890')
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
