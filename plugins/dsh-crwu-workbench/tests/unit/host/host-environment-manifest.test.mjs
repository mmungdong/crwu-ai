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

const ROOT = new URL('../../../', import.meta.url)

const { DEFAULT_MANIFEST, DSH_RUNTIME_SOURCE } = await import(new URL('src/host/core/environment/manifest-default.ts', ROOT).href)
const { normalizeOss } = await import(new URL('src/host/core/environment/manifest.ts', ROOT).href)

// ── 内置清单自洽 ────────────────────────────────────────────────────────────

test('清单 v4：三件随包发布的组件只声明「叫什么、干什么、要求什么版本」', () => {
  // v3 → v4：iFinD 的 `ifindKey.path` 整组消失（凭据改由插件 Host 自己保管在插件状态目录，
  // 见 `host/integrations/ifind/store.ts`）。地址不再有第二个事实源，是这一版的关键。
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

test('iFinD 声明是**可选数据源**：required=false，且给出官方获取入口', () => {
  // 2026-09-30 口径（覆盖 2026-09-26 的「必需项」）：iFinD 是外部数据源，
  // 未配置不阻塞基础环境与报告审核，只让外部数据能力关闭、相关项目记「未检查」。
  const ifind = DEFAULT_MANIFEST.ifind
  assert.equal(ifind.required, false, 'iFinD 是可选数据源，不得阻塞')
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
