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

  /** 未开发的模块（报告评估）的占位页：正文里只有一枚灰色的「开发中」标签。 */
  placeholder: 'crwu-audit-placeholder',
  placeholderTag: 'crwu-audit-placeholder-tag',

  tabs: 'crwu-audit-tabs',
  tab: 'crwu-audit-tab',
  tabOn: 'crwu-audit-tab-on',
  tabCount: 'crwu-audit-tab-count',

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
  trustRow: 'crwu-audit-trust-row',
  authMask: 'crwu-audit-auth-mask',
  authBlocked: 'crwu-audit-auth-blocked',
  authCard: 'crwu-audit-auth-card',
  authTitle: 'crwu-audit-auth-title',
  authLead: 'crwu-audit-auth-lead',
  authSection: 'crwu-audit-auth-section',
  authText: 'crwu-audit-auth-text',
  authActions: 'crwu-audit-auth-actions',
  authGranted: 'crwu-audit-auth-granted',
  layerActions: 'crwu-audit-layer-actions',
  layerFix: 'crwu-audit-layer-fix',
  details: 'crwu-audit-details',
  detailsHead: 'crwu-audit-details-head',
  detailsToggle: 'crwu-audit-details-toggle',
  detailsBody: 'crwu-audit-details-body',

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
  sideDrawerBody: 'crwu-audit-side-drawer-body',

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
.crwu-audit-module-tag {
  flex: none; padding: 0 6px; border-radius: 6px;
  font-size: 10px; line-height: 16px; font-weight: 400; letter-spacing: 0.02em;
  color: var(--dsw-alias-label-caption);
  background: var(--dsw-alias-interactive-bg-hover);
}

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
   4. 分段控件（页内：待审核报告 / AI审核结果）
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-tabs {
  display: inline-flex; gap: 2px; padding: 3px; margin: 0 0 14px;
  border-radius: 11px; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-tab {
  border: none; background: transparent; color: var(--dsw-alias-label-secondary);
  border-radius: 8px; padding: 5px 14px; cursor: pointer;
  font-family: inherit; font-size: 12.5px; line-height: 18px;
  transition: background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease;
}
.crwu-audit-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.crwu-audit-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.crwu-audit-tab-on {
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-weight: 600; box-shadow: var(--dsw-shadow-lv1);
}
.crwu-audit-tab-count { margin-left: 6px; color: var(--dsw-alias-label-caption); }

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
  width: 100%; min-width: 1140px;
  border-collapse: collapse; table-layout: fixed;
}
.crwu-audit-col-name { width: 25%; }
.crwu-audit-col-seq-no { width: 18%; }
.crwu-audit-col-risk { width: 6%; }
.crwu-audit-col-review { width: 12%; }
.crwu-audit-col-modified { width: 14%; }
.crwu-audit-col-action { width: 25%; }
/* 表格自己横向滚动，而不是被卡片裁掉：表有 min-width，视口够窄时宁可滚动也不要把列切掉。 */
.crwu-audit-table-wrap { overflow-x: auto; }
.crwu-audit-th {
  text-align: left; font-weight: 600; padding: 9px 10px; font-size: 11.5px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-caption);
  /* 表头不换行：否则窄列会把「人工复核」竖着拆成三行，列宽也会跟着被压成一团。 */
  white-space: nowrap;
}
.crwu-audit-td {
  padding: 11px 10px; vertical-align: top;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  overflow-wrap: anywhere;
}
/* 行悬停给一点点底：一屏十几行时，眼睛不容易串行（办公场景的刚需）。 */
.crwu-audit-tbody-row:hover .crwu-audit-td { background: var(--dsw-alias-interactive-bg-hover); }
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

