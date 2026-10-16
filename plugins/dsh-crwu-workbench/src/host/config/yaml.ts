import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import {
  DEFAULT_VALUATION_BROWSER, DEFAULT_VALUATION_KNOWLEDGE, DEFAULT_VALUATION_RECALCULATION,
  type ValuationConfig, type WorkbenchConfig,
} from './config.ts'

interface ProtectedOssConfig {
  bucket: string
  endpoint: string
  baseUrl: string
  auditPrefix: string
  linkMode: 'signed' | 'public'
  linkTtlSeconds: number
}

export interface WorkbenchDeployment {
  schemaVersion: 1
  runtime: Omit<WorkbenchConfig, 'configSource' | 'ossBaseUrl'>
  oss: { protected: ProtectedOssConfig }
  source: string
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new Error(`${path} 必须是${allowEmpty ? '' : '非空'}字符串`)
  }
  return value.trim()
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} 必须是 boolean`)
  return value
}

function httpsUrl(value: unknown, path: string): string {
  const raw = string(value, path).replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${path} 必须是合法 HTTPS URL`)
  }
  if (url.protocol !== 'https:') throw new Error(`${path} 必须使用 HTTPS`)
  return url.toString().replace(/\/$/, '')
}

function positiveInteger(value: unknown, path: string, minimum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new Error(`${path} 必须是不小于 ${minimum} 的整数`)
  }
  return Number(value)
}

function objectKey(value: unknown, path: string): string {
  return string(value, path).replace(/^\/+|\/+$/g, '')
}

/** 一个来源 id：单段标识，不能是路径（它会进 CLI argv 与站点查表）。 */
function siteID(value: unknown, path: string): string {
  const raw = string(value, path)
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new Error(`${path} 必须是单段来源 id`)
  }
  return raw
}

/**
 * 一段来源 id 清单。**去重并保持声明顺序**：同一个来源既必需又可选是配置错误，
 * 而不是"两个都算" —— 门禁判据会因此自相矛盾。
 */
function siteIDList(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${path} 必须是来源 id 数组`)
  const out: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const id = siteID(value[index], `${path}[${String(index)}]`)
    if (out.includes(id)) throw new Error(`${path} 里来源 id 重复：${id}`)
    out.push(id)
  }
  return out
}

/** 把唯一 YAML 配置收窄成 Host 可直接使用的运行时配置。 */
export function parseWorkbenchYaml(sourceText: string, source = '<inline>'): WorkbenchDeployment {
  let parsed: unknown
  try {
    parsed = parse(sourceText)
  } catch (error) {
    throw new Error(`${source} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
  }

  const root = record(parsed, source)
  if (root.schemaVersion !== 1) throw new Error(`${source}: schemaVersion 必须是 1`)
  const workspace = record(root.workspace, 'workspace')
  const report = record(root.report, 'report')
  const audit = record(root.audit, 'audit')
  const oss = record(root.oss, 'oss')
  const protectedValue = record(oss.protected, 'oss.protected')

  const linkMode = string(protectedValue.linkMode, 'oss.protected.linkMode')
  if (linkMode !== 'signed' && linkMode !== 'public') {
    throw new Error('oss.protected.linkMode 只能是 signed 或 public')
  }
  const protectedOss: ProtectedOssConfig = {
    bucket: string(protectedValue.bucket, 'oss.protected.bucket'),
    endpoint: string(protectedValue.endpoint, 'oss.protected.endpoint'),
    baseUrl: httpsUrl(protectedValue.baseUrl, 'oss.protected.baseUrl'),
    auditPrefix: objectKey(protectedValue.auditPrefix, 'oss.protected.auditPrefix'),
    linkMode,
    linkTtlSeconds: positiveInteger(protectedValue.linkTtlSeconds, 'oss.protected.linkTtlSeconds', 60),
  }

  return {
    schemaVersion: 1,
    source,
    oss: { protected: protectedOss },
    runtime: {
      caseRoot: string(workspace.caseRoot, 'workspace.caseRoot', true),
      preferWorkspaceTitle: string(workspace.preferTitle, 'workspace.preferTitle'),
      formName: string(report.formName, 'report.formName'),
      ossBucket: protectedOss.bucket,
      ossPrefix: protectedOss.auditPrefix,
      ossEndpoint: protectedOss.endpoint,
      ossLinkMode: protectedOss.linkMode,
      ossLinkTtlSeconds: protectedOss.linkTtlSeconds,
      autoUpload: boolean(audit.autoUpload, 'audit.autoUpload'),
      requireTopLevelParent: boolean(workspace.requireTopLevelParent, 'workspace.requireTopLevelParent'),
      valuation: parseValuation(root.valuation, source),
    },
  }
}

