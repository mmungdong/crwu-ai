/**
 * 估值资料的 **Python 提取后端**与 `crwu_valuation_file_extract`（协议 32）单元测试。
 *
 * 这一层要钉死的不变量（每条都对应一个真实会发生的错）：
 *
 * 1. 脚本必须**落到案例目录里**再执行 —— `python.script.run` 只接受案例内的脚本路径，
 *    Host 自己也不许开后门（否则"模型提交任意可执行路径"的边界就白设了）；
 * 2. argv 逐个传参、不经 shell（`;`、`$()` 都只是字面量）；
 * 3. 脚本报 `ok:false`（缺 PDF 库 / 无文本层 / 旧版 .doc）→ **抛错**，由编排层记成
 *    "未解析 + 能力缺口"，**绝不返回半截字段**；
 * 4. 结果文件读不到 / 不是合法 JSON → 同样抛错（那是脚本或沙箱的问题，不是"读到了空内容"）；
 * 5. 字段表只收**字符串**值（下游要的是可显示、可比对的原文）；
 * 6. 工具只回紧凑摘要，完整结果落盘 —— 一张明细表几百行不该进模型上下文；
 * 7. 一份都没解析出来时 `ok:false` + `capability-gap`，不说成"成功但结果为空"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { pythonFileExtractor } = await import(new URL('src/host/domains/report-evaluation/intake/python-extractor.ts', ROOT).href)
const { runExtraction } = await import(new URL('src/host/domains/report-evaluation/intake/extract.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { valuationFileExtractTools } = await import(new URL('src/host/tools/report-evaluation/file-extract.ts', ROOT).href)
const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { CRWU_BUSINESS_TOOLS, REQUIRED_AUDIT_TOOLS } = await import(new URL('src/host/tools/report-audit/consts.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261012-120000-ef56'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`
const SCRIPT_SRC = '/pkg/skills/biz/crwu-biz-valuation-realestate/scripts/extract_files.py'
const SCRIPT_BODY = '# fake extractor\n'
const PDF = `${CASE_DIR}/材料-源/估值报告.pdf`

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
}

/** 内存 fs：只支持 `resolve` / `stat` / `readText` / `writeText` / `contains`。 */
function makeFs({ files = {}, dirs = [] } = {}) {
  const fileMap = new Map(Object.entries(files))
  const dirSet = new Set([WORKSPACE, CASE_DIR, `${CASE_DIR}/材料-源`, `${CASE_DIR}/提取结果`, ...dirs])
  return {
    files: fileMap, dirs: dirSet,
    async resolve(path) { return { targetKey: String(path), displayPath: String(path) } },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/, '')
      if (dirSet.has(key)) return { type: 'directory', version: 'v' }
      return fileMap.has(target.targetKey) ? { type: 'file', size: String(fileMap.get(target.targetKey)).length, version: 'v' } : undefined
    },
    async readText(target) { return fileMap.get(target.targetKey) ?? '' },
    async writeText(target, content) { fileMap.set(target.targetKey, content); return { operation: 'create', version: 'v' } },
    contains(parent, child) {
      const p = String(parent.displayPath).replace(/[\\/]+$/, '')
      const c = String(child.displayPath)
      return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`)
    },
  }
}

/** 记录每次命令的 shell 替身；`route` 决定输出。 */
function makeShell(route) {
  const commands = []
  return {
    commands,
    service: {
      resolve: (request) => request,
      async execute(request) {
        commands.push(request)
        const spec = route(request)
        const stdout = spec?.stdout ?? ''
        const exitCode = spec?.exitCode ?? 0
        return {
          result: async () => ({
            exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
            stdout: { text: stdout, truncated: false },
            stderr: { text: spec?.stderr ?? '', truncated: false },
          }),
        }
      },
    },
  }
}

const PYTHON_STUB = {
  cached: () => null,
  check: async () => ({
    ok: true, state: 'ok', path: '/dsh/python/bin/python3', versionText: '3.12.4',
    distributions: { openpyxl: '3.1.5' }, missingPackages: [], error: '', source: 'stub',
  }),
}

function makeState() {
  const state = createWorkbenchState(CONFIG)
  return {
    ...state,
    localAccess: grantedConsent(),
    workspaceChosen: true, workspaceMissing: false,
    workspaceId: 'w1', workspacePath: WORKSPACE, workspaceTitle: '工作区',
    caseRoot: WORKSPACE,
  }
}

function makeCtx(fs, shell) {
  return {
    get(name) {
      if (name === 'fs') return fs
      if (name === 'shell') return shell.service
      return undefined
    },
  }
}

function makeDeps({ fs, shell, state = makeState(), scopes = new ValuationScopes(), python = PYTHON_STUB } = {}) {
  const ctx = makeCtx(fs, shell)
  const { access } = makeTestAccess(ctx, { state })
  return {
    ctx, fs, shell, state, scopes,
    deps: {
      ctx, config: { ...CONFIG }, state, access,
      discussionScopes: createDiscussionScopeRegistry(),
      valuationScopes: scopes,
      python,
      world: {
        platform: async () => 'darwin-arm64',
        home: async () => '/Users/x',
        workdir: async () => WORKSPACE,
        cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
      },
    },
  }
}

function openValuation(deps, sessionId = 'valuation-session-1') {
  deps.valuationScopes.open({
    valuationId: VALUATION_ID, casePath: CASE_DIR, sessionId,
    workspaceId: 'w1', workspacePath: WORKSPACE,
    snapshot: {
      valuationId: VALUATION_ID, method: 'market', baseDate: '', supplementalPrompt: '',
      digest: 'sha256:x', frozenAt: '2026-10-12T00:00:00.000Z', files: [],
    },
    openedAt: 1,
  })
  return sessionId
}

function execOf(sessionId, signal = new AbortController().signal) {
  return {
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'),
    name: VALUATION_TOOL_NAMES.fileExtract, arguments: {}, signal,
    agent: { id: sessionId }, deferContext() {}, concludeTurn() {},
  }
}

/**
 * 从 POSIX 引号命令里取出 argv。
 *
 * `shellInvoke()` 产出的是**一条命令字符串**（不是 argv 数组）—— 每个参数都被单引号包起来，
 * 所以这里按引号切分即可（测试不引入 shell 解析器）。这本身就是一条断言：
 * 参数只能作为**字面量**出现，不会有 `$(...)` / `;` 被解释的余地。
 */
function argvOf(command) {
  return [...String(command).matchAll(/'([^']*)'/g)].map((match) => match[1])
}

/** 脚本输出内容（写进结果文件的那一份 JSON）。 */
function payload(overrides = {}) {
  return JSON.stringify({
    ok: true, error: '', fileName: '估值报告.pdf', fileType: 'pdf',
    text: '坐落：某路 1 号', tables: [], images: [], extractedFields: { 坐落: '某路 1 号' },
    warnings: [], capabilityGaps: [], ...overrides,
  })
}

/**
 * 一个"脚本会写结果文件"的 shell：`extract_files.py <in> <out>` 时把 `body` 写进 out。
 *
 * 用真实 fs 替身呈现（脚本写文件、Host 再读回来），而不是让 Host 直接拿到内容 ——
 * 中间那一步文件读写正是要验证的东西。
 */
function shellWritingPayload(fs, body, { exitCode = 0, stderr = '' } = {}) {
  return makeShell((request) => {
    const argv = argvOf(request.command)
    if (argv.some((item) => item.endsWith('extract_files.py'))) fs.files.set(String(argv[2]), body)
    return { stdout: '', exitCode, stderr }
  })
}

// ── 后端：落脚本、传 argv、映射结果 ─────────────────────────────────────────

test('后端：脚本**落到案例目录里**再执行，argv 逐个传参（脚本路径/输入/输出）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const shell = shellWritingPayload(fs, payload())
  const { deps } = makeDeps({ fs, shell })
  const extractor = pythonFileExtractor({
    ctx: deps.ctx, access: deps.access, python: deps.python,
    world: { platform: () => deps.world.platform() },
    casePath: CASE_DIR, sourceScriptPath: SCRIPT_SRC, readSource: async () => SCRIPT_BODY,
  })

  const result = await extractor.extract({ path: PDF, fileName: '估值报告.pdf', kind: 'pdf' })
  assert.equal(fs.files.get(`${CASE_DIR}/scripts/extract_files.py`), SCRIPT_BODY, '脚本必须先落到案例目录')
  assert.equal(result.text, '坐落：某路 1 号')
  assert.deepEqual(result.extractedFields, { 坐落: '某路 1 号' })

  const run = shell.commands.find((request) => String(request.command).includes('extract_files.py'))
  assert.ok(run, '必须以脚本路径为命令执行')
  assert.deepEqual(argvOf(run.command), [
    `${CASE_DIR}/scripts/extract_files.py`, PDF, `${CASE_DIR}/提取结果/提取-估值报告.pdf.json`,
  ], 'argv 第一个是案例内脚本路径，然后是输入与输出')
})

test('后端：脚本报 ok:false → 抛错（绝不返回半截字段）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const body = payload({
    ok: false, text: '', extractedFields: { 坐落: '不该出现' },
    capabilityGaps: ['PDF 无文本层，需要 OCR'],
  })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })
  const extractor = pythonFileExtractor({
    ctx: deps.ctx, access: deps.access, python: deps.python,
    world: { platform: () => deps.world.platform() },
    casePath: CASE_DIR, sourceScriptPath: SCRIPT_SRC, readSource: async () => SCRIPT_BODY,
  })

  await assert.rejects(
    () => extractor.extract({ path: PDF, fileName: '估值报告.pdf', kind: 'pdf' }),
    /OCR/,
    '缺口文案要带出来（否则上层只剩一句"读不出来"）',
  )
})

test('a missing PDF reader is a structured format capability failure', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const body = payload({
    ok: false, text: '', extractedFields: {}, capabilityGaps: ['合成：PDF 文本库未配置'],
    capabilities: { pdfText: false, pdfRender: false, imageOcr: false },
    capabilityProbe: { pdfTextLibrary: '', rasterizer: '' },
  })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })
  const extractor = pythonFileExtractor({
    ctx: deps.ctx, access: deps.access, python: deps.python,
    world: { platform: () => deps.world.platform() },
    casePath: CASE_DIR, sourceScriptPath: SCRIPT_SRC, readSource: async () => SCRIPT_BODY,
  })
  await assert.rejects(
    () => extractor.extract({ path: PDF, fileName: '估值报告.pdf', kind: 'pdf' }),
    (error) => error.kind === 'environment' && error.scope === 'format'
      && error.format === '.pdf' && error.state === 'missing',
  )
})

test('后端：结果文件缺失 / 不是合法 JSON → 抛错（不是"读到了空内容"）', async () => {
  for (const [body, pattern] of [[null, /boom|结果文件/], ['{ 不是 json', /合法 JSON/]]) {
    const fs = makeFs({ files: { [PDF]: 'PDF' } })
    const shell = body === null
      ? makeShell(() => ({ stdout: '', exitCode: 1, stderr: 'python: boom' }))
      : shellWritingPayload(fs, body)
    const { deps } = makeDeps({ fs, shell })
    const extractor = pythonFileExtractor({
      ctx: deps.ctx, access: deps.access, python: deps.python,
      world: { platform: () => deps.world.platform() },
      casePath: CASE_DIR, sourceScriptPath: SCRIPT_SRC, readSource: async () => SCRIPT_BODY,
    })
    await assert.rejects(() => extractor.extract({ path: PDF, fileName: '估值报告.pdf', kind: 'pdf' }), pattern)
  }
})

test('后端：字段表只收字符串值（别的形状丢弃，不猜测）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const body = payload({ extractedFields: { 坐落: '某路 1 号', 面积: 88, 嵌套: { a: 1 }, 空键: '' } })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })
  const extractor = pythonFileExtractor({
    ctx: deps.ctx, access: deps.access, python: deps.python,
    world: { platform: () => deps.world.platform() },
    casePath: CASE_DIR, sourceScriptPath: SCRIPT_SRC, readSource: async () => SCRIPT_BODY,
  })
  const result = await extractor.extract({ path: PDF, fileName: '估值报告.pdf', kind: 'pdf' })
  // 数字被 `text()` 收窄成字符串是刻意的（原文可比对）；空值等于"没读到"，直接不出现。
  assert.deepEqual(result.extractedFields, { 坐落: '某路 1 号', 面积: '88', 嵌套: '[object Object]' })
})

test('后端：包内脚本路径解析不到时抛错（插件包不完整，不是"没有资料"）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const { deps } = makeDeps({ fs, shell: makeShell(() => ({ stdout: '' })) })
  const extractor = pythonFileExtractor({
    ctx: deps.ctx, access: deps.access, python: deps.python,
    world: { platform: () => deps.world.platform() },
    casePath: CASE_DIR, sourceScriptPath: '', readSource: async () => '',
  })
  await assert.rejects(() => extractor.extract({ path: PDF, fileName: 'x.pdf', kind: 'pdf' }), /找不到技能脚本/)
})

test('后端：DSH Python 不可用时抛 capability 缺口（不退回系统解释器）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const { deps } = makeDeps({
    fs, shell: makeShell(() => ({ stdout: '' })),
    python: { cached: () => null, check: async () => ({ ok: false, state: 'missing', path: '', versionText: '', distributions: {}, missingPackages: [], error: '包内没有运行时', source: 'stub' }) },
  })
  const extractor = pythonFileExtractor({
    ctx: deps.ctx, access: deps.access, python: deps.python,
    world: { platform: () => deps.world.platform() },
    casePath: CASE_DIR, sourceScriptPath: SCRIPT_SRC, readSource: async () => SCRIPT_BODY,
  })
  await assert.rejects(() => extractor.extract({ path: PDF, fileName: 'x.pdf', kind: 'pdf' }), /Python 不可用/)
})

test('编排：一份读不出来不影响另一份（缺口带文件名上浮）', async () => {
  const good = `${CASE_DIR}/材料-源/好.docx`
  const fs = makeFs({ files: { [PDF]: 'PDF', [good]: 'DOCX' } })
  const shell = makeShell((request) => {
    const argv = argvOf(request.command)
    if (argv.some((item) => item.endsWith('extract_files.py'))) {
      const input = String(argv[1])
      fs.files.set(String(argv[2]), input.endsWith('.pdf')
        ? payload({ ok: false, text: '', extractedFields: {}, capabilityGaps: ['没有 PDF 读取库'] })
        : payload({ fileName: '好.docx', fileType: 'word', text: '用途：住宅', extractedFields: { 用途: '住宅' } }))
    }
    return { stdout: '' }
  })
  const { deps } = makeDeps({ fs, shell })
  const extractor = pythonFileExtractor({
    ctx: deps.ctx, access: deps.access, python: deps.python,
    world: { platform: () => deps.world.platform() },
    casePath: CASE_DIR, sourceScriptPath: SCRIPT_SRC, readSource: async () => SCRIPT_BODY,
  })
  const outcome = await runExtraction({
    files: [
      { path: PDF, fileName: '估值报告.pdf', kind: 'pdf' },
      { path: good, fileName: '好.docx', kind: 'word' },
    ],
    extractors: [extractor],
  })
  assert.deepEqual(outcome.files.map((file) => file.fileName), ['好.docx'])
  assert.deepEqual(outcome.unparsed, ['估值报告.pdf'])
  assert.match(outcome.capabilityGaps[0], /没有 PDF 读取库/)
})

// ── 工具 ────────────────────────────────────────────────────────────────────

test('工具注册面：估值提取 Tool 在注册清单里，但**不在**审核必需集', () => {
  assert.equal(CRWU_BUSINESS_TOOLS.includes(VALUATION_TOOL_NAMES.fileExtract), true)
  assert.equal(REQUIRED_AUDIT_TOOLS.includes(VALUATION_TOOL_NAMES.fileExtract), false)
})

test('工具：非估值会话被拒（普通会话不许用这条链路提资料）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const { deps } = makeDeps({ fs, shell: makeShell(() => ({ stdout: '' })) })
  const tool = valuationFileExtractTools(deps)[0]
  const result = await tool.execute({ caseDir: CASE_DIR, files: ['材料-源/估值报告.pdf'] }, execOf('随便一条会话'))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.match(result.error, /不是本轮估值会话/)
})

test('工具：空清单 / 绝对路径 / `..` / 资料不存在 —— 逐条拒绝在起进程之前', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const shell = makeShell(() => ({ stdout: '' }))
  const { deps } = makeDeps({ fs, shell })
  const sessionId = openValuation(deps)
  const tool = valuationFileExtractTools(deps)[0]

  const empty = await tool.execute({ caseDir: CASE_DIR, files: [] }, execOf(sessionId))
  assert.equal(empty.errorKind, 'input')
  const absolute = await tool.execute({ caseDir: CASE_DIR, files: [PDF] }, execOf(sessionId))
  assert.equal(absolute.errorKind, 'input')
  assert.match(absolute.error, /绝对路径/)
  const escaping = await tool.execute({ caseDir: CASE_DIR, files: ['../秘密.pdf'] }, execOf(sessionId))
  assert.equal(escaping.errorKind, 'input')
  assert.match(escaping.error, /\.\./)
  const missing = await tool.execute({ caseDir: CASE_DIR, files: ['材料-源/没有这份.pdf'] }, execOf(sessionId))
  assert.equal(missing.errorKind, 'not-found')
  assert.equal(shell.commands.length, 0, '校验阶段一条命令都不许起')
})

test('工具：成功时只回紧凑摘要，完整结果落盘（正文不进上下文）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const longText = '坐落：某路 1 号\n' + '正文'.repeat(500)
  const shell = shellWritingPayload(fs, payload({ text: longText }))
  const { deps } = makeDeps({ fs, shell })
  const sessionId = openValuation(deps)
  const tool = valuationFileExtractTools(deps)[0]

  const result = await tool.execute({ caseDir: CASE_DIR, files: ['材料-源/估值报告.pdf'] }, execOf(sessionId))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].textLength, longText.length, '摘要只给长度，不给正文')
  assert.equal('text' in result.files[0], false)
  assert.equal(result.files[0].extractedFields['坐落'], '某路 1 号')

  const stored = JSON.parse(fs.files.get(result.resultPath))
  assert.equal(stored.files[0].text, longText, '完整正文必须在落盘的那一份里')
  assert.equal(result.resultPath, `${CASE_DIR}/提取结果/提取汇总.json`)
})

test('工具：一份都没解析出来 → ok:false 且是 capability-gap（不说成"成功但为空"）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const body = payload({ ok: false, text: '', extractedFields: {}, capabilityGaps: ['没有 PDF 读取库'] })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })
  const sessionId = openValuation(deps)
  const result = await valuationFileExtractTools(deps)[0]
    .execute({ caseDir: CASE_DIR, files: ['材料-源/估值报告.pdf'] }, execOf(sessionId))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.deepEqual(result.unparsed, ['估值报告.pdf'])
  assert.match(result.capabilityGaps.join('；'), /没有 PDF 读取库/)
  assert.deepEqual(result.files, [])
})

test('工具：结果落盘失败时不谎报成功', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  // 让写 `提取汇总.json` 失败：把 writeText 改成只对结果文件失败。
  const original = fs.writeText.bind(fs)
  fs.writeText = async (target, content) => {
    if (String(target.targetKey).endsWith('提取汇总.json')) throw new Error('磁盘只读')
    return await original(target, content)
  }
  const shell = shellWritingPayload(fs, payload())
  const { deps } = makeDeps({ fs, shell })
  const sessionId = openValuation(deps)
  const result = await valuationFileExtractTools(deps)[0]
    .execute({ caseDir: CASE_DIR, files: ['材料-源/估值报告.pdf'] }, execOf(sessionId))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.match(result.error, /落盘失败/)
})
