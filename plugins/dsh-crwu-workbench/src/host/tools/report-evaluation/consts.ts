/**
 * 报告评估（房地产估值）Tool 的名字、分组与固定目录名。
 *
 * 与 `tools/report-audit/consts.ts` 同一套理由：名字是跨进程契约的一部分（技能正文、估值提示词、
 * 能力门禁与测试都逐字引用），所以只在这里写一份。
 */

/** 估值案例目录内的固定子目录与文件名（提示词与校验脚本都引用它们）。 */
export const VALUATION_MATERIAL_DIR = '材料-源'
export const VALUATION_EVIDENCE_DIR = '来源证据'
export const VALUATION_KNOWLEDGE_DIR = '知识快照'
export const VALUATION_INPUT_FILE = '估值输入.json'
export const VALUATION_OBJECT_FILE = '估值对象.json'
export const VALUATION_CASES_FILE = '估值案例.json'
export const VALUATION_PARAMS_FILE = '估值参数.json'
/** v2 delivery data (validated by `build_report_data.py --validate`). */
export const VALUATION_REPORT_DATA_FILE = '估值报告数据.json'
export const VALUATION_REPORT_FILE = '估值报告.html'
export const VALUATION_WORKBOOK_FILE = '估值底稿.xlsx'
/** v2 项目索引：项目 → 方案 → 对象 + 执行任务图。 */
export const VALUATION_PROJECT_INDEX_FILE = '项目估值方案索引.json'

/**
 * **估值链路**必需（也允许）的工具集。
 *
 * ⚠️ 它**不属于** `REQUIRED_AUDIT_TOOLS`：审核能力门禁回答的是"起审核之前必须看到什么"，
 * 估值是另一条业务链路，混进那张名单会让审核因为"估值工具不在"而拒绝启动。
 *
 * 第一条（bootstrap）由 Host 在会话开始之前调用一次；其余是估值会话自己要用的。
 * 这份名单**真的会被用来预检**（见 `visibility.ts`）：写在常量里不等于宿主注册了它们。
 */
export const VALUATION_CHILD_TOOLS = [
  'crwu_valuation_case_bootstrap',
  'crwu_valuation_file_extract',
  'crwu_valuation_knowledge_materialize',
  'crwu_valuation_template_materialize',
  'crwu_valuation_browser_preflight',
  'crwu_valuation_market_search',
  'crwu_valuation_market_capture',
  'crwu_valuation_browser_recover',
  'crwu_valuation_artifact_validate',
  'crwu_valuation_finalize',
  'crwu_valuation_project_prepare',
  'crwu_valuation_execution_dispatch',
  'crwu_valuation_execution_join',
  'crwu_valuation_revision',
  'crwu_valuation_recalculate',
  'crwu_valuation_listing_reference',
  'crwu_run_python_script',
] as const

export const VALUATION_TOOL_NAMES = {
  caseBootstrap: 'crwu_valuation_case_bootstrap',
  fileExtract: 'crwu_valuation_file_extract',
  knowledgeMaterialize: 'crwu_valuation_knowledge_materialize',
  templateMaterialize: 'crwu_valuation_template_materialize',
  browserPreflight: 'crwu_valuation_browser_preflight',
  marketSearch: 'crwu_valuation_market_search',
  marketCapture: 'crwu_valuation_market_capture',
  browserRecover: 'crwu_valuation_browser_recover',
  finalize: 'crwu_valuation_finalize',
  projectPrepare: 'crwu_valuation_project_prepare',
  executionDispatch: 'crwu_valuation_execution_dispatch',
  executionJoin: 'crwu_valuation_execution_join',
  /** 候选案例的稳定编号册与修订版本（协议 39：用户按编号选例 → 新版 + 旧版保留）。 */
  revision: 'crwu_valuation_revision',
  /** 用部署配置的表格程序真正重算并回读，Host 自己写重算结论（协议 39）。 */
  recalculate: 'crwu_valuation_recalculate',
  artifactValidate: 'crwu_valuation_artifact_validate',
  /** 挂牌参考一次性交付：固定输入 + 打包脚本 + 四件产物（只可能 partial）。 */
  listingReference: 'crwu_valuation_listing_reference',
} as const
