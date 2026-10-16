import * as React from 'react'

export const CRWU_TEXTAREA_CLASSES = {
  wrap: 'crwu-ui-textarea-wrap',
  textarea: 'crwu-ui-textarea',
  count: 'crwu-ui-textarea-count',
} as const

export type TextAreaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'onBlur' | 'onFocus' | 'className' | 'children'
> & {
  value: string
  onChange?: (value: string, event?: unknown) => void
  onBlur?: (event?: unknown) => void
  onFocus?: (event?: unknown) => void
  readOnly?: boolean
  disabled?: boolean
  invalid?: boolean
  required?: boolean
  id?: string
  describedBy?: string
  /** Optional external label id; consumed as `aria-labelledby`, never leaked as a raw DOM attr. */
  labelId?: string
  className?: string
  /** Extra class on the textarea element itself (page anchors). */
  controlClassName?: string
  countLabel?: string
  /** Grow rows with the content up to `maxRows` (beyond that the textarea scrolls). */
  autoGrow?: boolean
  maxRows?: number
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>
  [key: `data-${string}`]: unknown
}

/** Controlled multi-line input; composition callbacks and standard attributes pass through. */
export function TextArea(props: TextAreaProps): React.ReactElement {
  const {
    value, onChange, onBlur, onFocus, readOnly, disabled, invalid, required,
    id, describedBy, labelId, className, controlClassName, countLabel, autoGrow, maxRows, inputRef, rows, ...rest
  } = props
  const isReadOnly = readOnly === true
  const isDisabled = disabled === true
  const canEdit = !isReadOnly && !isDisabled
  const lineCount = value === '' ? 1 : value.split('\n').length
  const resolvedRows = rows ?? (autoGrow === true ? Math.min(maxRows ?? 6, Math.max(2, lineCount)) : undefined)
  const restAttrs = rest as unknown as React.TextareaHTMLAttributes<HTMLTextAreaElement>

  const handleChange = (event: unknown): void => {
    if (!canEdit) return
    const next = (event as { target?: { value?: unknown } } | null)?.target?.value
    onChange?.(typeof next === 'string' ? next : String(next ?? ''), event)
  }

  return <div className={[CRWU_TEXTAREA_CLASSES.wrap, className ?? ''].filter((one) => one !== '').join(' ')}>
    <textarea
      {...restAttrs}
      ref={inputRef as unknown as React.Ref<HTMLTextAreaElement>}
      id={id}
      className={[CRWU_TEXTAREA_CLASSES.textarea, controlClassName ?? ''].filter((one) => one !== '').join(' ')}
      value={value}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      rows={resolvedRows}
      readOnly={isReadOnly}
      disabled={isDisabled}
      aria-label={props['aria-label']}
      {...((describedBy ?? '') === '' ? {} : { 'aria-describedby': describedBy })}
      {...((labelId ?? '') === '' ? {} : { 'aria-labelledby': labelId })}
      {...(invalid === true ? { 'aria-invalid': true } : {})}
      {...(required === true ? { 'aria-required': true } : {})}
      onChange={handleChange}
      onBlur={onBlur}
      onFocus={onFocus}
    />
    {countLabel === undefined
      ? null
      : <span className={CRWU_TEXTAREA_CLASSES.count} aria-hidden="true">{countLabel}</span>}
  </div>
}
