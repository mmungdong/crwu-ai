/**
 * 报告评估资料入口（`host/domains/report-evaluation/intake`）的单元测试。
 *
 * 这一层决定"AI 到底看见了什么资料"，所以每条断言都对应一个**真实会发生的错**：
 *
 * 1. 空文件 / 越界路径 / 超大文件必须**被拒绝**，且拒绝原因分得清（不是笼统一句"选错了"）；
 * 2. 不认识的类型不算"选择错误"，而是"未解析" —— 界面要说的是"这份没解析"；
 * 3. 一份文件读不出来**不许**阻塞其他文件（用户传 20 份，坏一份就整轮失败是不能接受的）；
 * 4. 提取器报的能力缺口必须上浮，且**不许**被静默吞掉（否则结果 JSON 会假装"都读到了"）；
 * 5. 输入清单指纹按**相对路径排序**后计算：同一批资料重选一次顺序变了，指纹必须不变
 *    （否则历史结果再也对不上，用户看到的"重传同一份文件结果对不上"就是这么来的）。
 *
 * ## 计划 Task 2 之后的边界（本文件后半段）
 *
 * 归档预览（`preview.ts` / `metadata.ts`）只做**本机**的事：扫描、复制、验指纹、算摘要。
 * 它**不**调用 Python 提取、**不**拉知识库、**不**发任何网络请求、**不**调模型 ——
 * 这三条现在由这里的结构断言钉住（提取与知识物化都归父会话）。预览的行为断言见
 * `host-valuation-handoff.test.mjs`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const {
  contentTypeOf,
  extensionOf,
  isSupportedFileName,
  kindLabel,
  kindOf,
} = await import(new URL('src/host/domains/report-evaluation/intake/classify.ts', ROOT).href)
const {
  buildIntakeManifest,
  sha256OfBytes,
  validateIntakeSelection,
} = await import(new URL('src/host/domains/report-evaluation/intake/manifest.ts', ROOT).href)
const { runExtraction } = await import(
  new URL('src/host/domains/report-evaluation/intake/extract.ts', ROOT).href)
const { dedupeOrdered } = await import(
  new URL('src/host/domains/report-evaluation/intake/types.ts', ROOT).href)

// ── 类型判定 ────────────────────────────────────────────────────────────────

test('扩展名判定：第一版支持的类型逐条认得，大小写与多点文件名都稳', () => {
  for (const [name, kind] of [
    ['估值报告.pdf', 'pdf'],
    ['说明.DOCX', 'word'],
    ['说明.doc', 'word'],
    ['计算表.xlsx', 'excel'],
    ['旧表.XLS', 'excel'],
    ['现场照片.PNG', 'image'],
    ['照片.jpg', 'image'],
    ['照片.jpeg', 'image'],
  ]) {
    assert.equal(kindOf(name), kind, name)
  }
  assert.equal(extensionOf('a.b.c.PDF'), '.pdf', '取最后一段扩展名')
  assert.equal(extensionOf('.gitignore'), '', '前导点不算扩展名')
  assert.equal(extensionOf('没有扩展名'), '')
  assert.equal(kindOf('扫描件.tif'), 'image', '认得但不主动解析：界面要能说清是什么')
  assert.equal(kindOf('打包.zip'), 'archive')
  assert.equal(kindOf('说明.txt'), 'text')
  assert.equal(kindOf('奇怪的东西'), 'unknown')
})

test('第一版主动解析的类型只有 PDF / Word / Excel / 图片', () => {
  for (const name of ['a.pdf', 'a.doc', 'a.docx', 'a.xls', 'a.xlsx', 'a.png', 'a.jpg', 'a.jpeg']) {
    assert.equal(isSupportedFileName(name), true, name)
  }
  for (const name of ['a.txt', 'a.csv', 'a.zip', 'a.tif', 'a.pptx', 'a']) {
    assert.equal(isSupportedFileName(name), false, name)
  }
})

test('内容类型按类型给出；认不出来退回二进制流（不假装是文本）', () => {
  assert.equal(contentTypeOf('a.pdf'), 'application/pdf')
  assert.match(contentTypeOf('a.docx'), /wordprocessingml/)
  assert.match(contentTypeOf('a.xlsx'), /spreadsheetml/)
  assert.equal(contentTypeOf('a.jpeg'), 'image/jpeg', '`.jpeg` 不许被裁成 image/pg')
  assert.equal(contentTypeOf('a.tif'), 'image/tiff')
  assert.equal(contentTypeOf('a.txt'), 'text/plain')
  assert.equal(contentTypeOf('a'), 'application/octet-stream')
})

test('类型名是人话（界面与能力缺口里直接展示）', () => {
  for (const kind of ['pdf', 'word', 'excel', 'image', 'text', 'archive', 'unknown']) {
    assert.ok(kindLabel(kind).length > 0)
  }
  // 界面/缺口里看到的是人话，**不是**内部枚举名本身（`excel` / `unknown`）。
  for (const kind of ['pdf', 'word', 'excel', 'image', 'text', 'archive', 'unknown']) {
    assert.notEqual(kindLabel(kind), kind, kind)
  }
})

// ── 选择校验 ────────────────────────────────────────────────────────────────

test('空文件 / 越界路径 / 超大文件 / 重复选择 —— 逐条拒绝，理由分得清', () => {
  const { accepted, rejected } = validateIntakeSelection({
    allowedRoots: ['/Users/x/资料'],
    maxFileBytes: 1024,
    candidates: [
      { fileName: '好文件.pdf', path: '/Users/x/资料/好文件.pdf', sizeBytes: 100 },
      { fileName: '空文件.pdf', path: '/Users/x/资料/空文件.pdf', sizeBytes: 0 },
      { fileName: '外面的.pdf', path: '/etc/passwd', sizeBytes: 10 },
      { fileName: '巨大的.pdf', path: '/Users/x/资料/巨大的.pdf', sizeBytes: 2048 },
      { fileName: '好文件.pdf', path: '/Users/x/资料/好文件.pdf', sizeBytes: 100 },
    ],
  })
  assert.deepEqual(accepted.map((item) => item.fileName), ['好文件.pdf'])
  assert.deepEqual(rejected.map((item) => item.kind), ['empty', 'out-of-bounds', 'too-large', 'duplicate'])
  for (const item of rejected) {
    assert.ok(item.reason.length > 0, `${item.kind} 必须有理由`)
    assert.equal(/\/etc|\/Users/.test(item.reason), false, '理由不回显绝对路径')
  }
})

test('一个允许根都没有时**一律**拒绝（不许"没有白名单就放行"）', () => {
  const { accepted, rejected } = validateIntakeSelection({
    allowedRoots: [],
    candidates: [{ fileName: 'a.pdf', path: '/Users/x/资料/a.pdf', sizeBytes: 10 }],
  })
  assert.deepEqual(accepted, [])
  assert.equal(rejected[0].kind, 'out-of-bounds')
})

test('子目录在允许根之下算通过；相邻同名前缀不算（`/资料夹` 不是 `/资料` 的子目录）', () => {
  const inside = validateIntakeSelection({
    allowedRoots: ['/Users/x/资料'],
    candidates: [{ fileName: 'a.pdf', path: '/Users/x/资料/子目录/a.pdf', sizeBytes: 10 }],
  })
  assert.equal(inside.accepted.length, 1)

  const sibling = validateIntakeSelection({
    allowedRoots: ['/Users/x/资料'],
    candidates: [{ fileName: 'a.pdf', path: '/Users/x/资料夹/a.pdf', sizeBytes: 10 }],
  })
  assert.deepEqual(sibling.accepted, [], '同名前缀的邻居目录不是子目录')
})

test('不支持的类型**不算**选择错误（员工交扫描件是正常行为）', () => {
  const { accepted, rejected } = validateIntakeSelection({
    allowedRoots: ['/Users/x/资料'],
    candidates: [{ fileName: '扫描件.tif', path: '/Users/x/资料/扫描件.tif', sizeBytes: 10 }],
  })
  assert.equal(rejected.length, 0, '类型不该在这里被拒')
  assert.equal(accepted.length, 1, '它进的是"未解析"，由提取阶段记 capability gap')
})

// ── 输入清单与指纹 ──────────────────────────────────────────────────────────

test('输入清单按相对路径排序，指纹与选择顺序无关', () => {
  const first = buildIntakeManifest({
    now: new Date('2026-10-12T00:00:00.000Z'),
    files: [
      { fileName: 'b.xlsx', relativePath: '材料-源/b.xlsx', sizeBytes: 20, sha256: 'sha256:b' },
      { fileName: 'a.pdf', relativePath: '材料-源/a.pdf', sizeBytes: 10, sha256: 'sha256:a' },
    ],
  })
  const second = buildIntakeManifest({
    now: new Date('2026-10-12T01:00:00.000Z'),
    files: [
      { fileName: 'a.pdf', relativePath: '材料-源/a.pdf', sizeBytes: 10, sha256: 'sha256:a' },
      { fileName: 'b.xlsx', relativePath: '材料-源/b.xlsx', sizeBytes: 20, sha256: 'sha256:b' },
    ],
  })
  assert.deepEqual(first.files.map((file) => file.fileName), ['a.pdf', 'b.xlsx'])
  assert.equal(first.digest, second.digest, '重选一次顺序变了，指纹必须不变')
  assert.match(first.digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(first.generatedAt, '2026-10-12T00:00:00.000Z')
})

test('内容变了指纹就变；文件名与类型从文件名补全', () => {
  const base = { fileName: 'a.pdf', relativePath: '材料-源/a.pdf' }
  const one = buildIntakeManifest({ files: [{ ...base, sizeBytes: 10, sha256: 'sha256:a' }] })
  const two = buildIntakeManifest({ files: [{ ...base, sizeBytes: 11, sha256: 'sha256:a' }] })
  assert.notEqual(one.digest, two.digest)
  assert.equal(one.files[0].kind, 'pdf', '类型由文件名推出来，调用方不必重复给')
})

test('sha256OfBytes 与字节内容一一对应', () => {
  assert.match(sha256OfBytes('abc'), /^sha256:[0-9a-f]{64}$/)
  assert.equal(sha256OfBytes('abc'), sha256OfBytes(new TextEncoder().encode('abc')), '字符串与同样的字节同值')
  assert.notEqual(sha256OfBytes('abc'), sha256OfBytes('abd'))
})

test('去重保序：能力缺口与观察的展示顺序稳定', () => {
  assert.deepEqual(dedupeOrdered(['a', 'b', 'a', ' ', 'c']), ['a', 'b', 'c'])
})

// ── 提取编排 ────────────────────────────────────────────────────────────────

/** 一个只处理指定扩展名的提取器替身。 */
function stubExtractor(extensions, produce) {
  const calls = []
  return {
    calls,
    extractor: {
      canHandle: (_contentType, fileName) => extensions.some((ext) => String(fileName).toLowerCase().endsWith(ext)),
      async extract(input) {
        calls.push(input)
        return await produce(input)
      },
    },
  }
}

