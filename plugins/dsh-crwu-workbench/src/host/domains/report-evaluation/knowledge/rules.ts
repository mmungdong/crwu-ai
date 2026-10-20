import { text } from '../../../../shared/utils/value.ts'

/**
 * 知识库文档里的**结构化规则段**（设计稿 §6.3，Schema：`schemas/rule-parameters.schema.json`）。
 *
 * 为什么必须有这一层：Agent 可以分析自然语言与证据，但**运行数值规则**（阈值、税率、面积区间、
 * 案例最少数量、取整）必须从已物化文档的结构化字段取。缺了它，脚本只能按记忆补数或按代码里的
 * 默认值跑 —— 两种都是"看起来在工作、其实没有依据"。
 *
 * 四条硬口径：
 *
 * 1. 只认受 Schema 限制的 **JSON 数据段**。可执行代码、shell、任意 URL、选择器 / 脚本字段
 *    一律拒绝（`unsafe-content`）—— 知识库正文不该能改写执行面。
 * 2. `snapshotDigest` 对不上就**整段不认**：说明这段参数不是从本轮快照来的。
 * 3. 多段 → `ambiguous`，不选第一段。
 * 4. 缺结构化参数 → 返回**缺口**（`missing`），绝不返回默认值。
 */

export type RuleValueKind = 'threshold' | 'rate' | 'ratio' | 'range' | 'count' | 'date-window' | 'rounding' | 'enum'
export type RuleComparison = 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'between' | 'in' | 'not-in' | 'none'
export type RuleStrength = 'must' | 'should' | 'should-not' | 'may'
export type RuleBasisGrade =
  | 'mandatory-standard'
  | 'industry-standard'
  | 'published-data'
  | 'market-practice'
  | 'project-fact'

export type RuleRounding = {
  mode: 'half-up' | 'half-even' | 'floor' | 'ceil' | 'truncate'
  digits: number
  stage: 'input' | 'intermediate' | 'result'
}

export type RuleAppliesTo = {
  propertyTypes: string[]
  methods: string[]
  valueScopes: string[]
  regions: string[]
  valuationPaths: string[]
}

export type RuleParameter = {
  ruleId: string
  label: string
  valueKind: RuleValueKind
  value: string | number | boolean | null
  valueMin: string | number | boolean | null
  valueMax: string | number | boolean | null
  unit: string
  comparison: RuleComparison
  rounding: RuleRounding | null
  appliesTo: RuleAppliesTo
  sourceRef: string
  basisGrade: RuleBasisGrade
  valueDate: string | null
  strength: RuleStrength
  requiresCapabilities: string[]
  templateId: string | null
  templateContractVersion: string | null
  missingHandling: 'block' | 'degrade' | 'not-applicable' | null
}

export interface RuleSnapshotInput {
  /** Host-owned route id. A fragment may omit it; if present it must match. */
  routeId: string
  /** Host-computed digest of the persisted bytes. A fragment may omit it; if present it must match. */
  snapshotDigest: string
  /** Persisted body bytes. */
  body: string
  /** Expected section id (optional; a mismatch means another rule set). */
  sectionId?: string
}

export type RuleParameterErrorKind =
  | '' | 'missing' | 'invalid' | 'ambiguous' | 'digest-mismatch' | 'unsafe-content' | 'infrastructure'

export type RuleParameterSet = {
  ok: boolean
  error: string
  errorKind: RuleParameterErrorKind
  routeId: string
  ruleSetVersion: string
  snapshotDigest: string
  sectionId: string
  effectiveFrom: string | null
  effectiveTo: string | null
  parameters: RuleParameter[]
  /** 缺结构化参数时的缺口说明（**不是**默认值）。 */
  gaps: string[]
}

const RULE_SET_VERSION = 'crwu.valuation.rule-parameters.v1'

