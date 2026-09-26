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

const ROOT = new URL('../../', import.meta.url)
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
