import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { renderJson } from '../common/outcome.ts'

export const VALUATION_WORKFLOW_CONTROL_TOOL = 'crwu_valuation_workflow_run'

const CAPABILITY_GAP = '本轮工作流运行时没有装配：不能进入工作流'
const EXECUTION_FAILURE = '工作流执行失败'

/** The control tool only needs the opaque command entry point. */
export interface ValuationWorkflowControlRuntime {
  execute(commandId: string, execution: ToolRunContext): Promise<unknown>
}

export interface ValuationWorkflowControlDeps {
  /** Optional: when absent the tool reports a structured capability gap. */
  workflowRuntime?: ValuationWorkflowControlRuntime
}

interface ValuationWorkflowControlResult {
  ok: boolean
  errorKind: string
  error: string
  snapshot: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Forward the Host-minted command id unchanged; a non-string becomes an unknown command. */
function commandIdOf(args: unknown): string {
  if (!isRecord(args)) return ''
  const value = args.commandId
  return typeof value === 'string' ? value : ''
}

/** Keep the result a four-field lossless JSON value (no undefined members). */
function normalizeOutcome(value: unknown): ValuationWorkflowControlResult {
  if (!isRecord(value)) {
    return { ok: false, errorKind: 'failed', error: EXECUTION_FAILURE, snapshot: null }
  }
  return {
    ok: value.ok === true,
    errorKind: typeof value.errorKind === 'string' ? value.errorKind : '',
    error: typeof value.error === 'string' ? value.error : '',
    snapshot: isRecord(value.snapshot) ? value.snapshot : null,
  }
}

/**
 * Bounded model-visible status for the canonical control result. The full snapshot
 * stays on the Tool result for the Host/UI; the model render never carries receipts,
 * stages or knowledge.
 */
function renderControlStatus(value: unknown): { type: 'text'; text: string }[] {
  const outcome = isRecord(value) ? value : {}
  const snapshot = isRecord(outcome.snapshot) ? outcome.snapshot : {}
  const status = typeof snapshot.status === 'string' ? snapshot.status : ''
  return renderJson({
    ok: outcome.ok === true,
    errorKind: typeof outcome.errorKind === 'string' ? outcome.errorKind : '',
    error: typeof outcome.error === 'string' ? outcome.error : '',
    runId: typeof snapshot.runId === 'string' ? snapshot.runId : '',
    revision: typeof snapshot.revision === 'number' && Number.isFinite(snapshot.revision)
      ? snapshot.revision : null,
    status,
    waiting: status === 'waiting-user',
  })
}

export function valuationWorkflowTools(deps: ValuationWorkflowControlDeps): ToolDefinition[] {
  const tool: ToolDefinition = {
    name: VALUATION_WORKFLOW_CONTROL_TOOL,
    description: [
      '推进本轮房地产估值工作流：提交 Host 铸造的不透明命令标识，由宿主在真实会话范围里执行。',
      'commandId 只来自 Host 的提示，不得自行编造；本工具不接受路径、提示词、模型或工具名。',
      '返回的是受控图状态：执行暂停、终态或失败都会让父会话在本回合停止，不代替图继续业务推进。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        commandId: { type: 'string', description: 'Host 铸造的不透明工作流命令标识' },
      },
      required: ['commandId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '本次命令是否被接受' },
          errorKind: { type: 'string', description: '失败类别；成功为空串' },
          error: { type: 'string', description: '用户可见的失败说明；成功为空串' },
          snapshot: { description: '当前工作流快照；没有业务快照时为 null' },
        },
        required: ['ok', 'errorKind', 'error', 'snapshot'],
      },
      render: (_args, value) => renderControlStatus(value),
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      // Forward the genuine execution context unchanged; the runtime re-checks ownership.
      try {
        const runtime = deps.workflowRuntime
        if (runtime === undefined) {
          return { ok: false, errorKind: 'capability-gap', error: CAPABILITY_GAP, snapshot: null }
        }
        return normalizeOutcome(await runtime.execute(commandIdOf(args), exec))
      } catch {
        return { ok: false, errorKind: 'failed', error: EXECUTION_FAILURE, snapshot: null }
      } finally {
        // Conclude the outer round exactly once, whatever the graph outcome.
        exec.concludeTurn()
      }
    },
  }
  return [tool]
}
