/**
 * Pure binder for the market planning-selection candidate.
 *
 * The inference child returns an untrusted candidate. This function admits it only when
 * every place/business field is proved by a real material, explicit user input, a verified
 * knowledge body, or an explicit filename community clue. It performs no IO, never mutates
 * its input, and returns a fresh clone on success.
 */

export type WorkflowPlanningSelectionField =
  | 'city' | 'community' | 'nearbyCommunities' | 'valueScope' | 'providerOrder' | 'templatePath'

export interface WorkflowPlanningSelectionBasis {
  field: WorkflowPlanningSelectionField
  sourceId: string
  quote: string
}

export interface WorkflowPlanningSelectionQuestion {
  field: string
  prompt: string
}

export interface WorkflowPlanningSelection {
  city: string
  community: string
  nearbyCommunities: string[]
  valueScope: string
  providerOrder: string[]
  templatePath: string
  basis: WorkflowPlanningSelectionBasis[]
  questions: WorkflowPlanningSelectionQuestion[]
}

export interface WorkflowPlanningSelectionMaterial {
  materialId: string
  fileName: string
  digest?: string
  text?: string
}

export interface WorkflowPlanningSelectionKnowledge {
  sourceId: string
  body?: string
  path?: string
  digest?: string
}

/** Frozen host context: the actual admitted materials, verified knowledge and registered catalogs. */
export interface WorkflowPlanningSelectionContext {
  userInput: string
  materials: WorkflowPlanningSelectionMaterial[]
  knowledge: WorkflowPlanningSelectionKnowledge[]
  allowedProviderIds: readonly string[]
  allowedTemplatePaths: readonly string[]
}

export type WorkflowPlanningSelectionResult =
  | { ok: true; selection: WorkflowPlanningSelection }
  | { ok: false; error: string; questions?: WorkflowPlanningSelectionQuestion[]; selection?: undefined }

const FIELD_IDS: readonly WorkflowPlanningSelectionField[] = [
  'city', 'community', 'nearbyCommunities', 'valueScope', 'providerOrder', 'templatePath',
]
const CANDIDATE_KEYS = [
  'city', 'community', 'nearbyCommunities', 'valueScope', 'providerOrder', 'templatePath', 'basis', 'questions',
]
const BASIS_KEYS = ['field', 'sourceId', 'quote']
const QUESTION_KEYS = ['field', 'prompt']
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export const USER_SOURCE_ID = 'user-input'
export const FILE_NAME_SUFFIX = ':file-name'

const MAX_ITEMS = 64
const MAX_QUESTION_ITEMS = 32
const MAX_ID_LENGTH = 256
const MAX_NAME_LENGTH = 256
const MAX_QUOTE_LENGTH = 4000

type SourceKind = 'material' | 'user' | 'knowledge' | 'file-name'

interface ResolvedBasis extends WorkflowPlanningSelectionBasis {
  kind: SourceKind
  sourceText: string
}

type SourceResolution = { kind: SourceKind; text: string } | null

function failure(error: string, questions?: WorkflowPlanningSelectionQuestion[]): WorkflowPlanningSelectionResult {
  return questions === undefined ? { ok: false, error } : { ok: false, error, questions }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasForbiddenKeys(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => FORBIDDEN_KEYS.has(key))
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record)
  if (keys.length !== expected.length) return false
  return expected.every((key) => Object.prototype.hasOwnProperty.call(record, key))
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

type ParsedScalar = { ok: true; value: string } | { ok: false; error: string }

/** Explicit guard so the validated string is bound to a typed local (no `as any`). */
function parseScalar(value: unknown, name: string): ParsedScalar {
  if (typeof value !== 'string') return { ok: false, error: `${name} 必须是字符串` }
  if (value.length > MAX_NAME_LENGTH) return { ok: false, error: `${name} 超出长度上限` }
  return { ok: true, value }
}

/** Bounded, duplicate-free string array; returns null when malformed. */
function parseStringArray(value: unknown, max: number, allowEmpty: boolean): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  if (!allowEmpty && value.length === 0) return null
  const out: string[] = []
  for (const item of value) {
    if (!isBoundedString(item, MAX_NAME_LENGTH)) return null
    if (out.includes(item)) return null
    out.push(item)
  }
  return out
}

