/**
 * Host capability bundle for the reusable valuation business services.
 *
 * The types are imported from their owning modules (not from the Tool dependency
 * bag), so the services stay usable by the future project runtime without pulling in
 * Tool-only fields.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WorkbenchConfig } from '../../../config/config.ts'
import type { LocalAccessBroker } from '../../../core/access/broker.ts'
import type { WorldFacts } from '../../../core/platform/world.ts'
import type { PythonRuntimeResolver } from '../../../core/runtime/python.ts'
import type { ValuationScopeService } from '../../../domains/report-evaluation/scope.ts'

export interface HostWorkflowServiceDeps {
  ctx: Context
  config: WorkbenchConfig
  access: LocalAccessBroker
  world: WorldFacts
  python?: PythonRuntimeResolver
  valuationScopes?: ValuationScopeService
  /** Stable object that owns the per-plugin catalog cache (ToolDeps today). */
  cacheOwner?: object
}
