/**
 * Start adapter across the two DSH subagent lines this plugin declares.
 *
 * `0.1.7` line: the service exposes `start(name, request)` and returns a run
 * carrying `id` / `localAgent` / `result` / `dispose`; the provider declares
 * `capabilities.toolFilter`, so a caller may ask for `toolFilter: { allow: [] }`.
 *
 * `0.2.x` line (the deployed desktop runtime ships `0.2.1-rc.2`): the same
 * service exposes `startActivation(spec)` and returns
 * `{ childId, result, dispose }`, the child request travels inside
 * `spec.request`, and the provider declares `agentPreset` instead of
 * `toolFilter`/`persona` — `toolFilter` is no longer a start-time capability.
 *
 * Tool isolation is line-specific. The `0.1.7` request carries
 * `toolFilter: { allow: [] }` and requires the provider capability. The `0.2.x`
 * request has no tool filter, so the caller reserves the native child session
 * id, watches `agent/created` for exactly that id before publication, and
 * applies the child-scoped `tools.restrict({ allow: [] })` synchronously. A
 * child whose restriction cannot be applied to the reserved id is never
 * accepted as a receipt.
 *
 * Why detection instead of a version check: the plugin declares both lines and
 * only the live service object answers which one is loaded. Calling one name
 * unconditionally fails closed on the other line, and every caller then reports
 * the same collapsed "no eligible provider / service unverifiable" gap — which
 * is how the valuation workflow ended up never starting a page-reading child.
 */
import { randomUUID } from 'node:crypto'
import { text } from '../../../shared/utils/value.ts'

/** Provider capability flags are read as facts, never assumed. */
export interface SubagentCapabilitiesLike {
  toolFilter?: boolean
  outputSchema?: boolean
  agentPreset?: boolean
}

export interface SubagentProviderLike {
  name?: string
  inheritsParentContext?: boolean
  capabilities?: SubagentCapabilitiesLike
  /**
   * Method presence IS the local backend marker on the `0.2.x` line: the service
   * routes `prepareContinuable` providers to the in-process child path and every
   * other provider to the external path.
   */
  prepareContinuable?: unknown
}

export interface SubagentStructuredResult {
  output?: unknown
  stopReason?: string
  structured?: unknown
  diagnostic?: unknown
}

/** One published child, normalized across both lines. */
export interface SubagentRunLike {
  id?: string
  /** `local` is a verified fact from the loaded API, not a caller assumption. */
  local: boolean
  result: Promise<SubagentStructuredResult>
  dispose(): Promise<void>
}

/** The `0.1.7` line's published one-shot handle. */
export interface SubagentLegacyRunLike {
  id?: string
  localAgent?: unknown
  result: Promise<SubagentStructuredResult>
  dispose(): Promise<void>
}

/** The `0.2.x` activation receipt. */
export interface SubagentActivationLike {
  childId?: string
  result?: Promise<SubagentStructuredResult>
  dispose?: () => Promise<void>
}

export interface SubagentRuntimeLike {
  list(): string[]
  getProvider(name: string): SubagentProviderLike | undefined
  /** `0.1.7` line. */
  start?(name: string, request: Record<string, unknown>): Promise<SubagentLegacyRunLike>
  /** `0.2.x` line. */
  startActivation?(spec: Record<string, unknown>): Promise<SubagentActivationLike>
}

/** The freshly registered native child observed through `agent/created`. */
export interface SubagentCreatedAgentLike {
  id?: unknown
  session?: { header?: { id?: unknown; parentSession?: unknown } }
  /** Scoped child context; the tools service here is the real capability boundary. */
  ctx?: { get?(name: string): unknown }
}

export interface SubagentCreatedPayloadLike {
  agent?: SubagentCreatedAgentLike
  source?: unknown
  signal?: unknown
}

/** The scoped `tools` service; `restrict` narrows this child only. */
interface ChildToolsLike {
  restrict?(filter: { allow: string[] }): unknown
}

/**
 * The narrow slice of the caller context the activation path needs.
 *
 * `on('agent/created', ...)` is the only prepublication window in which the
 * native manager has not yet released the child to its first model turn, so the
 * restriction installed there is what makes the isolation real. `global: true`
 * is required because the child context is not the caller's scope.
 */
