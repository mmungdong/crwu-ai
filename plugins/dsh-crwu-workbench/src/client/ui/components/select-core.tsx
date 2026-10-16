import * as React from 'react'
import { CheckIcon, ChevronDownIcon } from '../icons.tsx'
import { useInstanceId } from './ids.ts'
import { Popover, usePopover, type PopoverAnchorNode, type PopoverCloseReason, type PopoverContentNode } from './Popover.tsx'
import { POPOVER_CLOSE_MS, POPOVER_ROW_HEIGHT, POPOVER_ROW_HEIGHT_HINT } from './popover-model.ts'
import { TYPEAHEAD_MS, selectIntentFor, selectRegistry, typeaheadIndexOf } from './select-model.ts'

export interface SelectOption {
  value: string
  label: string
  hint?: string
  badge?: string
  disabled?: boolean
}

export interface SelectClassNames {
  root: string
  trigger: string
  value: string
  placeholder: string
  chevron: string
  list: string
  listOut: string
  option: string
  optionActive: string
  optionMark: string
  optionMain: string
  optionLabel: string
  optionHint: string
  optionBadge: string
}

export interface SelectCoreProps {
  name?: string
  /** Explicit combobox id so a `<label htmlFor>` can focus the control; popup ids stay generated. */
  id?: string
  value: string
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  required?: boolean
  invalid?: boolean
  describedBy?: string
  labelId?: string
  onBlur?: () => void
  onChange: (value: string) => void
  className?: string
  /** Extra root attributes (page anchors) merged over the presentation hooks. */
  dataAttributes?: Record<string, string | undefined>
  /** Extra option attributes (page anchors). */
  optionAttributes?: (option: SelectOption, index: number) => Record<string, string | undefined>
}

export interface SelectPresentation {
  classes: SelectClassNames
  idPrefixOf: (props: SelectCoreProps, instanceId: string) => string
  rootDataKey: string
  stateDataKey: string
  optionDataKey: string
  registryKeyOf: (props: SelectCoreProps, instanceId: string) => string
  labelledByOf: (props: SelectCoreProps, valueId: string) => string | undefined
  /** Exit animation on close; reduced motion and ownership cleanup still close immediately. */
  animateClose?: boolean
}

type SelectCloseReason = PopoverCloseReason | 'commit'

function classNames(...all: Array<string | false | undefined>): string {
  return all.filter((one): one is string => typeof one === 'string' && one !== '').join(' ')
}

function prefersReducedMotion(): boolean {
  const media = (globalThis as { matchMedia?: (query: string) => { matches?: boolean } }).matchMedia
  if (typeof media !== 'function') return false
  try { return media.call(globalThis, '(prefers-reduced-motion: reduce)').matches === true } catch (error) { void error; return false }
}

function estimateHeight(options: readonly SelectOption[]): number {
  let total = 10
  for (const option of options) {
    total += option.hint === undefined || option.hint === '' ? POPOVER_ROW_HEIGHT : POPOVER_ROW_HEIGHT_HINT
  }
  return total
}

/**
 * One stateful select implementation, shared by the public component and the valuation
 * compatibility surface. Presentation supplies classes, id scheme and data hooks.
 */
