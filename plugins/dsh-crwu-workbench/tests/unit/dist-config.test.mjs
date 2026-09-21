import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { distributionTargetsFromFile } = await import(new URL('../../scripts/plugin-distribution-config.mjs', ROOT).href)

test('plugin distribution derives write and employee read URLs from the package YAML', () => {
  const configFile = new URL('config/crwu-workbench.yml', ROOT).pathname
  assert.deepEqual(distributionTargetsFromFile(configFile, 'dsh-crwu-workbench-0.0.1.tgz'), {
    ossUrl: 'oss://crwu-only-workspace/crwu-dsh-plugins/dsh-crwu-workbench-0.0.1.tgz',
    installUrl: 'https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-dsh-plugins/dsh-crwu-workbench-0.0.1.tgz',
  })
})
