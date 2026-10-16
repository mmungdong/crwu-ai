import * as React from 'react'
import { zhCN } from '../../locales/zh-CN.ts'
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  CloseIcon,
} from '../icons.tsx'
import {
  addDays,
  daysInMonth,
  formatDateValue,
  parseDateValue,
  shiftMonth,
  shiftYear,
  weekdayOf,
  type DateParts,
} from './date-value.ts'
import { useInstanceId } from './ids.ts'
import { Popover, usePopover, type PopoverAnchorNode, type PopoverCloseReason, type PopoverContentNode } from './Popover.tsx'
import { POPOVER_CLOSE_MS, POPOVER_WIDTH } from './popover-model.ts'
import { selectRegistry } from './select-model.ts'

export const CRWU_DATE_PICKER_CLASSES = {
  root: 'crwu-ui-datepicker',
  control: 'crwu-ui-datepicker-control',
  input: 'crwu-ui-datepicker-input',
  trigger: 'crwu-ui-datepicker-trigger',
  clear: 'crwu-ui-datepicker-clear',
  dialog: 'crwu-ui-datepicker-dialog',
  dialogOut: 'crwu-ui-datepicker-dialog-out',
  head: 'crwu-ui-datepicker-head',
  title: 'crwu-ui-datepicker-title',
  nav: 'crwu-ui-datepicker-nav',
  viewGrid: 'crwu-ui-datepicker-view-grid',
  viewOption: 'crwu-ui-datepicker-view-option',
  viewOptionOn: 'crwu-ui-datepicker-view-option-on',
  grid: 'crwu-ui-datepicker-grid',
  weekRow: 'crwu-ui-datepicker-week',
  weekday: 'crwu-ui-datepicker-weekday',
  cell: 'crwu-ui-datepicker-cell',
  blank: 'crwu-ui-datepicker-blank',
  day: 'crwu-ui-datepicker-day',
  daySelected: 'crwu-ui-datepicker-day-selected',
  dayToday: 'crwu-ui-datepicker-day-today',
  footer: 'crwu-ui-datepicker-footer',
  action: 'crwu-ui-datepicker-action',
  error: 'crwu-ui-datepicker-error',
} as const

export interface DatePickerProps {
  value: string
  onChange: (value: string) => void
  /** Validity transitions while editing; empty optional dates are valid. */
  onValidityChange?: (valid: boolean) => void
  id?: string
  describedBy?: string
  invalid?: boolean
  disabled?: boolean
  readOnly?: boolean
  min?: string
  max?: string
  placeholder?: string
  className?: string
}

type DateViewMode = 'days' | 'months' | 'years'

function classNames(...all: Array<string | false | undefined>): string {
  return all.filter((one): one is string => typeof one === 'string' && one !== '').join(' ')
}

function prefersReducedMotion(): boolean {
  const media = (globalThis as { matchMedia?: (query: string) => { matches?: boolean } }).matchMedia
  if (typeof media !== 'function') return false
  try { return media.call(globalThis, '(prefers-reduced-motion: reduce)').matches === true } catch (error) { void error; return false }
}

function todayParts(): DateParts {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
}

const MONTHS = Array.from({ length: 12 }, (_value, index) => index + 1)
const WEEKDAYS = Array.from(zhCN.datePickerWeekdays)