export interface SubagentStartContextLike {
  on?(
    event: 'agent/created',
    listener: (payload: SubagentCreatedPayloadLike) => undefined | Promise<undefined>,
    options: { global: true },
  ): (() => void) | undefined
}

export interface SubagentStartInput {
  label: string
  prompt: Array<Record<string, unknown>>
  parent: unknown
  signal: AbortSignal
  /** JSON Schema for the structured answer; the service validates it as a fact. */
  outputSchema: unknown
}

export type SubagentStartRefusal =
  /** Neither line of the service entry point is present. */
  | 'service-unverifiable'
  /** No provider is both fresh and able to enforce the structured contract. */
  | 'no-eligible-provider'
  /** The activation receipt is missing the identity, result or disposal a caller must verify. */
  | 'unverifiable-activation'

/** Whether the live service exposes either entry point. */
export function hasSubagentStart(runtime: SubagentRuntimeLike | undefined): boolean {
  if (runtime === undefined) return false
  if (typeof runtime.list !== 'function' || typeof runtime.getProvider !== 'function') return false
  return typeof runtime.startActivation === 'function' || typeof runtime.start === 'function'
}

/**
 * Whether one provider can host a fresh child with real tool isolation.
 *
 * Both lines require `inheritsParentContext=false` and `outputSchema`. They
 * differ on isolation: the legacy line narrows through the provider's
 * `toolFilter` capability, while activation requires the provider to be local
 * (`prepareContinuable`), since only then can the caller observe the child's
 * scoped tools and restrict them before the first model turn.
 */
function providerIsEligible(provider: SubagentProviderLike | undefined, activationLine: boolean): boolean {
  if (provider === undefined) return false
  if (provider.inheritsParentContext !== false) return false
  if (provider.capabilities?.outputSchema !== true) return false
  if (activationLine) return typeof provider.prepareContinuable === 'function'
  return provider.capabilities?.toolFilter === true
}

/**
 * Pick the provider to delegate to: fresh context, the structured contract, and
 * the isolation mechanism of the loaded line.
 */
export function eligibleProvider(
  runtime: SubagentRuntimeLike,
): { name: string; provider: SubagentProviderLike } | null {
  const activationLine = typeof runtime.startActivation === 'function'
  let names: string[]
  try {
    names = runtime.list()
  } catch {
    return null
  }
  const eligible: Array<{ name: string; provider: SubagentProviderLike }> = []
  for (const name of names) {
    let provider: SubagentProviderLike | undefined
    try {
      provider = runtime.getProvider(name)
    } catch {
      continue
    }
    if (!providerIsEligible(provider, activationLine)) continue
    eligible.push({ name, provider: provider as SubagentProviderLike })
  }
  if (eligible.length === 0) return null
  return eligible.find((item) => item.name === 'spawn') ?? eligible[0] ?? null
}

/** Native child session id shape; the reserved id is what the manager publishes. */
function mintActivationSessionId(): string {
  return `session-${randomUUID()}`
}

/** The parent session id the activation child must be attached to. */
function parentSessionIdOf(parent: unknown): string {
  if (parent === null || typeof parent !== 'object') return ''
  return text((parent as { id?: unknown }).id)
}

/**
 * Start one child and normalize its handle.
 *
 * The returned run always carries a non-empty `id`, a real `result` promise, a
 * `dispose`, and a verified `local` fact: a caller that cannot establish those
 * refuses the run instead of publishing an unverifiable result.
 *
 * The activation line has no start-time tool filter, so isolation is installed
 * by the caller: reserve the child id, restrict exactly that child's scoped
 * tools inside `agent/created` before publication. A receipt whose id or
 * applied restriction does not match that reservation is returned as a
 * non-local run, so the caller journals the real id and the bounded stop path
 * owns cleanup instead of a fabricated success.
 */
