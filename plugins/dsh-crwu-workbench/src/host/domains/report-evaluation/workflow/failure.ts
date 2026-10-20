import type { ValuationWorkflowNodeFailure } from '../../../../shared/contracts/valuation-workflow.ts'

const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 4_000
const list = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(text)
const GENERIC_REASONS = new Set(['失败', '受阻', '不通过', '未通过', '节点失败', '节点受阻', '节点没有通过', 'unknown', 'error', 'failed', 'blocked'])

export function readNodeFailure(value: unknown): ValuationWorkflowNodeFailure | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const failure = value as Record<string, unknown>
  if (Object.keys(failure).some((key) => !['kind', 'reason', 'requirements', 'actions'].includes(key))
    || !['business', 'output-contract', 'system'].includes(String(failure.kind))
    || !text(failure.reason) || GENERIC_REASONS.has(failure.reason.trim().replace(/[。.!！]/g, '').toLowerCase())
    || !list(failure.requirements) || !list(failure.actions)) return null
  return { kind: failure.kind as ValuationWorkflowNodeFailure['kind'], reason: failure.reason,
    requirements: [...failure.requirements], actions: [...failure.actions] }
}

export function nodeFailure(kind: ValuationWorkflowNodeFailure['kind'], gaps: string[]): ValuationWorkflowNodeFailure {
  const requirements = gaps.filter((gap) => typeof gap === 'string' && gap.trim() !== '').map((gap) => gap.slice(0, 4_000)).slice(0, 64)
  if (requirements.length === 0) requirements.push('本次执行没有记录具体失败原因，无法判定需要补充哪些业务信息。')
  return { kind, reason: requirements.join('；').slice(0, 4_000), requirements,
    actions: kind === 'business'
      ? ['按上述未满足要求补齐资料或更正答案，再重新执行该节点。']
      : ['打开本节点会话核查执行记录；修复上述故障后重新执行。无需猜测补充业务答案。'] }
}
