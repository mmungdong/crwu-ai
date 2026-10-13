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
body[data-ds-dark-theme] [data-crwu-scope="workbench"] {
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
`
