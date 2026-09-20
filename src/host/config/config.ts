import Schema from '@deepseek-ai/schemastery'
import { CONFIG_DEFAULTS } from './consts.ts'

/** 工作台的部署配置。 */
export interface WorkbenchConfig {
  caseRoot: string
  preferWorkspaceTitle: string
  manifestUrl: string
  installDocUrl: string
  formName: string
  ossBucket: string
  ossPrefix: string
  ossEndpoint: string
  ossLinkMode: 'signed' | 'public'
  ossLinkTtlSeconds: number
  autoUpload: boolean
  singleAuditOnly: boolean
  requireTopLevelParent: boolean
}

/** Cordis 配置 Schema。 */
export const Config: Schema<WorkbenchConfig> = Schema.object({
  caseRoot: Schema.string().default(CONFIG_DEFAULTS.caseRoot),
  preferWorkspaceTitle: Schema.string().default(CONFIG_DEFAULTS.preferWorkspaceTitle),
  manifestUrl: Schema.string().default(CONFIG_DEFAULTS.manifestUrl),
  installDocUrl: Schema.string().default(CONFIG_DEFAULTS.installDocUrl),
  formName: Schema.string().default(CONFIG_DEFAULTS.formName),
  ossBucket: Schema.string().default(CONFIG_DEFAULTS.ossBucket),
  ossPrefix: Schema.string().default(CONFIG_DEFAULTS.ossPrefix),
  ossEndpoint: Schema.string().default(CONFIG_DEFAULTS.ossEndpoint),
  ossLinkMode: Schema.union(['signed', 'public']).default(CONFIG_DEFAULTS.ossLinkMode),
  ossLinkTtlSeconds: Schema.natural().min(60).default(CONFIG_DEFAULTS.ossLinkTtlSeconds),
  autoUpload: Schema.boolean().default(CONFIG_DEFAULTS.autoUpload),
  singleAuditOnly: Schema.boolean().default(CONFIG_DEFAULTS.singleAuditOnly),
  requireTopLevelParent: Schema.boolean().default(CONFIG_DEFAULTS.requireTopLevelParent),
})
