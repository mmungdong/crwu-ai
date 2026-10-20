/**
 * Valuation intake (revision 2): only asset type and method are required.
 *
 * Positive zero-input cases are expected to fail against the current file-required
 * branches; safety cases keep the attribute and scan guards. Assertions use the real
 * state machine and controller, never source regexes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)

const state = await import(new URL(
  'src/client/modules/report-evaluation/model/valuation-state.ts', ROOT).href)
const { createReportEvaluationController } = await import(new URL(
  'src/client/modules/report-evaluation/controller.ts', ROOT).href)

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

/** Minimal valid revision-2 draft: only the two required choices are set. */
function zeroFileDraft(patch = {}) {
  return state.initialValuationState({ assetType: 'real-estate', method: 'market', ...patch })
}

/** Honest Host receipt for a zero-file intake; Host-side archival is covered separately. */
const ZERO_FILE_PREVIEW = {
  ok: true,
  error: '',
  errorKind: '',
  requestId: 'valuation-1',
  previewId: 'p-zero',
  projectId: 'p-zero',
  casePath: '/cases/p-zero',
  inputDigest: 'sha256:zero-file-digest',
  assetType: 'real-estate',
  methodRequest: 'market',
  baseDate: null,
  purpose: null,
  valueType: null,
  templateFileId: null,
  supplementalPrompt: '',
  files: [],
  fileCount: 0,
  overLimit: false,
  skipped: [],
  capabilityGaps: [],
  createdAt: '2026-10-19T00:00:00.000Z',
  expiresAt: '2026-10-19T00:30:00.000Z',
}

/** Non-empty selected state (scanning/failed/over-limit/truncated) for the safety guards. */
function selectedDraft(patch = {}) {
  return zeroFileDraft({
    selection: ['/synthetic/资料'],
    files: [{
      path: '/synthetic/资料', name: '资料', dirHint: '', kind: 'directory',
      sizeBytes: 0, status: 'scanned', reason: '', fileCount: 1,
    }],
    fileRows: [{
      path: '/synthetic/资料/权属资料.pdf', name: '权属资料.pdf', kind: 'pdf',
      sizeBytes: 10, parentPath: '/synthetic/资料', state: 'included',
    }],
    scanState: 'ready',
    fileCount: 1,
    readableCount: 1,
    ...patch,
  })
}

test('只选资产类型与评估方法、没有任何资料的草稿可以准备确认', () => {
  const draft = zeroFileDraft()
  assert.equal(draft.phase, 'draft')
  assert.equal(draft.selection.length, 0, '本用例刻意不带任何选择')
  assert.equal(draft.files.length, 0)
  assert.equal(draft.fileRows.length, 0)
  assert.equal(draft.scanState, 'idle', '空草稿不应被伪装成“已扫描可读”')
  assert.equal(draft.readableCount, 0)

  assert.equal(state.startDisabledReason(draft), '', '两个必选项已选，空资料不应再拦启动')

  const prepared = state.beginPrepare(draft, 1)
  assert.equal(prepared.ok, true, prepared.error)
  assert.equal(prepared.state.phase, 'preparing-confirmation')
  assert.equal(prepared.state.assetType, 'real-estate')
  assert.equal(prepared.state.method, 'market')
  assert.deepEqual(prepared.state.selection, [], '准备阶段保留“零资料”这个事实，不补假文件')
  assert.equal(prepared.state.files.length, 0)
  assert.equal(prepared.state.readableCount, 0)
  assert.equal(prepared.state.scanState, 'idle', '零资料是主动留空，不是一次“扫描成功”')
})

test('市场法/收益法/成本法都能在目的、价值类型、日期、补充要求全空时准备', () => {
  for (const method of ['market', 'income', 'cost']) {
    const draft = zeroFileDraft({
      method,
      purpose: '',
      valueType: '',
      baseDate: '',
      supplementalPrompt: '',
    })
    assert.equal(state.startDisabledReason(draft), '', `${method} 的全空可选项不应拦启动`)
    const prepared = state.beginPrepare(draft, 1)
    assert.equal(prepared.ok, true, `${method}: ${prepared.error}`)
    assert.equal(prepared.state.phase, 'preparing-confirmation', method)
    assert.equal(prepared.state.method, method)
    assert.equal(prepared.state.purpose, '')
    assert.equal(prepared.state.valueType, '')
    assert.equal(prepared.state.baseDate, '')
    assert.equal(prepared.state.supplementalPrompt, '')
  }
})

test('controller 对零资料只发一次 intake(paths: []) 并进入确认阶段', async () => {
  const calls = { intake: [], start: 0 }
  const port = {
    fileInput: async () => [],
    scan: async () => ({ ok: true, items: [], files: [], fileCount: 0, overLimit: false, skipped: [], skippedCount: 0 }),
    intake: async (input) => {
      calls.intake.push(input)
      return { ...ZERO_FILE_PREVIEW, requestId: input.requestId }
    },
    start: async () => { calls.start += 1; return { ok: false, error: '不应进入交接' } },
    openSession: async () => ({ ok: true, error: '' }),
  }
  const controller = createReportEvaluationController(port, { initial: zeroFileDraft() })

  controller.preparePreview()
  await tick()

  assert.equal(calls.intake.length, 1, '一次确认只发一次准备请求')
  const request = calls.intake[0]
  assert.deepEqual(request.paths, [], '零资料必须原样提交空路径，而不是编一份清单')
  assert.deepEqual(request.excluded, [])
  assert.equal(request.templatePath, '')
  assert.equal(request.assetType, 'real-estate')
  assert.equal(request.method, 'market')
  assert.equal(request.baseDate, '')
  assert.equal(request.purpose, '')
  assert.equal(request.valueType, '')
  assert.equal(request.supplementalPrompt, '')

  const after = controller.getState()
  assert.equal(after.phase, 'confirmation', after.error)
  assert.equal(after.preview?.projectId, 'p-zero')
  assert.equal(after.preview?.fileCount, 0)
  assert.equal(after.preview?.files.length, 0)
  assert.deepEqual(after.selection, [])
  assert.equal(calls.start, 0, '确认阶段不得自动开始交接')
})

test('缺资产类型或方法、以及未知枚举仍然被拒绝', () => {
  for (const patch of [
    { assetType: '' },
    { assetType: 'auto' },
    { assetType: 'land' },
    { method: '' },
    { method: 'auto' },
    { method: 'income-v2' },
  ]) {
    const draft = zeroFileDraft(patch)
    assert.notEqual(state.startDisabledReason(draft), '', JSON.stringify(patch))
    assert.equal(state.beginPrepare(draft, 1).ok, false, JSON.stringify(patch))
  }
})

test('扫描中、扫描失败、超限与截断清单仍然阻止准备', () => {
  for (const patch of [
    { scanState: 'scanning' },
    { scanState: 'failed', scanError: '读取资料失败' },
    { overLimit: true, fileCount: 31, limit: 30 },
    { truncated: true },
  ]) {
    const draft = selectedDraft(patch)
    assert.notEqual(state.startDisabledReason(draft), '', JSON.stringify(patch))
    assert.equal(state.beginPrepare(draft, 1).ok, false, JSON.stringify(patch))
  }
})
