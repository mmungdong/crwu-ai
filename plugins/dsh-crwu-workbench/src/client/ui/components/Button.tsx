import * as React from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'text' | 'danger'
export type ButtonSize = 'sm' | 'md'

export type ButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick' | 'disabled' | 'type' | 'className' | 'children'
> & {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  disabled?: boolean
  /** Id of the visible element explaining why the button is disabled. */
  describedBy?: string
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  type?: 'button' | 'submit' | 'reset'
  className?: string
  buttonRef?: React.Ref<HTMLButtonElement>
  children?: React.ReactNode
  /** Legacy primitive alias for `children`. */
  label?: string
  [key: `data-${string}`]: unknown
}

export const CRWU_BUTTON_CLASSES = {
  base: 'crwu-ui-btn',
  primary: 'crwu-ui-btn-primary',
  secondary: 'crwu-ui-btn-secondary',
  soft: 'crwu-ui-btn-soft',
  text: 'crwu-ui-btn-text',
  danger: 'crwu-ui-btn-danger',
  sm: 'crwu-ui-btn-sm',
  loading: 'crwu-ui-btn-loading',
  spinner: 'crwu-ui-btn-spinner',
  label: 'crwu-ui-btn-label',
} as const

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: CRWU_BUTTON_CLASSES.primary,
  secondary: CRWU_BUTTON_CLASSES.secondary,
  soft: CRWU_BUTTON_CLASSES.soft,
  text: CRWU_BUTTON_CLASSES.text,
  danger: CRWU_BUTTON_CLASSES.danger,
}

/** Blue default action button; loading and disabled both stop the click from firing. */
export function Button(props: ButtonProps): React.ReactElement {
  const {
    variant, size, loading, disabled, describedBy, onClick, type, className,
    buttonRef, children, label, ...rest
  } = props
  const resolvedVariant = variant ?? 'primary'
  const isLoading = loading === true
  const isDisabled = disabled === true
  const restAttrs = rest as unknown as React.ButtonHTMLAttributes<HTMLButtonElement>
  const classes = [
    CRWU_BUTTON_CLASSES.base,
    VARIANT_CLASS[resolvedVariant],
    size === 'sm' ? CRWU_BUTTON_CLASSES.sm : '',
    isLoading ? CRWU_BUTTON_CLASSES.loading : '',
    className ?? '',
  ].filter((one) => one !== '').join(' ')
  return <button
    {...restAttrs}
    ref={buttonRef as unknown as React.Ref<HTMLButtonElement>}
    type={type ?? 'button'}
    className={classes}
    disabled={isDisabled || isLoading}
    aria-busy={isLoading ? true : undefined}
    {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
    onClick={isLoading || isDisabled ? undefined : onClick}
  >
    {isLoading ? <span className={CRWU_BUTTON_CLASSES.spinner} aria-hidden="true" /> : null}
    <span className={CRWU_BUTTON_CLASSES.label}>{children ?? label}</span>
  </button>
}
