import * as React from 'react'
import { zhCN } from '../../locales/zh-CN.ts'
import { useInstanceId } from './ids.ts'

export const CRWU_FIELD_CLASSES = {
  root: 'crwu-ui-field',
  label: 'crwu-ui-field-label',
  labelText: 'crwu-ui-field-label-text',
  required: 'crwu-ui-field-required',
  requiredText: 'crwu-ui-field-required-text',
  hint: 'crwu-ui-field-hint',
  error: 'crwu-ui-field-error',
} as const

export interface FormFieldRenderProps {
  id: string
  labelId: string
  describedBy?: string
  invalid: boolean
  required: boolean
}

export interface FormFieldProps {
  label: string
  required?: boolean
  hint?: React.ReactNode
  error?: string
  id?: string
  className?: string
  /** Extra data/aria attributes on the field root (test hooks / page anchors). */
  dataAttributes?: Record<string, string | undefined>
  /** Extra data/aria attributes on the hint element. */
  hintData?: Record<string, string | undefined>
  /** Extra data/aria attributes on the error element. */
  errorData?: Record<string, string | undefined>
  /**
   * Render function receiving the ids/state for the control; the caller builds the control so
   * any shared input, select or date picker can be associated with this label.
   */
  children: (field: FormFieldRenderProps) => React.ReactNode
}

/** Label + hint + error owner; the control itself is provided by the render function. */
export function FormField(props: FormFieldProps): React.ReactElement {
  const generatedId = useInstanceId('crwu-field')
  const id = props.id ?? generatedId
  const labelId = `${id}-label`
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const required = props.required === true
  const invalid = typeof props.error === 'string' && props.error !== ''
  const describedBy = [
    props.hint === undefined || props.hint === '' ? null : hintId,
    invalid ? errorId : null,
  ].filter((one): one is string => one !== null).join(' ')

  return <div
    className={[CRWU_FIELD_CLASSES.root, props.className ?? ''].filter((one) => one !== '').join(' ')}
    {...((props.dataAttributes ?? {}) as unknown as React.HTMLAttributes<HTMLDivElement>)}
  >
    <label id={labelId} htmlFor={id} className={CRWU_FIELD_CLASSES.label}>
      <span className={CRWU_FIELD_CLASSES.labelText}>{props.label}</span>
      {required ? <span className={CRWU_FIELD_CLASSES.required} aria-hidden="true">*</span> : null}
      {required ? <span className={CRWU_FIELD_CLASSES.requiredText}>{zhCN.uiFieldRequired}</span> : null}
    </label>
    {props.children({ id, labelId, describedBy: describedBy === '' ? undefined : describedBy, invalid, required })}
    {props.hint === undefined || props.hint === ''
      ? null
      : <p id={hintId} className={CRWU_FIELD_CLASSES.hint}
        {...((props.hintData ?? {}) as unknown as React.HTMLAttributes<HTMLParagraphElement>)}
      >{props.hint}</p>}
    {invalid
      ? <p id={errorId} role="alert" className={CRWU_FIELD_CLASSES.error}
        {...((props.errorData ?? {}) as unknown as React.HTMLAttributes<HTMLParagraphElement>)}
      >{props.error}</p>
      : null}
  </div>
}
