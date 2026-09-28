import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { loadWorkbenchYaml } from './yaml.ts'

/** Cordis 只负责选择开发配置；实际部署值全部来自 YAML。 */
export interface PluginConfig {
  configFile: string
}

/** YAML 归一化后交给 Host 各模块的稳定配置。 */
export interface WorkbenchConfig {
  configSource: string
  caseRoot: string
  preferWorkspaceTitle: string
  formName: string
  ossBucket: string
  ossPrefix: string
  ossEndpoint: string
  ossBaseUrl: string
  ossLinkMode: 'signed' | 'public'
  ossLinkTtlSeconds: number
  autoUpload: boolean
  requireTopLevelParent: boolean
}

/** Cordis 配置只留一个开发覆盖入口；空串时自动找包内 config/crwu-workbench.yml。 */
export const Config: Schema<PluginConfig> = Schema.object({
  configFile: Schema.string().default(''),
})

function packagedCandidates(moduleUrl: string): string[] {
  return [
    // 源码开发：src/host/config/config.ts → 插件根/config。
    fileURLToPath(new URL('../../../config/crwu-workbench.yml', moduleUrl)),
    // TGZ 安装：lib/index.js → 插件根/config。
    fileURLToPath(new URL('../config/crwu-workbench.yml', moduleUrl)),
  ]
}

/** 开发模式读显式 YAML；安装后的 TGZ 自动读随包配置。 */
export function resolveWorkbenchConfig(input: Partial<PluginConfig> = {}, moduleUrl = import.meta.url): WorkbenchConfig {
  const explicit = (input.configFile || process.env.CRWU_CONFIG_FILE || '').trim()
  let configFile = explicit
  if (configFile === '') {
    configFile = packagedCandidates(moduleUrl).find((candidate) => existsSync(candidate)) ?? ''
  }
  if (configFile === '') {
    throw new Error('找不到 config/crwu-workbench.yml；开发模式可设置 CRWU_CONFIG_FILE')
  }
  if (!existsSync(configFile)) throw new Error(`配置文件不存在：${configFile}`)
  const deployment = loadWorkbenchYaml(configFile)
  return {
    ...deployment.runtime,
    configSource: deployment.source,
    ossBaseUrl: deployment.oss.protected.baseUrl,
  }
}
