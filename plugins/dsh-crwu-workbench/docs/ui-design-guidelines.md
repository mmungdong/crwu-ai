# 界面与设计规范（dsh-crwu-workbench）

这份文档回答「**为什么长这样、要改样式该动哪里**」。判据（门禁）在 `plugins/dsh-crwu-workbench/AGENTS.md`，
两者冲突时以那份为准。写代码前按需读；改完把新踩的坑补进来。

---

## 1. 视觉语言：办公 + Apple

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

**报告审核页另有一层工作台色板**（2026-09-23 加入）：`consts.ts` 样式表的**§19「工作台 Design Token」**
是整份样式表里**唯一允许写字面量色值的块**（`--crwu-app-bg` / `--crwu-surface` / `--crwu-hover` /
`--crwu-text-*` / `--crwu-risk-*` / `--crwu-shadow-*` …）。其余任何规则只允许引用 `var(--crwu-*)`
或 `var(--dsw-*)`；单测会**先把 §19 整块剔除**再扫 `#hex` / `rgb(` / `hsl(`。

- **深色不是另写一套选择器**：DSH 把解析后的明暗写到 `body[data-ds-dark-theme]`
  （不管是"跟随系统"还是手动选的深色都会落到这个属性上），所以在 §19 里用
  `body[data-ds-dark-theme] .crwu-audit-root { --crwu-…: … }` 覆盖同名 token 即可 ——
  组件与规则一份都不用改，浅深自动成立。**不要用 `prefers-color-scheme`**：那跟的是操作系统，
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

## 2. 样式怎么交付

包形态是**单文件** `lib/client.js`，没有 CSS 资源加载器：

- 样式文本放在 `src/client/features/workbench/consts.ts` 的 `WORKBENCH_STYLE_TEXT`；
- 由 `styles.ts` 在 Cordis 生命周期里插入
  `<style id="crwu-audit-package-styles" data-plugin="dsh-crwu-workbench">`，寿命由 `ctx.effect` 管；
- **样式文本是模板字符串：注释里也不能出现反引号**。一个反引号会把整段样式截断，
  而且**不报错**（编译期才发现语法错，或者干脆静默少一段）。这条已经踩过两次。

---

## 3. 类名与选择器纪律

1. 类名一律 `crwu-audit-` 前缀（历史前缀 `crwu-wb-` / `crwu-workbench-` 已统一，不要再出现）：
   样式是插件自己往 `document.head` 注入的**全局** `<style>`，前缀就是隔离手段；
2. 类名常量集中在 `WORKBENCH_CLASSES`，组件只引用常量；
3. 有一条单测断言**每个类名常量都有一条 `.<类名>` 规则**，漏写样式会红；
4. `install/browser-check.mjs` 里有硬编码选择器（`.crwu-audit-module`、`td.crwu-audit-td-nowrap` 等），
   **改类名必须同步它**；
5. **组件变体一律用「双类」选择器，不靠书写顺序**：`.crwu-audit-btn.crwu-audit-btn-primary`（(0,2,0)），
   不要写单类 `.crwu-audit-btn-primary`（(0,1,0)）。基础样式 `.crwu-audit-btn` 也是 (0,1,0)，而 §20
   迁移覆盖层在样式表**最后**，于是单类变体会被它的 `background/color` 吃掉（主按钮退化成普通按钮），
   可变体的 `:hover` 特异性更高、反而生效 —— 结果悬停时深底 + 深字，**整个按钮全黑**
   （用户 2026-09-23 报的缺陷）。同理，变体的 hover 要把基础按钮的 `:hover:not(:disabled)` 一起写进
   选择器组；`opacity` 不要写进 hover（那会让禁用的主按钮悬停时看起来可点，禁用态靠 `:disabled` 的
   0.45 表达）。这条由 `tests/unit/client-package.test.mjs` 的「按钮变体一律用双类选择器」盯着。

---

## 4. 布局硬规则（每条对应一次真实故障）

1. **滚动归正文区，不归 root**：
   `.crwu-audit-root { height:100%; min-height:0; overflow:hidden }` +
   `.crwu-audit-body { overflow:auto; min-height:0 }`。DSH 的主内容列是
   `display:flex; overflow:hidden`，它不滚动、把滚动交给面板；少这两条长页面会被裁一半。
   滚动**不能放 root**：头部（标题 + 版本标签 + 问候）必须常驻，root 一滚它就跟着滚出视口。
