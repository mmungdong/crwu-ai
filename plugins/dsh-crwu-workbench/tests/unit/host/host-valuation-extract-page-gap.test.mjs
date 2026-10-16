/**
 * P1（扫描 PDF）：**逐页事实与能力声明在 Host 边界上的契约**。
 *
 * 技能脚本（`extract_files.py`）多写六个键：`pages` / `pageCount` / `pagesWithText` /
 * `pagesWithoutText` 与 `capabilities` / `capabilityProbe`。这一层要钉死的不是"脚本写得好不好"
 * （那由技能侧的 `test_extract_files.py` 覆盖），而是**这些事实走到会话为止还剩什么**：
 *
 * 1. 带页码区间的缺口文案（`第 2–3 页无文本层：…请人工核对…`）必须**真的到会话**：
 *    它是本轮的**唯一**人工动作指令，丢了就等于又回到一句笼统的"需要 OCR"；
 * 2. `ok:false` 的文件走"未解析 + 能力缺口"这条路时，缺口原文必须出现在错误里
 *    （连带页码区间），不能被压成一句通用失败；
 * 3. 逐页事实与能力声明要**过 Host 边界**：会话据此决定"改读页面图像"还是"请人工补关键页"，
 *    所以 `pages` / `pageCount` / 计数 / `capabilities` / `capabilityProbe` 都要能读到；
 * 4. 但**读不出来就是读不出来**：形状不对的逐页行 / 计数 / 能力一律降级成"没声明"
 *    （键不出现），绝不许被凑成 `hasTextLayer: true` 或 `false`；
 * 5. 紧凑摘要只给**计数 + 能力 + 页码缺口文案**，完整逐页表留在
 *    `提取结果/提取汇总.json` —— 一份 PDF 最多 200 页，逐页表进上下文不划算。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { makeTestAccess } from '../../helpers/local-access-broker-fixture.mjs'
import { grantedConsent } from '../../helpers/local-access-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)

const { pythonFileExtractor } = await import(new URL('src/host/domains/report-evaluation/intake/python-extractor.ts', ROOT).href)
const { runExtraction } = await import(new URL('src/host/domains/report-evaluation/intake/extract.ts', ROOT).href)
const { createDiscussionScopeRegistry } = await import(new URL('src/host/domains/report-audit/discussion-scope.ts', ROOT).href)
const { ValuationScopes } = await import(new URL('src/host/domains/report-evaluation/scope.ts', ROOT).href)
const { valuationFileExtractTools } = await import(new URL('src/host/tools/report-evaluation/file-extract.ts', ROOT).href)
const { VALUATION_TOOL_NAMES } = await import(new URL('src/host/tools/report-evaluation/consts.ts', ROOT).href)
const { createWorkbenchState } = await import(new URL('src/host/core/state/store.ts', ROOT).href)

const WORKSPACE = '/cases/space'
const VALUATION_ID = '估值-20261012-120000-ef56'
const CASE_DIR = `${WORKSPACE}/${VALUATION_ID}`
const SCRIPT_SRC = '/pkg/skills/biz/crwu-biz-valuation-realestate/scripts/extract_files.py'
const SCRIPT_BODY = '# fake extractor\n'
const PDF = `${CASE_DIR}/材料-源/扫描件.pdf`

const PAGE_GAP = '第 2–3 页无文本层：本部署没有 PDF 页面渲染能力，请人工核对这几页的坐落/面积/权属'

const CONFIG = {
  caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '',
  ossBucket: '', ossPrefix: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true,
  requireTopLevelParent: true,
}

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

function makeShell(route) {
  const commands = []
  return {
    commands,
    service: {
      resolve: (request) => request,
      async execute(request) {
        commands.push(request)
        const spec = route(request)
        return {
          result: async () => ({
            exitCode: spec?.exitCode ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
            stdout: { text: spec?.stdout ?? '', truncated: false },
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

function makeDeps({ fs, shell, state = makeState(), scopes = new ValuationScopes() } = {}) {
  const ctx = makeCtx(fs, shell)
  const { access } = makeTestAccess(ctx, { state })
  return {
    ctx, fs, shell, state, scopes,
    deps: {
      ctx, config: { ...CONFIG }, state, access,
      discussionScopes: createDiscussionScopeRegistry(),
      valuationScopes: scopes,
      python: PYTHON_STUB,
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

function execOf(sessionId) {
  return {
    callId: 'c1', rootCallId: 'c1', token: Symbol('t'),
    name: VALUATION_TOOL_NAMES.fileExtract, arguments: {}, signal: new AbortController().signal,
    agent: { id: sessionId }, deferContext() {}, concludeTurn() {},
  }
}

function argvOf(command) {
  return [...String(command).matchAll(/'([^']*)'/g)].map((match) => match[1])
}

function shellWritingPayload(fs, body) {
  return makeShell((request) => {
    const argv = argvOf(request.command)
    if (argv.some((item) => item.endsWith('extract_files.py'))) fs.files.set(String(argv[2]), body)
    return { stdout: '' }
  })
}

function extractorFor(deps) {
  return pythonFileExtractor({
    ctx: deps.ctx, access: deps.access, python: deps.python,
    world: { platform: () => deps.world.platform() },
    casePath: CASE_DIR, sourceScriptPath: SCRIPT_SRC, readSource: async () => SCRIPT_BODY,
  })
}

const SCANNED_PAGES = [
  { index: 1, hasTextLayer: true, chars: 12 },
  { index: 2, hasTextLayer: false, chars: 0 },
  { index: 3, hasTextLayer: false, chars: 0 },
]
const SCANNED_CAPABILITIES = { pdfText: true, pdfRender: false, imageOcr: false, visionFallback: 'none' }
const SCANNED_PROBE = { pdfTextLibrary: 'pypdf', rasterizer: '', pdfImageExtractor: '', ocrEngine: '' }

/** 脚本在"部分页有文本层"时的真实回执形状（逐页事实 + 能力声明 + 一条页码缺口）。 */
function scannedPayload(overrides = {}) {
  return JSON.stringify({
    ok: true, error: '', fileName: '扫描件.pdf', fileType: 'pdf',
    text: '坐落：某路 1 号', tables: [], images: [], extractedFields: { 坐落: '某路 1 号' },
    warnings: [], capabilityGaps: [PAGE_GAP],
    pages: SCANNED_PAGES,
    pageCount: 3, pagesWithText: 1, pagesWithoutText: 2,
    capabilities: SCANNED_CAPABILITIES,
    capabilityProbe: SCANNED_PROBE,
    ...overrides,
  })
}

