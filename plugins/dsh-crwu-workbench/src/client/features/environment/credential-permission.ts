import type { CredentialPermission } from '../../../shared/types.ts'
import { zhCN } from '../../locales/zh-CN.ts'

/**
 * 把 Host 的结构化权限结论翻成**一句给员工看的话**（协议 17）。
 *
 * 三种结局各自对应不同的动作，混在一起说就会误导：
 *
 * - `verified`：真的收紧了（POSIX 0600 已生效）→ 不需要说什么；
 * - `inherited`：**没有**执行收紧命令（Windows 上 POSIX 0600 不适用，由当前账户 ACL 负责）
 *   → 必须说清楚，否则员工会以为这份文件被 0600 保护着；
 * - `failed`：试图收紧但失败（chmod 报错 / 被沙箱拒绝）→ 这是安全边界没守住，逐字回原因。
 *
 * 界面**不得**把 `inherited` 显示成成功，也不得把「不适用」显示成失败。
 *
 * `onlyFailures: true` 用在「本来就有更重要的提示」的分支（例如 OSS 连通性失败）：
 * 那种时候再叠一句 ACL 说明只会把真正要处理的问题挤掉。
 */
export function credentialPermissionHint(
  raw: unknown,
  options: { onlyFailures?: boolean } = {},
): string {
  const permission = asPermission(raw)
  if (permission === null) return ''
  if (permission.status === 'failed') {
    return permission.message !== '' ? permission.message : zhCN.envCredHardeningFailed
  }
  if (options.onlyFailures === true) return ''
  if (permission.status === 'inherited') {
    // 文案以本机语言包为准（Host 的 message 是给日志与 API 用的）。
    return permission.mechanism === 'windows-acl'
      ? zhCN.envCredInheritedWindowsAcl
      : (permission.message !== '' ? permission.message : zhCN.envCredInherited)
  }
  return ''
}

/** 边界收窄：Host 应答是外部输入，字段缺失或形状不对时按「没有结论」处理。 */
function asPermission(raw: unknown): CredentialPermission | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const status = record.status
  if (status !== 'verified' && status !== 'inherited' && status !== 'failed') return null
  const mechanism = record.mechanism
  if (mechanism !== 'posix-0600' && mechanism !== 'windows-acl' && mechanism !== 'host-store') {
    // 不认识的机制：仍按 status 说话（status 才是动作依据），机制按中性处理。
    return { status, mechanism: 'posix-0600', message: typeof record.message === 'string' ? record.message : '' }
  }
  return { status, mechanism, message: typeof record.message === 'string' ? record.message : '' }
}
