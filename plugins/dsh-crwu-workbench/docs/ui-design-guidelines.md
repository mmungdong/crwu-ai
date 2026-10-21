# 界面与设计规范（dsh-crwu-workbench）

这份文档回答「**为什么长这样、要改样式该动哪里**」。判据（门禁）在 `plugins/dsh-crwu-workbench/AGENTS.md`，
两者冲突时以那份为准。写代码前按需读；改完把新踩的坑补进来。

---

## 1. 视觉语言：办公 + Apple

侧栏“报告评估”使用现有中性小标签显示“开发中”；该状态只标注开发进度，入口与已实现的工作流继续可用。

用户口径（2026-09-22）：「办公风 + Apple 视觉」。落点是三条：

1. **信息密度不降**：资产评估师要一屏看多条记录，所以字号、行高、表格列宽都为"看得多"服务，
   不为留白牺牲内容；
2. **分层靠描边和阴影，不靠大色块**：卡片 = 1px `--dsw-alias-border-l1` + `--dsw-shadow-lv1`；
   状态色只出现在圆点、胶囊、左侧一条细边上；
3. **动效克制**：只过渡 `background` / `color` / `box-shadow` / `transform`，时长 120~160ms；
   **绝不过渡 `width` / `height`**（会重排抖动）。

### 1.1 颜色只用 DSH 真定义过的 token

取值以 `@deepseek-ai/dsh-client-ui-theme` 的 alias 表为准。实际用过且确认存在的一批：

| 用途 | token |
|---|---|
| 底 / 层次 | `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1..3` |
| 描边 | `--dsw-alias-border-l1..l4` |
| 文字 | `--dsw-alias-label-primary`、`-secondary`、`-tertiary`、`-caption` |
| 状态 | `--dsw-alias-state-success-primary`、`-error-primary`、`-warn-primary`（以及 `-tertiary` 家族） |
| 交互 | `--dsw-alias-interactive-bg-hover`、`-active`、`--dsw-alias-button-info-fill`、`--dsw-alias-button-primary-fill` |
| 侧栏专属 | `--dsw-specific-sidebar-fill`、`-nav-item-hover`、`-nav-item-active`、`-nav-item-active-accent` |
| 阴影 | `--dsw-shadow-lv1..3` |
| 实心色块上的字形 | `--dsw-static-neutral-bluish-00`（**static 白**，理由见 §6.3） |

**插件自己的语义 token 只声明在** `src/client/styles/tokens.ts`（`--crwu-app-bg` / `--crwu-surface` /
`--crwu-hover` / `--crwu-text-*` / `--crwu-risk-*` / `--crwu-shadow-*` …）—— 它是整份样式表里
**唯一允许写字面量色值的所有者**。其余任何规则只允许引用 `var(--crwu-*)` 或 `var(--dsw-*)`；
单测会先剔除 token 所有者再扫 `#hex` / `rgb(` / `hsl(`。

当前方向（2026-10-15 落地）：中性白 / 近黑读数面 + **操作蓝**交互；普通操作、选中目录、
输入焦点都用 `--crwu-interactive*`，`--crwu-control` / `--crwu-control-text` 现在只是它的别名
（`--crwu-interactive-soft` / `--crwu-interactive`）。品牌红 `--crwu-brand` 只留给品牌标记与
风险语义，不再用作普通焦点 / 选中描边。共享控件的完整 API 见
[`shared-ui-components.md`](shared-ui-components.md)。

- **深色不是另写一套选择器**：DSH 把解析后的明暗写到 `body[data-ds-dark-theme]`
  （不管是"跟随系统"还是手动选的深色都会落到这个属性上），所以在 `tokens.ts` 里用
  `body[data-ds-dark-theme] [data-crwu-scope="workbench"] { --crwu-…: … }` 覆盖同名 token 即可
  —— 组件与规则一份都不用改，浅深自动成立。**不要用 `prefers-color-scheme`**：那跟的是操作系统，
  不是用户在 Harness 里选的偏好。
- 品牌红 `--crwu-brand` 与风险色 `--crwu-risk-a/b/c` **不随主题翻转**，只声明在浅色那份里。

两条踩过的坑：

- 本仓早先写过 `--dsw-alias-bg-secondary`、`--dsw-alias-border-secondary`、`--dsw-alias-state-warning-primary`
  这些**并不存在**的名字。未定义的 `var()` 会让**整条声明失效**（卡片没边框、底色透明、页面"很陋"），
  而控制台**没有任何报错**；
- 有一条单测扫硬编码色值（`#hex` / `rgb(` / `hsl(`），但它**扫不出不存在的 token** ——
  加颜色前自己去 theme 表核对一遍。

### 1.2 字体与圆角不自己写

- 字体跟随 `--dsw-font-family`（本身就是 `-apple-system, BlinkMacSystemFont, …` 的 Apple 优先栈）；
- 圆角只写 `border-radius`，连续曲率由 DSH 全局的 `corner-shape: superellipse(1.5)` 提供，
  不要手写贝塞尔。

---

## 2. 样式怎么交付、怎么分层、怎么限定作用域（2026-10-13 重构）

包形态是**单文件** `lib/client.js`，没有 CSS 资源加载器：样式文本随产物交付，由 Cordis
生命周期插入一个 `<style id="crwu-audit-package-styles" data-plugin="dsh-crwu-workbench">`。

### 2.1 按所有者拆分，装配在一处

```text
src/client/styles/          tokens.ts · base.ts · scope.ts · scope-css.ts · bundle.ts · install.ts
src/client/ui/styles/       button.ts · card.ts · drawer.ts · dialog.ts
                            field.ts · select.ts · date-picker.ts · popover.ts（共享控件外观）
src/client/shell/styles/    layout.ts · navigation.ts · sidebar.ts
src/client/modules/<模块>/styles/pane.ts
```

- **类名常量**留在模块的 `consts.ts` / `model/`（组件与测试共用）；
- **样式文本**跟着所有者走；`styles/bundle.ts` 是唯一的装配点（顺序 = 层叠顺序）；
- 业务模块只保留布局 / 命中区 / 排版，外观（底色、边界、焦点、悬停、禁用）由
  `ui/styles/*` 的共享所有者负责；旧控件类名只作锚点，不再重新画一层外观。
- `shell/consts.ts` **只放类名**，不再承载设计变量与各业务样式。

### 2.2 作用域：`data-crwu-scope="workbench"`

类名前缀只做到"命名不撞车"，做不到"规则不越界" —— 一条 `.crwu-audit-btn { … }` 会命中任何
页面里同名的元素。所以每个**独立挂载点**的根节点都带 `data-crwu-scope="workbench"`：
主面板、侧栏入口（展开态与轨道态）、会话头按钮、Cordis 运行卡片、抽屉等浮层。

- 主题变量定义在 `[data-crwu-scope="workbench"]` 上（深色 `body[data-ds-dark-theme] [data-crwu-scope="workbench"]`），
  **不是** `.crwu-audit-root` —— 那个类还带着高度与溢出规则，小组件套上会被拉成整屏；
- 规则由 `styles/bundle.ts` 的 `scopeCss()` 统一加前缀 `:where([data-crwu-scope="workbench"]) `：
  `:where()` 权重为 0，所以**加作用域不改变原有层叠关系**，也就不需要 `!important`；
- **作用域节点自身的规则**（`.crwu-audit-root`、token 块）必须写成
  `[data-crwu-scope="workbench"].crwu-audit-root`：`:where([…]) .crwu-audit-root` 要求
  "祖先里有作用域节点"，而它自己就是那个节点，永远不命中；
- **不给** `body` / `:root` 加变量，也**不写**裸的 `body/html/button/input/*` 重置规则。

### 2.3 安装：单一入口 + 按 document 引用计数 + 内容始终刷新

- 只有一处 `ctx.effect(installWorkbenchStyles, …)`（`src/client/styles/install.ts`）；
- 已有同 id 节点时**复用并重写 `textContent`**：残留的旧节点、开发重载后的新内容都能生效
  （以前"查到就直接返回"，改了 CSS 看不到变化）；
- 多个活跃实例按 document 记账，**计数归零才移除节点**；清理函数幂等。

### 2.4 模板字符串的坑

样式文本仍是模板字符串：**注释里也不能出现反引号**。一个反引号会把整段样式截断，
而且不一定报错。这条已经踩过两次（最近一次就在估值模块的样式文件里）。

---

## 3. 类名与选择器纪律

1. 类名前缀按归属：共享控件 `crwu-ui-*`、估值业务 `crwu-valuation-*`、既有报告审核
   `crwu-audit-*` 都接受；新代码不要再出现历史前缀 `crwu-wb-` / `crwu-workbench-`。
   样式是插件自己往 `document.head` 注入的**全局** `<style>`，前缀 + 作用域是两道隔离；
2. 类名常量与它所属的组件 / 模块放在一起（shell 的在 `shell/consts.ts`，业务模块的在各自目录）；
3. 有一条单测断言**每个类名常量都有一条 `.<类名>` 规则**，漏写样式会红；
3.1. **业务模块不得重定义共享控件的裸规则**（`.crwu-audit-btn { … }`）：要调排版就用
   带祖先组合器的变体（`.crwu-audit-td-action .crwu-audit-btn { … }`），作用域留在自己容器里；
3.2. 一级 / 二级目录的样式属于 **shell**，业务模块不许再定义；
4. `install/browser-check.mjs` 里有硬编码选择器（`.crwu-audit-module`、`td.crwu-audit-td-nowrap` 等），
   **改类名必须同步它**；
