/**
 * 更新专用的 Client 门面：四个操作名 + **运行时收窄**。
 *
 * 两条边界：
 * 1. **只发空参数**。四个方法都是零参数方法，每次请求都发 `{}`；调用方就算硬塞
 *    `version` / `registry` / `spec` / `command`，也进不了请求体。安装目标只能由 Host 自己
 *    授权（Host 侧 `update/ops.ts` 会拒绝任何带参数的 `update-install`）。
 * 2. **Host 返回的是不可信 JSON**。这里逐字段重建安全对象：未知状态、未知枚举、类型不符、
 *    多余的 registry metadata / 日志 / requestId 一律不接受。收窄结果喂给 Store，绝不把
 *    原始 JSON 直接当成 UI 状态。
 */
import { rpc } from '../../api/client.ts'
import { UPDATE_OPERATION_NAMES } from '../../../shared/consts.ts'
import type {
  UpdateCandidate,
  UpdateCheckState,
  UpdateInstallState,
  UpdateSourceKind,
} from '../../../shared/update/types.ts'

/** 更新四个方法的传输注入点：默认走同源 RPC，测试可直接替换（不必碰 global fetch）。 */
export type UpdateTransport = (operation: string, args: unknown) => Promise<unknown>

export interface UpdateApi {
  updateStatus: () => Promise<unknown>
  updateCheck: () => Promise<unknown>
  updateInstall: () => Promise<unknown>
  updateCancel: () => Promise<unknown>
}

/**
 * 方法名 → Host 操作名。
 *
 * 操作名来自共享常量（协议 16 的单一事实源），`OPERATION_OF` 从这张局部映射**组合**出来 ——
 * 不允许在聚合表里再手写一遍字符串。
 */
export const UPDATE_METHOD_OPERATION = {
  updateStatus: UPDATE_OPERATION_NAMES[0],
  updateCheck: UPDATE_OPERATION_NAMES[1],
  updateInstall: UPDATE_OPERATION_NAMES[2],
  updateCancel: UPDATE_OPERATION_NAMES[3],
} as const

/**
 * 建立四个更新方法。
 *
 * 返回值刻意是 `Promise<unknown>`：Host 的 JSON 还没经过收窄，谁都不能把它断言成可信状态。
 * 收窄是 `parseUpdateResponse()` 的职责，由 Store 调用。
 */
export function createUpdateApi(
  transport: UpdateTransport = (operation, args) => rpc(operation, args),
): UpdateApi {
  // 零参数：调用方多传的参数在签名处就被丢掉了，请求体永远是 {}。
  const call = (operation: string) => async (): Promise<unknown> => await transport(operation, {})
  return {
    updateStatus: call(UPDATE_METHOD_OPERATION.updateStatus),
    updateCheck: call(UPDATE_METHOD_OPERATION.updateCheck),
    updateInstall: call(UPDATE_METHOD_OPERATION.updateInstall),
    updateCancel: call(UPDATE_METHOD_OPERATION.updateCancel),
  }
}

/** 默认门面（组合进 `workbenchApi` 的那一份）。 */
export const updateApi: UpdateApi = createUpdateApi()

// ---------------------------------------------------------------------------
// 运行时收窄
// ---------------------------------------------------------------------------

/** 收窄结果：`ok` 的两半各自可能是 `null`（那一半不认识，Store 要保留旧值）。 */
export type ParsedUpdateResponse =
  | {
      kind: 'ok'
      check: UpdateCheckState | null
      install: UpdateInstallState | null
      /** 哪一半没认出来（保留旧值，并记一条稳定 code）。 */
      invalid: Array<'check' | 'install'>
    }
  /** Host 的边界拒绝信封（例如 `update-install` 收到参数）；文案一律丢弃。 */
  | { kind: 'rejected' }
  /** 整个信封不认识（不是对象 / ok 不是布尔 / 拒绝信封缺 error 文本）。 */
  | { kind: 'malformed'; code: 'malformed-envelope' }

const CHECK_STATUSES = ['idle', 'checking', 'up-to-date', 'available', 'unsupported', 'error'] as const
const UNSUPPORTED_REASONS = ['development-install', 'manager-unavailable', 'enterprise-registry'] as const
const CHECK_ERROR_KINDS = ['network', 'timeout', 'not-found', 'invalid-metadata', 'too-large', 'unknown'] as const
const INSTALL_STATUSES = ['idle', 'installing', 'awaiting-restart', 'failed', 'cancelled', 'updated'] as const
const INSTALL_STAGES = ['connecting', 'downloading', 'installing', 'cancelling'] as const
const INSTALL_ERROR_KINDS = [
  'source-unavailable', 'not-found', 'network', 'timeout', 'disk-full', 'permission',
  'integrity', 'build-blocked', 'incompatible-version', 'audit-active', 'busy', 'cancelled', 'unknown',
] as const
const SOURCE_KINDS = ['npmmirror', 'npm'] as const

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

