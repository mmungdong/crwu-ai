/**
 * DSH-backed intent inference for the valuation business graph.
 *
 * The child is fresh and non-inheriting and must return one structured intent
 * object. The adapter validates provenance with the graph's own intent validator
 * before publishing the actual child session id. The start itself goes through
 * `subagent-start.ts`: the loaded DSH line decides whether that is
 * `startActivation` (0.2.x) or `start` (0.1.7).
 */
import type { DshWorkflowInferenceOptions } from './inference.ts'
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { validateIntent } from '../../graph/valuation/intent.ts'
import type { ValuationIntent, WorkflowInput } from '../../graph/state.ts'
import { STOP_UNKNOWN_ERROR, resolveStopTimeoutMs, stopChild } from './lifecycle.ts'
import {
  eligibleProvider, hasSubagentStart, startSubagentChild,
  type SubagentRunLike, type SubagentRuntimeLike,
} from './subagent-start.ts'

export type DshIntentFailureKind = 'capability-gap' | 'failed' | 'cancelled' | 'stop-unknown'

export type DshIntentResult =
  | { ok: true; sessionId: string; intent: ValuationIntent }
  | { ok: false; error: string; errorKind: DshIntentFailureKind; sessionId?: string }

export interface DshWorkflowIntentPort {
  infer(
    input: WorkflowInput,
    registeredAssetIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<DshIntentResult>
}

const PUBLIC_INFRASTRUCTURE_ERROR = '意图子会话基础设施错误：详情已省略，请由 Host 诊断后重试'
const PUBLIC_JOURNAL_ERROR = '子会话日志写入失败：详情已省略，已停止该子会话'
const CANCELLED_ERROR = '本次意图识别已被取消'

const INTENT_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    business: { type: 'string', enum: ['valuation', 'unknown'] },
    assetType: {
      oneOf: [
        { type: 'string' },
        { type: 'null' },
      ],
    },
    status: { type: 'string', enum: ['resolved', 'needs-clarification', 'unsupported'] },
    objects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objectId: { type: 'string' },
          materialIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['objectId', 'materialIds'],
      },
    },
    evidence: {
      type: 'array',
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              materialId: { type: 'string' },
              quote: { type: 'string' },
            },
            required: ['materialId', 'quote'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              source: { type: 'string', const: 'user-input' },
              quote: { type: 'string' },
            },
            required: ['source', 'quote'],
          },
        ],
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['business', 'assetType', 'status', 'objects', 'evidence', 'questions'],
}

function gap(message: string): DshIntentResult {
  return { ok: false, errorKind: 'capability-gap', sessionId: '', error: message }
}

function workspaceFailure(sessionId: string): DshIntentResult {
  return {
    ok: false,
    errorKind: 'capability-gap',
    sessionId,
    error: `子会话没能挂到当前工作区并回读：${PUBLIC_INFRASTRUCTURE_ERROR}`,
  }
}

function intentPrompt(input: WorkflowInput, registeredAssetIds: readonly string[]): string {
  const materials = input.materials
    .map((material) => `- ${material.fileName} (${material.materialId} @${material.digest})\n${material.text}`)
    .join('\n\n')
  return [
    '任务：从用户输入和材料正文中识别估值意图，只输出 JSON 结构化对象。',
    '只输出一个 JSON 对象；不要前言、解释、叙述、Markdown 代码块，也不要调用任何工具。',
    'JSON 必须且只能包含 business, assetType, status, objects, evidence, questions 六个字段。',
    `本次必须遵守的 JSON Schema：${JSON.stringify(INTENT_OUTPUT_SCHEMA)}`,
    'business 为 "valuation" 或 "unknown"；status 为 "resolved"、"needs-clarification" 或 "unsupported"。',
    'assetType 为字符串或 null。objects 是 [{objectId, materialIds}]；materialIds 只能引用已提交材料标识。',
    'evidence 每项为 {"materialId","quote"} 或 {"source":"user-input","quote"}；quote 必须是对应正文的原文子串。',
    '信息不足时使用 needs-clarification 并提供具体问题；不得猜测对象或编造证据。',
    `已注册资产类型：${registeredAssetIds.length === 0 ? '（无）' : registeredAssetIds.join(', ')}`,
    '未注册的资产类型可以如实填写，但不会进入执行。',
    `用户输入：\n${input.text}`,
    materials === '' ? '已提交材料：（无）' : `已提交材料：\n${materials}`,
    `最初提交的入口选择快照（仅供范围参考，当前用户输入与材料正文才是本次意图依据）：${JSON.stringify(input.initialInput ?? null)}`,
    '缺失的可选目的 / 基准日 / 价值类型不是必须追问的问题；只有估值对象或证据确实无法从当前正文确定时才使用 needs-clarification，不得猜对象或编造证据。',
  ].join('\n\n')
}