/**
 * `valuation` 一节。
 *
 * 缺整节时**退回内置缺省**（link 开发的旧配置、或部署还没跟上新版本时不该整包启动失败）；
 * 但节内一旦写了字段，就按严格口径校验 —— 静默忽略写错的来源 id 会让门禁悄悄放行。
 */
function parseValuation(value: unknown, source: string): ValuationConfig {
  const defaults = {
    browser: { ...DEFAULT_VALUATION_BROWSER },
    knowledge: { ...DEFAULT_VALUATION_KNOWLEDGE },
    recalculation: { ...DEFAULT_VALUATION_RECALCULATION },
  }
  if (value === undefined || value === null) return defaults
  const root = record(value, `${source}: valuation`)
  return {
    browser: parseValuationBrowser(root.browser),
    knowledge: parseValuationKnowledge(root.knowledge),
    recalculation: parseValuationRecalculation(root.recalculation),
  }
}

/**
 * `valuation.recalculation`（协议 39）。
 *
 * - `enginePath`：表格计算程序的**绝对路径**；空串（默认）= 本部署没有它 = 重算 `unavailable`。
 *   绝对路径是硬要求：相对路径会跟着进程 cwd 变，等于让"在哪启动"决定算什么数。
 */
function parseValuationRecalculation(value: unknown): ValuationConfig['recalculation'] {
  if (value === undefined || value === null) return { ...DEFAULT_VALUATION_RECALCULATION }
  const root = record(value, 'valuation.recalculation')
  const raw = root.enginePath
  let enginePath = DEFAULT_VALUATION_RECALCULATION.enginePath
  if (raw !== undefined && raw !== null) {
    const text = string(raw, 'valuation.recalculation.enginePath', true)
    if (text !== '') {
      const absolute = text.startsWith('/') || /^[A-Za-z]:[\/]/.test(text) || text.startsWith('\\\\')
      if (!absolute || text.split(/[\\/]/).includes('..')) {
        throw new Error('valuation.recalculation.enginePath 必须是非空绝对路径且不含 `..`（默认留空 = 本部署没有表格计算程序）')
      }
      enginePath = text
    }
  }
  return { enginePath }
}

function parseValuationBrowser(browserValue: unknown): ValuationConfig['browser'] {
  if (browserValue === undefined || browserValue === null) return { ...DEFAULT_VALUATION_BROWSER }
  const browser = record(browserValue, 'valuation.browser')
  const required = siteIDList(browser.requiredSiteIds, 'valuation.browser.requiredSiteIds')
  const optional = siteIDList(browser.optionalSiteIds, 'valuation.browser.optionalSiteIds')
  const both = required.filter((id) => optional.includes(id))
  if (both.length > 0) {
    throw new Error(`valuation.browser 里同一个来源不能既必需又可选：${both.join('、')}`)
  }
  const sitesFile = browser.sitesFile === undefined || browser.sitesFile === null
    ? DEFAULT_VALUATION_BROWSER.sitesFile
    : string(browser.sitesFile, 'valuation.browser.sitesFile')
  if (sitesFile.startsWith('/') || /^[A-Za-z]:/.test(sitesFile) || sitesFile.includes('..')) {
    throw new Error('valuation.browser.sitesFile 必须是相对包根的路径')
  }
  return {
    sitesFile,
    requiredSiteIds: required,
    optionalSiteIds: optional,
    assistLoginChallenge: browser.assistLoginChallenge === undefined || browser.assistLoginChallenge === null
      ? DEFAULT_VALUATION_BROWSER.assistLoginChallenge
      : boolean(browser.assistLoginChallenge, 'valuation.browser.assistLoginChallenge'),
  }
}

