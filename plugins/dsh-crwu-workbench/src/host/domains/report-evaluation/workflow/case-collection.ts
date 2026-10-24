import type { TemplateCellRef, TemplateProfile, TemplateRequirements } from '../../../../shared/contracts/valuation-template.ts'
import { TEMPLATE_FIELD_APPLICABILITY, TEMPLATE_FIELD_CATEGORIES } from '../../../../shared/contracts/valuation-template.ts'
export type { TemplateCellRef, TemplateProfile, TemplateRequirement, TemplateRequirements } from '../../../../shared/contracts/valuation-template.ts'
export { TEMPLATE_FIELD_APPLICABILITY, TEMPLATE_FIELD_CATEGORIES } from '../../../../shared/contracts/valuation-template.ts'

const record = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => record(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)

function cellPosition(value: unknown): { row: number; column: number } | null {
  if (typeof value !== 'string') return null
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value)
  if (match === null) return null
  const column = [...match[1]!].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0)
  const row = Number(match[2])
  return column <= 16_384 && row <= 1_048_576 ? { row, column } : null
}

export function templateCellExists(ref: TemplateCellRef, profile: TemplateProfile): boolean {
  const position = cellPosition(ref.cell)
  const sheet = profile.sheets.find((item) => item.name === ref.sheet)
  // Empty target cells are omitted by the inspector but still exist inside sheet bounds.
  return position !== null && sheet !== undefined && position.row <= sheet.rows && position.column <= sheet.columns
}

export function isTemplateProfile(value: unknown): value is TemplateProfile {
  if (!exact(value, ['templateId', 'digest', 'relativePath', 'sheets', 'cells', 'definedNames', 'coverage'])
    || !nonempty(value.templateId) || !digest(value.digest) || !nonempty(value.relativePath)
    || !Array.isArray(value.sheets) || value.sheets.length === 0 || value.sheets.length > 64
    || !Array.isArray(value.cells) || value.cells.length > 100_000
    || !Array.isArray(value.definedNames)
    || !exact(value.coverage, ['complete', 'issues']) || typeof value.coverage.complete !== 'boolean'
    || !Array.isArray(value.coverage.issues) || !value.coverage.issues.every(nonempty)) return false
  const names = new Set<string>()
  for (const sheet of value.sheets) {
    if (!exact(sheet, ['name', 'rows', 'columns', 'mergedRanges']) || !nonempty(sheet.name) || names.has(sheet.name)
      || !Number.isSafeInteger(sheet.rows) || Number(sheet.rows) < 1 || Number(sheet.rows) > 1_048_576
      || !Number.isSafeInteger(sheet.columns) || Number(sheet.columns) < 1 || Number(sheet.columns) > 16_384
      || !Array.isArray(sheet.mergedRanges) || !sheet.mergedRanges.every(nonempty)) return false
    names.add(sheet.name)
  }
  const cells = new Set<string>()
  for (const cell of value.cells) {
    if (!exact(cell, ['sheet', 'cell', 'value', 'formula']) || !nonempty(cell.sheet) || !nonempty(cell.cell)
      || typeof cell.formula !== 'string'
      || !(cell.value === null || typeof cell.value === 'string' || typeof cell.value === 'boolean'
        || (typeof cell.value === 'number' && Number.isFinite(cell.value)))
      || !templateCellExists(cell as unknown as TemplateCellRef, value as unknown as TemplateProfile)) return false
    const key = JSON.stringify([cell.sheet, cell.cell])
    if (cells.has(key)) return false
    cells.add(key)
  }
  return value.definedNames.every((name) => exact(name, ['name', 'ref']) && nonempty(name.name) && typeof name.ref === 'string')
}

function isCellRef(value: unknown): value is TemplateCellRef {
  return exact(value, ['sheet', 'cell']) && nonempty(value.sheet) && cellPosition(value.cell) !== null
}

