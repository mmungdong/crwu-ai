/**
 * 本地审核（协议 28）的稳定类名与样式文本。
 *
 * 与 `features/workbench/consts.ts` 同一套视觉语言：颜色 / 圆角 / 阴影只用那份文件里
 * **已经定义过**的 `--crwu-*` 语义 token，这里不新增任何 CSS 变量、不用 emoji、
 * 也不用大面积红底。样式片段由 `features/workbench/consts.ts` 拼进同一条样式表，
 * 随 `lib/client.js` 一起交付。
 *
 * 过渡只碰 background / border-color / color / box-shadow / opacity（不动宽高，避免重排抖动），
 * 并在 `prefers-reduced-motion: reduce` 下全部关掉。
 */

export const LOCAL_AUDIT_CLASSES = {
  /* 页签条（报告审核 / 本地审核） */
  tablist: 'crwu-audit-tablist',
  /* 页面顶部说明（副标题 + 辅助说明） */
  intro: 'crwu-audit-local-intro',
  introLead: 'crwu-audit-local-intro-lead',
  introNote: 'crwu-audit-local-intro-note',
  tab: 'crwu-audit-tab',
  tabOn: 'crwu-audit-tab-on',

  /* 正文与卡片 */
  pane: 'crwu-audit-local',
  cardTitleText: 'crwu-audit-local-card-title-text',
  cardHint: 'crwu-audit-local-card-hint',
  cardActions: 'crwu-audit-local-card-actions',
  empty: 'crwu-audit-local-empty',
  emptyMark: 'crwu-audit-local-empty-mark',

  /* 已选择内容 */
  list: 'crwu-audit-local-list',
  listRow: 'crwu-audit-local-list-row',
  rowIcon: 'crwu-audit-local-row-icon',
  rowMain: 'crwu-audit-local-row-main',
  rowName: 'crwu-audit-local-row-name',
  rowMeta: 'crwu-audit-local-row-meta',
  rowStatus: 'crwu-audit-local-row-status',
  rowReason: 'crwu-audit-local-row-reason',
  rowRemove: 'crwu-audit-local-row-remove',
  rowGroup: 'crwu-audit-local-row-group',
  rowHead: 'crwu-audit-local-row-head',
  listRowFile: 'crwu-audit-local-list-row-file',
  listNested: 'crwu-audit-local-list-nested',
  summary: 'crwu-audit-local-summary',
  overLimit: 'crwu-audit-local-over-limit',
  skippedNote: 'crwu-audit-local-skipped-note',
  skippedDetails: 'crwu-audit-local-skipped-details',
  skippedSummary: 'crwu-audit-local-skipped-summary',
  skippedHint: 'crwu-audit-local-skipped-hint',
  skeleton: 'crwu-audit-local-skeleton',
  skeletonLine: 'crwu-audit-local-skeleton-line',
  columns: 'crwu-audit-local-columns',
  column: 'crwu-audit-local-column',

  /* 状态语气（图标 + 文字 + 颜色三重表达） */
  toneOk: 'crwu-audit-local-tone-ok',
  toneWarn: 'crwu-audit-local-tone-warn',
  toneError: 'crwu-audit-local-tone-error',
  toneMuted: 'crwu-audit-local-tone-muted',

  /* 补充提示词 */
  field: 'crwu-audit-local-field',
  fieldLabel: 'crwu-audit-local-field-label',
  textarea: 'crwu-audit-local-textarea',
  fieldHint: 'crwu-audit-local-field-hint',

  /* 准备阶段条 */
  stages: 'crwu-audit-local-stages',
  stage: 'crwu-audit-local-stage',
  stageDone: 'crwu-audit-local-stage-done',
  stageActive: 'crwu-audit-local-stage-active',
  stageTodo: 'crwu-audit-local-stage-todo',
  stageMark: 'crwu-audit-local-stage-mark',
  stageMarkBusy: 'crwu-audit-local-stage-mark-busy',

  /* 结果与兜底 */
  done: 'crwu-audit-local-done',
  doneMark: 'crwu-audit-local-done-mark',
  doneTitle: 'crwu-audit-local-done-title',
  doneMeta: 'crwu-audit-local-done-meta',
  doneHint: 'crwu-audit-local-done-hint',
  handoff: 'crwu-audit-local-handoff',
  handoffMark: 'crwu-audit-local-handoff-mark',
  handoffTitle: 'crwu-audit-local-handoff-title',
  handoffLead: 'crwu-audit-local-handoff-lead',
  handoffSteps: 'crwu-audit-local-handoff-steps',
  handoffActions: 'crwu-audit-local-handoff-actions',
  handoffPrompt: 'crwu-audit-local-handoff-prompt',
  handoffCopied: 'crwu-audit-local-handoff-copied',

  /* 底部主操作 */
  action: 'crwu-audit-local-action',
  actionReason: 'crwu-audit-local-action-reason',
  fatal: 'crwu-audit-local-fatal',
} as const
