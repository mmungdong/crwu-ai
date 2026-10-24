import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { TemplateMarketNodeId } from '../../../shared/contracts/valuation-template-market.ts'
import { templateMarketOutputSchema, type MarketJsonSchema } from '../../domains/report-evaluation/workflow/template-market-contracts.ts'

function nativeSchema(schema: MarketJsonSchema): JsonSchemaNode {
  if (schema.anyOf) return { oneOf: schema.anyOf.map(nativeSchema) }
  return {
    ...(schema.type ? { type: schema.type } : {}),
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, nativeSchema(value)])) } : {}),
    ...(schema.required ? { required: schema.required } : {}),
    ...(schema.items ? { items: nativeSchema(schema.items) } : {}),
    ...(schema.additionalProperties !== undefined ? { additionalProperties: schema.additionalProperties !== false } : {}),
  }
}

// Native output enforcement is followed by the stricter domain validator.
export const templateMarketInferenceSchema = (nodeId: TemplateMarketNodeId): JsonSchemaNode => nativeSchema(templateMarketOutputSchema(nodeId))
export const TEMPLATE_MARKET_INSTRUCTION = '按 facts.nodeInput 中的当前模板、事实、知识、有效回答与能力制定当前节点成果。'
  + '只消费当前输入，不调用检索、详情、截图或计算工具。不得编造路径、摘要、来源、数值、专业判断或默认系数。'
  + 'collection-plan 从 upstream.templates.profiles 中原样选择模板，按真实单元格生成 requirements，basis 必须逐字引用已验真知识。'
  + 'requirements.fields 每项必须明确 owner=subject/case/shared、unit 目标单位。对象栏与案例栏不能混填，不能确定时标 pending。'
  + '地点只从用户正文或资料正文取证，文件名不能证明地址。不能确定模板或地点时返回 needs-user，并优先提供选择题。'
  + '新问题必须 answerProtocol=2，明确 control、required、version、applicable、reason、allowDefer；普通选项不含 __other__。'
  + '未取得机构检索预算时，明确提出技术预算建议（页数不超过20、案例不超过200、耗时不超过120000毫秒），由 confirm-plan 统一确认。'
  + '保留挂牌与成交性质；原模板坏公式仅作为计算限制，仍可整理底稿；不以算术平均替代市场法。'
