/**
 * Host-side zero-file valuation intake (revision 2).
 *
 * With a valid asset type + method, paths: [] must produce an honest zero-file
 * archived preview (real identity/digest, no phantom files, no copy/read work), and
 * an independent xlsx template must be scannable/archivable on its own. Current
 * file-required branches are expected to reject these positive cases.
 *
 * Safety guards: invalid asset/method fail before any directory or archive action;
 * explicit all-skipped, over-limit, truncated and scan-failure inputs still reject.
 * Intake cases use only the real preparePreview through its existing PreviewDeps; a
 * final regression pins durable zero-file project-record restoration.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../../', import.meta.url)
const {
  preparePreview,
  PreviewRegistry,
  valuationInputDigest,
} = await import(new URL('src/host/domains/report-evaluation/intake/preview.ts', ROOT).href)
const { scanSelection, nodeLocalAuditFs } = await import(new URL(
  'src/host/domains/local-audit/scan.ts', ROOT).href)
const { WORKBENCH_PROTOCOL } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { VALUATION_INPUT_SCHEMA_VERSION } = await import(new URL(
  'src/shared/contracts/valuation-project.ts', ROOT).href)
const {
  PROJECT_RECORD_SCHEMA_VERSION,
  buildProjectRecord,
  projectRecordOf,
} = await import(new URL(
  'src/host/domains/report-evaluation/lifecycle/project-record.ts', ROOT).href)

const TEMPS = []
test.after(() => {
  for (const dir of TEMPS) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMPS.push(dir)
  return dir
}

function sourceDir(spec) {
  const dir = tempDir('crwu-valuation-empty-src-')
  for (const [name, content] of spec) writeFileSync(join(dir, name), content)
  return dir
}

const NOW = new Date('2026-10-19T08:00:00.000Z')

/** Successful empty scan shape for an intentional zero-material intake. */
function emptyScan() {
  return {
    ok: true, error: '', errorKind: '', items: [], files: [], skipped: [],
    fileCount: 0, limit: 30, overLimit: false, readableCount: 0,
    skippedCount: 0, truncated: false,
  }
}

/**
 * Real scanning plus in-memory archival, following the existing handoff fixture.
 * Source files are real so scanSelection runs; counters prove no byte work happens
 * for a zero-file intake.
 */
function makeHarness() {
  const workspace = tempDir('crwu-valuation-empty-ws-')
  const archive = new Map()
  const dirs = new Set()
  const previews = new PreviewRegistry()
  const mintedIds = []
  const scanCalls = []
  const counts = { copy: 0, readSource: 0, readArchive: 0, stat: 0 }

  const previewDeps = {
    previews,
    scan: async (selection, excluded) => {
      scanCalls.push({ selection: [...selection], excluded: [...(excluded ?? [])] })
      if (selection.length === 0) return emptyScan()
      return await scanSelection(selection, nodeLocalAuditFs(), { excluded: excluded ?? [] })
    },
    canonicalPath: (path) => nodeLocalAuditFs().canonical(path),
    readSourceBytes: async (path) => {
      counts.readSource += 1
      return new Uint8Array(readFileSync(path))
    },
    statSource: async (path) => {
      counts.stat += 1
      const info = statSync(path)
      return { createdAt: null, modifiedAt: info.mtime.toISOString(), readable: true }
    },
    ensureDirectories: async ({ projectDir, materialDir }) => {
      dirs.add(projectDir)
      dirs.add(materialDir)
      return { ok: true, error: '', errorKind: '' }
    },
    copyMaterial: async ({ sourcePath, archivePath }) => {
      counts.copy += 1
      const bytes = readFileSync(sourcePath)
      archive.set(archivePath, Buffer.from(bytes))
      return { ok: true, error: '', errorKind: '', sizeBytes: bytes.length }
    },
    readArchiveBytes: async (path) => {
      counts.readArchive += 1
      const bytes = archive.get(path)
      if (bytes === undefined) throw new Error(`归档副本不存在：${path}`)
      return new Uint8Array(bytes)
    },
    projectDirOf: (projectId) => `${workspace}/${projectId}`,
    mintProjectId: () => {
      const id = `估值-20261019-080000-${String(mintedIds.length + 1).padStart(4, '0')}`
      mintedIds.push(id)
      return id
    },
    now: () => NOW,
  }

  return { workspace, archive, dirs, previews, mintedIds, scanCalls, counts, previewDeps }
}