5. **共享按钮变体只用公共类**：`.crwu-ui-btn-primary` / `-secondary` / `-soft` / `-text` 由
   `ui/styles/button.ts` 唯一拥有，业务模块不要再画一遍底色 / 悬停 / 焦点。历史迁移层
   （`.crwu-audit-btn`、`.crwu-valuation-btn` 私有灰底与品牌红焦点覆盖）已删除，这些旧类名
   只作锚点。确实要在业务容器里调整布局时才用带祖先的组合器。禁用态是 token 感知的 subdued
   中性底（`--crwu-control`），而不是把实心主按钮整体降透明度。这条由
   `tests/unit/client-package.test.mjs` 的「按钮变体一律用双类选择器」与样式所有权用例盯着。

---

## 4. 布局硬规则（每条对应一次真实故障）

1. **滚动归正文区，不归 root**：
   `.crwu-audit-root { height:100%; min-height:0; overflow:hidden }` +
   `.crwu-audit-body { overflow:auto; min-height:0 }`。DSH 的主内容列是
   `display:flex; overflow:hidden`，它不滚动、把滚动交给面板；少这两条长页面会被裁一半。
   滚动**不能放 root**：头部（标题 + 版本标签 + 问候）必须常驻，root 一滚它就跟着滚出视口。
2. **表格固定布局 + `colgroup` 百分比列宽**（`.crwu-audit-table` + `.crwu-audit-col-*`）：
   `table-layout: auto` 会把多出来的宽度全给最宽那列（实测 1920px 时报告名涨到 696px，
   操作列几乎不动，右侧一直很挤）；表格另设 `min-width: 1040px`（16% 的操作列要放得下一个主操作
   + 32px 小鲸鱼 + •••），外面必须套 `.crwu-audit-table-wrap { overflow-x:auto }`。
   报告容器宽度 ≤1180px 时表格取消 `min-width` 并允许操作区换行；≤760px 时整表切成
   **每条报告一张卡**（`data-label` 显示列名，操作区独占一行）—— 375/600/960 面板宽度都不再出现
   横向滚动，也不隐藏任何列或裁掉操作。
3. **窄列不换行**：宽表的流水号 / 风险 / 时间一律 `white-space:nowrap` 并给 `title`，
   否则会被从中间折断；窄卡布局下恢复自然换行。
4. **浮层用 fixed + 明确层级**：抽屉遮罩 900 / 抽屉 901 / 授权弹框 950。
   遮罩盖住整个视口时，**一次"没关掉"会让后面每个 click 都超时** —— 验收脚本里这是最常见的假失败源。

---

### 4.1 工作空间清理弹窗

清理入口在工作空间配置底部分组。弹窗使用环境模块自己的
`src/client/modules/environment/styles/cleanup.ts`，不再复用简单选择弹窗的排版。
头部与底栏不滚动，正文和待删清单各自限高；路径、文件名允许换行。
“不进回收站”和审核历史清空直接可见，Host 返回的补充限制保留在原生 `details` 中。
目录名确认与执行期间禁止关闭继续沿用原判据；焦点在弹窗内循环，关闭后返回入口。
原生控件通过 `tokens.ts` 中的 `--crwu-color-scheme` 跟随应用主题。

无需 ReactDOM 的专用布局验收（现有轻量渲染器生成真实组件快照，浏览器验证布局及原生折叠交互）：

```bash
node install/workspace-cleanup-browser-check.mjs --playwright <node_modules> --browser <browser-executable> --out <new-directory>
```

Playwright 和 Chromium 系浏览器为外部测试依赖，不随插件安装；macOS、Windows 均显式传入本机路径，
脚本在启动前检查文件存在，缺失时给出修复参数并退出。此轮仅 macOS + Edge 实测，Windows 未验证。
React 状态、回调及执行安全使用 `client-workspace-cleanup-dialog.test.mjs` 和清理状态机测试验证；
快照布局验收不代替真实 DSH profile 验收。

## 5. 侧栏入口：一张分组卡（唯一入口席位）

席位是 `sidebar.footer.action`（左侧栏底部、Settings 上方），**只占一个席位**，内容是插件自绘的一张卡：

```
┌───────────────────────────────────────┐
│ [品牌标记] 中瑞世联工作台  [dev]        │  ← 卡头：纯标题，不可点、无悬停底色
│ ───────────────────────────────────── │
│  ↗ 报告评估                            │  ← 三行子项，顺序固定，不按条件重排
│  ☑ 报告审核                            │     （它们是**模块入口**；面板内部才是
│  ⚙ 环境信息                       ●    │      「估值 / 审核」两级目录，见 §6.9）
└───────────────────────────────────────┘
```

口径与踩过的坑：

1. **卡头是纯标题**（用户：「中瑞世联工作台这个本身不应该能选中」）：它是 `<div>`，
   没有 `onClick`、没有 `cursor:pointer`、没有 `:hover` 规则。打开面板只靠子项 ——
   点当前子项同样能进（store 会推进 `selectEpoch`，面板据此重置门禁）。
2. **选中 = 面板正开着 + 就是当前模块**（`active && current.active === id`）。
   只看 store 里的"当前模块"会让用户在左侧栏点开自己的会话之后，这里还高亮着上一次那个子项 ——
   看起来像工作台还在前台（用户报过这个 bug）。面板切走就收起整块高亮，记忆仍留在 store 里。
3. **悬停与选中的底色必须色相不同**（用户报过"悬停别的子项时和激活那条一样"）：
   悬停 = `--dsw-alias-interactive-bg-hover` 中性极浅底；选中 = 品牌蓝低浓度底
   （`color-mix(in srgb, var(--dsw-alias-button-info-fill) 16%, transparent)`）+ 左侧 3px 蓝条 + 加粗。
   另外显式写 `.crwu-audit-module-on:hover` —— 悬停自己那条选中行不该被降级。
4. **卡激活只压实描边**（`border-l1` → `border-l2`）：不整块换底色，整块换在侧栏里就是一块突兀色块。
5. **「开发中」是灰色小 tag**（用户先要图标、看过之后又要求换回文字）：
   10px / 圆角 6 / `caption` 灰 / 一层极浅中性底，无描边、无状态色、**不带图标**。
6. **环境结论标记是 16px 实心圆徽标**（用户选定"圆底图标（iOS 设置风）"）：
   通过 = **品牌蓝实心圆 + 白勾**（2026-10-16 改：不再用亮绿，绿色在环境页与信息蓝"打架"）/
   不通过 = 红圆白叹号 / 自检中 = 琥珀圆 + 一段旋转白弧（CSS `::after`）/ 尚未自检 = 空心圈。
   它**只画在「环境信息」那一行**，挂在别的子项后面会被读成"那一行通过了"。
7. **不要再引入背景水印**：试过一版（超大单色 logo + 下面一行「中瑞世联」），
   用户看过之后决定不要。验收脚本反过来钉住 `.crwu-audit-watermark*` 数量必须为 0。
8. **折叠成 56px 轨道时只画品牌标记，不画环境徽标**（用户 2026-09-22：
   「左侧栏收起来的时候不应展示绿色的标记」）。轨道里既没有「环境信息」这行字、也没有卡头，
   一枚常亮的实心标记在那里读不出结论，只是噪音。结论不丢 —— 轨道那颗按钮的 `title`
   仍然写着「环境信息：已通过 / 未通过 / 自检中 / 尚未自检」。`install/browser-check.mjs`
   会点一次 DSH 自带的「收起侧边栏」，断言轨道里 `svg` 恰好 1 枚、`.crwu-audit-side-entry-mark`
   0 枚，再点「打开侧边栏」还原成分组卡。

---

## 6. 面板外壳

### 6.0 子页面只有一层 Workspace Surface（2026-09-22 / 09-23 用户口径）

用户原话：「除了 header 部分，其他都是 border，我认为都可以用一个圆角的大背景框住，
而不是分为好多块」。这条是**子页面级的布局硬规则**，改任何一页先照它来：

- **头部留在框外**：品牌 + 版本标签 + 问候仍是 DSH 面板头（§6.1），正文才开始是框。
- **正文只有一层框**：`.crwu-audit-surface`（圆角 14 / 1px `--crwu-border` / `--crwu-surface` /
  `--crwu-shadow-surface` = `0 1px 2px rgba(0,0,0,.025), 0 8px 28px rgba(0,0,0,.035)` /
  `overflow:hidden` 让圆角真的裁住里面的标题行与表头）。它是"工作台里的一块纸"，
  **不是 Dashboard 大卡**：描边极浅、阴影极轻、半径克制；
- **App 底与纸分得开**：root 底是 `--crwu-app-bg`（浅灰），body 内边距 20×24；
- **框内的分区靠发丝线 + 留白**，卡片自己那层描边 / 阴影 / 圆角在这一层里撤掉
  —— 否则只是把"好多块"往里挪了一层，用户看到的还是"框里套框"；
- **报告审核只有一个报告列表**：列表上方不再有「报告列表」标题或 Tab；总数只在分页区显示一次。
- **用 `hidden` 隐藏的元素要自己兜一条 `[hidden] { display: none }`**：`hidden` 只靠 UA 样式，
  任何作者样式的 `display` 都会把它盖掉（2026-10-11 实测：两个常驻 tabpanel 的空壳因此占了 320px，
  用户看到"页签下面一大片空白"）。
- **页签是一条工作区导航，不是两张卡片**（2026-10-11 重构）：命中高度 44px；选中态 =
  文字加重 + 3px 品牌色底部强调线（**形状 + 颜色双重**，不靠颜色单独表达）；未选中只做悬停浅底；
  焦点环 2px；`prefers-reduced-motion` 下不做过场。两个 tabpanel 元素常驻，非选中者为 `hidden` 空壳
  （`aria-controls` 恒有效，同时不把重页面挂起来）。
