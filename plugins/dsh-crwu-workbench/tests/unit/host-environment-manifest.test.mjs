/**
 * 环境清单 / 版本约束 / shell 引用的单元测试。
 *
 * 这一层的规则很容易「看起来对但实际放行」：约束解析不出数字时按「无约束」通过、
 * 实际输出解析不出数字时反而必须失败。每条都反向验一遍。
 *
 * 2026-09-25 起文件里少了两类测试：**远程清单的拉取与归一**、**按平台的下载表**
 * （`normalizeManifest` / `loadManifest` / `resolveBinary` / `ossutilPlatforms`）。
 * 它们测的是只读 OSS 那条链路，链路本身已删除 —— 留着它们的等价物才是假覆盖。
 *
 * 同一天的第二次改造又改了口径：清单从 `binaries[]`（packaged 工具与 system runtime 探针混装）
 * 拆成 `packaged[]` + `runtime.python`，并删掉裸 `python3` 检查。所以这里的断言也从
 * 「清单里有 crwu/dws/python3/ossutil 四条」变成「三件组件 + 一条 DSH 自带 Python 运行时」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { satisfies, parseVersion, compareVersion } = await import(new URL('src/host/environment/version.ts', ROOT).href)
const { DEFAULT_MANIFEST, DSH_RUNTIME_SOURCE } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)
const { quoteArg, normalizeOss } = await import(new URL('src/host/environment/manifest.ts', ROOT).href)

// ── 版本 ────────────────────────────────────────────────────────────────────

test('parseVersion reads a version out of noisy command output', () => {
  assert.deepEqual(parseVersion('v22.19.0'), [22, 19, 0])
  assert.deepEqual(parseVersion('Version: 1.7.19'), [1, 7, 19])
  assert.deepEqual(parseVersion('Python 3.11'), [3, 11, 0])
  assert.deepEqual(parseVersion('dws 0.2.14 (build 7)'), [0, 2, 14])
  assert.equal(parseVersion('no version here'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(null), null)
})

test('compareVersion is a three-segment lexicographic comparison', () => {
  assert.equal(compareVersion([1, 2, 3], [1, 2, 3]), 0)
  assert.equal(compareVersion([1, 2, 3], [1, 2, 4]), -1)
  assert.equal(compareVersion([2, 0, 0], [1, 9, 9]), 1)
  assert.equal(compareVersion([1, 10, 0], [1, 9, 0]), 1, '10 必须大于 9（不能按字符串比）')
})

test('satisfies honours each operator', () => {
  assert.deepEqual(satisfies('22.19.0', '>=16.7'), { ok: true, reason: '' })
  assert.deepEqual(satisfies('16.6.0', '>=16.7'), { ok: false, reason: '低于期望 >=16.7' })
  assert.equal(satisfies('0.2.14', '>0.2.14').ok, false)
  assert.equal(satisfies('0.2.15', '>0.2.14').ok, true)
  assert.equal(satisfies('1.7.19', '<=1.7.19').ok, true)
  assert.equal(satisfies('1.7.20', '<=1.7.19').ok, false)
  assert.equal(satisfies('3.11.0', '<4').ok, true)
  assert.equal(satisfies('1.7.19', '1.7.19').ok, true, '无操作符按等号处理')
  assert.equal(satisfies('1.7.20', '1.7.19').ok, false)
})

test('satisfies treats an absent constraint as no constraint', () => {
  assert.deepEqual(satisfies('anything', ''), { ok: true, reason: '' })
  assert.deepEqual(satisfies('anything', '*'), { ok: true, reason: '' })
  // 约束本身解析不出数字 = 清单写错了，但按「没有约束」处理而不是把人挡在门外。
  assert.deepEqual(satisfies('1.0.0', 'latest'), { ok: true, reason: '' })
})

test('satisfies fails when the installed version cannot be read', () => {
  // 「装了但读不到版本」不能算通过：那会让环境自检显示绿而实际不可用。
  const verdict = satisfies('command not found', '>=16.7')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /无法从命令版本输出解析出版本号|无法从命令输出解析出版本号/)
})

// ── 内置清单自洽 ────────────────────────────────────────────────────────────

test('清单 v4：三件随包发布的组件只声明「叫什么、干什么、要求什么版本」', () => {
  // v3 → v4：iFinD 的 `ifindKey.path` 整组消失（凭据改由插件 Host 自己保管在插件状态目录，
  // 见 `host/ifind/store.ts`）。地址不再有第二个事实源，是这一版的关键。
  assert.equal(DEFAULT_MANIFEST.schema, 'crwu.env-manifest.v4')
  assert.equal('ifindKey' in DEFAULT_MANIFEST, false, 'iFinD 的旧字段整组消失')
  assert.equal('path' in DEFAULT_MANIFEST.ifind, false, '凭据位置由 store 推导，清单不再声明路径')
  assert.deepEqual(DEFAULT_MANIFEST.packaged.map((entry) => entry.name), ['crwu', 'dws', 'ossutil'])
  for (const entry of DEFAULT_MANIFEST.packaged) {
    // 这三件不由 PATH 解析、也不跑版本命令 —— 所以清单里根本不该再有 command / versionArgs / expect。
    for (const banned of ['command', 'versionArgs', 'expect', 'url', 'sha256', 'target', 'platforms', 'archive', 'member']) {
      assert.equal(banned in entry, false, `${entry.name} 不该再有 ${banned} 字段`)
    }
    assert.ok(entry.label.length > 0)
    assert.ok(entry.note.length > 0)
  }
  // dws 的版本要求仍然要有个地方写下来：清单常量里的 expectedVersion（不执行二进制去问）。
  assert.equal(DEFAULT_MANIFEST.packaged.find((entry) => entry.name === 'dws').expectedVersion, '>=0.2.14')
})

test('iFinD 声明是必需项：required=true，且给出官方获取入口', () => {
  // 2026-09-26 产品口径覆盖了旧的 OPT-006-R1 · F-008：iFinD 不再是条件能力。
  const ifind = DEFAULT_MANIFEST.ifind
  assert.equal(ifind.required, true, 'iFinD 未通过必须阻塞')
  assert.equal(ifind.field, 'auth_token')
  assert.match(ifind.applyUrl, /^https:\/\/mcp\.51ifind\.com/)
  assert.ok(ifind.label.length > 0)
})

test('清单里没有 binaries[]，也没有裸 python3 检查项', () => {
  assert.equal('binaries' in DEFAULT_MANIFEST, false, '四类混装的 binaries[] 必须删掉')
  const json = JSON.stringify(DEFAULT_MANIFEST)
  assert.equal(json.includes('python3'), false, '清单里不该再出现裸 python3')
  assert.equal(json.includes('"command"'), false, '清单里不该再有按名字调用的 command')
})

test('Python 是 DSH 自带运行时，不是系统命令：来源、版本约束、必需包都要写清', () => {
  const python = DEFAULT_MANIFEST.runtime.python
  assert.equal(python.required, true)
  assert.match(python.expect, /^>=3\./)
  assert.ok(python.requiredPackages.includes('openpyxl'), 'openpyxl 是审核表格链路的必需包')
  assert.equal(python.note.includes('DSH'), true, '用途必须说清是 DSH 自带')
  assert.match(DSH_RUNTIME_SOURCE, /DSH 自带/)
})

test('清单的服务项：氚云与钉钉进 ④ 授权，oss 只喂 ⑤ 交付门禁', () => {
  assert.deepEqual(
    DEFAULT_MANIFEST.services.map((service) => service.id),
    ['h3yun', 'dingtalk', 'oss'],
  )
})

// ── OSS 归一 ────────────────────────────────────────────────────────────────

test('normalizeOss only accepts the two documented link modes', () => {
  assert.equal(normalizeOss({ linkMode: 'public' }).linkMode, 'public')
  assert.equal(normalizeOss({ linkMode: 'signed' }).linkMode, 'signed')
  assert.equal(normalizeOss({ linkMode: 'PRIVATE' }).linkMode, 'signed', '不认识的模式必须回落到签名 URL')
  assert.equal(normalizeOss({ enabled: 'yes' }).enabled, false, 'enabled 只认严格 true')
  assert.equal(normalizeOss({ autoUpload: false }).autoUpload, false)
  assert.equal(normalizeOss({}).autoUpload, true)
  assert.equal(normalizeOss({ prefix: '/crwu/audit/' }).prefix, '/crwu/audit', 'prefix 去掉尾斜杠')
  assert.equal(normalizeOss({ linkTtl: 'soon' }).linkTtl, 3600, 'TTL 解析不出数字时回默认')
})

test('quoteArg only quotes when the value needs it', () => {
  assert.equal(quoteArg('https://a.b/c.json'), 'https://a.b/c.json')
  assert.equal(quoteArg('has space'), "'has space'")
  assert.equal(quoteArg("it's"), "'it'\\''s'")
  assert.equal(quoteArg(''), "''")
})
