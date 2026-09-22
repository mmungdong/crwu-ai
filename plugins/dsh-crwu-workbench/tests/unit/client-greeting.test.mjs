/**
 * 面板头部那句问候的直接测试（纯函数）。
 *
 * 姓名来自**环境自检**（`env.me.name`，钉钉 CLI 在同一次自检里取回），所以这里不测请求，
 * 只钉两件事：分档正确，以及**姓名拿不到就整句为空** —— 不许显示「晚上好，」这种半句，
 * 也不许编造「同事」之类的占位（用户 2026-09-22 口径：钉钉 cli 没有登录信息就什么也不展示）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../', import.meta.url)
const { greetingLine, greetingOf } = await import(
  new URL('src/client/features/workbench/greeting.ts', ROOT).href
)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

test('greetingOf 按本地小时分档：凌晨 / 早上 / 上午 / 中午 / 下午 / 晚上', () => {
  const cases = [
    [0, zhCN.greetingNight], [4, zhCN.greetingNight],
    [5, zhCN.greetingMorning], [8, zhCN.greetingMorning],
    [9, zhCN.greetingForenoon], [10, zhCN.greetingForenoon],
    [11, zhCN.greetingNoon], [13, zhCN.greetingNoon],
    [14, zhCN.greetingAfternoon], [17, zhCN.greetingAfternoon],
    [18, zhCN.greetingEvening], [23, zhCN.greetingEvening],
  ]
  for (const [hour, expected] of cases) {
    assert.equal(greetingOf(hour), expected, `${String(hour)} 点该是「${expected}」`)
  }
  // 时钟取不到（NaN / Infinity）时退回一个安全值，而不是崩或显示空。
  assert.equal(greetingOf(Number.NaN), zhCN.greetingMorning)
  assert.equal(greetingOf(Number.POSITIVE_INFINITY), zhCN.greetingMorning)
})

test('greetingLine：姓名拿不到就整句为空（不许半句、不许编造）', () => {
  assert.equal(greetingLine(15, '杨凡宾'), `${zhCN.greetingAfternoon}，杨凡宾`)
  assert.equal(greetingLine(12, '杨凡宾'), `${zhCN.greetingNoon}，杨凡宾`)
  for (const empty of ['', '   ', '\n']) {
    assert.equal(greetingLine(15, empty), '', `姓名是 ${JSON.stringify(empty)} 时整句不展示`)
  }
  // 姓名两边的空白不该带进界面。
  assert.equal(greetingLine(15, ' 杨凡宾 '), `${zhCN.greetingAfternoon}，杨凡宾`)
})
