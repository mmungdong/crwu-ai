import type { Agent } from '@deepseek-ai/dsh-agent'

export interface AuditChildRun {
  id: string
  localAgent?: Agent
  result?: Promise<unknown>
  dispose?: () => Promise<void>
}

interface AuditProvider {
  capabilities?: { toolFilter?: boolean; agentPreset?: boolean }
  prepareContinuable?: unknown
}

/** The live service, rather than the installed SDK, selects the supported entry. */
export interface AuditSubagentRuntime {
  list(): string[]
  getProvider?(name: string): AuditProvider | undefined
  start?(name: string, request: Record<string, unknown>): Promise<AuditChildRun>
  startActivation?(spec: Record<string, unknown>): Promise<{
    childId?: string
    result?: Promise<unknown>
    dispose?: () => Promise<void>
  }>
  interrupt?(childId: string, authority: { kind: 'user'; parentSessionId: string }): void
}