test('后端：页码缺口文案必须原样到会话（这是本轮唯一的人工动作指令）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, scannedPayload()) })

  const result = await extractorFor(deps).extract({ path: PDF, fileName: '扫描件.pdf', kind: 'pdf' })
  assert.deepEqual(result.capabilityGaps, [PAGE_GAP], '缺口文案不许被改写或丢掉')
  assert.match(result.capabilityGaps[0], /第 2–3 页无文本层/)
  assert.match(result.capabilityGaps[0], /请人工核对这几页的坐落\/面积\/权属/)
})

test('后端：逐页事实与能力声明过 Host 边界（会话据此决定读图像还是请人工）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, scannedPayload()) })

  const result = await extractorFor(deps).extract({ path: PDF, fileName: '扫描件.pdf', kind: 'pdf' })
  assert.deepEqual(result.pages, SCANNED_PAGES, '逐页表要按原样过来（index 从 1 起）')
  assert.equal(result.pageCount, 3)
  assert.equal(result.pagesWithText, 1)
  assert.equal(result.pagesWithoutText, 2)
  assert.deepEqual(result.capabilities, SCANNED_CAPABILITIES)
  assert.equal(result.capabilityProbe.pdfTextLibrary, 'pypdf')
  assert.equal(result.capabilityProbe.rasterizer, '', '空串是"探过、没找到"的证据，不能当成"没探"')
  assert.equal(result.text, '坐落：某路 1 号', '读到的页照常给正文')
})

test('后端：形状不对的逐页行 / 计数 / 能力降级成"没声明"，绝不凑成 hasTextLayer:true', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const body = scannedPayload({
    pages: [
      { index: 1, hasTextLayer: 'yes', chars: 5 },
      { index: 2, hasTextLayer: true, chars: 5 },
      { index: 3, hasTextLayer: 1, chars: 5 },
      { index: 'x', hasTextLayer: false },
      null,
      'nope',
    ],
    pageCount: '3',
    pagesWithText: 2.5,
    pagesWithoutText: -1,
    capabilities: { pdfText: 'true', pdfRender: 0, imageOcr: null, visionFallback: 7 },
    capabilityProbe: 'nope',
  })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })

  const result = await extractorFor(deps).extract({ path: PDF, fileName: '扫描件.pdf', kind: 'pdf' })
  // 只有 index + 布尔 hasTextLayer 都成立的行才算一条事实；坏行丢弃，不许猜。
  assert.deepEqual(result.pages, [{ index: 2, hasTextLayer: true, chars: 5 }])
  for (const unknown of ['pageCount', 'pagesWithText', 'pagesWithoutText']) {
    assert.equal(unknown in result, false, `${unknown} 不是合法计数时必须缺省（未知），不许凑成 0`)
  }
  assert.equal('capabilities' in result, false, '非布尔能力不能当 false，也不能当 true')
  assert.equal('capabilityProbe' in result, false, '探针证据不是对象时不落成空对象')
})