/** Required conditions since protocol 39; paths defaults to the allowed empty intake. */
function request(patch = {}) {
  return {
    requestId: 'req-empty',
    paths: [],
    assetType: 'real-estate',
    method: 'market',
    baseDate: '',
    purpose: '',
    valueType: '',
    supplementalPrompt: '',
    ...patch,
  }
}

/** Valid durable project-record payload; files stay empty for the zero-material run. */
function projectRecordPayload(patch = {}) {
  return {
    schemaVersion: PROJECT_RECORD_SCHEMA_VERSION,
    protocolVersion: WORKBENCH_PROTOCOL,
    inputSchemaVersion: VALUATION_INPUT_SCHEMA_VERSION,
    valuationId: '估值-empty-1',
    projectId: '估值-empty-1',
    previewId: '估值-empty-1',
    casePath: '/workspace/估值-empty-1',
    workspaceId: 'w1',
    workspacePath: '/workspace',
    sessionId: 'session-empty-1',
    planIds: [],
    phase: 'draft',
    assetType: 'real-estate',
    methodRequest: 'market',
    baseDate: null,
    purpose: null,
    valueType: null,
    templateFileId: null,
    supplementalPrompt: '',
    inputDigest: `sha256:${'a'.repeat(64)}`,
    files: [],
    createdAt: '2026-10-19T08:00:00.000Z',
    ...patch,
  }
}

