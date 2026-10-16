/**
 * 抽屉里的 **12 个估值要素**必须只有一套标签（方案 §5.4 的那份清单）。
 *
 * 它出现在三个地方：**对象 schema**（`schemas/valuation-object.schema.json` 的 `fieldLabels`）、
 * **Host 的要素清单**（`VALUATION_FIELD_KEYS`，用来算 `missingFields`）、
 * **界面**（`VALUATION_FIELD_LABELS`，用来画抽屉里的"资料中读到的信息 / 缺失信息"两栏）。
 *
 * 三处各写一份的后果不是"重复"，而是**用户核对的那份清单与结果文件里的口径不同**：
 * 抽屉里显示"建筑面积缺失"，而 `估值对象.json` 里没有这一项 —— 谁也不知道该信哪个。
 * 所以这里按**文本**（而不是运行期对象）核对：schema 是 JSON 文件，读出来比。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const SCHEMA = new URL('skills/biz/crwu-biz-valuation-realestate/schemas/valuation-object.schema.json', ROOT)

const { VALUATION_FIELD_KEYS } = await import(new URL('src/host/operations/report-evaluation.ts', ROOT).href)
const { VALUATION_FIELD_LABELS } = await import(
  new URL('src/client/modules/report-evaluation/model/valuation-state.ts', ROOT).href)

/** 方案 §5.4 逐字列出的那 12 项（顺序固定）。 */
const CANONICAL = [
  '坐落', '房屋性质', '用途', '建筑面积', '楼层', '总楼层',
  '建筑结构', '建成年代', '权属信息', '租赁信息', '价格信息', '已知案例线索',
]

test('对象 schema 的 fieldLabels 就是方案 §5.4 的那 12 项', () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'))
  assert.deepEqual(schema.properties.fieldLabels.items.enum, CANONICAL)
})

test('Host 侧不再有"抽屉要素清单"：协议 35 起抽屉只显示文件元信息与用户输入', () => {
  // v1 的 `VALUATION_FIELD_KEYS` 是**确认抽屉**的数据源（界面据此画"资料中读到的信息 /
  // 缺失信息"两栏）。v2 把这个清单整块从抽屉里拿掉了 —— 抽屉只显示文件元信息与用户填的条件。
  // 所以这里反过来钉：它**不许**再作为 Host 的操作层导出回来（回来就等于抽屉又在展示业务字段）。
  assert.equal(VALUATION_FIELD_KEYS, undefined, 'Host 不该再导出抽屉要素清单')
  // 12 个标签仍然是**会话内对象契约**的一部分（`valuation-object.schema.json`），
  // 由上面的第一条断言把守 —— 业务字段没有被删除，只是不再出现在启动页抽屉里。
})

test('Client 侧不再有"抽屉要素清单"：确认抽屉不展示业务字段', () => {
  assert.equal(VALUATION_FIELD_LABELS, undefined, 'Client 不该再导出抽屉要素标签')
})