/** 缺结构化参数时的固定说明（程序侧适配缺口，不是知识缺失，也不补默认值）。 */
export const NON_NEGOTIABLE_MISSING = '正文是普通业务文字，尚未适配成受控规则参数：这是程序侧适配缺口，不代表知识缺失'

const VALUE_KINDS: readonly string[] = ['threshold', 'rate', 'ratio', 'range', 'count', 'date-window', 'rounding', 'enum']
const COMPARISONS: readonly string[] = ['gte', 'gt', 'lte', 'lt', 'eq', 'between', 'in', 'not-in', 'none']
const STRENGTHS: readonly string[] = ['must', 'should', 'should-not', 'may']
const BASIS_GRADES: readonly string[] = [
  'mandatory-standard', 'industry-standard', 'published-data', 'market-practice', 'project-fact',
]
const ROUNDING_MODES: readonly string[] = ['half-up', 'half-even', 'floor', 'ceil', 'truncate']
const ROUNDING_STAGES: readonly string[] = ['input', 'intermediate', 'result']
const PROPERTY_TYPES: readonly string[] = ['residential', 'commercial', 'office', 'industrial', 'apartment', 'other']
const METHOD_VALUES: readonly string[] = ['market', 'income', 'cost']
const VALUE_SCOPES: readonly string[] = ['land-only', 'building-only', 'land-and-building']
const VALUATION_PATHS: readonly string[] = ['combined', 'separate', 'unresolved']
const MISSING_HANDLING: readonly string[] = ['block', 'degrade', 'not-applicable']

/** 明确禁止的**键名**（脚本 / 选择器 / 表达式 / 抓取指令面）。 */
const UNSAFE_KEYS: readonly string[] = [
  'selector', 'selectors', 'script', 'scripts', 'code', 'eval', 'expression', 'expressions',
  'command', 'commands', 'exec', 'shell', 'url', 'urls', 'href', 'regex', 'xpath', 'sql',
  'subprocess', 'child_process', 'function', 'import', 'require', 'js', 'javascript', 'python',
]

