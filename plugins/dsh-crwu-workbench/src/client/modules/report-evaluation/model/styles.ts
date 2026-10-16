/**
 * 报告评估（房地产估值，协议 35）的**稳定类名**。
 *
 * 与本地审核同一条口径：类名常量留在模块的 model 里（组件、用例共用一份），
 * 样式文本跟着所有者走 —— 见 `../styles/pane.ts`，作用域由 `styles/bundle.ts` 统一加。
 *
 * 改这里的名字必须同时改三处：组件上的字面量、`install/browser-check.mjs` 的选择器、
 * 以及 `client-valuation-pane.test.mjs` 里那条"常量与字面量一致"的断言。
 */
import { CRWU_SELECT_CLASSES } from '../../../ui/components/Select.tsx'

export const VALUATION_CLASSES = {
  /** 页面根（一层 Workspace Surface 的内容区）。 */
  pane: 'crwu-valuation',
  /** 案例来源**能力区**（协议 39 起不再是门禁屏；类名留给既有样式与浏览器检查选择器）。 */
  capabilityArea: 'crwu-valuation-auth',
  /** 一条登录任务的提示行。 */
  authJob: 'crwu-valuation-auth-job',
  /** 登录任务提示行里的文字。 */
  authJobText: 'crwu-valuation-auth-job-text',
  /** 单工作面（资料 → 必填两项 → 补充条件 → 信息获取辅助 → 操作栏）。 */
  intake: 'crwu-valuation-intake',
  /** 两个必填项的并排行（容器够宽时两列等宽，窄面板纵向堆叠）。 */
  requiredRow: 'crwu-valuation-required',
  /** 一个字段的容器（标签 + 控件 + 说明/错误，纵向 8px）。 */
  field: 'crwu-valuation-field',
  /** 字段标签（14px/600，与控件同宽）。 */
  fieldLabel: 'crwu-valuation-field-label',
  /** 必填标记（星号视觉 + 读屏文字）。 */
  fieldRequired: 'crwu-valuation-field-required',
  /** 可选标记（「补充条件 · 可选」那一档）。 */
  fieldOptional: 'crwu-valuation-field-optional',
  /** 字段级错误（短句，紧贴控件下方）。 */
  fieldError: 'crwu-valuation-field-error',
  /** 补充条件的三列网格（宽三列 / 中两列 / 窄一列）。 */
  conditions: 'crwu-valuation-conditions',
  /** Deprecated valuation select aliases: the shared public select classmap now owns them. */
  selectRoot: CRWU_SELECT_CLASSES.root,
  selectTrigger: CRWU_SELECT_CLASSES.trigger,
  selectValue: CRWU_SELECT_CLASSES.value,
  selectPlaceholder: CRWU_SELECT_CLASSES.placeholder,
  selectChevron: CRWU_SELECT_CLASSES.chevron,
  selectList: CRWU_SELECT_CLASSES.list,
  selectListOut: CRWU_SELECT_CLASSES.listOut,
  selectOption: CRWU_SELECT_CLASSES.option,
  selectOptionActive: CRWU_SELECT_CLASSES.optionActive,
  selectOptionMark: CRWU_SELECT_CLASSES.optionMark,
  selectOptionMain: CRWU_SELECT_CLASSES.optionMain,
  selectOptionLabel: CRWU_SELECT_CLASSES.optionLabel,
  selectOptionHint: CRWU_SELECT_CLASSES.optionHint,
  selectOptionBadge: CRWU_SELECT_CLASSES.optionBadge,
  /** 信息获取辅助区的摘要行（始终可见，详情按需展开）。 */
  capabilitySummary: 'crwu-valuation-capability-summary',
  capabilityDetails: 'crwu-valuation-capability-details',
  /** 摘要行里的状态词（已登录 / 未登录 / 尚未检查 / 暂无法确认）。 */
  capabilityState: 'crwu-valuation-capability-state',
  /** 抽屉首屏的轻量摘要面。 */
  drawerSummary: 'crwu-valuation-drawer-summary',
  drawerKv: 'crwu-valuation-drawer-kv',
  /** 抽屉里的紧凑文件主行。 */
  drawerFileRow: 'crwu-valuation-drawer-file-row',
  drawerFileMain: 'crwu-valuation-drawer-file-main',
  drawerFileTools: 'crwu-valuation-drawer-file-tools',
  drawerFileDetails: 'crwu-valuation-drawer-file-details',
  /** 粘性操作栏（主页面「确认」在这里，且是唯一 primary）。 */
  actionbar: 'crwu-valuation-actionbar',
  /** 操作被禁用时的原因（`aria-describedby` 指向它）。 */
  actionReason: 'crwu-valuation-action-reason',
  /** 抽屉容器。 */
  drawer: 'crwu-valuation-drawer',
  /** 抽屉固定 footer（返回修改 / 开始估值）。 */
  drawerFooter: 'crwu-valuation-drawer-actions',
  /** 中性按钮。 */
  btn: 'crwu-valuation-btn',
  /** primary 变体（双类选择器：`.crwu-valuation-btn.crwu-valuation-btn-primary`）。 */
  btnPrimary: 'crwu-valuation-btn-primary',
  /** 交接结果屏（建会话失败 / 自动打开失败）。 */
  handoff: 'crwu-valuation-handoff',
  /** 会话层错误（`role="alert"`）。 */
  error: 'crwu-valuation-error',
  /** 成功 / 进行中的提示（`role="status"`）。 */
  notice: 'crwu-valuation-notice',
} as const
