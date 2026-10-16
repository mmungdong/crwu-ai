/**
 * 唯一部署配置源（`config/crwu-workbench.yml`）的解析与校验。
 *
 * 2026-09-25 起 YAML 里**只剩 `oss.protected`**：`oss.readonly`（环境清单 / 安装文档 / 插件 TGZ
 * 的分发桶）连同依赖它的三条链路一起下掉了。所以这里少了两条测试：readonly 的地址推导、
 * 以及 `distributionTargets`（插件改从 npm 安装，不再往 OSS 传 tgz）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { loadWorkbenchYaml, parseWorkbenchYaml } = await import(new URL('src/host/config/yaml.ts', ROOT).href)
const { resolveWorkbenchConfig } = await import(new URL('src/host/config/config.ts', ROOT).href)

const VALID_YAML = `
schemaVersion: 1
workspace:
  caseRoot: ''
  preferTitle: 中瑞世联工作空间
  requireTopLevelParent: true
report:
  formName: 报告审核
audit:
  autoUpload: true
oss:
  protected:
    bucket: crwu-workspace
    endpoint: oss-cn-beijing.aliyuncs.com
    baseUrl: https://crwu-workspace.oss-cn-beijing.aliyuncs.com
    auditPrefix: crwu/audit
    linkMode: signed
    linkTtlSeconds: 3600
`

test('YAML resolves the protected audit OSS into runtime config', () => {
  const resolved = parseWorkbenchYaml(VALID_YAML, 'inline-test.yml')

  assert.equal(resolved.runtime.ossBucket, 'crwu-workspace')
  assert.equal(resolved.runtime.ossPrefix, 'crwu/audit')
  assert.equal(resolved.runtime.ossEndpoint, 'oss-cn-beijing.aliyuncs.com')
  assert.equal(resolved.runtime.ossLinkMode, 'signed')
  assert.equal(resolved.runtime.ossLinkTtlSeconds, 3600)
  assert.equal(resolved.runtime.preferWorkspaceTitle, '中瑞世联工作空间')
  // 只读分发桶已经不存在：运行时配置里不该再出现清单地址或安装文档地址。
  assert.equal('manifestUrl' in resolved.runtime, false)
  assert.equal('installDocUrl' in resolved.runtime, false)
  assert.equal('readonly' in resolved.oss, false)
})

test('invalid YAML is rejected before development or packaging can use it', () => {
  assert.throws(
    () => parseWorkbenchYaml(VALID_YAML.replace('schemaVersion: 1', 'schemaVersion: 2'), 'bad.yml'),
    /schemaVersion/,
  )
  assert.throws(
    () => parseWorkbenchYaml(VALID_YAML.replace('https://crwu-workspace', 'http://crwu-workspace'), 'bad.yml'),
    /HTTPS/,
  )
  assert.throws(
    () => parseWorkbenchYaml(VALID_YAML.replace('linkTtlSeconds: 3600', 'linkTtlSeconds: 30'), 'bad.yml'),
    /linkTtlSeconds/,
  )
  // 只读那一整段已经不在校验范围内：写了也不再解析（少一段配置就少一条可被改写的地址）。
  assert.doesNotThrow(() => parseWorkbenchYaml(`${VALID_YAML}  readonly:\n    bucket: x\n`, 'extra.yml'))
})

test('development can load an explicitly selected YAML file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crwu-yaml-'))
  const file = join(root, 'crwu-workbench.yml')
  try {
    await writeFile(file, VALID_YAML.replace('报告审核', '开发审核'), 'utf8')
    const resolved = loadWorkbenchYaml(file)
    assert.equal(resolved.runtime.formName, '开发审核')
    assert.equal(resolved.source, file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Host activation resolves an explicitly selected development YAML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crwu-host-config-'))
  const file = join(root, 'crwu-workbench.yml')
  try {
    await writeFile(file, VALID_YAML.replace('crwu/audit', 'crwu/dev-audit'), 'utf8')
    const config = resolveWorkbenchConfig({ configFile: file })
    assert.equal(config.ossPrefix, 'crwu/dev-audit')
    assert.equal(config.configSource, file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * `valuation.knowledge.wikiPath`（协议 39 起的**唯一业务入口**）与遗留的 `manifestPath`。
 *
 * 两条都是**库内相对路径**，校验要严：绝对路径与 `..` 会让它指向知识库之外。
 * 基准与 `mirrorRoot` 的文件系统绝对路径**不是一回事**，各自独立回退。
 */
const KNOWLEDGE_YAML = (body) => `${VALID_YAML}\nvaluation:\n  knowledge:\n${body}\n`

test('未配置 valuation.knowledge 时 wikiPath 取默认入口，manifestPath 退回遗留缺省', () => {
  const resolved = parseWorkbenchYaml(VALID_YAML, 'inline-test.yml')

  // 与技能 `references/knowledge-routing.md` 声明的入口逐字一致。
  assert.equal(resolved.runtime.valuation.knowledge.wikiPath, '01 估值与测算/01 房地产/wiki.adoc')
  assert.equal(resolved.runtime.valuation.knowledge.manifestPath, '01 估值与测算/01 房地产/00-知识目录与必需项')
})