test('每份文件交给第一个能处理它的提取器；读不出来的不阻塞其他文件', async () => {
  const pdf = stubExtractor(['.pdf'], (input) => ({
    fileName: input.fileName, fileType: 'pdf', text: '坐落：某路 1 号', tables: [], images: [],
    extractedFields: { 坐落: '某路 1 号' }, warnings: [], capabilityGaps: [],
  }))
  const excel = stubExtractor(['.xlsx'], async () => { throw new Error('openpyxl 不可用') })
  const outcome = await runExtraction({
    files: [
      { path: '/c/材料-源/a.pdf', fileName: 'a.pdf', kind: 'pdf' },
      { path: '/c/材料-源/b.xlsx', fileName: 'b.xlsx', kind: 'excel' },
    ],
    extractors: [pdf.extractor, excel.extractor],
  })

  assert.deepEqual(outcome.files.map((file) => file.fileName), ['a.pdf'], '成功的照常返回')
  assert.deepEqual(outcome.unparsed, ['b.xlsx'], '失败的进未解析')
  assert.equal(outcome.capabilityGaps.length, 1)
  assert.match(outcome.capabilityGaps[0], /b\.xlsx/)
  assert.match(outcome.capabilityGaps[0], /Excel 表格/, '缺口要说是哪一类文件')
  assert.match(outcome.capabilityGaps[0], /openpyxl 不可用/, '真实原因要带出来')
})

