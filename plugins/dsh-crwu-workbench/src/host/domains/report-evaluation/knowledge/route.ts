/**
 * 房地产估值的知识路由**类型与常量**（设计稿 §4.1 / §4.3）。
 *
 * 这里**不再有路由表**。"有哪些知识、各在哪"由知识库侧 manifest 声明
 * （`manifest.ts` 解析、`config/crwu-workbench.yml` 的 `valuation.knowledge.manifestPath` 定位），
 * 所以改知识库即生效、无需发版。
 *
 * 三条口径：
 *
 * 1. **`routeId` 由 manifest 的键位推导**，不是库内路径。路径会随库改名变
 *    （2026-10-14 业务库把 `02-市场法` 改成了 `02 市场法`），槽位不该跟着变。
 * 2. **没有"必需项清单"**。除 manifest 本身读不到（没入口）之外，任何缺失都不阻断取数 ——
 *    逐条如实报 `RouteState`，由调用方按处置表决定。
 * 3. **没有本地 references 兜底**：正文只来自业务库（`dws`）或身份已验证镜像
 *    （`verified-mirror`）。技能自带的 `references/` 只留技术合同。
 */

/** 方法口径（`auto` = 由会话判定）。 */
export type ValuationMethodKey = 'auto' | 'market' | 'income' | 'cost'

export const VALUATION_METHODS: readonly ValuationMethodKey[] = ['auto', 'market', 'income', 'cost']

/** 路由命中判断的结论。写进报告时与 `schemas/valuation-report-data.schema.json` 的 outcome 同集合。 */
export type RouteState = 'found' | 'missing' | 'empty' | 'ambiguous' | 'unreadable'

/**
 * 节点形态：文档（文本通道）/ 二进制（模板，逐字节验真）。
 *
 * manifest 只推导出这两种 —— 正文槽位是 `document`，计算表模板槽位是 `binary`。
 */
export type KnowledgeRouteKind = 'document' | 'binary'

/** 一条取数路由：库内**完整路径** + 形态。 */
export interface KnowledgeRoute {
  /** 逻辑槽位，由 manifest 键位推导（`method-selection` / `method.<m>.guide` / `method.<m>.template`）。 */
  routeId: string
  /** 库内相对路径（不含库名），由 `manifestRoutePath` 拼出。 */
  path: string
  kind: KnowledgeRouteKind
  /** 同目录同名恢复允许的正文后缀（小写，不含点）。 */
  extensions: readonly string[]
}

/** 文本正文的后缀。 */
export const TEXT_EXTENSIONS: readonly string[] = ['md', 'adoc', 'txt']
/** 二进制模板的后缀。 */
export const BINARY_EXTENSIONS: readonly string[] = ['xlsx', 'xls', 'xlsm']

/** 形态 → 允许的后缀。 */
export function extensionsForKind(kind: KnowledgeRouteKind): readonly string[] {
  return kind === 'binary' ? BINARY_EXTENSIONS : TEXT_EXTENSIONS
}

/**
 * 知识库名称。
 *
 * 与审核链路默认的「中瑞世联评估审核知识库」**不是同一个库** —— 业务知识在
 * 「中瑞世联业务知识库」下。名称在这里只写一次，工具与测试共用。
 */
export const VALUATION_KNOWLEDGE_SPACE = '中瑞世联业务知识库'

/** 估值案例目录内的知识快照目录与索引文件名。 */
export const KNOWLEDGE_SNAPSHOT_DIR = '知识快照'
/** 汇总索引（Host 内部证据；每路由一份 schema 文档在 `KNOWLEDGE_INDEX_DIR` 下）。 */
export const KNOWLEDGE_INDEX_FILE = '.知识来源.json'
/** 每路由一份 `knowledge-source.schema.json` 文档的目录。 */
export const KNOWLEDGE_INDEX_DIR = '知识来源'

/** 方法取值收窄。 */
export function isValuationMethodKey(value: unknown): value is ValuationMethodKey {
  return VALUATION_METHODS.includes(String(value ?? '').trim() as ValuationMethodKey)
}