export async function startSubagentChild(
  runtime: SubagentRuntimeLike,
  ctx: SubagentStartContextLike | undefined,
  provider: SubagentProviderLike,
  name: string,
  input: SubagentStartInput,
): Promise<{ ok: true; run: SubagentRunLike } | { ok: false; refusal: SubagentStartRefusal }> {
  if (typeof runtime.startActivation === 'function') {
    // Only the local continuation backend exposes the child's scoped tools; an
    // external provider is refused before any child is spawned.
    if (typeof provider.prepareContinuable !== 'function') return { ok: false, refusal: 'no-eligible-provider' }
    if (ctx === undefined || typeof ctx.on !== 'function') return { ok: false, refusal: 'unverifiable-activation' }
    const parentId = parentSessionIdOf(input.parent)
    if (parentId === '') return { ok: false, refusal: 'unverifiable-activation' }
    const sessionId = mintActivationSessionId()
    let restricted = false
    let removeListener: (() => void) | undefined
    try {
      const removed = ctx.on('agent/created', (payload) => {
        const agent = payload?.agent
        // Only the reserved child may be touched; other creations pass through.
        if (text(agent?.id) !== sessionId) return undefined
        if (text(agent?.session?.header?.id) !== sessionId) throw new Error('activation child id mismatch')
        if (text(agent?.session?.header?.parentSession) !== parentId) {
          throw new Error('activation child parent mismatch')
        }
        const tools = agent?.ctx?.get?.('tools') as ChildToolsLike | undefined
        if (tools === undefined || typeof tools.restrict !== 'function') {
          throw new Error('activation child tools are not restrictable')
        }
        // Synchronous: the first model turn must not start before this applies.
        tools.restrict({ allow: [] })
        restricted = true
        return undefined
      }, { global: true })
      // A start whose temporary listener cannot be removed would leave a
      // process-wide hook behind: refuse before spawning anything.
      if (typeof removed !== 'function') return { ok: false, refusal: 'unverifiable-activation' }
      removeListener = removed

      const activation = await runtime.startActivation({
        childId: sessionId,
        provider: name,
        label: input.label,
        // `delivery: 'caller'` keeps the result with this caller: no settlement
        // message is injected into the workflow session.
        delivery: 'caller',
        signal: input.signal,
        request: {
          prompt: input.prompt,
          parent: input.parent,
          outputSchema: input.outputSchema,
        },
      })
      if (activation === undefined || activation.result === undefined || typeof activation.dispose !== 'function') {
        return { ok: false, refusal: 'unverifiable-activation' }
      }
      const result = activation.result
      const dispose = activation.dispose
      const id = text(activation.childId).trim()
      if (id === '') return { ok: false, refusal: 'unverifiable-activation' }
      // A real, stoppable receipt that is not the reserved/restricted child is
      // returned as a non-local run: the caller journals the actual id and the
      // bounded stop path reports stop-unknown instead of a fabricated result.
      if (id !== sessionId || !restricted) {
        return { ok: true, run: { id, local: false, result, dispose } }
      }
      return {
        ok: true,
        run: {
          id,
          // `prepareContinuable` was required above: the service routes this
          // provider to the in-process child path, which is the local marker.
          local: true,
          result,
          dispose,
        },
      }
    } catch {
      // The listener refused before publication, so no receipt is published.
      return { ok: false, refusal: 'unverifiable-activation' }
    } finally {
      // Only the temporary listener is removed; the child context owns the
      // restriction for the life of the child.
      removeListener?.()
    }
  }

  if (typeof runtime.start === 'function') {
    if (provider.capabilities?.outputSchema !== true || provider.capabilities?.toolFilter !== true) {
      return { ok: false, refusal: 'no-eligible-provider' }
    }
    const request: Record<string, unknown> = {
      label: input.label,
      prompt: input.prompt,
      parent: input.parent,
      signal: input.signal,
      outputSchema: input.outputSchema,
      // Legacy isolation is a real start-time capability on this line.
      toolFilter: { allow: [] },
    }
    const run = await runtime.start(name, request)
    return {
      ok: true,
      run: {
        id: run.id,
        local: run.localAgent !== null && typeof run.localAgent === 'object',
        result: run.result,
        dispose: run.dispose,
      },
    }
  }

  return { ok: false, refusal: 'service-unverifiable' }
}