- **审核中的行不展示"与 DeepSeek 讨论"**（2026-10-11 用户口径）：正在跑的这条还没有可讨论的结果，
  主位已经是「审核中」状态；停止与查看审核信息留在 ••• 里。**不是**把入口整体撤掉 ——
  非审核中的行照旧有这一枚。
- **一个视图只允许一枚 primary**：次级操作（选择、复制、重新准备）用共享 `secondary` / `soft` /
  `text` 蓝色变体；
  高风险动作（重新审核、停止审核）用警示语气 + **行内二次确认**（第一次点只把该项变「确认…」）。
- **命中区 ≥44×44px**：共享 Button / IconButton 在 coarse pointer 下用真实的 44px 尺寸；
  小图标按钮（列表行 X、交付件 ⓘ）只在**纵向**扩外扩，横向外扩会撑出窄面板的横向滚动条。
- **禁用旁边必须说原因**：可见文字 + `aria-describedby` 关联到按钮上，不只挂 `title`。
- **加载不许伪装成空态**：数据还没回来时给骨架 + `role="status"`；"一个都没有"才是空态。
- **错误用 `role="alert"`、成功反馈用 `role="status"`**；普通说明两者都不用（避免噪音）。
- **一个工作面、一条纵向任务流**（2026-10-20 修订 2）：估值只要求两个业务选择 ——
  **资产类型 / 评估方法**，资料、模板、目的、价值类型、日期、补充要求与信息获取辅助都可留空。
  页面顺序固定为 **必填两项 → 资料（可选）→ 补充条件（可选）→ 信息获取辅助（可选）→ 操作**；
  资料控制（选择文件 / 文件夹、清空）放在资料列表之前，资料很多时不把操作推到长列表末尾。
  工作面上限宽 1120px、宽屏居中。当前顺序由 `tests/unit/client/client-valuation-required.test.mjs`「revision 2 puts the two required choices before optional materials and conditions」钉住。
- **估值页也走"一层工作纸"**（2026-10-15）：三个业务页（报告审核 / 本地审核 / 报告评估）在内容区里
  共用同一个 `.crwu-audit-page-paper`（14px 圆角 + 轻边界 + `--crwu-shadow-surface`）。
  估值页以前直接落在内容区底色上，于是"内部辅助卡片很重、外面反而没有纸"。业务模块**自己不再画框**
  —— 再画一层就是双层描边，而"卡片里再套卡片"正是这一轮要去掉的重感；分区改由 16–24px 留白 +
  `--crwu-border` 发丝线表达（`.crwu-valuation-block + .crwu-valuation-block`）。
- **两个必填项用同一种控件**：资产类型与评估方法都是**select-only combobox**（`role=combobox` +
  `listbox`/`option` + `aria-expanded` / `aria-controls` / `aria-activedescendant`），
  **不是**原生 `<select>`、也**不是**一排 radio —— 后两者统一不了观感，而原生 `<select>` 的浮层
  改不了宽度、选项说明与选中勾。触发器的视觉与文本输入完全同档（40px 高 / 10px 圆角 /
  12px 水平内距 / `--crwu-input-bg` 填充）。
- **浮层落点是"量"出来的，不是猜出来的**（2026-10-15 真机纠正）：估值工作面带
  `container-type: inline-size`（容器查询的宿主），但 **Chromium 不把它算作 `position: fixed`
  的包含块**（计算值 `contain: none`）。按"container-type 隐含 layout 包含"去换算坐标，
  贴右下的下拉会整体偏移一个工作面原点（实测跑到资料区左上角 24,271 而不是触发器下方 349,444）。
  现在先按视口坐标摆一次，再读回元素自身 `getBoundingClientRect()` 把差值累加进偏移 —— 一次收敛，
  祖先换了 / 页面滚了都会在下一次重摆时自己纠正。
  ⚠️ 配套约束：浮层的**入场动画只能动 `opacity`**。`getBoundingClientRect()` 包含 `transform`，
  带位移的入场动画会让第一次量到的位置偏 4px，于是自校准把浮层永久推到偏 4px 的位置（实测过）。
- **必填项的错误不是一进页面就红**：只在**失焦**、**清空已填值**或触发下一步时，才在该字段下方
  出现一句短错误；底栏仍用 `aria-describedby` 说明"当前最先要完成的一项"。
- **响应式以面板实际可用宽度为准**（容器查询 `@container crwu-valuation`），不是浏览器窗口宽度：
  宿主侧栏展开后窗口可能很宽、面板却只有 500px。宿主不支持容器查询时退回纵向排布（不横向溢出）。
- **页面的身份由目录条承担，不再画 24px 页面大字**（2026-10-11 用户口径：「报告审核 页面的
  报告审核这几个大字不需要」）：一级 / 二级目录条（§6.9）就长在正文顶部，再画一行同名大字只是重复。
  估值页 2026-10-16 也统一到这条：`valuation` 节点**不声明** `title`，「估值」页签就是页面身份，
  目录下面不再重复一行大字。通用渲染器保留给**声明了 `title` 的节点**；`.crwu-audit-page-head` /
  `-page-title` 两个类仍保留（别处可能复用），报告审核页不使用。
- **目录条在纸外面，纸只有一层**：一级 / 二级目录条长在滚动容器（`.crwu-audit-tab-panel`）**外面**
  —— 所以它始终留在页面顶部，切换目录时页面也不会跳。审核那两页在内容区里共用**一张纸**
  （`.crwu-audit-page-paper`），报告审核页自己那层 surface 在纸里必须**撤掉描边 / 圆角 / 阴影**
  （`.crwu-audit-page-paper > .crwu-audit-surface { border: 0; border-radius: 0; box-shadow: none }`）
  —— 否则那圈 1px 正好落在内容顶部，用户看到的就是"下面多了一条横线"（2026-10-11 实测）。
  内容块还必须把高度接下去：`.crwu-audit-surface` 是 `height:100%` 的 flex 列，没有这一层，
  里面那层 surface 的 `height:100%` 会退化成 `auto`、`pane-main` 的 `overflow:auto` 就再也滚不起来。
  估值页是**固定高度工作面**：`.crwu-audit-tab-panel[data-workbench-page="valuation"]` 关掉自己的
  `overflow`（全页只有一条竖滚动条），滚动交给工作面的正文 `.crwu-valuation-intake-body`；
  那张纸加 `padding-block: 16px 12px` 与 `data-workbench-page="valuation"`，让正文滚动条不顶到圆角。
- **右侧自绘 AI 讨论栏已撤**（用户 2026-09-22：「这里不设计右侧对话框了，去掉吧，只会增加负担」）：
  讨论只由操作列那枚小鲸鱼进入，落到 DSH **原生会话**（见 §6.4）。

表格固定七列：报告名称、报告流水号、风险等级、人工复核、AI 审核结果、更新时间、操作。
人工复核显示氚云原始字段，AI 审核结果列默认只显示查询状态或交付件数量；审核报告、审核数据等明细通过数量旁的信息图标悬浮查看，查询失败不得写成未审核。

**报告列表是一张细描边圆角卡**（2026-10-20 修订 2）：卡内是安静标题 + 流水号搜索（Enter 才查、框内清空）
+ 刷新 + 列表 + 分页。宽度判断走列表卡自己的容器查询（`@container crwu-audit-report`），
不是浏览器窗口：≤1180px 表格取消 `min-width`、操作区允许换行；≤760px 每条报告成为一张可读卡片，
七个单元格用 `data-label` 显示列名，操作独占一行。**不隐藏列、不裁掉主操作 / 小鲸鱼 / •••**，
375/600/960 面板宽度都不出现横向滚动。当前审核摘要是列表之外的一张紧凑任务卡，与分页 / 搜索无关。

**列表的其余硬数字**（改之前先看 `modules/report-audit/styles/pane.ts` 与 `ui/styles/*`）：
表头 39px / `--crwu-surface-subtle` / 12px 500；行 82px + 12px padding + 发丝线；
风险 = 6px 圆点 + 字母（无底无描边）；搜索框走共享 TextInput（`.crwu-ui-input-wrap`，
边框 / 填充 / 聚焦由共享 field 所有者负责）。工具条的刷新与 42px 输入框同高（coarse 下共享
`min-height: 44px` 接管）。**有起点装饰的输入**由共享 field 给 wrapper 标记 `data-start-adorned`：
图标内缩 12px、图标到文字 8px，同时把 input 自己的左内距归零 —— 否则 12px 内距 + 6px gap 会叠成
18px 的假间距；无装饰的输入仍是 12px 文字内距。

**次级控件只有一套浅蓝底**（用户 2026-09-23：「操作列的按钮颜色不一致，还有刷新按钮」）：
工具条的**刷新**、操作列的**小鲸鱼**、**•••**，全部走同一对 token
`--crwu-control`（静止，现在是 `--crwu-interactive-soft` 的别名）/ `--crwu-control-hover`
（悬停）/ `--crwu-control-active`（按下或菜单打开），**一屏里只有主操作是实心**。
改其中任何一个都要改另外三个 —— 单测「次级控件共用同一套中性底」会把不一致直接判红。
小鲸鱼 / ••• 是共享 `IconButton`：`flex: 0 0 auto` 且子 SVG `flex: none`（DeepSeek 图形保持
自身 23.16:17.04 比例，实测 18×13.24）；宽表里操作列整行 `min-width: max-content`，
中等宽度允许整行换行，窄卡布局里操作独占一行起头，绝不把 32px 命中区压成 25.8px 的细条。

