/**
 * Valuation experience model (prototype baseline, 2026-10-23).
 *
 * Pure state and selectors for the redesigned flow:
 * overview → intake (object / materials+info / review) → six-step workbench.
 *
 * Host data is projected into the same `ExperienceState`; demo fixtures are only
 * admitted through an explicit employee action and stay marked as demo.
 */
import type { ValuationPageState } from '../model/valuation-state.ts'

export type IntakeStage = 'object' | 'info' | 'review'
export type ExperienceView = 'intake' | 'workspace'
export type WorkflowStep = 'docs' | 'check' | 'reasoning' | 'confirm' | 'cases' | 'caseCheck'
export type FieldTag = '材料摘取' | '用户填写' | '用户更正' | '待核对'
export type StepState = 'todo' | 'done' | 'needs'
export type PlanStatus = 'draft' | 'pending' | 'confirmed' | 'stale'
export type CaseStatus = 'eligible' | 'nearby' | 'pending' | 'rejected'

export const DOC_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'doc', 'docx'] as const
export const DEMO_PROJECT_ID = 'demo-project'
export const WORKFLOW_STEPS: ReadonlyArray<{ key: WorkflowStep; label: string; num: string }> = [
  { key: 'docs', label: '资料与模板', num: '1' },
  { key: 'check', label: '信息核对', num: '2' },
  { key: 'reasoning', label: '方案推理', num: '3' },
  { key: 'confirm', label: '方案确认', num: '4' },
  { key: 'cases', label: '案例获取', num: '5' },
  { key: 'caseCheck', label: '案例核对', num: '6' },
]
export const CHECK_KEYS = ['deal', 'area', 'built', 'rights', 'time'] as const
export const CHECK_LABELS: Record<string, string> = {
  deal: '挂牌信息已核实（非成交）',
  area: '面积口径一致',
  built: '建成年份已补核',
  rights: '权利性质可比',
  time: '挂牌时点接近（12 个月内）',
}
export const PLAN_CHANNELS = ['链家', '房天下', '58'] as const
export type PlanChannel = typeof PLAN_CHANNELS[number]

export interface ExtractValue {
  value: string
  doc: string
  page: number
  quote: string
}

export interface MaterialFile {
  id: string
  path: string
  relPath: string
  name: string
  size: number
  mtime: number
  ext: string
  excluded: boolean
  demoKey: string
  pages: string[] | null
  fields: string[]
  note: string
}

export interface MaterialSource {
  id: string
  label: string
  kind: 'folder' | 'files'
  at: string
  files: MaterialFile[]
}

export interface TemplateView {
  name: string
  size: number
  status: 'pending'
  demo: boolean
  path: string
}

export interface AreaConflict {
  material: string
  user: string
  doc: string
  page: number
  quote: string
  choice: 'material' | 'user' | null
}

export interface Draft {
  projectId: string
  projectName: string
  category: '' | 'realestate'
  assetType: string
  city: string
  community: string
  location: string
  usage: string
  area: string
  areaSource: 'user' | 'material' | 'user-corrected'
  method: '市场法' | '收益法' | '成本法'
  baseDate: string
  note: string
  demo: boolean
  sources: MaterialSource[]
  template: TemplateView | null
  templateError: string
  conflict: AreaConflict | null
  extracts: Record<string, ExtractValue> | null
  savedAt: string
}

export interface FieldOption {
  value: string
  label: string
  disabled?: boolean
}

export interface FieldView {
  key: string
  label: string
  value: string
  tag: FieldTag
  group: 'basic' | 'rights' | 'valuation'
  control: 'text' | 'number' | 'date' | 'select' | 'textarea'
  unit: string
  required: boolean
  options: FieldOption[]
  questionId: string
  nodeId: string
  promise: string
  source: ExtractValue | null
  sourceText: string
  placeholder: string
  answered: boolean
}

export interface PlanConditions {
  channels: string[]
  areaMin: number | null
  areaMax: number | null
  targetCount: number
  stopCondition: string
  extra: string
  verifyBuilt: 'list' | 'detail'
}

export interface PlanSourceView {
  provider: string
  community: string
  unitPrice: string
  area: string
  transaction: string
  evidence: string
  reason: string
  url: string
}

export interface PlanView {
  id: string
  rev: number
  infoVersion: number
  status: PlanStatus
  method: string
  subjectArea: number | null
  createdAt: string
  conditions: PlanConditions
  inputs: { address: string; usage: string; area: string; rights: string; template: string }
  sources: PlanSourceView[]
  basis: string[]
  gaps: string[]
  limitations: string[]
  templateName: string
  templateVersion: string
  templateVerified: boolean
  digest: string
  host: boolean
}

export interface CaseView {
  id: string
  community: string
  unit: string
  addr: string
  area: number | null
  floor: string
  deal: string
  date: string
  unitPrice: number | null
  total: number | null
  distance: number | null
  decoration: string
  built: string
  rights: string
  channel: string
  source: string
  sourceUrl: string
  status: CaseStatus
  selection: 'unselected' | 'selected' | 'adopted' | 'excluded'
  missing: string[]
  recommendation: string
  similarities: string[]
  differences: string[]
  score: number
}

export interface AdoptedCase {
  id: string
  matchedRev: number
  needsReview: boolean
  note: string
  checks: Record<string, boolean>
}

export interface VersionChange {
  key: string
  label: string
  from: string
  to: string
}

export interface VersionRecord {
  version: number
  at: string
  author: string
  note: string
  changes: VersionChange[]
}

export interface HostProjection {
  available: boolean
  empty: boolean
  projectId: string
  parentSessionId: string
  phase: string
  status: string
  error: string
  updatedAt: string
  progress: Record<string, unknown> | null
  current: Record<string, unknown> | null
}

export type SheetState =
  | { kind: 'source'; key: string }
  | { kind: 'document'; id: string }
  | { kind: 'template' }
  | { kind: 'concept' }
  | { kind: 'note'; caseId: string }
  | { kind: 'discard' }
  | { kind: 'demo' }

export interface ExperienceState {
  view: ExperienceView
  intakeStage: IntakeStage
  workspaceStep: WorkflowStep
  draft: Draft
  materials: MaterialSource[]
  scan: { state: string; error: string; fileCount: number; limit: number; overLimit: boolean; truncated: boolean; readableCount: number }
  evaluationPhase: string
  fields: FieldView[]
  infoVersion: number
  history: VersionRecord[]
  lastSaved: { version: number; changes: VersionChange[] } | null
  draftValues: Record<string, string> | null
  plan: PlanView | null
  planHistory: Array<{ rev: number; infoVersion: number; targetCount: number; at: string }>
  candidates: CaseView[]
  candidateAt: string
  candidatePlanRev: number
  adopted: AdoptedCase[]
  caseFilter: 'all' | 'complete' | 'pending'
  checks: { docs: StepState; info: StepState; plan: StepState; cases: StepState; caseCheck: StepState }
  confirmAck: boolean
  areaRangePrompt: boolean
  infoTab: 'fields' | 'history' | 'basis'
  infoOpen: boolean
  planEditing: boolean
  sheet: SheetState | null
  busy: boolean
  error: string
  notice: string
  toast: { text: string; seq: number }
  mode: 'host' | 'demo' | 'empty'
  host: HostProjection
  refreshAt: string
  handoffPending: boolean
  autoConfirm: boolean
  openedHost: boolean
  handoffCanEdit: boolean
}

export interface HostSyncInput {
  current: Record<string, unknown> | null
  progress: Record<string, unknown> | null
  error: string
}

/* ------------------------------------------------------------------ */
/* Basic helpers                                                       */
/* ------------------------------------------------------------------ */

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function numberOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(text(value))
  return Number.isFinite(n) ? n : null
}

export function extOf(name: string): string {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return match === null ? '' : match[1] as string
}

export function typeLabelOf(ext: string): string {
  return ext === '' ? 'FILE' : ext.toUpperCase().slice(0, 5)
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.0', '')} MB`
}

