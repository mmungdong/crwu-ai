/**
 * 报告评估的**业务知识路由**（协议 32）。
 *
 * 这一层只决定"该用哪一份知识、来源是什么"；取数与落盘由 Tool 负责。
 * 决策逻辑（`resolve.ts`）是纯函数 + 注入探针，所以五条降级规则可以被穷尽单测，
 * 而不必先有一个可用的知识库。
 */
export {
  KNOWLEDGE_INDEX_FILE,
  KNOWLEDGE_SNAPSHOT_DIR,
  KNOWLEDGE_SUBDOMAIN,
  REQUIRED_KNOWLEDGE_ROUTES,
  VALUATION_KNOWLEDGE_ROUTES,
  VALUATION_KNOWLEDGE_SPACE,
  routeByNode,
  routeByPath,
  routesForMethod,
} from './route.ts'
export type { KnowledgeOrigin, KnowledgeRoute, ValuationMethodKey } from './route.ts'
export {
  buildKnowledgeSource,
  byteLength,
  knowledgeDigest,
  knowledgeSnapshotDigest,
  knowledgeSourcesView,
} from './snapshot.ts'
export type { KnowledgeSource, KnowledgeSourceView } from './snapshot.ts'
export {
  knowledgeBodyBytes,
  knowledgeFileName,
  knowledgeNodeNames,
  knowledgeRouteChecklist,
  resolveKnowledgePlan,
} from './resolve.ts'
export type {
  KnowledgeBody,
  KnowledgeProbe,
  KnowledgeProbeResult,
  ResolveKnowledgeInput,
  ResolvedKnowledge,
} from './resolve.ts'
export {
  VALUATION_SKILL_DIR,
  emptyKnowledgeProbe,
  localKnowledgeProbe,
  localReferenceBytes,
  localReferencePath,
  missingLocalReferences,
  valuationPackageRoot,
} from './fallback.ts'
