/**
 * 工作台的稳定类名与样式文本。
 *
 * 为什么样式随 `lib/client.js` 一起交付，而不是独立 CSS：包形态还没接入 DSH 官方的
 * CSS Module 虚拟加载器，独立 CSS 会漏发。样式由 `styles.ts` 随 Cordis 生命周期插入。
 *
 * ## 视觉语言（办公 + Apple，2026-09-22 用户指定的口径）
 *
 * 三条硬约束，改样式前先读：
 *
 * 1. **颜色、字号、阴影一律用 DSH 真正定义过的 token**，取值以 `@deepseek-ai/dsh-client-ui-theme`
 *    的 alias 表为准。本仓早先用过 `--dsw-alias-bg-secondary`、`--dsw-alias-border-secondary`、
 *    `--dsw-alias-state-warning-primary` 这些**并不存在**的名字 —— 未定义的 var() 会让整条声明
 *    失效，于是卡片没边框、底色全透明，页面看起来「很陋」而控制台**没有任何报错**。
 *    有一条测试扫硬编码色值（`#hex` / `rgb(` / `hsl(`），但它**扫不出不存在的 token**。
 * 2. **字体跟随 `--dsw-font-family`**（本身就是 `-apple-system, BlinkMacSystemFont, …` 的
 *    Apple 优先栈），中文再落 PingFang SC；不自己写 font-family 列表。
 * 3. **圆角交给 DSH 的 `corner-shape: superellipse(1.5)`**（theme 里已全局生效），
 *    所以这里只写 `border-radius`，拿到的就是 Apple 那种连续曲率圆角，不要再手写贝塞尔。
 *
 * 办公风格的落点：信息密度不降（资产评估师要一屏看多条记录），但**分层清楚、动效克制、
 * 只用一处强调色**。卡片靠 1px 描边 + `--dsw-shadow-lv1` 立起来，不靠大色块；状态色只出现在
 * 圆点、胶囊与左侧一条细边上。所有过渡都限制在 background/color/box-shadow/transform，
 * 时长 120~160ms，不动布局属性（width/height 过渡会引起重排抖动）。
 */
export const WORKBENCH_CLASSES = {
  root: 'crwu-audit-root',
  header: 'crwu-audit-header',
  title: 'crwu-audit-title',
  /** 「现在跑的是哪一份插件」小标签（dev / 具体版本）；侧栏入口与面板头部共用。 */
  version: 'crwu-audit-version',
  versionDev: 'crwu-audit-version-dev',
  versionInstalled: 'crwu-audit-version-installed',
  versionUnknown: 'crwu-audit-version-unknown',
  /** 头部右侧那句问候（`下午好，某某某`）；姓名拿不到时整句不渲染。 */
  greeting: 'crwu-audit-greeting',
  description: 'crwu-audit-description',
  error: 'crwu-audit-error',
  result: 'crwu-audit-result',

  /** 面板正文区：**这里才是滚动容器**（root 是 flex 列，底部模块切换条必须常驻）。 */
  body: 'crwu-audit-body',
  /** 侧栏分组卡上的一行子项（报告评估 / 报告审核 / 环境信息）。 */
  module: 'crwu-audit-module',
  moduleOn: 'crwu-audit-module-on',
  moduleGlyph: 'crwu-audit-module-glyph',
  moduleLabel: 'crwu-audit-module-label',
  /** 还没开发的子项旁边那枚灰色的「开发中」小标签。 */
  moduleTag: 'crwu-audit-module-tag',

  /** 侧栏底部（Settings 上方）那枚常驻工作台入口。 */
  sideEntry: 'crwu-audit-side-entry',
  sideEntryOn: 'crwu-audit-side-entry-on',
  sideEntryRail: 'crwu-audit-side-entry-rail',
  sideEntryGlyph: 'crwu-audit-side-entry-glyph',
  sideEntryLabel: 'crwu-audit-side-entry-label',
  sideEntryMark: 'crwu-audit-side-entry-mark',
  sideEntryMarkOk: 'crwu-audit-side-entry-mark-ok',
  sideEntryMarkBad: 'crwu-audit-side-entry-mark-bad',
  sideEntryMarkBusy: 'crwu-audit-side-entry-mark-busy',
  sideEntryMarkIdle: 'crwu-audit-side-entry-mark-idle',

  /** 侧栏那张分组卡：卡头（模块名 + 版本标签）+ 卡身（三个子项行）。 */
  sideCard: 'crwu-audit-side-card',
  /** 工作台面板正开着时的卡（只加一道更实的描边，不整块换底色）。 */
  sideCardOn: 'crwu-audit-side-card-on',
  sideCardHead: 'crwu-audit-side-card-head',
  sideCardTitle: 'crwu-audit-side-card-title',
  sideCardRows: 'crwu-audit-side-card-rows',

  /** 统一的「正在自检环境」等待页（第一次进工作台时整块正文都是它）。 */
  loadingPane: 'crwu-audit-loading-pane',
  loadingMark: 'crwu-audit-loading-mark',
  loadingTitle: 'crwu-audit-loading-title',
  loadingHint: 'crwu-audit-loading-hint',

  /** 「报告评估」的 Coming Soon 页（无卡片、无边框，靠排版留白）。 */
  eval: 'crwu-audit-eval',
  evalInner: 'crwu-audit-eval-inner',
  evalIcon: 'crwu-audit-eval-icon',
  evalTitle: 'crwu-audit-eval-title',
  evalSubtitle: 'crwu-audit-eval-subtitle',
  evalDesc: 'crwu-audit-eval-desc',
  evalStatus: 'crwu-audit-eval-status',
  evalDot: 'crwu-audit-eval-dot',
  evalNext: 'crwu-audit-eval-next',
  evalNextLead: 'crwu-audit-eval-next-lead',
  evalLink: 'crwu-audit-eval-link',
  evalArrow: 'crwu-audit-eval-arrow',

  tabs: 'crwu-audit-tabs',
  tab: 'crwu-audit-tab',
  tabOn: 'crwu-audit-tab-on',
  tabCount: 'crwu-audit-tab-count',

  /** 页面头：标题 + 副标题 + 右侧计数（Apple 的 Workspace Header 语汇）。 */
  pageHead: 'crwu-audit-page-head',
  pageTitle: 'crwu-audit-page-title',
  pageMeta: 'crwu-audit-page-meta',
  /** 列表工具条：搜索框 + 刷新同属一行（刷新不再挂页面右上角）。 */
  toolbar: 'crwu-audit-toolbar',
  /** Spotlight 式搜索：输入框 + 右侧那个 × 清空。 */
  searchWrap: 'crwu-audit-search',
  /** 输入框左侧那枚放大镜（不参与交互，只做「这是搜索」的形状提示）。 */
  searchGlyph: 'crwu-audit-search-glyph',
  searchClear: 'crwu-audit-search-clear',
  /** 搜索行里的动作按钮（刷新）：与输入框同高，视觉上属于同一个工具条。 */
  searchAction: 'crwu-audit-search-action',
  /** 次级控件（刷新）：与操作列的小鲸鱼 / ••• **同一套中性底**，只有主操作是实心。 */
  ghost: 'crwu-audit-ghost',
  /** 刷新进行中的图标旋转（列表保持显示，只转图标）。 */
  ghostBusy: 'crwu-audit-ghost-busy',
  /** 流水号：平时的等宽文字 + 悬停才浮出的复制图标。 */
  seq: 'crwu-audit-seq',
  seqCopy: 'crwu-audit-seq-copy',
  seqCopyOn: 'crwu-audit-seq-copy-on',
  /** 空态：一行主文案 + 一行轻量说明（不画插画）。 */
  empty: 'crwu-audit-empty',
  emptyHint: 'crwu-audit-empty-hint',
  /** AI 审核列表的交付件列：业务语义（审核报告 / 审核数据），不暴露 OSS 原始路径。 */
  resultFiles: 'crwu-audit-result-files',
  resultCount: 'crwu-audit-result-count',
  fileChip: 'crwu-audit-file-chip',
  colResSeqNo: 'crwu-audit-col-res-seq-no',
  colResFiles: 'crwu-audit-col-res-files',
  colResAction: 'crwu-audit-col-res-action',
  /** 分页的「首页 / 上一页 / 下一页 / 末页」四枚导航按钮（图标 + 可访问名）。 */
  pagerNav: 'crwu-audit-pager-nav',

  /** 子页面的大圆角框（一个框住全部，框内靠发丝线分格，不再分成好多块）。 */
  surface: 'crwu-audit-surface',
  /** 大框顶部那一行：下划线式页签（+ 各视图自己的工具条仍在正文里）。 */
  paneHead: 'crwu-audit-pane-head',
  /** 大框身体：左数据 + 右 AI 讨论。 */
  paneBody: 'crwu-audit-pane-body',
  paneMain: 'crwu-audit-pane-main',

  /** 「与 DeepSeek 共同讨论这份报告」：操作列那枚小图标 + 右侧面板。 */
  /** 拉文件期间盖住正文的等待页。 */
  aiMask: 'crwu-audit-ai-mask',
  /** 列表数据区：等待页只盖它，页头 / 页签 / 工具条保持可见。 */
  listArea: 'crwu-audit-list-area',
  /** 「已有报告会话」的选择 Dialog。 */
  aiDialog: 'crwu-audit-ai-dialog',
  aiDialogBackdrop: 'crwu-audit-ai-dialog-backdrop',
  aiDialogTitle: 'crwu-audit-ai-dialog-title',
  aiDialogBody: 'crwu-audit-ai-dialog-body',
  aiDialogOption: 'crwu-audit-ai-dialog-option',
  aiDialogOptionOn: 'crwu-audit-ai-dialog-option-on',
  aiDialogOptionTitle: 'crwu-audit-ai-dialog-option-title',
  aiDialogOptionHint: 'crwu-audit-ai-dialog-option-hint',
  aiDialogActions: 'crwu-audit-ai-dialog-actions',
  /** 操作列：一行只放主操作 + 小鲸鱼 + •••；永不纵向堆叠。 */
  rowActions: 'crwu-audit-row-actions',
  progressChip: 'crwu-audit-progress-chip',
  /** 操作列那枚 ••• 按钮（菜单打开时保持 selected）。 */
  menu: 'crwu-audit-menu',
  menuOpen: 'crwu-audit-menu-open',
  /** 统一的浮层：Tooltip 与 Dropdown 共用一套视觉/动画（见样式 §18）。 */
  floatLayer: 'crwu-audit-float',
  floatTip: 'crwu-audit-float-tip',
  floatMenu: 'crwu-audit-float-menu',
  floatArrow: 'crwu-audit-float-arrow',
  floatItem: 'crwu-audit-float-item',
  /** 菜单打开时那一行保持浅选中（用户始终知道菜单属于谁）。 */
  tbodyRowOn: 'crwu-audit-tbody-row-on',
  /** 风险等级：低噪音 Status Indicator（小圆点 + 等级字母），不是彩色 Tag。 */
  risk: 'crwu-audit-risk',
  riskDot: 'crwu-audit-risk-dot',
  riskDotHigh: 'crwu-audit-risk-dot-high',
  riskDotMedium: 'crwu-audit-risk-dot-medium',
  riskDotLow: 'crwu-audit-risk-dot-low',
  riskDotOk: 'crwu-audit-risk-dot-ok',
  /** 人工复核列：主状态 13px + 次级 12px（两行权重不同）。 */
  reviewMain: 'crwu-audit-review-main',
  /** 分页：页码 + 跳页。 */
  pager: 'crwu-audit-pager',
  pagerPage: 'crwu-audit-pager-page',
  pagerPageOn: 'crwu-audit-pager-page-on',
  pagerGap: 'crwu-audit-pager-gap',
  pagerJumpWrap: 'crwu-audit-pager-jump',
  pagerJump: 'crwu-audit-pager-jump-input',
  aiRowBtn: 'crwu-audit-ai-row-btn',
  aiRowBtnOn: 'crwu-audit-ai-row-btn-on',

  card: 'crwu-audit-card',
  cardTitle: 'crwu-audit-card-title',
  cardTitleText: 'crwu-audit-card-title-text',
  cardExtra: 'crwu-audit-card-extra',
  cardBody: 'crwu-audit-card-body',

  section: 'crwu-audit-section',
  sectionHead: 'crwu-audit-section-head',
  sectionTitle: 'crwu-audit-section-title',
  sectionCount: 'crwu-audit-section-count',
  sectionBody: 'crwu-audit-section-body',

  notice: 'crwu-audit-notice',
  noticeWarn: 'crwu-audit-notice-warn',
  noticeOk: 'crwu-audit-notice-ok',

  row: 'crwu-audit-row',
  stack: 'crwu-audit-stack',
  divider: 'crwu-audit-divider',
  muted: 'crwu-audit-muted',
  mono: 'crwu-audit-mono',
  link: 'crwu-audit-link',
  grow: 'crwu-audit-grow',

  table: 'crwu-audit-table',
  tbodyRow: 'crwu-audit-tbody-row',
  th: 'crwu-audit-th',
  td: 'crwu-audit-td',
  tdAction: 'crwu-audit-td-action',
  colName: 'crwu-audit-col-name',
  colSeqNo: 'crwu-audit-col-seq-no',
  colRisk: 'crwu-audit-col-risk',
  colReview: 'crwu-audit-col-review',
  colModified: 'crwu-audit-col-modified',
  colAction: 'crwu-audit-col-action',
  tableWrap: 'crwu-audit-table-wrap',
  tdName: 'crwu-audit-td-name',
  tdNowrap: 'crwu-audit-td-nowrap',
  tdReview: 'crwu-audit-td-review',
  cellNowrap: 'crwu-audit-cell-nowrap',
  cellTitle: 'crwu-audit-cell-title',
  cellSub: 'crwu-audit-cell-sub',
  cellMono: 'crwu-audit-cell-mono',

  badge: 'crwu-audit-badge',
  badgeOk: 'crwu-audit-badge-ok',
  badgeMedium: 'crwu-audit-badge-medium',
  badgeHigh: 'crwu-audit-badge-high',
  badgeLow: 'crwu-audit-badge-low',

  chip: 'crwu-audit-chip',
  chipOk: 'crwu-audit-chip-ok',
  chipBad: 'crwu-audit-chip-bad',
  chipWarn: 'crwu-audit-chip-warn',
  chipMuted: 'crwu-audit-chip-muted',

  dot: 'crwu-audit-dot',
  dotOk: 'crwu-audit-dot-ok',
  dotBad: 'crwu-audit-dot-bad',
  dotBusy: 'crwu-audit-dot-busy',
  dotIdle: 'crwu-audit-dot-idle',

  hero: 'crwu-audit-hero',
  heroOk: 'crwu-audit-hero-ok',
  heroBad: 'crwu-audit-hero-bad',
  heroMark: 'crwu-audit-hero-mark',
  heroMarkOk: 'crwu-audit-hero-mark-ok',
  heroMarkBad: 'crwu-audit-hero-mark-bad',
  heroMain: 'crwu-audit-hero-main',
  heroTitle: 'crwu-audit-hero-title',
  heroSub: 'crwu-audit-hero-sub',
  heroActions: 'crwu-audit-hero-actions',

  /* 环境页（2026-09-26 重排）：紧凑状态摘要 + 引导式配置工作区（左侧步骤导航 / 右侧当前步骤）。
     顶部不再有「进入报告审核」按钮，也不再有三块技术指标卡。 */
  status: 'crwu-audit-status',
  statusOk: 'crwu-audit-status-ok',
  statusBad: 'crwu-audit-status-bad',
  statusMark: 'crwu-audit-status-mark',
  statusMarkOk: 'crwu-audit-status-mark-ok',
  statusMarkBad: 'crwu-audit-status-mark-bad',
  statusMain: 'crwu-audit-status-main',
  statusTitle: 'crwu-audit-status-title',
  statusSub: 'crwu-audit-status-sub',
  statusNote: 'crwu-audit-status-note',
  statusMeta: 'crwu-audit-status-meta',
  statusDot: 'crwu-audit-status-dot',
  statusAction: 'crwu-audit-status-action',
  workspace: 'crwu-audit-workspace',
  stepsNav: 'crwu-audit-steps',
  stepsList: 'crwu-audit-steps-list',
  stepItem: 'crwu-audit-step',
  stepItemOn: 'crwu-audit-step-on',
  stepIndex: 'crwu-audit-step-index',
  stepIndexDone: 'crwu-audit-step-index-done',
  stepText: 'crwu-audit-step-text',
  stepTitle: 'crwu-audit-step-title',
  stepState: 'crwu-audit-step-state',
  stepPanel: 'crwu-audit-step-panel',
  stepPanelHead: 'crwu-audit-step-panel-head',
  stepPanelTitle: 'crwu-audit-step-panel-title',
  stepLead: 'crwu-audit-step-lead',
  stepCard: 'crwu-audit-step-card',
  stepHead: 'crwu-audit-step-card-head',
  stepFields: 'crwu-audit-fields',
  field: 'crwu-audit-field',
  fieldLabel: 'crwu-audit-field-label',

  meter: 'crwu-audit-meter',
  meterFill: 'crwu-audit-meter-fill',
  meterFillBad: 'crwu-audit-meter-fill-bad',

  heroTodo: 'crwu-audit-hero-todo',

  layer: 'crwu-audit-layer',
  layerOk: 'crwu-audit-layer-ok',
  layerBad: 'crwu-audit-layer-bad',
  layerHead: 'crwu-audit-layer-head',
  layerTitle: 'crwu-audit-layer-title',
  layerCount: 'crwu-audit-layer-count',
  layerToggle: 'crwu-audit-layer-toggle',
  layerBody: 'crwu-audit-layer-body',
  layerHeadExtra: 'crwu-audit-layer-head-extra',
  authGranted: 'crwu-audit-auth-granted',
  layerActions: 'crwu-audit-layer-actions',
  layerFix: 'crwu-audit-layer-fix',
  details: 'crwu-audit-details',
  detailsHead: 'crwu-audit-details-head',
  detailsTitle: 'crwu-audit-details-title',
  detailsToggle: 'crwu-audit-details-toggle',
  detailsBody: 'crwu-audit-details-body',
  detailsPanelHead: 'crwu-audit-details-panel-head',
  detailsPanelTitle: 'crwu-audit-details-panel-title',
  detailsCopyError: 'crwu-audit-details-copy-error',
  detailsContact: 'crwu-audit-details-contact',

  metrics: 'crwu-audit-metrics',
  metric: 'crwu-audit-metric',
  metricValue: 'crwu-audit-metric-value',
  metricLabel: 'crwu-audit-metric-label',

  item: 'crwu-audit-item',
  itemHead: 'crwu-audit-item-head',
  itemMain: 'crwu-audit-item-main',
  itemName: 'crwu-audit-item-name',
  itemNote: 'crwu-audit-item-note',
  itemMeta: 'crwu-audit-item-meta',
  itemFix: 'crwu-audit-item-fix',

  blockers: 'crwu-audit-blockers',
  blocker: 'crwu-audit-blocker',
  blockerIndex: 'crwu-audit-blocker-index',

  spinner: 'crwu-audit-spinner',
  spinnerLarge: 'crwu-audit-spinner-large',
  loading: 'crwu-audit-loading',
  loadingInline: 'crwu-audit-loading-inline',
  loadBar: 'crwu-audit-load-bar',
  loadBarFill: 'crwu-audit-load-bar-fill',
  dim: 'crwu-audit-dim',

  sideDrawer: 'crwu-audit-side-drawer',
  sideDrawerBackdrop: 'crwu-audit-side-drawer-backdrop',
  sideDrawerHead: 'crwu-audit-side-drawer-head',
  sideDrawerTitle: 'crwu-audit-side-drawer-title',
  /** 标题下面那行流水号（12px 等宽、text-tertiary）；正文不再重复它。 */
  sideDrawerSub: 'crwu-audit-side-drawer-sub',
  /** × 关闭：32×32 图标按钮（透明底 + 悬停一层中性底），替代原来的「关闭」文字按钮。 */
  sideDrawerClose: 'crwu-audit-side-drawer-close',
  /** 关闭动画期间的类（父层延迟 150ms 卸载，见 WorkbenchPanel.closeDrawer）。 */
  sideDrawerOut: 'crwu-audit-side-drawer-out',
  sideDrawerBackdropOut: 'crwu-audit-side-drawer-backdrop-out',
  sideDrawerBody: 'crwu-audit-side-drawer-body',

  /** 「审核信息」Drawer 的小节（审核摘要 / 问题情况 / 复核情况 / 报告信息 / 技术详情）。 */
  sec: 'crwu-audit-sec',
  secTitle: 'crwu-audit-sec-title',
  /** 报告信息：沿用 kv 两列，但值允许换行（报告版本是长字符串）。 */
  infoValueWrap: 'crwu-audit-info-value-wrap',
  /** 核心指标（第一屏的轻量 Surface：复核命中率 + AI 检出 + 已提未改）。
      注意键名是 km，不要用 metrics —— 那个键已经被环境信息页的统计条占了。 */
  km: 'crwu-audit-km',
  rateLabel: 'crwu-audit-rate-label',
  rateValue: 'crwu-audit-rate-value',
  rateMeta: 'crwu-audit-rate-meta',
  kmRow: 'crwu-audit-km-row',
  kmLabel: 'crwu-audit-km-label',
  kmValue: 'crwu-audit-km-value',
  kmHint: 'crwu-audit-km-hint',
  /** 「已提出但仍未整改」折叠区（左侧 3px 琥珀强调条 + 数量 badge）。 */
  raised: 'crwu-audit-raised',
  raisedHead: 'crwu-audit-raised-head',
  raisedTitle: 'crwu-audit-raised-title',
  raisedSub: 'crwu-audit-raised-sub',
  raisedCount: 'crwu-audit-raised-count',
  /** 通用折叠机制（已提未改 / AI 问题 / 报告信息 / 技术详情共用一套）。 */
  acc: 'crwu-audit-acc',
  accBody: 'crwu-audit-acc-body',
  accInner: 'crwu-audit-acc-inner',
  accChevron: 'crwu-audit-acc-chevron',
  /** 折叠小节（报告信息 / 其他事项 / 技术详情共用同一形态：顶部发丝线 + 40px 头）。 */
  fold: 'crwu-audit-fold',
  foldHead: 'crwu-audit-fold-head',
  foldTitle: 'crwu-audit-fold-title',
  /** AI 检出问题列表。 */
  issueList: 'crwu-audit-issue-list',
  issueRow: 'crwu-audit-issue-row',
  issueHead: 'crwu-audit-issue-head',
  issueMain: 'crwu-audit-issue-main',
  issueSeverity: 'crwu-audit-issue-severity',
  issueTitle: 'crwu-audit-issue-title',
  issueBrief: 'crwu-audit-issue-brief',
  issueDetail: 'crwu-audit-issue-detail',
  issueField: 'crwu-audit-issue-field',
  issueFieldLabel: 'crwu-audit-issue-field-label',
  issueFieldValue: 'crwu-audit-issue-field-value',
  issueLink: 'crwu-audit-issue-link',
  /** 二级小结（高/中/低、待确认/未检查、三条带）——统一一条轻文案。 */
  summaryLine: 'crwu-audit-summary-line',
  /** 技术详情里的原始值展示（折叠机制与 fold 共用）。 */
  techRow: 'crwu-audit-tech-row',
  techKey: 'crwu-audit-tech-key',
  techValue: 'crwu-audit-tech-value',
  techJson: 'crwu-audit-tech-json',
  techCopy: 'crwu-audit-tech-copy',
  techHint: 'crwu-audit-tech-hint',

  gate: 'crwu-audit-gate',
  gateTitle: 'crwu-audit-gate-title',

  btn: 'crwu-audit-btn',
  btnPrimary: 'crwu-audit-btn-primary',
  btnWarn: 'crwu-audit-btn-warn',
  btnSmall: 'crwu-audit-btn-small',

  input: 'crwu-audit-input',
  drawer: 'crwu-audit-drawer',
  drawerHead: 'crwu-audit-drawer-head',
  kv: 'crwu-audit-kv',
  kvKey: 'crwu-audit-kv-key',
  kvValue: 'crwu-audit-kv-value',
} as const