2. **表格固定布局 + `colgroup` 百分比列宽**（`.crwu-audit-table` + `.crwu-audit-col-*`）：
   `table-layout: auto` 会把多出来的宽度全给最宽那列（实测 1920px 时报告名涨到 696px，
   操作列几乎不动，右侧一直很挤）；表格另设 `min-width`，外面必须套
   `.crwu-audit-table-wrap { overflow-x:auto }`，视口太窄时表内滚动而不是被卡片裁掉。
3. **窄列不换行**：流水号 / 风险 / 时间一律 `white-space:nowrap` 并给 `title`，
   否则会被从中间折断。
4. **浮层用 fixed + 明确层级**：抽屉遮罩 900 / 抽屉 901 / 授权弹框 950。
   遮罩盖住整个视口时，**一次"没关掉"会让后面每个 click 都超时** —— 验收脚本里这是最常见的假失败源。

---

## 5. 侧栏入口：一张分组卡（唯一入口席位）

席位是 `sidebar.footer.action`（左侧栏底部、Settings 上方），**只占一个席位**，内容是插件自绘的一张卡：

```
┌───────────────────────────────────────┐
│ [品牌标记] 中瑞世联工作台  [dev]        │  ← 卡头：纯标题，不可点、无悬停底色
│ ───────────────────────────────────── │
│  ↗ 报告评估            [开发中]        │  ← 三行子项，顺序固定，不按条件重排
│  ☑ 报告审核                            │
│  ⚙ 环境信息                       ●    │  ← 环境结论只画在这一行
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
   绿圆白勾 / 红圆白叹号 / 琥珀圆 + 一段旋转白弧（CSS `::after`）/ 尚未自检 = 空心圈。
   它**只画在「环境信息」那一行**，挂在别的子项后面会被读成"那一行通过了"。
7. **不要再引入背景水印**：试过一版（超大单色 logo + 下面一行「中瑞世联」），
   用户看过之后决定不要。验收脚本反过来钉住 `.crwu-audit-watermark*` 数量必须为 0。
8. **折叠成 56px 轨道时只画品牌标记，不画环境徽标**（用户 2026-09-22：
   「左侧栏收起来的时候不应展示绿色的标记」）。轨道里既没有「环境信息」这行字、也没有卡头，
   一枚常亮的实心绿勾在那里读不出结论，只是噪音。结论不丢 —— 轨道那颗按钮的 `title`
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
  `overflow:hidden` 让圆角真的裁住里面的页签行与表头）。它是"工作台里的一块纸"，
  **不是 Dashboard 大卡**：描边极浅、阴影极轻、半径克制；
- **App 底与纸分得开**：root 底是 `--crwu-app-bg`（浅灰），body 内边距 20×24；
- **框内的分区靠发丝线 + 留白**，卡片自己那层描边 / 阴影 / 圆角在这一层里撤掉
  —— 否则只是把"好多块"往里挪了一层，用户看到的还是"框里套框"；
- **页签是轻量 Segmented Workspace Tabs**：外层是浅槽（`--crwu-tab-track` / padding 3 / 圆角 9），
  选中项是槽里浮起的白片（`--crwu-surface` + `--crwu-shadow-tab` + 600）。**没有下划线指示条、
  也没有"底色 + 下划线"双重选中**（用户 2026-09-23 口径：不要红色 underline）。inactive 悬停
  只加一层 `rgba(255,255,255,.55)`，禁止 hover 出红线 / 大灰块 / 位移；
- **右侧自绘 AI 讨论栏已撤**（用户 2026-09-22：「这里不设计右侧对话框了，去掉吧，只会增加负担」）：
  讨论只由操作列那枚小鲸鱼进入，落到 DSH **原生会话**（见 §6.4）。

**报告审核的两个页签叫「报告列表」/「AI 审核列表」**（用户口径：「这个报告审核下面只有两个 tab，
一个是报告列表，一个是 AI 审核列表」）。`zhCN.tabPending` / `tabResults` 就是这两句文案 ——
验收脚本按这两个名字点页签，改文案要同批改脚本。

**列表的其余硬数字**（改之前先看 `consts.ts` §20）：表头 39px / `--crwu-surface-subtle` / 12px 500；
行 82px + 12px padding + 发丝线；风险 = 6px 圆点 + 字母（无底无描边）；搜索框 400×38 圆角 9、
默认只有填充**没有黑边**、聚焦白底 + `0 0 0 3px var(--crwu-focus-ring)`。

**次级控件只有一套底**（用户 2026-09-23：「操作列的按钮颜色不一致，还有刷新按钮」）：
工具条的**刷新**、操作列的**小鲸鱼**、**•••**、流水号的**复制**图标，全部走同一对 token
`--crwu-control`（静止）/ `--crwu-control-hover`（悬停）/ `--crwu-control-active`（按下或菜单打开），
**一屏里只有主操作是实心**。改其中任何一个都要改另外三个 —— 单测
「次级控件共用同一套中性底」会把不一致直接判红。

两条对应的坑：① 中性底必须和 `--crwu-hover`（行悬停底）**分得开**，否则鼠标移到哪一行，
那一行的次级控件底色就和行底糊在一起（浅色 `#EFF0F2` vs `#F5F6F7`，深色 `#2E2F34` vs `#222326`）；
② 这套 token 是**浅深两套里各写一遍**的（`--crwu-control` 在 `body[data-ds-dark-theme]` 块里被覆盖），
只改浅色那份，深色就会退回旧值。

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
**整块正文只有一页**（`features/workbench/LoadingPane.tsx`），不是"环境信息页的半成品"：

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

