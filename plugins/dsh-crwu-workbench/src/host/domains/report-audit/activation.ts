import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { text } from '../../../shared/utils/value.ts'
import { AUDIT_CHILD_DENIED_TOOLS, REQUIRED_AUDIT_CHILD_TOOLS } from '../../tools/report-audit/consts.ts'
import type { AuditChildRun, AuditSubagentRuntime } from './subagent-runtime.ts'

interface ChildTools {
  restrict(filter: { deny: string[] }): () => void
  get(name: string, scope: Agent): unknown
}

export async function startAuditActivation(
  ctx: Context,
  runtime: AuditSubagentRuntime,
  provider: string,
  parent: Agent,
  input: { label: string; prompt: string; signal: AbortSignal },
): Promise<{ run?: AuditChildRun; error: string }> {
  if (typeof ctx.on !== 'function') return { error: '无法监听子会话创建窗口，拒绝创建审核子会话。' }
  const reservedId = `session-${randomUUID()}`
  let child: Agent | undefined
  let verified = false
  let attempted = false
  let run: AuditChildRun = { id: reservedId }
  let remove: (() => void) | undefined
  try {
    const off = ctx.on('agent/created', ({ agent }) => {
      if (text(agent.id) !== reservedId) return
      child = agent
      if (text(agent.session.header.id) !== reservedId
        || text(agent.session.header.parentSession) !== text(parent.id)) {
        throw new Error('审核子会话的父子身份不匹配')
      }
      const tools = agent.ctx.get('tools') as ChildTools | undefined
      if (typeof tools?.restrict !== 'function' || typeof tools.get !== 'function') {
        throw new Error('无法验证审核子会话的工具边界')
      }
      // The serial creation hook finishes before the first model turn.
      tools.restrict({ deny: [...AUDIT_CHILD_DENIED_TOOLS] })
      if (AUDIT_CHILD_DENIED_TOOLS.some((name) => tools.get(name, agent) !== undefined)
        || REQUIRED_AUDIT_CHILD_TOOLS.some((name) => tools.get(name, agent) === undefined)) {
        throw new Error('审核子会话的工具限制回读失败')
      }
      verified = true
    }, { global: true })
    if (typeof off !== 'function') return { error: '创建监听无法释放，拒绝创建审核子会话。' }
    remove = off
    attempted = true
    const activation = await runtime.startActivation!({
      childId: reservedId,
      provider,
      label: input.label,
      delivery: 'caller',
      signal: input.signal,
      request: { parent, prompt: [{ type: 'text', text: input.prompt }] },
    })
    const actualId = text(activation?.childId)
    run = {
      id: child === undefined && actualId !== '' ? actualId : reservedId,
      ...(child === undefined ? {} : { localAgent: child }),
      ...(activation?.result === undefined ? {} : { result: activation.result }),
      ...(typeof activation?.dispose !== 'function' || (child !== undefined && actualId !== reservedId)
        ? {} : { dispose: () => activation.dispose!() }),
    }
    // The lifecycle event owns audit status; consume infrastructure rejections too.
    if (typeof activation?.result?.catch === 'function') void activation.result.catch(() => undefined)
    if (actualId !== reservedId || !verified || child === undefined
      || typeof activation?.result?.then !== 'function' || typeof activation.dispose !== 'function') {
      return { run, error: '无法验证 activation 收据或审核子会话的工具边界。' }
    }
    return { run, error: '' }
  } catch {
    return {
      ...(attempted ? { run: { ...run, ...(child === undefined ? {} : { localAgent: child }) } } : {}),
      error: '创建审核子会话失败：activation 创建或工具边界校验未通过。',
    }
  } finally {
    remove?.()
  }
}
