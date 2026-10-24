import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { requireBoundValuationActor, type ValuationServicePrincipal } from './access.ts'
import type { HostWorkflowServiceDeps } from './deps.ts'

export async function readMarketEvidence(deps: HostWorkflowServiceDeps, principal: ValuationServicePrincipal, path: string,
  expectedDigest?: string): Promise<{ body: string; digest: string; bytes: number }> {
  const bound = requireBoundValuationActor(principal, deps)
  const call = { operation: 'system.case-file.read', source: 'audit-tool', workdir: principal.caseDir } as const
  if (!bound.ok || principal.signal?.aborted || !deps.access.authorize(call).ok) throw new Error('本轮证据读取未获授权，请恢复本轮执行后重试')
  if (!path || /^[\\/]|[:\x00-\x1f]/.test(path) || path.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new Error('证据路径不是案例内的登记路径')
  const root = await realpath(principal.caseDir)
  const target = await realpath(resolve(principal.caseDir, path))
  const inside = relative(root, target)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('证据路径越出本轮案例，请重新取得证据')
  const data = await readFile(target)
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
  if (!data.length || data.length > 64 * 1024 * 1024 || (expectedDigest && digest !== expectedDigest)) throw new Error('证据字节或摘要与登记不一致，请重新核对来源')
  const current = requireBoundValuationActor(principal, deps)
  if (!current.ok || current.actor.scopeKey !== bound.actor.scopeKey || !deps.access.authorize(call).ok || principal.signal?.aborted) throw new Error('本轮证据读取授权已变化，请回到当前任务重试')
  deps.access.note(call, { summary: 'valuation market evidence verification' })
  return { body: data.toString('utf8'), digest, bytes: data.length }
}
