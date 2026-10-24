/**
 * 发布前的 OCR 覆盖率门禁（`requireCoveragePass`）。
 *
 * 2026-10-22 现场：交付校验被跳过时，没有任何一道闸门阻止"没读完就送件"。
 * 2026-10-23 复查：旧实现把所有读取失败折成空串，于是"文件服务不可用 / 权限拒绝"
 * 会被当成"本轮不需要 OCR"直接放行 —— 这里钉住"读不出来一律 fail-closed"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { requireCoveragePass } = await import(
  new URL('src/host/tools/report-audit/coverage-snapshot.ts', ROOT).href
)

const CASE = '/work/中瑞世联工作空间/la-1-abc'

/**
 * 内存 fs：`stat` 按存在性返回，`readText` 只读存在的文件。
 *
 * `fault(path)` 可以注入非"不存在"的故障（权限拒绝、fs 未装配），用于验证 fail-closed。
 */
function makeCtx(files = {}, options = {}) {
  const store = new Map(Object.entries(files))
  const fault = options.fault
  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      const message = fault?.(target.targetKey)
      if (message !== undefined) throw new Error(message)
      return store.has(target.targetKey) ? { type: 'file' } : undefined
    },
    async readText(target) {
      const value = store.get(target.targetKey)
      if (value === undefined) throw new Error(`ENOENT: ${target.targetKey}`)
      return value
    },
  }
  return { ctx: { get: (name) => (name === 'fs' ? fs : undefined) }, store }
}

function coverageOf(gateStatus, status = 'computed', blocks = []) {
  return JSON.stringify({ schemaVersion: 1, status, gate: { status: gateStatus, blocks } })
}

test('没有 OCR 需求时放行', async () => {
  const { ctx } = makeCtx()
  const result = await requireCoveragePass(ctx, CASE)
  assert.equal(result.ok, true, result.error)
})

test('有 OCR 需求但没有快照：拒绝并指向 ocr_coverage.py', async () => {
  const { ctx } = makeCtx({
    [`${CASE}/材料盘点.json`]: JSON.stringify({
      ocrRequired: [{ path: '材料-源/工商资料/2003年.pdf', reason: 'no-text-layer' }],
    }),
  })
  const result = await requireCoveragePass(ctx, CASE)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'policy')
  assert.match(result.error, /ocr\/coverage\.json/)
  assert.match(result.error, /ocr_coverage\.py/)
})

test('门禁未通过：拒绝并把阻断项带回来', async () => {
  const { ctx } = makeCtx({
    [`${CASE}/ocr/coverage.json`]: coverageOf('blocked', 'computed', [
      { kind: 'partial-read', relativePath: '材料-源/车辆/登记证.pdf' },
    ]),
  })
  const result = await requireCoveragePass(ctx, CASE)
  assert.equal(result.ok, false)
  assert.match(result.error, /partial-read/)
  assert.match(result.error, /门禁未通过/)
})

test('门禁通过：放行', async () => {
  const { ctx } = makeCtx({ [`${CASE}/ocr/coverage.json`]: coverageOf('pass') })
  const result = await requireCoveragePass(ctx, CASE)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.status, 'pass')
})

test('缺索引的终态：指回 ocr_prepare.py', async () => {
  const { ctx } = makeCtx({
    [`${CASE}/ocr/coverage.json`]: JSON.stringify({
      schemaVersion: 1, status: 'index-missing', gate: { status: 'blocked', blocks: [] },
    }),
  })
  const result = await requireCoveragePass(ctx, CASE)
  assert.equal(result.ok, false)
  assert.match(result.error, /ocr_prepare\.py/)
})

test('快照读不出来：按基础设施失败，不当作通过', async () => {
  const { ctx } = makeCtx({ [`${CASE}/ocr/coverage.json`]: 'not-json' })
  const result = await requireCoveragePass(ctx, CASE)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
})

// ---------------------------------------------------------------- fail-closed

test('文件服务读不出来（权限拒绝）：基础设施失败，不许当成"没有 OCR"', async () => {
  const { ctx } = makeCtx({}, {
    fault: (path) => (path.endsWith('coverage.json') ? 'EACCES: permission denied' : undefined),
  })
  const result = await requireCoveragePass(ctx, CASE)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.match(result.error, /可重试/)
})

test('没有文件服务：基础设施失败', async () => {
  const result = await requireCoveragePass({ get: () => undefined }, CASE)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
})

test('盘点损坏：基础设施失败（不能当成没有 ocrRequired）', async () => {
  const { ctx } = makeCtx({ [`${CASE}/材料盘点.json`]: '{ 不是 JSON' })
  const result = await requireCoveragePass(ctx, CASE)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.match(result.error, /材料盘点\.json/)
})

test('索引读不出来：基础设施失败', async () => {
  const { ctx } = makeCtx({}, {
    fault: (path) => (path.endsWith('index.json') ? 'EIO: i/o error' : undefined),
  })
  const result = await requireCoveragePass(ctx, CASE)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
})

test('本地审核（disclose）：strict 视图 blocked 但 effectiveStatus=pass 时放行', async () => {
  const { ctx } = makeCtx({
    [`${CASE}/ocr/coverage.json`]: JSON.stringify({
      schemaVersion: 1,
      status: 'computed',
      gate: {
        policy: 'disclose',
        status: 'blocked',
        effectiveStatus: 'pass',
        blocks: [{ kind: 'pending-pages', pendingPages: 12 }],
      },
    }),
  })
  const result = await requireCoveragePass(ctx, CASE)
  assert.equal(result.ok, true, result.error)
})