两条对应的坑：① 这套底必须和 `--crwu-hover`（行悬停底）**分得开**，否则鼠标移到哪一行，
那一行的次级控件底色就和行底糊在一起；② 这套 token 是**浅深两套里各写一遍**的
（`--crwu-control` 在 `body[data-ds-dark-theme]` 块里被覆盖），只改浅色那份，深色就会退回旧值。

### 6.1 头部

`[品牌标记] 中瑞世联工作台 [dev/版本标签] ………………………………… 晚上好，某某某`

- **头部要安静**：高 54px、`--crwu-header-bg` + `backdrop-filter: blur(18px)`、
  底边 1px `--crwu-border`（**不要纯黑线**）。它不是视觉中心，标题字号与正文同级；
- **右侧永远是那句问候**（`greetingLine(hour, env.me.name)`）：问候语按本地小时分档
  （凌晨好 0–5 / 早上好 5–9 / 上午好 9–11 / 中午好 11–14 / 下午好 14–18 / 晚上好 18–24）；
  姓名的来源见 `docs/development-notes.md` §6（跟着环境自检一起取）。
- **姓名拿不到就整句不渲染**（用户：「如果钉钉 cli 没有登录信息，那就什么也不展示」）：
  不显示「晚上好，」这种半句，也不编造"同事"之类的占位。
- **头部不显示模块名**（用户要求去掉）："我在哪一页"由侧栏那张卡的高亮说了算，
  右侧那一格留给问候。窄面板下标题先被截断，版本标签与问候永远看得见。

### 6.2 首次进入 = 统一的等待页

第一次点进工作台会跑一轮环境自检（工具 / 登录态 / 上传配置 / 外部数据）。这几秒里
**整块正文只有一页**（`shell/LoadingPane.tsx`），不是"环境信息页的半成品"：

1. **一枚会依次亮起来的品牌标记（76px）**：四个色块按 `crwu-audit-brand-wave` 顺序呼吸
   （延迟 0 / .14 / .28 / .42s），整体再叠一层极轻微的 `crwu-audit-breathe`。
   用品牌图形当加载符号：客户端产物是单文件、没有资源加载器，任何新图形都得内联进 bundle，
   而品牌标记是现成的矢量、跟着主题缩放，比通用转圈更有归属感；
2. 主文案「正在自检环境」+ 一句说明（正在检查工具、登录态、上传配置与外部数据，通过后会自动继续）——
   刻意不提任何模块名；
3. 底部一条**限宽**（168px）的不确定进度条，让"还在动"有连续的视觉证据；
4. `@media (prefers-reduced-motion: reduce)` 关掉动画：结构、文案不受影响。

**什么情况下不显示等待页**：宿主是旧构建（要看到"请重启 profile"那句话）、
请求已失败（要看到真实原因）—— 一直转圈会把这两种情况藏起来。

### 6.3 「开发中」与空目录

二级目录里 `enabled: false` 的那些页面（估值 / 土地、估值 / 机器设备）在目录条上是**灰态 + 一枚
「开发中」小标签**，并且**不可进入**（`disabled` + `aria-disabled`，判据同时在 store 里）。

一级目录下一个可用页面都没有时（其他业务），正文只说一句「**该业务目录暂未开放**」——
居中、一行、`--crwu-text-secondary`；不给空白页、不编功能清单、不写"敬请期待"。

### 6.4 点小鲸鱼：用 crwu 拉文件 → 气泡问「新建 / 继续」→ 跳原生会话

**右侧自绘对话框已经撤掉**（用户 2026-09-22 改口径：「这里不设计右侧对话框了，去掉吧，只会增加负担」）。
对话本体是 DSH 的**原生会话**，我们只做三件事：拉数据、问一句、切过去。

| 位置 | 内容 |
|---|---|
| 入口 | 操作列里那枚 `.crwu-audit-ai-row-btn`；图标是**用户给的 DeepSeek 官方 SVG**（`viewBox 0 0 23.16 17.04`，填充式 `currentColor`，宽扁比例别拉伸） |
| 悬停文案 | 「与 DeepSeek 讨论报告」——**浮层 Tooltip**（`--crwu-tip-bg` + 白字 + 箭头，渲染在表格之外），不用原生 `title` |
| 拉取中 | **只盖列表数据区**（`.crwu-audit-ai-mask`）：页头 / 页面标题 / 工具条保持可见，里面是与首屏自检同一枚品牌标记 + 进度条的等待页（用户："crwu 在查询的时候，应该有个中瑞世联的 Loading 页面"） |
| 有绑定会话 | 弹 `.crwu-audit-ai-dialog`：**新建对话 / 继续上次聊天**；点遮罩关掉，不建任何东西 |
| 没有绑定会话 | 直接建新会话 + 注入上下文，然后把主面板切到那条原生会话 |
| 多会话 | 会话名 `报告讨论 · <流水号>`、`… #2`、`… #3`；**前缀匹配要排除 `X-10` 这类**（`报告讨论 · X-1` 是它的前缀，纯 `startsWith` 会认错人） |

**操作列三件套的视觉口径（2026-09-23 重定，取代「三个都实心反色」那版）**：一行只有
**一个主操作 + 小鲸鱼 + 必要时一个 •••**，一屏里只允许**一处实心**：

| 元素 | 几何 | 底色 |
|---|---|---|
| 主操作（AI 审核 / 查看报告） | 32px 高 / padding 0 12 / 圆角 8 / 13px | `--crwu-primary-bg` + `--crwu-primary-text`；hover `--crwu-primary-bg-hover` + `translateY(-1px)`；active `scale(.97)` |
| 小鲸鱼 | 32×32 / 圆角 8 | `--crwu-control`，hover `--crwu-control-hover` + `translateY(-1px)`，active `--crwu-control-active` + `scale(.94)` |
| ••• | 32×32 / 圆角 8 | 同小鲸鱼：`--crwu-control` / hover `--crwu-control-hover` / 打开 `--crwu-control-active` |

**「刷新 / 小鲸鱼 / ••• / 复制」是同一族**（都是次级控件），底色逐字相同；差别只在几何与图标。
第一版把它们做成了三种形态（刷新透明 Ghost、小鲸鱼填充 `#F2F3F4`、••• 全透明），用户一眼就指出
「操作列的按钮颜色不一致，还有刷新按钮」—— 现在这条由单测与验收脚本双向盯着。

**报告行的交付件只讲业务语义**（用户 2026-09-23 口径，2026-10-09 收成浮层）：AI 审核结果列默认
只显示「N 个交付件」+ 一枚 Info 图标，**悬停 / 聚焦 / 点击**时才在表格之外的全局浮层里按
「审核报告 / 审核数据 / N 个辅助文件」列明细；**不显示 `crwu/audit/.../*.html|json` 这类 OSS 原始路径**；
完整路径只允许出现在「审核信息」抽屉与开发模式里。交付件到业务语义的映射在
`ReportPane.tsx` 的 `fileKindsOf`，行操作规则在 `row.ts`（有单测，且都证伪过）。

**拉的是什么（`report-files`，第 26 个 Host 操作，只列举不下载）**：用户让我"看下 skills 里 crwu
是怎么查这些文件的" —— crwu-audit 技能步骤 1 就是
`crwu h3yun files list --schema <表单 code> --id <ObjectId>`，只取**附件字段/文件名/类型/大小/下载 URL**
这些元数据（真实输出 `{"data":[{field,fileId,fileName,fileSize,contentType,downloadUrl}]}`）。
所以这一查是三组：**氚云附件**（权威来源）+ **本地案例目录** `<工作空间>/<流水号>` + **云端交付件**
（复用 `ossIndex({seqNo})`）。**正文一律不下载** —— 要正文由 AI 在会话里按需取，或走逐件的
`crwu h3yun file get`。

**为什么不做自绘对话**（2026-09-22 对照安装的 DSH 逐个核实，别再试一遍）：
`main` 槽位只有保留键 `conversation` 有会话绑定；客户端产物只能 `require('react')`（装不进 `ui-chat`）；
右栏只有资源标签页、没有对话类型；真机探针实测登记回调拿到的标准 props 是
`usePanelInfo|useSessions|useSessionPendingInteraction|useWorkspaces|useResource`，**没有 `renderSlot`**。

---

### 6.5 「审核信息」Drawer：AI 审核质量与问题摘要（2026-09-23 二轮定稿）

**定位**（用户原话）：「它不是审核状态详情，而是 **AI 审核质量与问题摘要**」。所以第一屏按 P0–P4 排：

| 优先级 | 内容 | 数据来源 | 视觉 |
| --- | --- | --- | --- |
| **P0** | 复核命中率 | `reviewComparison.metrics.aiHitRate`（缺则 `hitRate`） | **32px/600**（第一视觉重点）；**不按高低给红黄绿**（命中率不是考试成绩）；只显示百分数，公式进技术详情 |
| **P1** | AI 检出问题数 | `summary.counts.issuesTotal`（**缺字段才**退回 `issues.length`；不从 severity 重新求和） | 20px/600 + `其中独立发现 N`（`bands.aiOnly`，只作 secondary，不做第四个 KPI） |
| **P1** | 已提未改 | `reviewItems[].linkedIssueIds` × `inFileResolution === 'L-open'` | 20px/600 + 左侧 3px 琥珀强调条 + 低浓度红 badge |
| **P2** | AI 检出的具体问题 | `issues[].title` + `gapAnalysis.difference`（退回 `problemDescription` 首行/首句） | 列表行（非 Card）：严重程度 · 标题 · 两行简述；点开给位置 / 建议 / 查看更多审核依据 |
| **P3** | 报告信息 | projectId / auditTime / stage / reportVersion / generatedAt + 审核结论 / 复核状态 | **默认折叠**的 40px 小节 |
| **P4** | 技术详情 | 引擎版本 / raw 枚举 / raw counts / bands / metrics / reviewItems / 原始 ISO 时间 / schema / renderer / digest / 内部流水号 | **默认折叠** + monospace + 可复制 |

