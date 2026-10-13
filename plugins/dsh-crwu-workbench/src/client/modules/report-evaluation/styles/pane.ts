/**
 * 报告评估（房地产估值，协议 32）的**样式文本**（类名常量在 `model/styles.ts`）。
 *
 * 与其它业务同一套视觉语言：颜色 / 圆角 / 阴影只用 `styles/tokens.ts` 里**已经定义过**的
 * `--crwu-*` 语义 token，这里不新增 CSS 变量、不用 emoji。
 * 样式必须并进那条总样式表 —— DSH 没有独立的 CSS 加载通道，样式随 `lib/client.js` 交付。
 *
 * 作用域由 `styles/bundle.ts` 统一加（`scopeCss`），这里只管规则本身。
 * 动画只碰 opacity / transform，并在 `prefers-reduced-motion: reduce` 下全部关掉。
 */
export const VALUATION_STYLE_TEXT = `
.crwu-valuation { display: flex; flex-direction: column; gap: var(--crwu-space-3, 12px); }
/* 页面抬头由**面板按导航元数据**渲染（.crwu-audit-nav-page-*），这一页只留阶段那一行。 */
.crwu-valuation-hint { margin: 2px 0 0; font-size: 12px; color: var(--crwu-text-secondary); opacity: .8; }
.crwu-valuation-phase { margin: 0; font-size: 13px; font-weight: 500; }
.crwu-valuation-empty { margin: 0; font-size: 13px; color: var(--crwu-text-secondary); opacity: .8; }
.crwu-valuation-error { margin: 0; font-size: 13px; color: var(--crwu-risk-a); }

/* ── 单个工作面（§3）──────────────────────────────────────────────────────
   纵向任务流：资料 → 方法 → 基准日 → 补充要求 → 操作。工作面上限宽 1120px、宽屏居中，
   窄屏自然收缩；**不再**给资料区与设置区强设同一高度（那正是左边一大片空白的来源）。
   一个外层工作面即可，内部分区靠标题、间距与一条轻分隔线。 */
.crwu-valuation-intake {
  display: flex; flex-direction: column;
  gap: var(--crwu-space-5, 20px);
  max-width: 1120px; margin: 0 auto; width: 100%;
  /* 容器查询的宿主：响应式以**面板实际可用宽度**为准，不是浏览器窗口宽度
     （宿主侧栏展开后窗口可能很宽、面板却只有 500px）。 */
  container-type: inline-size;
  container-name: crwu-valuation;
}
/* 分区：没有卡片标题 + 卡片正文那一层套壳，只有标题、间距与一条轻分隔线。 */
.crwu-valuation-block { display: flex; flex-direction: column; gap: 8px; }
.crwu-valuation-block + .crwu-valuation-block {
  border-top: 1px solid var(--crwu-border); padding-top: var(--crwu-space-4, 16px);
}
.crwu-valuation-block-head { display: flex; align-items: center; gap: var(--crwu-space-3, 12px); }
.crwu-valuation-block-title {
  margin: 0; font-size: 14px; font-weight: 600; color: var(--crwu-text-primary);
  display: flex; align-items: baseline;
}
.crwu-valuation-block-optional { font-size: 12px; font-weight: 400; color: var(--crwu-text-tertiary); }
.crwu-valuation-block-head .crwu-valuation-pick { margin-left: auto; }
.crwu-valuation-grow { flex: 1 1 auto; }

/* 空态：简洁，不做插画，也不暗示拖放（宿主没把拖放交过来）。 */
.crwu-valuation-empty {
  border: 1px dashed var(--crwu-border-strong); border-radius: var(--crwu-radius-lg);
  padding: var(--crwu-space-5, 20px); text-align: center;
}
.crwu-valuation-empty-title { margin: 0; font-size: 13px; color: var(--crwu-text-body); }
.crwu-valuation-empty-hint { margin: 4px 0 0; font-size: 12px; color: var(--crwu-text-tertiary); }

/* 文件列表：有界高度，文件很多时**内部滚动**（后面的设置不能被推到很远）。 */
.crwu-valuation-files {
  margin: 0; padding: 0; list-style: none;
  display: flex; flex-direction: column;
  max-height: 264px; overflow-y: auto;
}
.crwu-valuation-file {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 0; border-top: 1px solid var(--crwu-border); font-size: 13px;
}
.crwu-valuation-file:first-child { border-top: none; }
.crwu-valuation-file-off { opacity: .7; }
.crwu-valuation-file-icon { flex: none; padding-top: 2px; color: var(--crwu-text-tertiary); }
.crwu-valuation-file-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.crwu-valuation-file-name {
  color: var(--crwu-text-primary);
  /* 长文件名截断；完整名称在 title 里，详情里也能看到。 */
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.crwu-valuation-file-meta { display: flex; gap: 8px; font-size: 12px; color: var(--crwu-text-tertiary); }
.crwu-valuation-file-dir { overflow-wrap: anywhere; }
.crwu-valuation-file-reason { font-size: 12px; color: var(--crwu-risk-b); }
.crwu-valuation-file-status { flex: none; font-size: 12px; color: var(--crwu-text-secondary); white-space: nowrap; }
.crwu-valuation-file-remove {
  flex: none; width: 24px; height: 24px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: none; border: 0; border-radius: 6px; cursor: pointer; color: inherit; opacity: .6;
}
.crwu-valuation-file-remove:hover { opacity: 1; background: var(--crwu-hover); }
.crwu-valuation-file-remove:disabled { opacity: .3; cursor: default; }
.crwu-valuation-more {
  align-self: flex-start; background: none; border: 0; padding: 0; cursor: pointer;
  color: var(--crwu-brand); font: inherit; font-size: 12px;
}
.crwu-valuation-more:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }

/* 资料数量 + 读取状态：一行小字。 */
.crwu-valuation-count {
  display: flex; align-items: center; gap: 8px; margin: 0;
  font-size: 12px; color: var(--crwu-text-secondary);
}
.crwu-valuation-count-num { font-weight: 500; }
.crwu-valuation-count-state { opacity: .8; }
.crwu-valuation-count-error { color: var(--crwu-risk-a); }
.crwu-valuation-pick { display: inline-flex; gap: 8px; }

/* 方法：**紧凑四项**。默认纵向（窄面板），容器够宽时一行四项。 */
.crwu-valuation-methods { display: flex; flex-direction: column; gap: 6px; }
.crwu-valuation-method {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 7px 12px; cursor: pointer;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md);
  transition: border-color .16s ease, background-color .16s ease;
}
/* 选中：底色 + 品牌色描边 + 文字加重，三样一起给（不只靠红边）。 */
.crwu-valuation-method-on {
  border-color: var(--crwu-brand); background: var(--crwu-selected);
}
.crwu-valuation-method input { margin: 0; accent-color: var(--crwu-brand); }
.crwu-valuation-method-label { font-size: 13px; font-weight: 500; }
.crwu-valuation-method-on .crwu-valuation-method-label { font-weight: 600; color: var(--crwu-text-primary); }

@container crwu-valuation (min-width: 560px) {
  .crwu-valuation-methods { flex-direction: row; flex-wrap: wrap; }
  .crwu-valuation-method { flex: 0 1 auto; }
}

/* 操作区：**面板内**粘性（不是宿主页面的全局固定底栏）。
   它是工作面里最后一个块，position: sticky 只在这个滚动容器里生效。 */
.crwu-valuation-actionbar {
  position: sticky; bottom: 0; z-index: 1;
  display: flex; align-items: center; gap: var(--crwu-space-2, 8px); flex-wrap: wrap;
  padding: 10px 0;
  background: var(--crwu-surface);
  border-top: 1px solid var(--crwu-border);
}
.crwu-valuation-action-count { font-size: 12px; color: var(--crwu-text-secondary); }

/* 提取进度：一句话 + 宿主报的真实阶段，不画假百分比。 */
.crwu-valuation-intake-status {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md);
  background: var(--crwu-surface-subtle); font-size: 13px;
}
.crwu-valuation-intake-status-label { font-weight: 500; }
.crwu-valuation-intake-status-stage { color: var(--crwu-text-secondary); }
.crwu-valuation-spinner {
  flex: none; width: 12px; height: 12px; border-radius: 50%;
  border: 1.6px solid color-mix(in srgb, var(--crwu-brand) 30%, transparent);
  border-top-color: var(--crwu-brand);
  animation: crwu-audit-spin 0.8s linear infinite;
}
.crwu-valuation-intake-error {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  padding: 10px 12px; border: 1px solid var(--crwu-border); border-left: 3px solid var(--crwu-risk-a);
  border-radius: var(--crwu-radius-md); background: var(--crwu-surface-subtle);
}
.crwu-valuation-intake-error strong { font-size: 13px; }
.crwu-valuation-intake-error p { margin: 0; font-size: 12px; color: var(--crwu-text-secondary); }

.crwu-valuation-date, .crwu-valuation-prompt {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; padding: 6px 8px;
  color: inherit; background: transparent;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md);
}
.crwu-valuation-prompt { resize: vertical; }
.crwu-valuation-date:disabled, .crwu-valuation-prompt:disabled { opacity: .6; }
.crwu-valuation-start, .crwu-valuation-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.crwu-valuation-btn {
  /* 显式盒模型：作用域挡得住"插件的规则命中谁"，挡不住宿主把 box-sizing **继承**下来。 */
  box-sizing: border-box;
  display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 13px;
  padding: 6px 12px; cursor: pointer; color: inherit; background: transparent;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md);
  transition: background-color .16s ease, border-color .16s ease, opacity .16s ease;
}
.crwu-valuation-btn:hover { background: var(--crwu-hover); }
.crwu-valuation-btn:disabled { opacity: .45; cursor: default; }
.crwu-valuation-btn-primary { border-color: var(--crwu-brand); color: var(--crwu-brand); }

.crwu-valuation-drawer-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.crwu-valuation-drawer-note { margin: 0 0 10px; font-size: 12px; color: var(--crwu-text-secondary); opacity: .85; }
.crwu-valuation-drawer-section { margin-top: 14px; display: flex; flex-direction: column; gap: 4px; }
.crwu-valuation-drawer-section h4 { margin: 8px 0 2px; font-size: 12px; font-weight: 600; opacity: .8; }
.crwu-valuation-drawer-files, .crwu-valuation-drawer-missing, .crwu-valuation-drawer-gaps,
.crwu-valuation-drawer-providers, .crwu-valuation-providers, .crwu-valuation-artifacts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.crwu-valuation-drawer-files li, .crwu-valuation-providers li, .crwu-valuation-artifacts li { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
.crwu-valuation-drawer-file-name { font-weight: 500; }
.crwu-valuation-drawer-file-meta, .crwu-valuation-drawer-file-note, .crwu-valuation-drawer-provider-detail { font-size: 12px; color: var(--crwu-text-secondary); opacity: .8; }
.crwu-valuation-drawer-fields { display: grid; grid-template-columns: minmax(88px, auto) 1fr; gap: 2px 10px; margin: 0; font-size: 13px; }
.crwu-valuation-drawer-fields dt { opacity: .75; }
.crwu-valuation-drawer-fields dd { margin: 0; overflow-wrap: anywhere; }
.crwu-valuation-drawer-digest { margin: 14px 0 0; font-size: 11px; color: var(--crwu-text-secondary); opacity: .7; overflow-wrap: anywhere; }
/* 要素的来源：跟在值后面的一行小字（粒度是文件，见抽屉里的说明）。 */
.crwu-valuation-drawer-source { display: block; margin-top: 1px; font-size: 11px; color: var(--crwu-text-tertiary); }
.crwu-valuation-drawer-note-inline { color: var(--crwu-text-tertiary); font-size: 12px; }
/* 知识来源：路由 + 来源 + 版本信息（更新时间 / 正文指纹），两行排开。 */
.crwu-valuation-drawer-knowledge { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.crwu-valuation-drawer-knowledge li { display: flex; flex-direction: column; font-size: 12px; }
.crwu-valuation-drawer-knowledge-route { color: var(--crwu-text-primary); }
.crwu-valuation-drawer-knowledge-meta { color: var(--crwu-text-tertiary); font-family: var(--crwu-font-mono); font-size: 11px; overflow-wrap: anywhere; }
/* 资料冲突：逐条列出"哪一份资料说了什么"，并标出当前采用的那一份。 */
.crwu-valuation-drawer-conflicts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.crwu-valuation-drawer-conflicts > li { display: flex; flex-direction: column; gap: 2px; }
.crwu-valuation-drawer-conflicts ul { margin: 0; padding: 0 0 0 14px; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.crwu-valuation-drawer-conflicts ul li { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.crwu-valuation-drawer-conflict-label { font-weight: 600; color: var(--crwu-text-primary); }
.crwu-valuation-drawer-conflict-source { color: var(--crwu-text-tertiary); font-size: 11px; }
.crwu-valuation-drawer-conflict-value { color: var(--crwu-text-body); }
.crwu-valuation-drawer-conflict-current { font-size: 11px; color: var(--crwu-risk-b); }

/* 完整业务提示词：默认收起，展开后等宽、可滚动、可选中复制。 */
.crwu-valuation-drawer-prompt { margin: 0; }
.crwu-valuation-drawer-prompt summary { cursor: pointer; font-size: 12px; color: var(--crwu-text-secondary); }
.crwu-valuation-drawer-prompt summary:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-valuation-drawer-prompt pre {
  margin: 8px 0 0; padding: 10px 12px; max-height: 320px; overflow: auto;
  border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md);
  background: var(--crwu-surface-subtle); color: var(--crwu-text-body);
  font-family: var(--crwu-font-mono); font-size: 11.5px; line-height: 18px;
  white-space: pre-wrap; overflow-wrap: anywhere;
}

.crwu-valuation-progress, .crwu-valuation-result { display: flex; flex-direction: column; gap: var(--crwu-space-3, 12px); }
.crwu-valuation-stage { margin: 2px 0 0; font-size: 13px; }
.crwu-valuation-bar { height: 6px; border-radius: 3px; background: var(--crwu-hover); overflow: hidden; }
.crwu-valuation-bar-fill { height: 100%; background: var(--crwu-brand); transition: width .2s ease; }
.crwu-valuation-summary { display: grid; grid-template-columns: minmax(88px, auto) 1fr; gap: 2px 10px; margin: 0; font-size: 13px; }
.crwu-valuation-summary dt { opacity: .75; }
.crwu-valuation-summary dd { margin: 0; font-variant-numeric: tabular-nums; }
/* 计价单位跟在单价后面，小一号 —— 它是口径说明，不是第二个数字。 */
.crwu-valuation-price-unit { margin-left: 4px; font-size: 11px; color: var(--crwu-text-tertiary); }
.crwu-valuation-case-group { margin-top: 10px; }
.crwu-valuation-case-group h4 { margin: 0 0 4px; font-size: 12px; font-weight: 600; opacity: .8; }
.crwu-valuation-cases { width: 100%; border-collapse: collapse; font-size: 12px; }
.crwu-valuation-cases th, .crwu-valuation-cases td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--crwu-border); vertical-align: top; }
.crwu-valuation-case-title { display: block; font-weight: 500; }
/* 按来源汇总：与规则校验摘要同一档排版（都是"这一屏的账"）。 */
.crwu-valuation-source-summary { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.crwu-valuation-source-summary li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }

/* 规则校验摘要：规则 ID 等宽、计数与阈值次级色。 */
.crwu-valuation-rule-checks { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.crwu-valuation-rule-checks li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.crwu-valuation-rule-id { font-family: var(--crwu-font-mono); font-size: 11px; color: var(--crwu-text-body); }
.crwu-valuation-rule-counts { color: var(--crwu-text-secondary); }
.crwu-valuation-rule-limit { color: var(--crwu-text-tertiary); font-size: 11px; }
.crwu-valuation-case-evidence { font-family: var(--crwu-font-mono); font-size: 11px; overflow-wrap: anywhere; }
/* 公开联系方式：机构 / 联系人 + **原样**号码 + 状态；没有任何联系入口。 */
.crwu-valuation-case-contact { display: flex; flex-direction: column; font-size: 12px; }
.crwu-valuation-case-contact-who { color: var(--crwu-text-primary); }
.crwu-valuation-case-contact-phone { font-family: var(--crwu-font-mono); font-size: 11px; color: var(--crwu-text-body); }
.crwu-valuation-contact-state { font-size: 11px; color: var(--crwu-text-tertiary); }
.crwu-valuation-contacts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.crwu-valuation-contacts li { display: flex; flex-direction: column; font-size: 12px; }
.crwu-valuation-case-no-evidence { color: var(--crwu-risk-b); }
/* 剔除 / 需修正的案例：默认收起（过程留痕，不删）。 */
.crwu-valuation-case-group[data-valuation-dropped-cases] > summary {
  cursor: pointer; font-size: 12px; font-weight: 600; opacity: .85;
}
.crwu-valuation-case-group[data-valuation-dropped-cases] > summary:focus-visible {
  outline: 2px solid var(--crwu-brand); outline-offset: 2px;
}
/* 方法冲突：比结论更显眼（用户指定的方法被换了，必须当场看见）。 */
.crwu-valuation-method-conflict {
  margin: 0 0 10px; padding: 8px 12px;
  border: 1px solid var(--crwu-border); border-left: 3px solid var(--crwu-risk-a);
  border-radius: var(--crwu-radius-md); background: var(--crwu-surface-subtle);
}
.crwu-valuation-method-conflict strong { font-size: 13px; }
.crwu-valuation-method-conflict p { margin: 2px 0 0; font-size: 12px; color: var(--crwu-text-secondary); }
/* 方法判断记录：采用 / 不采用 + 依据。 */
.crwu-valuation-method-screening { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.crwu-valuation-method-screening li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.crwu-valuation-method-name { font-weight: 500; color: var(--crwu-text-primary); }
.crwu-valuation-method-reason { color: var(--crwu-text-secondary); }

/* 部分结果 / 阶段结果：语气比"证据不完整"更明确 —— 这一轮**没跑完**。 */
.crwu-valuation-partial {
  margin: 0 0 10px; padding: 8px 12px;
  border: 1px solid var(--crwu-border); border-left: 3px solid var(--crwu-risk-a);
  border-radius: var(--crwu-radius-md); background: var(--crwu-surface-subtle);
}
.crwu-valuation-partial strong { font-size: 13px; }
.crwu-valuation-partial p { margin: 2px 0 0; font-size: 12px; color: var(--crwu-text-secondary); }

/* 证据不完整的提示：是提示不是错误（结论照样显示，但读者要知道打折扣看）。 */
.crwu-valuation-incomplete {
  margin: 0 0 10px; padding: 8px 12px;
  border: 1px solid var(--crwu-border); border-left: 3px solid var(--crwu-risk-b);
  border-radius: var(--crwu-radius-md); background: var(--crwu-surface-subtle);
}
.crwu-valuation-incomplete strong { font-size: 13px; }
.crwu-valuation-incomplete p { margin: 2px 0 0; font-size: 12px; color: var(--crwu-text-secondary); }

@media (prefers-reduced-motion: reduce) {
  .crwu-valuation-method, .crwu-valuation-btn, .crwu-valuation-bar-fill { transition: none; }
  .crwu-valuation-spinner { animation: none; }
}
`
