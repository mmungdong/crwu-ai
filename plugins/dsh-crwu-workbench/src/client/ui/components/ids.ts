import * as React from 'react'

let counter = 0

/**
 * Monotonic process-local id. The test renderer has no useId, and business names can repeat
 * across mounts, so every component instance takes its own suffix from here.
 */
export function nextInstanceId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter.toString(36)}`
}

/** Stable id for the lifetime of one component instance. */
export function useInstanceId(prefix: string): string {
  const ref = React.useRef<string | null>(null)
  let id = ref.current
  if (id === null) {
    id = nextInstanceId(prefix)
    ref.current = id
  }
  return id
}
