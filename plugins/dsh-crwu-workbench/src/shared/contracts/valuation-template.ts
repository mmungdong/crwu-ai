export interface TemplateCellRef { sheet: string; cell: string }

export interface TemplateProfile {
  templateId: string
  digest: string
  relativePath: string
  sheets: Array<{ name: string; rows: number; columns: number; mergedRanges: string[] }>
  cells: Array<TemplateCellRef & { value: string | number | boolean | null; formula: string }>
  definedNames: Array<{ name: string; ref: string }>
  coverage: { complete: boolean; issues: string[] }
}

export const TEMPLATE_FIELD_CATEGORIES = ['source-fact', 'shared-fact', 'judgment', 'derived', 'calculation'] as const
export const TEMPLATE_FIELD_APPLICABILITY = ['applicable', 'not-applicable', 'pending'] as const

export interface TemplateRequirement {
  owner?: 'subject' | 'case' | 'shared'
  unit?: string
  fieldId: string
  label: string
  labelRef: TemplateCellRef
  targetRefs: TemplateCellRef[]
  category: typeof TEMPLATE_FIELD_CATEGORIES[number]
  applicability: typeof TEMPLATE_FIELD_APPLICABILITY[number]
  criticalFor: Array<'eligibility' | 'calculation'>
  basis: Array<{ sourceId: string; quote: string }>
}

export interface TemplateRequirements {
  templateId: string
  templateDigest: string
  version: number
  fields: TemplateRequirement[]
  questions: Array<{ field: string; prompt: string }>
}