**第一屏明确不放**：审核摘要卡、「未通过」大状态、「复核 · 已执行」、`问题情况 → 发现问题 → 13`
这类三层重复标题、命中率完整公式、`{"overlap":1,...}` 原始 JSON。

**「已提未改」的判定（唯一口径，不许改写成别的）**：`linkedIssueIds` 非空 **且**
`inFileResolution === 'L-open'` → 关联 `issues[]` → 按 issueId 去重。`L-resolved` / `L-unclosed` /
`L-uncheckable`、以及没有关联 issue 的人工项一律**不算** —— 用户口径「宁可暂时不显示，也不要误报」。
**不要**用 `overlap > 0` 或 `issue.flowStatus` 顶替（前者只是"两边都发现了"，后者只是问题工作流状态）。

**数据从哪来**：抽屉拿不到 `issues[]` / `reviewItems[]` 时无法展示这两块，所以
`oss-result`（`auditInfoFromResult`）**追加**了两组**裁剪过的最小集**（同一操作、同参数，纯新增；
`WORKBENCH_PROTOCOL` 随之 +1）。裁剪口径：`issues[]` 只留 8 个字段、逐字段截断、封顶 100 条；
`reviewItems[]` 只留 6 个字段、封顶 100 条。**`ruleEvidence` / `materialEvidence` / 知识库路径 /
完整引文不进这个接口** —— 它们在交付件里，由「查看更多审核依据 →」回到报告。

**折叠机制**：一处实现（`.crwu-audit-acc` + `data-open` + `grid-template-rows: 0fr→1fr`，170ms），
已提未改 / 报告信息 / 其他事项 / 技术详情 / 单条问题共用；chevron 同步 `rotate(90deg)`。
AI 问题**一次只展开一条**（列表层持有 `openIssue`）。

尺寸与交互：宽 580（560–620，`--crwu-drawer-w`）、面用 `--crwu-surface`（不另立深色主题）；
遮罩 `rgba(0,0,0,.32/.34)` + `blur(2px)`；开 `translateX(20px) → 0` 200ms、关 150ms（父层延迟卸载，
`onClose` 仍立刻回调）；头部 `标题(16/600) + 一行等宽流水号 + ×(32×32)`；业务时间一律绝对
（`YYYY-MM-DD HH:mm`）；关闭后不动列表（页码 / 搜索 / 滚动位置）。

### 6.6 「AI 审核结果分析会话」（audit_analysis，2026-09-23）

**入口**：有正式 HTML 或 JSON 的报告行操作列 = `[查看报告] [DeepSeek SVG] [•••]`。DeepSeek 那枚**复用**
`ui/icons.tsx` 的 `DeepSeekIcon` 与操作列同一套 Icon Button（`C.aiRowBtn`，32×32、
圆角 8、`--crwu-control` 底、hover `translateY(-1px)`、active `scale(.94)`），Tooltip 走**同一个**
Floating Layer，文案换成「与 DeepSeek 分析审核结果」（无正式结果时为「与 DeepSeek 讨论报告」；有结果时原始报告讨论保留在菜单）。
**不要**新增文字按钮（`AI分析`）、不要新增状态 Tag（`可分析 / AI ready / 已同步 / 上下文完整`）。

**会话归属**：与报告列表共用 `Report → Conversations`（1:N），来源靠**会话名**区分：
`审核分析 · <流水号>`（`audit_analysis`）vs `报告讨论 · <流水号>`（`report_discussion`）。
`ensureDiscussion({kind})` + `sessionsOfKind(kind, …)` 是唯一入口 —— 不去给 DSH 的会话数据库加 metadata。

**点下去先做版本检查（Audit Conversation Preflight）**，绝不静默进入：

| 顺序 | 动作 |
| 1 | `report-files`（氚云附件 + 本地案例目录 + 云端交付件，**只列举不下载**） |
| 2 | `oss-result`（裁剪过的审核摘要：审核报告 / 结构化问题 / 复核意见） |
| 3 | `freshnessOf()` 判定版本关系 |
| 4 | 按结论弹框或直进 |

**版本判定优先级**（`modules/report-audit/model/audit-freshness.ts`，纯函数）：
`digest → version → etag → mtime → 时间退化`。两侧都有的那一项才可比；**纯时间关系只能得出
`possibly_stale`**（用户口径：更新时间可能来自非内容性操作），`stale` 必须有 digest/version/etag 证据。
四态 `current / possibly_stale / stale / unknown` **只给程序用**，界面上永远说中文。

| 结论 | 界面 |
| `stale` | 「报告已更新」+ 两个时间对照 + 重新 AI 审核 / 仍以当前审核结果分析 / 取消 |
| `possibly_stale` | 「报告在 AI 审核后存在更新记录」+ 使用最新资料重新分析 / 继续查看原审核上下文（**不用"已失效"这种确定语气**） |
| 缺原始报告 | 「无法获取最新原始报告」+ 重试 / 仍以有限资料继续（进入 Limited Context） |
| 已有分析会话 | 「已有审核分析会话」+ 继续上次分析 / 新建分析会话（检测到更新时**建议**新建，不替用户选） |

**新建 = Fresh Snapshot**：重新取最新资料与审核产物；§20 的 System Instruction **逐字**注入
（`zhCN.aiAuditSystemPrompt`，`【REPORT_SERIAL_NUMBER】` 换真实流水号），再附 §21 的版本 Notice
（报告更新时间 / AI 审核时间 / 复核更新时间 / 版本关系 / 缺失项）。**不把文件正文拼进 Prompt** ——
会话建在案例根目录下，模型按路径回看原文（用户 §19）。

**版本证据从哪来（一次调用就有）**：`ossutil ls` **默认长格式**，一次列举同时给出对象个数与
每个对象的 `Size(B)` / `LastModifiedTime` / `ETag`（`parseLsEntries()` 解析；**不要**加 `--short-format`）。
本地案例目录那份用 DSH `fs` 的 `FsDirEntry.version`（后端权威新鲜度令牌，比 mtime 强）。
两者各自与**上次快照**比 → 「报告资料变过 / 审核结果重新生成过」是客观信号；
跨源（本地 fs version vs OSS ETag）**不可互比**，所以初次判定仍按 digest→version→etag→mtime→时间 退化，
不齐就只说 `possibly_stale`。

**Context Snapshot** 存在浏览器本地 `crwu.audit-analysis.<流水号>`（读写都收窄 + try/catch；
丢了退化到会话行 `updatedAt`）。字段见 `audit-freshness.ts` 的 `AuditContextSnapshot`。
**历史审核产物永不回写**：AI Audit T1 / Current Report T2 / Analysis T3 三者独立。

### 6.7 DeepSeek 会话的统一数据边界（远端-only，2026-09-23 强制规则）

两个业务会话（`report_discussion`、`audit_analysis`）**只允许使用本次会话由系统从远端业务数据源获取、
并显式加入 Conversation Context 的资料**。本地文件一律不许进业务判断 —— 即使文件名/流水号与当前报告
完全一致。

| 维度 | 规则 |
| --- | --- |
| 允许的资料 | 氚云附件（远端原始文件）· 云端交付件（OSS 对象）· 远端业务 Metadata · 远端 AI 审核报告 HTML · 远端审核结构化 JSON · 远端人工复核意见 |
| 禁止的资料 | 本机目录/工作区/缓存/临时目录/历史下载/其它任务留下的文件 —— 一律不进上下文，也不给路径 |
| 上下文构造 | `fileLinesOf()` **只列氚云附件 + 云端交付件**；`report-files.local`（本地案例目录）整组丢弃 |
| 来源记录 | `sourcesOf()` → `{sourceType:'remote', provider:'h3yun'|'oss', remoteId, remoteVersion, remoteUpdatedAt, digest, fetchedAt}`；**不许出现 localPath** |
| 版本身份 | Snapshot 用 `reportRemoteId`（氚云 fileId + OSS key）/ `auditRemoteId`（OSS key）/ `fetchedAt`；**本地路径不参与版本判断** |
| 远端失败 | **不 fallback 本地**：弹「无法获取当前报告的远端最新资料 / 为避免使用过期或来源不明的数据，本次未创建分析会话」，只给**重试** |
| 部分远端缺失 | 允许按真实可用的**远端**产物降级（只有 HTML 或只有 JSON），并在上下文里写明缺什么；**不得用本地文件补齐** |
| Prompt | §12 / §13 / §14 逐字注入（报告讨论 7 条 + AI 分析 7 条强制规则 + 事实来源优先级） |

**Prompt 只描述"本次远端提供了什么"，不描述"本地存在什么"**：不许出现「本地已经…」「工作区下面…」
「从本地读取…」这类表述（有单测/契约扫描盯着）。

**工具层边界（§15）现状**：插件侧**做不到**给会话指定 agent preset —— DSH 客户端
`sessions.create()` 会重建 payload 只转发 `{workspaceId|cwd, sessionId}`，`agentPreset` 被丢掉
（见 `@deepseek-ai/dsh-api-session-controller/lib/client.js` 的 `create()`）。按 preset 组合建会话
（preset 内不挂 bash/fs 工具 → 会话根本没有本地文件工具）只在**宿主侧**可行：
`ctx.get('agents').create({meta:{agentPreset}})` + `agentPresets.mount(agentCtx, id)`
（本插件建审核根会话时已在用这套），且需要插件自带一份 preset 目录并挂进 profile 的 preset root。
这属于改动 Harness 的 agent plane + 必须真机重启验证。
**用户 2026-09-23 已确认：本轮就采用「上下文 + Prompt」边界（方案 B），工具层的 preset 方案不做** ——
所以这是**有意选择**，不是遗漏；不要在看到"模型理论上仍可主动横扫文件系统"时把它当成待修缺陷，
要改先问用户。边界范围只针对这两个业务会话，**普通 Harness 会话不受影响**。

