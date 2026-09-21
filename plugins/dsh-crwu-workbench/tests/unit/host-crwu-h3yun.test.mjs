/**
 * 第 2 层前半（crwu 白名单执行器 / 氚云应答解析 / oss 凭据）的单元测试。
 *
 * 这一层是安全边界所在：白名单判断、检索词注入、凭据不回显 —— 每条都要能反向失败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { escalationAllowed, keychainBlocked, runCrwu, describeFailure } = await import(
  new URL('src/host/crwu/run.ts', ROOT).href
)
const { rowsFromEnvelope, totalFromEnvelope, buildQueryFilter, rowToTask, seqNoFromKey, pickForm } = await import(
  new URL('src/host/h3yun/records.ts', ROOT).href
)
const { labelOf, maskKey, pick } = await import(new URL('src/host/h3yun/fields.ts', ROOT).href)
const { SEQ_NO_FULL, RECORDS_STDOUT_MAX, H3YUN_FIELDS } = await import(new URL('src/host/h3yun/consts.ts', ROOT).href)
const { parseOssConfig, buildOssConfig, readOssCred, ossConfigPath, resolveConfigPath } = await import(
  new URL('src/host/oss/cred.ts', ROOT).href
)

// ── crwu 执行器 ─────────────────────────────────────────────────────────────

test('runCrwu refuses anything that is not the crwu binary', async () => {
  const ctx = { get: () => undefined }
  for (const argv of [[], ['sh', '-c', 'ls'], ['crwu2'], ['/usr/bin/crwu']]) {
    const run = await runCrwu(ctx, argv, { trusted: true })
    assert.equal(run.ok, false)
    assert.match(run.error, /缺少命令|只允许调用 crwu/)
  }
})

test('runCrwu only escalates whitelisted h3yun subcommands', async () => {
  // 白名单必须是显式枚举：氚云将来加子命令时默认落在「拒绝」侧。
  assert.equal(escalationAllowed(['crwu', 'h3yun', 'session', 'login']), true)
  assert.equal(escalationAllowed(['crwu', 'h3yun', 'session', 'logout']), false)
  assert.equal(escalationAllowed(['crwu', 'h3yun', 'records', 'list']), true)
  assert.equal(escalationAllowed(['crwu', 'h3yun', 'forms', 'search']), true)
  assert.equal(escalationAllowed(['crwu', 'audit', 'run']), false)
  assert.equal(escalationAllowed(['crwu', 'h3yun', 'admin']), false)
  assert.equal(escalationAllowed(['crwu']), false)
})

test('runCrwu rejects an explicit escalation it is not allowed to make', async () => {
  const ctx = { get: () => undefined }
  const run = await runCrwu(ctx, ['crwu', 'audit', 'run'], { trusted: true, escalate: true })
  assert.equal(run.ok, false)
  assert.match(run.error, /不允许无沙箱执行/)
})

test('runCrwu 里白名单命令自己声明权限（员工零配置），非白名单给最小权限', async () => {
  const specs = []
  const ctx = {
    get: (name) => (name === 'shell'
      ? {
          resolve: (request) => { specs.push(request); return request },
          async run() {
            return { exitCode: 0, timedOut: false, stdout: { text: '{}', truncated: false }, stderr: { text: '', truncated: false } }
          },
        }
      : undefined),
  }
  // 未授权：白名单命令也**不提权**（授权就是「允许读本机凭据」的同意；没授权时环境自检会硬阻塞）。
  await runCrwu(ctx, ['crwu', 'h3yun', 'records', 'list'], { trusted: false, platform: 'darwin-arm64', workdir: '/cases/x' })
  assert.equal(specs[0].sandboxPolicy, undefined, '未授权不得无沙箱执行')
  assert.equal(specs[0].command, 'crwu h3yun records list')

  // 已授权 + 白名单：声明所需权限（读钥匙串必须在沙箱外）。
  specs.length = 0
  await runCrwu(ctx, ['crwu', 'h3yun', 'records', 'list'], { trusted: true, platform: 'darwin-arm64', workdir: '/cases/x' })
  assert.deepEqual(specs[0].sandboxPolicy, { mode: 'danger-full-access', workspaceRoot: '/cases/x' })

  // 非白名单：即使已授权也给最小权限。
  specs.length = 0
  await runCrwu(ctx, ['crwu', 'version'], { trusted: true, platform: 'darwin-arm64', workdir: '/cases/x' })
  assert.equal(specs[0].sandboxPolicy, undefined, '非白名单命令即使已授权也不提权（能给最小权限就给最小）')

  // 拿不到会话工作区时不能直接失败（提权请求必须带 workspaceRoot）→ 退回沙箱执行。
  specs.length = 0
  const fallback = await runCrwu(ctx, ['crwu', 'h3yun', 'records', 'list'], { trusted: true, platform: 'darwin-arm64' })
  assert.equal(specs[0].sandboxPolicy, undefined, '没有 workspaceRoot 就退回沙箱')
  assert.equal(fallback.ok, true, '不能因为拿不到工作区就把命令判失败')
})

test('runCrwu quotes arguments and passes the big stdout budget through', async () => {
  const specs = []
  const ctx = {
    get: (name) => (name === 'shell'
      ? {
          resolve: (request) => { specs.push(request); return request },
          async run() {
            return { exitCode: 0, timedOut: false, stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false } }
          },
        }
      : undefined),
  }
  await runCrwu(ctx, ['crwu', 'h3yun', 'records', 'list', '--filter', "SeqNo Equal '2026-1-X1'"], {
    trusted: true,
    platform: 'darwin-arm64',
    workdir: '/cases/x',
    stdoutMaxBytes: RECORDS_STDOUT_MAX,
  })
  assert.equal(specs[0].stdoutMaxBytes, RECORDS_STDOUT_MAX)
  assert.match(specs[0].command, /^crwu h3yun records list --filter 'SeqNo Equal '\\''2026-1-X1'\\'''/)
})

test('keychainBlocked recognizes the credential-store failures', () => {
  assert.equal(keychainBlocked({ stderr: 'failed to access credential store' }), true)
  assert.equal(keychainBlocked({ stdout: 'auto-refresh failed' }), true)
  assert.equal(keychainBlocked({ stderr: 'exit status 161' }), true)
  assert.equal(keychainBlocked({ stderr: 'network unreachable' }), false)
  assert.equal(keychainBlocked({}), false)
})

test('runCrwu offers escalation when the keychain blocked a sandboxed run', async () => {
  const ctx = {
    get: (name) => (name === 'shell'
      ? {
          resolve: (request) => request,
          async run() {
            return { exitCode: 1, timedOut: false, stdout: { text: '', truncated: false }, stderr: { text: 'failed to access credential store', truncated: false } }
          },
        }
      : undefined),
  }
  const run = await runCrwu(ctx, ['crwu', 'h3yun', 'records', 'list'], { trusted: false, platform: 'darwin-arm64', workdir: '/cases/x' })
  assert.equal(run.ok, false)
  assert.equal(run.keychainBlocked, true)
  assert.equal(run.escalateAvailable, true, '界面据此显示「去授权」而不是干瞪眼')
  // 已经记住授权的人不该再被反复打扰（这条是「trusted 只作为优化保留」的落地断言）。
  const trustedRun = await runCrwu(ctx, ['crwu', 'h3yun', 'records', 'list'], { trusted: true, platform: 'darwin-arm64', workdir: '/cases/x' })
  assert.equal(trustedRun.escalateAvailable, false)
})

test('describeFailure prefers stderr, then error, then the exit code', () => {
  assert.equal(describeFailure({ stderr: 'boom', error: 'x', exitCode: 1 }), 'boom')
  assert.equal(describeFailure({ stderr: '  ', error: 'inner', exitCode: 1 }), 'inner')
  assert.equal(describeFailure({ stderr: '', error: '', exitCode: 7 }), '命令退出码 7')
})

// ── 氚云应答解析 ────────────────────────────────────────────────────────────

test('rowsFromEnvelope finds rows in every shape h3yun returns', () => {
  assert.deepEqual(rowsFromEnvelope([1, 2]), [1, 2])
  assert.deepEqual(rowsFromEnvelope({ data: [1] }), [1])
  assert.deepEqual(rowsFromEnvelope({ data: { returnData: [1] } }), [1])
  assert.deepEqual(rowsFromEnvelope({ data: { rows: [1] } }), [1])
  assert.deepEqual(rowsFromEnvelope({ data: { items: [1] } }), [1])
  // 认不出的形状回空数组，而不是把对象当行用。
  assert.deepEqual(rowsFromEnvelope({ data: { weird: 1 } }), [])
  assert.deepEqual(rowsFromEnvelope(null), [])
})

test('totalFromEnvelope reads the count or reports zero', () => {
  assert.equal(totalFromEnvelope({ data: { dataCount: 20 } }), 20)
  assert.equal(totalFromEnvelope({ data: { total: 5 } }), 5)
  assert.equal(totalFromEnvelope({ data: { count: 3 } }), 3)
  assert.equal(totalFromEnvelope({ data: {} }), 0)
  assert.equal(totalFromEnvelope({ data: { dataCount: 'many' } }), 0)
})

test('buildQueryFilter distinguishes exact, fuzzy and unsafe queries', () => {
  assert.deepEqual(buildQueryFilter(''), { expr: '', mode: '' })
  assert.deepEqual(buildQueryFilter('   '), { expr: '', mode: '' })
  assert.deepEqual(buildQueryFilter('2026-301705-LX10170'), { expr: "SeqNo Equal '2026-301705-LX10170'", mode: 'equal' })
  assert.deepEqual(buildQueryFilter('301705'), { expr: "SeqNo Contains '301705'", mode: 'contains' })
  assert.deepEqual(buildQueryFilter('301705-LX10170'), { expr: "SeqNo Contains '301705-LX10170'", mode: 'contains' })
  // 含引号/反斜杠一律拒绝：不能拼进氚云表达式。
  assert.deepEqual(buildQueryFilter("301705'"), { expr: '', mode: 'invalid' })
  assert.deepEqual(buildQueryFilter('301705\\'), { expr: '', mode: 'invalid' })
})

test('SEQ_NO_FULL only matches a full serial number', () => {
  assert.equal(SEQ_NO_FULL.test('2026-301705-LX10170'), true)
  assert.equal(SEQ_NO_FULL.test('2026-301705-LX10170-AB12'), true)
  assert.equal(SEQ_NO_FULL.test('301705'), false)
  assert.equal(SEQ_NO_FULL.test('2026-301705'), false)
})

test('rowToTask maps h3yun codes to panel fields and tolerates object values', () => {
  const task = rowToTask({
    ObjectId: 'abcdefgh12345678',
    Name: '某项目报告',
    [H3YUN_FIELDS.project]: '某某项目',
    [H3YUN_FIELDS.reviewLevel]: { label: '二级复核' },
    [H3YUN_FIELDS.reviewState]: '待复核',
    [H3YUN_FIELDS.currentNode]: { name: '审核岗' },
    SeqNo: '2026-301705-LX10170',
    Status: 1,
    Status_Name: '进行中',
    ModifiedTime: '2026-09-20 10:00',
  })
  assert.equal(task.name, '某项目报告')
  assert.equal(task.project, '某某项目')
  assert.equal(task.reviewLevel, '二级复核')
  assert.equal(task.reviewState, '待复核')
  assert.equal(task.currentNode, '审核岗')
  assert.equal(task.status, '1')
  assert.equal(task.idTail, 'efgh12345678'.slice(-8))
})

test('rowToTask never shows [object Object] and invents no title', () => {
  const task = rowToTask({ Name: null, ObjectId: 42 })
  assert.equal(task.name, '（无标题）')
  assert.equal(task.id, '42')
  assert.equal(task.project, '')
  const weird = rowToTask({ F0000158: { nested: true } })
  assert.equal(weird.reviewLevel, '')
})

test('labelOf collapses h3yun value shapes to text', () => {
  assert.equal(labelOf('x'), 'x')
  assert.equal(labelOf(7), '7')
  assert.equal(labelOf(true), 'true')
  assert.equal(labelOf({ label: 'L' }), 'L')
  assert.equal(labelOf({ name: 'N' }), 'N')
  assert.equal(labelOf({ value: 'V' }), 'V')
  assert.equal(labelOf({ title: 'T' }), 'T')
  assert.equal(labelOf({ other: 1 }), '')
  assert.equal(labelOf(null), '')
})

test('pick takes the first non-null candidate', () => {
  assert.equal(pick({ a: null, b: 2 }, ['a', 'b']), 2)
  assert.equal(pick({ a: '' }, ['a']), '')
  assert.equal(pick(null, ['a']), undefined)
})

test('seqNoFromKey recovers the serial number from an object key', () => {
  assert.equal(seqNoFromKey('crwu/audit/2026-301705-LX10170/审核意见.html', 'crwu/audit'), '2026-301705-LX10170')
  assert.equal(seqNoFromKey('/crwu/audit/2026-301705-LX10170/审核意见.html', '/crwu/audit/'), '2026-301705-LX10170')
  assert.equal(seqNoFromKey('2026-301705-LX10170/x.html', ''), '2026-301705-LX10170')
  assert.equal(seqNoFromKey('crwu/audit/other/x.html', 'crwu/audit'), '')
  assert.equal(seqNoFromKey('', 'crwu/audit'), '')
})

test('pickForm prefers an exact display-name match, then any form node', () => {
  const rows = [
    { displayName: '报价单', nodeType: '200', code: 'A' },
    { displayName: '报告审核', nodeType: '210', code: 'B' },
  ]
  assert.deepEqual(pickForm(rows, '报告审核'), { code: 'B', name: '报告审核' })
  assert.deepEqual(pickForm(rows, '不存在的表单'), { code: 'A', name: '报价单' })
  assert.equal(pickForm([{ displayName: '别的', nodeType: '999' }], '报告审核'), null)
  assert.equal(pickForm([], '报告审核'), null)
})

// ── OSS 凭据 ────────────────────────────────────────────────────────────────

test('parseOssConfig reads the ini-style file and ignores comments', () => {
  const config = parseOssConfig('# comment\n[Credentials]\nlanguage=CH\nendpoint=oss-cn-x.aliyuncs.com\naccessKeyID=AKID\naccessKeySecret=SECRET\n')
  assert.equal(config.language, 'CH')
  assert.equal(config.endpoint, 'oss-cn-x.aliyuncs.com')
  assert.equal(config.accesskeyid, 'AKID')
  assert.equal(config.accesskeysecret, 'SECRET')
})

test('buildOssConfig refuses a half-filled credential pair', () => {
  assert.equal(buildOssConfig({ accessKeyId: 'AK', accessKeySecret: '' }).ok, false)
  assert.equal(buildOssConfig({ accessKeyId: '', accessKeySecret: 'SK' }).ok, false)
  const built = buildOssConfig({ accessKeyId: 'AK', accessKeySecret: 'SK', endpoint: 'ep', stsToken: 'STS' })
  assert.equal(built.ok, true)
  assert.match(built.content, /\[Credentials\]/)
  assert.match(built.content, /accessKeyID=AK/)
  assert.match(built.content, /accessKeySecret=SK/)
  assert.match(built.content, /stsToken=STS/)
  assert.match(built.content, /language=CH/)
})

test('readOssCred returns a masked view and never the secret', async () => {
  const ctx = {
    get: (name) => (name === 'fs'
      ? {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat() { return { type: 'file' } },
          async readText() {
            return 'accessKeyID=AKID1234567890\naccessKeySecret=TOPSECRET\nendpoint=oss-cn-x.aliyuncs.com\n'
          },
        }
      : undefined),
  }
  const view = await readOssCred(ctx, '/Users/x')
  assert.equal(view.exists, true)
  assert.equal(view.endpoint, 'oss-cn-x.aliyuncs.com')
  assert.equal(view.accessKeyIdMasked, 'AKID****7890')
  assert.equal(view.hasSecret, true)
  assert.equal(view.hasSts, false)
  assert.equal(JSON.stringify(view).includes('TOPSECRET'), false, '脱敏视图里绝不能带出 secret')
})

test('readOssCred reports a missing file without throwing', async () => {
  const ctx = {
    get: (name) => (name === 'fs'
      ? { async resolve(path) { return { targetKey: path, displayPath: path } }, async stat() { return undefined } }
      : undefined),
  }
  const view = await readOssCred(ctx, '/Users/x')
  assert.equal(view.exists, false)
  assert.equal(view.path, '/Users/x/.ossutilconfig')
  const noFs = await readOssCred({ get: () => undefined }, '/Users/x')
  assert.equal(noFs.exists, false)
})

test('ossConfigPath and resolveConfigPath follow the execution world home', () => {
  assert.equal(ossConfigPath('/Users/x/'), '/Users/x/.ossutilconfig')
  assert.equal(ossConfigPath(''), '~/.ossutilconfig')
  assert.equal(resolveConfigPath('/Users/x', 'darwin-arm64', '~/.ossutilconfig'), '/Users/x/.ossutilconfig')
  assert.equal(resolveConfigPath('/Users/x', 'darwin-arm64', '/abs/cfg'), '/abs/cfg')
})

test('maskKey never leaks a short key', () => {
  assert.equal(maskKey('AKID1234567890'), 'AKID****7890')
  assert.equal(maskKey('short'), '****')
  assert.equal(maskKey(''), '')
})
