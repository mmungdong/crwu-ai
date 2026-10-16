/**
 * Shared select model: keyboard intents, typeahead and the single-open registry.
 * Pure except for the module-level registry, which is coordinated by unique instance keys.
 */

import {
  POPOVER_CLOSE_MS,
  POPOVER_GAP,
  POPOVER_MARGIN,
  POPOVER_MAX_HEIGHT,
  POPOVER_MIN_HEIGHT,
  POPOVER_ROW_HEIGHT,
  POPOVER_ROW_HEIGHT_HINT,
} from './popover-model.ts'

export const SELECT_GAP = POPOVER_GAP
export const SELECT_MARGIN = POPOVER_MARGIN
export const SELECT_MAX_HEIGHT = POPOVER_MAX_HEIGHT
export const SELECT_MIN_HEIGHT = POPOVER_MIN_HEIGHT
export const SELECT_CLOSE_MS = POPOVER_CLOSE_MS
export const SELECT_ROW_HEIGHT = POPOVER_ROW_HEIGHT
export const SELECT_ROW_HEIGHT_HINT = POPOVER_ROW_HEIGHT_HINT

export type SelectIntent =
  | { kind: 'none' }
  | { kind: 'tab' }
  | { kind: 'close' }
  | { kind: 'open'; active: number }
  | { kind: 'move'; active: number }
  | { kind: 'commit'; active: number }

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low
  return Math.min(Math.max(value, low), high)
}

function wrap(index: number, count: number): number {
  return ((index % count) + count) % count
}

/** What one key press should do; Tab is separate so it closes without stopping the event. */
export function selectIntentFor(input: {
  key: string
  open: boolean
  active: number
  count: number
  selected: number
}): SelectIntent {
  const { key, open, count, selected } = input
  if (key === 'Tab') return { kind: 'tab' }
  if (count <= 0) return { kind: 'none' }
  const active = clamp(input.active, 0, count - 1)
  const initial = selected >= 0 && selected < count ? selected : 0
  switch (key) {
    case 'Escape':
      return open ? { kind: 'close' } : { kind: 'none' }
    case 'ArrowDown':
      return open ? { kind: 'move', active: wrap(active + 1, count) } : { kind: 'open', active: initial }
    case 'ArrowUp':
      return open
        ? { kind: 'move', active: wrap(active - 1, count) }
        : { kind: 'open', active: selected >= 0 && selected < count ? selected : count - 1 }
    case 'Home':
      return open ? { kind: 'move', active: 0 } : { kind: 'none' }
    case 'End':
      return open ? { kind: 'move', active: count - 1 } : { kind: 'none' }
    case 'Enter':
    case ' ':
      return open ? { kind: 'commit', active } : { kind: 'open', active: initial }
    default:
      return { kind: 'none' }
  }
}

/** First label that starts with the buffer, or -1. */
export function typeaheadIndexOf(labels: readonly string[], buffer: string): number {
  const needle = buffer.trim().toLowerCase()
  if (needle === '') return -1
  return labels.findIndex((label) => label.trim().toLowerCase().startsWith(needle))
}

/** Typeahead buffer lifetime. */
export const TYPEAHEAD_MS = 600

export interface SelectRegistry {
  openId: () => string
  claim: (id: string, close: () => void) => void
  release: (id: string) => void
}

/** Only one popup may be open at a time. */
export const selectRegistry: SelectRegistry = {
  openId: () => state.id,
  claim: (id, close) => {
    if (state.id !== '' && state.id !== id) state.close?.()
    state.id = id
    state.close = close
  },
  release: (id) => {
    if (state.id !== id) return
    state.id = ''
    state.close = null
  },
}

const state: { id: string; close: (() => void) | null } = { id: '', close: null }

/** Test-only reset; production code never calls this. */
export function resetSelectRegistry(): void {
  state.id = ''
  state.close = null
}
