/**
 * Error kinds produced by the reusable Host business services.
 *
 * A deliberate subset of the registered Tool error union, typed locally so service
 * results can be passed to the shared `failure(...)` helper without `any` casts and
 * without importing the whole Tool layer into the integration.
 */
export type ValuationServiceErrorKind =
  | ''
  | 'input'
  | 'capability-gap'
  | 'approval'
  | 'infrastructure'
  | 'file'
  | 'cancelled'
  | 'cli'
  | 'not-found'
  | 'policy'
