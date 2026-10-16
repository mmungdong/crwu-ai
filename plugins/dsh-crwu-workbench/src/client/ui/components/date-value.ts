/**
 * Pure date-value helpers for the shared UI.
 *
 * No Date/timezone conversion happens here: a `YYYY-MM-DD` string is parsed field by field,
 * so the same input always produces the same output on every system.
 */

export interface DateParts {
  year: number
  month: number
  day: number
}

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30
  return 31
}

function validYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1 && year <= 9999
}

function validParts(parts: unknown): parts is DateParts {
  const candidate = parts as DateParts | null
  return candidate !== null
    && typeof candidate === 'object'
    && validYear(candidate.year)
    && Number.isInteger(candidate.month) && candidate.month >= 1 && candidate.month <= 12
    && Number.isInteger(candidate.day) && candidate.day >= 1
    && candidate.day <= daysInMonth(candidate.year, candidate.month)
}

/**
 * Strict padded `YYYY-MM-DD`, or null for anything else (whitespace, ISO datetimes,
 * non-strings, unknown dates). Never rolls a date over into the next month.
 */
export function parseDateValue(value: unknown): DateParts | null {
  if (typeof value !== 'string') return null
  const matched = SHAPE.exec(value)
  if (matched === null) return null
  const parts = { year: Number(matched[1]), month: Number(matched[2]), day: Number(matched[3]) }
  return validParts(parts) ? parts : null
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** Format valid parts; invalid parts throw RangeError instead of producing a rolled date. */
export function formatDateValue(parts: DateParts): string {
  if (!validParts(parts)) throw new RangeError('date parts are not a real calendar date')
  return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`
}

/** Move whole months, clamping the day to the target month end. */
export function shiftMonth(value: string, delta: number): string {
  const parts = parseDateValue(value)
  if (parts === null) throw new RangeError(`invalid date: ${String(value)}`)
  if (!Number.isInteger(delta)) throw new RangeError('month delta must be an integer')
  const total = parts.year * 12 + (parts.month - 1) + delta
  const year = Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12 + 1
  if (!validYear(year)) throw new RangeError('resulting year is out of range')
  return formatDateValue({ year, month, day: Math.min(parts.day, daysInMonth(year, month)) })
}

/** Move whole years, clamping a leap day to the target month end. */
export function shiftYear(value: string, delta: number): string {
  const parts = parseDateValue(value)
  if (parts === null) throw new RangeError(`invalid date: ${String(value)}`)
  if (!Number.isInteger(delta)) throw new RangeError('year delta must be an integer')
  const year = parts.year + delta
  if (!validYear(year)) throw new RangeError('resulting year is out of range')
  return formatDateValue({ year, month: parts.month, day: Math.min(parts.day, daysInMonth(year, parts.month)) })
}

/** Add whole days to valid parts without any timezone conversion. */
export function addDays(parts: DateParts, delta: number): DateParts {
  if (!validParts(parts) || !Number.isInteger(delta)) throw new RangeError('invalid date parts or day delta')
  let year = parts.year
  let month = parts.month
  let day = parts.day + delta
  while (day < 1) {
    month -= 1
    if (month < 1) { month = 12; year -= 1 }
    day += daysInMonth(year, month)
  }
  while (day > daysInMonth(year, month)) {
    day -= daysInMonth(year, month)
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  if (!validYear(year)) throw new RangeError('resulting year is out of range')
  return { year, month, day }
}

/** ISO weekday for a Gregorian date, 0 = Sunday (Sakamoto's algorithm). */
export function weekdayOf(year: number, month: number, day: number): number {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const adjusted = month < 3 ? year - 1 : year
  return (adjusted + Math.floor(adjusted / 4) - Math.floor(adjusted / 100)
    + Math.floor(adjusted / 400) + offsets[month - 1] + day) % 7
}
