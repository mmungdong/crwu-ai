import { createHash } from 'node:crypto'
import { text } from '../../../../shared/utils/value.ts'
import { canonicalListingUrl } from './candidates.ts'
import { budgetFromJson, type MarketBudget } from './budget.ts'
import { isSafeCityCode, type BusinessCityResolution } from './city.ts'

/**
 * Durable list snapshots (protocol 40).
 *
 * One scope = Host project/plan + sample group + round. Within a scope, each exact provider
 * page query gets its own successful-page snapshot; the scope ledger keeps the cumulative
 * union of rows so a second identical call can replay facts without re-navigating.
 */

/** Scope of one list ledger (project/plan + group + round + normalized business city). */
export interface ListScope {
  projectId: string
  planId: string
  group: string
  round: number
  /** Business city the scope belongs to; different cities must never share a ledger. */
  city?: string
}

/** Identity of one exact provider page query inside a scope. */
export interface PageQuery {
  providerId: string
  /** Stable task id derived from project/plan/provider/page/keyword/city. */
  taskId: string
}

function safeSegment(value: string): string {
  return text(value).replace(/[^0-9A-Za-z._\u4e00-\u9fff-]/g, '_').slice(0, 64)
}

function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)
}

/** File segment for a scope; stable for the same project/plan/group/round/city. */
export function scopeKeyOf(scope: ListScope): string {
  const city = text(scope.city)
  const raw = [scope.projectId, scope.planId, scope.group, String(scope.round), city].join('|')
  return `${safeSegment(scope.projectId)}-${safeSegment(scope.planId)}-${safeSegment(scope.group)}-`
    + `${String(scope.round)}-${safeSegment(city)}-${digestOf(raw)}`
}

/** File segment for one exact page query inside a scope. */
export function pageKeyOf(query: PageQuery): string {
  return `${safeSegment(query.providerId)}-${digestOf(query.taskId)}`
}

/** Persisted schema versions. */
export const LIST_PAGE_SCHEMA = 'crwu.valuation.list-page.v1'
export const LIST_LEDGER_SCHEMA = 'crwu.valuation.list-ledger.v1'

/** One successful list page (rows are serialized case records). */
export interface ListPageSnapshot {
  schemaVersion: typeof LIST_PAGE_SCHEMA
  providerId: string
  /** Stable task id the snapshot belongs to (identity guard on replay). */
  taskId: string
  pageNo: number
  url: string
  capturedAt: string
  evidenceFile: string
  evidenceDigest: string
  /** Serialized case rows for this page (complete page only). */
  rows: unknown[]
}

/** Cumulative rows for one scope; the canonical ledger also owns that scope's budget. */
export interface ListLedger {
  schemaVersion: typeof LIST_LEDGER_SCHEMA
  scope: ListScope
  city: string
  updatedAt: string
  rows: unknown[]
  budget?: MarketBudget
  /** Canonical successful page snapshots by taskId; page JSON files are derived mirrors. */
  pages?: Record<string, ListPageSnapshot>
  /** Verified business-city resolution facts, reusable without re-running the city lookup. */
  cityResolution?: BusinessCityResolution
}

function objectOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function scopeOf(value: unknown): ListScope | null {
  const raw = objectOf(value)
  if (raw === null) return null
  const round = typeof raw.round === 'number' && Number.isFinite(raw.round) ? Math.max(1, Math.trunc(raw.round)) : 1
  return {
    projectId: text(raw.projectId), planId: text(raw.planId),
    group: text(raw.group), round, city: text(raw.city),
  }
}

/** Strict serialized SearchCase guard: reject malformed persisted rows, never reshape them. */
function isSerializedRow(value: unknown): boolean {
  const raw = objectOf(value)
  if (raw === null) return false
  if (canonicalListingUrl(text(raw.url)) === '') return false
  for (const key of ['source', 'title', 'evidence', 'screenshot', 'screenshot_digest', 'screenshot_captured_at']) {
    if (typeof raw[key] !== 'string') return false
  }
  for (const key of ['building_area', 'unit_price']) {
    const field = raw[key]
    // Cache stores observations, not adoptions: 0 / negative are valid serialized numbers.
    if (field !== null && !(typeof field === 'number' && Number.isFinite(field))) return false
  }
  return Array.isArray(raw.notes) && (raw.notes as unknown[]).every((note) => typeof note === 'string')
}

