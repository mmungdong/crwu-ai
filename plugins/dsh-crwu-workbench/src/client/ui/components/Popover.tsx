import * as React from 'react'
import {
  POPOVER_GAP,
  POPOVER_MARGIN,
  POPOVER_MAX_HEIGHT,
  POPOVER_MIN_HEIGHT,
  containmentRootOf,
  intersectRect,
  placementOf,
  type ClientRect,
  type SelectBox,
} from './popover-model.ts'

export type PopoverCloseReason = 'outside' | 'escape' | 'tab' | 'focus-leave' | 'owner'

export interface PopoverAnchorNode {
  getBoundingClientRect?: () => ClientRect
  ownerDocument?: { defaultView?: unknown } | null
  parentElement?: unknown
  contains?: (node: unknown) => boolean
  focus?: () => void
}

export interface PopoverContentNode {
  scrollHeight?: number
  /**
   * Inline style actually applied by the last commit. Calibration compares these rendered
   * coordinates with the element's own rect from the same DOM epoch.
   */
  style?: { left?: string; top?: string }
  getBoundingClientRect?: () => ClientRect
  contains?: (node: unknown) => boolean
}

export interface PopoverFrame {
  left: number
  top: number
  width: number
  maxHeight: number
}

interface ListenerTarget {
  addEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void
  removeEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void
}

export interface UsePopoverInput {
  open: boolean
  /** Placement anchor; `triggerRef` is the fallback when absent. */
  anchorRef?: React.MutableRefObject<PopoverAnchorNode | null>
  triggerRef?: React.MutableRefObject<PopoverAnchorNode | null>
  listRef: React.MutableRefObject<PopoverContentNode | null>
  contentHeightRef: React.MutableRefObject<number>
  insideSelector: string
  onRequestClose: (reason: PopoverCloseReason) => void
  desiredWidth?: number
  gap?: number
  margin?: number
  maxHeight?: number
  minHeight?: number
  /** Close when focus moves outside the anchor or the popup (nonmodal pickers). */
  closeOnFocusLeave?: boolean
}

export interface UsePopoverResult {
  box: SelectBox | null
  frame: PopoverFrame | null
  place: () => void
}

/**
 * Shared popover behaviour: measured fixed-position placement, self-calibration against the
 * real containing block, and document/window listeners that close or reposition while open.
 * Close requests carry a reason so callers can decide whether to restore focus.
 */
