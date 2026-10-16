import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { loadWorkbenchYaml } from './yaml.ts'

/** Cordis 只负责选择开发配置；实际部署值全部来自 YAML。 */
export interface PluginConfig {
  configFile: string
}

/** 房地产估值页的**浏览器来源配置**（设计稿 §4.2）。 */
export interface ValuationBrowserConfig {
  /**
   * CLI 直接吃的站点清单路径，**相对包根**（`skills/biz/.../assets/browser-sites.json`）。
   *
   * 为什么不给绝对路径：link 开发与 TGZ 安装的包根不同，写死一处必然在另一处失效；
   * 为什么不让模型提交：站点清单决定浏览器能去哪些域名。
   */
  sitesFile: string
  /** 门禁要放行必须全部 `authenticated` 的来源。 */
  requiredSiteIds: string[]
  /** 只展示、不阻塞的来源。 */
  optionalSiteIds: string[]
  /** 登录任务遇到**可见**挑战时是否允许调用固定恢复策略辅助一次。 */
  assistLoginChallenge: boolean
}

/** 房地产估值知识来源的 Host 配置（设计稿 §6.1 的第 ④ 级恢复）。 */
export interface ValuationKnowledgeConfig {
  /**
   * **身份已验证**的本地镜像根。
   *
   * - 默认**空串 = 不启用**：本机已有的那份缓存（`~/knowledge-中瑞世联业务业务知识库`）的
   *   `_manifest.json` 里 `spaceName` 是「中瑞世联评估审核知识库」（审核库），目录名像业务库
   *   **不构成**身份证明，所以不做任何默认猜测；
   * - 只有 manifest 的 `spaceName` 与业务库名逐字相等、且每个文件字节 digest 对得上时，
   *   镜像才会作为 `source = verified-mirror` 参与取数；
   * - 这个值**不进**模型可见结果，也不接受模型提交。
   */
  mirrorRoot: string
  /**
   * 资产类别的**入口 Wiki**，**相对知识库根**的库内路径（协议 39 起的唯一业务入口）。
   *
   * Skill 自己的 `references/knowledge-routing.md` 也声明了同一个入口；这里放一份是为了让
   * Host 在**会话开始前**就能取到入口正文（不必先让模型知道路径）。两处指向同一份真实知识，
   * 改库即生效、无需发版。
   */
  wikiPath: string
  /**
   * ⚠️ **遗留**：知识库侧 manifest 的位置（相对知识库根）。
   *
   * 协议 39 起业务入口是**入口 Wiki**（`wikiPath`），本键只为让仍在盘上的旧配置与旧案例
   * 继续可读而保留。取数仍走 manifest 时会在工具结果里带一条迁移提示；
   * **新部署不要再配它**，也不要再往知识库里写新的 manifest。
   */
  manifestPath: string
}

/**
 * 表格计算程序配置（协议 39）。
 *
 * 仓库**不随包发布** LibreOffice / Excel，所以它只能由部署显式指定：
 * 空串 = 本部署没有表格计算程序 = 重算 `unavailable`（报告只能 `partial`）；
 * 非空时必须是**绝对路径**（不接受 PATH 上的同名命令 —— 那等于让环境决定算什么数）。
 */
export interface ValuationRecalculationConfig {
  enginePath: string
}

/** 估值相关配置（浏览器来源 + 知识镜像 + 表格计算程序）。 */
export interface ValuationConfig {
  browser: ValuationBrowserConfig
  knowledge: ValuationKnowledgeConfig
  recalculation: ValuationRecalculationConfig
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
  valuation: ValuationConfig
}

/** 浏览器来源配置的缺省值（部署 YAML 缺这一节时用它）。 */
export const DEFAULT_VALUATION_BROWSER: ValuationBrowserConfig = {
  sitesFile: 'skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json',
  requiredSiteIds: ['lianjia'],
  optionalSiteIds: [],
  assistLoginChallenge: true,
}

/**
 * 知识镜像配置的缺省值：**镜像默认不启用**。
 *
 * 部署要显式填一个已验证的绝对路径才会生效；空串不是"还没配"，而是"本轮不启用镜像"。
 */
export const DEFAULT_VALUATION_RECALCULATION: ValuationRecalculationConfig = {
  enginePath: '',
}

export const DEFAULT_VALUATION_KNOWLEDGE: ValuationKnowledgeConfig = {
  mirrorRoot: '',
  // 与技能 `references/knowledge-routing.md` 声明的入口**逐字一致**（设计稿 §4.1）。
  wikiPath: '01 估值与测算/01 房地产/wiki.adoc',
  manifestPath: '01 估值与测算/01 房地产/00-知识目录与必需项',
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
