import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { TEMPLATE_FIELD_APPLICABILITY, TEMPLATE_FIELD_CATEGORIES } from '../../domains/report-evaluation/workflow/case-collection.ts'

const CELL_REF_SCHEMA: JsonSchemaNode = {
  type: 'object', additionalProperties: false,
  properties: { sheet: { type: 'string' }, cell: { type: 'string' } }, required: ['sheet', 'cell'],
}

export const TEMPLATE_ANALYSIS_SCHEMA: JsonSchemaNode = {
  type: 'object', additionalProperties: false,
  properties: {
    templateId: { type: 'string' }, templateDigest: { type: 'string' }, version: { type: 'integer' },
    fields: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        fieldId: { type: 'string' }, label: { type: 'string' }, labelRef: CELL_REF_SCHEMA,
        targetRefs: { type: 'array', items: CELL_REF_SCHEMA },
        category: { type: 'string', enum: [...TEMPLATE_FIELD_CATEGORIES] },
        applicability: { type: 'string', enum: [...TEMPLATE_FIELD_APPLICABILITY] },
        criticalFor: { type: 'array', items: { type: 'string', enum: ['eligibility', 'calculation'] } },
        basis: { type: 'array', items: { type: 'object', additionalProperties: false,
          properties: { sourceId: { type: 'string' }, quote: { type: 'string' } }, required: ['sourceId', 'quote'] } },
      },
      required: ['fieldId', 'label', 'labelRef', 'targetRefs', 'category', 'applicability', 'criticalFor', 'basis'],
    } },
    questions: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { field: { type: 'string' }, prompt: { type: 'string' } }, required: ['field', 'prompt'] } },
  },
  required: ['templateId', 'templateDigest', 'version', 'fields', 'questions'],
}

export const TEMPLATE_ANALYSIS_INSTRUCTION = '只分析 facts.templateProfile 中已检查的模板结构与采用知识。'
  + 'templateId/templateDigest 必须原样绑定该模板；labelRef 指向标签原文，targetRefs 指向表内真实目标单元格，保留实际案例列数。'
  + '逐字段区分来源事实、共享事实、专业判断、衍生值及计算值；basis 必须逐字引用采用知识及其 sourceId。'
  + '不能确定的适用性标为 pending 并列入 questions；不补默认系数，不计算估值，不调用工具。'
