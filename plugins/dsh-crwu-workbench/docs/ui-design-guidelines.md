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

### 6.0 子页面只有一层大圆角框（2026-09-22 用户口径）

用户原话：「除了 header 部分，其他都是 border，我认为都可以用一个圆角的大背景框住，
而不是分为好多块」。这条是**子页面级的布局硬规则**，改任何一页先照它来：

- **头部留在框外**：品牌 + 版本标签 + 问候仍是 DSH 面板头（§6.1），正文才开始是框。
- **正文只有一层框**：`.crwu-audit-surface`（圆角 16 / 1px `border-l1` / `bg-layer-1` /
  `overflow:hidden` 让圆角真的裁住里面的页签行与表头）；
- **框内的分区靠发丝线 + 留白**，卡片自己那层描边 / 阴影 / 圆角在这一层里撤掉
  （`.crwu-audit-surface .crwu-audit-pane-main .crwu-audit-card { border:none; box-shadow:none; border-radius:0 }`）
  —— 否则只是把"好多块"往里挪了一层，用户看到的还是"框里套框"；
- **页签是下划线式**（选中 = 2px 品牌色下划线 + 加粗），不再是带底色的胶囊：胶囊本身就是
  一块带描边的小块；
- **报告审核页 = 左数据 + 右 AI 讨论**（`.crwu-audit-pane-body` / `-pane-main` / `.crwu-audit-ai-panel`，
  右栏 `flex: 0 0 30%` + min/max 兜底，可收起成 34px 窄条）。左右之间只用一条发丝线，不给右栏再套卡。

**报告审核的两个页签叫「报告列表」/「AI 审核列表」**（用户口径：「这个报告审核下面只有两个 tab，
一个是报告列表，一个是 AI 审核列表」）。`zhCN.tabPending` / `tabResults` 就是这两句文案 ——
验收脚本按这两个名字点页签，改文案要同批改脚本。

### 6.1 头部

`[品牌标记] 中瑞世联工作台 [dev/版本标签] ………………………………… 晚上好，某某某`

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
| 入口 | 操作列**最后面**那一枚 `.crwu-audit-ai-row-btn`；图标是**用户给的 DeepSeek 官方 SVG**（`viewBox 0 0 23.16 17.04`，填充式 `currentColor`，宽扁比例别拉伸） |
| 悬停文案 | 「与Deepseek一起讨论这份报告」（用户原话） |
| 拉取中 | **整块正文**盖一层 `.crwu-audit-ai-mask`，里面是与首屏自检同一枚品牌标记 + 进度条的等待页（用户："crwu 在查询的时候，应该有个中瑞世联的 Loading 页面"） |
| 有绑定会话 | 贴点击处弹 `.crwu-audit-ai-ask` 气泡（位置由 `askPosition` 夹在视口内）：**新建对话 / 继续上次聊天**；点遮罩关掉，不建任何东西 |
| 没有绑定会话 | 直接建新会话 + 注入上下文，然后把主面板切到那条原生会话 |
| 多会话 | 会话名 `报告讨论 · <流水号>`、`… #2`、`… #3`；**前缀匹配要排除 `X-10` 这类**（`报告讨论 · X-1` 是它的前缀，纯 `startsWith` 会认错人） |

**操作列三件套的视觉口径**（用户 2026-09-23：「更多操作的三个点也需要改下颜色适配，和前面的 AI 审核一样，
按钮的背景色什么的，这样看起来很清楚」）：**主操作、小鲸鱼、••• 走同一套实心反色** —— 背景
`var(--crwu-text-1)`、字形/字 `var(--crwu-surface-1)`（深浅主题自动对调）、悬停同一个
`color-mix(... 86%, transparent)`、都 28px 高、圆角 8px。••• **不在样式里另写颜色**，而是在组件上挂
`C.btn + C.btnPrimary`（见 `ReportPane.tsx` 操作列），`.crwu-audit-menu` 只留几何与「菜单开着」的品牌色内环
`box-shadow: inset 0 0 0 2px var(--crwu-brand)` —— 同一组颜色写两遍必然不同步，而浅底选中态在实心按钮上
根本看不出来（原来那个 `surface-selected` 打开态就是这么失效的）。

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
