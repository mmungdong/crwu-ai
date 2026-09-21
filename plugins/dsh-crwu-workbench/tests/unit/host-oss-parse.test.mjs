/**
 * 第 4 层前半（OSS 对象路径解析）的单元测试。
 *
 * 这一层是**越界防护**所在：任何按 key 读对象或签名的接口都先过 `stripPrefix`。
 * 所以这里重点验证「不在前缀内必须判空」，以及 `ossutil` 输出里的非对象行不被当成对象。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const {
  stripPrefix,
  fileNameOf,
  parseLsObjects,
  parseSignUrl,
  joinUrl,
  groupObjects,
  seqNoFromObjectKey,
  isResultJson,
} = await import(new URL('src/host/oss/parse.ts', ROOT).href)

test('stripPrefix is the out-of-prefix guard and returns empty for outsiders', () => {
  assert.equal(stripPrefix('crwu/audit/S1/a.html', 'crwu/audit'), 'S1/a.html')
  assert.equal(stripPrefix('crwu/audit/S1/a.html', '/crwu/audit/'), 'S1/a.html', '前缀两侧的斜杠会被规整掉')
  // key 自己带前导斜杠时**不**剥（与 legacy 一致）：真实对象 key 不带前导斜杠，
  // 而把「看起来像前缀」的东西剥掉会让越界判据变得不可靠。
  assert.equal(stripPrefix('/crwu/audit/S1/a.html', 'crwu/audit'), '')
  // 这几条是安全边界：越界的 key 必须判空，调用方据此拒绝。
  assert.equal(stripPrefix('other/audit/S1/a.html', 'crwu/audit'), '')
  assert.equal(stripPrefix('crwu/auditfake/S1/a.html', 'crwu/audit'), '', '前缀必须按整段匹配，不能是字符串前缀')
  assert.equal(stripPrefix('crwu/audit', 'crwu/audit'), '', '等于前缀本身没有相对 key')
  assert.equal(stripPrefix('anything', ''), 'anything', '未配置前缀时不加限制（清单负责约束）')
})

test('fileNameOf takes the last segment', () => {
  assert.equal(fileNameOf('crwu/audit/S1/审核意见.S1.html'), '审核意见.S1.html')
  assert.equal(fileNameOf('name'), 'name')
  assert.equal(fileNameOf(''), '')
})

test('parseLsObjects ignores non-object lines from the CLI summary', () => {
  const output = [
    'oss://bkt/crwu/audit/S1/审核意见.S1.html',
    'oss://bkt/crwu/audit/S1/审核结果.S1.json',
    '',
    'Object Number is: 2',
    '0.123(s) elapsed',
  ].join('\n')
  assert.deepEqual(parseLsObjects(output, 'bkt'), [
    'crwu/audit/S1/审核意见.S1.html',
    'crwu/audit/S1/审核结果.S1.json',
  ])
})

test('parseLsObjects accepts a foreign bucket prefix by dropping it', () => {
  assert.deepEqual(parseLsObjects('oss://other/x/y.json', 'bkt'), ['x/y.json'])
  assert.deepEqual(parseLsObjects('oss://nopath', 'bkt'), [], '没有路径段的行是垃圾行')
})

test('parseSignUrl picks the URL line out of signer output', () => {
  const output = '正在签名…\nhttps://bkt.oss-cn-x.aliyuncs.com/a?Signature=abc\n完成'
  assert.equal(parseSignUrl(output), 'https://bkt.oss-cn-x.aliyuncs.com/a?Signature=abc')
  assert.equal(parseSignUrl('没有 URL'), '')
  assert.equal(parseSignUrl(''), '')
})

test('joinUrl percent-encodes each path segment but keeps slashes', () => {
  assert.equal(joinUrl('https://cdn.invalid/base/', 'crwu/audit/审核意见.S1.html'),
    `https://cdn.invalid/base/crwu/audit/${encodeURIComponent('审核意见.S1.html')}`)
  assert.equal(joinUrl('', 'a'), '', '没有 base 就不拼 URL')
})

test('seqNoFromObjectKey reads the serial number from the object layout', () => {
  assert.equal(seqNoFromObjectKey('crwu/audit/2026-301705-LX10170/审核意见.2026-301705-LX10170.html', 'crwu/audit'), '2026-301705-LX10170')
  // 前缀换过时退一步扫整条 key。
  assert.equal(seqNoFromObjectKey('old/2026-301705-LX10170/x.html', 'crwu/audit'), '2026-301705-LX10170')
  assert.equal(seqNoFromObjectKey('crwu/audit/not-a-seq/x.html', 'crwu/audit'), '')
})

test('groupObjects keys by serial number and only marks canonical artifacts', () => {
  // 流水号必须是「年-编号-…」形状：这是从 key 反推归属的唯一判据。
  const seq = '2026-301705-LX10170'
  const items = groupObjects([
    `crwu/audit/${seq}/审核意见.${seq}.html`,
    `crwu/audit/${seq}/审核结果.${seq}.json`,
    `crwu/audit/${seq}/审核意见.${seq}.html.before-20260919`,
  ], 'crwu/audit')
  assert.deepEqual(Object.keys(items), [seq])
  assert.equal(items[seq].htmlKey, `crwu/audit/${seq}/审核意见.${seq}.html`, '备份不能被当成正式交付件')
  assert.equal(items[seq].jsonKey, `crwu/audit/${seq}/审核结果.${seq}.json`)
  assert.equal(items[seq].files.length, 3, '附件仍然列出，只是不填正式字段')
})

test('groupObjects ignores keys without a serial number', () => {
  const items = groupObjects(['crwu/audit/readme.txt', 'crwu/audit/2026-301705-LX10170/x.html'], 'crwu/audit')
  assert.deepEqual(Object.keys(items), ['2026-301705-LX10170'])
  // `S1` 这类占位符不是流水号，不该被归组（否则列表会多出一堆幽灵条目）。
  assert.deepEqual(groupObjects(['crwu/audit/S1/x.html'], 'crwu/audit'), {})
})

test('isResultJson only accepts a .json suffix', () => {
  assert.equal(isResultJson('crwu/audit/S1/审核结果.S1.json'), true)
  assert.equal(isResultJson('crwu/audit/S1/审核结果.S1.JSON'), true)
  assert.equal(isResultJson('crwu/audit/S1/审核意见.S1.html'), false)
  assert.equal(isResultJson('crwu/audit/S1/x.json.bak'), false, '后缀不在结尾就不算 JSON')
})