test('后端：整页表全是坏行时不留空数组（空数组会被 every 读成"整份都有文本层"）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const body = scannedPayload({
    pages: [{ index: 0, hasTextLayer: false }, { index: 2, hasTextLayer: 'no' }],
    pageCount: 2, pagesWithText: 0, pagesWithoutText: 2,
  })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })

  const result = await extractorFor(deps).extract({ path: PDF, fileName: '扫描件.pdf', kind: 'pdf' })
  assert.equal('pages' in result, false, '一条事实都没有时 pages 必须缺省')
  // 计数是脚本自己的声明，与 pages 是否成形无关：声明了就给出去（会话能看出"声明与事实不一致"）。
  assert.equal(result.pageCount, 2)
  assert.equal(result.pagesWithoutText, 2)
})

test('后端：明确声明的"全不能"要留住（false ≠ 未知）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const body = scannedPayload({
    text: '', extractedFields: {}, capabilityGaps: ['本机 Python 没有可用的 PDF 文本读取库（pypdf / PyPDF2 / pdfminer 都没有）：这一份 PDF 未解析'],
    pages: [], pageCount: 0, pagesWithText: 0, pagesWithoutText: 0,
    capabilities: { pdfText: false, pdfRender: false, imageOcr: false, visionFallback: 'none' },
    capabilityProbe: {
      pdfTextLibrary: '', rasterizer: '', pdfImageExtractor: '', ocrEngine: '',
      probedRasterizers: 'pdftoppm、pdftocairo、mutool、gs、qpdf',
      probe: 'importlib.util.find_spec + shutil.which', probeError: '',
    },
  })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })

  const result = await extractorFor(deps).extract({ path: PDF, fileName: '扫描件.pdf', kind: 'pdf' })
  assert.deepEqual(result.capabilities, { pdfText: false, pdfRender: false, imageOcr: false, visionFallback: 'none' })
  assert.match(result.capabilityProbe.probedRasterizers, /pdftoppm/)
  assert.equal(result.capabilityProbe.pdfTextLibrary, '', '探过但没有库：这是结论，不是"未知"')
  assert.equal('pages' in result, false, '没有任何逐页事实时不留空表')
})

test('后端：混合 PDF —— 只有 hasTextLayer:true 的页贡献正文，无文本层页一个字都不产生', async () => {
  const MIXED_GAP = '第 4–5 页无文本层：本部署没有 PDF 页面渲染能力，请人工核对这几页的坐落/面积/权属'
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const body = scannedPayload({
    text: '坐落：某路 1 号\n用途：住宅',
    extractedFields: { 坐落: '某路 1 号', 用途: '住宅' },
    capabilityGaps: [MIXED_GAP],
    pages: [
      { index: 1, hasTextLayer: true, chars: 24 },
      { index: 2, hasTextLayer: true, chars: 12 },
      { index: 3, hasTextLayer: true, chars: 8 },
      { index: 4, hasTextLayer: false, chars: 0 },
      { index: 5, hasTextLayer: false, chars: 0 },
    ],
    pageCount: 5, pagesWithText: 3, pagesWithoutText: 2,
  })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })

  const result = await extractorFor(deps).extract({ path: PDF, fileName: '扫描件.pdf', kind: 'pdf' })
  assert.equal(result.pagesWithText, 3)
  assert.equal(result.pagesWithoutText, 2)
  assert.deepEqual(result.pages.filter((page) => !page.hasTextLayer).map((page) => page.index), [4, 5])
  assert.equal(result.text, '坐落：某路 1 号\n用途：住宅')
  assert.deepEqual(result.extractedFields, { 坐落: '某路 1 号', 用途: '住宅' })
  assert.match(result.capabilityGaps[0], /第 4–5 页无文本层/)
})

