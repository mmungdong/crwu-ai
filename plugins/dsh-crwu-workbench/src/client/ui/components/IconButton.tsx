import * as React from 'react'
import { Button, type ButtonProps, type ButtonVariant } from './Button.tsx'

export type IconButtonProps = Omit<ButtonProps, 'variant' | 'label' | 'children'> & {
  /** Accessible name; also used as the tooltip unless `title` is given. */
  label: string
  variant?: ButtonVariant
  children?: React.ReactNode
}

/** Square icon-only button built on the shared Button family. */
export function IconButton(props: IconButtonProps): React.ReactElement {
  const { label, variant, className, children, ...rest } = props
  const classes = ['crwu-ui-icon-btn', className ?? ''].filter((one) => one !== '').join(' ')
  return <Button
    {...rest}
    variant={variant ?? 'secondary'}
    className={classes}
    aria-label={props['aria-label'] ?? label}
    title={props.title ?? label}
  >{children}</Button>
}
