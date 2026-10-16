/**
 * Pure date-value contract (src/client/ui/components/date-value.ts).
 * Runs the same assertions in two TZ child processes (UTC+14 / UTC-10) so any local-time
 * conversion in the implementation shows up as a divergence. Uses the existing tsx loader;
 * no network or provider access.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../../../', import.meta.url)
const LOADER = new URL('tests/helpers/tsx-loader.mjs', ROOT)
const DATE_VALUE = new URL('src/client/ui/components/date-value.ts', ROOT)

/** Kiritimati = UTC+14, Adak = UTC-10. */
const TIMEZONES = ['Pacific/Kiritimati', 'America/Adak']

/**
 * Child script: load the source, run the same checks and report failures as JSON.
 * Written as a plain string to avoid clashing with the outer template interpolation.
 */
const CHILD_SCRIPT = `
import assert from 'node:assert/strict'

const loaderUrl = ${JSON.stringify(LOADER.href)}
const moduleUrl = ${JSON.stringify(DATE_VALUE.href)}
const failures = []
const check = (name, fn) => {
  try {
    fn()
  } catch (error) {
    failures.push({ name: name, message: String((error && error.message) || error) })
  }
}

let loaded = null
let loadError = ''
try {
  const loader = await import(loaderUrl)
  loader.registerTsxLoader()
  loaded = await import(moduleUrl)
} catch (error) {
  loadError = String((error && error.message) || error)
}

if (loaded === null) {
  process.stdout.write(JSON.stringify({ loaded: false, error: loadError, failures: failures }))
} else {
  const parseDateValue = loaded.parseDateValue
  const formatDateValue = loaded.formatDateValue
  const shiftMonth = loaded.shiftMonth
  const shiftYear = loaded.shiftYear

  check('导出 parseDateValue', () => { assert.equal(typeof parseDateValue, 'function', '必须导出 parseDateValue 函数') })
  check('导出 formatDateValue', () => { assert.equal(typeof formatDateValue, 'function', '必须导出 formatDateValue 函数') })
  check('导出 shiftMonth', () => { assert.equal(typeof shiftMonth, 'function', '必须导出 shiftMonth 函数') })
  check('导出 shiftYear', () => { assert.equal(typeof shiftYear, 'function', '必须导出 shiftYear 函数') })

  // ── parseDateValue: strict YYYY-MM-DD ────────────────────────────────────
  check('2024-02-29 合法（闰年）', () => {
    assert.deepEqual(parseDateValue('2024-02-29'), { year: 2024, month: 2, day: 29 })
  })
  check('2000-02-29 合法（四百年闰）', () => {
    assert.deepEqual(parseDateValue('2000-02-29'), { year: 2000, month: 2, day: 29 })
  })
  check('1900-02-29 非法（百年不闰）', () => { assert.equal(parseDateValue('1900-02-29'), null) })
  check('2026-02-29 非法（平年）', () => { assert.equal(parseDateValue('2026-02-29'), null) })
  check('2026-02-30 非法（不存在的日期，不许归一）', () => { assert.equal(parseDateValue('2026-02-30'), null) })
  check('月份越界拒绝', () => { assert.equal(parseDateValue('2026-13-01'), null) })
  check('日期 0 拒绝', () => { assert.equal(parseDateValue('2026-01-00'), null) })
  check('严格零填充：2026-1-01 拒绝', () => { assert.equal(parseDateValue('2026-1-01'), null) })
  check('严格零填充：2026-01-1 拒绝', () => { assert.equal(parseDateValue('2026-01-1'), null) })
  check('严格形状：20260101 拒绝', () => { assert.equal(parseDateValue('20260101'), null) })
  check('前导空白拒绝', () => { assert.equal(parseDateValue(' 2026-01-01'), null) })
  check('尾部空白拒绝', () => { assert.equal(parseDateValue('2026-01-01 '), null) })
  check('ISO 日期时间拒绝', () => { assert.equal(parseDateValue('2026-01-01T00:00:00Z'), null) })
  check('null 拒绝', () => { assert.equal(parseDateValue(null), null) })
  check('undefined 拒绝', () => { assert.equal(parseDateValue(undefined), null) })
  check('空串拒绝', () => { assert.equal(parseDateValue(''), null) })
  check('非字符串拒绝', () => { assert.equal(parseDateValue(20260101), null) })

  // ── formatDateValue: zero-pad valid parts, RangeError on invalid parts ───
  check('formatDateValue 零填充', () => {
    assert.equal(formatDateValue({ year: 2026, month: 1, day: 5 }), '2026-01-05')
  })
  check('formatDateValue 闰日', () => {
    assert.equal(formatDateValue({ year: 2024, month: 2, day: 29 }), '2024-02-29')
  })
  const badParts = [
    { year: 2026, month: 0, day: 1 },
    { year: 2026, month: 13, day: 1 },
    { year: 2026, month: 1, day: 0 },
    { year: 2026, month: 1, day: 32 },
    { year: 2026, month: 2, day: 29 },
    { year: 2026, month: 4, day: 31 },
    { year: 2026, month: 1, day: 1.5 },
    { year: 2026, month: 1, day: Number.NaN },
  ]
  for (const bad of badParts) {
    const label = 'formatDateValue 非法部件 ' + JSON.stringify(bad)
    check(label, () => { assert.throws(() => formatDateValue(bad), RangeError) })
  }

  // ── shiftMonth: month-end clamp and year crossing ───────────────────────
  check('shiftMonth 2026-01-31 +1 → 2026-02-28', () => { assert.equal(shiftMonth('2026-01-31', 1), '2026-02-28') })
  check('shiftMonth 2024-01-31 +1 → 2024-02-29', () => { assert.equal(shiftMonth('2024-01-31', 1), '2024-02-29') })
  check('shiftMonth 2026-03-31 -1 → 2026-02-28', () => { assert.equal(shiftMonth('2026-03-31', -1), '2026-02-28') })
  check('shiftMonth 2026-08-31 +1 → 2026-09-30', () => { assert.equal(shiftMonth('2026-08-31', 1), '2026-09-30') })
  check('shiftMonth 2026-12-31 +1 → 2027-01-31（跨年）', () => { assert.equal(shiftMonth('2026-12-31', 1), '2027-01-31') })
  check('shiftMonth 2026-01-31 -1 → 2025-12-31（跨年）', () => { assert.equal(shiftMonth('2026-01-31', -1), '2025-12-31') })
  check('shiftMonth +12 同月日', () => { assert.equal(shiftMonth('2026-05-15', 12), '2027-05-15') })
  check('shiftMonth delta 0 原样', () => { assert.equal(shiftMonth('2026-05-15', 0), '2026-05-15') })

  // ── shiftYear: leap-day clamp ───────────────────────────────────────────
  check('shiftYear 2024-02-29 +1 → 2025-02-28', () => { assert.equal(shiftYear('2024-02-29', 1), '2025-02-28') })
  check('shiftYear 2025-02-28 +1 → 2026-02-28', () => { assert.equal(shiftYear('2025-02-28', 1), '2026-02-28') })
  check('shiftYear 2024-02-29 +4 → 2028-02-29', () => { assert.equal(shiftYear('2024-02-29', 4), '2028-02-29') })
  check('shiftYear 2026-03-31 +1 → 2027-03-31', () => { assert.equal(shiftYear('2026-03-31', 1), '2027-03-31') })
  check('shiftYear 2026-01-01 -1 → 2025-01-01', () => { assert.equal(shiftYear('2026-01-01', -1), '2025-01-01') })
  check('shiftYear 1900-02-28 +1 → 1901-02-28', () => { assert.equal(shiftYear('1900-02-28', 1), '1901-02-28') })

  process.stdout.write(JSON.stringify({ loaded: true, failures: failures }))
}
`