function intentContractError(value: unknown): string {
  const problems: string[] = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) problems.push('缺少结构化对象。')
  else {
    const record = value as Record<string, unknown>
    for (const [key, schema] of Object.entries(INTENT_OUTPUT_SCHEMA.properties!)) {
      if (record[key] === undefined) problems.push(`缺少 ${key} 字段。`)
      else if (validateJsonSchemaValue(schema, record[key]).length > 0) problems.push(`${key} 的类型或嵌套字段不符合意图契约。`)
    }
    if (Object.keys(record).some((key) => !Object.hasOwn(INTENT_OUTPUT_SCHEMA.properties!, key))) problems.push('包含意图契约未允许的字段，未采用其内容。')
  }
  if (problems.length === 0) problems.push('对象标识、材料引用、原文证据或澄清问题未通过来源与完整性校验；不得编造证据。')
  return `意图结构化结果校验失败：${problems.join('')}请重新执行意图识别；无需猜测填写业务答案。`
}

export function createDshWorkflowIntent(options: DshWorkflowInferenceOptions): DshWorkflowIntentPort {
  return {
    async infer(
      input: WorkflowInput,
      registeredAssetIds: readonly string[],
      callerSignal?: AbortSignal,
    ): Promise<DshIntentResult> {
      const runtime = options.ctx?.get?.('subagents') as SubagentRuntimeLike | undefined
      if (!hasSubagentStart(runtime)) {
        return gap('Host 的 subagents 服务不可验证（既没有 startActivation 也没有 start）：拒绝创建子会话')
      }
      const live = runtime as SubagentRuntimeLike
      const picked = eligibleProvider(live)
      if (picked === null) {
        return gap('没有可用的隔离子代理 provider：必须 inheritsParentContext=false 且声明 outputSchema')
      }
      if (options.workspace !== undefined && typeof options.attachWorkspace !== 'function') {
        return gap('需要把子会话挂到当前工作区，但没有可用的工作区挂载与回读能力：拒绝创建未归属的子会话')
      }

      const controller = new AbortController()
      const forward = (): void => { controller.abort() }
      if (callerSignal !== undefined) {
        if (callerSignal.aborted) controller.abort()
        else callerSignal.addEventListener('abort', forward, { once: true })
      }

      const stopTimeoutMs = resolveStopTimeoutMs(options.stopTimeoutMs)
      const detach = (): void => {
        if (callerSignal !== undefined) callerSignal.removeEventListener('abort', forward)
      }
      const disposeOrStopUnknown = async (run: SubagentRunLike, sessionId: string): Promise<DshIntentResult | null> => {
        if (await stopChild(run, stopTimeoutMs)) return null
        return { ok: false, errorKind: 'stop-unknown', sessionId, error: STOP_UNKNOWN_ERROR }
      }

      let run: SubagentRunLike
      try {
        const started = await startSubagentChild(live, options.ctx, picked.provider, picked.name, {
          label: 'valuation:intent',
          prompt: [{ type: 'text', text: intentPrompt(input, registeredAssetIds) }],
          parent: options.parentAgent,
          signal: controller.signal,
          outputSchema: INTENT_OUTPUT_SCHEMA,
        })
        if (!started.ok) {
          detach()
          return gap(`子会话没有可核对的启动凭据（${started.refusal}）：拒绝创建未验证的子会话`)
        }
        run = started.run
      } catch {
        detach()
        return { ok: false, errorKind: 'failed', sessionId: '', error: PUBLIC_INFRASTRUCTURE_ERROR }
      }

      const sessionId = String(run.id ?? '').trim()
      if (sessionId !== '' && options.onStarted !== undefined) {
        try {
          await options.onStarted({ sessionId, kind: 'intent' })
        } catch {
          const stopped = await disposeOrStopUnknown(run, sessionId)
          detach()
          return stopped ?? { ok: false, errorKind: 'failed', sessionId, error: PUBLIC_JOURNAL_ERROR }
        }
      }
      if (sessionId === '' || !run.local) {
        const stopped = await disposeOrStopUnknown(run, sessionId)
        detach()
        return stopped ?? gap('子会话没有可验证的本进程子代理：拒绝把不可核对的运行当作成果')
      }

      let workspaceAttachment: { ok: boolean; error?: string } | null | undefined
      try {
        workspaceAttachment = options.workspace === undefined
          ? null
          : await options.attachWorkspace?.({
            childId: sessionId, workspace: options.workspace, parentAgent: options.parentAgent,
          })
      } catch {
        const stopped = await disposeOrStopUnknown(run, sessionId)
        detach()
        return stopped ?? workspaceFailure(sessionId)
      }
      if (workspaceAttachment !== null && workspaceAttachment !== undefined && !workspaceAttachment.ok) {
        const stopped = await disposeOrStopUnknown(run, sessionId)
        detach()
        return stopped ?? workspaceFailure(sessionId)
      }

      let abortListener: (() => void) | undefined
      const aborted = new Promise<'aborted'>((resolve) => {
        abortListener = () => { resolve('aborted') }
        if (controller.signal.aborted) { abortListener(); return }
        controller.signal.addEventListener('abort', abortListener, { once: true })
      })

      try {
        const raced = await Promise.race([
          run.result.then((value) => ({ aborted: false as const, value })),
          aborted.then(() => ({ aborted: true as const, value: undefined })),
        ])
        if (raced.aborted || controller.signal.aborted) {
          const stopped = await disposeOrStopUnknown(run, sessionId)
          if (stopped !== null) return stopped
          return { ok: false, errorKind: 'cancelled', sessionId, error: CANCELLED_ERROR }
        }
        const value = raced.value
        if (value === undefined || value.stopReason !== 'completed') {
          const stopped = await disposeOrStopUnknown(run, sessionId)
          if (stopped !== null) return stopped
          return {
            ok: false,
            errorKind: 'failed',
            sessionId,
            error: '意图子会话异常结束，未完成意图识别；请打开节点会话核查模型服务或执行限制，恢复后重新执行。',
          }
        }
        const validated = validateIntent(value.structured, input)
        if (!validated.ok) {
          const stopped = await disposeOrStopUnknown(run, sessionId)
          if (stopped !== null) return stopped
          return { ok: false, errorKind: 'failed', sessionId, error: intentContractError(value.structured) }
        }
        const stopped = await disposeOrStopUnknown(run, sessionId)
        if (stopped !== null) return stopped
        return { ok: true, sessionId, intent: validated.intent }
      } catch {
        const stopped = await disposeOrStopUnknown(run, sessionId)
        if (stopped !== null) return stopped
        return { ok: false, errorKind: 'failed', sessionId, error: PUBLIC_INFRASTRUCTURE_ERROR }
      } finally {
        if (abortListener !== undefined) controller.signal.removeEventListener('abort', abortListener)
        detach()
      }
    },
  }
}
