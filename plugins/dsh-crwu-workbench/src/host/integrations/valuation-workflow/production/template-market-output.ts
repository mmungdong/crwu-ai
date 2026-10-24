import type { TemplateMarketNodeId, TemplateMarketNodeData, TemplateMarketNodeOutput } from '../../../../shared/contracts/valuation-template-market.ts'

export const marketCompleted = <N extends TemplateMarketNodeId>(data: TemplateMarketNodeData[N], summary: string): TemplateMarketNodeOutput<N> =>
  ({ outcome: 'completed', summary, data, questions: [], limitations: [], failure: null })
export function marketFailure<N extends TemplateMarketNodeId>(reason: string): TemplateMarketNodeOutput<N> {
  return { outcome: 'failed', summary: reason, data: null, questions: [], limitations: [],
    failure: { kind: 'system', reason, requirements: [reason], actions: ['保留已取得资料，修复当前能力后重试此节点'] } }
}