test('编排：整份扫描件走未解析时，页码缺口原文出现在缺口里', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const body = scannedPayload({ ok: false, text: '', extractedFields: {} })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })

  const outcome = await runExtraction({
    files: [{ path: PDF, fileName: '扫描件.pdf', kind: 'pdf' }],
    extractors: [extractorFor(deps)],
  })
  assert.deepEqual(outcome.unparsed, ['扫描件.pdf'])
  assert.equal(outcome.files.length, 0)
  assert.match(outcome.capabilityGaps.join('；'), /第 2–3 页无文本层/)
  assert.match(outcome.capabilityGaps.join('；'), /请人工核对这几页的坐落\/面积\/权属/)
})

test('工具：摘要给计数 + 能力 + 页码缺口文案，逐页表留给提取汇总.json', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  const body = scannedPayload({
    images: [{
      path: '提取-扫描件.pdf-页面图片/第2页-图1.png',
      description: '扫描件.pdf#第2页图片#1 · 内嵌位图 · 24 字节 · 内容未识别（本部署没有 OCR / 视觉识别能力）',
    }],
    capabilities: { pdfText: true, pdfRender: false, imageOcr: false, visionFallback: 'session-images' },
  })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })
  const sessionId = openValuation(deps)

  const result = await valuationFileExtractTools(deps)[0]
    .execute({ caseDir: CASE_DIR, files: ['材料-源/扫描件.pdf'] }, execOf(sessionId))

  assert.equal(result.ok, true, result.error)
  assert.equal(result.files[0].imageCount, 1, '摘要是数量，不是图像本身')
  assert.equal('images' in result.files[0], false, '图像不进模型上下文')
  assert.deepEqual(result.files[0].capabilityGaps, [PAGE_GAP])
  // 会话要**不开文件**就能决定"读页面图像 / 请人工补这几页"。
  assert.equal(result.files[0].pageCount, 3)
  assert.equal(result.files[0].pagesWithText, 1)
  assert.equal(result.files[0].pagesWithoutText, 2)
  assert.deepEqual(result.files[0].capabilities, {
    pdfText: true, pdfRender: false, imageOcr: false, visionFallback: 'session-images',
  })
  assert.equal('pages' in result.files[0], false, '逐页表（最多 200 行）不进紧凑摘要')

  const stored = JSON.parse(fs.files.get(result.resultPath))
  assert.deepEqual(stored.files[0].pages, SCANNED_PAGES, '完整逐页表在落盘的那一份里')
  assert.equal(stored.files[0].pageCount, 3)
  assert.equal(stored.files[0].images[0].path, '提取-扫描件.pdf-页面图片/第2页-图1.png')
  assert.match(stored.files[0].images[0].description, /内容未识别/, '登记图像不等于认出内容')
})

test('工具：没有逐页事实的那一份不许在摘要里冒出计数（未知 ≠ 0）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  // 老脚本 / 非 PDF：完全没有 pages / pageCount / capabilities 这几个键。
  const body = JSON.stringify({
    ok: true, error: '', fileName: '扫描件.pdf', fileType: 'pdf',
    text: '坐落：某路 1 号', tables: [], images: [], extractedFields: { 坐落: '某路 1 号' },
    warnings: [], capabilityGaps: [],
  })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })
  const sessionId = openValuation(deps)

  const result = await valuationFileExtractTools(deps)[0]
    .execute({ caseDir: CASE_DIR, files: ['材料-源/扫描件.pdf'] }, execOf(sessionId))

  assert.equal(result.ok, true, result.error)
  for (const unknown of ['pageCount', 'pagesWithText', 'pagesWithoutText', 'capabilities']) {
    assert.equal(unknown in result.files[0], false, `${unknown} 缺省就是未知，不许补成 0/false`)
  }
})

test('编排：**部分读到**的文件不许被打成"未解析"（前缀只说这次解析出了什么）', async () => {
  const fs = makeFs({ files: { [PDF]: 'PDF' } })
  // 读到了正文与字段，但有 1 页没有文本层 → 缺口是"部分读到"，不是"整份没读"。
  const body = scannedPayload({ text: '坐落：某路 1 号', extractedFields: { 坐落: '某路 1 号' } })
  const { deps } = makeDeps({ fs, shell: shellWritingPayload(fs, body) })

  const outcome = await runExtraction({
    files: [{ path: PDF, fileName: '扫描件.pdf', kind: 'pdf' }],
    extractors: [extractorFor(deps)],
  })
  const gap = outcome.capabilityGaps.find((one) => one.includes('无文本层'))
  assert.ok(gap, `缺口里要有页码说明：${JSON.stringify(outcome.capabilityGaps)}`)
  assert.equal(gap.startsWith('未解析：'), false, '读到了正文就不该说"未解析"')
  assert.match(gap, /^扫描件\.pdf（第 [0-9–]+ 页无文本层/)
})
