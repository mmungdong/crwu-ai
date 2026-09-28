import { parseJsonLoose } from '../../shared/utils/json.ts'
import { text } from '../../shared/utils/value.ts'
import type { ToolErrorKind } from './consts.ts'

/**
 * 工具的统一失败包络。
 *
 * 三类失败必须**分开**（这是排查方向问题，不是措辞问题）：
 * - `approval`：DSH 审批策略拒绝（人没同意 / 没有审批通道）；
 * - `infrastructure`：shell 服务缺失、沙箱后端不可用等命令根本没跑起来的情况；
 * - `cli`：命令跑完了，退出码非 0（业务失败，stderr 是真实原因）。
 *
 * `input` / `capability-gap` / `policy` / `not-found` 是工具层自己判出来的，
 * 与上面三类不重叠。成功时 `errorKind` 为空串、`error` 为空串。
 */
export interface ToolEnvelope {
  ok: boolean
  errorKind: ToolErrorKind
  error: string
}

/** 失败包络：`ok` 是字面量 `false`，便于在联合类型里收窄。 */
export interface ToolFailure {
  ok: false
  errorKind: ToolErrorKind
  error: string
}

export function failure(errorKind: ToolErrorKind, error: string): ToolFailure {
  return { ok: false, errorKind, error: error.slice(0, 600) }
}

/**
 * 审批类失败的指纹。
 *
 * 文案来自 DSH 自身（`@deepseek-ai/dsh-sandbox` 的 `approveEscalation` 与
 * `@deepseek-ai/dsh-tools` 的 ask 分支）：
 * 「the user rejected escalating this …」「approval for escalating to … was cancelled」
 * 「requires approval, but no approval channel is available」「requires approval (not yet supported)」。
 * 所以判据是 approval / rejected / denied / cancelled 这一组词，而不是某一句固定文案。
 */
const APPROVAL_FAILURE = /approval|rejected|denied|cancelled|审批|拒绝/i

/** 命令输出 → 模型可见文本：超长时明确标注截断，不静默丢内容。 */
export function clampText(value: unknown, max: number): string {
  const raw = text(value)
  return raw.length <= max ? raw : `${raw.slice(0, max)}\n…（输出已截断，共 ${raw.length} 字符）`
}

/**
 * 把一次 shell/crwu/dws 运行归类成失败类别。
 *
 * 判据顺序很重要：取消 → 审批 → 基础设施 → 退出码。反过来会把「被取消」报成
 * 「审批被拒」，让模型去重新申请一次根本不需要的授权。
 */
export function classifyRun(run: {
  error?: string
  aborted?: boolean
  exitCode?: number | null
  ok?: boolean
}): ToolErrorKind {
  if (run.aborted === true) return 'cancelled'
  const error = text(run.error)
  if (error !== '') return APPROVAL_FAILURE.test(error) ? 'approval' : 'infrastructure'
  if (run.ok === true || run.exitCode === 0) return ''
  return 'cli'
}

/** 从任意一次运行结果里取一句最有信息量的失败描述。 */
export function reasonOf(run: { stderr?: unknown; stdout?: unknown; error?: unknown; exitCode?: number | null }): string {
  const stderr = text(run.stderr).trim()
  if (stderr !== '') return stderr.slice(0, 600)
  const error = text(run.error).trim()
  if (error !== '') return error.slice(0, 600)
  return `命令退出码 ${String(run.exitCode ?? 'unknown')}`
}

/** 把工具输出解析成 JSON 对象；不是对象就返回 null（调用方据此判「命令没返回 JSON」）。 */
export function jsonObject(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonLoose(text(value))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** 统一的成功/失败渲染：结构化 JSON 原样进模型上下文。 */
export function renderJson(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}