### 6.8 环境信息页：紧凑状态摘要 + 引导式配置工作区（2026-09-26 重排）

**页面顺序 = 员工的操作顺序**，而且**一次只让他做一件事**：

```
┌ 环境状态摘要 ─────────────────────────────────────────┐
│ 环境已就绪 / 还需完成 N 项                [重新检查]   │
│ 已完成 N/N · 最近检查与验证 2026-10-16 09:33          │
└───────────────────────────────────────────────────────┘
┌ 配置工作区 ───────────────────────────────────────────┐
│ 1 账号连接     已完成 │ 第 N 步 · <标题>        <状态> │
│ 2 阿里云 OSS   待处理 │ 一句用途说明                    │
│ 3 iFinD        待处理 │ 当前操作表单 / 登录按钮          │
│ 4 工作空间     已完成 │ 验证过程与人话结果               │
└───────────────────────────────────────────────────────┘
                                     [>_ 开发者诊断 ▾]
```

五条硬口径：

1. **顶部只有一枚主动作「重新检查」**。就绪时**不**放跳转按钮，只写一句
   「配置已完成。你可以从左侧进入报告审核。」—— 进哪一页由左侧栏的统一导航门禁说了算。
2. **顶部不罗列全部阻塞项**，只给**第一条**明确下一步（左侧步骤导航已经回答了"哪里不对"）；
   `平台` 这类技术指标移入开发者诊断，检查 / 验证时刻压成一行辅助文案
   （`YYYY-MM-DD HH:mm`，无秒、无 AM·PM；两个时刻是同一瞬间时合并成一句「最近检查与验证」），
   完成数量与进度合并成一条紧凑摘要（不再有三块指标卡）。
3. **默认停在第一项未完成的步骤；用户手动选过之后，后台刷新不许抢焦点**。
   响应式看**面板自己的宽度**（命名容器查询 `@container crwu-environment`），不是浏览器窗口：
   ≤860px 改成顶部横向步骤条 + 下方详情，≤559px 步骤条收成 2×2 网格，任何宽度都不得横向滚动。
4. **密钥类输入只提交、不回显**：OSS AK 与 iFinD API-Key 两张表单都在提交后立刻清空本地输入，
   已保存只给掩码 / 「已保存」；Bucket、Endpoint、前缀、验证工具名、数据样本、协议版本、
   凭据文件路径**只在开发者诊断里**出现。
5. **开发者诊断是内容区右下角的轻量入口**：终端 SVG + 文字，自适应宽度、无整行虚线框；展开后
   全部信息进入入口上方的单一大面板，面板顶部提供完整复制，入口/收起按钮始终留在同一位置，
   不用 `fixed` 悬浮遮挡表单；展开后的技术数据保持全宽并显示在入口上方。入口下方常驻一条克制的
   「联系开发同学排查」链接，跳到开发者公开分享的钉钉个人名片，作为员工无法自行恢复时的兜底。

