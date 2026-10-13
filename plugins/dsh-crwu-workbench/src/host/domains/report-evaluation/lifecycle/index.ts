/** 估值轮次的状态机与进程内注册表（协议 32）。 */
export {
  TERMINAL_PHASES,
  advance,
  canAdvance,
  emptyArtifacts,
  emptyProgress,
  isTerminalPhase,
  normalizeProgress,
  phaseWithHostProtocol,
} from './state.ts'
export type {
  AdvanceOutcome,
  ArtifactPresence,
  ProviderState,
  RecordPatch,
  ValuationPhase,
  ValuationProgress,
  ValuationRecord,
} from './state.ts'
export { ValuationLifecycles } from './registry.ts'
export type { OpenOutcome, RegistryOptions } from './registry.ts'
