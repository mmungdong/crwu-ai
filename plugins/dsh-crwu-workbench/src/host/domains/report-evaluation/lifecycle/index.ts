/** 估值轮次的状态机、进程内注册表、项目记录与归属恢复（协议 32）。 */
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
export {
  PROJECT_RECORD_FILE,
  PROJECT_RECORD_SCHEMA_VERSION,
  buildProjectRecord,
  materialOfEntry,
  projectRecordCompatibility,
  projectRecordFiles,
  projectRecordFinished,
  projectRecordOf,
} from './project-record.ts'
export type {
  ProjectRecord,
  ProjectRecordFileEntry,
  ProjectRecordPayload,
  ProjectRecordRead,
} from './project-record.ts'
export { resumeProject } from './resume.ts'
export type {
  ResumeDeps,
  ResumeLifecycles,
  ResumeOutcome,
  ResumeRequest,
  ResumeWorkspace,
} from './resume.ts'
