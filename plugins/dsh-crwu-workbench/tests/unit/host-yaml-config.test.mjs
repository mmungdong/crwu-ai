import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const {
  distributionTargets,
  loadWorkbenchYaml,
  parseWorkbenchYaml,
} = await import(new URL('src/host/config/yaml.ts', ROOT).href)
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
  readonly:
    bucket: crwu-only-workspace
    endpoint: oss-cn-beijing.aliyuncs.com
    baseUrl: https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com
    manifestKey: crwu-env-manifest.json
    installDocKey: crwu-env-install.md
    pluginPrefix: crwu-dsh-plugins
  protected:
    bucket: crwu-workspace
    endpoint: oss-cn-beijing.aliyuncs.com
    baseUrl: https://crwu-workspace.oss-cn-beijing.aliyuncs.com
    auditPrefix: crwu/audit
    linkMode: signed
    linkTtlSeconds: 3600
`

test('YAML resolves the public read-only OSS and protected audit OSS into runtime config', () => {
  const resolved = parseWorkbenchYaml(VALID_YAML, 'inline-test.yml')

  assert.equal(resolved.runtime.manifestUrl, 'https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-env-manifest.json')
  assert.equal(resolved.runtime.installDocUrl, 'https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-env-install.md')
  assert.equal(resolved.runtime.ossBucket, 'crwu-workspace')
  assert.equal(resolved.runtime.ossPrefix, 'crwu/audit')
  assert.equal(resolved.runtime.ossEndpoint, 'oss-cn-beijing.aliyuncs.com')
  assert.equal(resolved.runtime.ossLinkMode, 'signed')
  assert.equal(resolved.runtime.ossLinkTtlSeconds, 3600)
  assert.equal(resolved.runtime.preferWorkspaceTitle, '中瑞世联工作空间')
})

test('distribution targets come from the read-only OSS section', () => {
  const resolved = parseWorkbenchYaml(VALID_YAML, 'inline-test.yml')
  assert.deepEqual(distributionTargets(resolved, 'dsh-crwu-workbench-0.0.1.tgz'), {
    ossUrl: 'oss://crwu-only-workspace/crwu-dsh-plugins/dsh-crwu-workbench-0.0.1.tgz',
    installUrl: 'https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-dsh-plugins/dsh-crwu-workbench-0.0.1.tgz',
  })
})

test('invalid YAML is rejected before development or packaging can use it', () => {
  assert.throws(
    () => parseWorkbenchYaml(VALID_YAML.replace('schemaVersion: 1', 'schemaVersion: 2'), 'bad.yml'),
    /schemaVersion/,
  )
  assert.throws(
    () => parseWorkbenchYaml(VALID_YAML.replace('https://crwu-only-workspace', 'http://crwu-only-workspace'), 'bad.yml'),
    /HTTPS/,
  )
  assert.throws(
    () => parseWorkbenchYaml(VALID_YAML.replace('linkTtlSeconds: 3600', 'linkTtlSeconds: 30'), 'bad.yml'),
    /linkTtlSeconds/,
  )
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