export function nowLabel(clock: () => number = Date.now): string {
  const d = new Date(clock())
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

let sequence = 0
export function uid(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`
}

export function emptyChecks(): Record<string, boolean> {
  return { deal: false, area: false, built: false, rights: false, time: false }
}

export function isDocExt(ext: string): boolean {
  return (DOC_EXT as readonly string[]).includes(ext)
}

export function rowStatusOf(file: MaterialFile, duplicate: boolean): 'included' | 'excluded' | 'duplicate' | 'unsupported' | 'wrong-role' {
  if (file.ext === 'xlsx' || file.ext === 'xls') return 'wrong-role'
  if (!isDocExt(file.ext)) return 'unsupported'
  if (file.excluded) return 'excluded'
  if (duplicate) return 'duplicate'
  return 'included'
}

export interface MaterialRow {
  source: MaterialSource
  file: MaterialFile
  status: 'included' | 'excluded' | 'duplicate' | 'unsupported' | 'wrong-role'
  reason: string
}

export function materialRows(state: ExperienceState): MaterialRow[] {
  const seen = new Set<string>()
  const rows: MaterialRow[] = []
  for (const source of state.materials) {
    for (const file of source.files) {
      const duplicate = seen.has(`${file.relPath}|${file.size}`)
      const status = rowStatusOf(file, duplicate)
      if (status === 'included') seen.add(`${file.relPath}|${file.size}`)
      rows.push({ source, file, status, reason: reasonOf(status, file, duplicate) })
    }
  }
  return rows
}

function reasonOf(status: MaterialRow['status'], file: MaterialFile, duplicate: boolean): string {
  switch (status) {
    case 'wrong-role': return '计算表模板请在下方模板区单独选择，不并入产权资料。'
    case 'unsupported': return `格式不支持读取：${file.ext === '' ? '未知格式' : `.${file.ext}`}，保留在清单中供你确认。`
    case 'excluded': return '已手动排除。'
    case 'duplicate': return duplicate ? '与已纳入文件的相对路径和大小相同；字节是否相同由 Host 判断。' : ''
    default: return ''
  }
}

export function materialStats(rows: MaterialRow[]): {
  included: number
  excluded: number
  duplicate: number
  unsupported: number
  total: number
} {
  return {
    included: rows.filter((row) => row.status === 'included').length,
    excluded: rows.filter((row) => row.status === 'excluded').length,
    duplicate: rows.filter((row) => row.status === 'duplicate').length,
    unsupported: rows.filter((row) => row.status === 'unsupported' || row.status === 'wrong-role').length,
    total: rows.length,
  }
}

export function includedRows(state: ExperienceState): MaterialRow[] {
  return materialRows(state).filter((row) => row.status === 'included')
}

export function fullLocation(draft: Draft): string {
  const loc = text(draft.location)
  const city = text(draft.city)
  if (loc === '') return [city, text(draft.community)].filter((item) => item !== '').join('')
  if (city !== '' && !loc.startsWith(city)) return `${city}${loc}`
  return loc
}

export function filledCount(draft: Draft): number {
  const keys: Array<keyof Draft> = ['projectName', 'city', 'community', 'location', 'usage', 'area', 'baseDate', 'note']
  return keys.filter((key) => text(draft[key]) !== '').length
}

export function infoGate(state: ExperienceState): { ok: boolean; hasDoc: boolean; hasInput: boolean } {
  const hasDoc = includedRows(state).length > 0
  const hasInput = filledCount(state.draft) > 0
  return { ok: hasDoc || hasInput, hasDoc, hasInput }
}

export function activeConflict(state: ExperienceState): AreaConflict | null {
  const conflict = state.draft.conflict
  if (conflict === null || !state.draft.demo) return null
  if (text(state.draft.area) === '') return null
  const hasDoc = includedRows(state).some((row) => row.file.demoKey === 'd1')
  return hasDoc ? conflict : null
}

export function conflictPending(state: ExperienceState): boolean {
  const conflict = activeConflict(state)
  return conflict !== null && conflict.choice === null
}

export function areaTagOf(state: ExperienceState): string {
  if (text(state.draft.area) === '') return '待核对'
  if (state.draft.areaSource === 'material') return '材料摘取'
  if (state.draft.areaSource === 'user-corrected') return '用户更正'
  return '用户填写'
}

export function readableCount(state: ExperienceState): number {
  return includedRows(state).filter((row) => row.file.pages !== null).length
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

export const FIELD_GROUPS: ReadonlyArray<{ key: FieldView['group']; title: string }> = [
  { key: 'basic', title: '基本属性' },
  { key: 'rights', title: '权利与现状' },
  { key: 'valuation', title: '评估口径' },
]

export const FIELD_META: ReadonlyArray<{
  key: string
  label: string
  group: FieldView['group']
  control: FieldView['control']
  unit: string
  required: boolean
  placeholder: string
}> = [
  { key: 'location', label: '坐落位置', group: 'basic', control: 'textarea', unit: '', required: true, placeholder: '未填写' },
  { key: 'area', label: '建筑面积', group: 'basic', control: 'number', unit: '㎡', required: true, placeholder: '未填写' },
  { key: 'usage', label: '房屋用途', group: 'basic', control: 'text', unit: '', required: true, placeholder: '未填写' },
  { key: 'built', label: '建筑年代', group: 'basic', control: 'text', unit: '', required: false, placeholder: '未填写' },
  { key: 'floor', label: '所在楼层', group: 'basic', control: 'text', unit: '', required: false, placeholder: '未填写' },
  { key: 'rights', label: '权利性质', group: 'rights', control: 'text', unit: '', required: false, placeholder: '未填写' },
  { key: 'decoration', label: '装修情况', group: 'rights', control: 'text', unit: '', required: false, placeholder: '未填写' },
  { key: 'occupancy', label: '使用现状', group: 'rights', control: 'text', unit: '', required: false, placeholder: '未填写' },
  { key: 'mortgage', label: '抵押情况', group: 'rights', control: 'text', unit: '', required: false, placeholder: '尚未核实' },
  { key: 'baseDate', label: '评估基准日', group: 'valuation', control: 'date', unit: '', required: false, placeholder: '未填写' },
  { key: 'method', label: '评估方法', group: 'valuation', control: 'select', unit: '', required: true, placeholder: '未填写' },
  { key: 'areaBasis', label: '面积口径', group: 'valuation', control: 'text', unit: '', required: true, placeholder: '建筑面积' },
  { key: 'caseRange', label: '案例面积范围', group: 'valuation', control: 'text', unit: '', required: false, placeholder: '可选，如 80–105 ㎡' },
]

const METHOD_OPTIONS: FieldOption[] = [
  { value: '市场法', label: '市场法' },
  { value: '收益法', label: '收益法（未接通）', disabled: true },
  { value: '成本法', label: '成本法（未接通）', disabled: true },
]

function fieldOf(key: string, patch: Partial<FieldView>): FieldView {
  const meta = FIELD_META.find((item) => item.key === key)
  if (meta === undefined) {
    return {
      key, label: key, value: '', tag: '待核对', group: 'basic', control: 'text', unit: '', required: false,
      options: [], questionId: '', nodeId: '', promise: '', source: null, sourceText: '', placeholder: '', answered: false,
      ...patch,
    }
  }
  return {
    key,
    label: meta.label,
    value: '',
    tag: '待核对',
    group: meta.group,
    control: meta.control,
    unit: meta.unit,
    required: meta.required,
    options: key === 'method' ? METHOD_OPTIONS : [],
    questionId: '',
    nodeId: '',
    promise: '',
    source: null,
    sourceText: '',
    placeholder: meta.placeholder,
    answered: false,
    ...patch,
  }
}

export function fieldsFromDraft(draft: Draft): FieldView[] {
  const valueOf: Record<string, string> = {
    location: fullLocation(draft),
    area: text(draft.area),
    usage: text(draft.usage),
    baseDate: text(draft.baseDate),
    method: text(draft.method),
    areaBasis: '建筑面积',
  }
  return FIELD_META.map((meta) => {
    const value = valueOf[meta.key] ?? ''
    const tag: FieldTag = value === '' ? '待核对' : '用户填写'
    return fieldOf(meta.key, { value, tag, answered: value !== '' })
  })
}

export function fieldsFromDemo(state: ExperienceState): FieldView[] {
  const draft = state.draft
  const extracts = draft.extracts ?? {}
  const hasDoc = (key: string): boolean => includedRows(state).some((row) => row.file.demoKey === key)
  const get = (extractKey: string): ExtractValue | null => {
    const item = extracts[extractKey]
    return item === undefined ? null : item
  }
  const defaults: Record<string, string> = {
    location: fullLocation(draft),
    area: text(draft.area),
    usage: text(draft.usage),
    baseDate: text(draft.baseDate),
    method: text(draft.method),
    floor: '',
    areaBasis: '建筑面积',
  }
  return FIELD_META.map((meta) => {
    const extractKey = meta.key === 'area' ? 'area' : meta.key
    const material = hasDoc(meta.key === 'built' ? 'd3' : meta.key === 'decoration' ? 'd5' : 'd1') ? get(extractKey) : null
    const userValue = defaults[meta.key] ?? ''
    const value = meta.key === 'area'
      ? (text(draft.area) !== '' ? text(draft.area) : material?.value ?? '')
      : (userValue !== '' ? userValue : material?.value ?? '')
    let tag: FieldTag = '待核对'
    let source: ExtractValue | null = null
    let sourceText = ''
    if (material !== null && value === material.value) {
      tag = '材料摘取'
      source = material
    } else if (material !== null && value !== '') {
      tag = '用户更正'
      source = material
      sourceText = `原资料 ${material.value} 仍保留`
    } else if (value !== '') {
      tag = '用户填写'
    }
    if (meta.key === 'area' && tag !== '待核对') {
      tag = areaTagOf(state) as FieldTag
      if (draft.areaSource === 'user-corrected') tag = '用户更正'
    }
    return fieldOf(meta.key, { value, tag, source, sourceText, answered: value !== '' })
  })
}

const FIELD_ALIASES: Record<string, string> = {
  areaSqm: 'area', buildingArea: 'area', area: 'area',
  useLabel: 'usage', plannedUse: 'usage', usage: 'usage',
  address: 'location', location: 'location',
  builtYear: 'built', completionYear: 'built', built: 'built',
  floorLevel: 'floor', floor: 'floor',
  rightType: 'rights', rights: 'rights',
  decoration: 'decoration', renovation: 'decoration',
  occupancy: 'occupancy', mortgage: 'mortgage',
  baseDate: 'baseDate', method: 'method', areaBasis: 'areaBasis', caseRange: 'caseRange',
}

function normalizedFieldKey(field: string): string {
  const raw = field.replace(/^.*[:.]/, '')
  return FIELD_ALIASES[raw] ?? raw
}

export function fieldsFromHost(progress: Record<string, unknown> | null, draft: Draft): FieldView[] {
  const questionnaire = record(progress?.questionnaire)
  const questions = asArray(questionnaire?.questions)
  const mapped = new Map<string, FieldView>()
  for (const raw of questions) {
    const question = record(raw)
    if (question === null || question.applicable === false) continue
    const field = text(question.field)
    if (field === '') continue
    const key = normalizedFieldKey(field)
    if (mapped.has(key)) continue
    const known = text(question.knownValue)
    const answer = answerTextOf(question.answer)
    const value = answer !== '' ? answer : known
    let tag: FieldTag = '待核对'
    if (answer !== '' && known !== '' && answer !== known) tag = '用户更正'
    else if (known !== '') tag = '材料摘取'
    else if (answer !== '') tag = '用户填写'
    else if (value !== '') tag = '用户填写'
    const options = asArray(question.options).flatMap((option) => {
      const item = record(option)
      if (item === null) return []
      return [{ value: text(item.value), label: text(item.label) || text(item.value) }]
    })
    const control = text(question.control)
    const meta = FIELD_META.find((item) => item.key === key)
    mapped.set(key, fieldOf(key, {
      label: meta?.label ?? (text(question.prompt) || key),
      value,
      tag,
      group: meta?.group ?? 'basic',
      control: control === 'number' ? 'number'
        : control === 'date' ? 'date'
          : control === 'select' || control === 'radio' ? 'select'
            : control === 'textarea' ? 'textarea'
              : meta?.control ?? 'text',
      unit: meta?.unit ?? '',
      required: question.required !== false,
      options: options.length > 0 ? options : (key === 'method' ? METHOD_OPTIONS : []),
      questionId: text(question.questionId),
      nodeId: text(question.nodeId),
      sourceText: text(question.source),
      placeholder: meta?.placeholder ?? '未填写',
      answered: question.answer !== null && question.answer !== undefined,
    }))
  }
  const base = fieldsFromDraft(draft)
  const canonical = FIELD_META.map((meta) => {
    const existing = mapped.get(meta.key)
    const fallback = base.find((item) => item.key === meta.key) ?? fieldOf(meta.key, {})
    if (existing === undefined) return fallback
    if (existing.value === '' && fallback.value !== '') {
      return { ...existing, value: fallback.value, tag: '用户填写' as FieldTag, answered: false }
    }
    return existing
  })
  const extras = [...mapped.entries()]
    .filter(([key]) => !FIELD_META.some((meta) => meta.key === key))
    .map(([, field]) => field)
  return [...canonical, ...extras]
}

export function answerTextOf(value: unknown): string {
  const answer = record(value)
  if (answer === null) return ''
  const kind = text(answer.kind)
  if (kind === 'choice') {
    const values = asArray(answer.values).map((item) => text(item)).filter(Boolean)
    const supplement = text(answer.supplement)
    return [values.join(' / '), supplement].filter(Boolean).join('；')
  }
  if (kind === 'other') return text(answer.text)
  if (kind === 'defer') return ''
  return text(answer.value)
}

export function countPending(fields: FieldView[]): number {
  return fields.filter((field) => field.tag === '待核对').length
}

export function missingRequired(fields: FieldView[]): FieldView[] {
  return fields.filter((field) => field.required && text(field.value) === '')
}

/** Host fields only block on questions the Host actually asked; local fields keep all required ones. */
export function missingRequiredFor(state: ExperienceState): FieldView[] {
  if (state.mode !== 'host') return missingRequired(state.fields)
  return state.fields.filter((field) => field.required && field.questionId !== '' && text(field.value) === '')
}

export function fieldTagsOf(fields: FieldView[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const field of fields) out[field.tag] = (out[field.tag] ?? 0) + 1
  return out
}

/* ------------------------------------------------------------------ */
/* Intake reducers                                                     */
/* ------------------------------------------------------------------ */

export function blankDraft(): Draft {
  return {
    projectId: '',
    projectName: '',
    category: '',
    assetType: '',
    city: '',
    community: '',
    location: '',
    usage: '',
    area: '',
    areaSource: 'user',
    method: '市场法',
    baseDate: '',
    note: '',
    demo: false,
    sources: [],
    template: null,
    templateError: '',
    conflict: null,
    extracts: null,
    savedAt: '',
  }
}

export function initialExperienceState(): ExperienceState {
  const draft = blankDraft()
  return {
    view: 'intake',
    intakeStage: 'object',
    workspaceStep: 'docs',
    draft,
    materials: [],
    scan: { state: 'idle', error: '', fileCount: 0, limit: 200, overLimit: false, truncated: false, readableCount: 0 },
    evaluationPhase: 'draft',
    fields: fieldsFromDraft(draft),
    infoVersion: 0,
    history: [],
    lastSaved: null,
    draftValues: null,
    plan: null,
    planHistory: [],
    candidates: [],
    candidateAt: '',
    candidatePlanRev: 0,
    adopted: [],
    caseFilter: 'all',
    checks: { docs: 'todo', info: 'todo', plan: 'todo', cases: 'todo', caseCheck: 'todo' },
    confirmAck: false,
    areaRangePrompt: false,
    infoTab: 'fields',
    infoOpen: false,
    planEditing: false,
    sheet: null,
    busy: false,
    error: '',
    notice: '',
    toast: { text: '', seq: 0 },
    mode: 'empty',
    host: {
      available: false, empty: true, projectId: '', parentSessionId: '', phase: '', status: '',
      error: '', updatedAt: '', progress: null, current: null,
    },
    refreshAt: '',
    handoffPending: false,
    autoConfirm: false,
    openedHost: false,
    handoffCanEdit: true,
  }
}

export function patchDraft(state: ExperienceState, patch: Partial<Draft>): ExperienceState {
  const draft = { ...state.draft, ...patch }
  return {
    ...state,
    draft,
    fields: state.mode === 'demo' ? fieldsFromDemo({ ...state, draft }) : fieldsFromDraft(draft),
  }
}

export function applyIntakeField(state: ExperienceState, field: string, value: string): ExperienceState {
  const draft = { ...state.draft, [field]: value } as Draft
  if (field === 'area') {
    const conflict = draft.conflict
    if (conflict !== null) {
      const next = { ...conflict, user: value }
      if (text(value) === conflict.material) {
        next.choice = 'material'
        draft.areaSource = 'material'
      } else {
        next.choice = null
        draft.areaSource = 'user'
      }
      draft.conflict = next
    } else {
      draft.areaSource = 'user'
    }
  }
  if (field === 'method') draft.method = '市场法'
  return {
    ...state,
    draft,
    fields: state.mode === 'demo' ? fieldsFromDemo({ ...state, draft }) : fieldsFromDraft(draft),
  }
}

export function chooseConflict(state: ExperienceState, choice: 'material' | 'user'): ExperienceState {
  const conflict = activeConflict(state)
  if (conflict === null) return state
  const next = { ...conflict, choice }
  const draft: Draft = choice === 'material'
    ? { ...state.draft, area: conflict.material, areaSource: 'material', conflict: next }
    : { ...state.draft, area: conflict.user, areaSource: 'user-corrected', conflict: next }
  return { ...state, draft, fields: state.mode === 'demo' ? fieldsFromDemo({ ...state, draft }) : fieldsFromDraft(draft) }
}

export function setTemplate(state: ExperienceState, template: TemplateView | null, error = ''): ExperienceState {
  return { ...state, draft: { ...state.draft, template, templateError: error } }
}

export function toggleDemoFile(state: ExperienceState, fileId: string): ExperienceState {
  const sources = state.draft.sources.map((source) => ({
    ...source,
    files: source.files.map((file) => file.id === fileId ? { ...file, excluded: !file.excluded } : file),
  }))
  const hasDemo = sources.some((source) => source.files.some((file) => file.demoKey !== ''))
  const next: ExperienceState = {
    ...state,
    draft: { ...state.draft, sources, demo: hasDemo, conflict: hasDemo ? state.draft.conflict : null },
    mode: hasDemo ? 'demo' : (state.host.projectId === '' ? 'empty' : 'host'),
  }
  return { ...next, materials: demoMaterials(next), fields: fieldsFromDemo(next) }
}

export function removeDemoSource(state: ExperienceState, sourceId: string): ExperienceState {
  const sources = state.draft.sources.filter((source) => source.id !== sourceId)
  const hasDemo = sources.some((source) => source.files.some((file) => file.demoKey !== ''))
  const next: ExperienceState = {
    ...state,
    draft: { ...state.draft, sources, demo: hasDemo, conflict: hasDemo ? state.draft.conflict : null },
    mode: hasDemo ? 'demo' : (state.host.projectId === '' ? 'empty' : 'host'),
  }
  return { ...next, materials: demoMaterials(next), fields: fieldsFromDemo(next) }
}

/* ------------------------------------------------------------------ */
/* Demo fixture                                                        */
/* ------------------------------------------------------------------ */

const DEMO_QUOTE = {
  material: '89.5',
  user: '96.2',
  doc: '不动产权证.pdf',
  page: 2,
  quote: '房屋建筑面积 89.50 平方米，其中套内建筑面积 72.18 平方米。',
}

export const DEMO_EXTRACT: Record<string, ExtractValue> = {
  location: { value: '杭州市滨江区江陵路 188 号滨江花园 3 幢 2 单元 1802 室', doc: '不动产权证.pdf', page: 2, quote: '坐落：杭州市滨江区江陵路 188 号滨江花园 3 幢 2 单元 1802 室。' },
  area: { value: DEMO_QUOTE.material, doc: DEMO_QUOTE.doc, page: DEMO_QUOTE.page, quote: DEMO_QUOTE.quote },
  usage: { value: '住宅', doc: '不动产权证.pdf', page: 1, quote: '规划用途：住宅；房屋性质：商品房。' },
  built: { value: '2016 年', doc: '房屋买卖合同.pdf', page: 3, quote: '该房屋于 2016 年 6 月竣工交付，钢混结构。' },
  rights: { value: '出让 / 商品房', doc: '不动产权证.pdf', page: 1, quote: '权利性质：出让；土地使用期限至 2086 年 5 月 29 日。' },
  decoration: { value: '精装修', doc: '装修情况说明.docx', page: 1, quote: '全屋精装修，2024 年完成翻新，厨卫设施齐全。' },
}

const DEMO_PAGES: Record<string, string[]> = {
  d1: ['read', 'read', 'read', 'blank', 'blank', 'blank', 'blank', 'blank', 'blank', 'blank', 'blank', 'blank'],
  d2: ['read', 'read', 'blank'],
  d3: ['read', 'read', 'read', 'blank', 'blank', 'blank', 'blank', 'blank'],
  d4: ['read'],
  d5: ['read', 'blank'],
  d6: ['reg'],
  d7: ['reg'],
}

const DEMO_DOC_FIELDS: Record<string, string[]> = {
  d1: ['坐落位置', '建筑面积', '房屋用途', '权利性质'],
  d2: [],
  d3: ['建筑年代'],
  d4: [],
  d5: ['装修情况'],
  d6: [],
  d7: [],
}

function demoFile(key: string, relPath: string, size: number, mtime: number, excluded = false): MaterialFile {
  return {
    id: `demo-${key}`,
    path: '',
    relPath,
    name: relPath.split('/').slice(-1)[0] ?? relPath,
    size,
    mtime,
    ext: extOf(relPath),
    excluded,
    demoKey: key,
    pages: DEMO_PAGES[key] ?? null,
    fields: DEMO_DOC_FIELDS[key] ?? [],
    note: DEMO_PAGES[key] === undefined ? '手动登记' : '示例资料 · 演示摘取',
  }
}

export function demoDraft(projectId = DEMO_PROJECT_ID): Draft {
  return {
    ...blankDraft(),
    projectId,
    projectName: '滨江花园 3 幢 1802 室 · 市场法案例准备',
    category: 'realestate',
    assetType: '住宅',
    city: '杭州市',
    community: '滨江花园',
    location: '滨江区江陵路 188 号滨江花园 3 幢 2 单元 1802 室',
    usage: '住宅',
    area: DEMO_QUOTE.user,
    areaSource: 'user',
    method: '市场法',
    baseDate: '2026-09-30',
    note: '优先同小区、同用途住宅；挂牌价仅作背景资料，不当作成交依据。',
    demo: true,
    sources: [
      {
        id: 'demo-source-1',
        label: '示例·产权资料',
        kind: 'folder',
        at: '示例',
        files: [
          demoFile('d1', '示例·产权资料/权属证明/不动产权证.pdf', 2516582, 1792500000000),
          demoFile('d2', '示例·产权资料/权属证明/不动产登记信息查询记录.pdf', 880640, 1792500000000),
          demoFile('d3', '示例·产权资料/交易资料/房屋买卖合同.pdf', 1153434, 1792500000000),
          demoFile('d4', '示例·产权资料/交易资料/购房发票.jpg', 1677721, 1792500000000),
          demoFile('d5', '示例·产权资料/现状资料/装修情况说明.docx', 88064, 1792500000000),
          demoFile('d6', '示例·产权资料/现状资料/小区实勘/南向客厅.jpg', 4404019, 1792500000000),
          demoFile('d7', '示例·产权资料/现状资料/小区实勘/户型图.png', 1887436, 1792500000000),
          demoFile('d8', '示例·产权资料/现状资料/旧版户型图.png', 2013266, 1792500000000, true),
          demoFile('d9', '示例·产权资料/现状资料/说明.txt', 4210, 1792500000000),
        ],
      },
      {
        id: 'demo-source-2',
        label: '示例·重复扫描（同一相对路径）',
        kind: 'folder',
        at: '示例',
        files: [demoFile('dup', '示例·产权资料/权属证明/不动产权证.pdf', 2516582, 1792500000000)],
      },
    ],
    template: { name: '示例·住宅市场法计算表.xlsx', size: 1887436, status: 'pending', demo: true, path: '' },
    templateError: '',
    conflict: {
      material: DEMO_QUOTE.material,
      user: DEMO_QUOTE.user,
      doc: DEMO_QUOTE.doc,
      page: DEMO_QUOTE.page,
      quote: DEMO_QUOTE.quote,
      choice: null,
    },
    extracts: DEMO_EXTRACT,
    savedAt: '',
  }
}

export function demoMaterials(state: ExperienceState): MaterialSource[] {
  return state.draft.sources
}

export function loadDemoState(state: ExperienceState, projectId = state.draft.projectId || DEMO_PROJECT_ID): ExperienceState {
  const draft = demoDraft(projectId)
  const materials = demoMaterials({ ...state, draft })
  const withMaterials = { ...state, draft, materials }
  const next: ExperienceState = {
    ...withMaterials,
    fields: fieldsFromDemo(withMaterials),
    mode: 'demo',
    view: 'intake',
    intakeStage: 'info',
    infoVersion: 1,
    history: [{ version: 1, at: nowLabel(), author: '示例评估师', note: '从示例资料摘取并建档', changes: [] }],
    lastSaved: null,
    draftValues: null,
    plan: null,
    planHistory: [],
    candidates: [],
    candidateAt: '',
    candidatePlanRev: 0,
    adopted: [],
    checks: { docs: 'done', info: 'todo', plan: 'todo', cases: 'todo', caseCheck: 'todo' },
    confirmAck: false,
    error: '',
    notice: '',
    sheet: null,
    toast: { text: '已载入示例项目：虚构资料、手填信息与住宅市场法模板', seq: state.toast.seq + 1 },
  }
  return next
}

/* ------------------------------------------------------------------ */
/* Plan                                                               */
/* ------------------------------------------------------------------ */

export function parseAreaRange(value: string): { min: number; max: number } | null {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*[–\-~至]\s*(\d+(?:\.\d+)?)/)
  if (match === null) return null
  const a = Number.parseFloat(match[1] as string)
  const b = Number.parseFloat(match[2] as string)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null
  return { min: Math.min(a, b), max: Math.max(a, b) }
}

export function defaultConditions(area: number, range: string, note = ''): PlanConditions {
  const parsed = parseAreaRange(range)
  return {
    channels: [...PLAN_CHANNELS],
    areaMin: parsed?.min ?? Math.floor(area * 0.85),
    areaMax: parsed?.max ?? Math.ceil(area * 1.15),
    targetCount: 8,
    stopCondition: '候选达到目标数，或近 12 个月挂牌翻查完毕即停止。',
    extra: note,
    verifyBuilt: 'detail',
  }
}

export function sanitizeConditions(value: Partial<PlanConditions> | null, area: number, note = ''): PlanConditions {
  const base = defaultConditions(area || 89.5, '', note)
  const min = numberOf(value?.areaMin)
  const max = numberOf(value?.areaMax)
  const target = numberOf(value?.targetCount)
  const channels = asArray(value?.channels).map((item) => text(item)).filter((item) => (PLAN_CHANNELS as readonly string[]).includes(item))
  return {
    channels: channels.length > 0 ? channels : base.channels,
    areaMin: min !== null && min > 0 ? min : base.areaMin,
    areaMax: max !== null && max > 0 ? max : base.areaMax,
    targetCount: target !== null ? Math.max(1, Math.min(12, Math.round(target))) : base.targetCount,
    stopCondition: text(value?.stopCondition) || base.stopCondition,
    extra: value?.extra === undefined ? base.extra : text(value.extra),
    verifyBuilt: value?.verifyBuilt === 'list' ? 'list' : 'detail',
  }
}

export function planStatusOf(state: ExperienceState): PlanStatus | 'none' {
  const plan = state.plan
  if (plan === null) return 'none'
  if (plan.infoVersion !== state.infoVersion) return 'stale'
  return plan.status
}

export function planValidConfirmed(state: ExperienceState): boolean {
  return planStatusOf(state) === 'confirmed'
}

export function buildPlan(state: ExperienceState, previous: PlanView | null, area: number): PlanView {
  const conditions = previous !== null
    ? sanitizeConditions(previous.conditions, area, state.draft.note)
    : defaultConditions(area, fieldValueOf(state.fields, 'caseRange'), state.draft.note)
  return {
    id: previous === null ? 'local-plan-1' : `local-plan-${previous.rev + 1}`,
    rev: previous === null ? 1 : previous.rev + 1,
    infoVersion: state.infoVersion,
    status: 'pending',
    method: '市场法',
    subjectArea: area,
    createdAt: nowLabel(),
    conditions,
    inputs: {
      address: fullLocation(state.draft),
      usage: state.draft.usage,
      area: `${area} ㎡`,
      rights: fieldValueOf(state.fields, 'rights'),
      template: state.draft.template?.name ?? '未选择计算表模板',
    },
    sources: [],
    basis: [],
    gaps: [],
    limitations: [],
    templateName: state.draft.template?.name ?? '未选择计算表模板',
    templateVersion: state.draft.template?.demo === true ? '示例结构' : '待检查',
    templateVerified: false,
    digest: '',
    host: false,
  }
}

function fieldValueOf(fields: FieldView[], key: string): string {
  return fields.find((field) => field.key === key)?.value ?? ''
}

/* ------------------------------------------------------------------ */
/* Cases                                                              */
/* ------------------------------------------------------------------ */

export const DEMO_CASES: ReadonlyArray<Omit<CaseView, 'score'>> = [
  { id: 'C-01', community: '滨江花园', unit: '2 幢 1502 室', addr: '同小区 · 江陵路 188 号', area: 86.4, floor: '15 / 26', deal: '示例挂牌', date: '2026-08-14', unitPrice: 48600, total: 420, distance: 0.2, decoration: '精装修', built: '2016', rights: '出让 / 商品房', channel: '链家', source: '经纪机构挂牌信息（示例）', sourceUrl: '', status: 'eligible', selection: 'unselected', missing: [], recommendation: '同小区、面积接近，建议采用', similarities: ['同小区', '同用途'], differences: ['楼层不同'] },
  { id: 'C-02', community: '滨江花园', unit: '5 幢 901 室', addr: '同小区 · 江陵路 188 号', area: 92.8, floor: '9 / 26', deal: '示例挂牌', date: '2026-09-02', unitPrice: 45900, total: 426, distance: 0.3, decoration: '简装', built: '2016', rights: '出让 / 商品房', channel: '房天下', source: '经纪机构挂牌信息（示例）', sourceUrl: '', status: 'eligible', selection: 'unselected', missing: [], recommendation: '面积略大，装修差异需修正', similarities: ['同小区'], differences: ['简装'] },
  { id: 'C-03', community: '江南名庭', unit: '3 幢 1701 室', addr: '江汉路 66 号 · 约 1.2 km', area: 95.2, floor: '17 / 24', deal: '示例挂牌', date: '2026-07-28', unitPrice: 47200, total: 449, distance: 1.2, decoration: '精装修', built: '2015', rights: '出让 / 商品房', channel: '链家', source: '经纪机构挂牌信息（示例）', sourceUrl: '', status: 'nearby', selection: 'unselected', missing: [], recommendation: '邻近小区，可作为背景案例', similarities: ['同区域', '精装'], differences: ['不同小区'] },
  { id: 'C-04', community: '滨江花园', unit: '1 幢 2201 室', addr: '同小区 · 江陵路 188 号', area: 88.9, floor: '22 / 26', deal: '示例挂牌', date: '2026-06-19', unitPrice: 49100, total: 437, distance: 0.2, decoration: '精装修', built: '2016', rights: '出让 / 商品房', channel: '58', source: '经纪机构挂牌信息（示例）', sourceUrl: '', status: 'eligible', selection: 'unselected', missing: [], recommendation: '面积接近、精装，可比性较高', similarities: ['同小区', '精装'], differences: ['楼层更高'] },
  { id: 'C-05', community: '春江郦城', unit: '8 幢 1203 室', addr: '滨盛路 900 号 · 约 2.1 km', area: 84.0, floor: '12 / 18', deal: '示例挂牌', date: '2026-09-05', unitPrice: 46800, total: 393, distance: 2.1, decoration: '简装', built: '', rights: '出让 / 商品房', channel: '房天下', source: '经纪机构挂牌信息（示例）', sourceUrl: '', status: 'nearby', selection: 'unselected', missing: ['建成年份'], recommendation: '距离较远，仅作背景', similarities: ['同区域'], differences: ['距离 2.1 km', '简装'] },
  { id: 'C-06', community: '江南名庭', unit: '2 幢 1102 室', addr: '江汉路 66 号 · 约 1.4 km', area: 97.5, floor: '', deal: '示例挂牌', date: '2026-09-18', unitPrice: 44500, total: 434, distance: 1.4, decoration: '精装修', built: '2015', rights: '出让 / 商品房', channel: '58', source: '经纪机构挂牌信息（示例）', sourceUrl: '', status: 'nearby', selection: 'unselected', missing: ['楼层'], recommendation: '面积偏大，楼层待核', similarities: ['精装'], differences: ['面积偏大'] },
  { id: 'C-07', community: '滨江花园', unit: '6 幢 702 室', addr: '同小区 · 江陵路 188 号', area: 90.1, floor: '7 / 26', deal: '示例挂牌', date: '2026-05-30', unitPrice: 45300, total: 408, distance: 0.3, decoration: '毛坯', built: '2016', rights: '出让 / 商品房', channel: '链家', source: '经纪机构挂牌信息（示例）', sourceUrl: '', status: 'eligible', selection: 'unselected', missing: [], recommendation: '毛坯，需做装修修正', similarities: ['同小区'], differences: ['毛坯'] },
  { id: 'C-08', community: '春江郦城', unit: '5 幢 1801 室', addr: '滨盛路 900 号 · 约 1.8 km', area: 99.0, floor: '18 / 22', deal: '示例挂牌', date: '2026-08-22', unitPrice: 48900, total: 484, distance: 1.8, decoration: '精装修', built: '2018', rights: '出让 / 商品房', channel: '房天下', source: '经纪机构挂牌信息（示例）', sourceUrl: '', status: 'nearby', selection: 'unselected', missing: [], recommendation: '面积偏大，建成年份较新', similarities: ['精装'], differences: ['面积偏大'] },
]

export function scoreCase(c: Pick<CaseView, 'area' | 'distance' | 'decoration' | 'built'>, subjectArea: number): number {
  if (c.area === null) return 60
  const diff = Math.abs(c.area - subjectArea) / subjectArea
  let score = 100 - diff * 120
  if (c.distance !== null && c.distance > 0.5) score -= (c.distance - 0.5) * 4
  if (c.decoration === '毛坯') score -= 8
  else if (c.decoration === '简装') score -= 2
  const built = Number.parseInt(c.built, 10)
  if (Number.isFinite(built) && built < 2013) score -= 2
  return Math.max(48, Math.min(99, Math.round(score)))
}

export function matchingDemoCases(plan: PlanView): CaseView[] {
  const conditions = sanitizeConditions(plan.conditions, plan.subjectArea ?? 89.5)
  return DEMO_CASES
    .filter((c) => conditions.channels.includes(c.channel)
      && c.area !== null
      && c.area >= conditions.areaMin!
      && c.area <= conditions.areaMax!)
    .map((c) => ({ ...c, score: scoreCase(c, plan.subjectArea ?? 89.5) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, conditions.targetCount)
}

export function caseMissing(c: CaseView): string[] {
  const missing: string[] = []
  if (c.floor === '') missing.push('楼层')
  if (c.built === '') missing.push('建成年份')
  if (c.rights === '' || c.rights === '待核') missing.push('权利性质')
  return missing
}

export function caseStatusLabel(state: ExperienceState, entry: AdoptedCase | undefined): string {
  if (entry === undefined) return '待核对'
  const all = CHECK_KEYS.every((key) => entry.checks[key] === true)
  if (entry.needsReview) return '需复核'
  if (all && state.checks.caseCheck === 'done') return '已核对'
  return '待核对'
}

export function adoptedCaseOf(state: ExperienceState, caseId: string): AdoptedCase | undefined {
  return state.adopted.find((entry) => entry.id === caseId)
}

/* ------------------------------------------------------------------ */
/* Navigation / step states                                            */
/* ------------------------------------------------------------------ */

export function navStateFor(state: ExperienceState, route: WorkflowStep): { state: string; cls: 'done' | 'warn' | '' } {
  const planStatus = planStatusOf(state)
  if (route === 'docs') {
    if (state.materials.every((source) => source.files.length === 0)) return { state: '未开始', cls: '' }
    return { state: state.draft.template !== null ? '已载入' : '已载入资料', cls: 'done' }
  }
  if (route === 'check') {
    if (state.checks.info === 'done') return { state: '已核对', cls: 'done' }
    const pending = countPending(state.fields)
    return { state: pending > 0 ? `${pending} 项待核对` : '待核对', cls: 'warn' }
  }
  if (route === 'reasoning') {
    if (state.plan === null) return { state: '未开始', cls: '' }
    if (planStatus === 'stale') return { state: '需重新推理', cls: 'warn' }
    if (planStatus === 'draft') return { state: '草案', cls: 'warn' }
    if (planStatus === 'pending') return { state: '待确认', cls: '' }
    return { state: '已确认', cls: 'done' }
  }
  if (route === 'confirm') {
    if (state.plan === null) return { state: '未开始', cls: '' }
    if (planStatus === 'stale') return { state: '需重新确认', cls: 'warn' }
    if (planStatus === 'draft') return { state: '待提交', cls: 'warn' }
    if (planStatus === 'pending') return { state: '待确认', cls: '' }
    return { state: '已完成', cls: 'done' }
  }
  if (route === 'cases') {
    if (state.plan === null) return { state: '未开始', cls: '' }
    if (planStatus === 'stale') return { state: '需重新检索', cls: 'warn' }
    if (planStatus !== 'confirmed') return { state: '待方案确认', cls: '' }
    if (state.candidates.length > 0 && state.candidatePlanRev === state.plan.rev) return { state: '已获取案例', cls: 'done' }
    return { state: '待检索', cls: '' }
  }
  if (route === 'caseCheck') {
    if (state.adopted.length === 0) return { state: '未开始', cls: '' }
    if (state.checks.caseCheck === 'done' && planValidConfirmed(state)) return { state: '已完成', cls: 'done' }
    if (state.adopted.some((entry) => entry.needsReview)) return { state: '需复核', cls: 'warn' }
    if (!planValidConfirmed(state)) return { state: '待方案确认', cls: '' }
    return { state: '待核对', cls: '' }
  }
  return { state: '', cls: '' }
}

export function workspaceStepOfHost(progress: Record<string, unknown> | null): WorkflowStep {
  if (progress === null) return 'docs'
  const market = record(progress.market)
  const currentNode = text(market?.currentNode)
  if (currentNode !== '') {
    if (currentNode === 'templates' || currentNode === 'materials') return 'docs'
    if (currentNode === 'collection-plan') return 'reasoning'
    if (currentNode === 'confirm-plan') return 'confirm'
    if (currentNode === 'search-listings' || currentNode === 'candidate-workbook' || currentNode === 'select-cases' || currentNode === 'inspect-details') return 'cases'
    return 'caseCheck'
  }
  const plan = record(progress.plan)
  if (plan !== null && plan.accepted === true) {
    return asArray(record(progress.market)?.candidates).length > 0 ? 'cases' : 'confirm'
  }
  if (plan !== null) return 'reasoning'
  return 'docs'
}

/* ------------------------------------------------------------------ */
/* Host projection                                                     */
/* ------------------------------------------------------------------ */

export function hostProjectionOf(input: HostSyncInput): HostProjection {
  const current = input.current
  const empty = current === null || current.empty === true
  return {
    available: current !== null && current.ok !== false,
    empty,
    projectId: text(current?.projectId),
    parentSessionId: text(current?.parentSessionId),
    phase: text(current?.phase),
    status: text(input.progress?.status) || text(current?.phase),
    error: text(input.error) || text(current?.error),
    updatedAt: text(input.progress?.updatedAt),
    progress: input.progress,
    current,
  }
}

const PROVIDER_LABELS: Record<string, string> = {
  lianjia: '链家',
  fang: '房天下',
  '58': '58',
  anjuke: '安居客',
}

export function providerLabelOf(value: string): string {
  return PROVIDER_LABELS[value] ?? value
}

function factValue(facts: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const fact = record(facts[key])
    const value = fact === null ? null : fact.value
    if (value !== null && value !== undefined && text(value) !== '') return text(value)
  }
  return ''
}

export function planFromHost(progress: Record<string, unknown> | null): PlanView | null {
  if (progress === null) return null
  const market = record(progress.market)
  const marketPlan = record(market?.plan)
  const workflowPlan = record(progress.plan)
  if (marketPlan === null && workflowPlan === null) return null
  const revision = numberOf(progress.revision) ?? 0
  const accepted = workflowPlan?.accepted === true
    || asArray(record(progress.graph)?.nodes).some((node) => {
      const item = record(node)
      return text(item?.templateMarketNodeId) === 'confirm-plan' && text(item?.state) === 'passed'
    })
  let status: PlanStatus = accepted ? 'confirmed' : workflowPlan?.ready === false ? 'draft' : 'pending'
  const planRevision = numberOf(workflowPlan?.revision)
  if (planRevision !== null && planRevision !== revision) status = 'stale'
  const marketFilters = record(marketPlan?.filters)
  const marketSubject = record(marketPlan?.subject)
  const marketBudget = record(marketPlan?.budget)
  const template = record(marketPlan?.template)
  const templateRelative = text(template?.relativePath)
  const templateName = templateRelative === '' ? text(record(workflowPlan?.template)?.fileName) || '未确定模板' : templateRelative.replace(/\\/g, '/').split('/').slice(-1)[0] ?? templateRelative
  const providers = asArray(marketPlan?.providers).map((item) => providerLabelOf(text(item))).filter(Boolean)
  const stopRules = asArray(marketPlan?.stopRules).map((item) => text(item)).filter(Boolean)
  const sources = asArray(workflowPlan?.sources).flatMap((raw) => {
    const source = record(raw)
    if (source === null) return []
    const fields = record(source.fields)
    return [{
      provider: providerLabelOf(text(source.providerId)),
      community: text(source.community),
      unitPrice: fields?.unitPrice === null || fields?.unitPrice === undefined ? '待核' : `${text(fields.unitPrice)} 元/㎡`,
      area: fields?.areaSqm === null || fields?.areaSqm === undefined ? '待核' : `${text(fields.areaSqm)} ㎡`,
      transaction: text(source.transactionType),
      evidence: text(source.evidence),
      reason: text(source.reason),
      url: text(source.detailUrl),
    }]
  })
  const basis = asArray(workflowPlan?.basis).map((item) => text(record(item)?.quote)).filter(Boolean)
  const limitations = asArray(workflowPlan?.limitations).map((item) => text(item)).filter(Boolean)
  const gaps = asArray(workflowPlan?.gaps).map((item) => text(item)).filter(Boolean)
  const subjectArea = numberOf(marketSubject?.areaSqm) ?? numberOf(workflowPlan?.subjectArea) ?? numberOf(record(progress.object)?.areaSqm)
  return {
    id: text(marketPlan?.planId) || text(workflowPlan?.digest) || `host-plan-${revision}`,
    rev: revision,
    infoVersion: revision,
    status,
    method: text(workflowPlan?.method) || '市场法',
    subjectArea,
    createdAt: text(progress.updatedAt),
    conditions: {
      channels: providers,
      areaMin: numberOf(marketFilters?.areaMin),
      areaMax: numberOf(marketFilters?.areaMax),
      targetCount: numberOf(marketBudget?.maxCandidates) ?? 0,
      stopCondition: stopRules.join('；') || '按 Host 方案中的停止条件执行。',
      extra: '',
      verifyBuilt: 'detail',
    },
    inputs: {
      address: [text(marketFilters?.city), text(marketFilters?.district), text(marketFilters?.community)].filter(Boolean).join(' '),
      usage: text(marketSubject?.useLabel),
      area: subjectArea === null ? '待核' : `${subjectArea} ㎡`,
      rights: fieldValueOf(fieldsFromHost(progress, blankDraft()), 'rights'),
      template: templateName,
    },
    sources,
    basis,
    gaps,
    limitations,
    templateName,
    templateVersion: record(workflowPlan?.template)?.verified === true ? '已校验' : '待检查',
    templateVerified: record(workflowPlan?.template)?.verified === true,
    digest: text(workflowPlan?.digest) || text(marketPlan?.digest),
    host: true,
  }
}

export function casesFromHost(progress: Record<string, unknown> | null): CaseView[] {
  if (progress === null) return []
  const market = record(progress.market)
  const marketPlan = record(market?.plan)
  const marketSubject = record(marketPlan?.subject)
  const subjectArea = numberOf(marketSubject?.areaSqm) ?? 89.5
  const selected = new Set(asArray(market?.selectedCaseIds).map((item) => text(item)))
  const marketCandidates = asArray(market?.candidates).flatMap((raw) => {
    const candidate = record(raw)
    if (candidate === null) return []
    const id = text(candidate.caseId)
    const list = record(candidate.listFacts) ?? {}
    const detail = record(candidate.detailFacts) ?? {}
    const facts = { ...list, ...detail }
    const area = numberOf(factValue(facts, ['areaSqm', 'area', 'buildingArea']))
    const unitPrice = numberOf(factValue(facts, ['unitPrice', 'price']))
    const community = factValue(facts, ['community', 'residentialArea', 'estate'])
    const floor = factValue(facts, ['floor', 'floorLevel'])
    const built = factValue(facts, ['builtYear', 'built', 'completionYear'])
    const rights = factValue(facts, ['rights', 'rightType', 'propertyRight'])
    const decoration = factValue(facts, ['decoration', 'renovation'])
    const date = factValue(facts, ['listedAt', 'listDate', 'publishDate'])
    const transaction = factValue(facts, ['transactionType', 'dealType'])
    const state = text(candidate.selectionState)
    return [{
      id,
      community: community || '房源',
      unit: '',
      addr: factValue(facts, ['address', 'location']),
      area,
      floor,
      deal: transaction === '' ? '挂牌' : transaction,
      date,
      unitPrice,
      total: null,
      distance: null,
      decoration,
      built,
      rights,
      channel: providerLabelOf(text(candidate.providerId)),
      source: text(candidate.recommendation),
      sourceUrl: text(candidate.sourceUrl),
      status: text(candidate.status) === 'eligible' ? 'eligible' : text(candidate.status) === 'nearby' ? 'nearby' : text(candidate.status) === 'rejected' ? 'rejected' : 'pending',
      selection: selected.has(id) || state === 'selected' || state === 'adopted' ? 'selected' : state === 'excluded' ? 'excluded' : 'unselected',
      missing: asArray(candidate.missingFields).map((item) => text(item)).filter(Boolean),
      recommendation: text(candidate.recommendation),
      similarities: asArray(candidate.similarities).map((item) => text(item)).filter(Boolean),
      differences: asArray(candidate.differences).map((item) => text(item)).filter(Boolean),
      score: area === null ? 60 : scoreCase({ area, distance: null, decoration, built }, subjectArea),
    } satisfies CaseView]
  })
  if (marketCandidates.length > 0) return marketCandidates
  const plan = record(progress.plan)
  return asArray(plan?.sources).flatMap((raw) => {
    const source = record(raw)
    if (source === null) return []
    const fields = record(source.fields)
    const area = numberOf(fields?.areaSqm)
    const unitPrice = numberOf(fields?.unitPrice)
    return [{
      id: text(source.providerId) || `source-${Math.random().toString(36).slice(2, 6)}`,
      community: text(source.community) || '可比来源',
      unit: '',
      addr: text(source.detailUrl),
      area,
      floor: '',
      deal: text(source.transactionType) === 'transaction' ? '成交' : '挂牌',
      date: '',
      unitPrice,
      total: null,
      distance: null,
      decoration: '',
      built: '',
      rights: '',
      channel: providerLabelOf(text(source.providerId)),
      source: text(source.evidence),
      sourceUrl: text(source.detailUrl),
      status: 'pending',
      selection: 'unselected',
      missing: [],
      recommendation: text(source.evidence),
      similarities: [],
      differences: [],
      score: area === null ? 60 : scoreCase({ area, distance: null, decoration: '', built: '' }, 89.5),
    } satisfies CaseView]
  })
}

export function fieldsFromWorkspace(state: ExperienceState): FieldView[] {
  if (state.mode === 'demo') return fieldsFromDemo(state)
  if (state.host.progress !== null) return fieldsFromHost(state.host.progress, state.draft)
  return fieldsFromDraft(state.draft)
}

/* ------------------------------------------------------------------ */
/* Workspace reducers                                                  */
/* ------------------------------------------------------------------ */

export function setView(state: ExperienceState, view: ExperienceView): ExperienceState {
  return { ...state, view }
}

export function setIntakeStage(state: ExperienceState, stage: IntakeStage): ExperienceState {
  return { ...state, view: 'intake', intakeStage: stage }
}

export function setWorkspaceStep(state: ExperienceState, step: WorkflowStep): ExperienceState {
  return { ...state, view: 'workspace', workspaceStep: step }
}

export function saveInfo(state: ExperienceState, values: Record<string, string>): ExperienceState {
  const areaRaw = text(values.area)
  if (areaRaw !== '') {
    const area = Number.parseFloat(areaRaw)
    if (!Number.isFinite(area) || area <= 0) {
      return { ...state, error: '建筑面积需要是大于 0 的数字', sheet: null }
    }
    values = { ...values, area: String(area) }
  }
  const changes: VersionChange[] = []
  const fields = state.fields.map((field) => {
    const next = Object.prototype.hasOwnProperty.call(values, field.key) ? values[field.key] ?? '' : field.value
    if (next === field.value) return field
    let tag: FieldTag = field.tag
    if (next === '') tag = '待核对'
    else if (field.tag === '材料摘取') tag = '用户更正'
    else if (field.tag === '待核对') tag = '用户填写'
    else if (field.tag === '用户更正') tag = '用户更正'
    else tag = '用户填写'
    changes.push({ key: field.key, label: field.label, from: field.value, to: next })
    return { ...field, value: next, tag }
  })
  if (changes.length === 0) {
    return { ...state, draftValues: null, notice: '没有需要保存的修改', sheet: null }
  }
  const version = Math.max(1, state.infoVersion + 1)
  const at = nowLabel()
  const history = [{
    version,
    at,
    author: '示例评估师',
    note: '用户更正信息',
    changes,
  }, ...state.history]
  const areaChanged = changes.some((change) => change.key === 'area')
  const planAffected = state.plan !== null
  const plan = planAffected && state.plan !== null ? state.plan : null
  const adopted = state.adopted.map((entry) => planAffected
    ? { ...entry, needsReview: true, checks: emptyChecks() }
    : entry)
  const draft: Draft = { ...state.draft }
  for (const change of changes) {
    if (change.key === 'area') { draft.area = change.to; draft.areaSource = change.to === '' ? 'user' : 'user-corrected' }
    if (change.key === 'usage') draft.usage = change.to
    if (change.key === 'baseDate') draft.baseDate = change.to
    if (change.key === 'location') draft.location = change.to
    if (change.key === 'method' && (change.to === '市场法' || change.to === '收益法' || change.to === '成本法')) draft.method = change.to
  }
  return {
    ...state,
    draft,
    fields,
    infoVersion: version,
    history,
    lastSaved: { version, changes },
    draftValues: null,
    plan,
    adopted,
    checks: {
      ...state.checks,
      plan: planAffected ? 'needs' : state.checks.plan,
      caseCheck: state.adopted.length > 0 && planAffected ? 'needs' : state.checks.caseCheck,
    },
    areaRangePrompt: state.areaRangePrompt || (areaChanged && text(state.fields.find((field) => field.key === 'caseRange')?.value) !== ''),
    planEditing: false,
    notice: `已保存为信息 v${version}，共 ${changes.length} 项改动${planAffected ? ' · 方案需重新推理' : ''}`,
  }
}

export function confirmInfo(state: ExperienceState): ExperienceState {
  const missing = missingRequiredFor(state)
  if (missing.length > 0) {
    return { ...state, error: `请先补全：${missing.map((field) => field.label).join('、')}`, infoOpen: true, infoTab: 'fields' }
  }
  return {
    ...state,
    checks: { ...state.checks, info: 'done' },
    workspaceStep: 'reasoning',
    error: '',
    notice: state.plan === null ? '信息已核对，可以生成任务方案' : '信息已核对，当前方案可继续复核',
  }
}

export function generatePlan(state: ExperienceState): ExperienceState {
  const areaValue = Number.parseFloat(text(state.draft.area) || state.fields.find((field) => field.key === 'area')?.value || '')
  if (!Number.isFinite(areaValue) || areaValue <= 0) {
    return { ...state, error: '请先填写有效的建筑面积', workspaceStep: 'check' }
  }
  if (state.mode === 'host') {
    return {
      ...state,
      error: '',
      notice: '方案由估值工作流生成。请先完成信息核对并通过「刷新进度」读取最新方案。',
      workspaceStep: 'reasoning',
    }
  }
  const plan = buildPlan(state, state.plan, areaValue)
  return {
    ...state,
    plan,
    planHistory: state.planHistory,
    candidates: [],
    candidateAt: '',
    candidatePlanRev: 0,
    adopted: [],
    confirmAck: false,
    planEditing: false,
    checks: { ...state.checks, plan: 'todo', cases: 'todo', caseCheck: 'todo' },
    workspaceStep: 'reasoning',
    notice: `已按信息 v${state.infoVersion} 生成任务方案 r${plan.rev}`,
  }
}

export function savePlanConditions(state: ExperienceState, conditions: PlanConditions): ExperienceState {
  if (state.plan === null) return state
  const status = planStatusOf(state)
  if (status === 'stale' || status === 'confirmed') {
    return { ...state, error: status === 'stale' ? '方案已过期，请先重新推理' : '已确认方案不能直接调整' }
  }
  if (conditions.channels.length === 0) return { ...state, error: '至少选择一个检索渠道' }
  if (conditions.areaMin === null || conditions.areaMax === null || conditions.areaMin <= 0 || conditions.areaMax <= conditions.areaMin) {
    return { ...state, error: '面积范围需要是有效区间，且下限小于上限' }
  }
  if (!Number.isFinite(conditions.targetCount) || conditions.targetCount < 1 || conditions.targetCount > 12) {
    return { ...state, error: '目标候选数量需要在 1–12 之间' }
  }
  const plan: PlanView = {
    ...state.plan,
    rev: state.plan.rev + 1,
    conditions,
    status: 'draft',
    createdAt: nowLabel(),
  }
  return {
    ...state,
    plan,
    candidates: [],
    candidateAt: '',
    candidatePlanRev: 0,
    confirmAck: false,
    planEditing: false,
    checks: { ...state.checks, plan: 'todo', cases: 'todo' },
    notice: `已保存为方案草案 r${plan.rev}，手设条件会保留`,
  }
}

export function submitPlan(state: ExperienceState): ExperienceState {
  if (state.plan === null) return state
  if (planStatusOf(state) === 'stale') return { ...state, error: '方案已过期，请先重新推理' }
  if (state.mode === 'host') {
    return { ...state, notice: '方案由估值工作流确认，请使用「确认方案」提交审批。', workspaceStep: 'confirm' }
  }
  return {
    ...state,
    plan: { ...state.plan, status: 'pending' },
    confirmAck: false,
    planEditing: false,
    checks: { ...state.checks, plan: 'todo' },
    notice: '方案已提交为待确认',
  }
}

export function toggleConfirmAck(state: ExperienceState): ExperienceState {
  return { ...state, confirmAck: !state.confirmAck }
}

export function confirmPlan(state: ExperienceState): ExperienceState {
  if (state.plan === null) return state
  const status = planStatusOf(state)
  if (status !== 'pending') {
    return { ...state, error: status === 'stale' ? '方案已过期，需要重新推理' : '当前方案还不能确认' }
  }
  if (!state.confirmAck) return { ...state, error: '请先勾选复核确认' }
  const plan: PlanView = { ...state.plan, status: 'confirmed' }
  return {
    ...state,
    plan,
    confirmAck: false,
    checks: { ...state.checks, plan: 'done', cases: state.candidates.length > 0 ? 'done' : 'todo' },
    planHistory: [...state.planHistory, {
      rev: plan.rev,
      infoVersion: plan.infoVersion,
      targetCount: plan.conditions.targetCount,
      at: nowLabel(),
    }],
    workspaceStep: 'cases',
    notice: `方案 r${plan.rev} 已确认，进入案例获取；检索尚未在本页自动开始`,
  }
}

export function retrieveCases(state: ExperienceState): ExperienceState {
  if (state.plan === null) return state
  if (planStatusOf(state) !== 'confirmed') {
    return { ...state, error: '方案确认后才能获取案例' }
  }
  if (state.mode === 'host') {
    return {
      ...state,
      notice: '估值工作流会在方案确认后执行检索。请用「刷新进度」读取真实候选。',
      checks: { ...state.checks, cases: 'needs' },
    }
  }
  const cases = matchingDemoCases(state.plan)
  const adopted = state.adopted.map((entry) => entry.matchedRev !== state.plan!.rev
    ? { ...entry, matchedRev: state.plan!.rev, needsReview: true, checks: emptyChecks() }
    : entry)
  return {
    ...state,
    candidates: cases,
    candidateAt: nowLabel(),
    candidatePlanRev: state.plan.rev,
    adopted,
    checks: { ...state.checks, cases: 'done', caseCheck: adopted.length > 0 ? 'needs' : state.checks.caseCheck },
    notice: `已按方案 r${state.plan.rev} 获取 ${cases.length} 个示例挂牌候选（目标 ${state.plan.conditions.targetCount} 个）`,
  }
}

export function toggleAdopt(state: ExperienceState, caseId: string): ExperienceState {
  if (!planValidConfirmed(state)) return { ...state, error: '方案确认后才能采用案例' }
  const existing = state.adopted.find((entry) => entry.id === caseId)
  let adopted: AdoptedCase[]
  if (existing !== undefined) {
    adopted = state.adopted.filter((entry) => entry.id !== caseId)
  } else {
    if (state.adopted.length >= 4) return { ...state, error: '最多采用 4 个案例，请先取消一个' }
    adopted = [...state.adopted, {
      id: caseId,
      matchedRev: state.plan?.rev ?? 0,
      needsReview: false,
      note: '',
      checks: emptyChecks(),
    }]
  }
  return {
    ...state,
    adopted,
    candidates: state.candidates.map((c) => c.id === caseId
      ? { ...c, selection: existing === undefined ? 'selected' : 'unselected' }
      : c),
    checks: { ...state.checks, caseCheck: adopted.length > 0 ? 'needs' : 'todo' },
    notice: existing === undefined ? '已加入采用案例，请在案例核对中逐项复核' : '已取消采用该案例',
  }
}

export function toggleCaseCheck(state: ExperienceState, caseId: string, key: string): ExperienceState {
  if (!planValidConfirmed(state)) return { ...state, error: '方案确认后才能核对采用案例' }
  const adopted = state.adopted.map((entry) => {
    if (entry.id !== caseId) return entry
    const checks = { ...entry.checks, [key]: !entry.checks[key] }
    const all = CHECK_KEYS.every((item) => checks[item] === true)
    return { ...entry, checks, needsReview: all ? false : entry.needsReview }
  })
  return {
    ...state,
    adopted,
    checks: { ...state.checks, caseCheck: state.checks.caseCheck === 'done' ? 'needs' : state.checks.caseCheck },
  }
}

export function saveCaseNote(state: ExperienceState, caseId: string, note: string): ExperienceState {
  return {
    ...state,
    adopted: state.adopted.map((entry) => entry.id === caseId ? { ...entry, note } : entry),
    sheet: null,
    notice: '复核说明已保存',
  }
}

export function removeAdopted(state: ExperienceState, caseId: string): ExperienceState {
  const adopted = state.adopted.filter((entry) => entry.id !== caseId)
  return {
    ...state,
    adopted,
    candidates: state.candidates.map((c) => c.id === caseId ? { ...c, selection: 'unselected' } : c),
    checks: { ...state.checks, caseCheck: adopted.length > 0 ? 'needs' : 'todo' },
    notice: '已取消采用该案例',
  }
}

export function completeCaseCheck(state: ExperienceState): ExperienceState {
  if (!planValidConfirmed(state)) return { ...state, error: '方案无效，暂时不能完成核对' }
  if (state.adopted.length === 0) return { ...state, error: '还没有采用案例' }
  const allChecked = state.adopted.every((entry) => CHECK_KEYS.every((key) => entry.checks[key] === true))
  if (!allChecked) return { ...state, error: '还有核对项未完成' }
  if (state.adopted.some((entry) => entry.needsReview)) return { ...state, error: '还有案例标记为需复核' }
  return {
    ...state,
    checks: { ...state.checks, caseCheck: 'done' },
    notice: '案例核对已完成，可导出采用清单',
  }
}

export function dismissAreaRange(state: ExperienceState): ExperienceState {
  return { ...state, areaRangePrompt: false }
}

/* ------------------------------------------------------------------ */
/* CSV export                                                         */
/* ------------------------------------------------------------------ */

export function adoptedCsv(state: ExperienceState): string {
  const header = ['案例编号', '小区', '房号', '坐落', '渠道', '建筑面积(㎡)', '楼层', '资料类型', '挂牌日期', '挂牌单价(元/㎡)', '挂牌总价(万元)', '距离(km)', '建成年份', '采用状态', '复核说明']
  const rows = state.adopted.map((entry) => {
    const c = state.candidates.find((item) => item.id === entry.id)
    if (c === undefined) return null
    return [
      c.id, c.community, c.unit, c.addr, c.channel, c.area ?? '', c.floor || '待核', c.deal, c.date,
      c.unitPrice ?? '', c.total ?? '', c.distance ?? '', c.built || '待核', caseStatusLabel(state, entry), entry.note,
    ]
  }).filter((row): row is Array<string | number> => row !== null)
  const lines: Array<Array<string | number>> = [
    ['项目', fullLocation(state.draft) || state.draft.projectName || '未命名项目'],
    ['本轮任务', '案例获取与核对（仅示例挂牌）'],
    ['建筑面积', text(state.draft.area)],
    ['信息版本', `v${state.infoVersion}`],
    ['方案版本', state.plan === null ? '' : `r${state.plan.rev}`],
    ['采用案例数', state.adopted.length],
    ['说明', '示例挂牌不作为成交依据；本清单不含金额结论，不构成评估报告。'],
    [],
    header,
  ]
  return lines.concat(rows).map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n')
}

/* ------------------------------------------------------------------ */
/* Derived experience for host sync                                   */
/* ------------------------------------------------------------------ */

export function syncHost(state: ExperienceState, input: HostSyncInput): ExperienceState {
  const host = hostProjectionOf(input)
  if (state.mode === 'demo') return { ...state, host }
  const progress = host.progress
  const next: ExperienceState = { ...state, host }
  if (!host.available || host.empty) {
    return {
      ...next,
      mode: 'empty',
      fields: state.view === 'workspace' ? fieldsFromDraft(state.draft) : state.fields,
      plan: null,
      candidates: [],
      adopted: [],
    }
  }
  const fields = fieldsFromHost(progress, state.draft)
  const infoVersion = numberOf(progress?.revision) ?? state.infoVersion
  const plan = planFromHost(progress)
  const candidates = casesFromHost(progress)
  const selected = new Set(candidates.filter((c) => c.selection === 'selected').map((c) => c.id))
  const previous = new Map(state.adopted.map((entry) => [entry.id, entry]))
  const adopted = candidates.filter((c) => selected.has(c.id)).map((c) => {
    const entry = previous.get(c.id)
    return entry ?? { id: c.id, matchedRev: plan?.rev ?? 0, needsReview: false, note: '', checks: emptyChecks() }
  })
  const autoOpen = !state.openedHost
    && host.projectId !== ''
    && state.view === 'intake'
    && state.draft.category === ''
    && state.materials.length === 0
  return {
    ...next,
    mode: 'host',
    openedHost: true,
    ...(autoOpen ? { view: 'workspace' as const } : {}),
    fields,
    infoVersion,
    plan,
    candidates,
    adopted,
    candidatePlanRev: plan?.rev ?? 0,
    workspaceStep: state.view === 'workspace' ? state.workspaceStep : workspaceStepOfHost(progress),
    checks: {
      docs: state.materials.some((source) => source.files.length > 0) ? 'done' : 'todo',
      info: missingRequiredFor({ ...state, fields, mode: 'host' }).length > 0
        ? 'needs'
        : state.checks.info === 'done' ? 'done' : 'needs',
      plan: plan === null ? 'todo' : plan.status === 'confirmed' ? 'done' : 'needs',
      cases: candidates.length > 0 ? 'done' : state.checks.cases,
      caseCheck: adopted.length > 0 ? state.checks.caseCheck : 'todo',
    },
  }
}

/* ------------------------------------------------------------------ */
/* Materials sync                                                     */
/* ------------------------------------------------------------------ */

function basenameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? path
}

export function materialsFromEvaluation(
  evaluation: ValuationPageState,
  demo: MaterialSource[],
): MaterialSource[] {
  const sources: MaterialSource[] = []
  for (const root of evaluation.selection) {
    const rows = evaluation.fileRows.filter((row) => row.parentPath === root)
    const entry = evaluation.files.find((file) => file.path === root)
    const kind: MaterialSource['kind'] = rows.length > 1 || (entry?.fileCount ?? 0) > 1 ? 'folder' : 'files'
    const relativeOf = (path: string): string => {
      const normalized = path.replace(/\\/g, '/')
      const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
      const rel = normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : rowNameOf(path)
      return `${basenameOf(root)}/${rel}`
    }
    const rowNameOf = (path: string): string => path.replace(/\\/g, '/').split('/').slice(-1)[0] ?? path
    const files: MaterialFile[] = rows.length > 0
      ? rows.map((row, index) => ({
        id: `${root}#${index}`,
        path: row.path,
        relPath: kind === 'folder' ? relativeOf(row.path) : row.name,
        name: row.name,
        size: row.sizeBytes,
        mtime: 0,
        ext: extOf(row.name),
        excluded: row.state === 'excluded',
        demoKey: '',
        pages: null,
        fields: [],
        note: '仅登记文件路径，尚未接真实读取',
      }))
      : (entry === undefined ? [] : [{
        id: root,
        path: root,
        relPath: root,
        name: entry.name,
        size: entry.sizeBytes,
        mtime: 0,
        ext: extOf(entry.name),
        excluded: false,
        demoKey: '',
        pages: null,
        fields: [],
        note: evaluation.scanState === 'ready' ? '仅登记文件路径，尚未接真实读取' : '正在读取清单',
      }])
    sources.push({
      id: root,
      label: basenameOf(root),
      kind,
      at: '',
      files,
    })
  }
  return [...demo, ...sources]
}
