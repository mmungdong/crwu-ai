/**
 * 工作簿重算与状态上限（设计稿 §10.3，计划 Task 9）。
 *
 * 这一层要挡住三种"看起来完成了"的假象，它们都源于同一个事实：
 * **openpyxl / DSH Python 不计算公式**，读回来的是上次保存时的缓存值。
 *
 * 1. 用 openpyxl 读到缓存值就宣称"重算通过"；
 * 2. 把"已写入公式"当成"已算出数值"；
 * 3. 打开一次 LibreOffice 就宣告成功（进程起来 ≠ 算完 ≠ 与 JSON 一致）。
 *
 * 所以：没有经验证的本地表格程序 → `unavailable`，报告上限被压到 `partial`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const { createWorkbookRecalculator, statusCeilingFromRecalculation } = await import(
  new URL('src/host/domains/report-evaluation/delivery/recalculation.ts', ROOT).href)

const { engineCommandOf, readBackCellsJson, recalcProvidersOf, runConfiguredEngine } = await import(
  new URL('src/host/domains/report-evaluation/delivery/recalculation-engine.ts', ROOT).href)

const INPUT = {
  taskId: 'plan-001-realestate',
  workbookRelativePath: '估值底稿.xlsx',
  caseRoot: '/cases/space/项目-001/方案/plan-001',
  expected: [
    { objectId: 'object-001', unitPrice: '42000', totalValue: '3749760' },
    { objectId: 'object-002', unitPrice: '39800', totalValue: '6352120' },
  ],
}

test('没有重算 provider → unavailable，且永远不是 verified', async () => {
  const recalculator = createWorkbookRecalculator({
    probe: async () => [],
    run: async () => { throw new Error('不该执行') },
  })
  const outcome = await recalculator.recalculate(INPUT)
  assert.equal(outcome.state, 'unavailable')
  assert.equal(outcome.verified, false)
  assert.equal(outcome.providerId, '')
  assert.match(outcome.reason, /待重算/)
  // 关键：状态上限必须是 partial —— 没核对过的数字不能 completed。
  assert.equal(statusCeilingFromRecalculation(outcome), 'partial')
})

test('探测本身失败也按"没有 provider"处理，不假装可用', async () => {
  const recalculator = createWorkbookRecalculator({
    probe: async () => { throw new Error('broker 拒绝') },
    run: async () => { throw new Error('不该执行') },
  })
  assert.deepEqual(await recalculator.providers(), [])
  assert.equal((await recalculator.recalculate(INPUT)).state, 'unavailable')
})

test('重算后回读一致才 verified，状态上限才是 completed', async () => {
  const seen = []
  const recalculator = createWorkbookRecalculator({
    probe: async () => [{ id: 'libreoffice.local', detail: 'soffice' }],
    run: async (input) => {
      seen.push(input)
      return {
        ok: true,
        observed: [
          { objectId: 'object-001', unitPrice: '42000', totalValue: '3749760' },
          // 尾随零差异不算不一致（同一个数）。
          { objectId: 'object-002', unitPrice: '39800.0', totalValue: '6352120.00' },
        ],
      }
    },
    now: () => '2026-10-14T00:00:00Z',
  })
  const outcome = await recalculator.recalculate(INPUT)
  assert.equal(outcome.state, 'recalculated')
  assert.equal(outcome.verified, true)
  assert.equal(outcome.providerId, 'libreoffice.local')
  assert.deepEqual(outcome.mismatches, [])
  assert.equal(statusCeilingFromRecalculation(outcome), 'completed')
  // 回读的必须是**重算之后从文件里读回来的**值，abspath 由受控案例目录拼出。
  assert.equal(seen[0].workbookAbsolutePath, '/cases/space/项目-001/方案/plan-001/估值底稿.xlsx')
})

test('回读与 JSON 不一致 → recalculated 但 verified=false，报告只能 partial', async () => {
  const recalculator = createWorkbookRecalculator({
    probe: async () => [{ id: 'excel.local', detail: 'excel' }],
    run: async () => ({
      ok: true,
      observed: [
        { objectId: 'object-001', unitPrice: '42000', totalValue: '3749760' },
        { objectId: 'object-002', unitPrice: '39800', totalValue: '9999999' },
      ],
    }),
  })
  const outcome = await recalculator.recalculate(INPUT)
  assert.equal(outcome.state, 'recalculated')
  assert.equal(outcome.verified, false)
  assert.match(outcome.mismatches.join('；'), /object-002/)
  assert.match(outcome.reason, /不一致/)
  assert.equal(statusCeilingFromRecalculation(outcome), 'partial')
})

test('读不到某个对象的数值也算不一致（"读不到"≠"对得上"）', async () => {
  const recalculator = createWorkbookRecalculator({
    probe: async () => [{ id: 'excel.local', detail: 'excel' }],
    run: async () => ({ ok: true, observed: [{ objectId: 'object-001', unitPrice: '42000', totalValue: '3749760' }] }),
  })
  const outcome = await recalculator.recalculate(INPUT)
  assert.equal(outcome.verified, false)
  assert.match(outcome.mismatches.join('；'), /读不到/)
})

// ── 引擎探测与执行（协议 39）────────────────────────────────────────────────

test('引擎路径只来自部署配置：空串 = 没有引擎，绝不扫 PATH', () => {
  const none = recalcProvidersOf({ valuation: { recalculation: { enginePath: '' } } })
  assert.deepEqual(none, [])
  const noneAtAll = recalcProvidersOf(undefined)
  assert.deepEqual(noneAtAll, [], '配置缺失也是"没有引擎"，不是"猜一个"')
  const configured = recalcProvidersOf({ valuation: { recalculation: { enginePath: '/opt/spreadsheet/bin/soffice' } } })
  assert.equal(configured.length, 1)
  assert.equal(configured[0].id, 'libreoffice.local')
  // detail 只回程序名，不回绝对路径（配置路径属于本机事实，不进模型可见结果）。
  assert.match(configured[0].detail, /soffice/)
  assert.equal(configured[0].detail.includes('/opt/spreadsheet'), false)
})

test('引擎命令由 Host 拼：固定参数 + 只把底稿与临时目录写进去', () => {
  const command = engineCommandOf({
    enginePath: '/opt/spreadsheet/bin/soffice',
    workbookAbsolutePath: '/cases/a/方案/p/估值底稿.xlsx',
    scratchAbsolutePath: '/cases/a/方案/p/.recalc',
  }, 'darwin-arm64')
  assert.match(command, /--headless/)
  assert.match(command, /--norestore/)
  assert.match(command, /--convert-to xlsx/)
  assert.match(command, /--outdir/)
  assert.match(command, /估值底稿\.xlsx/)
  // 两个**路径参数**都被引号包住（路径里有空格也不会被拆成两个参数）。
  assert.match(command, /'\/cases\/a\/方案\/p\/\.recalc'/)
  assert.match(command, /'\/cases\/a\/方案\/p\/估值底稿\.xlsx'/)
})

test('回读入参是「对象 → 位置」，位置由调用方按模板填写说明给', () => {
  const json = readBackCellsJson([
    { objectId: 'object-001', unitPriceCell: '估值结果汇总!J5', totalValueCell: '估值结果汇总!L5' },
  ])
  assert.deepEqual(JSON.parse(json), {
    'object-001': { unitPrice: '估值结果汇总!J5', totalValue: '估值结果汇总!L5' },
  })
})

test('runConfiguredEngine：没有引擎 / 没有位置 / 引擎失败 / 回读输出不是 JSON，各自如实失败', async () => {
  const ports = (patch = {}) => ({
    recalculatedAbsolutePath: '/cases/a/方案/p/.recalc/估值底稿.xlsx',
    scriptPath: '/cases/a/scripts/read_workbook_values.py',
    runEngine: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', error: '' }),
    runScript: async () => ({ ok: true, stdout: '{"observed":[],"problems":[]}', stderr: '', error: '' }),
    ...patch,
  })
  const request = {
    enginePath: '/opt/spreadsheet/bin/soffice',
    workbookAbsolutePath: '/cases/a/方案/p/估值底稿.xlsx',
    scratchAbsolutePath: '/cases/a/方案/p/.recalc',
    observations: [{ objectId: 'object-001', unitPriceCell: '汇总!J5', totalValueCell: '汇总!L5' }],
  }

  const noEngine = await runConfiguredEngine({ ...request, enginePath: '' }, ports(), 'darwin-arm64')
  assert.equal(noEngine.ok, false)
  assert.match(noEngine.error, /没有配置表格计算程序/)

  const noCells = await runConfiguredEngine({ ...request, observations: [] }, ports(), 'darwin-arm64')
  assert.equal(noCells.ok, false)
  assert.match(noCells.error, /不许猜位置/)

  const engineFailed = await runConfiguredEngine(request, ports({
    runEngine: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'soffice: 转换失败', error: '' }),
  }), 'darwin-arm64')
  assert.equal(engineFailed.ok, false)
  assert.match(engineFailed.error, /没有成功重算/)
  assert.match(engineFailed.error, /soffice: 转换失败/, '引擎自己的原因要原样带回')

  const garbage = await runConfiguredEngine(request, ports({
    runScript: async () => ({ ok: true, stdout: '不是 JSON', stderr: '', error: '' }),
  }), 'darwin-arm64')
  assert.equal(garbage.ok, false)
  assert.match(garbage.error, /输出不是 JSON/)

  const good = await runConfiguredEngine(request, ports({
    runScript: async () => ({
      ok: true, stderr: '', error: '',
      stdout: JSON.stringify({ observed: [{ objectId: 'object-001', unitPrice: '39800', totalValue: null }], problems: ['object-001：汇总!L5 是公式但没有缓存值'] }),
    }),
  }), 'darwin-arm64')
  assert.equal(good.ok, true)
  assert.deepEqual(good.observed, [{ objectId: 'object-001', unitPrice: '39800', totalValue: null }])
  assert.equal(good.problems.length, 1)
})

test('第一个 provider 失败时换下一个；全部失败 → failed（底稿保留公式）', async () => {
  const tried = []
  const recalculator = createWorkbookRecalculator({
    probe: async () => [
      { id: 'excel.local', detail: 'excel' },
      { id: 'libreoffice.local', detail: 'soffice' },
    ],
    run: async (input) => {
      tried.push(input.provider.id)
      if (input.provider.id === 'excel.local') return { ok: false, error: '未安装' }
      return {
        ok: true,
        observed: [
          { objectId: 'object-001', unitPrice: '42000', totalValue: '3749760' },
          { objectId: 'object-002', unitPrice: '39800', totalValue: '6352120' },
        ],
      }
    },
  })
  const outcome = await recalculator.recalculate(INPUT)
  assert.deepEqual(tried, ['excel.local', 'libreoffice.local'])
  assert.equal(outcome.verified, true)

  const allFail = createWorkbookRecalculator({
    probe: async () => [{ id: 'excel.local', detail: 'excel' }],
    run: async () => { throw new Error('超时') },
  })
  const failed = await allFail.recalculate(INPUT)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.verified, false)
  assert.match(failed.reason, /partial/)
  assert.equal(statusCeilingFromRecalculation(failed), 'partial')

  // 探测到 provider 但一个都没成功，不能悄悄退化成 unavailable 的措辞。
  assert.equal(failed.providerId, '')
})
