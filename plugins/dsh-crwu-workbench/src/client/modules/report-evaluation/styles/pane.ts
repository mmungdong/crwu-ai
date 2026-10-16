/**
 * 报告评估（房地产估值，协议 39）的**样式文本**（类名常量在 `model/styles.ts`）。
 *
 * 与其它业务同一套视觉语言：颜色 / 圆角 / 阴影只用 `styles/tokens.ts` 里**已经定义过**的
 * `--crwu-*` / `--dsw-*` 语义 token，这里不新增 CSS 变量、不用 emoji、不写硬编码色值。
 * 样式必须并进那条总样式表 —— DSH 没有独立的 CSS 加载通道，样式随 `lib/client.js` 交付。
 *
 * 作用域由 `styles/bundle.ts` 统一加（`scopeCss`），这里只管规则本身。
 * 动画只碰 opacity / transform / background-color / border-color，**不动画 width / height**，
 * 并在 `prefers-reduced-motion: reduce` 下全部关掉（时长 100–160ms）。
 * 深色**不另写选择器**：token 翻转由 `styles/tokens.ts` 的 `body[data-ds-dark-theme]` 块负责，
 * 这里任何地方都不许出现 `prefers-color-scheme`（那跟的是操作系统，不是 DSH 里的选择）。
 *
 * 响应式以**容器查询**为准（`@container crwu-valuation`）：宿主侧栏展开后窗口可能很宽、
 * 面板却只有 500px，拿整窗宽度推断正文宽度必然出错。
 *
 * ## 一层工作纸 + 轻量分区（2026-10-15 用户口径）
 *
 * 外框由 shell 的工作纸承担（`.crwu-audit-page-paper`，14px 圆角 + 轻边界 + 轻阴影）。
 * `.crwu-valuation` 因此**自己不画框**：业务模块画第二层框就会变成双层描边，
 * 而"卡片里再套卡片"正是这一轮要去掉的重感。分区靠 16–24px 留白与发丝线表达。
 */
