import { fileURLToPath } from 'node:url'
import { loadWorkbenchYaml } from '../src/host/config/yaml.ts'

const configFile = fileURLToPath(new URL('../config/crwu-workbench.yml', import.meta.url))
const deployment = loadWorkbenchYaml(configFile)

console.log(`PASS 配置 ${deployment.source}`)
console.log(`     只读 OSS：${deployment.oss.readonly.bucket}`)
console.log(`     私有 OSS：${deployment.oss.protected.bucket}/${deployment.oss.protected.auditPrefix}`)