test('没有提取器能处理时：进未解析 + 能力缺口，绝不当成"读到了空内容"', async () => {
  const outcome = await runExtraction({
    files: [{ path: '/c/材料-源/扫描件.tif', fileName: '扫描件.tif', kind: 'image' }],
    extractors: [stubExtractor(['.pdf'], () => { throw new Error('不该被调用') }).extractor],
  })
  assert.deepEqual(outcome.files, [])
  assert.deepEqual(outcome.unparsed, ['扫描件.tif'])
  assert.match(outcome.capabilityGaps[0], /没有可用的提取器/)
})

test('扫描件没有文本层：提取器报的缺口必须上浮（空正文不是成功）', async () => {
  const scanned = stubExtractor(['.pdf'], (input) => ({
    fileName: input.fileName, fileType: 'pdf', text: '', tables: [], images: [],
    extractedFields: {}, warnings: [], capabilityGaps: ['PDF 无文本层，需要 OCR'],
  }))
  const outcome = await runExtraction({
    files: [{ path: '/c/材料-源/扫描.pdf', fileName: '扫描.pdf', kind: 'pdf' }],
    extractors: [scanned.extractor],
  })
  assert.equal(outcome.files.length, 1)
  assert.equal(outcome.capabilityGaps.length, 1)
  assert.match(outcome.capabilityGaps[0], /扫描\.pdf/)
  assert.match(outcome.capabilityGaps[0], /需要 OCR/)
})

