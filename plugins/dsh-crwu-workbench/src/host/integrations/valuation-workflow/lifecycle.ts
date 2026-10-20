/**
 * Bounded child cleanup shared by the DSH valuation adapters.
 *
 * Disposal is allowed to fail or hang, but a caller must never wait forever.
 * A timed-out dispose is reported as an unknown stop; its eventual settlement
 * is contained and cannot publish a business result.
 */

export const DEFAULT_STOP_TIMEOUT_MS = 5000
const MAX_STOP_TIMEOUT_MS = 60000

export const STOP_UNKNOWN_ERROR = '停止子会话失败，静止状态未知：请由 Host 诊断占用后重试'

export interface DisposableRun {
  dispose(): Promise<void>
}

/** Resolve a positive, finite, bounded stop timeout; otherwise use the default. */
export function resolveStopTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_STOP_TIMEOUT_MS
  }
  return Math.max(1, Math.min(Math.floor(value), MAX_STOP_TIMEOUT_MS))
}

/**
 * Await disposal only within the configured bound. Returns false on rejection,
 * synchronous throw or timeout. The disposal promise is always observed so a
 * late rejection cannot become an unhandled rejection.
 */
export async function stopChild(run: DisposableRun, timeoutMs: number): Promise<boolean> {
  const disposal = Promise.resolve()
    .then(() => run.dispose())
    .then(() => true)
    .catch(() => false)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })

  try {
    return (await Promise.race([disposal, timedOut])) === true
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
