/**
 * 工作台 Design Token（**唯一允许写字面量色值的块**）。
 *
 * 作用域是 `[data-crwu-scope="workbench"]` —— **不是** `.crwu-audit-root`：
 * 那个类还带着高度、布局与溢出规则，侧栏入口、会话头按钮这些独立挂载点套上它会被拉成整屏。
 * 主题作用域与面板布局是两件事，所以变量挂在作用域属性上，挂载点只需要带那个属性。
 *
 * 明暗两套：浅色写在这里，深色按 DSH 解析出来的 `body[data-ds-dark-theme]` 覆盖。
 * 为什么认这个属性而不是 `prefers-color-scheme`：用户的偏好可以是"跟随系统"也可以是手动选的，
 * 主题插件会把最终结论写到 body 的那个属性上 —— 直接读它，两种来源都对。
 *
 * 变量**不**挪到 `body` / `:root`：那等于让插件去改宿主的全局主题。
 */

export const CRWU_TOKEN_STYLE_TEXT = `
/* ════════════════════════════════════════════════════════════════════
   19. 工作台 Design Token
   ────────────────────────────────────────────────────────────────────
   这是**整份样式表里唯一允许写字面量色值的块**（有一条测试扫描它之外的所有规则，
   发现十六进制 / rgb() / hsl() 就红）。其它任何地方只允许引用这些 --crwu-* 或 DSH 的 --dsw-*。

   明暗两套：浅色写在这里，深色按 DSH 解析出来的 body[data-ds-dark-theme] 覆盖。
   为什么认这个属性而不是 prefers-color-scheme：用户的偏好可以是"跟随系统"也可以是手动选的，
   主题插件会把最终结论写到 body 的那个属性上 —— 直接读它，两种来源都对。
   ──────────────────────────────────────────────────────────────────── */
[data-crwu-scope="workbench"] {
  /* 尺寸与动效（组件里只引用，不写魔法数字） */
  --crwu-space-1: 4px; --crwu-space-2: 8px; --crwu-space-3: 12px; --crwu-space-4: 16px;
  --crwu-space-5: 20px; --crwu-space-6: 24px; --crwu-space-8: 32px;
  --crwu-radius-sm: 8px; --crwu-radius-md: 10px; --crwu-radius-lg: 12px; --crwu-radius-xl: 14px;
  --crwu-ease: cubic-bezier(0.16, 1, 0.3, 1);
  --crwu-font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --crwu-color-scheme: light;
  --crwu-pad-x: 24px;

  /* 面与线 */
  --crwu-app-bg: #F5F5F7;
  --crwu-workspace-bg: #FFFFFF;
  --crwu-header-bg: rgba(255, 255, 255, 0.92);
  --crwu-surface: #FFFFFF;
  --crwu-surface-subtle: #F8F9FB;
  --crwu-hover: #F5F6F7;
  --crwu-selected: #F0F1F3;
  --crwu-border: rgba(0, 0, 0, 0.06);
  --crwu-border-strong: rgba(0, 0, 0, 0.10);

  /* 文字三级 + 三种专用前景 */
  --crwu-text-primary: #171A21;
  --crwu-text-secondary: #686F7D;
  --crwu-text-tertiary: #697384;
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
  --crwu-input-bg: #F4F5F6;
  /* 次级控件（刷新 / 小鲸鱼 / ••• / 流水号复制）共用**同一套中性底**：
     用户口径（2026-09-23）：「操作列的按钮颜色不一致，还有刷新按钮」—— 一个填充、一个全透明、
     一个又是 Ghost，同一行里三种底。现在三处都走这三个格，只有主操作是实心。
     取值必须与 --crwu-hover（行悬停底）**分得开**，否则悬停到那一行时控件的底会被吃掉。 */
  --crwu-control: var(--crwu-interactive-soft);
  --crwu-control-hover: #E1ECFD;
  --crwu-control-active: #CFE0FA;
  --crwu-control-text: var(--crwu-interactive);
  /* 浮层菜单项自己的悬停底（在 --crwu-menu-bg 上，与中性控件不是同一层）。 */
  --crwu-menu-hover: #F3F4F5;
  --crwu-menu-bg: rgba(255, 255, 255, 0.98);
  --crwu-primary-bg: #1668DC;
  --crwu-primary-bg-hover: #0958D9;
  --crwu-primary-text: #FFFFFF;
  /* Interaction accent, input surface and required boundaries for the shared controls. */
  --crwu-interactive: #1668DC;
  --crwu-interactive-soft: #EFF5FF;
  --crwu-interactive-border: #B5CEF3;
  --crwu-field-bg: #FFFFFF;
  --crwu-field-border: #8A919E;
  --crwu-field-border-hover: #6E7480;
  --crwu-field-placeholder: #697384;
  --crwu-popover-bg: #FFFFFF;
  --crwu-popover-border: #E6E8ED;
  --crwu-popover-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
  --crwu-z-popover: 40;
  --crwu-day-hover-bg: #EFF5FF;
  --crwu-day-selected-bg: #1668DC;
  --crwu-day-selected-text: #FFFFFF;
  --crwu-day-today-border: #1668DC;
  /* Contrast-safe small error text and white-on-danger background. */
  --crwu-error-text: #B42318;
  --crwu-danger-bg: #C4320A;
  --crwu-tip-bg: rgba(38, 38, 40, 0.96);
  --crwu-tip-text: #FFFFFF;
  --crwu-focus-ring: rgba(0, 0, 0, 0.035);
  --crwu-scrim: rgba(0, 0, 0, 0.32);

  /* 估值语义槽（协议 37）：两个只在估值模块用的语义名。
     ① 必要输入框的边界：当前 --crwu-border 太浅，单独识别不出输入框（设计稿 §6.3）；
     ② 必要的帮助文案：tertiary 对白底约 2.80:1，承载不了"为什么要这样填"。
     两者都只是**引用已有取值**，不改其他模块的 tertiary / 品牌红 / 全局边框。 */
  --crwu-valuation-field-border: #85858B;
  /* 悬停时"边界略增强"：比静止再深一档，但不到焦点环那种强调。 */
  --crwu-valuation-field-border-hover: #6E6E73;
  --crwu-valuation-hint-text: #6E6E73;
  /* 估值工作面的**内容内缩**：底栏底色通栏、内容按同一个量退回来 ——
     于是"文字/按钮离边框有距离"与"与上方正文左对齐"能同时成立。 */
  --crwu-valuation-inset: 12px;

  /* 投影：只在这五个语义槽里，组件不自己拼阴影 */
  --crwu-shadow-tab: 0 1px 2px rgba(0, 0, 0, 0.06);
  --crwu-shadow-surface: 0 1px 2px rgba(0, 0, 0, 0.025), 0 8px 28px rgba(0, 0, 0, 0.035);
  --crwu-shadow-footer: 0 -8px 24px rgba(0, 0, 0, 0.03);
  --crwu-shadow-menu: 0 10px 30px rgba(0, 0, 0, 0.12);
  --crwu-shadow-tip: 0 6px 20px rgba(0, 0, 0, 0.22);
  --crwu-shadow-dialog: 0 24px 60px rgba(0, 0, 0, 0.18);
  /* Market workface palette (approved prototype baseline). */
  --mv-bg: #F5F5F7; --mv-surface: #FFFFFF; --mv-soft: #F8F9FB; --mv-hover: #F5F6F7;
  --mv-fg: #171A21; --mv-text: #414246; --mv-muted: #686F7D;
  --mv-line: rgba(0, 0, 0, 0.06); --mv-line-strong: rgba(0, 0, 0, 0.10);
  --mv-control: #D5D9E1; --mv-accent: #1668DC; --mv-accent-hover: #0958D9;
  --mv-accent-soft: #EFF5FF; --mv-accent-line: #B5CEF3; --mv-on-accent: #FFFFFF;
  --mv-success: #3F9D6A; --mv-success-soft: #EEF7F2; --mv-success-line: #BFE0CF; --mv-success-text: #2F7A52;
  --mv-warn: #D4A043; --mv-warn-soft: #FBF5E7; --mv-warn-line: #E6D2A6; --mv-warn-text: #866014;
  --mv-danger: #B33228; --mv-danger-soft: #FCF0EF; --mv-danger-line: #E9C6C2; --mv-danger-text: #A5362D;
  --mv-shadow: 0 1px 2px rgba(0, 0, 0, 0.025), 0 8px 28px rgba(0, 0, 0, 0.035);

}
/* 深色：同一套语义名的另一份取值。品牌红与风险色保持上面那份（它们不随主题变）。 */
body[data-ds-dark-theme] [data-crwu-scope="workbench"] {
  --crwu-app-bg: #101216;
  --crwu-workspace-bg: #191C22;
  --crwu-header-bg: #161719;
  --crwu-surface: #191C22;
  --crwu-surface-subtle: #22262F;
  --crwu-hover: #222326;
  --crwu-selected: #25262A;
  --crwu-border: rgba(255, 255, 255, 0.06);
  --crwu-border-strong: rgba(255, 255, 255, 0.10);

  --crwu-text-primary: #F1F3F7;
  --crwu-text-secondary: #ABB3C1;
  --crwu-color-scheme: dark;
  --crwu-text-tertiary: #6F7075;
  --crwu-text-body: #C8C9CD;
  --crwu-text-mono: #B8B9BE;
  --crwu-text-hash: #6F7075;
  --crwu-th-text: #8A8B90;
  --crwu-risk-text: #B4B5BA;

  --crwu-input-bg: #202124;
  /* 次级控件同一套中性底：必须比 --crwu-hover（行悬停 #222326）亮一档，
     否则悬停到那一行时「小鲸鱼 / •••」的底和行底糊成一片（用户报的"颜色不一致"里的一条）。 */
  --crwu-control: var(--crwu-interactive-soft);
  --crwu-control-hover: #2A3F5E;
  --crwu-control-active: #33507A;
  --crwu-control-text: var(--crwu-interactive);
  --crwu-menu-hover: #2F3034;
  --crwu-menu-bg: rgba(27, 28, 31, 0.98);
  --crwu-primary-bg: #286BD6;
  --crwu-primary-bg-hover: #347CE9;
  --crwu-primary-text: #FFFFFF;
  --crwu-interactive: #82B7FF;
  --crwu-interactive-soft: #22334C;
  --crwu-interactive-border: #486C9D;
  --crwu-field-bg: #20242C;
  --crwu-field-border: #667285;
  --crwu-field-border-hover: #7C879A;
  --crwu-field-placeholder: #9CA6B6;
  --crwu-popover-bg: #191C22;
  --crwu-popover-border: #343A46;
  --crwu-popover-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  --crwu-z-popover: 40;
  --crwu-day-hover-bg: #22334C;
  --crwu-day-selected-bg: #286BD6;
  --crwu-day-selected-text: #FFFFFF;
  --crwu-day-today-border: #82B7FF;
  --crwu-error-text: #FFB4AB;
  --crwu-danger-bg: #C93A3A;
  --crwu-tip-bg: rgba(62, 62, 66, 0.96);
  --crwu-tip-text: #FFFFFF;
  /* 估值语义槽的深色取值（同上，只服务估值模块）。 */
  --crwu-valuation-field-border: #6F717A;
  --crwu-valuation-field-border-hover: #8A8C95;
  --crwu-valuation-hint-text: #A1A1A6;
  --crwu-valuation-inset: 12px;
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
  --crwu-shadow-footer: 0 -8px 24px rgba(0, 0, 0, 0.35);
  --crwu-shadow-menu: 0 10px 30px rgba(0, 0, 0, 0.45);
  --crwu-shadow-tip: 0 6px 20px rgba(0, 0, 0, 0.45);
  --crwu-shadow-dialog: 0 24px 60px rgba(0, 0, 0, 0.50);
  --mv-bg: #101216; --mv-surface: #191C22; --mv-soft: #22262F; --mv-hover: #232833;
  --mv-fg: #F1F3F7; --mv-text: #D6DBE4; --mv-muted: #ABB3C1;
  --mv-line: rgba(255, 255, 255, 0.07); --mv-line-strong: rgba(255, 255, 255, 0.13);
  --mv-control: #3B414D; --mv-accent: #286BD6; --mv-accent-hover: #3578E5;
  --mv-accent-soft: #22334C; --mv-accent-line: #486C9D; --mv-on-accent: #FFFFFF;
  --mv-success: #5FB483; --mv-success-soft: #1B2B23; --mv-success-line: #335847; --mv-success-text: #7FC9A5;
  --mv-warn: #D4A043; --mv-warn-soft: #2C2618; --mv-warn-line: #5A4A28; --mv-warn-text: #E5C279;
  --mv-danger: #E06A60; --mv-danger-soft: #2C1D1D; --mv-danger-line: #5C3733; --mv-danger-text: #F0A39B;
  --mv-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 28px rgba(0, 0, 0, 0.22);

}
`
