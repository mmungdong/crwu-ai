import type { ValuationPhase, ValuationProviderView, ValuationResultView } from '../contracts/report-evaluation.ts'

/**
 * 报告评估（房地产估值，协议 32）的**编译期线协议契约**。
 *
 * ## 这里能查什么、不能查什么
 *
 * 能查的：Client 侧读到的字段名与取值集合（阶段词、交易性质、方法）与线协议一致。
 * **不能**查的：Host 侧的内部记录类型（`ValuationRecord` 等）直接赋给这些视图 ——
 * 它不是线协议形状（字段名是 camelCase 的内部表达、且多出 `createdAt` 之类不上线的字段）。
 * 所以那一侧的对应关系由 Host 自己的测试钉住（`host-valuation-ops` / `host-valuation-lifecycle`），
 * 这里只钉"两端都认同一套词"。
 */

/** 阶段词：两侧必须是同一套（多一个少一个都会在这里红）。 */
export const VALUATION_PHASES: readonly ValuationPhase[] = [
  'draft', 'extracting', 'confirmation', 'queued', 'running',
  'browser-login-required', 'completed', 'failed', 'cancelled', 'stale-host',
]

/** 交易性质：只有这四种，界面按它分桶（成交才允许作可比实例）。 */
export const VALUATION_TRANSACTION_TYPES: readonly string[] = ['挂牌', '成交', '询价', '未知']

/** 方法：结论侧只有三种（`auto` 是用户输入，不是结论）。 */
export const VALUATION_CONCLUSION_METHODS: readonly string[] = ['market', 'income', 'cost']

/** 外部来源的展示行：`stateLabel` 与 `state` 必须同时在场（界面直接显示前者）。 */
export const PROVIDER_VIEW_SHAPE: (view: ValuationProviderView) => ValuationProviderView = (view) => view

/**
 * 结果视图的**关键约束**：缺的数字必须是 `null`。
 *
 * 这条不是形状检查（`number | null` 本来就允许 null），而是**语义提醒**：
 * 谁要是把缺失写成 0，类型系统不会拦，只有 `validate_result.py` 会。
 * 放在这里是因为估值链路里"0 与未知混同"是代价最高的一类错。
 */
export const RESULT_VIEW_KEEPS_NULL: (view: ValuationResultView) => ValuationResultView = (view) => view
