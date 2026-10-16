import * as React from 'react'
import { zhCN } from '../../locales/zh-CN.ts'
import { CloseIcon } from '../icons.tsx'

export const CRWU_INPUT_CLASSES = {
  wrap: 'crwu-ui-input-wrap',
  input: 'crwu-ui-input',
  adornment: 'crwu-ui-input-adornment',
  clear: 'crwu-ui-input-clear',
} as const

export type TextInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onBlur' | 'onFocus' | 'className' | 'children' | 'size'
> & {
  value: string
  onChange?: (value: string, event?: unknown) => void
  onBlur?: (event?: unknown) => void
  onFocus?: (event?: unknown) => void
  clearable?: boolean
  readOnly?: boolean
  disabled?: boolean
  invalid?: boolean
  required?: boolean
  id?: string
  describedBy?: string
  /** Optional external label id; consumed as `aria-labelledby`, never leaked as a raw DOM attr. */
  labelId?: string
  /** Extra class on the input element itself (page anchors). */
  controlClassName?: string
  className?: string
  startAdornment?: React.ReactNode
  endAdornment?: React.ReactNode
  inputRef?: React.MutableRefObject<HTMLInputElement | null>
  [key: `data-${string}`]: unknown
}

/** Controlled text input with an optional clear action; the wrap owns the field border. */
export function TextInput(props: TextInputProps): React.ReactElement {
  const {
    value, onChange, onBlur, onFocus, clearable, readOnly, disabled, invalid, required,
    id, describedBy, labelId, className, controlClassName, startAdornment, endAdornment, inputRef, ...rest
  } = props
  const isReadOnly = readOnly === true
  const isDisabled = disabled === true
  const canEdit = !isReadOnly && !isDisabled
  const showClear = clearable === true && value !== '' && canEdit
  const restAttrs = rest as unknown as React.InputHTMLAttributes<HTMLInputElement>

  const handleChange = (event: unknown): void => {
    if (!canEdit) return
    const next = (event as { target?: { value?: unknown } } | null)?.target?.value
    onChange?.(typeof next === 'string' ? next : String(next ?? ''), event)
  }

  // Presence markers stay on the wrapper (never on the input); the field styles own the inset.
  return <div
    className={[CRWU_INPUT_CLASSES.wrap, className ?? ''].filter((one) => one !== '').join(' ')}
    {...(invalid === true ? { 'data-invalid': 'true' } : {})}
    {...(startAdornment === undefined ? {} : { 'data-start-adorned': 'true' })}
    {...(endAdornment === undefined ? {} : { 'data-end-adorned': 'true' })}
  >
    {startAdornment === undefined
      ? null
      : <span className={CRWU_INPUT_CLASSES.adornment} aria-hidden="true">{startAdornment}</span>}
    <input
      {...restAttrs}
      ref={inputRef as unknown as React.Ref<HTMLInputElement>}
      id={id}
      className={[CRWU_INPUT_CLASSES.input, controlClassName ?? ''].filter((one) => one !== '').join(' ')}
      type={props.type ?? 'text'}
      value={value}
      placeholder={props.placeholder}
      autoComplete={props.autoComplete}
      maxLength={props.maxLength}
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
    {showClear
      ? <button
        type="button"
        className={CRWU_INPUT_CLASSES.clear}
        aria-label={zhCN.uiInputClear}
        onClick={() => { onChange?.('') }}
      ><CloseIcon size={14} /></button>
      : null}
    {endAdornment === undefined
      ? null
      : <span className={CRWU_INPUT_CLASSES.adornment} aria-hidden="true">{endAdornment}</span>}
  </div>
}
