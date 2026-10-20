/**
 * Per-composition registry of compiled professional valuation graphs.
 *
 * Registration is explicit and instance-scoped: there is no module-level global
 * registry, no asset switch and no implicit fallback graph.
 */
import { CompiledStateGraph, END, START } from '@langchain/langgraph'
import { VALUATION_WORKFLOW_STAGES } from '../../../shared/contracts/valuation-workflow.ts'
import {
  WorkflowState,
  type WorkflowGraphState,
  type WorkflowGraphUpdate,
} from '../state.ts'

export type ValuationAssetGraph = CompiledStateGraph<
  WorkflowGraphState,
  WorkflowGraphUpdate,
  string
>

export interface ValuationGraphRegistry {
  register(id: string, graph: ValuationAssetGraph): void
  ids(): string[]
  get(id: string): ValuationAssetGraph | undefined
}

const SAFE_ASSET_ID = /^[A-Za-z][A-Za-z0-9_-]*$/

const RESERVED_IDS = new Set<string>([
  START,
  END,
  'intent-router',
  'valuation',
  '__proto__',
  'prototype',
  'constructor',
  ...Object.keys(WorkflowState.spec),
  ...VALUATION_WORKFLOW_STAGES,
])

function checkedId(value: string): string {
  if (typeof value !== 'string') throw new Error('资产图标识必须是字符串')
  if (!SAFE_ASSET_ID.test(value)) throw new Error('资产图标识只能使用字母、数字、下划线或连字符，且必须以字母开头')
  if (RESERVED_IDS.has(value)) throw new Error(`资产图标识是保留名称：${value}`)
  return value
}

function isCompiledGraph(value: unknown): value is ValuationAssetGraph {
  if (value === null || typeof value !== 'object' || !(value instanceof CompiledStateGraph)) return false
  const candidate = value as { lg_is_pregel?: unknown; invoke?: unknown; getGraphAsync?: unknown }
  return candidate.lg_is_pregel === true
    && typeof candidate.invoke === 'function'
    && typeof candidate.getGraphAsync === 'function'
}

export function createValuationGraphRegistry(): ValuationGraphRegistry {
  const graphs = new Map<string, ValuationAssetGraph>()
  return {
    register(id: string, graph: ValuationAssetGraph): void {
      const checked = checkedId(id)
      if (graphs.has(checked)) throw new Error(`资产图已经注册：${checked}`)
      if (!isCompiledGraph(graph)) throw new Error('注册项必须是已编译的 LangGraph 图')
      graphs.set(checked, graph)
    },
    ids(): string[] {
      return [...graphs.keys()]
    },
    get(id: string): ValuationAssetGraph | undefined {
      return graphs.get(id)
    },
  }
}
