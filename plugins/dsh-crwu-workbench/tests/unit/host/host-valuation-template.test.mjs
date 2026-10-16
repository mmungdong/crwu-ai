/**
 * 计算表模板的**字节验真**（`verifyTemplateWorkbook`）。
 *
 * 这一层钉的是"看起来能用、其实不能用"的一类模板：**下载到的不是 xlsx**
 * （HTML 错误页 / 登录页 / 被网关改写的响应 / 空字节）—— 按工作簿打开才发现，员工已经填了一半。
 *
 * 为什么这里只剩两道判据（非空、ZIP 魔数）：
 *
 * - 旧形态还有"字节与索引声明的 digest / sizeBytes 一致"，但 manifest 为模板声明的只有**指针**
 *   （`methods.<m>.template` → 库内相对路径），没有 digest 也没有 sizeBytes。没有可比的声明值，
 *   校验就会恒真 —— 恒真的校验比没有校验更糟，它会让"模板验过真了"变成一句空话。
 *   真正的字节留痕改由**取回后算出的 sha256** 承担（`entries[].digest`）。
 * - **结构校验**（七张可见表、无隐藏表、公式链）由 Skill 自带的 `check_workbook_contract.py`
 *   回答，在 TS 里重写一遍必然漂移。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const { verifyTemplateWorkbook } = await import(
  new URL('src/host/domains/report-evaluation/knowledge/template-bytes.ts', ROOT).href)

/** 最小可辨的 ZIP 头：`PK\x03\x04` 加一点内容（不必是真工作簿，验真只看这两点）。 */
function zipBytes(tail = 'rest-of-workbook') {
  return new TextEncoder().encode(`PK\x03\x04${tail}`)
}

test('空字节 → 拒绝：0 字节不是一份可用的工作簿', () => {
  for (const bytes of [null, new Uint8Array(0)]) {
    const check = verifyTemplateWorkbook(bytes, 'method.market.template')
    assert.equal(check.ok, false)
    assert.equal(check.problems.length, 1)
    assert.match(check.problems[0], /0 字节/)
    assert.match(check.problems[0], /method\.market\.template/, '要说清是哪一份模板')
  }
})

test('不是 ZIP/xlsx（HTML 错误页、登录页）→ 拒绝，并点明"不要按工作簿打开"', () => {
  const loginPage = new TextEncoder().encode('<!doctype html><html><body>请先登录</body></html>')
  const check = verifyTemplateWorkbook(loginPage, 'method.market.template')
  assert.equal(check.ok, false)
  assert.match(check.problems[0], /不是 ZIP\/xlsx/)
  assert.match(check.problems[0], /登录页|错误页/)
  assert.match(check.problems[0], /不要按工作簿打开/)
})

test('前四字节是 PK\\x03\\x04 → 通过（结构校验不在这里）', () => {
  const check = verifyTemplateWorkbook(zipBytes(), 'method.market.template')
  assert.equal(check.ok, true)
  assert.deepEqual(check.problems, [])
})

test('只对前四字节下判据：内容里出现 PK 不算数', () => {
  const check = verifyTemplateWorkbook(new TextEncoder().encode('<html>PK\x03\x04</html>'), 't')
  assert.equal(check.ok, false)
})