/* 单元格内部的三层排版：主行（项目名）、次行（状态/节点）、等宽行（编号/时间）。 */
.crwu-audit-cell-title { font-weight: 600; line-height: 1.45; }
.crwu-audit-cell-sub { margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.crwu-audit-cell-nowrap { white-space: nowrap; }
.crwu-audit-cell-mono {
  margin-top: 3px; color: var(--dsw-alias-label-caption);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
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
   12. 环境自检的四层（工具 / 登录认证 / 上传配置 / 外部数据）
   ────────────────────────────────────────────────────────────────────
   每层一张卡：标题 + x/y 已就绪 + 层级色；**没就绪的层默认展开**，全部就绪的收成一行。
   层级色只用在左边框上（不整块染色）：一页四层时整块染色会喧宾夺主，左边一条足够分层次。
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
.crwu-audit-trust-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.crwu-audit-layer-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
/* 层里嵌的"怎么办"块（例如 ④ 的 AK 表单）：左侧一条竖线 + 去掉内层卡片的重复边框感。 */
.crwu-audit-layer-fix { margin-top: 10px; padding-left: 12px; border-left: 2px solid var(--dsw-alias-border-l2); }
.crwu-audit-layer-fix .crwu-audit-card { margin-bottom: 0; box-shadow: none; }

/* ════════════════════════════════════════════════════════════════════
   13. 排查详情（维护者看）
   ────────────────────────────────────────────────────────────────────
   默认收起：sha256、清单来源、会话 id 这些是维护者信息，普通员工一进来不该看到。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-details { margin-bottom: 14px; }
.crwu-audit-details-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 14px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 12px; text-align: left; cursor: pointer;
  transition: background 0.14s ease;
}
.crwu-audit-details-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.crwu-audit-details-toggle { margin-left: auto; color: var(--dsw-alias-link); font-size: 11.5px; white-space: nowrap; }
.crwu-audit-details-body { padding: 12px 0 0; }
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
/* 品牌标记当加载符号：整体轻微呼吸，四个色块再按顺序依次亮起（见下面 nth-child 的延迟）。 */
.crwu-audit-loading-mark {
  display: inline-flex; margin-bottom: 6px;
  animation: crwu-audit-breathe 2.4s ease-in-out infinite;
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
  0%, 100% { transform: scale(0.97); }
  50% { transform: scale(1.03); }
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
.crwu-audit-auth-mask {
  position: fixed; inset: 0; z-index: 950;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}
.crwu-audit-auth-blocked {
  position: fixed; inset: 0; z-index: 950;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; background: var(--dsw-alias-bg-layer-1);
}
.crwu-audit-auth-card {
  box-sizing: border-box; width: min(560px, 100%); max-height: 100%; overflow: auto;
  display: flex; flex-direction: column; gap: 12px;
  padding: 24px; border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-shadow-lv3);
  animation: crwu-audit-rise 0.18s ease-out;
}
.crwu-audit-auth-title { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; color: var(--dsw-alias-label-primary); }
.crwu-audit-auth-lead { color: var(--dsw-alias-label-secondary); }
.crwu-audit-auth-section { margin-top: 4px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.crwu-audit-auth-text { color: var(--dsw-alias-label-secondary); }
.crwu-audit-auth-actions { display: flex; gap: 8px; margin-top: 10px; }
.crwu-audit-auth-granted { color: var(--dsw-alias-label-caption); }

/* ════════════════════════════════════════════════════════════════════
   17. 右侧抽屉（审核信息）
   ────────────────────────────────────────────────────────────────────
   固定定位贴着视口右侧：抽屉属于「页面级」的临时面板，不该被面板自己的滚动容器裁掉。
   z-index 要高过面板内容，遮罩再低一层。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-side-drawer-backdrop {
  position: fixed; inset: 0; z-index: 900;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}
.crwu-audit-side-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 901;
  box-sizing: border-box; width: min(560px, 92vw);
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border-left: 1px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-shadow-lv3);
  animation: crwu-audit-drawer-in 0.18s ease-out;
}
@keyframes crwu-audit-drawer-in {
  from { transform: translateX(24px); opacity: 0.4; }
  to { transform: none; opacity: 1; }
}
@keyframes crwu-audit-rise {
  from { transform: translateY(8px); opacity: 0.4; }
  to { transform: none; opacity: 1; }
}
.crwu-audit-side-drawer-head {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 14px 18px;
  background: var(--dsw-alias-bg-layer-1);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-side-drawer-title { font-weight: 600; margin-right: auto; overflow-wrap: anywhere; }
.crwu-audit-side-drawer-body {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 16px 18px 26px;
}
.crwu-audit-gate {
  border: 1px dashed var(--dsw-alias-state-warn-primary);
  border-radius: 14px; padding: 16px 18px; margin-bottom: 14px;
}
.crwu-audit-gate-title { font-weight: 600; color: var(--dsw-alias-state-warn-primary); }

/* ════════════════════════════════════════════════════════════════════
   18. 按钮 / 输入 / 抽屉 / 键值表
   ────────────────────────────────────────────────────────────────────
   按钮是这套视觉里唯一「有重量」的元素：默认只有描边，主操作才上实心填充，
   一屏里最多一处实心 —— 这是 Apple 的层级感做法，也是办公场景里防误点的需要。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-btn {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  padding: 5px 13px; cursor: pointer;
  font-family: inherit; font-size: 12px; line-height: 18px;
  transition: background 0.14s ease, border-color 0.14s ease, opacity 0.14s ease;
}
.crwu-audit-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.crwu-audit-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.crwu-audit-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.crwu-audit-btn-primary {
  background: var(--dsw-alias-button-primary-fill);
  border-color: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.crwu-audit-btn-primary:hover:not(:disabled) { opacity: 0.88; background: var(--dsw-alias-button-primary-fill); }
.crwu-audit-btn-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.crwu-audit-btn-small { padding: 3px 10px; font-size: 11.5px; line-height: 16px; }

.crwu-audit-input {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  padding: 6px 10px; font-family: inherit; font-size: 12px; line-height: 18px;
  min-width: 220px;
}
.crwu-audit-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }

.crwu-audit-drawer {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  padding: 14px 16px; margin-top: 12px; background: var(--dsw-alias-bg-layer-2);
}
.crwu-audit-drawer-head { font-weight: 600; margin-bottom: 8px; }
.crwu-audit-kv { display: grid; grid-template-columns: 150px 1fr; gap: 6px 14px; align-items: baseline; }
.crwu-audit-kv-key { color: var(--dsw-alias-label-caption); }
.crwu-audit-kv-value { overflow-wrap: anywhere; }
`
