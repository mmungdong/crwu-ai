/**
 * 房地产估值的**业务知识路由与物化**（设计稿 §2.1 / §6）。
 *
 * 这一层只决定"该用哪一份知识、从哪来、缺了算不算致命"，以及把结果落成可核对的快照；
 * 取数（dws 命令）与落盘（案例目录写文件）由 Tool 注入。于是路径解析、同名恢复、
 * 镜像身份验证与规则段解析都能在没有真实知识库的情况下被穷尽单测。
 *
 * **"有哪些知识"由知识库侧 manifest 声明**（`manifest.ts`），这里不放路由表：
 * 改库即生效，不必发版。
 *
 * ⚠️ 这里**没有**本地 `references/` 兜底：生产正文只来自业务库（`dws`）或身份已验证镜像
 * （`verified-mirror`）。技能自带的 `references/knowledge-routing.md` 是技术合同，不是业务正文。
 */
export {
  BINARY_EXTENSIONS,
  KNOWLEDGE_INDEX_DIR,
  KNOWLEDGE_INDEX_FILE,
  KNOWLEDGE_SNAPSHOT_DIR,
  TEXT_EXTENSIONS,
  VALUATION_KNOWLEDGE_SPACE,
  VALUATION_METHODS,
  extensionsForKind,
  isValuationMethodKey,
} from './route.ts'
export type {
  KnowledgeRoute,
  KnowledgeRouteKind,
  RouteState,
  ValuationMethodKey,
} from './route.ts'
export {
  METHOD_SELECTION_ROUTE_ID,
  manifestRoutePath,
  methodGuideRouteId,
  methodTemplateRouteId,
  parseValuationManifest,
} from './manifest.ts'
export type { ManifestParseResult, ManifestRoute } from './manifest.ts'
export {
  KNOWLEDGE_INDEX_SCHEMA,
  byteLength,
  knowledgeDigest,
  knowledgeFileName,
  knowledgeSnapshotDigest,
  parseKnowledgeIndex,
  safeSnapshotRelative,
  toKnowledgeSourceDocument,
} from './snapshot.ts'
export type {
  KnowledgeIndexDocument,
  KnowledgeIndexReadResult,
  KnowledgeManifest,
  KnowledgeManifestEntry,
  KnowledgeManifestErrorKind,
  KnowledgeRouteOutcome,
} from './snapshot.ts'
export {
  knowledgeIdentityKey,
  materializeKnowledge,
  resolveRoute,
  snapshotFileFor,
  toKnowledgeRoute,
  wikiPathProblem,
  wikiRouteFromPath,
} from './resolve.ts'
export type {
  CatalogFile,
  KnowledgeCatalog,
  KnowledgeMaterializeDeps,
  KnowledgeMaterializeInput,
  RouteDocument,
  RouteResolution,
} from './resolve.ts'
export { loadVerifiedMirror, mirrorRootOf } from './mirror.ts'
export type { MirrorConfig, MirrorDocument, MirrorOutcome } from './mirror.ts'
export { verifyTemplateWorkbook } from './template-bytes.ts'
export type { TemplateByteCheck } from './template-bytes.ts'
export { NON_NEGOTIABLE_MISSING, parseRuleParameters } from './rules.ts'
export type {
  RuleAppliesTo,
  RuleBasisGrade,
  RuleComparison,
  RuleParameter,
  RuleParameterErrorKind,
  RuleParameterSet,
  RuleRounding,
  RuleSnapshotInput,
  RuleStrength,
  RuleValueKind,
} from './rules.ts'
