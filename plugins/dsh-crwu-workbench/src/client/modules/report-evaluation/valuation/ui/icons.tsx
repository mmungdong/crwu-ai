import * as React from 'react'

/** Module-local icons keep the prototype's 1.7px stroke language without new deps. */
export interface IconProps {
  size?: number
  className?: string
}

function frame(props: IconProps): {
  width: number
  height: number
  className: string | undefined
  viewBox: string
  fill: string
  stroke: string
  strokeWidth: number
  strokeLinecap: 'round'
  strokeLinejoin: 'round'
  'aria-hidden': true
} {
  return {
    width: props.size ?? 16,
    height: props.size ?? 16,
    className: props.className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }
}

export function ArrowRight(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M5 12h14" /><path d="m13.5 6.5 5.5 5.5-5.5 5.5" /></svg>
}

export function ChevronRight(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="m9 6 6 6-6 6" /></svg>
}

export function ChevronLeft(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M15 6l-6 6 6 6" /></svg>
}

export function ChevronDown(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="m6 9 6 6 6-6" /></svg>
}

export function CheckIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M5 12.5l4.2 4.2L19 7" /></svg>
}

export function UploadIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
}

export function FileIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></svg>
}

export function FolderIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M3 7h7l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></svg>
}

export function XIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M6 6l12 12M18 6L6 18" /></svg>
}

export function InfoIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></svg>
}

export function AlertIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M12 4l8.5 15h-17z" /><path d="M12 9v4M12 16h.01" /></svg>
}

export function LockIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
}

export function SheetIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M9 4v16M15 9v11" /></svg>
}

export function BuildingIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M14 9h5a1 1 0 0 1 1 1v11M3 21h18" /><path d="M8 8h2M8 12h2M8 16h2" /></svg>
}

export function ChipIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></svg>
}

export function ChartIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M4 20V4M4 20h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></svg>
}

export function DotsIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><circle cx="6" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18" cy="12" r="1" /></svg>
}

export function SaveIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v6h7V4M8 20v-6h8v6" /></svg>
}

export function ScaleIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M12 4v16M6 20h12M5 7h14" /><path d="m7 7-2.5 5a3 3 0 0 0 5 0z" /><path d="m17 7-2.5 5a3 3 0 0 0 5 0z" /></svg>
}

export function StampIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M9.5 10V6.8a2.5 2.5 0 0 1 5 0V10" /><path d="M6 10h12v3.5H6z" /><path d="M5 16.5h14V20H5z" /><path d="M10 13.5v3M14 13.5v3" /></svg>
}

export function SearchIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><circle cx="10.8" cy="10.8" r="5.8" /><path d="m15.2 15.2 4.3 4.3" /></svg>
}

export function ShieldIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M12 3.5 19 6v5.5c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6z" /><path d="m9 12 2 2 4-4.5" /></svg>
}

export function RefreshIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M19.5 9A8 8 0 1 0 20 14" /><path d="M19.5 4.5V9H15" /></svg>
}

export function DownloadIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M5 19.5h14" /></svg>
}

export function EditIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10z" /><path d="m14.5 7 2.5 2.5" /></svg>
}

export function PanelIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><rect x="4" y="4.5" width="16" height="15" rx="2" /><path d="M14.5 4.5v15" /></svg>
}

export function ClockIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
}

export function PlusIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M12 5v14M5 12h14" /></svg>
}

export function MinusIcon(props: IconProps): React.ReactElement {
  return <svg {...frame(props)}><path d="M5 12h14" /></svg>
}