/** 明确禁止的**取值形状**（可执行代码 / shell / 任意 URL）。 */
const UNSAFE_VALUES: readonly RegExp[] = [
  /https?:\/\//i,
  /<\s*script\b/i,
  /;\s*(rm|curl|wget|sh|bash|powershell|python|node)\b/i,
  /\b(eval|exec|subprocess|child_process|os\.system|require\s*\(|import\s+[A-Za-z_$]|Function\s*\()/,
  /\bfunction\s*\(|=>/,
  /\b(python3?|node|sh|bash)\s+-c\b/,
]

const TOP_KEYS: readonly string[] = [
  'ruleSetVersion', 'routeId', 'snapshotDigest', 'sectionId', 'effectiveFrom', 'effectiveTo', 'parameters', 'notes',
]

const PARAMETER_KEYS: readonly string[] = [
  'ruleId', 'label', 'valueKind', 'value', 'valueMin', 'valueMax', 'unit', 'comparison', 'rounding',
  'appliesTo', 'sourceRef', 'basisGrade', 'valueDate', 'strength', 'requiresCapabilities',
  'templateId', 'templateContractVersion', 'missingHandling',
]

interface Candidate {
  raw: string
  value: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** 递归扫一遍：禁止的键名与取值形状。 */
function unsafeReason(value: unknown, path: string): string {
  if (typeof value === 'string') {
    for (const pattern of UNSAFE_VALUES) {
      if (pattern.test(value)) return `${path} 的值命中禁止形状（${pattern.source}）`
    }
    return ''
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return ''
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const reason = unsafeReason(value[index], `${path}[${String(index)}]`)
      if (reason !== '') return reason
    }
    return ''
  }
  const doc = record(value)
  if (doc === null) return `${path} 不是 JSON 数据`
  for (const [key, nested] of Object.entries(doc)) {
    if (UNSAFE_KEYS.includes(key.toLowerCase())) return `${path}.${key} 是不允许的字段（脚本 / 选择器 / URL 面）`
    const reason = unsafeReason(nested, `${path}.${key}`)
    if (reason !== '') return reason
  }
  return ''
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

function enumValue(value: unknown, allowed: readonly string[]): string | null {
  const raw = text(value)
  return allowed.includes(raw) ? raw : null
}

function stringArray(value: unknown, allowed?: readonly string[]): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    const raw = text(item)
    if (raw === '') return null
    if (allowed !== undefined && !allowed.includes(raw)) return null
    out.push(raw)
  }
  return out
}

function scalarOrNull(value: unknown): string | number | boolean | null | undefined {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return undefined
}

/** 一条参数按 Schema 收窄；不合法时返回错误文本。 */
function parseParameter(raw: unknown, index: number): { ok: true; value: RuleParameter } | { ok: false; error: string } {
  const doc = record(raw)
  if (doc === null) return { ok: false, error: `parameters[${String(index)}] 必须是对象` }
  const extra = unknownKeys(doc, PARAMETER_KEYS)
  if (extra.length > 0) return { ok: false, error: `parameters[${String(index)}] 有不允许的字段：${extra.join('、')}` }
  const ruleId = text(doc.ruleId)
  const label = text(doc.label)
  if (ruleId === '' || label === '') return { ok: false, error: `parameters[${String(index)}] 缺少 ruleId / label` }
  const valueKind = enumValue(doc.valueKind, VALUE_KINDS) as RuleValueKind | null
  if (valueKind === null) return { ok: false, error: `parameters[${String(index)}].valueKind 不在允许集合里` }
  const sourceRef = text(doc.sourceRef)
  if (sourceRef === '') return { ok: false, error: `parameters[${String(index)}].sourceRef 不能为空（参数必须有权威出处）` }
  const basisGrade = enumValue(doc.basisGrade, BASIS_GRADES) as RuleBasisGrade | null
  if (basisGrade === null) return { ok: false, error: `parameters[${String(index)}].basisGrade 不在允许集合里` }
  const strength = enumValue(doc.strength, STRENGTHS) as RuleStrength | null
  if (strength === null) return { ok: false, error: `parameters[${String(index)}].strength 不在允许集合里` }

  const appliesRaw = record(doc.appliesTo)
  if (appliesRaw === null) return { ok: false, error: `parameters[${String(index)}].appliesTo 必须是对象` }
  const propertyTypes = stringArray(appliesRaw.propertyTypes, PROPERTY_TYPES)
  const methods = stringArray(appliesRaw.methods, METHOD_VALUES)
  if (propertyTypes === null || methods === null) {
    return { ok: false, error: `parameters[${String(index)}].appliesTo 的 propertyTypes / methods 不合法` }
  }
  const valueScopes = stringArray(appliesRaw.valueScopes, VALUE_SCOPES)
  const valuationPaths = stringArray(appliesRaw.valuationPaths, VALUATION_PATHS)
  const regions = stringArray(appliesRaw.regions)
  if (valueScopes === null || valuationPaths === null || regions === null) {
    return { ok: false, error: `parameters[${String(index)}].appliesTo 的取值不合法` }
  }
  const appliesExtra = unknownKeys(appliesRaw, ['propertyTypes', 'methods', 'valueScopes', 'regions', 'valuationPaths'])
  if (appliesExtra.length > 0) {
    return { ok: false, error: `parameters[${String(index)}].appliesTo 有不允许的字段：${appliesExtra.join('、')}` }
  }

  let rounding: RuleRounding | null = null
  if (doc.rounding !== undefined && doc.rounding !== null) {
    const roundingRaw = record(doc.rounding)
    if (roundingRaw === null) return { ok: false, error: `parameters[${String(index)}].rounding 必须是对象` }
    const roundingExtra = unknownKeys(roundingRaw, ['mode', 'digits', 'stage'])
    if (roundingExtra.length > 0) return { ok: false, error: `parameters[${String(index)}].rounding 有不允许的字段：${roundingExtra.join('、')}` }
    const mode = enumValue(roundingRaw.mode, ROUNDING_MODES)
    const digits = roundingRaw.digits
    if (mode === null || !Number.isInteger(digits) || Number(digits) < 0 || Number(digits) > 8) {
      return { ok: false, error: `parameters[${String(index)}].rounding 的 mode / digits 不合法` }
    }
    const stage = roundingRaw.stage === undefined ? 'result' : enumValue(roundingRaw.stage, ROUNDING_STAGES)
    if (stage === null) return { ok: false, error: `parameters[${String(index)}].rounding.stage 不合法` }
    rounding = { mode: mode as RuleRounding['mode'], digits: Number(digits), stage: stage as RuleRounding['stage'] }
  }

  const comparison = doc.comparison === undefined ? 'none' : enumValue(doc.comparison, COMPARISONS)
  if (comparison === null) return { ok: false, error: `parameters[${String(index)}].comparison 不在允许集合里` }
  const missingHandling = doc.missingHandling === undefined ? null : enumValue(doc.missingHandling, MISSING_HANDLING)
  if (doc.missingHandling !== undefined && missingHandling === null) {
    return { ok: false, error: `parameters[${String(index)}].missingHandling 不在允许集合里` }
  }
  const value = scalarOrNull(doc.value)
  const valueMin = scalarOrNull(doc.valueMin)
  const valueMax = scalarOrNull(doc.valueMax)
  if (value === undefined || valueMin === undefined || valueMax === undefined) {
    return { ok: false, error: `parameters[${String(index)}] 的 value / valueMin / valueMax 只能是字符串 / 数字 / 布尔 / null` }
  }
  const requiresCapabilities = stringArray(doc.requiresCapabilities)
  if (requiresCapabilities === null) return { ok: false, error: `parameters[${String(index)}].requiresCapabilities 必须是字符串数组` }
  const templateId = doc.templateId === undefined ? null : (doc.templateId === null ? null : text(doc.templateId))
  const contractVersion = doc.templateContractVersion === undefined
    ? null
    : (doc.templateContractVersion === null ? null : text(doc.templateContractVersion))

  return {
    ok: true,
    value: {
      ruleId,
      label,
      valueKind,
      value: value ?? null,
      valueMin: valueMin ?? null,
      valueMax: valueMax ?? null,
      unit: text(doc.unit),
      comparison: comparison as RuleComparison,
      rounding,
      appliesTo: { propertyTypes, methods, valueScopes, regions, valuationPaths },
      sourceRef,
      basisGrade,
      valueDate: doc.valueDate === undefined || doc.valueDate === null ? null : text(doc.valueDate),
      strength,
      requiresCapabilities,
      templateId: templateId === '' ? null : templateId,
      templateContractVersion: contractVersion === '' ? null : contractVersion,
      missingHandling: missingHandling as RuleParameter['missingHandling'],
    },
  }
}

/** 抽出所有提到本规则集版本的 fenced JSON 段。 */
function candidatesOf(body: string): string[] {
  const raw: string[] = []
  const fence = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g
  let match = fence.exec(body)
  while (match !== null) {
    const content = match[2] ?? ''
    if (content.includes(RULE_SET_VERSION)) raw.push(content)
    match = fence.exec(body)
  }
  return raw
}

function gap(error: string, input: RuleSnapshotInput): RuleParameterSet {
  return {
    ok: false,
    error,
    errorKind: 'missing',
    routeId: text(input.routeId),
    ruleSetVersion: '',
    snapshotDigest: text(input.snapshotDigest),
    sectionId: '',
    effectiveFrom: null,
    effectiveTo: null,
    parameters: [],
    gaps: [`暂无可用的受控规则参数（${RULE_SET_VERSION}）：程序侧适配缺口：${error}`],
  }
}

/**
 * 从一个已物化快照里解析结构化规则参数。
 *
 * 只认数据段；对不上 digest、多段、畸形 JSON、含可执行内容、缺必填字段都如实失败。
 * 失败时 `parameters` 恒为空数组 —— **绝不**回退到默认值。
 */
export function parseRuleParameters(input: RuleSnapshotInput): RuleParameterSet {
  const routeId = text(input.routeId)
  const digest = text(input.snapshotDigest)
  const fail = (errorKind: RuleParameterErrorKind, error: string, extra: Partial<RuleParameterSet> = {}): RuleParameterSet => ({
    ok: false,
    error,
    errorKind,
    routeId,
    ruleSetVersion: '',
    snapshotDigest: digest,
    sectionId: '',
    effectiveFrom: null,
    effectiveTo: null,
    parameters: [],
    gaps: [],
    ...extra,
  })

  const raw = candidatesOf(text(input.body))
  if (raw.length === 0) {
    return gap(NON_NEGOTIABLE_MISSING, input)
  }

  const candidates: Candidate[] = []
  for (const content of raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      return fail('invalid', `规则段不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    const doc = record(parsed)
    if (doc === null) return fail('invalid', '规则段必须是 JSON 对象')
    candidates.push({ raw: content, value: doc })
  }
  if (candidates.length > 1) {
    return fail('ambiguous', `同一份正文里有 ${candidates.length} 段结构化规则（不选第一段）`)
  }

  const candidate = candidates[0] as Candidate
  const doc = candidate.value
  const unsafe = unsafeReason(doc, 'rule-parameters')
  if (unsafe !== '') return fail('unsafe-content', unsafe)

  const extra = unknownKeys(doc, TOP_KEYS)
  if (extra.length > 0) return fail('invalid', `规则段有不允许的字段：${extra.join('、')}`)
  if (text(doc.ruleSetVersion) !== RULE_SET_VERSION) {
    return fail('invalid', `规则段版本不是 ${RULE_SET_VERSION}`)
  }
  const declaredRoute = text(doc.routeId)
  if (routeId === '') {
    return fail('missing', 'Host 没有提供 routeId：不能把规则段绑定到未知来源')
  }
  if (declaredRoute !== '' && declaredRoute !== routeId) {
    return fail('invalid', `规则段声明的 routeId（${declaredRoute}）与本条快照（${routeId}）不一致`)
  }
  if (digest === '') {
    return fail('missing', 'Host 没有提供 snapshotDigest：不能把规则段绑定到未知版本')
  }
  const declaredDigest = text(doc.snapshotDigest)
  if (declaredDigest !== '' && declaredDigest !== digest) {
    return fail('digest-mismatch',
      `规则段的 snapshotDigest（${declaredDigest}）与本轮快照摘要（${digest}）不一致：整段不认`)
  }
  const sectionId = text(doc.sectionId)
  if (text(input.sectionId) !== '' && sectionId !== text(input.sectionId)) {
    return fail('invalid', `规则段声明的是另一节（${sectionId || '未声明'}），期望 ${text(input.sectionId)}`)
  }
  const rawParameters = doc.parameters
  if (!Array.isArray(rawParameters) || rawParameters.length === 0) {
    return fail('invalid', '规则段没有 parameters（结构化参数为空）')
  }
  const parameters: RuleParameter[] = []
  for (let index = 0; index < rawParameters.length; index += 1) {
    const parsed = parseParameter(rawParameters[index], index)
    if (!parsed.ok) return fail('invalid', parsed.error)
    parameters.push(parsed.value)
  }

  return {
    ok: true,
    error: '',
    errorKind: '',
    routeId,
    ruleSetVersion: RULE_SET_VERSION,
    snapshotDigest: digest,
    sectionId,
    effectiveFrom: doc.effectiveFrom === undefined || doc.effectiveFrom === null ? null : text(doc.effectiveFrom),
    effectiveTo: doc.effectiveTo === undefined || doc.effectiveTo === null ? null : text(doc.effectiveTo),
    parameters,
    gaps: [],
  }
}
