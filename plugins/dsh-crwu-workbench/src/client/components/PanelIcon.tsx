import * as React from 'react'

export interface PanelIconProps {
  size?: number
  active?: boolean
}

/** 工作台侧栏图标。 */
export function PanelIcon(props: PanelIconProps): React.ReactElement {
  const size = typeof props.size === 'number' ? props.size : 16
  const stroke = props.active === true ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
  return <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={stroke}
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x={3} y={3.5} width={18} height={17} rx={3} />
    <path d="M7.5 8.5h5.5" />
    <path d="M7.5 12.5h9" />
    <path d="M7.5 16.5h4" />
  </svg>
}
