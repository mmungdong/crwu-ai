import type { Context } from '@deepseek-ai/cordis'
import { parseJsonLoose } from '../../shared/utils/json.ts'
import { text } from '../../shared/utils/value.ts'
import { runShell } from '../shell/run.ts'

/**
 * 取「我是谁」——面板头部那句问候里的姓名。
 *
 * 数据源只有一个：钉钉 CLI（`dws contact user get-self`）。返回体里
 * `result[0].orgEmployeeModel` 带着 `orgUserName`（姓名）、`orgName`（公司）与 `userId`，
 * 所以这里不做文本匹配，直接解析 JSON。
 *
 * 三条与「钉钉认证」探测同源的约束（**不要在这里另立一套**）：
 *
 * 1. **必须提权**：dws 的 token 在系统钥匙串里，受限沙箱下读不到，它会如实回「未登录」——
 *    也就是说沙箱里问出来的"没登录"是假结论。所以调用方**只在员工已授权**（`trustCredentials`）
 *    时才该走到这里；`sandboxPolicy` 由 `runShell` 的 `escalate` 声明。
 * 2. **提权命令必须有工作目录**：DSH 拒绝「无工作区的提权执行」，所以 `workdir` 是必填。
 * 3. **失败一律降级成"没有姓名"**，绝不抛：这句问候是装饰，不能因为它把面板搞崩。
 *    `name: ''` 就是"什么也不展示"的契约（用户 2026-09-22 口径）。
 */

export interface WhoamiResult {
  /** 姓名；拿不到就是空串（界面据此整句不展示）。 */
  name: string
  /** 公司名（`orgName`）；拿不到就是空串。界面目前不展示，留给排查与将来的用法。 */
  org: string
  userId: string
  /** 拿不到时的**真实原因**（命令没跑起来 / 没登录 / 解析不出来），不是给用户看的错误。 */
  reason: string
}

export interface WhoamiDeps {
  ctx: Context
  workdir: () => Promise<string>
  timeoutMs?: number
}

const EMPTY: WhoamiResult = { name: '', org: '', userId: '', reason: '' }

/** 单个 `orgEmployeeModel`（外部 JSON，逐字段收窄）。 */
function readEmployee(model: unknown): { name: string; org: string; userId: string } | null {
  if (model === null || typeof model !== 'object') return null
  const doc = model as Record<string, unknown>
  const name = text(doc.orgUserName)
  if (name === '') return null
  return { name, org: text(doc.orgName), userId: text(doc.userId) }
}

/** 从 `dws contact user get-self --format json` 的返回体里取员工信息。 */
export function readSelfDocument(payload: unknown): { name: string; org: string; userId: string } | null {
  if (payload === null || typeof payload !== 'object') return null
  const doc = payload as Record<string, unknown>
  const result = doc.result
  if (!Array.isArray(result) || result.length === 0) return null
  const first = result[0]
  if (first === null || typeof first !== 'object') return null
  return readEmployee((first as Record<string, unknown>).orgEmployeeModel)
}

export async function dwsSelf(deps: WhoamiDeps): Promise<WhoamiResult> {
  // 命令是固定的字面量（没有用户输入、没有需要转义的字符），与「钉钉认证」那条探测同样写法。
  const run = await runShell(deps.ctx, 'dws contact user get-self --format json', {
    workdir: await deps.workdir(),
    timeoutMs: deps.timeoutMs ?? 30_000,
    escalate: true,
  })
  if (!run.ok) {
    // 命令**没跑起来**与「跑完了但没登录」是两件事：都要如实带原因回去（界面反正不展示）。
    return { ...EMPTY, reason: text(run.error) || text(run.stderr) || '取个人信息失败' }
  }
  const employee = readSelfDocument(parseJsonLoose(run.stdout))
  if (employee === null) return { ...EMPTY, reason: '钉钉没有返回个人信息（多半是没登录）' }
  return { ...employee, reason: '' }
}
