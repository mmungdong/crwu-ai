/**
 * Shared popover geometry. Pure functions only, so the browser and the fake-DOM tests
 * compute the same placement.
 */

export interface ClientRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
}

export const POPOVER_GAP = 8
export const POPOVER_MARGIN = 8
export const POPOVER_MAX_HEIGHT = 280
export const POPOVER_MIN_HEIGHT = 96
export const POPOVER_CLOSE_MS = 110
export const POPOVER_ROW_HEIGHT = 44
export const POPOVER_ROW_HEIGHT_HINT = 60
export const POPOVER_WIDTH = 288

export interface SelectBox {
  left: number
  top: number
  width: number
  maxHeight: number
  flip: boolean
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low
  return Math.min(Math.max(value, low), high)
}

/** Available area = viewport ∩ containing block. */
export function intersectRect(a: ClientRect, b: ClientRect): ClientRect {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.right, b.right)
  const bottom = Math.min(a.bottom, b.bottom)
  return { left, top, right, bottom, width: Math.max(0, right - left) }
}

export interface PlacementInput {
  anchor: ClientRect
  bounds: ClientRect
  contentHeight: number
  /** Optional preferred width; defaults to the anchor width and is clamped to the bounds. */
  desiredWidth?: number
  gap?: number
  margin?: number
  maxHeight?: number
  minHeight?: number
}

/**
 * Below the anchor by default, anchor width unless a desired width is given; flips above when
 * the bottom is short and the top is roomier; always clamped inside the available area.
 */
export function placementOf(input: PlacementInput): SelectBox {
  const { anchor, bounds } = input
  const gap = input.gap ?? POPOVER_GAP
  const margin = input.margin ?? POPOVER_MARGIN
  const heightLimit = input.maxHeight ?? POPOVER_MAX_HEIGHT
  const minHeight = input.minHeight ?? POPOVER_MIN_HEIGHT
  const availableWidth = Math.max(0, bounds.right - bounds.left - margin * 2)
  const width = Math.max(0, Math.min(input.desiredWidth ?? anchor.width, availableWidth))
  const below = bounds.bottom - (anchor.bottom + gap) - margin
  const above = (anchor.top - gap) - bounds.top - margin
  const flip = input.contentHeight > below && above > below
  const space = Math.max(minHeight, flip ? above : below)
  const maxHeight = Math.min(heightLimit, space)
  const height = Math.min(Math.max(input.contentHeight, 0), maxHeight)
  const rawTop = flip ? anchor.top - gap - height : anchor.bottom + gap
  return {
    left: clamp(anchor.left, bounds.left + margin, bounds.right - margin - width),
    top: clamp(rawTop, bounds.top + margin, bounds.bottom - margin - height),
    width,
    maxHeight,
    flip,
  }
}

/**
 * Nearest ancestor that establishes a containing block for `position: fixed`.
 *
 * container-type is deliberately ignored: Chromium reports `contain: none` for it and does
 * not make it the containing block, so trusting it would push the popover off target.
 */
export function containmentRootOf(node: { parentElement?: unknown } | null): unknown {
  let current = (node?.parentElement ?? null) as null | {
    parentElement?: unknown
    ownerDocument?: { defaultView?: { getComputedStyle?: (element: unknown) => Record<string, string> } } | null
  }
  while (current !== null && current !== undefined) {
    const view = current.ownerDocument?.defaultView
    const styleOf = view?.getComputedStyle
    if (typeof styleOf === 'function') {
      let style: Record<string, string> | null = null
      try { style = styleOf.call(view, current) } catch (error) { void error }
      if (style !== null) {
        const contain = style.contain ?? ''
        const willChange = style.willChange ?? ''
        if ((style.transform ?? 'none') !== 'none'
          || (style.filter ?? 'none') !== 'none'
          || (style.perspective ?? 'none') !== 'none'
          || (style.backdropFilter ?? 'none') !== 'none'
          || contain.includes('layout') || contain.includes('paint')
          || willChange.includes('transform')) {
          return current
        }
        void style.containerType
      }
    }
    current = (current.parentElement ?? null) as typeof current
  }
  return null
}