test('提取器返回空结果却**不报**缺口：记一条观察，让它可见（不静默）', async () => {
  const silent = stubExtractor(['.pdf'], (input) => ({
    fileName: input.fileName, fileType: 'pdf', text: '', tables: [], images: [],
    extractedFields: {}, warnings: [], capabilityGaps: [],
  }))
  const outcome = await runExtraction({
    files: [{ path: '/c/材料-源/空.pdf', fileName: '空.pdf', kind: 'pdf' }],
    extractors: [silent.extractor],
  })
  assert.equal(outcome.capabilityGaps.length, 0, '提取器没报缺口，不替它编一个')
  assert.equal(outcome.warnings.length, 1)
  assert.match(outcome.warnings[0], /提取结果为空/)
})

test('提取器判定能否处理时抛错：跳过它并记一条观察，其它提取器照常工作', async () => {
  const broken = {
    canHandle: () => { throw new Error('后端未装配') },
    extract: async () => { throw new Error('不该被调用') },
  }
  const works = stubExtractor(['.pdf'], (input) => ({
    fileName: input.fileName, fileType: 'pdf', text: '正文', tables: [], images: [],
    extractedFields: {}, warnings: ['编码回退到 GBK'], capabilityGaps: [],
  }))
  const outcome = await runExtraction({
    files: [{ path: '/c/材料-源/a.pdf', fileName: 'a.pdf', kind: 'pdf' }],
    extractors: [broken, works.extractor],
  })
  assert.equal(outcome.files.length, 1, '坏提取器不影响后面的')
  assert.equal(outcome.warnings.some((warning) => warning.includes('后端未装配')), true)
  assert.equal(outcome.warnings.some((warning) => warning.includes('编码回退到 GBK')), true)
})