export function bindWorkflowPlanningSelection(
  candidate: unknown,
  context: WorkflowPlanningSelectionContext,
): WorkflowPlanningSelectionResult {
  if (!isPlainObject(candidate) || hasForbiddenKeys(candidate)) {
    return failure('规划选择候选必须是无原型污染键的 JSON 对象')
  }
  if (!hasExactKeys(candidate, CANDIDATE_KEYS)) {
    return failure('规划选择候选字段必须且只能是 city/community/nearbyCommunities/valueScope/providerOrder/templatePath/basis/questions')
  }

  const parsedCity = parseScalar(candidate.city, 'city')
  if (!parsedCity.ok) return failure(parsedCity.error)
  const parsedCommunity = parseScalar(candidate.community, 'community')
  if (!parsedCommunity.ok) return failure(parsedCommunity.error)
  const parsedValueScope = parseScalar(candidate.valueScope, 'valueScope')
  if (!parsedValueScope.ok) return failure(parsedValueScope.error)
  const parsedTemplatePath = parseScalar(candidate.templatePath, 'templatePath')
  if (!parsedTemplatePath.ok) return failure(parsedTemplatePath.error)
  const city = parsedCity.value
  const community = parsedCommunity.value
  const valueScope = parsedValueScope.value
  const templatePath = parsedTemplatePath.value

  const nearby = parseStringArray(candidate.nearbyCommunities, MAX_ITEMS, true)
  if (nearby === null) return failure('nearbyCommunities 必须是有界且不重复的字符串数组')
  const providers = parseStringArray(candidate.providerOrder, MAX_ITEMS, true)
  if (providers === null) return failure('providerOrder 必须是有界且不重复的字符串数组')

  const allowedProviders = new Set(context.allowedProviderIds ?? [])
  for (const providerId of providers) {
    if (!allowedProviders.has(providerId)) return failure(`providerOrder 含未登记渠道：${providerId}`)
  }
  const allowedTemplates = new Set(context.allowedTemplatePaths ?? [])
  if (templatePath.trim() !== '' && !allowedTemplates.has(templatePath)) {
    return failure('templatePath 不是已登记模板路径；不得猜测目录、追加后缀或使用任意 URL')
  }

  const materials = new Map<string, WorkflowPlanningSelectionMaterial>()
  for (const material of context.materials ?? []) {
    if (!isPlainObject(material)) continue
    if (typeof material.materialId === 'string' && typeof material.fileName === 'string') {
      materials.set(material.materialId, material as unknown as WorkflowPlanningSelectionMaterial)
    }
  }
  const knowledge = new Map<string, string>()
  for (const source of context.knowledge ?? []) {
    if (!isPlainObject(source)) continue
    if (typeof source.sourceId === 'string' && typeof source.body === 'string') {
      knowledge.set(source.sourceId, source.body)
    }
  }
  const resolveSource = (sourceId: string): SourceResolution => {
    if (sourceId === USER_SOURCE_ID) return { kind: 'user', text: String(context.userInput ?? '') }
    if (sourceId.endsWith(FILE_NAME_SUFFIX)) {
      const materialId = sourceId.slice(0, -FILE_NAME_SUFFIX.length)
      const material = materials.get(materialId)
      if (material === undefined) return null
      return { kind: 'file-name', text: String(material.fileName ?? '') }
    }
    const material = materials.get(sourceId)
    if (material !== undefined) return { kind: 'material', text: String(material.text ?? '') }
    const body = knowledge.get(sourceId)
    if (body !== undefined) return { kind: 'knowledge', text: body }
    return null
  }

  if (!Array.isArray(candidate.basis) || candidate.basis.length > MAX_ITEMS) {
    return failure('basis 必须是有界数组')
  }
  const basis: ResolvedBasis[] = []
  const seen = new Set<string>()
  for (const raw of candidate.basis) {
    if (!isPlainObject(raw) || hasForbiddenKeys(raw) || !hasExactKeys(raw, BASIS_KEYS)) {
      return failure('basis 每项字段必须且只能是 field/sourceId/quote')
    }
    const field = raw.field
    const sourceId = raw.sourceId
    const quote = raw.quote
    if (typeof field !== 'string' || !FIELD_IDS.includes(field as WorkflowPlanningSelectionField)) {
      return failure('basis.field 不是已知的规划字段')
    }
    if (!isBoundedString(sourceId, MAX_ID_LENGTH)) return failure('basis.sourceId 必须是非空有界字符串')
    if (!isBoundedString(quote, MAX_QUOTE_LENGTH)) return failure('basis.quote 必须是非空有界字符串')
    const triple = `${field}\u0000${sourceId}\u0000${quote}`
    if (seen.has(triple)) return failure('basis 不得重复 field/sourceId/quote')
    seen.add(triple)
    const source = resolveSource(sourceId)
    if (source === null) return failure(`basis 引用了未知来源：${sourceId}`)
    if (!source.text.includes(quote)) return failure(`basis.quote 未出现在来源 ${sourceId} 的原文中`)
    basis.push({ field: field as WorkflowPlanningSelectionField, sourceId, quote, kind: source.kind, sourceText: source.text })
  }

  if (!Array.isArray(candidate.questions) || candidate.questions.length > MAX_QUESTION_ITEMS) {
    return failure('questions 必须是有界数组')
  }
  const questions: WorkflowPlanningSelectionQuestion[] = []
  for (const raw of candidate.questions) {
    if (!isPlainObject(raw) || hasForbiddenKeys(raw) || !hasExactKeys(raw, QUESTION_KEYS)) {
      return failure('questions 每项字段必须且只能是 field/prompt')
    }
    if (!isBoundedString(raw.field, MAX_ID_LENGTH) || !isBoundedString(raw.prompt, MAX_QUOTE_LENGTH)) {
      return failure('questions.field 与 questions.prompt 必须是非空有界字符串')
    }
    questions.push({ field: raw.field, prompt: raw.prompt })
  }
  if (questions.length > 0) {
    return failure('规划选择仍有未决问题，不能凭猜测继续', questions)
  }

  const provenBy = (
    field: WorkflowPlanningSelectionField,
    kinds: readonly SourceKind[],
    mustContain?: string,
  ): ResolvedBasis | undefined => basis.find((item) => item.field === field
    && kinds.includes(item.kind)
    && (mustContain === undefined || item.quote.includes(mustContain)))

  if (city.trim() === '') {
    questions.push({ field: 'city', prompt: '缺少可核对的所在城市，请补充材料原文或用户明确输入' })
  } else if (provenBy('city', ['material', 'user'], city) === undefined) {
    return failure('city 必须由材料原文或用户明确输入作为依据，且依据需包含该城市名')
  }

  if (community.trim() === '') {
    questions.push({ field: 'community', prompt: '缺少可核对的社区名称，请补充材料原文、文件名线索或用户明确输入' })
  } else if (provenBy('community', ['material', 'user', 'file-name'], community) === undefined) {
    return failure('community 必须由材料原文、文件名线索或用户明确输入作为依据，且依据需包含该社区名')
  }

  for (const name of nearby) {
    if (provenBy('nearbyCommunities', ['material', 'user'], name) === undefined) {
      return failure(`nearbyCommunities 缺少包含该名称的明确地点依据：${name}`)
    }
  }

  if (valueScope.trim() === '') {
    questions.push({ field: 'valueScope', prompt: '缺少估价范围口径，请补充知识库正文或用户明确输入' })
  } else if (provenBy('valueScope', ['knowledge', 'user'], valueScope) === undefined) {
    return failure('valueScope 必须由知识库正文或用户明确输入作为依据，且依据需包含该口径，不能用文件名代替')
  }

  if (providers.length === 0) {
    questions.push({ field: 'providerOrder', prompt: '缺少检索渠道顺序，请补充知识库正文或用户明确输入' })
  } else if (provenBy('providerOrder', ['knowledge', 'user']) === undefined) {
    return failure('providerOrder 必须由知识库正文或用户明确输入作为依据，不能用文件名代替')
  }

  if (templatePath.trim() === '') {
    questions.push({ field: 'templatePath', prompt: '缺少已登记模板路径，请补充知识库正文或用户明确输入' })
  } else if (provenBy('templatePath', ['knowledge', 'user']) === undefined) {
    return failure('templatePath 必须由知识库正文或用户明确输入作为依据，不能用文件名代替')
  }

  if (questions.length > 0) {
    return failure('规划选择缺少可由来源证明的字段', questions)
  }

  return {
    ok: true,
    selection: {
      city,
      community,
      nearbyCommunities: [...nearby],
      valueScope,
      providerOrder: [...providers],
      templatePath,
      basis: basis.map((item) => ({ field: item.field, sourceId: item.sourceId, quote: item.quote })),
      questions: [],
    },
  }
}
