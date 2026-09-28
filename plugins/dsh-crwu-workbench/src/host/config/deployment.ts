import type { EnvManifest } from '../environment/manifest-default.ts'
import type { WorkbenchConfig } from './config.ts'

/**
 * 把 YAML 的部署值盖到内置清单上。
 *
 * 现在只有**一个**数据源：包内 YAML（部署可变值）+ 代码里的内置清单（工具/服务/工作空间偏好）。
 * 原来还会去只读 OSS 拉一份远程清单，2026-09-25 已整体下掉 —— 二进制随包发布，服务与 OSS
 * 都在 YAML 里，远程清单只剩「能让别人远程改你机器上的解释权」这一条，不再需要。
 */
export function applyDeploymentConfig(manifest: EnvManifest, config: WorkbenchConfig): EnvManifest {
  return {
    ...manifest,
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
      // 内置清单里的 `probeCommand` 永远为空：它等价于「宿主 Shell 自由脚本」，
      // 只允许来自受信的部署配置，不接受任何远程数据。
      probeCommand: '',
    },
  }
}
