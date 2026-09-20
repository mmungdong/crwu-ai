/**
 * 工作台的稳定类名与样式文本。
 *
 * 为什么样式随 `lib/client.js` 一起交付，而不是独立 CSS：包形态还没接入 DSH 官方的
 * CSS Module 虚拟加载器，独立 CSS 会漏发。样式由 `styles.ts` 随 Cordis 生命周期插入。
 *
 * **颜色一律用 DSH 真正定义过的主题变量**，取值以 `@deepseek-ai/dsh-client-ui-theme` 的
 * alias 表为准（`--dsw-alias-bg-base` / `-bg-layer-1..3` / `-border-l1..l2` /
 * `-label-primary|secondary|caption` / `-state-success|error|warn-primary` /
 * `-button-primary-fill` / `-interactive-bg-hover`）。
 *
 * 这条不是洁癖：本仓库早先用过 `--dsw-alias-bg-secondary`、`--dsw-alias-border-secondary`、
 * `--dsw-alias-state-warning-primary` 这些**在当前 DSH 里并不存在**的名字 —— 未定义的
 * var() 会让整条声明失效，于是卡片没有边框、底色全透明，页面看起来「很陋」。有一条测试
 * 扫描这里不许出现硬编码色值，但**扫不出不存在的 token**，所以改颜色前先核对 theme 表。
 */