/** Controlled date picker: one bordered text+calendar control over a shared popup. */
export function DatePicker(props: DatePickerProps): React.ReactElement {
  const readOnly = props.readOnly === true
  const disabled = props.disabled === true
  const canEdit = !readOnly && !disabled
  const instanceId = useInstanceId('crwu-datepicker')
  const id = props.id ?? instanceId
  const errorId = `${id}-date-error`
  const dialogId = `${id}-dialog`
  const registryKey = `datepicker:${instanceId}`

  const [draft, setDraft] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [closing, setClosing] = React.useState(false)
  const initial = parseDateValue(props.value) ?? todayParts()
  const [view, setView] = React.useState({ year: initial.year, month: initial.month })
  const [viewMode, setViewMode] = React.useState<DateViewMode>('days')
  const [focusIso, setFocusIso] = React.useState<string | null>(null)

  const controlRef = React.useRef<PopoverAnchorNode | null>(null)
  const triggerRef = React.useRef<PopoverAnchorNode | null>(null)
  const dialogRef = React.useRef<PopoverContentNode | null>(null)
  const contentHeightRef = React.useRef(320)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const dayRefs = React.useRef(new Map<string, { focus?: () => void }>())
  const lastValidityRef = React.useRef<boolean | null>(null)
  const lastValueRef = React.useRef(props.value)

  const today = todayParts()
  const todayIso = formatDateValue(today)
  const selectedIso = props.value !== '' && parseDateValue(props.value) !== null ? props.value : ''

  // Synchronize an external value change without leaving a stale draft.
  let activeDraft = draft
  if (lastValueRef.current !== props.value) {
    lastValueRef.current = props.value
    activeDraft = null
    if (draft !== null) setDraft(null)
    if (error !== '') setError('')
  }
  const display = activeDraft ?? props.value
  const invalidState = props.invalid === true || error !== ''
  const describedBy = [props.describedBy, error !== '' ? errorId : null]
    .filter((one): one is string => typeof one === 'string' && one !== '')
    .join(' ')

  const rangeErrorOf = (iso: string): string => {
    const min = props.min === undefined || props.min === '' ? null : parseDateValue(props.min)
    const max = props.max === undefined || props.max === '' ? null : parseDateValue(props.max)
    if (min !== null && iso < formatDateValue(min)) return zhCN.datePickerOutOfRange
    if (max !== null && iso > formatDateValue(max)) return zhCN.datePickerOutOfRange
    return ''
  }

  const isDisabledIso = (iso: string): boolean => {
    if (parseDateValue(iso) === null) return true
    return rangeErrorOf(iso) !== ''
  }

  const validateText = (raw: string): { valid: boolean; iso: string | null; error: string } => {
    const text = raw.trim()
    if (text === '') return { valid: true, iso: '', error: '' }
    const parsed = parseDateValue(text)
    if (parsed === null) return { valid: false, iso: null, error: zhCN.datePickerInvalid }
    const iso = formatDateValue(parsed)
    const range = rangeErrorOf(iso)
    if (range !== '') return { valid: false, iso, error: range }
    return { valid: true, iso, error: '' }
  }

  const notifyValidity = (valid: boolean): void => {
    if (lastValidityRef.current === valid) return
    lastValidityRef.current = valid
    props.onValidityChange?.(valid)
  }

  const boundIso = (value: string | undefined): string | null => {
    if (value === undefined || value === '') return null
    const parsed = parseDateValue(value)
    return parsed === null ? null : formatDateValue(parsed)
  }
  const minIso = boundIso(props.min)
  const maxIso = boundIso(props.max)

  /** Clamp an ISO date directly into the parsed optional range (no day scanning). */
  const clampToRange = (iso: string): string | null => {
    if (parseDateValue(iso) === null) return null
    let next = iso
    if (minIso !== null && next < minIso) next = minIso
    if (maxIso !== null && next > maxIso) next = maxIso
    return parseDateValue(next) === null ? null : next
  }

  /** Keep the preferred day when it fits the target month, else clamp to the month end. */
  const focusInMonth = (preferredIso: string, year: number, month: number): string => {
    const parts = parseDateValue(preferredIso)
    const day = parts !== null && parts.year === year && parts.month === month
      ? parts.day
      : Math.min(parts?.day ?? 1, daysInMonth(year, month))
    return formatDateValue({ year, month, day })
  }

  const safeShiftMonth = (iso: string, delta: number): string | null => {
    try { return shiftMonth(iso, delta) } catch (thrown) { void thrown; return null }
  }
  const safeShiftYear = (iso: string, delta: number): string | null => {
    try { return shiftYear(iso, delta) } catch (thrown) { void thrown; return null }
  }

  const closeCalendar = React.useCallback((reason: PopoverCloseReason | 'commit', immediate = false): void => {
    selectRegistry.release(registryKey)
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null }
    if (immediate || prefersReducedMotion()) {
      setClosing(false)
      setOpen(false)
    } else {
      setClosing(true)
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null
        setClosing(false)
        setOpen(false)
      }, POPOVER_CLOSE_MS)
    }
    if (reason === 'escape' || reason === 'commit') triggerRef.current?.focus?.()
  }, [registryKey])

  const requestClose = React.useCallback((reason: PopoverCloseReason): void => { closeCalendar(reason) }, [closeCalendar])
  const { box, frame, place } = usePopover({
    open,
    anchorRef: controlRef,
    triggerRef,
    listRef: dialogRef,
    contentHeightRef,
    insideSelector: `[data-crwu-datepicker-instance="${instanceId}"], [data-crwu-datepicker-dialog="${instanceId}"]`,
    onRequestClose: requestClose,
    desiredWidth: POPOVER_WIDTH,
    closeOnFocusLeave: true,
  })

  React.useEffect(() => () => {
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null }
    selectRegistry.release(registryKey)
  }, [registryKey])

  React.useEffect(() => {
    if (!canEdit && open) closeCalendar('owner', true)
  }, [canEdit, open, closeCalendar])

  // External value resets restore the reported validity (empty is valid).
  React.useEffect(() => {
    if (!canEdit) return
    const outcome = validateText(props.value)
    if (lastValidityRef.current !== outcome.valid) {
      lastValidityRef.current = outcome.valid
      props.onValidityChange?.(outcome.valid)
    }
  }, [props.value])

  // A range change re-evaluates the current draft validity; it never clears an invalid draft.
  React.useEffect(() => {
    if (!canEdit) return
    const outcome = validateText(draft ?? props.value)
    if (lastValidityRef.current !== outcome.valid) {
      lastValidityRef.current = outcome.valid
      props.onValidityChange?.(outcome.valid)
    }
  }, [props.min, props.max])

  React.useEffect(() => {
    if (!open || closing || viewMode !== 'days') return
    const preferred = focusIso ?? (selectedIso !== '' ? selectedIso : todayIso)
    const node = dayRefs.current.get(preferred)
    if (node?.focus !== undefined) node.focus()
  }, [open, closing, viewMode, focusIso, selectedIso, todayIso])

  const openCalendar = (): void => {
    if (!canEdit) return
    const parsed = parseDateValue(props.value)
    const preferred = parsed !== null ? props.value : todayIso
    const focus = clampToRange(preferred) ?? preferred
    const focusParts = parseDateValue(focus) ?? todayParts()
    setView({ year: focusParts.year, month: focusParts.month })
    setFocusIso(focus)
    setViewMode('days')
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null }
    setClosing(false)
    setOpen(true)
    selectRegistry.claim(registryKey, () => { closeCalendar('owner', true) })
    place()
  }

  const toggleCalendar = (): void => {
    if (open) closeCalendar('owner')
    else openCalendar()
  }

  const commitDate = (iso: string): void => {
    if (!canEdit) return
    if (isDisabledIso(iso)) {
      const range = rangeErrorOf(iso)
      if (range !== '') setError(range)
      return
    }
    setDraft(null)
    setError('')
    setFocusIso(iso)
    notifyValidity(true)
    if (iso !== props.value) props.onChange(iso)
    closeCalendar('commit')
  }

  const handleInput = (event: unknown): void => {
    if (!canEdit) return
    const next = (event as { target?: { value?: unknown } } | null)?.target?.value
    const text = typeof next === 'string' ? next : String(next ?? '')
    setDraft(text)
    setError('')
    notifyValidity(validateText(text).valid)
  }

  const handleBlur = (): void => {
    if (!canEdit) return
    const outcome = validateText(draft ?? props.value)
    if (outcome.valid && outcome.iso !== null) {
      setDraft(null)
      setError('')
      notifyValidity(true)
      if (outcome.iso !== props.value) props.onChange(outcome.iso)
      return
    }
    setError(outcome.error)
    notifyValidity(false)
  }

  const handleClear = (): void => {
    if (!canEdit) return
    setDraft(null)
    setError('')
    notifyValidity(true)
    if (props.value !== '') props.onChange('')
  }

  const moveFocus = (iso: string): void => {
    setFocusIso(iso)
    const parsed = parseDateValue(iso)
    if (parsed !== null) setView({ year: parsed.year, month: parsed.month })
  }

  const shiftViewMonth = (delta: number): void => {
    const next = safeShiftMonth(formatDateValue({ year: view.year, month: view.month, day: 1 }), delta)
    const parsed = next === null ? null : parseDateValue(next)
    if (parsed === null) return
    setView({ year: parsed.year, month: parsed.month })
    const preferred = focusIso ?? (selectedIso !== '' ? selectedIso : todayIso)
    const clamped = clampToRange(focusInMonth(preferred, parsed.year, parsed.month))
    if (clamped !== null) setFocusIso(clamped)
  }

  const shiftViewYear = (delta: number): void => {
    const next = safeShiftYear(formatDateValue({ year: view.year, month: view.month, day: 1 }), delta)
    const parsed = next === null ? null : parseDateValue(next)
    if (parsed === null) return
    setView({ year: parsed.year, month: parsed.month })
    const preferred = focusIso ?? (selectedIso !== '' ? selectedIso : todayIso)
    const clamped = clampToRange(focusInMonth(preferred, parsed.year, parsed.month))
    if (clamped !== null) setFocusIso(clamped)
  }

  const navMonth = (delta: number): void => {
    if (viewMode === 'days') shiftViewMonth(delta)
    else shiftViewYear(delta)
  }
  const navYear = (delta: number): void => {
    if (viewMode === 'years') shiftViewYear(delta * 12)
    else shiftViewYear(delta)
  }

  const onDialogKeyDown = (event: unknown): void => {
    const keyboard = event as {
      key?: unknown
      shiftKey?: boolean
      target?: { closest?: (selector: string) => unknown } | null
      preventDefault?: () => void
      stopPropagation?: () => void
    } | null
    const key = typeof keyboard?.key === 'string' ? keyboard.key : ''
    if (key === '') return
    if (key === 'Escape') {
      keyboard?.preventDefault?.()
      keyboard?.stopPropagation?.()
      closeCalendar('escape')
      return
    }
    const target = keyboard?.target
    const inGrid = target === undefined || target === null
      ? true
      : (typeof target.closest === 'function' ? target.closest('[data-crwu-date-grid]') !== null : false)
    if (inGrid !== true) return
    const baseIso = focusIso ?? (selectedIso !== '' ? selectedIso : todayIso)
    const parts = parseDateValue(baseIso)
    if (parts === null) return
    try {
      if (key === 'ArrowLeft') { keyboard?.preventDefault?.(); moveFocus(formatDateValue(addDays(parts, -1))); return }
      if (key === 'ArrowRight') { keyboard?.preventDefault?.(); moveFocus(formatDateValue(addDays(parts, 1))); return }
      if (key === 'ArrowUp') { keyboard?.preventDefault?.(); moveFocus(formatDateValue(addDays(parts, -7))); return }
      if (key === 'ArrowDown') { keyboard?.preventDefault?.(); moveFocus(formatDateValue(addDays(parts, 7))); return }
      if (key === 'Home' || key === 'End') {
        keyboard?.preventDefault?.()
        const offset = (weekdayOf(parts.year, parts.month, parts.day) + 6) % 7
        moveFocus(formatDateValue(addDays(parts, key === 'Home' ? -offset : 6 - offset)))
        return
      }
      if (key === 'PageUp' || key === 'PageDown') {
        keyboard?.preventDefault?.()
        const source = formatDateValue(parts)
        const next = keyboard?.shiftKey === true
          ? (key === 'PageUp' ? safeShiftYear(source, -1) : safeShiftYear(source, 1))
          : (key === 'PageUp' ? safeShiftMonth(source, -1) : safeShiftMonth(source, 1))
        if (next !== null) moveFocus(next)
        return
      }
      if (key === 'Enter' || key === ' ') {
        keyboard?.preventDefault?.()
        commitDate(baseIso)
      }
    } catch (thrown) {
      void thrown
    }
  }

  const expanded = open && !closing
  const leading = (weekdayOf(view.year, view.month, 1) + 6) % 7
  const total = daysInMonth(view.year, view.month)
  const cells: Array<number | null> = []
  for (let index = 0; index < leading; index += 1) cells.push(null)
  for (let day = 1; day <= total; day += 1) cells.push(day)
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: Array<Array<number | null>> = []
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7))

  const pageStart = Math.floor((view.year - 1) / 12) * 12 + 1
  const pageYears = Array.from({ length: 12 }, (_value, index) => pageStart + index).filter((year) => year >= 1 && year <= 9999)
  const title = viewMode === 'days'
    ? `${String(view.year)}${zhCN.datePickerYearSuffix}${String(view.month)}${zhCN.datePickerMonthSuffix}`
    : (viewMode === 'months'
      ? `${String(view.year)}${zhCN.datePickerYearSuffix}`
      : `${String(pageStart)}–${String(pageStart + 11)}`)
  const todayDisabled = isDisabledIso(todayIso)

  return <div className={classNames(CRWU_DATE_PICKER_CLASSES.root, props.className)}
    data-crwu-datepicker-instance={instanceId}>
    <div
      className={CRWU_DATE_PICKER_CLASSES.control}
      ref={controlRef as unknown as React.Ref<HTMLDivElement>}
      {...(invalidState ? { 'data-invalid': 'true' } : {})}
    >
      <input
        id={id}
        className={CRWU_DATE_PICKER_CLASSES.input}
        type="text"
        inputMode="numeric"
        value={display}
        placeholder={props.placeholder ?? zhCN.datePickerPlaceholder}
        disabled={disabled}
        readOnly={readOnly}
        {...(describedBy === '' ? {} : { 'aria-describedby': describedBy })}
        {...(invalidState ? { 'aria-invalid': true } : {})}
        onChange={canEdit ? handleInput : undefined}
        onBlur={canEdit ? handleBlur : undefined}
      />
      <button
        type="button"
        ref={triggerRef as unknown as React.Ref<HTMLButtonElement>}
        className={CRWU_DATE_PICKER_CLASSES.trigger}
        data-crwu-date-trigger="true"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-label={zhCN.datePickerOpen}
        disabled={disabled || readOnly}
        onClick={toggleCalendar}
      ><CalendarIcon size={16} /></button>
      {display !== '' && canEdit
        ? <button
          type="button"
          className={CRWU_DATE_PICKER_CLASSES.clear}
          data-crwu-date-action="clear"
          aria-label={zhCN.datePickerClear}
          onClick={handleClear}
        ><CloseIcon size={14} /></button>
        : null}
    </div>

    {open ? <Popover
      id={dialogId}
      listRef={dialogRef}
      box={box}
      frame={frame}
      className={classNames(CRWU_DATE_PICKER_CLASSES.dialog, closing && CRWU_DATE_PICKER_CLASSES.dialogOut)}
      role="dialog"
      ariaLabel={zhCN.datePickerDialogLabel}
      ariaHidden={closing ? 'true' : undefined}
      inert={closing}
      dataAttributes={{ 'data-crwu-datepicker-dialog': instanceId }}
      onKeyDown={onDialogKeyDown}
    >
      <div className={CRWU_DATE_PICKER_CLASSES.head}>
        <button type="button" className={CRWU_DATE_PICKER_CLASSES.nav} data-crwu-date-nav="prev-year" aria-label={zhCN.datePickerPrevYear} onClick={() => { navYear(-1) }}><ChevronsLeftIcon size={16} /></button>
        <button type="button" className={CRWU_DATE_PICKER_CLASSES.nav} data-crwu-date-nav="prev-month" aria-label={zhCN.datePickerPrevMonth} onClick={() => { navMonth(-1) }}><ChevronLeftIcon size={16} /></button>
        {viewMode === 'days'
          ? <button type="button" className={CRWU_DATE_PICKER_CLASSES.title} data-crwu-date-view="months" aria-label={zhCN.datePickerChooseMonth} onClick={() => { setViewMode('months') }}>{title}</button>
          : <button type="button" className={CRWU_DATE_PICKER_CLASSES.title} data-crwu-date-view="years" aria-label={zhCN.datePickerChooseYear} onClick={() => { setViewMode('years') }}>{title}</button>}
        <button type="button" className={CRWU_DATE_PICKER_CLASSES.nav} data-crwu-date-nav="next-month" aria-label={zhCN.datePickerNextMonth} onClick={() => { navMonth(1) }}><ChevronRightIcon size={16} /></button>
        <button type="button" className={CRWU_DATE_PICKER_CLASSES.nav} data-crwu-date-nav="next-year" aria-label={zhCN.datePickerNextYear} onClick={() => { navYear(1) }}><ChevronsRightIcon size={16} /></button>
      </div>

      {viewMode === 'months'
        ? <div className={CRWU_DATE_PICKER_CLASSES.viewGrid} role="group" aria-label={zhCN.datePickerChooseMonth}>
          {MONTHS.map((month) => <button
            key={month}
            type="button"
            className={classNames(CRWU_DATE_PICKER_CLASSES.viewOption, month === view.month && CRWU_DATE_PICKER_CLASSES.viewOptionOn)}
            data-crwu-date-view="month"
            data-crwu-date-month={month}
            onClick={() => {
              const preferred = focusIso ?? (selectedIso !== '' ? selectedIso : todayIso)
              const clamped = clampToRange(focusInMonth(preferred, view.year, month))
              setView((prev) => ({ ...prev, month }))
              if (clamped !== null) setFocusIso(clamped)
              setViewMode('days')
            }}
          >{`${String(month)}${zhCN.datePickerMonthSuffix}`}</button>)}
        </div>
        : null}

      {viewMode === 'years'
        ? <div className={CRWU_DATE_PICKER_CLASSES.viewGrid} role="group" aria-label={zhCN.datePickerChooseYear}>
          {pageYears.map((year) => <button
            key={year}
            type="button"
            className={classNames(CRWU_DATE_PICKER_CLASSES.viewOption, year === view.year && CRWU_DATE_PICKER_CLASSES.viewOptionOn)}
            data-crwu-date-view="year"
            data-crwu-date-year={year}
            onClick={() => {
              const preferred = focusIso ?? (selectedIso !== '' ? selectedIso : todayIso)
              const clamped = clampToRange(focusInMonth(preferred, year, view.month))
              setView((prev) => ({ ...prev, year }))
              if (clamped !== null) setFocusIso(clamped)
              setViewMode('months')
            }}
          >{`${String(year)}${zhCN.datePickerYearSuffix}`}</button>)}
        </div>
        : null}

      {viewMode === 'days'
        ? <div className={CRWU_DATE_PICKER_CLASSES.grid} role="grid" aria-label={zhCN.datePickerDialogLabel} data-crwu-date-grid="true">
          <div className={CRWU_DATE_PICKER_CLASSES.weekRow} role="row">
            {WEEKDAYS.map((weekday) => <div key={weekday} role="columnheader" className={CRWU_DATE_PICKER_CLASSES.weekday}>{weekday}</div>)}
          </div>
          {weeks.map((week, weekIndex) => <div key={`week-${String(weekIndex)}`} className={CRWU_DATE_PICKER_CLASSES.weekRow} role="row">
            {week.map((day, dayIndex) => day === null
              ? <div key={`blank-${String(dayIndex)}`} role="gridcell" className={CRWU_DATE_PICKER_CLASSES.blank} aria-hidden="true" />
              : (() => {
                const iso = formatDateValue({ year: view.year, month: view.month, day })
                const off = isDisabledIso(iso)
                const selected = iso === selectedIso
                const isToday = iso === todayIso
                return <div
                  key={iso}
                  role="gridcell"
                  className={CRWU_DATE_PICKER_CLASSES.cell}
                  aria-selected={selected ? true : undefined}
                  aria-current={isToday ? 'date' : undefined}
                >
                  <button
                    type="button"
                    ref={(node) => {
                      if (node === null) dayRefs.current.delete(iso)
                      else dayRefs.current.set(iso, node as unknown as { focus?: () => void })
                    }}
                    className={classNames(
                      CRWU_DATE_PICKER_CLASSES.day,
                      selected && CRWU_DATE_PICKER_CLASSES.daySelected,
                      isToday && CRWU_DATE_PICKER_CLASSES.dayToday,
                    )}
                    data-date={iso}
                    aria-label={zhCN.datePickerDayLabel
                      .replace('{year}', String(view.year))
                      .replace('{month}', String(view.month))
                      .replace('{day}', String(day))}
                    disabled={off}
                    aria-disabled={off ? true : undefined}
                    tabIndex={iso === focusIso ? 0 : -1}
                    onClick={off ? undefined : () => { commitDate(iso) }}
                  >{day}</button>
                </div>
              })())}
          </div>)}
        </div>
        : null}

      <div className={CRWU_DATE_PICKER_CLASSES.footer}>
        {display !== ''
          ? <button type="button" className={CRWU_DATE_PICKER_CLASSES.action} data-crwu-date-action="clear" onClick={handleClear}>{zhCN.datePickerClear}</button>
          : null}
        <button
          type="button"
          className={CRWU_DATE_PICKER_CLASSES.action}
          data-crwu-date-action="today"
          disabled={todayDisabled}
          onClick={todayDisabled ? undefined : () => { commitDate(todayIso) }}
        >{zhCN.datePickerToday}</button>
      </div>
    </Popover> : null}

    {error !== '' ? <p id={errorId} role="alert" className={CRWU_DATE_PICKER_CLASSES.error}>{error}</p> : null}
  </div>
}
