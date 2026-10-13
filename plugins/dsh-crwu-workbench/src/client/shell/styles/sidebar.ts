/**
 * 侧栏入口：分组卡 + 卡身三行子项（`sidebar.footer.action`，Settings 上方）。
 *
 * 选中项浮起来（品牌色低浓度底 + 左侧 3px 强调条 + 加粗），悬停给一层极浅的中性底色；
 * 卡头是纯标题，既不可点、也没有悬停底色。
 */

export const CRWU_SIDEBAR_STYLE_TEXT = `
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
[data-crwu-scope="workbench"].crwu-audit-side-card {
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
[data-crwu-scope="workbench"].crwu-audit-side-card-on { border-color: var(--dsw-alias-border-l2); }
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
[data-crwu-scope="workbench"].crwu-audit-side-entry {
  box-sizing: border-box; width: 100%;
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border: none; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 14px; line-height: 22px; text-align: left;
  cursor: pointer;
  transition: background 0.14s ease;
}
[data-crwu-scope="workbench"].crwu-audit-side-entry:hover { background: var(--dsw-specific-sidebar-nav-item-hover, var(--dsw-alias-interactive-bg-hover)); }
[data-crwu-scope="workbench"].crwu-audit-side-entry:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: -2px; }
[data-crwu-scope="workbench"].crwu-audit-side-entry-on { background: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-active)); font-weight: 500; }
.crwu-audit-side-entry-glyph { display: inline-flex; flex: none; align-items: center; justify-content: center; }
.crwu-audit-side-entry-label {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 折叠轨道：只画图标，居中。 */
[data-crwu-scope="workbench"].crwu-audit-side-entry-rail { justify-content: center; padding: 7px 0; }
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
`