export function usePopover(input: UsePopoverInput): UsePopoverResult {
  const {
    open,
    anchorRef,
    triggerRef,
    listRef,
    contentHeightRef,
    insideSelector,
    onRequestClose,
    closeOnFocusLeave,
  } = input
  const gap = input.gap ?? POPOVER_GAP
  const margin = input.margin ?? POPOVER_MARGIN
  const maxHeight = input.maxHeight ?? POPOVER_MAX_HEIGHT
  const minHeight = input.minHeight ?? POPOVER_MIN_HEIGHT
  const desiredWidth = input.desiredWidth
  const offsetRef = React.useRef({ x: 0, y: 0 })
  const [box, setBox] = React.useState<SelectBox | null>(null)

  const place = React.useCallback((): void => {
    const trigger = (anchorRef ?? triggerRef)?.current ?? null
    const anchor = trigger?.getBoundingClientRect?.()
    if (anchor === undefined) { setBox(null); return }
    const content = listRef.current
    const inlineLeft = Number.parseFloat(content?.style?.left ?? '')
    const inlineTop = Number.parseFloat(content?.style?.top ?? '')
    const measured = content?.getBoundingClientRect?.()
    if (measured !== undefined && Number.isFinite(inlineLeft) && Number.isFinite(inlineTop)) {
      // The rendered inline coordinates and the element's own rect describe the same DOM epoch;
      // their difference is the real containing-block displacement. Assign (never accumulate)
      // so repeated place calls before the next commit stay idempotent.
      offsetRef.current = { x: inlineLeft - measured.left, y: inlineTop - measured.top }
    }
    const view = (trigger?.ownerDocument?.defaultView ?? globalThis) as { innerWidth?: number; innerHeight?: number }
    const width = typeof view.innerWidth === 'number' ? view.innerWidth : 1440
    const height = typeof view.innerHeight === 'number' ? view.innerHeight : 900
    const viewport: ClientRect = { left: 0, top: 0, right: width, bottom: height, width }
    const root = containmentRootOf(trigger)
    const rootRect = (root as { getBoundingClientRect?: () => ClientRect } | null)?.getBoundingClientRect?.()
    const bounds = rootRect === undefined ? viewport : intersectRect(viewport, rootRect)
    const next = placementOf({
      anchor, bounds, contentHeight: contentHeightRef.current, desiredWidth, gap, margin, maxHeight, minHeight,
    })
    setBox(next)
  }, [anchorRef, triggerRef, listRef, contentHeightRef, desiredWidth, gap, margin, maxHeight, minHeight])

  React.useEffect(() => {
    if (!open) return undefined
    const measured = listRef.current?.scrollHeight
    if (typeof measured === 'number' && measured > 0) contentHeightRef.current = measured
    place()
    const doc = (globalThis as { document?: ListenerTarget }).document
    const win = (globalThis as { window?: ListenerTarget }).window
    const onDown = (event: unknown): void => {
      const target = (event as { target?: { closest?: (selector: string) => unknown } } | null)?.target
      if (target?.closest !== undefined && target.closest(insideSelector) !== null) return
      onRequestClose('outside')
    }
    const onKeyDown = (event: unknown): void => {
      if ((event as { key?: unknown } | null)?.key === 'Escape') onRequestClose('escape')
    }
    const onReflow = (): void => { place() }
    const onFocusIn = (event: unknown): void => {
      const target = (event as { target?: unknown } | null)?.target
      if (anchorRef?.current?.contains?.(target) === true) return
      const content = listRef.current
      if (content !== undefined && content !== null && content.contains?.(target) === true) return
      onRequestClose('focus-leave')
    }
    doc?.addEventListener?.('pointerdown', onDown, true)
    doc?.addEventListener?.('keydown', onKeyDown)
    win?.addEventListener?.('scroll', onReflow, true)
    win?.addEventListener?.('resize', onReflow)
    if (closeOnFocusLeave === true) doc?.addEventListener?.('focusin', onFocusIn)
    return () => {
      doc?.removeEventListener?.('pointerdown', onDown, true)
      doc?.removeEventListener?.('keydown', onKeyDown)
      win?.removeEventListener?.('scroll', onReflow, true)
      win?.removeEventListener?.('resize', onReflow)
      if (closeOnFocusLeave === true) doc?.removeEventListener?.('focusin', onFocusIn)
    }
  }, [open, place, insideSelector, onRequestClose, anchorRef, listRef, contentHeightRef, closeOnFocusLeave])

  const frame = box === null ? null : {
    left: Math.round(box.left + offsetRef.current.x),
    top: Math.round(box.top + offsetRef.current.y),
    width: Math.round(box.width),
    maxHeight: Math.round(box.maxHeight),
  }
  return { box, frame, place }
}

export interface PopoverProps {
  box: SelectBox | null
  frame: PopoverFrame | null
  id?: string
  role?: string
  className?: string
  labelledBy?: string
  ariaLabel?: string
  ariaHidden?: boolean | 'true'
  /** Exit surface: hidden, inert and pointer-inactive until it unmounts. */
  inert?: boolean
  dataAttributes?: Record<string, string | undefined>
  onKeyDown?: (event: unknown) => void
  listRef?: React.MutableRefObject<PopoverContentNode | null>
  children?: React.ReactNode
}

/** Presentational popover surface; behaviour lives in `usePopover`. */
export function Popover(props: PopoverProps): React.ReactElement {
  const style = props.frame === null ? undefined : {
    left: `${String(props.frame.left)}px`,
    top: `${String(props.frame.top)}px`,
    width: `${String(props.frame.width)}px`,
    maxHeight: `${String(props.frame.maxHeight)}px`,
  }
  const attributes: Record<string, string | undefined> = { ...(props.dataAttributes ?? {}) }
  if (props.inert === true) attributes['data-crwu-exiting'] = 'true'
  const inertAttr = props.inert === true
    ? ({ inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>)
    : {}
  return <div
    id={props.id}
    ref={props.listRef as unknown as React.Ref<HTMLDivElement>}
    className={['crwu-ui-popover', props.className ?? ''].filter((one) => one !== '').join(' ')}
    role={props.role ?? 'dialog'}
    aria-labelledby={props.labelledBy}
    aria-label={props.ariaLabel}
    aria-hidden={props.ariaHidden}
    data-flip={props.box?.flip === true ? 'top' : 'bottom'}
    style={style}
    onKeyDown={props.onKeyDown}
    {...(attributes as unknown as React.HTMLAttributes<HTMLDivElement>)}
    {...inertAttr}
  >{props.children}</div>
}