export function isTemplateRequirements(value: unknown): value is TemplateRequirements {
  if (!exact(value, ['templateId', 'templateDigest', 'version', 'fields', 'questions'])
    || !nonempty(value.templateId) || !digest(value.templateDigest)
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || !Array.isArray(value.fields) || value.fields.length === 0 || value.fields.length > 1024
    || !Array.isArray(value.questions) || value.questions.length > 64) return false
  const fields = new Set<string>()
  for (const field of value.fields) {
    if (!record(field) || !exact(field, ['fieldId', 'label', 'labelRef', 'targetRefs', 'category', 'applicability', 'criticalFor', 'basis', ...(Object.hasOwn(field, 'owner') ? ['owner'] : []), ...(Object.hasOwn(field, 'unit') ? ['unit'] : [])])
      || (field.owner !== undefined && !['subject', 'case', 'shared'].includes(String(field.owner))) || (field.unit !== undefined && typeof field.unit !== 'string')
      || !nonempty(field.fieldId) || fields.has(field.fieldId) || !nonempty(field.label) || !isCellRef(field.labelRef)
      || !Array.isArray(field.targetRefs) || field.targetRefs.length === 0 || !field.targetRefs.every(isCellRef)
      || !TEMPLATE_FIELD_CATEGORIES.some((item) => item === field.category)
      || !TEMPLATE_FIELD_APPLICABILITY.some((item) => item === field.applicability)
      || !Array.isArray(field.criticalFor) || !field.criticalFor.every((item) => item === 'eligibility' || item === 'calculation')
      || new Set(field.criticalFor).size !== field.criticalFor.length
      || !Array.isArray(field.basis) || field.basis.length === 0
      || !field.basis.every((basis) => exact(basis, ['sourceId', 'quote']) && nonempty(basis.sourceId) && nonempty(basis.quote))) return false
    fields.add(field.fieldId)
  }
  return value.questions.every((question) => exact(question, ['field', 'prompt']) && nonempty(question.field) && nonempty(question.prompt))
}

/** Bind proposals to inspected cells and exact admitted knowledge, never model defaults. */
export function bindTemplateRequirements(
  candidate: unknown,
  profile: TemplateProfile,
  knowledge: ReadonlyArray<{ sourceId: string; body?: string }>,
  options: { allowUnresolved?: boolean } = {},
): { ok: boolean; requirements?: TemplateRequirements; gaps: string[]; limitations?: string[] } {
  const gaps: string[] = []
  const limitations: string[] = []
  if (!isTemplateRequirements(candidate)) return { ok: false, gaps: ['模板需求结构无效：请重新分析字段、分类与依据，禁止默认系数或额外字段。'] }
  if (!isTemplateProfile(profile)) return { ok: false, gaps: ['模板检查结果无效：请重新检查所选模板。'] }
  if (candidate.templateId !== profile.templateId || candidate.templateDigest !== profile.digest) gaps.push('模板身份或摘要已改变：请重新解读模板。')
  if (!profile.coverage.complete || profile.coverage.issues.length > 0) limitations.push('模板检查覆盖不完整：仅填充已核对位置，计算前须补全检查。')
  const targets = new Set<string>()
  for (const field of candidate.fields) {
    const label = profile.cells.find((cell) => cell.sheet === field.labelRef.sheet && cell.cell === field.labelRef.cell)
    if (label === undefined || label.value !== field.label || !templateCellExists(field.labelRef, profile)) gaps.push(`字段 ${field.fieldId} 的标签与模板原文不一致。`)
    for (const ref of field.targetRefs) {
      const key = JSON.stringify([ref.sheet, ref.cell])
      if (!templateCellExists(ref, profile) || targets.has(key)) gaps.push(`字段 ${field.fieldId} 的目标位置不存在或重复。`)
      targets.add(key)
    }
    if (!field.basis.every((basis) => knowledge.some((source) => source.sourceId === basis.sourceId
      && typeof source.body === 'string' && source.body.includes(basis.quote)))) gaps.push(`字段 ${field.fieldId} 的方法依据无法在已验真知识中核对。`)
    if (field.applicability === 'pending') limitations.push(`字段 ${field.label} 的适用性尚未确认。`)
  }
  limitations.push(...candidate.questions.map((question) => question.prompt))
  if (!options.allowUnresolved) gaps.push(...limitations)
  return gaps.length > 0 ? { ok: false, gaps } : { ok: true, requirements: structuredClone(candidate), gaps: [], limitations }
}