export const WORKBENCH_CLASSES = {
  root: 'crwu-audit-root',
  header: 'crwu-audit-header',
  title: 'crwu-audit-title',
  version: 'crwu-audit-version',
  description: 'crwu-audit-description',
  error: 'crwu-audit-error',
  result: 'crwu-audit-result',

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

  lamp: 'crwu-audit-lamp',
  lampOk: 'crwu-audit-lamp-ok',
  lampBad: 'crwu-audit-lamp-bad',
  lampBusy: 'crwu-audit-lamp-busy',
  lampIdle: 'crwu-audit-lamp-idle',
  lampButton: 'crwu-audit-lamp-button',
  lampButtonOn: 'crwu-audit-lamp-button-on',
  lampText: 'crwu-audit-lamp-text',

  hero: 'crwu-audit-hero',
  heroOk: 'crwu-audit-hero-ok',
  heroBad: 'crwu-audit-hero-bad',
  heroMain: 'crwu-audit-hero-main',
  heroTitle: 'crwu-audit-hero-title',
  heroSub: 'crwu-audit-hero-sub',
  heroActions: 'crwu-audit-hero-actions',

  meter: 'crwu-audit-meter',
  meterFill: 'crwu-audit-meter-fill',
  meterFillBad: 'crwu-audit-meter-fill-bad',

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

export const WORKBENCH_STYLE_ID = 'crwu-audit-package-styles'

export const WORKBENCH_STYLE_TEXT = `
/* 面板自己是滚动容器 —— 这一条是必须的，不是样式偏好：
   DSH 的主内容列（centerCol）是 display:flex + overflow:hidden + height:100vh，它**不滚动**，
   而是把滚动交给面板。少了 height/overflow，面板会被裁在可视区高度上，
   超出的部分既看不见也滚不到（表现为「右侧滚轴不能滚动、内容像是缺了一半」）。 */
.crwu-audit-root {
  box-sizing: border-box;
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  /* 上内边距放在头部自己身上：滚动容器自身的 padding-top 不参与 sticky 约束矩形，
     留着它会在吸顶的头部上方露出一条正在滚动的正文（实测过）。 */
  padding: 0 18px 26px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.65;
}
/* 头部固定：环境页很长，滚下去之后「右上角那颗灯」不能跟着滚走 ——
   否则用户既看不到状态，也没有回到环境自检的入口。 */
.crwu-audit-header {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; gap: 8px;
  /* 负外边距让吸顶条铺满整个滚动口：否则左右各 18px 的 padding 里会露出下面的正文。 */
  margin: 0 -18px 6px;
  padding: 12px 18px 10px;
  background: var(--dsw-alias-bg-base);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-title { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
/* 标题旁的版本徽章：小而安静，但要能一眼读出来（等宽，选中方便复制去报问题）。 */
.crwu-audit-version {
  padding: 1px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-caption);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  white-space: nowrap; user-select: all; cursor: default;
}
.crwu-audit-description { margin-top: 4px; color: var(--dsw-alias-label-secondary); }
.crwu-audit-error { margin-top: 8px; color: var(--dsw-alias-state-error-primary); }
.crwu-audit-result {
  margin-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
}

/* ── 分段控件（报告页的 待审核 / AI审核结果）──────────────────────────── */
.crwu-audit-tabs {
  display: inline-flex; gap: 2px; padding: 2px; margin: 12px 0 10px;
  border-radius: 10px; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-tab {
  border: none; background: transparent; color: var(--dsw-alias-label-secondary);
  border-radius: 8px; padding: 3px 12px; cursor: pointer;
  font-size: 12px; line-height: 20px; font-family: inherit;
}
.crwu-audit-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.crwu-audit-tab-on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; }
.crwu-audit-tab-count { margin-left: 6px; color: var(--dsw-alias-label-caption); }

/* ── 卡片与分区 ─────────────────────────────────────────────────── */
.crwu-audit-card {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); margin-bottom: 12px; overflow: hidden;
}
.crwu-audit-card-title {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 14px; font-weight: 600; font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-card-title-text { min-width: 0; }
.crwu-audit-card-extra { margin-left: auto; font-weight: 400; color: var(--dsw-alias-label-caption); }
.crwu-audit-card-body { padding: 12px 14px; }

.crwu-audit-section {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); margin-bottom: 12px; overflow: hidden;
}
.crwu-audit-section-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px;
  background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-section-title { font-weight: 600; font-size: 12.5px; }
.crwu-audit-section-count { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11.5px; }
.crwu-audit-section-body { padding: 4px 14px 10px; }

/* ── 提示条 ─────────────────────────────────────────────────────── */
.crwu-audit-notice {
  border-radius: 10px; padding: 9px 12px; margin-bottom: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
.crwu-audit-notice-warn {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
}
.crwu-audit-notice-ok {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}

/* ── 排布工具类 ─────────────────────────────────────────────────── */
.crwu-audit-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.crwu-audit-stack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.crwu-audit-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 12px 0; }
.crwu-audit-muted { color: var(--dsw-alias-label-secondary); }
.crwu-audit-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.crwu-audit-link { color: var(--dsw-alias-link); overflow-wrap: anywhere; }
.crwu-audit-grow { flex: 1 1 auto; }

/* ── 表格 ───────────────────────────────────────────────────────── */
/* 列宽用固定布局 + 百分比，不是 auto：
   auto 布局下浏览器把多出来的宽度全给最宽的那一列 —— 实测 1920px 视口时「报告名称」涨到 696px、
   2560px 时涨到 1149px，而「操作」那列几乎没有变化，于是右边一直很挤（用户报的「撑不满/很挤」）。
   fixed 布局让整张表严格等于容器宽度、各列按这里的分工分配。
   min-width 是下限：视口太窄时宁可让面板横向滚动，也不要把某一列压到内容折断。
   （注意：这段注释在模板字符串里，**不能出现反引号**，否则会把样式文本截断。） */
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
  text-align: left; font-weight: 600; padding: 7px 9px; font-size: 11.5px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-caption);
  /* 表头不换行：否则窄列会把「人工复核」竖着拆成三行，列宽也会跟着被压成一团。 */
  white-space: nowrap;
}
.crwu-audit-td {
  padding: 9px 10px; vertical-align: top;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  overflow-wrap: anywhere;
}
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

/* ── 徽章与胶囊 ─────────────────────────────────────────────────── */
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
  border-radius: 999px; padding: 0 8px; font-size: 11px; line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.crwu-audit-chip-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-chip-bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.crwu-audit-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.crwu-audit-chip-muted { color: var(--dsw-alias-label-caption); }

/* ── 状态灯 ─────────────────────────────────────────────────────── */
.crwu-audit-dot {
  width: 10px; height: 10px; border-radius: 50%; flex: none; display: inline-block;
  background: var(--dsw-alias-label-caption);
}
.crwu-audit-dot-ok { background: var(--dsw-alias-state-success-primary); }
.crwu-audit-dot-bad { background: var(--dsw-alias-state-error-primary); }
.crwu-audit-dot-busy { background: var(--dsw-alias-state-warn-primary); }
.crwu-audit-dot-idle { background: var(--dsw-alias-label-caption); }

.crwu-audit-lamp {
  width: 40px; height: 40px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: 2px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-hover);
}
.crwu-audit-lamp-ok { border-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-lamp-bad { border-color: var(--dsw-alias-state-error-primary); }
.crwu-audit-lamp-busy { border-color: var(--dsw-alias-state-warn-primary); }
.crwu-audit-lamp-idle { border-color: var(--dsw-alias-border-l2); }

.crwu-audit-lamp-button {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  padding: 2px 10px 2px 7px; font-size: 11.5px; line-height: 18px; font-family: inherit;
}
.crwu-audit-lamp-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.crwu-audit-lamp-button-on { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.crwu-audit-lamp-text { white-space: nowrap; }

/* ── 自检结论（hero）─────────────────────────────────────────────── */
.crwu-audit-hero {
  display: flex; gap: 14px; align-items: flex-start;
  padding: 14px; margin-bottom: 12px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.crwu-audit-hero-ok { border-color: var(--dsw-alias-state-success-primary); }
.crwu-audit-hero-bad { border-color: var(--dsw-alias-state-error-primary); }
.crwu-audit-hero-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-hero-title { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.crwu-audit-hero-sub { color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.crwu-audit-hero-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }

.crwu-audit-meter {
  height: 6px; border-radius: 999px; overflow: hidden; margin-top: 10px;
  background: var(--dsw-alias-interactive-bg-hover);
}
.crwu-audit-meter-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-state-success-primary); }
.crwu-audit-meter-fill-bad { background: var(--dsw-alias-state-warn-primary); }

.crwu-audit-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 8px; margin-top: 12px; }
.crwu-audit-metric {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2); padding: 7px 10px;
}
.crwu-audit-metric-value {
  font-size: 15px; font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.crwu-audit-metric-label { color: var(--dsw-alias-label-caption); font-size: 11px; }

/* ── 单条检查项 ─────────────────────────────────────────────────── */
.crwu-audit-item {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-item:last-child { border-bottom: none; }
.crwu-audit-item-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.crwu-audit-item-main { flex: 1 1 auto; min-width: 0; }
.crwu-audit-item-name { font-weight: 600; }
.crwu-audit-item-note { color: var(--dsw-alias-label-caption); }
.crwu-audit-item-meta { margin-top: 3px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.crwu-audit-item-fix { margin-top: 3px; color: var(--dsw-alias-state-warn-primary); overflow-wrap: anywhere; }

/* ── 阻塞清单 ───────────────────────────────────────────────────── */
.crwu-audit-blockers { list-style: none; margin: 8px 0 0; padding: 0; }
.crwu-audit-blocker {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-blocker:last-child { border-bottom: none; }
.crwu-audit-blocker-index {
  flex: none; width: 18px; height: 18px; margin-top: 2px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; line-height: 1;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
}

/* ── 加载与门禁 ─────────────────────────────────────────────────── */
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
  padding: 56px 12px; color: var(--dsw-alias-label-secondary);
}
.crwu-audit-loading-inline {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 0 10px; color: var(--dsw-alias-label-secondary);
}

/* 不确定进度条：翻页 / 重新自检 / 刷新列表时，让「正在加载」有一个看得见的落点。
   只压暗正文而不拦按钮的部分不放这里 —— 被 dim 包住的区域连点击一起停掉，防手快连点。 */
.crwu-audit-load-bar {
  position: relative; height: 2px; margin: 0 0 10px; overflow: hidden;
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

/* ── 右侧抽屉（审核信息）────────────────────────────────────────────
   固定定位贴着视口右侧：抽屉属于「页面级」的临时面板，不该被面板自己的滚动容器裁掉。
   z-index 要高过面板内容，遮罩再低一层。 */
.crwu-audit-side-drawer-backdrop {
  position: fixed; inset: 0; z-index: 900;
  background: var(--dsw-alias-bg-mask-1);
}
.crwu-audit-side-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 901;
  box-sizing: border-box; width: min(560px, 92vw);
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border-left: 1px solid var(--dsw-alias-border-l2);
  animation: crwu-audit-drawer-in 0.18s ease-out;
}
@keyframes crwu-audit-drawer-in {
  from { transform: translateX(24px); opacity: 0.4; }
  to { transform: none; opacity: 1; }
}
.crwu-audit-side-drawer-head {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 12px 16px;
  background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.crwu-audit-side-drawer-title { font-weight: 600; margin-right: auto; overflow-wrap: anywhere; }
.crwu-audit-side-drawer-body {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 14px 16px 24px;
}
.crwu-audit-gate {
  border: 1px dashed var(--dsw-alias-state-warn-primary);
  border-radius: 12px; padding: 14px 16px;
}
.crwu-audit-gate-title { font-weight: 600; color: var(--dsw-alias-state-warn-primary); }

/* ── 按钮 / 输入 / 抽屉 / 键值表 ────────────────────────────────── */
.crwu-audit-btn {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  padding: 4px 11px; cursor: pointer; font-size: 12px; line-height: 18px; font-family: inherit;
}
.crwu-audit-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.crwu-audit-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.crwu-audit-btn-primary {
  background: var(--dsw-alias-button-primary-fill);
  border-color: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.crwu-audit-btn-primary:hover:not(:disabled) { opacity: 0.88; background: var(--dsw-alias-button-primary-fill); }
.crwu-audit-btn-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.crwu-audit-btn-small { padding: 2px 8px; font-size: 11px; line-height: 16px; }

.crwu-audit-input {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  padding: 5px 9px; font-size: 12px; font-family: inherit;
}
.crwu-audit-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }

.crwu-audit-drawer {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  padding: 12px 14px; margin-top: 10px; background: var(--dsw-alias-bg-layer-2);
}
.crwu-audit-drawer-head { font-weight: 600; margin-bottom: 8px; }
.crwu-audit-kv { display: grid; grid-template-columns: 150px 1fr; gap: 5px 12px; align-items: baseline; }
.crwu-audit-kv-key { color: var(--dsw-alias-label-caption); }
.crwu-audit-kv-value { overflow-wrap: anywhere; }
`