test('零资料 + 全空可选项生成诚实的零文件归档预览，且同 requestId 幂等', async () => {
  const h = makeHarness()
  const preview = await preparePreview(request({ requestId: 'req-zero' }), h.previewDeps)

  assert.equal(preview.ok, true, preview.error)
  assert.equal(preview.requestId, 'req-zero')
  assert.equal(preview.fileCount, 0)
  assert.deepEqual(preview.files, [], '零资料预览不许出现幽灵文件')
  assert.equal(preview.overLimit, false)
  assert.deepEqual(preview.skipped, [])
  assert.equal(preview.templateFileId, null)
  assert.equal(preview.assetType, 'real-estate')
  assert.equal(preview.methodRequest, 'market')
  assert.equal(preview.baseDate, null)
  assert.equal(preview.purpose, null)
  assert.equal(preview.valueType, null)
  assert.equal(preview.supplementalPrompt, '')

  assert.ok(preview.previewId !== '', '零资料也必须有真实项目身份')
  assert.equal(preview.previewId, preview.projectId)
  assert.equal(preview.casePath, `${h.workspace}/${preview.projectId}`)
  assert.ok(h.dirs.has(preview.casePath), '需要建出项目目录，尽管没有资料可归档')
  assert.match(preview.inputDigest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(preview.inputDigest, valuationInputDigest({
    assetType: 'real-estate',
    methodRequest: 'market',
    baseDate: null,
    purpose: null,
    valueType: null,
    templateFileId: null,
    supplementalPrompt: '',
    files: [],
  }), '摘要必须是真实输入身份，不是随手拼的占位值')
  assert.equal(h.archive.size, 0)
  assert.deepEqual(h.counts, { copy: 0, readSource: 0, readArchive: 0, stat: 0 },
    '没有资料就不允许复制 / 读源 / 读归档 / stat')
  assert.equal(h.mintedIds.length, 1)

  const again = await preparePreview(request({ requestId: 'req-zero' }), h.previewDeps)
  assert.equal(again.ok, true, again.error)
  assert.equal(again.previewId, preview.previewId, '同一 requestId 必须复用同一份预览')
  assert.equal(again.projectId, preview.projectId)
  assert.equal(again.inputDigest, preview.inputDigest)
  assert.equal(h.mintedIds.length, 1, '幂等重试不许再铸一个项目目录')
  assert.deepEqual(h.counts, { copy: 0, readSource: 0, readArchive: 0, stat: 0 })
})

test('独立 xlsx 模板可单独构成资料清单并真实归档', async () => {
  const h = makeHarness()
  const directory = sourceDir([['计算表.xlsx', 'synthetic-template-bytes']])
  const templatePath = join(directory, '计算表.xlsx')

  const preview = await preparePreview(request({
    requestId: 'req-template-only',
    paths: [],
    templatePath,
  }), h.previewDeps)

  assert.equal(preview.ok, true, preview.error)
  assert.equal(preview.fileCount, 1, '模板本身是一份真实归档资料')
  assert.equal(preview.files.length, 1)
  assert.equal(preview.files[0].fileName, '计算表.xlsx')
  assert.equal(preview.templateFileId, preview.files[0].fileId, '模板角色绑定到归档后的 fileId')
  assert.equal(h.archive.size, 1, '模板必须真的被归档，而不是只登记路径')
  assert.equal(h.counts.copy, 1)
  assert.match(preview.inputDigest, /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(preview.inputDigest, valuationInputDigest({
    assetType: 'real-estate',
    methodRequest: 'market',
    baseDate: null,
    purpose: null,
    valueType: null,
    templateFileId: null,
    supplementalPrompt: '',
    files: [],
  }), '模板角色改变了输入身份')

  assert.equal(h.scanCalls.length, 1)
  assert.deepEqual(h.scanCalls[0].selection, [templatePath],
    '模板要进入同一次扫描，不要求员工再单独选一份资料')
  assert.deepEqual(h.scanCalls[0].excluded, [])
})

test('非法/缺失资产类型或方法在任何目录与归档动作之前失败', async () => {
  for (const patch of [
    { assetType: '' },
    { assetType: 'auto' },
    { assetType: 'land' },
    { method: '' },
    { method: 'auto' },
    { method: 'income-v2' },
  ]) {
    const h = makeHarness()
    const preview = await preparePreview(request({ requestId: 'req-invalid', ...patch }), h.previewDeps)
    assert.equal(preview.ok, false, JSON.stringify(patch))
    assert.equal(preview.errorKind, 'input-invalid', JSON.stringify(patch))
    assert.equal(h.dirs.size, 0, `${JSON.stringify(patch)} 不许建目录`)
    assert.equal(h.archive.size, 0, `${JSON.stringify(patch)} 不许归档`)
    assert.equal(h.mintedIds.length, 0, `${JSON.stringify(patch)} 不许铸项目号`)
  }
})

test('显式给出全跳过 / 超限 / 截断 / 扫描失败清单仍然拒绝，不当作“故意无资料”', async () => {
  const cases = [
    {
      name: 'all-skipped',
      scan: () => ({
        ...emptyScan(),
        skipped: [{ relativePath: '不可读.pdf', reason: '权限不足' }],
        skippedCount: 1,
      }),
      error: /没有可读取的普通文件/,
    },
    {
      name: 'over-limit',
      scan: () => ({
        ...emptyScan(),
        files: Array.from({ length: 31 }, (_, index) => ({
          name: `f${String(index)}.pdf`, sourcePath: `/synthetic/f${String(index)}.pdf`, sizeBytes: 1,
        })),
        fileCount: 31,
        overLimit: true,
      }),
      error: /31/,
    },
    {
      name: 'truncated',
      scan: () => ({
        ...emptyScan(),
        files: [{ name: 'a.pdf', sourcePath: '/synthetic/a.pdf', sizeBytes: 1 }],
        fileCount: 1,
        truncated: true,
      }),
      error: /没有完整读取|分批/,
    },
    {
      name: 'scan-failed',
      scan: () => ({ ...emptyScan(), ok: false, error: '扫描结果不完整', errorKind: 'infrastructure' }),
      error: /扫描结果不完整/,
    },
  ]

  for (const item of cases) {
    const h = makeHarness()
    h.previewDeps.scan = async () => item.scan()
    const preview = await preparePreview(request({ requestId: `req-${item.name}`, paths: ['/synthetic/入口'] }), h.previewDeps)
    assert.equal(preview.ok, false, item.name)
    assert.match(preview.error, item.error, item.name)
    assert.equal(h.dirs.size, 0, `${item.name} 不许建目录`)
    assert.equal(h.archive.size, 0, `${item.name} 不许归档`)
    assert.equal(h.counts.copy, 0, item.name)
  }
})

test('durable zero-file project record round-trips; bad files and dangling template fail', () => {
  const record = buildProjectRecord(projectRecordPayload())
  assert.match(record.recordDigest, /^sha256:[0-9a-f]{64}$/)

  const malformed = projectRecordOf({ ...record, files: 'not-an-array' })
  assert.equal(malformed.ok, false, 'files must be an array even when empty')
  assert.notEqual(malformed.error, '')

  const dangling = projectRecordOf(buildProjectRecord(projectRecordPayload({ templateFileId: 'material-999' })))
  assert.equal(dangling.ok, false, 'a template id must reference an archived xlsx entry')
  assert.notEqual(dangling.error, '')

  const read = projectRecordOf(JSON.parse(JSON.stringify(record)))
  assert.equal(read.ok, true, read.error)
  assert.deepEqual(read.record.files, [], 'an intentional zero-file run must survive restore')
  assert.equal(read.record.templateFileId, null)
  assert.equal(read.record.projectId, record.projectId)
  assert.equal(read.record.inputDigest, record.inputDigest)
  assert.equal(read.record.protocolVersion, WORKBENCH_PROTOCOL)
})