/** 候选：只保留线协议允许的六个字段，其余（registry / 日志 / requestId …）一律丢掉。 */
function narrowCandidate(value: unknown): UpdateCandidate | null {
  const raw = asRecord(value)
  if (raw === null) return null
  const currentVersion = asText(raw.currentVersion)
  const targetVersion = asText(raw.targetVersion)
  const sourceKind = oneOf<UpdateSourceKind>(raw.sourceKind, SOURCE_KINDS)
  const checkedAt = asText(raw.checkedAt)
  const expiresAt = asText(raw.expiresAt)
  if (currentVersion === null || targetVersion === null || sourceKind === null) return null
  if (checkedAt === null || expiresAt === null) return null

  const candidate: UpdateCandidate = { currentVersion, targetVersion, sourceKind, checkedAt, expiresAt }
  if (raw.publishedAt !== undefined) {
    const publishedAt = asText(raw.publishedAt)
    if (publishedAt === null) return null
    candidate.publishedAt = publishedAt
  }
  return candidate
}

function narrowCheck(value: unknown): UpdateCheckState | null {
  const raw = asRecord(value)
  if (raw === null) return null
  const status = oneOf(raw.status, CHECK_STATUSES)
  if (status === null) return null
  switch (status) {
    case 'idle':
      return { status }
    case 'checking': {
      if (raw.cached === undefined) return { status }
      const cached = narrowCandidate(raw.cached)
      return cached === null ? null : { status, cached }
    }
    case 'up-to-date': {
      const checkedAt = asText(raw.checkedAt)
      return checkedAt === null ? null : { status, checkedAt }
    }
    case 'available': {
      const checkedAt = asText(raw.checkedAt)
      const candidate = narrowCandidate(raw.candidate)
      return checkedAt === null || candidate === null ? null : { status, checkedAt, candidate }
    }
    case 'unsupported': {
      const reason = oneOf(raw.reason, UNSUPPORTED_REASONS)
      return reason === null ? null : { status, reason }
    }
    case 'error': {
      const kind = oneOf(raw.kind, CHECK_ERROR_KINDS)
      const checkedAt = asText(raw.checkedAt)
      return kind === null || checkedAt === null ? null : { status, kind, checkedAt }
    }
  }
}

function narrowInstall(value: unknown): UpdateInstallState | null {
  const raw = asRecord(value)
  if (raw === null) return null
  const status = oneOf(raw.status, INSTALL_STATUSES)
  if (status === null) return null
  switch (status) {
    case 'idle':
      return { status }
    case 'installing': {
      const stage = oneOf(raw.stage, INSTALL_STAGES)
      const targetVersion = asText(raw.targetVersion)
      const startedAt = asText(raw.startedAt)
      return stage === null || targetVersion === null || startedAt === null
        ? null
        : { status, stage, targetVersion, startedAt }
    }
    case 'awaiting-restart': {
      const targetVersion = asText(raw.targetVersion)
      const installedAt = asText(raw.installedAt)
      return targetVersion === null || installedAt === null ? null : { status, targetVersion, installedAt }
    }
    case 'failed': {
      const kind = oneOf(raw.kind, INSTALL_ERROR_KINDS)
      if (kind === null) return null
      const state: UpdateInstallState = { status, kind }
      if (raw.targetVersion !== undefined) {
        const targetVersion = asText(raw.targetVersion)
        if (targetVersion === null) return null
        state.targetVersion = targetVersion
      }
      return state
    }
    case 'cancelled': {
      const state: UpdateInstallState = { status }
      if (raw.targetVersion !== undefined) {
        const targetVersion = asText(raw.targetVersion)
        if (targetVersion === null) return null
        state.targetVersion = targetVersion
      }
      return state
    }
    case 'updated': {
      const version = asText(raw.version)
      return version === null ? null : { status, version }
    }
  }
}

/** 收窄一次更新操作响应。任何不认识的东西都不会进入 UI 状态。 */
export function parseUpdateResponse(raw: unknown): ParsedUpdateResponse {
  const envelope = asRecord(raw)
  if (envelope === null) return { kind: 'malformed', code: 'malformed-envelope' }
  if (envelope.ok === false) {
    // 边界拒绝：`error` 必须是字符串才算合法信封；文本本身**不保留**（不可信字符串不进 UI）。
    return asText(envelope.error) === null
      ? { kind: 'malformed', code: 'malformed-envelope' }
      : { kind: 'rejected' }
  }
  if (envelope.ok !== true) return { kind: 'malformed', code: 'malformed-envelope' }

  const invalid: Array<'check' | 'install'> = []
  const check = narrowCheck(envelope.check)
  if (check === null) invalid.push('check')
  const install = narrowInstall(envelope.install)
  if (install === null) invalid.push('install')
  return { kind: 'ok', check, install, invalid }
}