/** 版本 / dev 小标签的语义类：tone → 类名（侧栏入口与面板头部共用同一套）。 */
export const BUILD_TAG_CLASSES = {
  dev: WORKBENCH_CLASSES.versionDev,
  installed: WORKBENCH_CLASSES.versionInstalled,
  unknown: WORKBENCH_CLASSES.versionUnknown,
} as const

export const WORKBENCH_STYLE_ID = 'crwu-audit-package-styles'

export const WORKBENCH_STYLE_TEXT = `
/* ════════════════════════════════════════════════════════════════════
   0. 骨架：面板 = 固定头部 + 可滚正文
   ────────────────────────────────────────────────────────────────────
   滚动归属这一条是必须的，不是样式偏好：DSH 的主内容列（centerCol）是
   display:flex + overflow:hidden + height:100vh，它**不滚动**，而是把滚动交给面板。
   这里把滚动放在 .crwu-audit-body 而不是 root，头部因此常驻 —— 让 root 滚的话
   标题与版本标签会跟着滚出视口。整体仍是「面板自己拥有滚动」。
   （三个模块的入口在左侧栏那张分组卡上，面板里不再有自己的模块条。）
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-root {
  box-sizing: border-box;
  display: flex; flex-direction: column;
  height: 100%; min-height: 0; overflow: hidden;
  font-family: var(--dsw-font-family);
  font-size: 13px; line-height: 1.6;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  -webkit-font-smoothing: antialiased;
}
.crwu-audit-body {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  overscroll-behavior: contain;
  padding: 18px 22px 26px;
  scrollbar-gutter: stable;
}

.crwu-audit-header {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 14px 22px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
/* 头部右侧那句问候：不抢标题的注意力，但要比正文稍重一点（它带姓名，是"给这个人看的"）。 */
.crwu-audit-greeting {
  flex: none; margin-left: auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px; line-height: 20px;
  white-space: nowrap;
}
.crwu-audit-title {
  font-size: 15px; font-weight: 600; letter-spacing: -0.01em;
  line-height: 22px;
  /* 头部是一行不许溢出的：窄面板下标题先被截断，版本标签与右侧那句问候永远看得见。 */
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 版本 / dev 小标签：跟着名字或标题走的一枚胶囊。
   等宽字体 + user-select:all，用户截图报问题时连着版本号一起选中，不用手打。
   dev 用琥珀色提醒「这不是装好的包，改了得重新 build」，装好的包用中性灰。 */
.crwu-audit-version {
  flex: none;
  padding: 0 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-caption);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px;
  line-height: 16px; letter-spacing: 0.02em; white-space: nowrap;
  user-select: all; cursor: default;
}
.crwu-audit-version-dev {
  color: var(--dsw-alias-state-warn-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
}
.crwu-audit-version-installed { color: var(--dsw-alias-label-secondary); }
.crwu-audit-version-unknown { color: var(--dsw-alias-label-caption); }
.crwu-audit-description { margin-top: 4px; color: var(--dsw-alias-label-secondary); }
.crwu-audit-error { margin-top: 8px; color: var(--dsw-alias-state-error-primary); }
.crwu-audit-result {
  margin-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
}

/* ════════════════════════════════════════════════════════════════════
   1. 侧栏分组卡上的一行子项：报告评估 / 报告审核 / 环境信息
   ────────────────────────────────────────────────────────────────────
   形态是 Apple 设置面板里那种分组卡的一行：没有边框、没有分隔线，靠行与行之间的
   留白分格；**选中态不换布局属性**（只动 background / color / box-shadow /
   font-weight），所以来回切模块不会有重排抖动。
   选中行的左边一道 3px 强调条用 inset 阴影画，不占布局宽度 —— 行内文字不会因为
   选中而左右跳一格。

   悬停与选中的底色**必须一眼分得开**（用户 2026-09-22 报的缺陷：悬停别的子项时，
   底色和激活那条一模一样，看不出自己在哪一页）。做法是不用 DSH 那对
   interactive-bg-hover / interactive-bg-active 当「悬停 / 选中」——它们在两种主题下
   只差一档明度，选中行还只剩一道描边感；改成：悬停 = 一层中性极浅底，
   选中 = 品牌蓝的低浓度底（color-mix 调浓度）+ 左侧蓝条 + 加粗，色相就不同。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-module {
  box-sizing: border-box; width: 100%;
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border: none; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 13px; line-height: 20px; text-align: left;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease;
}
.crwu-audit-module:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.crwu-audit-module:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
/* 选中：品牌蓝低浓度底 + 左侧 3px 蓝条 + 加粗。加了 :hover 那条选择器，
   是因为悬停自己的选中行不该把它「降级」成悬停底色（两条同特异度，靠这里显式钉住）。 */
.crwu-audit-module-on,
.crwu-audit-module-on:hover {
  background: color-mix(in srgb, var(--dsw-alias-button-info-fill) 16%, transparent);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--dsw-alias-button-info-fill);
}
.crwu-audit-module-glyph { display: inline-flex; flex: none; color: var(--dsw-alias-label-caption); }
.crwu-audit-module-on .crwu-audit-module-glyph { color: var(--dsw-alias-brand-primary); }
.crwu-audit-module-label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 「开发中」小标签：灰色、比子项名小一号，紧跟在名字后面。
   用户 2026-09-22 的口径是"图标太难看，就要一个灰色小 tag"，所以这里没有描边、没有状态色，
   只有一层极浅的中性底（深浅主题都成立），文字用 caption 灰。 */
.crwu-audit-module-tag { flex: none; padding: 0; border-radius: 0; font-size: 12px; line-height: 18px; font-weight: 400;
  color: color-mix(in srgb, var(--dsw-alias-label-caption) 78%, transparent); background: transparent; }

/* ════════════════════════════════════════════════════════════════════
   2. 侧栏底部的分组卡（sidebar.footer.action，Settings 上方）
   ────────────────────────────────────────────────────────────────────
   展开态是一张分组卡（卡头 + 三行子项）；折叠成 56px 轨道时只留一颗按钮
   （由 JS 侧传 wide 决定，不靠媒体查询）。整块长在 DSH 侧栏里，所以卡身那几行沿用
   侧栏导航项的语义；**卡本体与卡头不跟着导航项走** —— 卡头不是导航项（见下）。
   ──────────────────────────────────────────────────────────────────── */
/* 卡片本体：一整张浅底圆角卡 —— 三个子项因此看起来是**一个模块**，而不是三个入口。 */
.crwu-audit-side-card {
  box-sizing: border-box; width: 100%;
  display: flex; flex-direction: column; gap: 2px;
  padding: 4px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  transition: border-color 0.14s ease;
}
/* 工作台面板正开着：只把描边压实一档，**不整块换底色** —— 先前列用
   sidebar-nav-item-active 给整张卡铺一层灰蓝，在侧栏里就是一块突兀的色块
   （用户 2026-09-22：「它的背景色不好看」）。「我在哪一页」由卡身那条选中行承担。 */
.crwu-audit-side-card-on { border-color: var(--dsw-alias-border-l2); }
/* 卡头：模块名那一行。它是**纯标题，不是第四个可选项**：没有 cursor:pointer，
   也没有悬停 / 聚焦态 —— 看起来就不像能点的，点它也真的什么都不会发生。 */
.crwu-audit-side-card-head {
  box-sizing: border-box; width: 100%;
  display: flex; align-items: center; gap: 8px;
  padding: 4px 6px 6px;
  color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 13px; line-height: 20px; text-align: left;
}
.crwu-audit-side-card-title {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 600; letter-spacing: -0.01em;
}
/* 卡身：三行子项。行间距就是分组卡的分格方式（不用分隔线）。 */
.crwu-audit-side-card-rows { display: flex; flex-direction: column; gap: 1px; }
.crwu-audit-side-entry {
  box-sizing: border-box; width: 100%;
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border: none; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 14px; line-height: 22px; text-align: left;
  cursor: pointer;
  transition: background 0.14s ease;
}
.crwu-audit-side-entry:hover { background: var(--dsw-specific-sidebar-nav-item-hover, var(--dsw-alias-interactive-bg-hover)); }
.crwu-audit-side-entry:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: -2px; }
.crwu-audit-side-entry-on { background: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-active)); font-weight: 500; }
.crwu-audit-side-entry-glyph { display: inline-flex; flex: none; align-items: center; justify-content: center; }
.crwu-audit-side-entry-label {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 折叠轨道：只画图标，居中。 */
.crwu-audit-side-entry-rail { justify-content: center; padding: 7px 0; }
/* 环境结论标记：一枚 16px 圆徽标（iOS 设置风 —— 实心状态色圆底 + 白字形）。
   它**只画在「环境信息」那一行**（其余子项右侧留空，免得被读成「那一行通过了」），
   顶在右端（margin-left:auto），用户扫一眼侧栏就知道环境行不行。
   四种结论各有形状，不只靠颜色：
     通过   = 实心绿圆 + 白勾；
     不通过 = 实心红圆 + 白叹号；
     自检中 = 实心琥珀圆 + 一段旋转白弧（见下面的 ::after）；
     尚未自检 = 空心圈（不给结论，也不假装有结论）。
   白字形用 static 白而不是 alias：alias 的 label-primary-inverted / -foreground
   在深色主题下会翻成深色，压在实心色块上就看不清了 —— 而色块上的字形必须恒为白。
   先前是一枚「裸勾 / 裸点」浮在行尾（没有容器），视觉上很飘（用户 2026-09-22：不好看）。 */
.crwu-audit-side-entry-mark {
  margin-left: auto; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 50%;
  box-sizing: border-box;
  color: var(--dsw-static-neutral-bluish-00);
}
.crwu-audit-side-entry-mark-ok { background: var(--dsw-alias-state-success-primary); }
.crwu-audit-side-entry-mark-bad { background: var(--dsw-alias-state-error-primary); }
.crwu-audit-side-entry-mark-busy { background: var(--dsw-alias-state-warn-primary); }
/* 自检中：圆里一段旋转的白弧。比静态图标更能说明「正在动」，也不需要额外的图形资产。 */
.crwu-audit-side-entry-mark-busy::after {
  content: '';
  box-sizing: border-box;
  width: 9px; height: 9px; border-radius: 50%;
  border: 1.6px solid color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 40%, transparent);
  border-top-color: var(--dsw-static-neutral-bluish-00);
  animation: crwu-audit-spin 0.8s linear infinite;
}
/* 尚未自检：空心圈 —— 安静，而且不会把「还没查」读成某种结论。 */
.crwu-audit-side-entry-mark-idle {
  background: transparent;
  border: 1.5px solid color-mix(in srgb, var(--dsw-alias-label-caption) 55%, transparent);
}

/* ════════════════════════════════════════════════════════════════════
   3. 未开发模块的占位页（报告评估）
   ────────────────────────────────────────────────────────────────────
   正文里只有一枚灰色的「开发中」标签，居中（用户 2026-09-22 口径：整页只写一个开发中）。
   做成一块有分量的圆角标签而不是"一行灰字飘在空白里"，也不再配图标 / 说明 / 计划事项——
   那些在一页明确不可用的内容上只会让人以为这里已经能用了。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-placeholder {
  display: flex; align-items: center; justify-content: center;
  min-height: 260px; padding: 24px;
}
.crwu-audit-placeholder-tag {
  padding: 8px 18px; border-radius: 12px;
  font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: 0.08em;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover);
  border: 1px solid var(--dsw-alias-border-l1);
}

/* ════════════════════════════════════════════════════════════════════
   4. 分段控件（页内：报告列表 / AI 审核列表）
   ────────────────────────────────────────────────────────────────────
   轻量 Apple Segmented Workspace Tabs：**容器才有底**（一枚 9px 圆角的浅槽），
   选中项是槽里浮起来的一块白片（1px 投影），没有下划线、也没有第二重选中状态。
   这是唯一一处"选中 = 换底色"的控件；页签容器透明 + 品牌色下划线那套已废弃
   （用户 2026-09-23 口径：不要红色 underline，不要红色下划线 + 底色双重选中）。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-tabs {
  display: inline-flex; gap: 2px; padding: 3px; margin: 0;
  border-radius: 9px; background: var(--crwu-tab-track); border: none;
}
.crwu-audit-tab {
  height: 34px; padding: 0 12px; border: none; border-radius: 7px;
  background: transparent; color: var(--crwu-tab-text);
  font-family: inherit; font-size: 13px; font-weight: 500; line-height: 18px;
  cursor: pointer;
  transition: background 120ms var(--crwu-ease), color 120ms var(--crwu-ease),
    box-shadow 160ms var(--crwu-ease);
}
.crwu-audit-tab:hover { background: var(--crwu-tab-hover); color: var(--crwu-tab-text-hover); }
.crwu-audit-tab:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
/* 选中：白片 + 极轻投影。hover 时不再追加别的层（禁止 hover 出红线 / 大灰块 / 位移）。 */
.crwu-audit-tab-on,
.crwu-audit-tab-on:hover {
  background: var(--crwu-surface); color: var(--crwu-text-primary); font-weight: 600;
  box-shadow: var(--crwu-shadow-tab);
}
.crwu-audit-tab-count {
  margin-left: 6px; color: var(--crwu-text-tertiary); font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.crwu-audit-tab-on .crwu-audit-tab-count { color: var(--crwu-text-tertiary); }

/* ════════════════════════════════════════════════════════════════════
   5. 卡片与分区
   ────────────────────────────────────────────────────────────────────
   办公风格的关键是「一眼能扫」：卡片只靠 1px 描边 + 最浅一档投影分层，
   标题条去掉整块底色、改成一条发丝线，避免页面被切成一格格的表格感。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-card {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1);
  margin-bottom: 14px; overflow: hidden;
}
.crwu-audit-card-title {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 16px; font-weight: 600; font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-card-title-text { min-width: 0; }
.crwu-audit-card-extra { margin-left: auto; font-weight: 400; color: var(--dsw-alias-label-caption); font-size: 12px; }
.crwu-audit-card-body { padding: 14px 16px; }

.crwu-audit-section {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1);
  margin-bottom: 14px; overflow: hidden;
}
.crwu-audit-section-head {
  display: flex; align-items: center; gap: 8px; padding: 11px 16px;
  background: transparent;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-section-title { font-weight: 600; font-size: 13px; }
.crwu-audit-section-count { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11.5px; }
.crwu-audit-section-body { padding: 6px 16px 12px; }

/* ════════════════════════════════════════════════════════════════════
   6. 提示条
   ────────────────────────────────────────────────────────────────────
   左缘一条 3px 色边 + 极浅底色：比整块染色克制，也不会和卡片描边打架。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-notice {
  border-radius: 10px; padding: 10px 14px; margin-bottom: 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-left-width: 3px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.crwu-audit-notice-warn {
  border-left-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary);
}
.crwu-audit-notice-ok {
  border-left-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-label-primary);
}

/* ════════════════════════════════════════════════════════════════════
   7. 排布工具类
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.crwu-audit-stack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.crwu-audit-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 14px 0; }
.crwu-audit-muted { color: var(--dsw-alias-label-secondary); }
.crwu-audit-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.crwu-audit-link { color: var(--dsw-alias-link); overflow-wrap: anywhere; }
.crwu-audit-grow { flex: 1 1 auto; }

/* ════════════════════════════════════════════════════════════════════
   8. 表格
   ────────────────────────────────────────────────────────────────────
   列宽用固定布局 + 百分比，不是 auto：
   auto 布局下浏览器把多出来的宽度全给最宽的那一列 —— 实测 1920px 视口时「报告名称」涨到 696px、
   2560px 时涨到 1149px，而「操作」那列几乎没有变化，于是右边一直很挤（用户报的「撑不满/很挤」）。
   fixed 布局让整张表严格等于容器宽度、各列按这里的分工分配。
   min-width 是下限：视口太窄时宁可让面板横向滚动，也不要把某一列压到内容折断。
   （注意：这段注释在模板字符串里，**不能出现反引号**，否则会把样式文本截断。）
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-table {
  width: 100%; min-width: 1000px;
  border-collapse: collapse; table-layout: fixed;
}
/* 列宽分工：流水号 23% 是**按内容算出来**的下限 —— 26 字符的等宽流水号（13px）约 203px，
   再加悬停复制图标 22px 与左右 padding 24px；低于这一档就会被从中间截断
   （它是用户检索用的标识，截断比换行更糟）。更新时间 14% 同理：业务时间改成
   YYYY-MM-DD HH:mm（16 字符）之后，12% 会把年份截掉 —— 而年份正是不能省的那一段。
   报告名列吸收剩余宽度，窄列一律 nowrap，整张表严格等于容器宽度、不出现横向滚动。 */
.crwu-audit-col-name { width: 22%; }
.crwu-audit-col-seq-no { width: 23%; }
.crwu-audit-col-risk { width: 6%; }
.crwu-audit-col-review { width: 12%; }
.crwu-audit-col-modified { width: 14%; }
.crwu-audit-col-action { width: 23%; }
/* AI 审核列表的三列分工（用户 2026-09-23 口径：38% / 42% / 20%）。
   它没有独立的表格组件：同一张 .crwu-audit-table 换一份 colgroup 就是另一张表。 */
.crwu-audit-col-res-seq-no { width: 38%; }
.crwu-audit-col-res-files { width: 42%; }
.crwu-audit-col-res-action { width: 20%; }
/* 表格自己横向滚动，而不是被卡片裁掉：表有 min-width，视口够窄时宁可滚动也不要把列切掉。 */
.crwu-audit-table-wrap { overflow-x: auto; }
.crwu-audit-th {
  text-align: left; font-weight: 500; height: 39px; padding: 0 12px; font-size: 12px;
  border-bottom: 1px solid var(--crwu-border);
  background: var(--crwu-surface-subtle);
  color: var(--crwu-th-text);
  /* 表头不换行：否则窄列会把「人工复核」竖着拆成三行，列宽也会跟着被压成一团。 */
  white-space: nowrap;
}
.crwu-audit-tbody-row { height: 82px; }
.crwu-audit-td {
  padding: 12px; vertical-align: middle;
  border-bottom: 1px solid var(--crwu-border);
  overflow-wrap: anywhere;
}
/* 行悬停给一点点底：一屏十几行时，眼睛不容易串行（办公场景的刚需）。
   菜单开着的那一行停在与悬停同一档、略深一档的选中底上（见 §20 的 selected）。 */
.crwu-audit-tbody-row:hover .crwu-audit-td { background: var(--crwu-hover); }
/* 列宽是"分工"而不是"抢"：报告名列表头最宽并吸收剩余宽度，窄列一律不换行，
   否则流水号/时间会被从中间折断、几列挤成一团（用户报的「列挤在一起」）。 */
.crwu-audit-td-name { min-width: 240px; }
.crwu-audit-td-nowrap {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 「初审 · 审核中」这行必须待在一行里；底下的复核节点名才可以换行。 */
.crwu-audit-td-review { min-width: 112px; }
.crwu-audit-td-action { min-width: 232px; }
.crwu-audit-td-action .crwu-audit-btn { margin: 2px 4px 2px 0; }

/* 单元格内部的三层排版：主行（报告名 14px/600，最多两行）、次行（副名/状态）、
   等宽辅助行（hash / 流水号 / 时间）。hash 只是辅助信息，不抢视觉（12px / 更浅一档色）。 */
.crwu-audit-cell-title {
  font-size: 14px; font-weight: 600; line-height: 1.45; letter-spacing: -0.01em;
  color: var(--crwu-text-primary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.crwu-audit-cell-sub {
  margin-top: 4px; color: var(--crwu-text-secondary); font-size: 12px; line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
}
.crwu-audit-cell-nowrap { white-space: nowrap; }
.crwu-audit-cell-mono {
  margin-top: 5px; color: var(--crwu-text-hash);
  font-family: var(--crwu-font-mono); font-size: 12px; line-height: 1.4;
}

/* ════════════════════════════════════════════════════════════════════
   9. 徽章与胶囊
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-badge {
  display: inline-block; border-radius: 6px; padding: 0 7px; margin-right: 4px;
  font-size: 11px; line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.crwu-audit-badge-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-badge-medium { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.crwu-audit-badge-high { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.crwu-audit-badge-low { color: var(--dsw-alias-label-caption); }

.crwu-audit-chip {
  display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
  border-radius: 999px; padding: 0 9px; font-size: 11px; line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.crwu-audit-chip-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-chip-bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.crwu-audit-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.crwu-audit-chip-muted { color: var(--dsw-alias-label-caption); }

/* ════════════════════════════════════════════════════════════════════
   10. 状态圆点
   ────────────────────────────────────────────────────────────────────
   内圈实心 + 外圈一圈同色半透明光晕：小尺寸下比纯实心更容易在密集列表里被看见。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block;
  background: var(--dsw-alias-label-caption);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-caption) 16%, transparent);
}
.crwu-audit-dot-ok {
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent);
}
.crwu-audit-dot-bad {
  background: var(--dsw-alias-state-error-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent);
}
.crwu-audit-dot-busy {
  background: var(--dsw-alias-state-warn-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);
}
.crwu-audit-dot-idle {
  background: var(--dsw-alias-label-caption);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-caption) 16%, transparent);
}

/* ════════════════════════════════════════════════════════════════════
   11. 自检结论（hero）
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-hero {
  display: flex; gap: 14px; align-items: flex-start;
  padding: 16px; margin-bottom: 14px; border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l1); border-left-width: 3px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1);
}
.crwu-audit-hero-ok { border-left-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-hero-bad { border-left-color: var(--dsw-alias-state-error-primary); }
/* 结论图标：圆角方块 + 同色浅底。比一颗裸圆点更"像一个结论"，也和卡片圆角语言一致。 */
.crwu-audit-hero-mark {
  flex: none; width: 40px; height: 40px; border-radius: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-hero-mark-ok {
  color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 34%, transparent);
}
.crwu-audit-hero-mark-bad {
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, transparent);
}
.crwu-audit-hero-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-hero-title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.crwu-audit-hero-sub { color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.crwu-audit-hero-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }

/* ════════════════════════════════════════════════════════════════════
   环境页（2026-09-26 重排）：紧凑状态摘要 + 引导式配置工作区
   ────────────────────────────────────────────────────────────────────
   办公 + Apple 设置页的层级感：
   - 顶部摘要**一条带**（不罗列全部阻塞项，不给「进入报告审核」按钮）；
   - 工作区是**一个** surface，左 260px 步骤导航（发丝分隔线分区，不各自套卡片），
     右侧当前步骤；窄屏（<=860px）改成顶部横向步骤条 + 下方详情，绝不横向溢出；
   - 分层只靠 1px 发丝线、留白与最轻一档阴影；状态色只出现在小图标 / 状态点 / 短标签上。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-status {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 14px 16px; margin-bottom: 14px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1);
}
.crwu-audit-status-ok { border-left: 3px solid var(--dsw-alias-state-success-primary); }
.crwu-audit-status-bad { border-left: 3px solid var(--dsw-alias-state-warn-primary); }
.crwu-audit-status-mark {
  flex: none; width: 32px; height: 32px; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
}
.crwu-audit-status-mark-ok {
  color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
}
.crwu-audit-status-mark-bad {
  color: var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
}
.crwu-audit-status-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-status-title { font-size: 15px; font-weight: 600; line-height: 22px; color: var(--crwu-text-primary); }
.crwu-audit-status-sub { margin-top: 2px; font-size: 13px; line-height: 19px; color: var(--crwu-text-secondary); }
.crwu-audit-status-note {
  display: flex; align-items: center; gap: 6px;
  margin-top: 6px; padding: 6px 10px; border-radius: 8px;
  font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
}
.crwu-audit-status-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  margin-top: 8px; font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary);
  font-variant-numeric: tabular-nums;
}
.crwu-audit-status-dot {
  width: 3px; height: 3px; border-radius: 50%; flex: none;
  background: var(--crwu-text-tertiary);
}
.crwu-audit-status-action { flex: none; display: flex; align-items: flex-start; padding-top: 2px; }

.crwu-audit-workspace {
  display: grid; grid-template-columns: 260px minmax(0, 1fr);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1);
  overflow: hidden;
}
.crwu-audit-steps { min-width: 0; border-right: 1px solid var(--crwu-border); background: var(--crwu-surface-subtle); }
.crwu-audit-steps-list { list-style: none; margin: 0; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.crwu-audit-step {
  display: flex; align-items: center; gap: 10px; width: 100%;
  min-height: 44px; padding: 6px 10px; border: none; border-radius: 10px;
  background: transparent; color: var(--crwu-text-secondary);
  font-family: inherit; font-size: 13px; line-height: 18px; text-align: left; cursor: pointer;
  transition: background 140ms var(--crwu-ease), color 140ms var(--crwu-ease);
}
.crwu-audit-step:hover { background: var(--crwu-hover); color: var(--crwu-text-primary); }
.crwu-audit-step:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: -2px; }
.crwu-audit-step-on, .crwu-audit-step-on:hover {
  background: var(--crwu-surface); color: var(--crwu-text-primary); font-weight: 600;
  box-shadow: var(--crwu-shadow-tab);
}
.crwu-audit-step-index {
  flex: none; width: 22px; height: 22px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--crwu-text-tertiary);
  border: 1px solid var(--crwu-border-strong); background: var(--crwu-surface);
}
/* 已完成：实心绿点（状态色只出现在这枚小图标上，不铺底）。 */
.crwu-audit-step-index-done {
  color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
}
.crwu-audit-step-text { min-width: 0; display: flex; flex-direction: column; }
.crwu-audit-step-title { font-size: 13px; line-height: 18px; }
.crwu-audit-step-state { font-size: 11px; line-height: 16px; color: var(--crwu-text-tertiary); font-weight: 400; }
.crwu-audit-step-panel { min-width: 0; padding: 16px 18px; }
.crwu-audit-step-panel-head {
  display: flex; align-items: center; gap: 10px;
  padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--crwu-border);
}
.crwu-audit-step-panel-title { flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 600; }
.crwu-audit-step-lead { margin: 0 0 12px; font-size: 13px; line-height: 20px; color: var(--crwu-text-secondary); }
/* 步骤内的表单块：与「一行配置项」同一套语言，但自带一段引导文案。 */
.crwu-audit-step-card { display: block; }
.crwu-audit-step-card-head { display: flex; align-items: center; gap: 10px; }
.crwu-audit-fields { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
.crwu-audit-field { display: flex; flex-direction: column; gap: 4px; }
.crwu-audit-field-label { font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary); }
/* 窄屏：左侧导航变成顶部横向步骤条，绝不横向溢出。 */
@media (max-width: 860px) {
  .crwu-audit-workspace { grid-template-columns: minmax(0, 1fr); }
  .crwu-audit-steps { border-right: none; border-bottom: 1px solid var(--crwu-border); }
  .crwu-audit-steps-list { flex-direction: row; overflow-x: auto; }
  .crwu-audit-step { width: auto; flex: none; }
}
@media (prefers-reduced-motion: reduce) {
  .crwu-audit-step, .crwu-audit-step:hover { transition: none; }
}

.crwu-audit-meter {
  height: 6px; border-radius: 999px; overflow: hidden; margin-top: 12px;
  background: var(--dsw-alias-interactive-bg-hover);
}
.crwu-audit-meter-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-state-success-primary); }
.crwu-audit-meter-fill-bad { background: var(--dsw-alias-state-warn-primary); }

.crwu-audit-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(116px, 1fr)); gap: 10px; margin-top: 14px; }
.crwu-audit-metric {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2); padding: 8px 11px;
}
.crwu-audit-metric-value {
  font-size: 16px; font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.crwu-audit-metric-label { color: var(--dsw-alias-label-caption); font-size: 11px; }

/* ════════════════════════════════════════════════════════════════════
   12. 环境自检的五层（插件内置组件 / DSH 脚本运行时 / 登录与凭据授权 / OSS 交付配置 / 外部数据）
   ────────────────────────────────────────────────────────────────────
   每层一张卡：标题 + x/y 已就绪 + 层级色；**没就绪的层默认展开**，全部就绪的收成一行。
   层级色只用在左边框上（不整块染色）：一页五层时整块染色会喧宾夺主，左边一条足够分层次。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-layer {
  border: 1px solid var(--dsw-alias-border-l1); border-left-width: 3px; border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1);
  margin-bottom: 12px; overflow: hidden;
}
.crwu-audit-layer-ok { border-left-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-layer-bad { border-left-color: var(--dsw-alias-state-warn-primary); }
.crwu-audit-layer-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 11px 14px; border: none; font-family: inherit; font-size: 13px; text-align: left;
  background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer;
  transition: background 0.14s ease;
}
.crwu-audit-layer-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.crwu-audit-layer-title { font-weight: 600; }
.crwu-audit-layer-count { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11.5px; }
.crwu-audit-layer-toggle { color: var(--dsw-alias-link); font-size: 11.5px; white-space: nowrap; }
.crwu-audit-layer-body { padding: 6px 14px 12px; }
.crwu-audit-layer-head-extra {
  padding: 7px 14px; font-size: 12px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2); border-top: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-layer-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
/* 层里嵌的"怎么办"块（例如 ④ 的 AK 表单）：左侧一条竖线 + 去掉内层卡片的重复边框感。 */
.crwu-audit-layer-fix { margin-top: 10px; padding-left: 12px; border-left: 2px solid var(--dsw-alias-border-l2); }
.crwu-audit-layer-fix .crwu-audit-card { margin-bottom: 0; box-shadow: none; }

/* ════════════════════════════════════════════════════════════════════
   13. 开发者诊断
   ────────────────────────────────────────────────────────────────────
   默认收起在内容区右下角：sha256、清单来源、会话 id 这些是开发信息，普通员工不需要注意。
   展开内容保持全宽并排在入口上方，入口本身不悬浮、不遮挡员工表单。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-details {
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  margin-top: 4px;
}
.crwu-audit-details-head {
  display: flex; align-items: center; gap: 8px; width: auto; min-height: 34px;
  padding: 6px 9px; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font-family: inherit; font-size: 12px; text-align: left; cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.crwu-audit-details-head:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.crwu-audit-details-title { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.crwu-audit-details-title svg { flex: 0 0 auto; color: currentColor; }
.crwu-audit-details-toggle { margin-left: auto; color: currentColor; font-size: 11.5px; white-space: nowrap; }
.crwu-audit-details-contact {
  padding: 0 9px 4px; color: var(--dsw-alias-label-secondary); font-size: 12px;
  text-decoration: none; text-underline-offset: 3px;
}
.crwu-audit-details-contact:hover { color: var(--dsw-alias-link); text-decoration: underline; }
.crwu-audit-details-contact:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 4px; }
.crwu-audit-details-body {
  align-self: stretch; order: -1; width: 100%; box-sizing: border-box;
  padding: 16px 18px 18px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1);
}
.crwu-audit-details-panel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-details-panel-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; }
.crwu-audit-details-copy-error { margin: -4px 0 10px; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.crwu-audit-details-body .crwu-audit-kv { margin-top: 0; }
.crwu-audit-hero-todo { margin-top: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }

/* ════════════════════════════════════════════════════════════════════
   14. 单条检查项 / 阻塞清单
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-item {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 11px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-item:last-child { border-bottom: none; }
.crwu-audit-item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.crwu-audit-item-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-item-name { font-weight: 600; }
.crwu-audit-item-note { color: var(--dsw-alias-label-caption); }
.crwu-audit-item-meta { margin-top: 3px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.crwu-audit-item-fix { margin-top: 4px; color: var(--dsw-alias-state-warn-primary); overflow-wrap: anywhere; }

.crwu-audit-blockers { list-style: none; margin: 8px 0 0; padding: 0; }
.crwu-audit-blocker {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-blocker:last-child { border-bottom: none; }
.crwu-audit-blocker-index {
  flex: none; width: 18px; height: 18px; margin-top: 2px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; line-height: 1;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
}

/* ════════════════════════════════════════════════════════════════════
   15. 加载态与门禁
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-spinner {
  width: 14px; height: 14px; flex: none; display: inline-block; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: crwu-audit-spin 0.9s linear infinite;
}
.crwu-audit-spinner-large { width: 26px; height: 26px; border-width: 3px; }
@keyframes crwu-audit-spin { to { transform: rotate(360deg); } }

.crwu-audit-loading {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: 64px 12px; color: var(--dsw-alias-label-secondary);
}
.crwu-audit-loading-inline {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 0 12px; color: var(--dsw-alias-label-secondary);
}

/* 不确定进度条：翻页 / 重新自检 / 刷新列表时，让「正在加载」有一个看得见的落点。
   只压暗正文而不拦按钮的部分不放这里 —— 被 dim 包住的区域连点击一起停掉，防手快连点。 */
/* ════════════════════════════════════════════════════════════════════
   3. 统一的「正在自检环境」等待页
   ────────────────────────────────────────────────────────────────────
   第一次点进工作台会跑一轮环境自检（工具 / 登录态 / 上传配置 / 外部数据），这几秒里
   整块正文只放这一页：会依次亮起来的品牌标记 + 两行字 + 一条不确定进度条。
   先前渲染的是**环境信息页的半成品**，看起来像"页面缺了一块"（用户 2026-09-22 口径：
   「需要一个统一的 loading 页面…这个注意有个好看的 svg」）。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-loading-pane {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; min-height: 360px; padding: 40px 24px; text-align: center;
}
/* 品牌标记当加载符号：整体极轻地呼吸（1 → 1.04 → 1，1.8s），四个色块再按顺序依次亮起
   （见下面 nth-child 的延迟）—— 没有旋转、没有大幅缩放、没有渐变光晕。 */
.crwu-audit-loading-mark {
  display: inline-flex; margin-bottom: 6px;
  animation: crwu-audit-breathe 1.8s ease-in-out infinite;
}
.crwu-audit-loading-mark svg polygon { animation: crwu-audit-brand-wave 1.6s ease-in-out infinite; }
.crwu-audit-loading-mark svg polygon:nth-child(2) { animation-delay: 0.14s; }
.crwu-audit-loading-mark svg polygon:nth-child(3) { animation-delay: 0.28s; }
.crwu-audit-loading-mark svg polygon:nth-child(4) { animation-delay: 0.42s; }
.crwu-audit-loading-title { font-size: 15px; font-weight: 600; line-height: 22px; }
.crwu-audit-loading-hint {
  max-width: 420px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 20px;
}
/* 进度条限宽：等待页里它是一条"心跳"，不该横贯整个正文。 */
.crwu-audit-loading-pane .crwu-audit-load-bar { width: 168px; margin: 10px 0 0; }

@keyframes crwu-audit-brand-wave {
  0%, 100% { opacity: 0.25; }
  35% { opacity: 1; }
}
@keyframes crwu-audit-breathe {
  0%, 100% { transform: scale(1); opacity: 0.7; }
  50% { transform: scale(1.04); opacity: 1; }
}
/* 尊重系统的"减少动态效果"：关掉动画，但页面结构与文案不受影响。 */
@media (prefers-reduced-motion: reduce) {
  .crwu-audit-loading-mark,
  .crwu-audit-loading-mark svg polygon,
  .crwu-audit-load-bar-fill { animation: none; }
}

.crwu-audit-load-bar {
  position: relative; height: 2px; margin: 0 0 12px; overflow: hidden;
  border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover);
}
.crwu-audit-load-bar-fill {
  position: absolute; top: 0; left: 0; height: 100%; width: 35%;
  border-radius: 999px; background: var(--dsw-alias-brand-primary);
  animation: crwu-audit-load-slide 1.1s ease-in-out infinite;
}
@keyframes crwu-audit-load-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(320%); }
}
.crwu-audit-dim { opacity: 0.55; pointer-events: none; }

/* ════════════════════════════════════════════════════════════════════
   16. 插件级授权门槛（弹框 / 拒绝屏）
   ────────────────────────────────────────────────────────────────────
   授权是本插件的硬前置：没有它取不到氚云待办、发不出钉钉回传，所以未授权时
   直接把整个面板挡住（Host 侧另有一条 blocked 兜底，防止绕过 UI 调操作）。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-auth-granted { color: var(--dsw-alias-label-caption); }

/* ════════════════════════════════════════════════════════════════════
   17. 「审核信息」右侧抽屉
   ────────────────────────────────────────────────────────────────────
   固定定位贴着视口右侧：抽屉属于「页面级」的临时面板，不该被面板自己的滚动容器裁掉。
   z-index 要高过面板内容，遮罩再低一层。

   用户 2026-09-23 口径：
   - 宽度 520–560（**不再加宽**），浅深两套色板都复用工作台 token，不在抽屉里另立一套；
   - 遮罩只 rgba(0,0,0,.32) + blur(2px)：关闭之后用户还要看得出自己是**从哪一行**打开的；
   - 开：translateX(20px) → 0 / opacity .85 → 1（200ms）；关：150ms，由父层延迟卸载（见 WorkbenchPanel）。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-side-drawer-backdrop {
  position: fixed; inset: 0; z-index: 900;
  background: var(--crwu-scrim);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  animation: crwu-audit-scrim-in 160ms var(--crwu-ease) both;
}
.crwu-audit-side-drawer-backdrop-out { animation: crwu-audit-scrim-out 150ms var(--crwu-ease) both; }
@keyframes crwu-audit-scrim-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes crwu-audit-scrim-out { from { opacity: 1; } to { opacity: 0; } }
.crwu-audit-side-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 901;
  box-sizing: border-box; width: min(var(--crwu-drawer-w), 92vw); max-width: var(--crwu-drawer-w);
  display: flex; flex-direction: column;
  background: var(--crwu-surface);
  border-left: 1px solid var(--crwu-border);
  box-shadow: none;
  animation: crwu-audit-drawer-in 200ms var(--crwu-ease) both;
}
.crwu-audit-side-drawer-out { animation: crwu-audit-drawer-out 150ms var(--crwu-ease) both; pointer-events: none; }
@keyframes crwu-audit-drawer-in {
  from { transform: translateX(20px); opacity: 0.85; }
  to { transform: translateX(0); opacity: 1; }
}
@keyframes crwu-audit-drawer-out {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(16px); opacity: 0.9; }
}
@media (prefers-reduced-motion: reduce) {
  .crwu-audit-side-drawer, .crwu-audit-side-drawer-out,
  .crwu-audit-side-drawer-backdrop, .crwu-audit-side-drawer-backdrop-out { animation: none; }
}
@keyframes crwu-audit-rise {
  from { transform: translateY(8px); opacity: 0.4; }
  to { transform: none; opacity: 1; }
}
/* 头部：标题 16/600 + 下面一行等宽流水号 + 右侧 ×（不再有「关闭」文字按钮）。 */
.crwu-audit-side-drawer-head {
  flex: none; display: flex; align-items: flex-start; gap: 12px;
  padding: 16px 16px 12px 20px;
  background: var(--crwu-surface);
  border-bottom: 1px solid var(--crwu-border);
}
.crwu-audit-side-drawer-title {
  margin-right: auto; min-width: 0;
  display: flex; flex-direction: column; gap: 3px;
  font-size: 16px; font-weight: 600; line-height: 22px; color: var(--crwu-text-primary);
}
.crwu-audit-side-drawer-sub {
  font-family: var(--crwu-font-mono); font-size: 12px; line-height: 16px;
  color: var(--crwu-text-tertiary);
  overflow-wrap: anywhere;
}
/* × ：透明底 + 悬停一层中性底，32×32（用户口径：删除「关闭」文字按钮，改成标准 Icon Button）。 */
.crwu-audit-side-drawer-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px;
  background: transparent; color: var(--crwu-control-text);
  font-family: inherit; font-size: 18px; line-height: 1; cursor: pointer;
  transition: background 120ms var(--crwu-ease), color 120ms var(--crwu-ease);
}
.crwu-audit-side-drawer-close:hover { background: var(--crwu-control-hover); color: var(--crwu-text-primary); }
.crwu-audit-side-drawer-close:active { background: var(--crwu-control-active); }
.crwu-audit-side-drawer-close:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-side-drawer-body {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 20px 20px 28px;
  scrollbar-width: thin;
  scrollbar-color: var(--dsh-scrollbar-thumb, var(--dsw-alias-scrollbar-bg-l2)) transparent;
}

/* ── Drawer 内容：核心指标 → 已提未改 → AI 问题列表 → 报告信息 → 技术详情 ──────
   2026-09-23 第二轮：抽屉的定位是「AI 审核质量与问题摘要」，不是「审核状态详情」。
   所以第一屏没有结论大卡，最大的字是**复核命中率**，下面是两个同级小指标（AI 检出 / 已提未改），
   然后直接进问题清单。主要靠 Spacing 分层（小节间距 24、内容间距 10–12）。 */
.crwu-audit-sec { margin-top: var(--crwu-space-6); }
.crwu-audit-sec:first-child { margin-top: 0; }
.crwu-audit-sec-title {
  margin-bottom: var(--crwu-space-3);
  font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
  color: var(--crwu-text-tertiary);
}
/* 核心指标：一块轻量 Surface（不画明显边框、不做三个 Dashboard 卡）。 */
.crwu-audit-km {
  box-sizing: border-box; padding: var(--crwu-space-4);
  border: 1px solid var(--crwu-border); border-radius: 12px;
  background: var(--crwu-sum-bg);
}
.crwu-audit-rate-label { font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary); }
/* 命中率是整个抽屉的**第一视觉重点**：30–34px / 600；不按高低给红黄绿（命中率不是考试成绩）。 */
.crwu-audit-rate-value {
  margin-top: 2px;
  font-size: 32px; font-weight: 600; line-height: 38px; letter-spacing: -0.02em;
  color: var(--crwu-text-primary); font-variant-numeric: tabular-nums;
}
.crwu-audit-rate-meta { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary); }
.crwu-audit-km-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
  margin-top: var(--crwu-space-4); padding-top: var(--crwu-space-3);
  border-top: 1px solid var(--crwu-border);
}
.crwu-audit-km-label { font-size: 12px; line-height: 16px; color: var(--crwu-text-tertiary); }
.crwu-audit-km-value {
  margin-top: 2px; font-size: 20px; font-weight: 600; line-height: 26px;
  color: var(--crwu-text-primary); font-variant-numeric: tabular-nums;
}
.crwu-audit-km-hint { margin-top: 3px; font-size: 12px; line-height: 17px; color: var(--crwu-text-tertiary); }

/* 「已提出但仍未整改」：业务上比 AI 新发现问题更值得注意，但**不做大红警告** ——
   左侧 3px 琥珀强调条 + 数量 badge（低浓度红底红字）。 */
.crwu-audit-raised {
  box-sizing: border-box; margin-top: var(--crwu-space-5);
  padding: 0 var(--crwu-space-3) 0 var(--crwu-space-3);
  border: 1px solid var(--crwu-border); border-left: 3px solid var(--crwu-risk-b);
  border-radius: 10px; background: transparent;
}
.crwu-audit-raised-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 11px 0; border: none; background: transparent;
  font-family: inherit; text-align: left; cursor: pointer;
  transition: background 160ms var(--crwu-ease);
}
.crwu-audit-raised-head:hover { background: var(--crwu-tech-hover); }
.crwu-audit-raised-head:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-raised-title { display: block; font-size: 13px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-audit-raised-sub {
  display: block; margin-top: 2px;
  font-size: 12px; line-height: 17px; color: var(--crwu-text-secondary);
}
.crwu-audit-raised-count {
  flex: none; margin-left: auto; padding: 0 8px; height: 20px; box-sizing: border-box;
  display: inline-flex; align-items: center; border-radius: 999px;
  background: color-mix(in srgb, var(--crwu-risk-a) 10%, transparent);
  color: var(--crwu-risk-a); font-size: 12px; font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.crwu-audit-raised .crwu-audit-issue-row:first-child { border-top: none; }
.crwu-audit-raised .crwu-audit-issue-row { padding-left: 0; padding-right: 0; }

/* 通用折叠（已提未改 / AI 问题 / 报告信息 / 技术详情）：grid-rows 0fr→1fr 拿到 170ms 高度动画，
   不需要测量高度，也不会在数据变化时跳。 */
.crwu-audit-acc-body {
  display: grid; grid-template-rows: 0fr;
  transition: grid-template-rows 170ms var(--crwu-ease);
}
.crwu-audit-acc[data-open="true"] .crwu-audit-acc-body { grid-template-rows: 1fr; }
.crwu-audit-acc-inner { overflow: hidden; min-height: 0; }
.crwu-audit-acc-chevron {
  flex: none; margin-left: auto; font-size: 13px; line-height: 1;
  color: var(--crwu-text-tertiary);
  transition: transform 170ms var(--crwu-ease);
}
.crwu-audit-acc[data-open="true"] .crwu-audit-acc-chevron { transform: rotate(90deg); }
/* 折叠小节（报告信息 / 其他事项 / 技术详情同一形态）：顶部发丝线 + 40px 折叠头。 */
.crwu-audit-fold { margin-top: var(--crwu-space-6); border-top: 1px solid var(--crwu-border); }
.crwu-audit-fold .crwu-audit-acc-inner { padding-top: var(--crwu-space-3); }
.crwu-audit-fold-head {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 40px;
  padding: 0; border: none; background: transparent;
  color: var(--crwu-text-tertiary); font-family: inherit; font-size: 12px; font-weight: 600;
  letter-spacing: 0.02em; text-align: left; cursor: pointer;
  transition: background 160ms var(--crwu-ease), color 160ms var(--crwu-ease);
}
.crwu-audit-fold-head:hover { background: var(--crwu-tech-hover); color: var(--crwu-text-secondary); }
.crwu-audit-fold-head:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: -2px; }
.crwu-audit-fold-title { min-width: 0; }

/* AI 检出问题：一条一行（不是 Card）；严重程度 + 标题 + 简述，点开才给位置与建议。 */
.crwu-audit-issue-list { display: flex; flex-direction: column; }
.crwu-audit-issue-row { border-top: 1px solid var(--crwu-border); }
.crwu-audit-issue-list > .crwu-audit-issue-row:first-child { border-top: none; }
.crwu-audit-issue-head {
  display: flex; align-items: flex-start; gap: 8px; width: 100%;
  padding: 11px 0; border: none; background: transparent;
  font-family: inherit; text-align: left; cursor: pointer;
  transition: background 120ms var(--crwu-ease);
}
.crwu-audit-issue-head:hover { background: var(--crwu-tech-hover); }
.crwu-audit-issue-head:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-issue-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-issue-severity {
  display: inline-flex; align-items: center; gap: 6px; margin-bottom: 3px;
  font-size: 12px; font-weight: 600; color: var(--crwu-risk-text);
}
.crwu-audit-issue-title {
  font-size: 13px; font-weight: 600; line-height: 19px; color: var(--crwu-text-primary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.crwu-audit-issue-brief {
  margin-top: 3px; font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.crwu-audit-issue-detail { padding: 0 0 12px; }
.crwu-audit-issue-field { display: flex; gap: 10px; margin-top: 8px; }
.crwu-audit-issue-field-label {
  flex: 0 0 62px; font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary);
}
.crwu-audit-issue-field-value {
  flex: 1 1 auto; min-width: 0; font-size: 12px; line-height: 18px;
  color: var(--crwu-text-secondary); overflow-wrap: anywhere; white-space: pre-wrap;
}
.crwu-audit-issue-link {
  display: inline-flex; align-items: center; gap: 4px; margin-top: 10px; padding: 0;
  border: none; background: transparent; cursor: pointer;
  color: var(--crwu-text-secondary); font-family: inherit; font-size: 12px; font-weight: 500;
  transition: color 120ms var(--crwu-ease);
}
.crwu-audit-issue-link:hover { color: var(--crwu-text-primary); }
.crwu-audit-issue-link:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; border-radius: 4px; }
/* 二级小结（高/中/低 · 待确认/未检查 · 三条带）：一条轻文案，不占块。 */
.crwu-audit-summary-line {
  margin-top: 10px; font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
}
.crwu-audit-sec .crwu-audit-summary-line { margin-top: 0; margin-bottom: 6px; }
/* 报告信息：值允许换行（报告版本可能是很长的一行原文，**不解析、只换行**）。 */
.crwu-audit-info-value-wrap { line-height: 1.55; overflow-wrap: anywhere; max-width: 46ch; }

/* ── 技术详情里的原始值 ──────────────────────────────────────────────────
   （折叠机制与 fold 共用；这里只管原始值的排版：等宽、允许换行、可复制。） */
.crwu-audit-tech-row { display: flex; gap: 10px; padding: 7px 0; border-top: 1px solid var(--crwu-border); }
.crwu-audit-tech-row:first-child { border-top: none; }
.crwu-audit-tech-key { flex: 0 0 42%; font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary); overflow-wrap: anywhere; }
.crwu-audit-tech-value {
  flex: 1 1 auto; min-width: 0; font-family: var(--crwu-font-mono); font-size: 12px; line-height: 18px;
  color: var(--crwu-text-secondary); overflow-wrap: anywhere; white-space: pre-wrap;
}
.crwu-audit-tech-json {
  box-sizing: border-box; margin: 8px 0 0; padding: 10px 12px; max-height: 240px; overflow: auto;
  border: 1px solid var(--crwu-border); border-radius: 8px; background: var(--crwu-surface-subtle);
  font-family: var(--crwu-font-mono); font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.crwu-audit-tech-copy {
  display: inline-flex; align-items: center; height: 24px; padding: 0 9px; margin-top: 8px;
  border: none; border-radius: 6px; background: var(--crwu-control); color: var(--crwu-control-text);
  font-family: inherit; font-size: 12px; cursor: pointer;
  transition: background 120ms var(--crwu-ease), color 120ms var(--crwu-ease);
}
.crwu-audit-tech-copy:hover { background: var(--crwu-control-hover); color: var(--crwu-text-primary); }
.crwu-audit-tech-hint { margin-top: 8px; font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary); }
@media (prefers-reduced-motion: reduce) {
  .crwu-audit-acc-body, .crwu-audit-acc-chevron { transition: none; }
}
.crwu-audit-gate {
  border: 1px dashed var(--dsw-alias-state-warn-primary);
  border-radius: 14px; padding: 16px 18px; margin-bottom: 14px;
}
.crwu-audit-gate-title { font-weight: 600; color: var(--dsw-alias-state-warn-primary); }

/* ════════════════════════════════════════════════════════════════════
   18. 按钮 / 图标按钮 / 输入 / 抽屉 / 键值表
   ────────────────────────────────────────────────────────────────────
   按钮是这套视觉里唯一「有重量」的元素：一屏里**最多一处实心**（主操作），
   其余都是中性面或 Ghost —— 这是 Apple 的层级感做法，也是办公场景里防误点的需要。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-btn {
  box-sizing: border-box; height: 30px; padding: 0 12px;
  border-radius: 8px; border: 1px solid var(--crwu-border-strong);
  background: var(--crwu-surface); color: var(--crwu-text-primary);
  font-family: inherit; font-size: 13px; font-weight: 500; line-height: 18px;
  cursor: pointer; white-space: nowrap;
  transition: background 120ms var(--crwu-ease), border-color 120ms var(--crwu-ease),
    color 120ms var(--crwu-ease), transform 120ms var(--crwu-ease), box-shadow 120ms var(--crwu-ease);
}
.crwu-audit-btn:hover:not(:disabled) { background: var(--crwu-hover); }
.crwu-audit-btn:active:not(:disabled) { transform: scale(0.97); }
.crwu-audit-btn:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-btn:disabled { opacity: 0.45; cursor: not-allowed; }
/* 变体一律「双类」选择器（(0,2,0)）：基础按钮只有 (0,1,0)，同特异度下会被排在更后的规则吃掉
   —— 那正是历史缺陷「悬停主按钮整个全黑」的根因（深底 + 深字）。双类不依赖书写顺序。 */
.crwu-audit-btn.crwu-audit-btn-primary {
  height: 32px; padding: 0 12px;
  border-color: transparent; background: var(--crwu-primary-bg); color: var(--crwu-primary-text);
}
.crwu-audit-btn.crwu-audit-btn-primary:hover,
.crwu-audit-btn.crwu-audit-btn-primary:hover:not(:disabled) {
  background: var(--crwu-primary-bg-hover);
  transform: translateY(-1px);
}
.crwu-audit-btn.crwu-audit-btn-primary:active:not(:disabled) { transform: scale(0.97); }
/* 警示变体（行内「确认重新审核」）：琥珀字 + 琥珀描边，与旁边的「取消」区分开。 */
.crwu-audit-btn.crwu-audit-btn-warn {
  border-color: color-mix(in srgb, var(--crwu-risk-b) 55%, transparent);
  color: var(--crwu-risk-b); background: var(--crwu-surface);
}
.crwu-audit-btn.crwu-audit-btn-warn:hover:not(:disabled) { background: var(--crwu-hover); }
.crwu-audit-btn-small { height: 28px; padding: 0 10px; font-size: 12px; }

/* 次级控件（列表工具条的「刷新」/ 操作列的小鲸鱼 / ••• / 流水号复制）：
   **同一套中性底 + 同一套悬停格**（--crwu-control*），只有主操作是实心 —— 用户 2026-09-23 口径
   「操作列的按钮颜色不一致，还有刷新按钮」。刷新期间**只有图标转**：已有列表保持显示，
   不清空、不白屏、不位移。 */
.crwu-audit-ghost {
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
  height: 36px; padding: 0 10px; border: none; border-radius: 8px;
  background: var(--crwu-control); color: var(--crwu-control-text);
  font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background 120ms var(--crwu-ease), color 120ms var(--crwu-ease);
}
.crwu-audit-ghost:hover:not(:disabled) { background: var(--crwu-control-hover); color: var(--crwu-text-primary); }
.crwu-audit-ghost:active:not(:disabled) { background: var(--crwu-control-active); transform: scale(0.98); }
.crwu-audit-ghost:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-ghost:disabled { opacity: 0.45; cursor: not-allowed; }
.crwu-audit-ghost svg { flex: none; }
.crwu-audit-ghost-busy svg { animation: crwu-audit-ghost-spin 900ms linear infinite; }
@keyframes crwu-audit-ghost-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .crwu-audit-ghost-busy svg { animation: none; }
}

/* 抽屉与键值表（审核信息的内容体；外壳见 §17）。 */
.crwu-audit-drawer { padding: 2px 0; }
.crwu-audit-drawer-head { font-weight: 600; margin-bottom: 8px; }
.crwu-audit-kv { display: grid; grid-template-columns: 150px 1fr; gap: 9px 14px; align-items: baseline; }
.crwu-audit-kv-key { color: var(--crwu-text-tertiary); font-size: 12px; }
.crwu-audit-kv-value { overflow-wrap: anywhere; color: var(--crwu-text-primary); }

/* ════════════════════════════════════════════════════════════════════
   19. 工作台 Design Token
   ────────────────────────────────────────────────────────────────────
   这是**整份样式表里唯一允许写字面量色值的块**（有一条测试扫描它之外的所有规则，
   发现十六进制 / rgb() / hsl() 就红）。其它任何地方只允许引用这些 --crwu-* 或 DSH 的 --dsw-*。

   明暗两套：浅色写在这里，深色按 DSH 解析出来的 body[data-ds-dark-theme] 覆盖。
   为什么认这个属性而不是 prefers-color-scheme：用户的偏好可以是"跟随系统"也可以是手动选的，
   主题插件会把最终结论写到 body 的那个属性上 —— 直接读它，两种来源都对。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-root {
  /* 尺寸与动效（组件里只引用，不写魔法数字） */
  --crwu-space-1: 4px; --crwu-space-2: 8px; --crwu-space-3: 12px; --crwu-space-4: 16px;
  --crwu-space-5: 20px; --crwu-space-6: 24px; --crwu-space-8: 32px;
  --crwu-radius-sm: 8px; --crwu-radius-md: 10px; --crwu-radius-lg: 12px; --crwu-radius-xl: 14px;
  --crwu-ease: cubic-bezier(0.16, 1, 0.3, 1);
  --crwu-font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --crwu-pad-x: 24px;

  /* 面与线 */
  --crwu-app-bg: #F4F5F7;
  --crwu-workspace-bg: #F7F8FA;
  --crwu-header-bg: rgba(255, 255, 255, 0.92);
  --crwu-surface: #FFFFFF;
  --crwu-surface-subtle: #FAFAFB;
  --crwu-hover: #F5F6F7;
  --crwu-selected: #F0F1F3;
  --crwu-border: rgba(0, 0, 0, 0.06);
  --crwu-border-strong: rgba(0, 0, 0, 0.10);

  /* 文字三级 + 三种专用前景 */
  --crwu-text-primary: #1D1D1F;
  --crwu-text-secondary: #6E6E73;
  --crwu-text-tertiary: #9A9A9F;
  --crwu-text-body: #414246;
  --crwu-text-mono: #48494D;
  --crwu-text-hash: #A0A1A5;
  --crwu-th-text: #8C8D92;
  --crwu-risk-text: #55565A;

  /* 品牌与风险语义色（不随明暗翻转） */
  --crwu-brand: #D84A4A;
  --crwu-risk-a: #DE5A5A;
  --crwu-risk-b: #D4A043;
  --crwu-risk-c: #8B8D92;
  /* 审核结论「通过」用低饱和绿：结论圆点用它，不做大色块、不做交通灯。 */
  --crwu-risk-pass: #3F9D6A;
  /* 抽屉与 Drawer 专用面（尺寸 + 两块极浅的底/线；深浅各一份） */
  --crwu-drawer-w: 580px;
  --crwu-sum-bg: rgba(0, 0, 0, 0.022);
  --crwu-sum-border: rgba(0, 0, 0, 0.06);
  --crwu-tech-hover: rgba(0, 0, 0, 0.02);

  /* 控件专用面 */
  --crwu-tab-track: #F2F3F5;
  --crwu-tab-text: #77787C;
  --crwu-tab-text-hover: #333438;
  --crwu-tab-hover: rgba(255, 255, 255, 0.55);
  --crwu-input-bg: #F4F5F6;
  /* 次级控件（刷新 / 小鲸鱼 / ••• / 流水号复制）共用**同一套中性底**：
     用户口径（2026-09-23）：「操作列的按钮颜色不一致，还有刷新按钮」—— 一个填充、一个全透明、
     一个又是 Ghost，同一行里三种底。现在三处都走这三个格，只有主操作是实心。
     取值必须与 --crwu-hover（行悬停底）**分得开**，否则悬停到那一行时控件的底会被吃掉。 */
  --crwu-control: #EFF0F2;
  --crwu-control-hover: #E4E5E8;
  --crwu-control-active: #DADCE0;
  --crwu-control-text: #5F6065;
  /* 浮层菜单项自己的悬停底（在 --crwu-menu-bg 上，与中性控件不是同一层）。 */
  --crwu-menu-hover: #F3F4F5;
  --crwu-menu-bg: rgba(255, 255, 255, 0.98);
  --crwu-primary-bg: #1D1D1F;
  --crwu-primary-bg-hover: #000000;
  --crwu-primary-text: #FFFFFF;
  --crwu-tip-bg: rgba(38, 38, 40, 0.96);
  --crwu-tip-text: #FFFFFF;
  --crwu-focus-ring: rgba(0, 0, 0, 0.035);
  --crwu-scrim: rgba(0, 0, 0, 0.32);

  /* 投影：只在这五个语义槽里，组件不自己拼阴影 */
  --crwu-shadow-tab: 0 1px 2px rgba(0, 0, 0, 0.06);
  --crwu-shadow-surface: 0 1px 2px rgba(0, 0, 0, 0.025), 0 8px 28px rgba(0, 0, 0, 0.035);
  --crwu-shadow-menu: 0 10px 30px rgba(0, 0, 0, 0.12);
  --crwu-shadow-tip: 0 6px 20px rgba(0, 0, 0, 0.22);
  --crwu-shadow-dialog: 0 24px 60px rgba(0, 0, 0, 0.18);
}
/* 深色：同一套语义名的另一份取值。品牌红与风险色保持上面那份（它们不随主题变）。 */
body[data-ds-dark-theme] .crwu-audit-root {
  --crwu-app-bg: #111214;
  --crwu-workspace-bg: #141517;
  --crwu-header-bg: #161719;
  --crwu-surface: #1B1C1F;
  --crwu-surface-subtle: #202124;
  --crwu-hover: #222326;
  --crwu-selected: #25262A;
  --crwu-border: rgba(255, 255, 255, 0.06);
  --crwu-border-strong: rgba(255, 255, 255, 0.10);

  --crwu-text-primary: #F2F2F3;
  --crwu-text-secondary: #A1A1A6;
  --crwu-text-tertiary: #6F7075;
  --crwu-text-body: #C8C9CD;
  --crwu-text-mono: #B8B9BE;
  --crwu-text-hash: #6F7075;
  --crwu-th-text: #8A8B90;
  --crwu-risk-text: #B4B5BA;

  --crwu-tab-track: #1F2023;
  --crwu-tab-text: #9A9BA0;
  --crwu-tab-text-hover: #D8D9DD;
  --crwu-tab-hover: rgba(255, 255, 255, 0.06);
  --crwu-input-bg: #202124;
  /* 次级控件同一套中性底：必须比 --crwu-hover（行悬停 #222326）亮一档，
     否则悬停到那一行时「小鲸鱼 / •••」的底和行底糊成一片（用户报的"颜色不一致"里的一条）。 */
  --crwu-control: #2E2F34;
  --crwu-control-hover: #3A3B41;
  --crwu-control-active: #45464C;
  --crwu-control-text: #A1A1A6;
  --crwu-menu-hover: #2F3034;
  --crwu-menu-bg: rgba(27, 28, 31, 0.98);
  --crwu-primary-bg: #F2F2F3;
  --crwu-primary-bg-hover: #FFFFFF;
  --crwu-primary-text: #17181A;
  --crwu-tip-bg: rgba(62, 62, 66, 0.96);
  --crwu-tip-text: #FFFFFF;
  --crwu-focus-ring: rgba(255, 255, 255, 0.06);
  /* 遮罩轻到能看见"抽屉是从哪一行打开的"（用户口径：.30–.36 + blur ≤3px）。 */
  --crwu-scrim: rgba(0, 0, 0, 0.34);
  /* 深色下"通过"要亮一档才看得见（低饱和绿，不是状态灯）。 */
  --crwu-risk-pass: #57B98A;
  --crwu-sum-bg: rgba(255, 255, 255, 0.035);
  --crwu-sum-border: rgba(255, 255, 255, 0.055);
  --crwu-tech-hover: rgba(255, 255, 255, 0.025);

  --crwu-shadow-tab: 0 1px 2px rgba(0, 0, 0, 0.35);
  --crwu-shadow-surface: 0 1px 2px rgba(0, 0, 0, 0.30), 0 8px 28px rgba(0, 0, 0, 0.28);
  --crwu-shadow-menu: 0 10px 30px rgba(0, 0, 0, 0.45);
  --crwu-shadow-tip: 0 6px 20px rgba(0, 0, 0, 0.45);
  --crwu-shadow-dialog: 0 24px 60px rgba(0, 0, 0, 0.50);
}

/* ════════════════════════════════════════════════════════════════════
   20. Workspace Surface：报告审核页
   ────────────────────────────────────────────────────────────────────
   层级只有三层：**App 底（浅灰）→ Workspace Surface（白，14px 圆角 + 一层轻阴影）→ 内容**。
   它是"工作台里的一块纸"，不是 Dashboard 大卡：描边极浅、阴影极轻、半径克制。
   内容区只有一层框，框内靠发丝线与留白分格（不再嵌套 Card / Border / Header）。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-root { background: var(--crwu-app-bg); color: var(--crwu-text-primary); }
.crwu-audit-body { padding: 20px var(--crwu-pad-x); }
.crwu-audit-header {
  height: 54px; padding: 0 var(--crwu-pad-x);
  background: var(--crwu-header-bg);
  border-bottom: 1px solid var(--crwu-border);
  -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
}
.crwu-audit-surface {
  box-sizing: border-box; display: flex; flex-direction: column;
  height: 100%; min-height: 0; overflow: hidden;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-xl);
  background: var(--crwu-surface); box-shadow: var(--crwu-shadow-surface);
}
.crwu-audit-page-head {
  flex: none; display: flex; align-items: center; gap: var(--crwu-space-3);
  min-height: 0; padding: var(--crwu-space-5) var(--crwu-pad-x) 0;
  background: transparent;
}
.crwu-audit-page-title {
  font-size: 24px; font-weight: 600; letter-spacing: -0.02em; line-height: 32px;
  color: var(--crwu-text-primary);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.crwu-audit-page-meta { margin-left: auto; display: flex; align-items: center; gap: var(--crwu-space-2); }
/* 标题 → Tabs 之间只留 18px（不要巨大的空白）。 */
.crwu-audit-pane-head {
  flex: none; display: flex; align-items: center; gap: var(--crwu-space-3);
  padding: 18px var(--crwu-pad-x) 0; border-bottom: none;
}
.crwu-audit-pane-body { flex: 1 1 auto; min-height: 0; display: flex; align-items: stretch; }
.crwu-audit-pane-main {
  position: relative; flex: 1 1 auto; min-width: 0; overflow: auto;
  padding: var(--crwu-space-4) var(--crwu-pad-x) var(--crwu-space-6);
}

/* ── 列表工具条：搜索 + 刷新同属一行（刷新不再挂页面右上角）──────────────── */
.crwu-audit-toolbar { display: flex; align-items: center; gap: var(--crwu-space-2); margin: 0 0 var(--crwu-space-3); }
.crwu-audit-search {
  position: relative; display: inline-flex; align-items: center;
  width: 400px; max-width: 100%; flex: 0 1 auto;
}
.crwu-audit-search .crwu-audit-input { width: 100%; padding-left: 34px; padding-right: 32px; }
.crwu-audit-search-glyph {
  position: absolute; left: 11px; display: inline-flex; pointer-events: none;
  color: var(--crwu-text-tertiary);
}
.crwu-audit-search-clear {
  position: absolute; right: 9px; width: 20px; height: 20px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 999px; background: var(--crwu-control);
  color: var(--crwu-control-text); font-family: inherit; font-size: 13px; line-height: 1;
  cursor: pointer;
  transition: background 120ms var(--crwu-ease), color 120ms var(--crwu-ease);
}
.crwu-audit-search-clear:hover { background: var(--crwu-control-hover); color: var(--crwu-text-primary); }
.crwu-audit-search-action { display: inline-flex; align-items: center; }
/* 输入框：默认只有一层比底更浅的填充，**没有黑色边框**；聚焦才浮起白底 + 一圈极轻的环。 */
.crwu-audit-input {
  box-sizing: border-box; height: 38px; min-width: 0; padding: 0 var(--crwu-space-3);
  border: 1px solid transparent; border-radius: 9px;
  background: var(--crwu-input-bg); color: var(--crwu-text-primary);
  font-family: inherit; font-size: 13px;
  transition: background 120ms var(--crwu-ease), border-color 120ms var(--crwu-ease),
    box-shadow 120ms var(--crwu-ease);
}
.crwu-audit-input::placeholder { color: var(--crwu-text-tertiary); }
.crwu-audit-input:focus-visible {
  outline: none; background: var(--crwu-surface);
  border-color: var(--crwu-border-strong);
  box-shadow: 0 0 0 3px var(--crwu-focus-ring);
}

/* ── 列表：表头 39px / 行 82px / 发丝分隔 / 只在行上 hover ─────────────────── */
.crwu-audit-table-wrap { overflow-x: auto; }
.crwu-audit-tbody-row { transition: background 120ms var(--crwu-ease); }
.crwu-audit-tbody-row-on .crwu-audit-td { background: var(--crwu-selected); }
/* 列宽是"分工"而不是"抢"：报告名列最宽并吸收剩余宽度，窄列一律不换行。 */
.crwu-audit-td-name { min-width: 220px; }
.crwu-audit-td-nowrap { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crwu-audit-td-review { min-width: 108px; }
.crwu-audit-td-action { min-width: 200px; }
.crwu-audit-td-action .crwu-audit-btn { margin: 0; }
/* 人工复核：主状态 13px + 处理节点 12px（两级字重与色阶都不同），间距 4px。
   **不新增任何业务枚举**：显示的还是氚云给的那两个字段，只是排版分开。 */
.crwu-audit-review-main { font-size: 13px; color: var(--crwu-text-body); white-space: nowrap; }

/* 流水号：13px 等宽；复制图标**只在悬停/聚焦时浮出**，不一直占位。 */
.crwu-audit-seq { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.crwu-audit-seq .crwu-audit-mono { font-size: 13px; color: var(--crwu-text-mono); }
.crwu-audit-seq-copy {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: var(--crwu-text-tertiary); cursor: pointer;
  opacity: 0;
  transition: opacity 120ms var(--crwu-ease), background 120ms var(--crwu-ease), color 120ms var(--crwu-ease);
}
.crwu-audit-tbody-row:hover .crwu-audit-seq-copy,
.crwu-audit-seq-copy:focus-visible { opacity: 1; }
.crwu-audit-seq-copy:hover { background: var(--crwu-control-hover); color: var(--crwu-text-primary); }
.crwu-audit-seq-copy-on { opacity: 1; color: var(--crwu-risk-b); }

/* 风险等级：**扫描信息**，不是装饰 —— 6px 圆点 + 等级字母，没有底色、没有描边、不是彩色 Tag。 */
.crwu-audit-risk {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 500; color: var(--crwu-risk-text);
}
.crwu-audit-risk-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--crwu-risk-c); }
.crwu-audit-risk-dot-high { background: var(--crwu-risk-a); }
.crwu-audit-risk-dot-medium { background: var(--crwu-risk-b); }
.crwu-audit-risk-dot-low { background: var(--crwu-risk-c); }
.crwu-audit-risk-dot-ok { background: var(--crwu-risk-c); }

/* ── 操作列：一个主操作 + 小鲸鱼 + 必要时一个 •••，水平排列，永不纵向堆叠 ────── */
.crwu-audit-row-actions { display: flex; align-items: center; gap: var(--crwu-space-2); flex-wrap: nowrap; }
/* 「审核中」不是可点的任务按钮：它只是主位上的一个状态（避免重复触发）。 */
.crwu-audit-progress-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
  border-radius: var(--crwu-radius-sm); border: 1px solid var(--crwu-border);
  background: var(--crwu-surface-subtle); color: var(--crwu-text-secondary);
  font-size: 13px; font-weight: 500;
}
.crwu-audit-progress-chip::before {
  content: ''; width: 6px; height: 6px; border-radius: 999px;
  background: var(--crwu-brand); animation: crwu-audit-pulse 1.8s ease-in-out infinite;
}
@keyframes crwu-audit-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .crwu-audit-progress-chip::before { animation: none; } }
/* 小鲸鱼：与「刷新 / •••」**同一套中性底**（--crwu-control*），不是第二个实心按钮。 */
.crwu-audit-ai-row-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px;
  background: var(--crwu-control); color: var(--crwu-control-text);
  cursor: pointer; vertical-align: middle;
  transition: background 110ms var(--crwu-ease), color 110ms var(--crwu-ease), transform 110ms var(--crwu-ease);
}
.crwu-audit-ai-row-btn:hover { background: var(--crwu-control-hover); color: var(--crwu-text-primary); transform: translateY(-1px); }
.crwu-audit-ai-row-btn:active { background: var(--crwu-control-active); transform: scale(0.94); }
.crwu-audit-ai-row-btn:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-ai-row-btn:disabled { opacity: 0.5; cursor: default; }
.crwu-audit-ai-row-btn-on { background: var(--crwu-control-hover); color: var(--crwu-text-primary); }
/* •••：与刷新 / 小鲸鱼**同一套中性底**；菜单打开时换到 active 那一格
   （不再有"实心反色"或"完全透明"这两种被用户指出不一致的形态）。 */
.crwu-audit-menu {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px;
  background: var(--crwu-control); color: var(--crwu-control-text);
  font-family: inherit; font-size: 15px; line-height: 1; letter-spacing: 1px; cursor: pointer;
  transition: background 110ms var(--crwu-ease), color 110ms var(--crwu-ease), transform 110ms var(--crwu-ease);
}
.crwu-audit-menu:hover { background: var(--crwu-control-hover); color: var(--crwu-text-primary); }
.crwu-audit-menu:active { background: var(--crwu-control-active); transform: scale(0.94); }
.crwu-audit-menu:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-menu-open, .crwu-audit-menu-open:hover { background: var(--crwu-control-active); color: var(--crwu-text-primary); }

/* ── AI 审核列表：交付件按**业务语义**呈现（审核报告 / 审核数据），不暴露 OSS 原始路径 ── */
.crwu-audit-result-files { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.crwu-audit-result-count { margin-right: 2px; font-size: 13px; color: var(--crwu-text-secondary); }
.crwu-audit-file-chip {
  display: inline-flex; align-items: center; height: 22px; padding: 0 9px;
  border: 1px solid var(--crwu-border); border-radius: 6px;
  background: var(--crwu-surface-subtle); color: var(--crwu-text-secondary);
  font-size: 12px; line-height: 1;
}

/* ── 空态：一行主文案 + 一行轻量说明，不画插画、不留表格骨架 ──────────────── */
.crwu-audit-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; min-height: 220px; padding: 48px 16px; text-align: center;
  color: var(--crwu-text-secondary); font-size: 13px;
}
.crwu-audit-empty-hint { color: var(--crwu-text-tertiary); font-size: 12.5px; }

/* ── 分页：‹ 页码 › + 跳至 [n] 页（总数已经在页签上，不再重复「共 N 条」）────── */
.crwu-audit-pager {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  padding: var(--crwu-space-4) 0 var(--crwu-space-1);
  font-size: 12px; color: var(--crwu-text-secondary);
}
.crwu-audit-pager-nav, .crwu-audit-pager-page {
  box-sizing: border-box; min-width: 28px; height: 28px; padding: 0 6px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 8px; background: transparent;
  color: var(--crwu-text-secondary); font-family: inherit; font-size: 12.5px;
  font-variant-numeric: tabular-nums; cursor: pointer;
  transition: background 120ms var(--crwu-ease), color 120ms var(--crwu-ease);
}
.crwu-audit-pager-nav { font-size: 14px; line-height: 1; }
.crwu-audit-pager-nav:hover:not(:disabled), .crwu-audit-pager-page:hover:not(:disabled) {
  background: var(--crwu-hover); color: var(--crwu-text-primary);
}
.crwu-audit-pager-nav:disabled, .crwu-audit-pager-page:disabled { opacity: 0.4; cursor: not-allowed; }
.crwu-audit-pager-page-on {
  background: var(--crwu-selected); color: var(--crwu-text-primary); font-weight: 600;
}
.crwu-audit-pager-gap { padding: 0 2px; color: var(--crwu-text-tertiary); }
.crwu-audit-pager-jump { display: inline-flex; align-items: center; gap: 6px; margin-left: var(--crwu-space-2); }
.crwu-audit-pager-jump-input {
  box-sizing: border-box; width: 60px; height: 28px; padding: 0 var(--crwu-space-2);
  border: 1px solid var(--crwu-border-strong); border-radius: 8px;
  background: var(--crwu-surface-subtle); color: var(--crwu-text-primary);
  font-family: inherit; font-size: 12.5px; text-align: center;
}
.crwu-audit-pager-jump-input:focus-visible {
  outline: none; background: var(--crwu-surface); box-shadow: 0 0 0 3px var(--crwu-focus-ring);
}

/* ── 统一 Floating Layer（DeepSeek Tooltip + 操作列 Dropdown）─────────────────
   两个浮层共用一套视觉与动画；都渲染在**表格之外**、position: fixed + 触发元素 rect 定位
   —— 客户端产物只允许 require react（没有 react-dom），这是 Portal 的等价实现，
   同时解决"被表格横向滚动容器裁掉"与"撑高行"两个问题。 */
.crwu-audit-float {
  position: fixed; z-index: 40; box-sizing: border-box;
  background: var(--crwu-menu-bg); border: 1px solid var(--crwu-border);
  border-radius: 10px; box-shadow: var(--crwu-shadow-menu); color: var(--crwu-text-primary);
  -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
  transition: left 160ms var(--crwu-ease), top 160ms var(--crwu-ease);
}
.crwu-audit-float-menu {
  min-width: 150px; padding: 5px;
  animation: crwu-audit-menu-in 160ms var(--crwu-ease) both;
}
@keyframes crwu-audit-menu-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.crwu-audit-float-tip {
  padding: 7px 10px; border-color: transparent; border-radius: 8px;
  background: var(--crwu-tip-bg); color: var(--crwu-tip-text);
  box-shadow: var(--crwu-shadow-tip);
  font-size: 12px; font-weight: 500; line-height: 16px; white-space: nowrap; pointer-events: none;
  animation: crwu-audit-tip-in 160ms var(--crwu-ease) both;
}
@keyframes crwu-audit-tip-in {
  from { opacity: 0; transform: translateY(4px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
/* 箭头：与浮层同底、只留朝外两条边、贴边 4px（与浮层之间没有断层）。 */
.crwu-audit-float-arrow {
  position: absolute; width: 8px; height: 8px;
  background: var(--crwu-menu-bg); border: 1px solid var(--crwu-border);
}
.crwu-audit-float-tip .crwu-audit-float-arrow {
  left: 50%; bottom: -4px; transform: translateX(-50%) rotate(45deg);
  background: var(--crwu-tip-bg); border: none;
}
.crwu-audit-float-menu[data-flip="top"] .crwu-audit-float-arrow {
  left: 50%; bottom: -4px; transform: translateX(-50%) rotate(45deg); border-top: none; border-left: none;
}
.crwu-audit-float-menu[data-flip="bottom"] .crwu-audit-float-arrow {
  right: 12px; top: -4px; transform: rotate(225deg); border-top: none; border-left: none;
}
.crwu-audit-float-item {
  display: flex; align-items: center; width: 100%; height: 34px; padding: 0 10px;
  border: none; border-radius: 6px; background: transparent;
  color: var(--crwu-text-primary); font-family: inherit; font-size: 13px; text-align: left; cursor: pointer;
  transition: background 110ms var(--crwu-ease);
}
.crwu-audit-float-item:hover { background: var(--crwu-menu-hover); }
.crwu-audit-float-item:active { background: var(--crwu-selected); }
.crwu-audit-float-item:disabled { color: var(--crwu-text-tertiary); cursor: default; }
.crwu-audit-float-item:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: -2px; }

/* 拉取报告资料 / 首次加载报告：等待页**只盖列表数据区**（页头 / 页签 / 工具条保持可见）。 */
.crwu-audit-list-area { position: relative; min-height: 360px; }
.crwu-audit-ai-mask {
  position: absolute; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--crwu-surface) 82%, transparent);
}
.crwu-audit-ai-mask .crwu-audit-loading-pane { min-height: 320px; padding: 24px 12px; }
/* 「已有报告会话」的选择 Dialog：浮层 + 轻遮罩，两个选项是并排的两块可点面。 */
.crwu-audit-ai-dialog-backdrop { position: fixed; inset: 0; z-index: 10; background: var(--crwu-scrim); }
.crwu-audit-ai-dialog {
  position: fixed; z-index: 11; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 420px; max-width: calc(100vw - 48px); box-sizing: border-box;
  padding: var(--crwu-space-5); border-radius: var(--crwu-radius-lg);
  border: 1px solid var(--crwu-border-strong); background: var(--crwu-surface);
  box-shadow: var(--crwu-shadow-dialog);
  animation: crwu-audit-float-in 160ms var(--crwu-ease) both;
}
@keyframes crwu-audit-float-in {
  from { opacity: 0; transform: translate(-50%, -50%) translateY(6px) scale(0.98); }
  to { opacity: 1; transform: translate(-50%, -50%) translateY(0) scale(1); }
}
.crwu-audit-ai-dialog-title { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; color: var(--crwu-text-primary); }
.crwu-audit-ai-dialog-body { margin-top: var(--crwu-space-2); font-size: 13px; line-height: 20px; color: var(--crwu-text-secondary); }
.crwu-audit-ai-dialog-option {
  box-sizing: border-box; width: 100%; margin-top: var(--crwu-space-3); padding: var(--crwu-space-3);
  text-align: left; cursor: pointer; border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md);
  background: var(--crwu-surface-subtle); font-family: inherit;
  transition: background 120ms var(--crwu-ease), border-color 120ms var(--crwu-ease);
}
.crwu-audit-ai-dialog-option:hover { background: var(--crwu-hover); border-color: var(--crwu-border-strong); }
.crwu-audit-ai-dialog-option:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: -2px; }
.crwu-audit-ai-dialog-option-on { border-color: color-mix(in srgb, var(--crwu-brand) 40%, transparent); }
.crwu-audit-ai-dialog-option-title { display: block; font-size: 13px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-audit-ai-dialog-option-hint { display: block; margin-top: 2px; font-size: 12px; color: var(--crwu-text-secondary); }
.crwu-audit-ai-dialog-actions { display: flex; justify-content: flex-end; margin-top: var(--crwu-space-4); }

/* 「报告评估」 Coming Soon 页：无卡片、无边框、无假进度。 */
.crwu-audit-eval {
  display: flex; flex-direction: column; align-items: center; min-height: 100%; box-sizing: border-box;
  padding: 18vh var(--crwu-space-6) 14vh; animation: crwu-audit-eval-in 240ms var(--crwu-ease) both;
}
.crwu-audit-eval-inner { display: flex; flex-direction: column; align-items: center; max-width: 480px; text-align: center; }
@keyframes crwu-audit-eval-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
.crwu-audit-eval-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 52px; height: 52px; border-radius: var(--crwu-radius-xl);
  background: var(--crwu-surface-subtle); border: 1px solid var(--crwu-border); color: var(--crwu-text-secondary);
  animation: crwu-audit-eval-breathe 3.6s var(--crwu-ease) infinite;
}
@keyframes crwu-audit-eval-breathe { 0%, 100% { opacity: 0.82; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }
.crwu-audit-eval-title { margin: var(--crwu-space-5) 0 0; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; line-height: 32px; color: var(--crwu-text-primary); }
.crwu-audit-eval-subtitle { margin-top: 10px; font-size: 14px; line-height: 20px; color: var(--crwu-text-secondary); }
.crwu-audit-eval-desc { margin: var(--crwu-space-3) 0 0; max-width: 420px; font-size: 13px; line-height: 20px; color: var(--crwu-text-secondary); }
.crwu-audit-eval-status { display: inline-flex; align-items: center; gap: 6px; margin-top: var(--crwu-space-5); font-size: 13px; line-height: 18px; color: var(--crwu-text-secondary); }
.crwu-audit-eval-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--crwu-brand); }
.crwu-audit-eval-next { margin-top: 28px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.crwu-audit-eval-next-lead { font-size: 12px; line-height: 18px; color: var(--crwu-text-tertiary); }
.crwu-audit-eval-link {
  display: inline-flex; align-items: center; gap: 6px; border: none; background: transparent; padding: 0; cursor: pointer;
  color: var(--crwu-text-secondary); font-family: inherit; font-size: 14px; font-weight: 500; line-height: 20px;
  transition: color 120ms var(--crwu-ease);
}
.crwu-audit-eval-link:hover { color: var(--crwu-text-primary); }
.crwu-audit-eval-link:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 4px; border-radius: 4px; }
.crwu-audit-eval-arrow { transition: transform 120ms var(--crwu-ease); }
.crwu-audit-eval-link:hover .crwu-audit-eval-arrow { transform: translateX(2px); }
@media (prefers-reduced-motion: reduce) {
  .crwu-audit-eval, .crwu-audit-eval-icon { animation: none; }
  .crwu-audit-eval-arrow { transition: none; }
}

/* ── 滚动条美化（报告审核正文的横向 + 纵向）────────────────────────────────
   走 DSH 自带的滚动条 token（--dsh-scrollbar-thumb 由侧栏那种容器注入，
   取不到时退回 --dsw-alias-scrollbar-bg-l2），所以一样跟着主题走、深浅都成立。 */
.crwu-audit-pane-main,
.crwu-audit-table-wrap,
.crwu-audit-body {
  scrollbar-width: thin;
  scrollbar-color: var(--dsh-scrollbar-thumb, var(--dsw-alias-scrollbar-bg-l2)) transparent;
}
.crwu-audit-pane-main::-webkit-scrollbar,
.crwu-audit-table-wrap::-webkit-scrollbar,
.crwu-audit-body::-webkit-scrollbar { width: 10px; height: 10px; }
.crwu-audit-pane-main::-webkit-scrollbar-track,
.crwu-audit-table-wrap::-webkit-scrollbar-track,
.crwu-audit-body::-webkit-scrollbar-track { background: transparent; }
.crwu-audit-pane-main::-webkit-scrollbar-thumb,
.crwu-audit-table-wrap::-webkit-scrollbar-thumb,
.crwu-audit-body::-webkit-scrollbar-thumb {
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: content-box;
  background-color: var(--dsh-scrollbar-thumb, var(--dsw-alias-scrollbar-bg-l2));
}
.crwu-audit-pane-main::-webkit-scrollbar-thumb:hover,
.crwu-audit-table-wrap::-webkit-scrollbar-thumb:hover,
.crwu-audit-body::-webkit-scrollbar-thumb:hover {
  background-color: var(--dsh-scrollbar-thumb-hover, var(--dsw-alias-scrollbar-hover-l2));
}
.crwu-audit-pane-main::-webkit-scrollbar-corner,
.crwu-audit-table-wrap::-webkit-scrollbar-corner { background: transparent; }

/* ── 迁移：把环境信息 / 报告评估页残留的 --dsw-* 面收进工作台色板 ─────────────
   这一段只做"别名映射"：把别人写死 dsw 语义色的地方落到 --crwu-*，
   **不重声明 .crwu-audit-btn 这类基础样式**（那会压过 §18 的双类变体）。 */
.crwu-audit-card, .crwu-audit-section, .crwu-audit-layer, .crwu-audit-hero,
/* 注意：这里**不含** .crwu-audit-side-drawer / .crwu-audit-drawer —— 抽屉的面由 §17 定义
   （--crwu-surface）。早先这条把它们一起改成了 surface-subtle，于是抽屉比面板底色浅一档、
   里面的 .crwu-audit-drawer 又叠一层，出现"两层纸"的观感。 */
.crwu-audit-notice, .crwu-audit-blocker {
  background: var(--crwu-surface-subtle); border-color: var(--crwu-border);
}
.crwu-audit-layer-head-extra, .crwu-audit-details-head { background: transparent; border-color: var(--crwu-border); }
.crwu-audit-layer-head:hover, .crwu-audit-details-head:hover { background: var(--crwu-hover); }
.crwu-audit-eval-icon { background: var(--crwu-surface-subtle); border-color: var(--crwu-border); }
.crwu-audit-metric { background: var(--crwu-surface-subtle); }
.crwu-audit-badge { background: var(--crwu-surface-subtle); border-color: var(--crwu-border); color: var(--crwu-text-secondary); }
.crwu-audit-chip { background: var(--crwu-surface-subtle); border-color: var(--crwu-border); }
.crwu-audit-muted { color: var(--crwu-text-secondary); }
.crwu-audit-mono { font-family: var(--crwu-font-mono); font-size: 12.5px; }
.crwu-audit-placeholder-tag { background: var(--crwu-surface-subtle); border-color: var(--crwu-border); color: var(--crwu-text-secondary); }
.crwu-audit-loading, .crwu-audit-loading-inline { color: var(--crwu-text-secondary); }
`
