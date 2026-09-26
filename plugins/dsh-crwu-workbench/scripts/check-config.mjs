import { fileURLToPath } from 'node:url'
import { loadWorkbenchYaml } from '../src/host/config/yaml.ts'

const configFile = fileURLToPath(new URL('../config/crwu-workbench.yml', import.meta.url))
const deployment = loadWorkbenchYaml(configFile)

console.log(`PASS 配置 ${deployment.source}`)
// 只剩审核产物那一个私有桶：只读分发桶（清单 / 安装文档 / 插件 TGZ）已于 2026-09-25 整体下掉。
console.log(`     私有 OSS：${deployment.oss.protected.bucket}/${deployment.oss.protected.auditPrefix}`)