export function createSelect(presentation: SelectPresentation): (props: SelectCoreProps) => React.ReactElement {
  function SelectCore(props: SelectCoreProps): React.ReactElement {
    const { value, options, placeholder = '' } = props
    const classes = presentation.classes
    const disabled = props.disabled === true
    const instanceId = useInstanceId('crwu-select')
    const registryKey = presentation.registryKeyOf(props, instanceId)
    const idPrefix = presentation.idPrefixOf(props, instanceId)
    const listId = `${idPrefix}-listbox`
    const valueId = `${idPrefix}-value`
    const triggerId = `${idPrefix}-trigger`
    // Index-based ids stay unique for punctuation/unicode option values (no lossy sanitizing).
    const optionIdOf = (index: number): string => `${listId}-option-${String(index)}`

    const selectedIndex = options.findIndex((option) => option.value === value)
    const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

    const [open, setOpen] = React.useState(false)
    const [closing, setClosing] = React.useState(false)
    const [active, setActive] = React.useState(selectedIndex >= 0 ? selectedIndex : 0)
    const contentHeightRef = React.useRef(estimateHeight(options))
    const triggerRef = React.useRef<PopoverAnchorNode | null>(null)
    const listRef = React.useRef<PopoverContentNode | null>(null)
    const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const typeahead = React.useRef({ buffer: '', at: 0 })

    const expanded = open && !closing

    const resolveActive = React.useCallback((target: number, direction: 1 | -1): number => {
      const count = options.length
      if (count <= 0) return 0
      let index = Math.min(Math.max(target, 0), count - 1)
      for (let step = 0; step < count; step += 1) {
        if (options[index]?.disabled !== true) return index
        index = ((index + direction) % count + count) % count
      }
      return Math.min(Math.max(target, 0), count - 1)
    }, [options])

    const close = React.useCallback((reason: SelectCloseReason = 'owner', immediate = false): void => {
      selectRegistry.release(registryKey)
      if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null }
      if (immediate || presentation.animateClose !== true || prefersReducedMotion()) {
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

    const requestClose = React.useCallback((reason: PopoverCloseReason): void => {
      close(reason === 'focus-leave' ? 'outside' : reason)
    }, [close])
    const { box, frame, place } = usePopover({
      open,
      triggerRef,
      listRef,
      contentHeightRef,
      insideSelector: `[data-crwu-select-instance="${instanceId}"], [data-crwu-select-list="${instanceId}"]`,
      onRequestClose: requestClose,
    })

    const openList = React.useCallback((): void => {
      if (disabled) return
      if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null }
      setClosing(false)
      setActive(resolveActive(selectedIndex >= 0 ? selectedIndex : 0, 1))
      setOpen(true)
      selectRegistry.claim(registryKey, () => { close('owner', true) })
      place()
    }, [close, disabled, place, registryKey, resolveActive, selectedIndex])

    const commit = React.useCallback((index: number): void => {
      const option = options[index]
      if (option === undefined || option.disabled === true) return
      if (option.value !== value) props.onChange(option.value)
      close('commit')
    }, [close, options, props, value])

    React.useEffect(() => {
      if (!open) return undefined
      return () => {
        selectRegistry.release(registryKey)
        if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null }
      }
    }, [open, registryKey])

    const onKeyDown = (event: unknown): void => {
      const keyboard = event as { key?: unknown; preventDefault?: () => void; stopPropagation?: () => void } | null
      const key = typeof keyboard?.key === 'string' ? keyboard.key : ''
      if (key === '') return
      if (key.length === 1 && key !== ' ') {
        const now = Date.now()
        const buffer = now - typeahead.current.at > TYPEAHEAD_MS ? key : typeahead.current.buffer + key
        typeahead.current = { buffer, at: now }
        const hit = typeaheadIndexOf(options.map((option) => option.label), buffer)
        if (hit >= 0) {
          keyboard?.preventDefault?.()
          if (!expanded) openList()
          setActive(resolveActive(hit, 1))
        }
        return
      }
      const intent = selectIntentFor({ key, open: expanded, active, count: options.length, selected: selectedIndex })
      switch (intent.kind) {
        case 'tab':
          if (open) close('tab')
          return
        case 'close':
          keyboard?.preventDefault?.()
          keyboard?.stopPropagation?.()
          close('escape')
          return
        case 'open':
          keyboard?.preventDefault?.()
          openList()
          setActive(resolveActive(intent.active, 1))
          return
        case 'move':
          keyboard?.preventDefault?.()
          setActive(resolveActive(intent.active, key === 'ArrowUp' || key === 'End' ? -1 : 1))
          return
        case 'commit':
          keyboard?.preventDefault?.()
          commit(intent.active)
          return
        default:
          return
      }
    }

    const labelledBy = presentation.labelledByOf(props, valueId)
    const rootData: Record<string, string> = {}
    rootData[presentation.rootDataKey] = props.name ?? instanceId
    rootData[presentation.stateDataKey] = open ? (closing ? 'closing' : 'open') : 'closed'
    rootData['data-crwu-select-instance'] = instanceId
    const rootAttrs = {
      className: classNames(classes.root, props.className),
      ...rootData,
      ...(props.dataAttributes ?? {}),
    } as unknown as React.HTMLAttributes<HTMLDivElement>

    return <div {...rootAttrs}>
      <button
        type="button"
        id={props.id ?? triggerId}
        ref={triggerRef as unknown as React.Ref<HTMLButtonElement>}
        className={classes.trigger}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={expanded}
        {...(expanded ? { 'aria-controls': listId } : {})}
        {...(expanded && options.length > 0 ? { 'aria-activedescendant': optionIdOf(active) } : {})}
        {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
        {...(props.describedBy === undefined ? {} : { 'aria-describedby': props.describedBy })}
        {...(props.required === true ? { 'aria-required': true } : {})}
        {...(props.invalid === true ? { 'aria-invalid': true } : {})}
        disabled={disabled}
        onClick={() => { if (open) close('escape'); else openList() }}
        onKeyDown={onKeyDown}
        onBlur={props.onBlur}
      >
        <span
          className={classNames(classes.value, selected === undefined && classes.placeholder)}
          id={valueId}
          title={selected?.label ?? ''}
        >{selected?.label ?? placeholder}</span>
        <span className={classes.chevron} aria-hidden="true"><ChevronDownIcon size={16} /></span>
      </button>

      {open ? <Popover
        id={listId}
        listRef={listRef}
        box={box}
        frame={frame}
        className={classNames(classes.list, closing && classes.listOut)}
        role="listbox"
        labelledBy={props.labelId}
        ariaHidden={closing ? 'true' : undefined}
        inert={closing}
        dataAttributes={{ 'data-crwu-select-list': instanceId }}
      >
        {options.map((option, index) => <li
          key={option.value}
          id={optionIdOf(index)}
          role="option"
          aria-selected={option.value === value}
          aria-disabled={option.disabled === true ? true : undefined}
          className={classNames(classes.option, index === active && classes.optionActive)}
          {...(({ [presentation.optionDataKey]: option.value, ...(props.optionAttributes?.(option, index) ?? {}) }) as unknown as React.LiHTMLAttributes<HTMLLIElement>)}
          onMouseEnter={() => { setActive(index) }}
          onMouseDown={(event) => { (event as { preventDefault?: () => void }).preventDefault?.() }}
          onClick={() => { commit(index) }}
        >
          <span className={classes.optionMark} aria-hidden="true">
            {option.value === value ? <CheckIcon size={14} /> : null}
          </span>
          <span className={classes.optionMain}>
            <span className={classes.optionLabel}>
              {option.label}
              {option.badge === undefined || option.badge === ''
                ? null
                : <span className={classes.optionBadge}>{option.badge}</span>}
            </span>
            {option.hint === undefined || option.hint === ''
              ? null
              : <span className={classes.optionHint}>{option.hint}</span>}
          </span>
        </li>)}
      </Popover> : null}
    </div>
  }
  return SelectCore
}