/**
 * `valuation.knowledge` 一节：知识入口。
 *
 * - `mirrorRoot`：**身份已验证**的镜像根。空串是合法且默认的取值（= 不启用镜像）；非空时必须是
 *   绝对路径且不含 `..` —— 相对路径会让"镜像根"随进程 cwd 漂移，同一份配置在两台机器上读到不同目录。
 * - `wikiPath`：入口 Wiki 的库内路径（协议 39 起的唯一业务入口）。校验口径与 `manifestPath` 同构；
 * - `manifestPath`（**遗留**）：知识库侧 manifest 的位置，相对知识库根。新部署不要再配它。校验口径与
 *   `valuation.browser.sitesFile` 同构（非空、不以 `/` 开头、不含 `..`），与 `mirrorRoot`
 *   的绝对路径口径**不同** —— 前者是库内路径，后者是文件系统路径。
 */
function parseValuationKnowledge(knowledgeValue: unknown): ValuationConfig['knowledge'] {
  if (knowledgeValue === undefined || knowledgeValue === null) return { ...DEFAULT_VALUATION_KNOWLEDGE }
  const knowledge = record(knowledgeValue, 'valuation.knowledge')

  // 两个键**各自独立回退**：只配了其中一个时，另一个必须拿缺省值而不是被整体丢弃。
  const rawMirror = knowledge.mirrorRoot
  let mirrorRoot = DEFAULT_VALUATION_KNOWLEDGE.mirrorRoot
  if (rawMirror !== undefined && rawMirror !== null) {
    const value = string(rawMirror, 'valuation.knowledge.mirrorRoot', true)
    if (value !== '') {
      if (!/^([A-Za-z]:[\\/]|[\\/])/.test(value) || value.split(/[\\/]+/).includes('..')) {
        throw new Error('valuation.knowledge.mirrorRoot 必须是非空绝对路径且不含 `..`（默认留空 = 不启用镜像）')
      }
      mirrorRoot = value
    }
  }

  const rawWiki = knowledge.wikiPath
  let wikiPath = DEFAULT_VALUATION_KNOWLEDGE.wikiPath
  if (rawWiki !== undefined && rawWiki !== null) {
    const value = string(rawWiki, 'valuation.knowledge.wikiPath', true)
    if (value === '' || value.startsWith('/') || value.split('/').includes('..')) {
      throw new Error('valuation.knowledge.wikiPath 必须是相对知识库根的非空路径且不含 `..`')
    }
    wikiPath = value
  }

  const rawManifest = knowledge.manifestPath
  let manifestPath = DEFAULT_VALUATION_KNOWLEDGE.manifestPath
  if (rawManifest !== undefined && rawManifest !== null) {
    const value = string(rawManifest, 'valuation.knowledge.manifestPath', true)
    if (value === '' || value.startsWith('/') || value.split('/').includes('..')) {
      throw new Error(
        'valuation.knowledge.manifestPath 必须是相对知识库根的非空路径且不含 `..`'
          + '（例如 `01 估值与测算/01 房地产/00-知识目录与必需项`）',
      )
    }
    manifestPath = value
  }

  return { mirrorRoot, wikiPath, manifestPath }
}

/** 开发模式可显式传路径；包内运行时传入随 TGZ 安装的 YAML 路径。 */
export function loadWorkbenchYaml(configFile: string): WorkbenchDeployment {
  return parseWorkbenchYaml(readFileSync(configFile, 'utf8'), configFile)
}