export const VALUATION_STYLE_TEXT = `
/* ── 工作纸里的一层工作面（§6.1）────────────────────────────────────────────
   纵向任务流：资料 → 资产类型 / 评估方法（必填）→ 补充条件 → 信息获取辅助 → 操作栏。
   上限宽 1120px、宽屏居中；容器查询的宿主就是这一层。 */
.crwu-valuation {
  display: flex; flex-direction: column; gap: 0;
  max-width: 1120px; margin: 0 auto; width: 100%;
  /* 确定高度：底部操作栏因此是**真正的 footer**（flex:none），不再用 sticky 压住内容。
     父层没有确定高度时它退化成 auto，操作栏就落到正文末尾 —— 那是可接受的降级，不是坏布局。 */
  height: 100%; min-height: 0;
  box-sizing: border-box;
  container-type: inline-size;
  container-name: crwu-valuation;
  /* 2026-10-16 polish: workface content inset is 24px (16px below in the container query).
     Local override, not a tokens.ts change, so other modules stay untouched. */
  --crwu-valuation-inset: 24px;
}
/* Workface content inset: the footer can span full width while content stays aligned with the body.
   container-type does not itself establish the fixed-position containing block that popover-model's
   containmentRootOf recognizes; that comes from transform / filter / backdrop-filter / contain layout. */
.crwu-valuation-intake-body,
.crwu-valuation > .crwu-valuation-handoff,
.crwu-valuation > .crwu-valuation-challenge-notes,
.crwu-valuation > .crwu-valuation-notice,
.crwu-valuation > .crwu-valuation-recent {
  margin-inline: var(--crwu-valuation-inset);
}
/* 窄面板收到 16px：在这条容器查询里改**后代**的变量（容器查询匹配不到容器自己）。 */
@container crwu-valuation (max-width: 559px) {
  .crwu-valuation-intake,
  .crwu-valuation > .crwu-valuation-handoff,
  .crwu-valuation > .crwu-valuation-challenge-notes,
  .crwu-valuation > .crwu-valuation-notice,
  .crwu-valuation > .crwu-valuation-recent {
    --crwu-valuation-inset: 16px;
  }
}
/* 输入工作面的挂载容器：**必须把高度接下去**。
   它是 .crwu-valuation 的 flex item，自己不设 flex:1 的话，里面的"确定高度 flex 列"
   拿不到高度，操作栏又会掉回正文末尾（真实浏览器实测：600px 高时操作栏跑到 y=915）。 */
.crwu-valuation-intake-host {
  flex: 1 1 auto; min-height: 0;
  display: flex; flex-direction: column;
}
/* 交接结果屏不参与"确定高度"这一套：它只有一小段内容，撑不满也不该被拉伸。 */
.crwu-valuation > .crwu-valuation-handoff,
.crwu-valuation > .crwu-valuation-challenge-notes,
.crwu-valuation > .crwu-valuation-notice,
.crwu-valuation > .crwu-valuation-recent { flex: none; }
/* 用 hidden 隐藏的元素要自己兜一条 display:none —— hidden 只靠 UA 样式，
   任何作者样式的 display 都会把它盖掉（UI 规范 §6.0 记过这个坑）。 */
.crwu-valuation [hidden] { display: none; }
/* 只给读屏的文字（必填标记的"必填"二字）。 */
.crwu-valuation-sr-only {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.crwu-valuation-error { margin: 0; font-size: 13px; color: var(--crwu-risk-a); overflow-wrap: anywhere; }
.crwu-valuation-notice { margin: 0; font-size: 13px; color: var(--crwu-text-body); }
/* 必要说明用 secondary 起（对白底约 4.6:1）：tertiary 承载不了操作所需的信息。 */
.crwu-valuation-hint {
  margin: 0; font-size: 12px; line-height: 18px;
  color: var(--crwu-valuation-hint-text); overflow-wrap: anywhere;
}
.crwu-valuation-grow { flex: 1 1 auto; }
.crwu-valuation-live {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.crwu-valuation-recent {
  display: flex; align-items: center; gap: 8px; margin: 0; flex-wrap: wrap;
  font-size: 12px; color: var(--crwu-text-secondary);
}

/* ── 单工作面：资料 → 必填两项 → 补充条件 → 辅助 → 操作栏（§8）────────────
   **确定高度的 flex 列**：中间正文 flex:1 / min-height:0 / overflow:auto，底部操作栏 flex:none。
   为什么不用 position:sticky：sticky 的 bottom:0 会把操作栏**拉到自己流入位置之上**，
   于是它盖住当时视口底部的内容（真实浏览器截图里，补充要求的输入框从操作栏下面露出来）。
   flex 列没有任何覆盖，命中的滚动容器也只有一个。 */
.crwu-valuation-intake {
  display: flex; flex-direction: column; width: 100%;
  flex: 1 1 auto; min-height: 0;
}
.crwu-valuation-intake-body {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  /* The shared inset group above also sets margin-inline; zero it here so the body padding is
     the single source of the content inset (it must line up with the footer content). */
  margin: 0;
  overflow-x: hidden;
  box-sizing: border-box; min-width: 0;
  display: flex; flex-direction: column; gap: var(--crwu-space-6, 24px);
  /* 12px top / 24px bottom / 24px inline (16px below 560px via --crwu-valuation-inset). */
  padding: 12px var(--crwu-valuation-inset) 24px;
  /* One thin, themed scrollbar owns vertical overflow.
     Only the ::-webkit-scrollbar rules below: writing the standard scrollbar-width / scrollbar-color
     disables that whole webkit block in Chromium (the local-audit case pins exactly this). */
  scrollbar-gutter: stable;
}
.crwu-valuation-intake-body::-webkit-scrollbar { width: 8px; height: 8px; }
.crwu-valuation-intake-body::-webkit-scrollbar-track { background: transparent; }
.crwu-valuation-intake-body::-webkit-scrollbar-thumb {
  border-radius: 999px; background-color: var(--crwu-field-border);
}
.crwu-valuation-intake-body::-webkit-scrollbar-thumb:hover { background-color: var(--crwu-field-border-hover); }
.crwu-valuation-block { display: flex; flex-direction: column; gap: var(--crwu-space-3, 12px); min-width: 0; }
.crwu-valuation-block + .crwu-valuation-block {
  border-top: 1px solid var(--crwu-border); padding-top: var(--crwu-space-6, 24px);
}
.crwu-valuation-block-head { display: flex; align-items: center; gap: var(--crwu-space-3, 12px); flex-wrap: wrap; }
.crwu-valuation-block-title {
  margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; color: var(--crwu-text-primary);
  display: flex; align-items: baseline;
}
.crwu-valuation-block-head .crwu-valuation-pick { margin-left: auto; }
.crwu-valuation-pick { display: inline-flex; gap: 8px; flex-wrap: wrap; }

/* ── 字段（标签 → 控件 → 说明 / 错误，纵向 8px）────────────────────────── */
.crwu-valuation-field { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.crwu-valuation-field-label {
  display: inline-flex; align-items: baseline; gap: 4px;
  font-size: 13px; font-weight: 600; line-height: 20px; color: var(--crwu-text-primary);
}
.crwu-valuation-field-required { color: var(--crwu-risk-a); font-weight: 400; }
.crwu-valuation-field-optional { font-size: 12px; font-weight: 400; color: var(--crwu-text-secondary); }
.crwu-valuation-field-error {
  margin: 0; font-size: 12px; line-height: 18px; color: var(--crwu-risk-a); overflow-wrap: anywhere;
}
/* 两个必填项：容器 ≥560px 时并排等宽；更窄纵向堆叠（按**面板实际宽度**判断）。 */
.crwu-valuation-required { display: grid; grid-template-columns: 1fr; gap: var(--crwu-space-5, 20px); }
@container crwu-valuation (min-width: 560px) {
  .crwu-valuation-required { grid-template-columns: 1fr 1fr; }
}
/* 补充条件：宽三列 / 中两列 / 窄一列。 */
.crwu-valuation-conditions { display: grid; grid-template-columns: 1fr; gap: var(--crwu-space-5, 20px); }
@container crwu-valuation (min-width: 520px) and (max-width: 779px) {
  .crwu-valuation-conditions { grid-template-columns: 1fr 1fr; }
}
@container crwu-valuation (min-width: 780px) {
  .crwu-valuation-conditions { grid-template-columns: repeat(3, 1fr); }
}

/* ── 空态：简洁，不做插画，也不暗示拖放（宿主没把拖放交过来）────────────── */
.crwu-valuation-empty {
  box-sizing: border-box; min-height: 104px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  border: 1px dashed var(--crwu-border-strong); border-radius: var(--crwu-radius-lg);
  background: var(--crwu-surface-subtle);
  padding: var(--crwu-space-5, 20px); text-align: center;
}
.crwu-valuation-empty-title { margin: 0; font-size: 13px; color: var(--crwu-text-body); }
.crwu-valuation-empty-hint { margin: 0; font-size: 12px; color: var(--crwu-text-secondary); overflow-wrap: anywhere; }

/* ── 入口与实际文件两层（§8.2）：桌面允许最多 320px 内部滚动；窄面板取消这一层 ── */
.crwu-valuation-files {
  margin: 0; padding: 0; list-style: none;
  display: flex; flex-direction: column;
  max-height: 320px; overflow-y: auto;
}
.crwu-valuation-entry { display: flex; flex-direction: column; border-top: 1px solid var(--crwu-border); }
.crwu-valuation-entry:first-child { border-top: none; }
.crwu-valuation-entry-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  min-height: 44px; padding: 2px 0; font-size: 14px;
}
/* 文件夹标题区就是展开开关：至少 44px 高的一整块可点。 */
.crwu-valuation-entry-toggle {
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; min-width: 0;
  padding: 0; border: 0; background: none; color: inherit;
  font: inherit; font-size: 14px; text-align: left; cursor: pointer;
  transition: color 120ms var(--crwu-ease);
}
.crwu-valuation-entry-toggle:hover { color: var(--crwu-interactive); }
.crwu-valuation-entry-toggle:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; border-radius: 6px; }
.crwu-valuation-entry-static { cursor: default; }
.crwu-valuation-entry-icon { display: inline-flex; color: var(--crwu-text-secondary); }
.crwu-valuation-entry-name {
  min-width: 0; max-width: 46ch; font-weight: 500; color: var(--crwu-text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.crwu-valuation-entry-meta { font-size: 12px; color: var(--crwu-text-secondary); }
.crwu-valuation-entry-status { font-size: 12px; color: var(--crwu-text-secondary); white-space: nowrap; }
.crwu-valuation-entry-reason { margin: 0 0 6px; font-size: 12px; color: var(--crwu-risk-b); overflow-wrap: anywhere; }
/* 移除入口是**独立**按钮（不触发展开），命中区 44×44。 */
.crwu-valuation-entry-remove {
  margin-left: auto; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 32px; padding: 0 10px; box-sizing: border-box; position: relative;
  font: inherit; font-size: 12px; cursor: pointer;
}
/* 命中区靠**纵向**外扩（横向外扩会让窄面板出现横向溢出）。 */
.crwu-valuation-entry-remove::after {
  content: ''; position: absolute; top: -6px; bottom: -6px; left: 0; right: 0;
}
.crwu-valuation-entry-remove:disabled { cursor: default; }

.crwu-valuation-sublist {
  margin: 0 0 6px; padding: 0 0 0 22px; list-style: none;
  display: flex; flex-direction: column;
  border-left: 1px solid var(--crwu-border);
}
.crwu-valuation-subfile {
  display: flex; align-items: flex-start; gap: 8px;
  min-height: 44px; padding: 6px 0; font-size: 14px;
}
.crwu-valuation-subfile-icon { flex: none; padding-top: 3px; color: var(--crwu-text-secondary); }
.crwu-valuation-subfile-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.crwu-valuation-subfile-name {
  color: var(--crwu-text-primary);
  /* 长文件名：两行以内，保留扩展名由 title 与详情承担。 */
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  overflow-wrap: anywhere;
}
.crwu-valuation-subfile-meta {
  display: flex; gap: 8px; flex-wrap: wrap;
  font-size: 12px; color: var(--crwu-text-secondary); font-variant-numeric: tabular-nums;
}
.crwu-valuation-subfile-status { flex: none; font-size: 12px; color: var(--crwu-text-secondary); white-space: nowrap; }
.crwu-valuation-subfile-actions { flex: none; display: inline-flex; align-items: center; gap: 4px; }
/* 已移除的行**不整行降透明度**（原因会更难读）：只把名字降一档并说明状态。 */
.crwu-valuation-subfile[data-valuation-subfile-state="removed"] .crwu-valuation-subfile-name { color: var(--crwu-text-secondary); }
/* 展开箭头：只做视觉，rotate 由 aria-expanded 驱动（不动画高度）。 */
.crwu-valuation-entry-chevron {
  flex: none; font-size: 14px; line-height: 1; color: var(--crwu-text-secondary);
  transition: transform 140ms var(--crwu-ease);
}
.crwu-valuation-entry-toggle[aria-expanded="true"] .crwu-valuation-entry-chevron { transform: rotate(90deg); }
/* 图标按钮：**44×44 的独立按钮槽**，里面才是 28px 的视觉盒。
   为什么不用负向 ::after 外扩：外扩会真的增加滚动容器的 scrollWidth（375px 窄面板实测多出 8px，
   正文因此出现横向滚动），而"点得到"和"不撑破布局"必须同时成立。 */
.crwu-valuation-file-remove {
  position: relative; flex: none; width: 44px; height: 44px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 8px; cursor: pointer;
}
.crwu-valuation-file-remove::after {
  content: ''; position: absolute; width: 28px; height: 28px; border-radius: 6px;
}
.crwu-valuation-file-remove:disabled { cursor: default; }
.crwu-valuation-reinclude {
  flex: none; min-height: 32px; padding: 0 10px; box-sizing: border-box;
  font: inherit; font-size: 12px; cursor: pointer;
}
.crwu-valuation-reinclude:disabled { cursor: default; }
.crwu-valuation-more {
  align-self: flex-start; background: none; border: 0; padding: 6px 0; cursor: pointer;
  color: var(--crwu-interactive); font: inherit; font-size: 12px; font-weight: 500;
  min-height: 32px;
}
.crwu-valuation-more:hover { text-decoration: underline; }
.crwu-valuation-more:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; border-radius: 4px; }

/* 新行入场：只做 opacity + 4px 位移（不动画 height）。React 保留 key，所以只有**新增**的
   文件行会播这一次；超过 8 条时整组一次淡入，不逐行延迟。 */
.crwu-valuation-subfile { animation: crwu-valuation-rise 160ms var(--crwu-ease) both; }
@keyframes crwu-valuation-rise {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

/* 资料数量 + 读取状态：一行小字。份数是**递归去重后的文件数**。 */
.crwu-valuation-count {
  display: flex; align-items: center; gap: 8px; margin: 0; flex-wrap: wrap;
  font-size: 12px; color: var(--crwu-text-secondary);
}
.crwu-valuation-count-num { font-weight: 500; font-variant-numeric: tabular-nums; }
.crwu-valuation-count-state { color: var(--crwu-text-secondary); }
.crwu-valuation-truncated {
  margin: 0; padding: 8px 10px; font-size: 12px;
  border: 1px solid var(--crwu-border); border-left: 3px solid var(--crwu-risk-a);
  border-radius: var(--crwu-radius-md); background: var(--crwu-surface-subtle);
  color: var(--crwu-text-body);
}
.crwu-valuation-skipped { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.crwu-valuation-skipped li { display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.crwu-valuation-skipped-name { color: var(--crwu-text-primary); overflow-wrap: anywhere; }
.crwu-valuation-skipped-reason { color: var(--crwu-text-secondary); overflow-wrap: anywhere; }
/* 撤销：反馈在资料区下方，8 秒；有焦点时不自动移除可操作控件。 */
.crwu-valuation-undobar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md);
  background: var(--crwu-surface-subtle); font-size: 12px; color: var(--crwu-text-body);
  animation: crwu-valuation-fade 120ms var(--crwu-ease) both;
}
@keyframes crwu-valuation-fade { from { opacity: 0; } to { opacity: 1; } }

/* Field / select / date / textarea appearance is owned by the shared ui/styles owners.
   Valuation only keeps the prompt-specific layout that the shared textarea does not set. */
.crwu-valuation-prompt { max-height: 240px; }
.crwu-valuation-prompt-count {
  margin-left: 6px; color: var(--crwu-text-secondary); font-variant-numeric: tabular-nums;
}

/* Capability panel (protocol 39: optional, lives inside the intake workface).
   Light inset panel: surface-subtle + soft border + radius; no shadow, no nested card. */
.crwu-valuation-auth {
  display: flex; flex-direction: column; gap: var(--crwu-space-3, 12px);
  min-width: 0;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid var(--crwu-border);
  border-radius: var(--crwu-radius-md);
  background: var(--crwu-surface-subtle);
}
/* Panel head: info icon + description on the left, always-visible action group on the right. */
.crwu-valuation-auth-head { display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
.crwu-valuation-auth-icon { flex: none; display: inline-flex; padding-top: 2px; color: var(--crwu-text-secondary); }
.crwu-valuation-auth-head-text { flex: 1 1 16ch; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.crwu-valuation-auth-desc { color: var(--crwu-text-secondary); }
.crwu-valuation-auth-head-actions { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-left: auto; }
/* Details entry: compact button + rotating chevron (not a bare floating text link). */
.crwu-valuation-auth-details-toggle {
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 4px;
  min-height: 30px; padding: 0 8px; border-radius: var(--crwu-radius-sm);
  font-size: 12px; color: var(--crwu-interactive); background: none; border: 0; cursor: pointer;
  transition: background-color 120ms var(--crwu-ease);
}
.crwu-valuation-auth-details-toggle:hover { background: var(--crwu-control); }
.crwu-valuation-auth-details-toggle:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-valuation-auth-chevron { transition: transform 140ms var(--crwu-ease); }
.crwu-valuation-auth-details-toggle[aria-expanded="true"] .crwu-valuation-auth-chevron { transform: rotate(180deg); }
.crwu-valuation-auth-status {
  display: flex; align-items: center; gap: 8px; margin: 0;
  font-size: 13px; color: var(--crwu-text-body);
}
/* Summary row: name / short state / action on one line; long reasons live in the details. */
.crwu-valuation-capability-summary { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.crwu-valuation-auth-site {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  min-height: 44px; padding: 6px 0;
  border-top: 1px solid var(--crwu-border); font-size: 13px;
}
.crwu-valuation-auth-site:first-child { border-top: none; }
.crwu-valuation-auth-site-name { font-weight: 500; color: var(--crwu-text-primary); min-width: 0; overflow-wrap: anywhere; }
/* State word is a light tag: color carries no meaning (the text already says it). */
.crwu-valuation-capability-state {
  display: inline-flex; align-items: center; min-height: 22px; padding: 0 8px;
  border: 1px solid var(--crwu-border); border-radius: 6px;
  background: var(--crwu-surface-subtle);
  font-size: 12px; color: var(--crwu-text-body);
}
/* Row actions: right-aligned on desktop; keep the 44px hit height after wrapping on narrow panels. */
.crwu-valuation-auth-site-actions { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
.crwu-valuation-auth-reason { margin: 0; font-size: 13px; color: var(--crwu-text-body); overflow-wrap: anywhere; }
.crwu-valuation-auth-reasons { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.crwu-valuation-auth-reasons li { display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.crwu-valuation-auth-site-reason { flex: 1 1 100%; font-size: 12px; color: var(--crwu-text-secondary); overflow-wrap: anywhere; }
/* Details: long reason / check time / login-job notes (collapsed by default).
   Entry animates opacity + 3px only, never height; collapsing is instant via hidden. */
.crwu-valuation-capability-details { min-width: 0; }
.crwu-valuation-auth-details-inner {
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
  animation: crwu-valuation-auth-in 150ms var(--crwu-ease) both;
}
@keyframes crwu-valuation-auth-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}
/* Passed but challenged: non-blocking, visually lighter than an error. */
.crwu-valuation-challenge-notes { margin: 0; padding: 0 0 0 18px; font-size: 12px; color: var(--crwu-text-secondary); }
.crwu-valuation-challenge-notes li { margin: 2px 0; }
.crwu-valuation-auth-job {
  display: flex; align-items: center; gap: 8px; margin: 0; flex-wrap: wrap;
  font-size: 13px; color: var(--crwu-text-body);
}
.crwu-valuation-auth-job-text { min-width: 0; overflow-wrap: anywhere; }

/* Action bar is the workface's own footer (flex:none; not fixed / sticky, never covers content).
   It reads as one **fixed band** that is truly closed: its own subtle surface, a full-bleed top
   hairline, and it reaches the paper's own left / right / bottom edge. That only works because the
   valuation paper carries no padding (styles/layout.ts) - the band and the body each own their
   inset, so no negative margin and no white line under the band. */
.crwu-valuation-actionbar {
  box-sizing: border-box;
  position: relative;
  flex: none; z-index: 1;
  display: flex; align-items: center; gap: var(--crwu-space-2, 8px); flex-wrap: wrap;
  min-height: 56px;
  margin: 0;
  padding: 12px var(--crwu-valuation-inset) 4px;
  background: var(--crwu-surface-subtle);
  /* Full-bleed edge, not an inset hairline: the band's own color already sets it apart from the
     paper, so the divider runs the band's full width instead of being drawn a second time. */
  border-top: 1px solid var(--crwu-border);
}
/* Action group on the right: the summary takes the remaining left width; narrow panels only
   wrap this group themselves. */
.crwu-valuation-action-actions {
  display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto;
}
/* One line on the left: "what is next" when enabled, "why not" when disabled. Both use the
   explanation / metadata tier (12px secondary) - required explanations must not be tertiary. */
.crwu-valuation-action-line {
  flex: 1 1 12ch; min-width: 0; font-size: 12px; line-height: 18px;
  color: var(--crwu-text-secondary); overflow-wrap: anywhere;
}
/* 兼容旧类名（禁用原因曾经是单独一行）：样式与上面同一档，避免历史引用失效。 */
.crwu-valuation-action-reason {
  flex: 1 1 12ch; font-size: 12px; line-height: 18px;
  color: var(--crwu-text-secondary); overflow-wrap: anywhere;
}

.crwu-valuation-intake-error {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  padding: 10px 12px; border: 1px solid var(--crwu-border); border-left: 3px solid var(--crwu-risk-a);
  border-radius: var(--crwu-radius-md); background: var(--crwu-surface-subtle);
  animation: crwu-valuation-fade 120ms var(--crwu-ease) both;
}
.crwu-valuation-intake-error strong { font-size: 13px; color: var(--crwu-text-primary); }
.crwu-valuation-intake-error p { margin: 0; font-size: 12px; color: var(--crwu-text-body); overflow-wrap: anywhere; }

/* 按钮：中性底 + 44px 命中高度；主按钮走**实心** token（UX-10：以前只有描边，
   "唯一 primary"的层级根本没成立）。 */
.crwu-valuation-btn {
  box-sizing: border-box; position: relative;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-size: 13px; min-height: 36px; padding: 0 12px;
  cursor: pointer; border-radius: var(--crwu-radius-md);
  transition: background-color 120ms var(--crwu-ease), color 120ms var(--crwu-ease),
    border-color 120ms var(--crwu-ease);
}
/* 命中高度靠**纵向**外扩到 ≥44px：横向也外扩会让窄面板的正文多出 8px 横向溢出
   （设计稿 §6.4 要求命中区够大，但正文不许出现横向滚动条）。 */
.crwu-valuation-btn::after { content: ''; position: absolute; top: -4px; bottom: -4px; left: 0; right: 0; }
.crwu-valuation-btn:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: 2px; }
.crwu-valuation-btn:disabled { opacity: 1; cursor: default; }
.crwu-valuation-btn:disabled:hover { cursor: default; }
/* 变体用**双类**选择器（不与基础类同权重打架）。 */
.crwu-valuation-btn.crwu-valuation-btn-primary {
  min-width: 96px; min-height: 36px;
  background: var(--crwu-primary-bg); color: var(--crwu-primary-text); border-color: transparent;
}
.crwu-valuation-btn.crwu-valuation-btn-primary:hover:not(:disabled) {
  background: var(--crwu-primary-bg-hover); color: var(--crwu-primary-text);
}
/* 禁用的主按钮退回**中性底**，而不是把实心主按钮整体降透明度：
   深色下 --crwu-primary-bg 是浅色，乘 .45 之后仍是一块很抢眼的大药丸 ——
   一屏最显眼的元素偏偏是点不动的那颗。 */
.crwu-valuation-btn.crwu-valuation-btn-primary:disabled {
  background: var(--crwu-control); color: var(--crwu-control-text); opacity: 1;
}
.crwu-valuation-btn.crwu-valuation-btn-primary:disabled:hover {
  background: var(--crwu-control); color: var(--crwu-control-text);
}

/* ── 只读确认抽屉（§10）────────────────────────────────────────────────── */
.crwu-valuation-drawer-actions { display: flex; gap: 8px; flex-wrap: wrap; width: 100%; justify-content: flex-end; }
.crwu-valuation-drawer-status {
  display: flex; flex-direction: column; gap: 2px; margin: 0 0 16px;
  padding: 10px 12px; border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md);
  background: var(--crwu-surface-subtle);
  font-size: 13px; color: var(--crwu-text-body);
  animation: crwu-valuation-fade 120ms var(--crwu-ease) both;
}
.crwu-valuation-drawer-status-lock { font-size: 12px; color: var(--crwu-text-secondary); }
/* 分区：小节之间 24px 留白，首节贴顶（正文内边距由抽屉 body 给）。 */
.crwu-valuation-drawer-summary { margin-top: var(--crwu-space-6, 24px); display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.crwu-valuation-drawer-summary:first-child { margin-top: 0; }
.crwu-valuation-drawer-summary h4 {
  margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; color: var(--crwu-text-primary);
  display: flex; align-items: baseline; gap: 6px;
}
.crwu-valuation-drawer-count { font-weight: 400; color: var(--crwu-text-secondary); }
/* 只读键值：两列（键值/键值）—— 四个关键事实在第一屏扫得完；窄屏退化成单列。 */
.crwu-valuation-drawer-kv {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 8px 14px; margin: 0; align-items: baseline;
}
@container crwu-valuation (max-width: 519px) {
  .crwu-valuation-drawer-kv { grid-template-columns: auto minmax(0, 1fr); }
}
.crwu-valuation-drawer-kv dt {
  margin: 0; font-size: 12px; line-height: 20px; color: var(--crwu-text-secondary); white-space: nowrap;
}
.crwu-valuation-drawer-kv dd {
  margin: 0; font-size: 14px; line-height: 20px; color: var(--crwu-text-primary); overflow-wrap: anywhere;
}
/* 补充条件里的整块字段（补充要求不在键值格里）。 */
.crwu-valuation-drawer-blocks { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.crwu-valuation-drawer-block-title { font-size: 12px; line-height: 20px; color: var(--crwu-text-secondary); }
/* 用户原文：保留换行；长内容只在正文自然滚动，不套第二层小滚动框。 */
.crwu-valuation-drawer-prompt {
  margin: 0; font-size: 14px; line-height: 20px; color: var(--crwu-text-primary);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
/* 资料主行：图标 + 文件名（主信息）+ 类型/大小（次信息）+ 展开开关；详情整行展开。 */
.crwu-valuation-drawer-files { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.crwu-valuation-drawer-file-row {
  display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap;
  min-height: 44px; padding: 8px 0;
  border-top: 1px solid var(--crwu-border); font-size: 14px;
}
.crwu-valuation-drawer-file-row:first-child { border-top: none; }
.crwu-valuation-drawer-file-icon { flex: none; padding-top: 3px; color: var(--crwu-text-secondary); }
.crwu-valuation-drawer-file-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.crwu-valuation-drawer-file-name { font-weight: 500; color: var(--crwu-text-primary); overflow-wrap: anywhere; }
.crwu-valuation-drawer-file-meta {
  display: flex; gap: 8px; flex-wrap: wrap; min-width: 0;
  font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary); font-variant-numeric: tabular-nums;
}
.crwu-valuation-drawer-file-dir { overflow-wrap: anywhere; }
.crwu-valuation-drawer-file-toggle { flex: none; margin-left: auto; }
.crwu-valuation-drawer-file-details {
  flex: 1 1 100%; min-width: 0; display: flex; flex-direction: column; gap: 6px;
  padding-left: 22px;
}
/* 原始绝对路径：12px、次级色、**可换行可选中**（核对"我选的是哪一份"靠它）。 */
.crwu-valuation-drawer-file-path {
  font-size: 12px; line-height: 18px; color: var(--crwu-text-secondary);
  overflow-wrap: anywhere; word-break: break-all;
  user-select: text; -webkit-user-select: text;
}
.crwu-valuation-drawer-file-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.crwu-valuation-copy {
  display: inline-flex; align-items: center; min-height: 26px; padding: 0 9px;
  font-family: inherit; font-size: 12px; cursor: pointer;
}
.crwu-valuation-copy:disabled { cursor: default; }
/* 复制反馈就地出现、1.5 秒后恢复，**不改变行宽**（固定最小宽度）。 */
.crwu-valuation-copy-state { min-width: 6ch; font-size: 12px; color: var(--crwu-text-secondary); }
.crwu-valuation-drawer-file-dup { font-size: 12px; color: var(--crwu-text-body); overflow-wrap: anywhere; }
.crwu-valuation-drawer-note { margin: 6px 0 0; font-size: 12px; color: var(--crwu-text-secondary); }

/* ── 交接结果屏（§11）──────────────────────────────────────────────────── */
.crwu-valuation-handoff {
  display: flex; flex-direction: column; gap: 8px;
  padding: var(--crwu-space-4, 16px);
  border: 1px solid var(--crwu-border); border-left: 3px solid var(--crwu-risk-a);
  border-radius: var(--crwu-radius-md); background: var(--crwu-surface-subtle);
  animation: crwu-valuation-fade 120ms var(--crwu-ease) both;
}
.crwu-valuation-handoff-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; color: var(--crwu-text-primary); }
.crwu-valuation-handoff-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--crwu-text-body); overflow-wrap: anywhere; }
.crwu-valuation-handoff-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

/* 键盘可达目标的滚动余量（设计稿 §17.1）：操作栏已经是 footer、不再覆盖正文，
   所以只需要一点呼吸位，不需要给它让出 52px。 */
.crwu-valuation-field, .crwu-valuation-select-trigger, .crwu-valuation-purpose,
.crwu-valuation-value-type, .crwu-valuation-date, .crwu-valuation-prompt,
.crwu-valuation-subfile, .crwu-valuation-file-remove, .crwu-valuation-entry-head, .crwu-valuation-entry-remove,
.crwu-valuation-btn, .crwu-valuation-reinclude, .crwu-valuation-capability-state {
  scroll-margin-block: 12px;
}

/* 加载指示：只有旋转，不动画 width / height。 */
.crwu-valuation-spinner {
  flex: none; width: 12px; height: 12px; border-radius: 50%;
  border: 1.6px solid color-mix(in srgb, var(--crwu-brand) 30%, transparent);
  border-top-color: var(--crwu-brand);
  animation: crwu-valuation-spin 0.8s linear infinite;
}
@keyframes crwu-valuation-spin { to { transform: rotate(360deg); } }

/* ── 窄面板与短高度（§16）──────────────────────────────────────────────── */
@container crwu-valuation (max-width: 559px) {
  /* 窄面板取消资料清单的内部滚动层，改由主正文滚动。 */
  .crwu-valuation-files { max-height: none; overflow-y: visible; }
}
@container crwu-valuation (max-width: 399px) {
  /* 窄面板里移除按钮换到第二行；但**内联轴仍然居中** —— 展开开关自己是一个 44px 高的
     可点区域，改成 flex-start 会把 12px 的类型/大小顶到行首，看起来像"元信息跑到文件名上面"
     （真机 375px 实测）。 */
  .crwu-valuation-entry-head { align-items: center; }
  .crwu-valuation-entry-remove { margin-left: 0; }
  /* Footer: summary left, action group right; never stretch the primary to full width - the
     action group wraps on its own when it does not fit. */
  .crwu-valuation-actionbar { align-items: flex-start; }
  .crwu-valuation-action-actions { margin-left: auto; }
  .crwu-valuation-btn.crwu-valuation-btn-primary { min-height: 44px; }
}
/* 窄面板的点按成本：正文与可编辑控件放大到 16px（设计稿 §6.2）。 */
@container crwu-valuation (max-width: 480px) {
  .crwu-valuation-date, .crwu-valuation-prompt, .crwu-valuation-purpose,
  .crwu-valuation-value-type, .crwu-valuation-select-trigger {
    font-size: 16px; line-height: 24px; min-height: 44px;
  }
  .crwu-valuation-subfile { font-size: 14px; }
  /* 移除按钮已经是 44×44 的按钮槽（窄面板无需再调），这里只放大图标本体。 */
  .crwu-valuation-file-remove::after { width: 32px; height: 32px; }
  .crwu-valuation-reinclude { min-height: 44px; }
  .crwu-valuation-btn { min-height: 44px; }
  .crwu-valuation-select-option { min-height: 48px; }
}

/* 减少动画：结构、状态文字与焦点呈现**同步完成**，不留下空等待。
   ⚠️ 这里的类名是**组件节点自己**的（浮层与抽屉），样式的其它部分由共享样式负责。 */
@media (prefers-reduced-motion: reduce) {
  .crwu-valuation-btn, .crwu-valuation-file-remove,
  .crwu-valuation-entry-toggle, .crwu-valuation-entry-remove, .crwu-valuation-reinclude,
  .crwu-valuation-copy, .crwu-valuation-select-trigger, .crwu-valuation-select-chevron,
  .crwu-valuation-purpose, .crwu-valuation-value-type, .crwu-valuation-date,
  .crwu-valuation-prompt, .crwu-valuation-subfile,
  .crwu-valuation-select-option { transition: none; }
  .crwu-valuation-spinner { animation: none; }
  /* 展开 / 关闭**即时完成**：组件在减少动画时不进入 closing，所以这里也把动画去掉。 */
  .crwu-valuation-select-list, .crwu-valuation-select-list-out { animation: none; }
  .crwu-valuation-undobar, .crwu-valuation-intake-error, .crwu-valuation-handoff,
  .crwu-valuation-drawer-status, .crwu-valuation-subfile { animation: none; }
  .crwu-valuation-entry-chevron, .crwu-valuation-auth-chevron { transition: none; }
  /* Status details expand instantly: no entry offset under reduced motion. */
  .crwu-valuation-auth-details-inner { animation: none; }
}
`