/** Parse a page snapshot; shape/identity mismatch returns null. */
export function parseListPageSnapshot(value: unknown, expect: { providerId: string; taskId: string }): ListPageSnapshot | null {
  const raw = objectOf(value)
  if (raw === null || raw.schemaVersion !== LIST_PAGE_SCHEMA) return null
  if (text(raw.providerId) !== expect.providerId) return null
  if (text(raw.taskId) !== expect.taskId) return null
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) return null
  if (!(raw.rows as unknown[]).every(isSerializedRow)) return null
  if (text(raw.evidenceFile) === '' || text(raw.evidenceDigest) === '') return null
  return {
    schemaVersion: LIST_PAGE_SCHEMA,
    providerId: text(raw.providerId),
    taskId: text(raw.taskId),
    pageNo: typeof raw.pageNo === 'number' ? raw.pageNo : 0,
    url: text(raw.url),
    capturedAt: text(raw.capturedAt),
    evidenceFile: text(raw.evidenceFile),
    evidenceDigest: text(raw.evidenceDigest),
    rows: [...raw.rows],
  }
}

/** Parse a ledger `pages` map strictly; any invalid entry or key mismatch returns null. */
function pagesOf(value: unknown): Record<string, ListPageSnapshot> | null {
  const raw = objectOf(value)
  if (raw === null) return null
  const out: Record<string, ListPageSnapshot> = {}
  for (const [key, item] of Object.entries(raw)) {
    const entry = objectOf(item)
    if (entry === null) return null
    const parsed = parseListPageSnapshot(entry, {
      providerId: text(entry.providerId), taskId: text(entry.taskId),
    })
    if (parsed === null || text(key) !== parsed.taskId) return null
    out[text(key)] = parsed
  }
  return out
}

/** Parse verified city-resolution facts; only `resolved`/`ok` facts are reusable. */
function cityResolutionOf(value: unknown): BusinessCityResolution | undefined {
  const raw = objectOf(value)
  if (raw === null) return undefined
  const status = text(raw.status)
  if (status !== 'resolved' || raw.ok !== true) return undefined
  const code = text(raw.code)
  if (!isSafeCityCode(code)) return undefined
  const via = text(raw.via)
  if (via !== 'site-key' && via !== 'published-list') return undefined
  const candidates = Array.isArray(raw.candidates)
    ? (raw.candidates as unknown[]).map((item) => objectOf(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({ name: text(item.name), key: text(item.key) }))
    : []
  return {
    status: 'resolved', ok: true, input: text(raw.input), code, via,
    reason: text(raw.reason), candidates, page: text(raw.page),
  }
}

/** Parse a scope ledger; shape mismatch returns null. */
export function parseListLedger(value: unknown, expect: ListScope): ListLedger | null {
  const raw = objectOf(value)
  if (raw === null || raw.schemaVersion !== LIST_LEDGER_SCHEMA) return null
  const scope = scopeOf(raw.scope)
  if (scope === null || scopeKeyOf(scope) !== scopeKeyOf(expect)) return null
  const rowsRaw = raw.rows === undefined ? [] : raw.rows
  if (!Array.isArray(rowsRaw) || !(rowsRaw as unknown[]).every(isSerializedRow)) return null
  let budget: MarketBudget | undefined
  if (raw.budget !== undefined) {
    const parsedBudget = budgetFromJson(raw.budget)
    if (parsedBudget === null) return null
    budget = parsedBudget
  }
  let pages: Record<string, ListPageSnapshot> | undefined
  if (raw.pages !== undefined) {
    const parsedPages = pagesOf(raw.pages)
    if (parsedPages === null) return null
    pages = parsedPages
  }
  let cityResolution: BusinessCityResolution | undefined
  if (raw.cityResolution !== undefined) {
    const parsedCity = cityResolutionOf(raw.cityResolution)
    if (parsedCity === undefined) return null
    if (text(parsedCity.input) !== text(expect.city)) return null
    cityResolution = parsedCity
  }
  return {
    schemaVersion: LIST_LEDGER_SCHEMA,
    scope,
    city: text(raw.city),
    updatedAt: text(raw.updatedAt),
    rows: [...(rowsRaw as unknown[])],
    ...(budget === undefined ? {} : { budget }),
    ...(pages === undefined ? {} : { pages }),
    ...(cityResolution === undefined ? {} : { cityResolution }),
  }
}

/**
 * Cumulative union by canonical URL. The first occurrence wins (stable); later rows with a
 * different canonical URL are appended even when their weak facts match.
 */
export function unionRows(
  existing: readonly unknown[],
  incoming: readonly unknown[],
  urlOf: (row: unknown) => string,
): unknown[] {
  const out: unknown[] = [...existing]
  const seen = new Set<string>()
  for (const row of out) {
    const canonical = canonicalListingUrl(urlOf(row))
    if (canonical !== '' && !seen.has(canonical)) seen.add(canonical)
  }
  for (const row of incoming) {
    const canonical = canonicalListingUrl(urlOf(row))
    if (canonical !== '' && seen.has(canonical)) continue
    if (canonical !== '') seen.add(canonical)
    out.push(row)
  }
  return out
}