test('wikiPath 采用配置里的库内相对路径，且绝对路径 / .. / 空串一律拒绝', () => {
  const resolved = parseWorkbenchYaml(
    KNOWLEDGE_YAML('    wikiPath: 01 估值与测算/01 房地产/wiki.md'),
    'inline-test.yml',
  )
  assert.equal(resolved.runtime.valuation.knowledge.wikiPath, '01 估值与测算/01 房地产/wiki.md')
  for (const bad of ['/etc/passwd', 'a/../b.md', "''"]) {
    assert.throws(
      () => parseWorkbenchYaml(KNOWLEDGE_YAML(`    wikiPath: ${bad}`), 'bad.yml'),
      /valuation\.knowledge\.wikiPath/,
      bad,
    )
  }
})

test('只给 wikiPath 时 manifestPath 仍独立回退到遗留缺省值', () => {
  const resolved = parseWorkbenchYaml(
    KNOWLEDGE_YAML('    wikiPath: 01 估值与测算/01 房地产/wiki.md'),
    'inline-test.yml',
  )
  assert.equal(resolved.runtime.valuation.knowledge.manifestPath, '01 估值与测算/01 房地产/00-知识目录与必需项')
})

test('manifestPath 采用配置里的库内相对路径', () => {
  const resolved = parseWorkbenchYaml(
    KNOWLEDGE_YAML('    manifestPath: 01 估值与测算/01 房地产/知识目录.md'),
    'inline-test.yml',
  )

  assert.equal(resolved.runtime.valuation.knowledge.manifestPath, '01 估值与测算/01 房地产/知识目录.md')
})

test('valuation.recalculation.enginePath：缺省空串（= 本部署没有表格计算程序），只接受绝对路径', () => {
  const fallback = parseWorkbenchYaml(VALID_YAML, 'inline-test.yml')
  assert.equal(fallback.runtime.valuation.recalculation.enginePath, '',
    '没有配置就是没有引擎：重算 unavailable，报告只能 partial')

  const ok = parseWorkbenchYaml(`${VALID_YAML}\nvaluation:\n  recalculation:\n    enginePath: /usr/local/bin/soffice\n`, 'inline.yml')
  assert.equal(ok.runtime.valuation.recalculation.enginePath, '/usr/local/bin/soffice')

  // 空串显式写出来 = 没有引擎（合法）。
  const empty = parseWorkbenchYaml(`${VALID_YAML}\nvaluation:\n  recalculation:\n    enginePath: ''\n`, 'inline.yml')
  assert.equal(empty.runtime.valuation.recalculation.enginePath, '')

  // 相对路径 / 含 `..` 一律拒绝：那等于让"在哪启动"决定算什么数。
  for (const bad of ['soffice', '../bin/soffice']) {
    assert.throws(
      () => parseWorkbenchYaml(`${VALID_YAML}\nvaluation:\n  recalculation:\n    enginePath: ${bad}\n`, 'bad.yml'),
      /valuation\.recalculation\.enginePath/,
      bad,
    )
  }
})

test('只给 manifestPath 时 mirrorRoot 仍独立回退到缺省值', () => {
  const resolved = parseWorkbenchYaml(
    KNOWLEDGE_YAML('    manifestPath: 01 估值与测算/01 房地产/知识目录.md'),
    'inline-test.yml',
  )

  assert.equal(resolved.runtime.valuation.knowledge.mirrorRoot, '')
})

test('manifestPath 是绝对路径或含 .. 或为空时拒绝', () => {
  assert.throws(
    () => parseWorkbenchYaml(KNOWLEDGE_YAML('    manifestPath: /etc/passwd'), 'bad.yml'),
    /valuation\.knowledge\.manifestPath/,
  )
  assert.throws(
    () => parseWorkbenchYaml(KNOWLEDGE_YAML('    manifestPath: a/../b.md'), 'bad.yml'),
    /valuation\.knowledge\.manifestPath/,
  )
  assert.throws(
    () => parseWorkbenchYaml(KNOWLEDGE_YAML("    manifestPath: ''"), 'bad.yml'),
    /valuation\.knowledge\.manifestPath/,
  )
})

/**
 * `valuation.knowledge.mirrorRoot`：**身份已验证**的镜像根，文件系统绝对路径。
 *
 * 空串是合法且默认的取值（= 不启用镜像，不是"还没配"）；非空时必须是绝对路径且不含 `..`，
 * 否则它会随工作目录漂移或指向镜像根之外 —— 而这一层是"知识库读不到时"的唯一降级来源。
 */
test('mirrorRoot 留空即不启用镜像，非空时必须是绝对路径', () => {
  const mirrorYaml = (value) => `${VALID_YAML}\nvaluation:\n  knowledge:\n    mirrorRoot: ${value}\n`

  assert.equal(parseWorkbenchYaml(VALID_YAML, 'inline-test.yml').runtime.valuation.knowledge.mirrorRoot, '')
  assert.equal(parseWorkbenchYaml(mirrorYaml("''"), 'inline-test.yml').runtime.valuation.knowledge.mirrorRoot, '')
  assert.equal(
    parseWorkbenchYaml(mirrorYaml('/tmp/crwu-mirror'), 'inline-test.yml').runtime.valuation.knowledge.mirrorRoot,
    '/tmp/crwu-mirror',
  )

  assert.throws(() => parseWorkbenchYaml(mirrorYaml('./mirror'), 'bad.yml'), /mirrorRoot/)
  assert.throws(() => parseWorkbenchYaml(mirrorYaml('/tmp/../etc'), 'bad.yml'), /mirrorRoot/)
})