**2026-10-16 环境页视觉补充**：就绪态不再用绿色 —— 状态摘要走白 / 深色面 + 1px 中性描边
（左侧没有绿色竖条），对勾与进度条改用 `--crwu-interactive`；`-bad` 仍保留琥珀警示边。
步骤导航的「已完成」是中性 / 淡蓝而不是亮绿勾；步骤面板里的配置卡**拍平**（去掉嵌套阴影与
第二层描边，只留发丝分隔与留白）。这些「ok 徽标 / 胶囊 / 圆点改蓝」只在
`.crwu-environment-page` 之下生效，**共享的全局成功绿（审核通过）不动**。
工作空间那一步只说人话：普通卡片只写「审核产物写到 `<工作空间>\<报告流水号>\`。」；
cwd / subagent 那串技术说明移进开发者诊断的「工作空间执行说明」一行，不再出现在员工视野里。

**账号连接那一步的两条登录路（协议 32）**：`钉钉登录（打开系统浏览器）` 是**首选**，
`设备流登录（浏览器回调不通时用）` 是**退路**。退路点开后**秒级**出现授权码与授权链接
（`dws auth login --device` 最长要等人 5 分钟，同步等它跑完就等于拿不到码）：

| 状态 | 画什么 |
| --- | --- |
| 闲置 | 一颗「设备流登录」+ 一句"什么时候该用它"（跑起来之后这句就不再显示） |
| 等待中 | 「等待你在浏览器里完成授权…（还剩 4:37）」/ 授权码（等宽、拉开字距）+「复制授权码」/ 链接 +「打开授权页面」+「复制链接」/「取消」 |
| 成功 | 一句话 + 环境自检**自动**刷新（不用手点「重新检查」） |
| 失败 / 超时 | 人话 + 沙箱归因的下一步动作 + dws 原文 + 「重试」 |

**授权页由 Host 打开，不由 CLI 自己开**（协议 32）：`dws` 自己那次 `open` 失败是**静默的**
（上游 loopback 用 nil logger、device 只记 Debug），员工看到的只有"点了没反应"。所以插件传
`--no-browser`、自己从输出里取链接并用 `system.browser.open` 打开，把 `opened` / `openError` 报回面板。
设备流优先打开「已填入授权码」那一版链接（员工只要点确认），「手动输入授权码的链接」单独列一行作退路。

**客户端补开是尽力而为**：Host 报 `opened === false` 时面板才用 `window.open` 再试一次 ——
它发生在一次 `await` 之后、不是用户手势，浏览器可能直接弹窗拦截。所以可靠路径是那颗
「打开授权页面」按钮；被拦不算失败，链接与授权码都摆在面板上可复制 —— 这恰好是无头 /
回调不通场景要走的路。两条登录**互斥**：设备流在跑时宿主拒绝 loopback，
loopback 在跑时界面禁用设备流按钮（都要抢同一把 `.dws` 锁）。

**视觉**：工作区是**一个** surface —— 左侧步骤栏靠一条发丝线与右侧分区，步骤项之间只有 2px 间距，
选中项是槽里浮起的一块白片（与分段控件同一套语汇）；不套"卡片里再套卡片"。
状态色只出现在三处小元素上：步骤序号圈（已完成 = 绿）、步骤面板标题旁的状态标签、配置项的状态点。

**分类色**：`authenticated` **且真的取到数据** = 绿；`unverified`（含"认证过了但没取到数据"）=
琥珀（**不是红**：还没证据 ≠ 填错了）；`invalid` / `unreachable` / `unconfigured` = 红。

**iFinD 是必需项（2026-09-26 起）**：未通过时它是一条**阻塞** issue，顶部摘要会说
「还需完成 N 项」，受保护页面被统一导航拦回本页，提示**整句**指名到项
（「进入【报告审核】前，请先完成 iFinD API-Key 验证。」）。所以本页**永远可进** —— 它就是修复入口。

**被拦回来的那一刻就要说明**：状态摘要里的那条轻提示读的是统一导航层记下的 `gateReason`
（不是页面自己拼的文案，也不等用户再点一次「重新检查」）。`gate` 的优先级是
"界面刚点的动作（`running` / `blocked`）> 导航层的 `blocked`" —— 反过来的话，
用户点「重新检查」时会先看到上一轮的拦截说明而不是 loading。

## 7. 交互口径（会反复被问到，先看这里）

| 行为 | 口径 |
|---|---|
| 环境自检 | **一次就够**：面板重新挂载不重跑（切会话/切模块都复用已有结论）；「重新自检」按钮、登录 / 授权成功后的刷新照旧真跑 |
| 换模块 | 返回报告审核时保留已提交的搜索与分页上下文并重新加载；审核状态独立轮询，离开取消旧页请求与定时器 |
| 分页与 OSS | 进入、翻页、搜索提交和刷新先取氚云分页，再一次提交本页合法去重流水号；Host 按目录查询、共享并发 3、整批 90 秒；空页跳过 OSS，不扫描总前缀、不预读 JSON |
| 查询失败 | 保留业务行并明确标记失败；单行重试只查该流水号。查询中或失败时禁用启动与重新审核，停止动作仍可用 |
| 上传完成 | 手动重传或上传时间变化只定向补查仍在当前页的流水号；旧页/旧行查询响应不得覆盖新结论 |
| 刷新 | 保留查询、页码和页大小，不附带环境自检与审核状态刷新；OSS 补齐期间刷新禁用，翻页与新搜索可取消旧轮 |
| 审核信息 | 右侧抽屉，读真实 JSON 对象（精确 key 懒加载，不整文件读） |
| 授权 | 未授权 = 整块面板被弹框挡住（同意 / 拒绝 → 再次授权）；授权一次落盘、长期有效 |
| 门禁 | 自检通过 → 自动进报告审核；不通过 → 停在环境信息并列出阻塞项 |

---

### 6.9 两级目录：一级「业务大类」+ 二级「功能页面」（2026-10-13）

工作台正文顶部最多**两条**页签（都是 `role="tablist"`；审核模块因只有一个一级目录而扁平为一条）。
两条目录**按模块分属**：进入哪个侧栏模块，就只看到那个模块的那棵树。

```text
报告评估（侧栏模块）  一级 [估值]（唯一；资产类型在下拉里选，没有二级条目）
报告审核（侧栏模块）  唯一一级 [审核] 扁平为主行 [报告审核] [本地审核]（不画冗余的「审核」行）
环境信息（侧栏模块）  不在目录树里（外层门禁与修复入口）
```

一级表达业务大类，二级表达**该业务下的功能页面**；页面内容跟着当前选中的页面节点走，
页面标题来自节点元数据（可选：节点声明了 `title` 才画）。结构只有一份来源：
`src/client/shell/navigation.ts`。
模块归属写在元数据的 `module` 字段上，`parentNodes(module)` 读它 —— **不是**在页面里按字符串过滤。

- **评估树里不许出现「审核」**、审核树里也不许出现「估值」：一个模块里出现另一个模块的入口，
  用户看不出自己在哪（用户截图里的重复入口就是这么来的）。
- **没有已配置业务项的一级目录根本不画**：「其他业务」的元数据留着，但底下一个业务项都没有，
  所以它不出现在目录条上 —— 不留"点进去什么都没有"的空占位入口。
- **页面身份变了要归零滚动位置**：内容区外壳是同一个元素（切换时不重建），它的 `scrollTop`
  会原样留到下一页。判据是 `pageIdentityOf()`（纯函数，可断言），动作只有"归零"这一句。

- **两级形态刻意不同**：一级用 44px 命中高度 + 选中项 3px 操作蓝底部强调线（沿用既有报告审核页那套
  `.crwu-audit-tab`）；二级是更轻的浅蓝胶囊（30px，`--crwu-interactive-soft` 底 +
  `--crwu-interactive` 描边 + 加粗），子项多时横向滚动。两级都用大卡片会显得过重，也看不出层级。
  **审核模块是唯一例外**：它只有一个一级目录（审核），再画一行「审核」是冗余的 —— 所以审核树
  **扁平**成一条主行，直接列 `报告审核 / 本地审核`，复用一级那套 `.crwu-audit-tab` / `-on` 形态与
  `aria-label=业务目录`；冗余的一级行不画。内部 group / node id（`audit` / `audit.report` /
  `audit.local`）、`aria-controls`、roving `tabindex` 与默认落点都不变。
- **切换是一次状态更新**：`module-store` 的 `navigateParent()` 在同一处算完"一级 + 二级 + 正文"，
  订阅者只收到一次通知 —— 不允许先改一级、下一帧再改二级（那会闪出不一致的画面）。
  切一级目录**默认选中第一个可用页面**，不记忆上一次的二级页面（用户明确口径）。
- **`enabled: false` 的目录节点**显示为灰态 + 「开发中」小标签，**不可进入**：
  判据在 store 里（`navigateNode` 拒绝），不是只把按钮画灰。一级目录下没有任何可用页面时
  正文说一句「该业务目录暂未开放」，不给空白页。
- **环境信息不是目录里的一页**：它是外层门禁态（环境没过时的统一落点，也是员工自己去看配置的入口），
  不占页签，从它回工作台给一颗「返回工作台」。环境通过后估值 / 审核页面不再展示任何环境信息。
- **滚动容器稳定**：目录条长在滚动容器（`.crwu-audit-tab-panel`）**外面**，所以它始终留在页面顶部；
  内容区是同一个元素、同一个高度，切换目录时**不重建** —— 滚动位置与宽度都不会跳。
- **可访问性**：两级都是标准 Tab 语义 —— `role="tablist"` / `role="tab"` / `aria-selected` /
  roving `tabindex`（当前项 0、其余 -1）、左右方向键循环、Home / End 直达两端，切页签把焦点带到新页签上；
  两级页签的 `aria-controls` 都指向**同一个真实存在**的内容区（`role="tabpanel"`，
  `aria-labelledby` 指回当前页签）。选中态不只用颜色表达：一级靠底部强调线 + 字重，
  二级靠浅色底 + 描边 + 字重。
- **一张纸**：审核那两页（报告审核 / 本地审核）在内容区里共用一张纸（`.crwu-audit-page-paper`），
  纸里那层 `.crwu-audit-surface` 必须撤掉描边 / 圆角 / 阴影（子页面只有一层 Workspace Surface，
  见 §6.0）—— 否则那圈 1px 正好落在内容顶部，看起来像"多了一条横线"。

「本地审核」页内部的视觉口径（协议 28，逐条对应设计 §13/§14/§15）：

- 三块卡片 + 一个主按钮；卡片只用 1px 描边与轻阴影，不新增渐变 / 玻璃拟态 / 插画；
- **独立材料任务的层级**（2026-10-20 修订 2）：左列先给「选择文件 / 文件夹 + 清空」控制，
  再给已选择清单；右列是可选补充提示词与准备/交接状态。宽面板用容器查询分两列，
  窄面板纵向排（控制 → 清单 → 提示词 → 状态 → 启动）。主操作只有底部一枚，
  位于右侧提示词/交接任务列之后；窄面板按同一顺序落在字段之后，禁用原因紧邻它可见。
- 状态用**图标 + 文字 + 颜色**三重表达（`待审核` / `已扫描` / `无法读取` / `已跳过` / `超过数量限制`），
  不许只靠颜色；图标沿用 `ui/icons.tsx` 的 1.6px / `currentColor` 语言（本轮补
  `FolderIcon` / `FileIcon`，不用 emoji）；
- 禁用按钮**旁边**必须给出可理解的原因文字（不是只挂 `title`）；
- 选择/扫描/快照/建会话的状态变化用 `aria-live`；错误紧邻它所属的那块区域；
- 动效只有：loading 旋转、150–200ms 淡入、复制成功的短暂确认；**不做**数字跳动；
  并支持 `prefers-reduced-motion: reduce`（减少动画时保留状态变化与文本反馈）。

### 6.10 房地产估值启动页（协议 37，2026-10-14）

页面结构没变：**门禁 → 单层工作面 → 只读核对抽屉 → 交接父会话 → 跳原生会话**。这一节的
每条口径都对应一次真实缺陷，改这一页之前先读。

**流程状态**

- **创建期间抽屉必须继续显示**：`confirmation` 与 `creating-session` 是**同一个抽屉实例**，
  主按钮原地变「正在创建会话…」。把阶段判断写成"只认 confirmation"会让点击后的原界面消失、
  pending 反馈看不见（UX-01）。创建期间 X / Escape / 遮罩 / 返回修改**四条路一起失效**，
  用状态区说明原因，不弹二次确认。
- **切页恢复要清"这一次页面请求的瞬时状态"**：离开时除了作废在途请求，
  还要把 `checking → idle`、`preparing-confirmation → draft`。只作废请求的话，回来会被
  "已经有一次检查在途"的守卫吃掉，页面永久停在 checking / 永远 pending（UX-05）。
  **交接不清**：`creating-session` 是 Host 的事务，切走不能中断。
- **超时不是"没创建"**：交接回执带了权威判据 `creationDisposition`
  （`not-created` / `created` / `unknown`）。只有 `not-created` 才允许「返回修改」；
  `unknown` 只提供「恢复交接」并复用同一轮 `requestId`。缺字段按 `unknown` 兜（偏安全的一侧）——
  拿"没有 sessionId"当"没建会话"会造出第二个项目目录。
- **失败标题来自结构化事实**，不要写一句覆盖所有情形的"会话还没有创建成功"：
  会话已经建出来时那句话是自相矛盾的（UX-17）。
- **登录任务五种状态各有各的话与动作**（running / waiting-user / succeeded / failed / cancelled）。
  `waiting-user`（凭据到位、等页面验证）**不是** `failed`、也**不是** `running`；
  把未知状态归一成 running 会让界面永远等下去（UX-03）。
- **人机验证有真实入口**：门禁在检测到挑战时给「打开验证窗口」，它走受控 Host 操作
  `valuation-browser-open-verification`（**只提交 `siteId`**，URL 与 profile 由 Host 定）。
  `opened: true` 只说明窗口开了，**不说明验证已经通过**。

**资料范围**

- **资料是可选的（2026-10-20 修订 2）**：只要求已登记的资产类型与 market / income / cost 之一；
  资料、模板、目的、价值类型、基准日、补充要求全空也可以开始，缺失要素由实际节点缺口补填。
  资料一旦显式提供，扫描 / 可读性 / 200 份上限 / 截断这些安全门禁仍然逐条生效。
- 资料区是**两层**：入口行（文件夹可展开）+ 真实文件行。只画一个展开箭头不算做完 ——
  必须能**逐个移除**，并且移除写进 `excluded[]` 让**扫描 / 预览 / 归档共用同一份范围**。
  只过滤 UI 列表就是"假排除"，预览和归档里那份文件会重新出现（UX-08）。
- 移除后的行**仍然看得见**（状态"已从本次范围移除"）并可「重新纳入」；撤销只保留**最近一次**、
  8 秒；移除文件夹要一起清掉只属于它的排除项（否则会留下"幽灵排除"）。
- 扫描时**不清空旧行**：旧事实继续显示并标注"正在重新读取清单"，主按钮临时禁用，
  新结果一次落地（先清空再出现会让列表闪一下）。
- 入口计数用 Host 的**递归去重事实**，不是入口数；枚举被安全上限截断时明确说
  "资料清单未完整读取"并**禁止确认**。

**视觉与可用性**

- **主按钮是实心的**：`--crwu-primary-bg` / `--crwu-primary-text`。只给描边 + 品牌色文字
  等于"唯一 primary"的层级根本没建立（UX-10）。
- **底栏是一条可见的固定带，而且必须"收口"**（2026-10-16 两轮用户口径）：底栏仍是 `flex:none` 的
  footer（不是 fixed / sticky），但它现在**有自己的表面底** `--crwu-surface-subtle` + **通栏** 1px
  `--crwu-border` 顶线 —— 透明底会让这条不随正文滚动的操作栏看起来像正文的最后一段。
  **底色要铺到工作纸自己的左右下三边**：估值页的工作纸因此 `padding: 0`
  （`.crwu-audit-page-paper[data-workbench-page="valuation"]`），内缩由正文与底栏**各自**承担 ——
  纸只要留一点内距，灰带下面就露一条白线（用户原话："下面为啥还有一条白线没收住"）。
  **不许用负外边距去补**：纸的横向内距本来就是 0，负向外扩会把底栏撑到纸外
  （真机实测：底栏比纸宽 24px，并多出 12px 纵向溢出，横向滚动条跟着回来）。
  摘要靠左、动作组靠右；窄面板只让动作组自己换行，**不**把主按钮拉成全宽；正文内缩与底栏内缩同量。
  底色只走 token（明暗两套由 `tokens.ts` 负责），正文滚动区保持透明，两个面必须**看得出不同**。
  `.crwu-valuation-intake-body` 纵向 12px 上 / 24px 下，横向在上方容器查询里收到 16px。
  工作面上限 1120px：纸更宽时底栏居中收窄，两侧留白**对称**。
- **命中区与横向溢出是同一件事**：图标按钮请用 **44×44 的独立按钮槽**（里面 28px 视觉盒），
  普通按钮只做**纵向**外扩。负向 `::after` 横向外扩会真的增加滚动容器的 `scrollWidth` ——
  375px 窄面板实测正文多出 8px 横向滚动（真机复现）。
- **必要说明不能用 tertiary**：估值模块用 `--crwu-valuation-hint-text`（浅深各一份）；tertiary 对白底
  约 2.8:1，承载不了"为什么要这样填"（UX-12）。输入边界不再由估值私有规则画，改由共享
  `ui/styles/field.ts` / `date-picker.ts` / `select.ts` 的 `--crwu-field-border` 统一负责。
- **只读抽屉不要画成 disabled 表单**：首屏是「本轮估值」的**两列键值摘要**（资产类型 / 评估方法 /
  资料份数 / 基准日），**资产类型与方法只认 Host 回包**（`preview.assetType` / `preview.methodRequest`）
  —— 不再由调用方另传一份可能漂移的草稿方法。方法说明**与本次选择相符**（旧文案
  「当前支持住宅市场法 / 收益法、成本法尚未提供完整知识与模板」已随能力口径删除）。
  资料主行紧凑（文件名是主信息、类型/大小是次信息），完整路径 / 创建时间 / 重复说明**按需展开**；
  未指定条件的必要影响**合并成一条**；创建时间标注 **UTC**，补充要求 `pre-wrap` 保留换行（UX-15 / UX-18）。
- **信息获取辅助区可以进抽屉**（2026-10-15 改判）：登录、检查、验证属于**允许的环境操作**，
  抽屉里给出链家状态与适用动作（旧约束"抽屉里一个能力都不许出现"作废）；但它仍然**不是启动门禁**。
- **辅助区是工作纸里的一块轻量内嵌面板**（2026-10-16）：`--crwu-surface-subtle` + 柔和描边 + 圆角，
  不叠阴影、不套第二层卡片。面板头给出**来源名 + 状态徽标 + 动作组**（检查 / 重新检查永远直接可见，
  不先展开详情）；未检查时来源名仍写「链家」、状态写「尚未检查」，不伪装成缺失。
- **详情入口是「状态详情」**（展开后「收起详情」）：`aria-expanded` / `aria-controls` 指向
  `role="region"` 的详情区，**每个挂载点用自己的实例 id**（`useInstanceId`），同页两处不会抢同一个 id；
  收起时详情区带 `hidden`（不在键盘顺序里）。进入只做 opacity + 3px 位移（150ms），**不动画高度**，
  减少动画时立即展开。详细原因 / 检查时刻 / 已结束的登录任务折在这里；running / waiting-user 的
  取消 / 去验证那一行**直接可见**。对外名字统一为「信息获取辅助 · 可选」，说明固定为
  "用于辅助获取公开信息；未登录可继续估值。"；辅助区**不许**把整页 `error` 当成自己的失败。
- **表单展示记忆**：抽屉打开时输入工作面**隐藏但保留在 DOM 里**（不是卸载），
  这样展开状态、查看全部状态、滚动位置与焦点锚点都不丢；「确认」那颗按钮还是同一个元素，
  抽屉退出后把焦点还给它（UX-16）。隐藏要用 `hidden`，并自己兜一条
  `.crwu-valuation [hidden] { display: none }`（作者样式的 `display` 会盖掉 UA 的 `hidden`）。
- **抽屉退出要真的播完**：父层管 `presented` / `closing`，150ms 后卸载，**退出期间继续显示同一份
  内容**（返回修改会清空 `preview`，只按 `preview !== null` 判断会让抽屉在点击那一帧就消失）。
  减少动画模式下立即卸载，不要变成"多等 150ms"。
- **上限不要靠 `maxLength` 静默截断**：超限写进状态并给明确说明、保留已有内容；
  中文输入法 composition 期间不应用上限（不把半个合成串报错）。
- **基准日只接受真实存在的日历日期**：`2026-02-30` 必须被拒绝（`new Date()` 会把它滚到 3 月 2 日）。
- **底栏必须是 footer，不许用 sticky 压内容**（2026-10-14 真机截图复现）：`position: sticky;
  bottom: 0` 会把底栏**拉到自己流入位置之上**，于是它盖住当时视口底部的内容 —— 用户看到的
  是"补充要求的输入框从底栏下面露出来"。改成设计稿 §9.2 的第一方案：工作面是**确定高度的
  flex 列**（`.crwu-valuation { height:100%; min-height:0 }`），中间正文
  `flex:1; min-height:0; overflow:auto`，底栏 `flex:none`。
  两个必须一起做的接线：**挂载容器也要 `flex:1 1 auto; min-height:0`**（少这一层，里面的
  "确定高度列"拿不到高度，底栏又会掉回正文末尾 —— 真机实测 600px 高时跑到 y=915）；
  父层没有确定高度时它退化成 `auto`，底栏落到正文末尾，这是可接受的降级。
  键盘可达目标这时只需要 `scroll-margin-block: 12px` 的呼吸位，不需要给底栏让出高度。
- **底栏左侧只放一行**：可用时是"下一步做什么"，禁用时是"为什么不能点"。两个都写会变成
  同一句话说两遍（空输入时摘要与原因是同义句），纯噪音。
- **禁用的主按钮退回 token 感知的 subdued 中性底**（`--crwu-control` + `opacity:1`），
  不要把实心主按钮整体降透明度 —— 否则一屏最显眼的元素偏偏是点不动的那颗。

## 8. 改完样式怎么验

1. `npm run check`（含 typecheck + 单测 + 构建 + 产物冒烟）；
2. **真机**：`install/browser-check.mjs` 用系统 Edge 跑一遍（几何断言 + 计算样式断言
   —— 例如"等待页那枚 svg 的 `animationName` 不是 none"、"悬停底色与选中底色不同"）；
3. **瞬时加载态用 `page.route` 人为拖慢**再断言，不要用固定等待；
4. **隔离 fixture 的浏览器验收（已入库）**：`tests/browser/unified-ui-fixture.tsx` /
   `tests/browser/valuation-ui-fixture.tsx` 用**真实源码组件 + 假端口**挂载页面，
   `install/ui-browser-check.mjs` 用**外部测试用** React/ReactDOM 与 Playwright 构建、起
   127.0.0.1 临时端口、跑检查并截图：

   ```bash
   node install/ui-browser-check.mjs \
     --react-root <node_modules with react + react-dom> \
     --playwright <node_modules with playwright-core> \
     --browser <browser executable> \
     --out <new output directory>
   ```

   `--out` 必须是一个**尚不存在**的新目录：脚本用 `mkdir(recursive:false)` 创建，
   已存在就明确报错，绝不删除调用方给的任意路径。外部运行时只用于测试，不进产物 / 依赖图；
   fixture 不访问账号、凭据、真实文件或 provider。覆盖范围：共享 Button 变体 / loading 宽度 /
   IconButton 表面、同名 Select 的唯一 id / 键盘 / 禁用、DatePicker 打开焦点 / 日提交 /
   月年视图 / 范围 / 清空非法草稿 / 减少动画立即退出、估值页 2 主题 × 5 宽度的横向溢出与浮层夹取、
   窄面板 16px 字段、主文字与焦点蓝的对比度、只读确认抽屉 / 可选能力 / 返回焦点 / 创建锁定 /
   单次 start。真实 profile 的 live 验收（`install/browser-check.mjs`）仍由 supervisor / 用户在
   独立 profile 上跑，本仓库不代跑。
5. **（可选、未入库）在内存里模拟真实 Host 文件通道**：历史手法是用 Playwright 的 `filechooser`
   造 `File`、临时注入 `window.__DSH_HOST_PATHS__` 假桥，并用 `page.route` 回包扫描 / 预览 /
   预检 / 交接 —— 它能把整条链路在真实浏览器里走完且不碰员工工作区。**入库的
   `install/ui-browser-check.mjs` 用的不是这条通道**，而是 fixture 里的内存假端口；上面这条
   只作为需要在真实 Host 边界上验证时的独立手法。若真的混用，fixture 阶段结束必须**把 App 交还
   回去**（等一级目录真的回到「审核」再交棒），否则后面依赖报告列表的段落会读到"面板还没切完"的那一帧。
6. **每个新断言先证伪一次**（临时注入缺陷 → 确认变红 → 还原）。证伪脚本的还原清单必须覆盖
   **它改过的每一个文件** —— 曾经漏还原一个新建组件，导致真机里等待页少了图形与进度条，
   而单测因为跑在旧源码上仍全绿。