### 6.3 空态：报告评估占位页

正文里**只有一枚灰色的圆角「开发中」标签**（14px / padding 8×18 / 圆角 12 / 浅中性底），居中。
不写说明文字、不列计划事项、不配图标（用户口径：「该页面整体写一个开发中就可以了」）；
也不做成"一行灰字飘在空白正中间"（那样"太难看了"）。模块名常驻面板头部，正文不重复。

### 6.4 点小鲸鱼：用 crwu 拉文件 → 气泡问「新建 / 继续」→ 跳原生会话

**右侧自绘对话框已经撤掉**（用户 2026-09-22 改口径：「这里不设计右侧对话框了，去掉吧，只会增加负担」）。
对话本体是 DSH 的**原生会话**，我们只做三件事：拉数据、问一句、切过去。

| 位置 | 内容 |
|---|---|
| 入口 | 操作列里那枚 `.crwu-audit-ai-row-btn`；图标是**用户给的 DeepSeek 官方 SVG**（`viewBox 0 0 23.16 17.04`，填充式 `currentColor`，宽扁比例别拉伸） |
| 悬停文案 | 「与 DeepSeek 讨论报告」——**浮层 Tooltip**（`--crwu-tip-bg` + 白字 + 箭头，渲染在表格之外），不用原生 `title` |
| 拉取中 | **只盖列表数据区**（`.crwu-audit-ai-mask`）：页头 / 页签 / 工具条保持可见，里面是与首屏自检同一枚品牌标记 + 进度条的等待页（用户："crwu 在查询的时候，应该有个中瑞世联的 Loading 页面"） |
| 有绑定会话 | 弹 `.crwu-audit-ai-dialog`：**新建对话 / 继续上次聊天**；点遮罩关掉，不建任何东西 |
| 没有绑定会话 | 直接建新会话 + 注入上下文，然后把主面板切到那条原生会话 |
| 多会话 | 会话名 `报告讨论 · <流水号>`、`… #2`、`… #3`；**前缀匹配要排除 `X-10` 这类**（`报告讨论 · X-1` 是它的前缀，纯 `startsWith` 会认错人） |

**操作列三件套的视觉口径（2026-09-23 重定，取代「三个都实心反色」那版）**：一行只有
**一个主操作 + 小鲸鱼 + 必要时一个 •••**，一屏里只允许**一处实心**：

| 元素 | 几何 | 底色 |
|---|---|---|
| 主操作（AI 审核 / 查看报告） | 32px 高 / padding 0 12 / 圆角 8 / 13px | `--crwu-primary-bg`（浅色 `#1D1D1F` / 深色 `#F2F2F3`，字色自动反转）；hover 更黑 + `translateY(-1px)`；active `scale(.97)` |
| 小鲸鱼 | 32×32 / 圆角 8 | `--crwu-control`，hover `--crwu-control-hover` + `translateY(-1px)`，active `--crwu-control-active` + `scale(.94)` |
| ••• | 32×32 / 圆角 8 | 同小鲸鱼：`--crwu-control` / hover `--crwu-control-hover` / 打开 `--crwu-control-active` |

**「刷新 / 小鲸鱼 / ••• / 复制」是同一族**（都是次级控件），底色逐字相同；差别只在几何与图标。
第一版把它们做成了三种形态（刷新透明 Ghost、小鲸鱼填充 `#F2F3F4`、••• 全透明），用户一眼就指出
「操作列的按钮颜色不一致，还有刷新按钮」—— 现在这条由单测与验收脚本双向盯着。

