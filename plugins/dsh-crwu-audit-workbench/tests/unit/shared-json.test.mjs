/**
 * `parseJsonLoose` 的单元测试。
 *
 * 这个函数存在的唯一理由是一条**真实**观察：`ossutil` v1.7.19 把 `<n>(s) elapsed`
 * 无条件写到 stdout，导致对每一个真实对象的 `JSON.parse` 都失败（「审核信息」抽屉永远报错）。
 * 所以测试里用的尾巴是**逐字抄回来的**，不是编的。
 *
 * 同时要防「放松过头」：垃圾输入、截断输入、括号错配都必须仍然返回 null。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { parseJsonLoose } = await import(new URL('src/shared/utils/json.ts', ROOT).href)

/** 真实 ossutil 输出尾巴（本机 v1.7.19 实测）。 */
const ELAPSED = '0.104387(s) elapsed'

test('plain JSON still parses exactly as before', () => {
  assert.deepEqual(parseJsonLoose('{"a":1,"b":[1,2]}'), { a: 1, b: [1, 2] })
  assert.deepEqual(parseJsonLoose('  [1,2,3]  '), [1, 2, 3])
  assert.deepEqual(parseJsonLoose('{"s":"中文"}'), { s: '中文' })
  assert.equal(parseJsonLoose('"scalar"'), 'scalar')
  assert.equal(parseJsonLoose('42'), 42)
})

test('ossutil 的 elapsed 尾巴不再让真实对象解析失败', () => {
  // 换行形式与同行形式都要能处理 —— 新版 ossutil 可能改排版，不能只押一种。
  assert.deepEqual(parseJsonLoose(`{"ok":true}\n${ELAPSED}\n`), { ok: true })
  assert.deepEqual(parseJsonLoose(`{"ok":true}${ELAPSED}`), { ok: true })
  assert.deepEqual(parseJsonLoose(`\n{"ok":true}\n\n${ELAPSED}\n`), { ok: true })
})

test('elapsed 尾巴出现在真实结构（多字节中文 + 嵌套对象）后面也能解析', () => {
  const body = JSON.stringify({
    schemaVersion: '1.6',
    auditTask: { projectId: '2026-302474-LX9995-BG8740', engineVersion: 'crwu-audit@2026-09-20 (deepseek-harness)' },
    summary: { counts: { issuesTotal: 12, high: 3 }, narrative: '12条问题均有被审件原文支撑' },
  })
  const parsed = parseJsonLoose(`${body}\n${ELAPSED}\n`)
  assert.equal(parsed.schemaVersion, '1.6')
  assert.equal(parsed.auditTask.projectId, '2026-302474-LX9995-BG8740')
  assert.equal(parsed.summary.counts.issuesTotal, 12)
})

test('字符串里的括号与转义不会把文档截断', () => {
  // 扫描必须先认字符串状态，否则会在 `}{` 上以为文档结束。
  const tricky = { a: '}{', b: 'x"}"y', c: '\\\\', d: { e: [1, { f: '}' }] } }
  assert.deepEqual(parseJsonLoose(`${JSON.stringify(tricky)}\n${ELAPSED}`), tricky)
  assert.deepEqual(parseJsonLoose('{"a":"}{","b":1}'), { a: '}{', b: 1 })
  assert.deepEqual(parseJsonLoose('{"a":"x\\"}{"}'), { a: 'x"}{' })
})

test('JSON 前面有别的话（告警、提示）也能取到文档', () => {
  assert.deepEqual(parseJsonLoose(`WARN something happened\n{"a":1}`), { a: 1 })
  assert.deepEqual(parseJsonLoose(`提示：正在读取\n[{"a":1}]`), [{ a: 1 }])
})

test('垃圾输入仍然返回 null，不因为「宽松」而放行', () => {
  assert.equal(parseJsonLoose(''), null)
  assert.equal(parseJsonLoose('   '), null)
  assert.equal(parseJsonLoose(undefined), null)
  assert.equal(parseJsonLoose(null), null)
  assert.equal(parseJsonLoose('no json here at all'), null)
  assert.equal(parseJsonLoose('{ broken'), null)
  assert.equal(parseJsonLoose('{"a":1'), null)
  assert.equal(parseJsonLoose('{"a":}'), null)
  assert.equal(parseJsonLoose('{"a":1]'), null, '括号错配不能放过')
  assert.deepEqual(parseJsonLoose('{"a":1}}'), { a: 1 }, '完整文档后面的多余括号不算错（CLI 尾巴同类）')
})

test('嵌套深度正确计数（深层不提前收尾）', () => {
  const deep = { a: { b: { c: { d: [1, [2, [3]]] } } } }
  assert.deepEqual(parseJsonLoose(`${JSON.stringify(deep)} ${ELAPSED}`), deep)
})
