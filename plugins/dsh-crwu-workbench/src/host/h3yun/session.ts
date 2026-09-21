import { parseJsonLoose } from '../../shared/utils/json.ts'
import { text } from '../../shared/utils/value.ts'

/**
 * 氚云会话状态。
 *
 * `crwu h3yun session status` 的应答形状是 `{ data: { userId, expiresAt, expiresIn } }`。
 * 解析放在一处：`env` 自检与 `session` 操作都要用，各写一遍必然漂移。
 */

export interface H3yunSession {
  userId: string
  expiresAt: string
  expiresIn: string
}

export function sessionView(doc: unknown): H3yunSession | null {
  if (doc === null || typeof doc !== 'object') return null
  const data = (doc as Record<string, unknown>).data
  if (data === null || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  return {
    userId: text(record.userId),
    expiresAt: text(record.expiresAt),
    expiresIn: text(record.expiresIn),
  }
}

/** 会话说自己过期了吗；解析不出时间时**不算过期**（宁可让用户去试，也不要误判成未登录）。 */
export function isExpired(session: H3yunSession | null, now: number = Date.now()): boolean {
  if (session === null || session.expiresAt === '') return false
  const at = Date.parse(session.expiresAt)
  return !Number.isNaN(at) && at <= now
}

/** 从命令 stdout 解析会话；JSON 坏掉返回 null。 */
export function parseSessionOutput(stdout: unknown): H3yunSession | null {
  const doc = parseJsonLoose(text(stdout))
  // 解析不出来必须返回 null：调用方按 `session === null` 判「没有会话」，
  // 若喂一个空对象进去，界面会把「读不到会话」显示成「已绑定但字段为空」。
  if (doc === null) return null
  return sessionView(doc)
}
