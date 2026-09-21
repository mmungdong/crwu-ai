import type { EnvManifest } from '../environment/manifest-default.ts'
import type { WorkbenchConfig } from './config.ts'

/** 让 YAML 管住部署值；远程清单只补充工具、服务及其它环境信息。 */
export function applyDeploymentConfig(manifest: EnvManifest, config: WorkbenchConfig): EnvManifest {
  return {
    ...manifest,
    installDocUrl: config.installDocUrl || manifest.installDocUrl,
    workspace: {
      ...manifest.workspace,
      preferTitle: config.preferWorkspaceTitle || manifest.workspace.preferTitle,
    },
    oss: {
      ...manifest.oss,
      enabled: config.ossBucket !== '' ? true : manifest.oss.enabled,
      bucket: config.ossBucket || manifest.oss.bucket,
      endpoint: config.ossEndpoint || manifest.oss.endpoint,
      prefix: config.ossPrefix || manifest.oss.prefix,
      publicBaseUrl: config.ossBaseUrl || manifest.oss.publicBaseUrl,
      linkMode: config.ossLinkMode,
      linkTtl: config.ossLinkTtlSeconds,
      autoUpload: config.autoUpload,
      // 远程只读清单是数据源，不是宿主 Shell 脚本分发渠道。
      probeCommand: '',
    },
  }
}