/** Run the contract once in the given timezone and return the child's JSON report. */
function runDateContract(timezone) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
    env: { ...process.env, TZ: timezone },
    encoding: 'utf8',
  })
  if (result.error !== undefined) {
    return { loaded: false, error: String(result.error.message), failures: [] }
  }
  const stdout = String(result.stdout ?? '').trim()
  const lastLine = stdout.split('\n').filter((one) => one.trim() !== '').pop() ?? ''
  try {
    return JSON.parse(lastLine)
  } catch (error) {
    void error
    const detail = String(result.stderr ?? '').trim() || stdout
    return { loaded: false, error: `子进程未返回 JSON（exit=${String(result.status)}）：${detail}`, failures: [] }
  }
}

test('公共日期值模块存在', () => {
  assert.ok(existsSync(fileURLToPath(DATE_VALUE)),
    '缺少公共日期契约模块 src/client/ui/components/date-value.ts')
})

test('纯日期值在 UTC+14 / UTC-10 两个时区下都成立', () => {
  for (const timezone of TIMEZONES) {
    const report = runDateContract(timezone)
    if (report.loaded !== true) {
      assert.fail(`无法加载 src/client/ui/components/date-value.ts（${timezone}）：${report.error}`)
    }
    assert.deepEqual(report.failures, [],
      `${timezone} 下的纯日期契约未通过：\n${JSON.stringify(report.failures, null, 2)}`)
  }
})
