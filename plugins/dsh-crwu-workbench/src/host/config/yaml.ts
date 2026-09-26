import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import type { WorkbenchConfig } from './config.ts'

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
    },
  }
}

/** 开发模式可显式传路径；包内运行时传入随 TGZ 安装的 YAML 路径。 */
export function loadWorkbenchYaml(configFile: string): WorkbenchDeployment {
  return parseWorkbenchYaml(readFileSync(configFile, 'utf8'), configFile)
}