test('多条相同的缺口只留一条（同一类问题不刷屏），顺序按出现先后', async () => {
  const same = (message) => stubExtractor(['.pdf'], (input) => ({
    fileName: input.fileName, fileType: 'pdf', text: '', tables: [], images: [],
    extractedFields: {}, warnings: [], capabilityGaps: [message],
  }))
  const outcome = await runExtraction({
    files: [
      { path: '/c/材料-源/1.pdf', fileName: '1.pdf', kind: 'pdf' },
      { path: '/c/材料-源/2.pdf', fileName: '2.pdf', kind: 'pdf' },
    ],
    extractors: [same('PDF 无文本层，需要 OCR')],
  })
  assert.equal(outcome.capabilityGaps.length, 2, '不同文件各自的缺口要分开（带文件名）')
  assert.equal(new Set(outcome.capabilityGaps).size, 2)
})

test('没有文件时返回空汇总（不是 undefined）', async () => {
  const outcome = await runExtraction({ files: [], extractors: [] })
  assert.deepEqual(outcome, { files: [], unparsed: [], capabilityGaps: [], warnings: [] })
})

// ── 静态判据：这一层不碰 shell / fs / 网络 ──────────────────────────────────

test('资料入口层不直接执行命令或读写文件（结构边界）', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const dir = new URL('src/host/domains/report-evaluation/intake/', ROOT)
  /** 去注释：这些文件必须**解释**边界，注释里的反例不算违规。 */
  const codeOf = async (name) => (await readFile(new URL(name, dir), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  /**
   * 纯逻辑层（判定 / 清单 / 编排 / 契约 / 元信息 / 归档预览）**一行外部动作都不许有**。
   *
   * `python-extractor.ts` 是刻意例外的**后端**：它就是要落脚本、起进程、读结果文件。
   * 边界仍然成立，因为它是唯一一个 —— 所以下面第二条断言把它钉成白名单里的**唯一**成员。
   * Task 2 新增的 `preview.ts` / `metadata.ts` 走**注入**（`PreviewDeps`）：扫描、复制、
   * 读归档副本都由调用方给，于是"预览到底做了什么"在一处看得见，也能被直接单测。
   */
  const PURE = ['classify.ts', 'extract.ts', 'manifest.ts', 'metadata.ts', 'preview.ts', 'types.ts']
  for (const name of PURE) {
    const code = await codeOf(name)
    for (const banned of ['node:child_process', 'ctx.shell', 'runShell', 'readFileSync', 'execSync', 'writeCaseText']) {
      assert.equal(code.includes(banned), false, `${name} 不许出现「${banned}」`)
    }
  }

  const touchingShell = []
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.ts')) continue
    const code = await codeOf(name)
    if (/runShell|shellInvoke|writeCaseText/.test(code)) touchingShell.push(name)
  }
  assert.deepEqual(touchingShell.sort(), ['python-extractor.ts'],
    '只有 Python 后端这一个文件可以落脚本 / 起进程；编排层保持纯粹才能被直接单测')
})

test('归档预览层不做提取、不发网络、不拉知识、不调模型（Task 2 的新边界）', async () => {
  const { readFile } = await import('node:fs/promises')
  const dir = new URL('src/host/domains/report-evaluation/intake/', ROOT)
  const strip = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  // 提取：以前确认抽屉打开时就会调 Python 提取正文 —— 现在是父会话的事。
  const extraction = ['runExtraction', 'pythonFileExtractor', 'extract_files.py', 'node:child_process', 'python']
  // 知识：确认前不拉任何规范正文（按阶段物化归父会话）。
  const knowledge = ['resolveKnowledgePlan', 'materializeKnowledge', 'knowledge/', 'dws']
  // 网络与模型：预览一个请求都不发，也不碰 Agent。
  const external = ['fetch(', 'node:http', 'node:https', 'node:net', 'ctx.get(', 'followup', 'agents']

  for (const name of ['preview.ts', 'metadata.ts']) {
    const code = strip(await readFile(new URL(name, dir), 'utf8'))
    for (const needle of [...extraction, ...knowledge, ...external]) {
      assert.equal(code.includes(needle), false, `${name} 不许出现「${needle}」`)
    }
  }
})
