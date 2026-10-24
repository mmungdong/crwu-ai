import type { AssetType, MethodRequest } from '../../../../shared/contracts/valuation-project.ts'

interface EntryChoices { assetType?: unknown; methodRequest?: unknown }
const REAL_ESTATE: AssetType = 'real-estate'
const MARKET: MethodRequest = 'market'

export function usesTemplateMarketFlow(input: EntryChoices | null | undefined): boolean {
  return input?.assetType === REAL_ESTATE && input.methodRequest === MARKET
}

export function workflowGraphVersionFor(input: {
  dto: { templateMarket?: unknown } | null
  frozen: EntryChoices | null
  graphVersion?: '1' | '2'
}): '1' | '2' {
  if (input.dto !== null) return input.dto.templateMarket ? '2' : '1'
  if (input.graphVersion !== undefined) return input.graphVersion
  return usesTemplateMarketFlow(input.frozen) ? '2' : '1'
}