**AI 审核列表的交付件只讲业务语义**（用户 2026-09-23 口径）：列里显示「N 个交付件」+
两枚轻量 Chip（审核报告 / 审核数据），**不显示 `crwu/audit/.../*.html|json` 这类 OSS 原始路径**；
完整路径只允许出现在「审核信息」抽屉与开发模式里。交付件到 Chip 的映射在
`ReportPane.tsx` 的纯函数 `fileKindsOf` / `resultMenuOf`（有单测，且都证伪过）。

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
（`YYYY-MM-DD HH:mm`）；关闭后不动列表（Tab / 页码 / 搜索 / 滚动位置）。

### 6.6 「AI 审核结果分析会话」（audit_analysis，2026-09-23）

**入口**：AI 审核列表的操作列 = `[查看报告] [DeepSeek SVG] [•••]`。DeepSeek 那枚**复用**
`components/icons.tsx` 的 `DeepSeekIcon` 与操作列同一套 Icon Button（`C.aiRowBtn`，32×32、
圆角 8、`--crwu-control` 底、hover `translateY(-1px)`、active `scale(.94)`），Tooltip 走**同一个**
Floating Layer，文案换成「与 DeepSeek 分析审核结果」（报告列表那枚仍是「与 DeepSeek 讨论报告」）。
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

**版本判定优先级**（`features/report-audit/audit-freshness.ts`，纯函数）：
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
│ 已完成 N/N · 最近检查 … · 最近真实验证 …               │
└───────────────────────────────────────────────────────┘
┌ 配置工作区 ───────────────────────────────────────────┐
│ 1 账号连接     已完成 │ 第 N 步 · <标题>        <状态> │
│ 2 阿里云 OSS   待处理 │ 一句用途说明                    │
│ 3 iFinD        待处理 │ 当前操作表单 / 登录按钮          │
│ 4 工作空间     已完成 │ 验证过程与人话结果               │
└───────────────────────────────────────────────────────┘
[维护者诊断 ▾]
```

四条硬口径：

1. **顶部只有一枚主动作「重新检查」**。就绪时**不**放跳转按钮，只写一句
   「配置已完成。你可以从左侧进入报告审核。」—— 进哪一页由左侧栏的统一导航门禁说了算。
2. **顶部不罗列全部阻塞项**，只给**第一条**明确下一步（左侧步骤导航已经回答了"哪里不对"）；
   `平台` 这类技术指标移入维护者诊断，「最近检查」压成一行辅助文案，
   完成数量与进度合并成一条紧凑摘要（不再有三块指标卡）。
3. **默认停在第一项未完成的步骤；用户手动选过之后，后台刷新不许抢焦点**。
   窄屏（≤860px）改成顶部横向步骤条 + 下方详情，375px 宽度下不得横向滚动。
4. **密钥类输入只提交、不回显**：OSS AK 与 iFinD API-Key 两张表单都在提交后立刻清空本地输入，
   已保存只给掩码 / 「已保存」；Bucket、Endpoint、前缀、验证工具名、数据样本、协议版本、
   凭据文件路径**只在维护者诊断里**出现。

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
| 换模块 | 只切正文，不重新取数；报告审核激活时才轮询状态，离开即清定时器 |
| OSS 列举 | 只在首次进入、显式刷新、上传成功后列举；**切标签 / 翻页 / 本地筛选不重复列举**；按流水号查找也只发一次 |
| 审核信息 | 右侧抽屉，读真实 JSON 对象（精确 key 懒加载，不整文件读） |
| 授权 | 未授权 = 整块面板被弹框挡住（同意 / 拒绝 → 再次授权）；授权一次落盘、长期有效 |
| 门禁 | 自检通过 → 自动进报告审核；不通过 → 停在环境信息并列出阻塞项 |

---

## 8. 改完样式怎么验

1. `npm run check`（含 typecheck + 475 条单测 + 构建 + 产物冒烟）；
2. **真机**：`install/browser-check.mjs` 用系统 Edge 跑一遍（几何断言 + 计算样式断言
   —— 例如"等待页那枚 svg 的 `animationName` 不是 none"、"悬停底色与选中底色不同"）；
3. **瞬时加载态用 `page.route` 人为拖慢**再断言，不要用固定等待；
4. **每个新断言先证伪一次**（临时注入缺陷 → 确认变红 → 还原）。证伪脚本的还原清单必须覆盖
   **它改过的每一个文件** —— 曾经漏还原一个新建组件，导致真机里等待页少了图形与进度条，
   而单测因为跑在旧源码上仍全绿。
