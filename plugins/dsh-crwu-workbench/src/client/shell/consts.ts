/**
 * 工作台 shell 的**稳定类名**（只此一件事）。
 *
 * ⚠️ 这里**不放样式文本**：样式按所有者拆在 `styles/`、`ui/styles/`、`shell/styles/`、
 * `modules/<模块>/styles/` 里，由 `styles/bundle.ts` 装配成一份、`styles/install.ts`
 * 随 Cordis 生命周期插入。这个文件曾经同时装着设计变量、共享组件样式和五个业务模块的
 * 一千八百行 CSS —— 于是"这一段属于谁"没有任何强制，改一处要先在两千行里找到它。
 *
 * 为什么样式仍随 `lib/client.js` 一起交付、不做独立 CSS：包形态还没接入 DSH 官方的
 * CSS Module 虚拟加载器，独立 CSS 会漏发；交付通道只有一条（`styles/install.ts`）。
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
  /**
   * 版本徽标成为**自助更新入口**后的附加类（侧栏入口与面板头部共用同一枚徽标）。
   *
   * 它只是"这枚徽标可点"，形状仍是 `.crwu-audit-version`；语气由下面三个修饰类表达。
   */
  updateBadge: 'crwu-audit-update-badge',
  /** 有可安装的新版本。 */
  updateBadgeAccent: 'crwu-audit-update-badge-accent',
  /** 正在安装 / 已经更新到新版本（正向进行态）。 */
  updateBadgeOk: 'crwu-audit-update-badge-ok',
  /** 已经装好、等待重启。 */
  updateBadgeWarn: 'crwu-audit-update-badge-warn',

  /** 自助更新面板（`UpdateDialog.tsx`）：固定浮层 + 遮罩，盖在面板之上。 */
  updateDialogBackdrop: 'crwu-audit-update-dialog-backdrop',
  updateDialog: 'crwu-audit-update-dialog',
  updateDialogHead: 'crwu-audit-update-dialog-head',
  updateDialogTitle: 'crwu-audit-update-dialog-title',
  updateDialogBody: 'crwu-audit-update-dialog-body',
  updateDialogNotice: 'crwu-audit-update-dialog-notice',
  updateDialogNoticeHint: 'crwu-audit-update-dialog-notice-hint',
  updateDialogStages: 'crwu-audit-update-dialog-stages',
  updateDialogStage: 'crwu-audit-update-dialog-stage',
  updateDialogStageOn: 'crwu-audit-update-dialog-stage-on',
  updateDialogReason: 'crwu-audit-update-dialog-reason',
  updateDialogError: 'crwu-audit-update-dialog-error',
  updateDialogActions: 'crwu-audit-update-dialog-actions',
  updateDialogDiag: 'crwu-audit-update-dialog-diag',
  updateDialogDiagRow: 'crwu-audit-update-dialog-diag-row',
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

  // ⚠️ 这里**没有** `eval*` 那一组了（2026-10-13）：报告评估的 Coming Soon 占位页已被
  // 真正的房地产估值面板取代，类名常量与样式同批删除，不留死代码。


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
  /** 空态：一行主文案 + 一行轻量说明（不画插画）。 */
  empty: 'crwu-audit-empty',
  emptyHint: 'crwu-audit-empty-hint',
  /** AI 审核列表的交付件列：业务语义（审核报告 / 审核数据），不暴露 OSS 原始路径。 */
  resultFiles: 'crwu-audit-result-files',
  resultCount: 'crwu-audit-result-count',
  resultEmptyTag: 'crwu-audit-result-empty',
  resultInfo: 'crwu-audit-result-info',
  resultLoading: 'crwu-audit-result-loading',
  resultSpinner: 'crwu-audit-result-spinner',
  /** 分页的「首页 / 上一页 / 下一页 / 末页」四枚导航按钮（图标 + 可访问名）。 */
  pagerNav: 'crwu-audit-pager-nav',

  /** 子页面的大圆角框（一个框住全部，框内靠发丝线分格，不再分成好多块）。 */
  surface: 'crwu-audit-surface',
  /** 大框顶部那一行：下划线式页签（+ 各视图自己的工具条仍在正文里）。 */
  paneHead: 'crwu-audit-pane-head',
  /**
   * **两级目录**（2026-10-13）：一级 = 业务大类（估值 / 审核 / 其他业务），
   * 二级 = 该业务下的功能页面（房地产 / 土地 / …；报告审核 / 本地审核）。
   *
   * 一级目录沿用既有报告审核页那种页签形态（`.crwu-audit-tablist` / `.crwu-audit-tab`：
   * 44px 命中高度 + 选中项底部 3px 强调线）—— 需求原话就是"整体交互参考现有报告审核页面"。
   * 二级目录另起一套更轻的形态（浅色胶囊 + 选中底），两级因此一眼分得清层级，
   * 也不会变成两张大卡片。
   */
  navBar: 'crwu-audit-nav',
  /** 二级目录那一条：子项多时**横向滚动**，不换行、也不把所有未来业务一次性铺开。 */
  navChildren: 'crwu-audit-nav-children',
  navChild: 'crwu-audit-nav-child',
  navChildOn: 'crwu-audit-nav-child-on',
  /** `enabled: false` 的二级目录：灰态「开发中」，不可进入。 */
  navChildOff: 'crwu-audit-nav-child-off',
  /** 「开发中」小标签（复用侧栏那枚灰 tag 的文案，形状更小）。 */
  navChildTag: 'crwu-audit-nav-child-tag',
  /** 一级目录下没有可用页面时的正文。 */
  navEmpty: 'crwu-audit-nav-empty',
  /** 页面标题区（标题来自导航元数据，随二级目录变化）。 */
  navPageHead: 'crwu-audit-nav-page-head',
  navPageTitle: 'crwu-audit-nav-page-title',
  navPageLead: 'crwu-audit-nav-page-lead',
  navPageNote: 'crwu-audit-nav-page-note',
  /** 审核那两页（报告审核 / 本地审核）在内容区里共用的那一张纸。 */
  pagePaper: 'crwu-audit-page-paper',
  /** 环境信息不是目录树里的一页：它在内容区里独占一块，不占页签。 */
  envScreen: 'crwu-audit-env-screen',
  /**
   * 目录条下面那一块内容：**这里才是页面自己的滚动容器**（目录条常驻，不跟着滚走）。
   *
   * 它存在的理由有两条，都不能省：
   * 1. 目录条要"固定在页面顶部"——它必须长在滚动容器**外面**；
   * 2. 高度要接下去：报告审核页自己的 `.crwu-audit-surface` 是 `height:100%`，
   *    父层没有确定高度时它会退化成 auto，`.crwu-audit-pane-main` 的 `overflow:auto`
   *    就再也滚不起来（列表长的时候会被外层 `overflow:hidden` 直接裁掉）。
   * 切换页面时这个盒子**不重建**（同一个元素、同样高度），滚动位置与宽度因此稳定。
   */
  tabPanel: 'crwu-audit-tab-panel',
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
  colAudit: 'crwu-audit-col-ai',
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
  /** 基础必检项标题后面的**红色星号**（可选的外部数据源不带它）。 */
  stepRequired: 'crwu-audit-step-required',
  /** 星号含义那行图例（只在步骤导航里出现一次）。 */
  stepLegend: 'crwu-audit-step-legend',
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
  /** 标题下的一行说明（估值确认抽屉用；报告审核那张不传就不渲染）。 */
  sideDrawerDesc: 'crwu-audit-side-drawer-desc',
  /** × 关闭：32×32 图标按钮（透明底 + 悬停一层中性底），替代原来的「关闭」文字按钮。 */
  sideDrawerClose: 'crwu-audit-side-drawer-close',
  /** 关闭动画期间的类（父层延迟 150ms 卸载，见 WorkbenchPanel.closeDrawer）。 */
  sideDrawerOut: 'crwu-audit-side-drawer-out',
  sideDrawerBackdropOut: 'crwu-audit-side-drawer-backdrop-out',
  sideDrawerBody: 'crwu-audit-side-drawer-body',
  /**
   * 抽屉的固定 footer（协议 35）。
   *
   * 它不是每张抽屉都必须有的：只给"底部有主操作"的抽屉（例如估值确认抽屉的
   * 「返回修改 / 开始估值」）。没有 footer 的抽屉（审核信息）渲染结果与以前**逐字相同**。
   */
  sideDrawerFoot: 'crwu-audit-side-drawer-foot',

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
  // ⚠️ 这里**没有** `loginStage` / `loginStageOn` 了（2026-09-30）：氚云内置浏览器扫码登录
  // （访客区 / `<webview>`）整体下掉，容器类名与它的样式一并删除，不留死代码。
} as const

/** 版本 / dev 小标签的语义类：tone → 类名（侧栏入口与面板头部共用同一套）。 */
export const BUILD_TAG_CLASSES = {
  dev: WORKBENCH_CLASSES.versionDev,
  installed: WORKBENCH_CLASSES.versionInstalled,
  unknown: WORKBENCH_CLASSES.versionUnknown,
} as const
