# 交接文档 · dsh-crwu-workbench 报告审核页重构（0.0.4）

> 给**下一轮对话**的 agent 读。先读 `AGENTS.md`（门禁口径）与 `docs/` 三份（为什么、怎么验），
> 再读这份 —— 它只写「现在到哪了、哪些还没验、下一步做什么、别踩哪些坑」。
> 这份文件**不进 npm 包**（`package.json.files` 是显式清单）。

## 1. 一句话现状

报告审核页的 UI/UX 重构（Apple-dark / Enterprise / Graphite / Calm 口径）**已完成并提交**
（`a305628`，分支 `feat/reactor_crwu_wb`，**未 push、未发版**），门禁全绿（496/496），
但有两处**用户尚未当面确认**、一处**浏览器验收尚未完整跑通**，见 §4/§5。

## 2. 环境与位置

| 事实 | 值 |
| --- | --- |
| 仓库 | `/Users/mungdong/code/github/mungdong/crwu-ai` |
| 插件 | `plugins/dsh-crwu-workbench`（源码 `src/`，产物 `lib/`，tsdown 打包） |
| 版本 | `0.0.4`（`package.json` / `VERSION` / `CHANGELOG.md` 三处一致，`npm run check` 里的 `version:check` 盯着） |
| 用户的实例 | `web` profile，`http://127.0.0.1:3080`（**重启由用户自己做** —— agent 跑在这个进程里，重启会把自己打断） |
| 开发安装 | 该 profile 已是 `link:` 指向本仓 → `npm run build` 之后**宿主改动需用户重启**、**纯客户端改动刷新页面即可** |
| 状态文件 | `~/.dsh/crwu-workbench.json`（**用户的真实数据**；动它之前先 `cp` 到 `/tmp`，见 §7） |
| 主题设置 | `~/.dsh/settings.yaml` 的 `ui-theme.preference`（当前 `light`，**全局共享**，改它会影响用户，见 §7 坑 2） |
| 一次性 profile | `~/.dsh/profiles/` 下 `smoke` / `smoke-u` / `smoke-w2` 是本轮自测留下的（可复用，也可 `rm -rf` 清掉） |
| 浏览器验收依赖 | `playwright-core` 装在 `/tmp/pw`（`/tmp` 会被清理，没了就 `cd /tmp/pw && npm i playwright-core`），用系统 Edge，不下载 Chromium |

**客户端 vs 宿主的指纹**：`ping` 回 `rev`（跟版本走）与 `builtAt`（产物被加载那一刻的 mtime）。
面板头部版本徽章的 `title` 里也有。**界面是新的、行为是旧的** 几乎都是宿主没重启。

## 3. 本轮做完了什么（都已提交）

1. **页面骨架**：报告审核页 = 一层大圆角框 + 页面头（刷新按钮与搜索框同高）+ 文字型 Tab（2px 品牌色
   滑动指示条）+ 搜索（Enter 触发、× 清空）+ 现代列表（发丝分隔、风险 = 6px 圆点 + 字母）+ 分页
   （页码窗口 `[1,0,123,…]` + 跳转 clamp）。撤掉右侧自绘对话框。
2. **操作列收敛**：`1 主操作 + 🐋 + •••`，状态噪音（已出结果/已上云/未查看会话/启动时间）全删；
   有结果就不再出现「AI 审核」（重新审核优先级更高）；行内「重新审核」是**一次点击展开确认**
   （第一下只置 `confirming`，不派发）。
3. **鲸鱼会话流**：新增 Host 操作 `report-files`（第 26 个，`crwu h3yun files list --schema … --id …`
   + 本地案例目录 + `ossIndex`，**只列举不下载**）+ 客户端门面 `reportFiles`；新增
   `assistant-context.ts` / `assistant-session.ts`（讨论会话命名 `报告讨论 · <流水号> #N`、查找、
   注入上下文、开新会话）。有绑定会话 → 气泡问「新建对话 / 继续上次聊天」；没有 → 直接建并切过去。
4. **主题跟随**（用户明确说这是 bug 修复）：`consts.ts` 的 §19 token 层 + §20 迁移覆盖层，
   结构色全部走 `--dsw-alias-*`，只有品牌红/风险色/阴影是固定十六进制；横向 + 纵向滚动条一并美化。
5. **浮层统一 Floating Layer**：Tooltip 与 ••• 菜单渲染在**面板大框之外**（`position: fixed` + rect 计算），
   不再被表格滚动容器与 `backdrop-filter` 的包含块裁掉；单个 `openMenu` 保证只开一个。
6. **两个 bug 修复**（都在 §7 坑表里）：
   - 悬停主按钮**整个全黑**：基础 `.crwu-audit-btn` 与单类变体同为 (0,1,0)，而 §20 迁移层写在样式表最后
     → 变体底色被吃掉、变体那条 `:hover` 反而生效。**变体一律双类**（`.crwu-audit-btn.crwu-audit-btn-primary`）。
   - ••• 统一为实心反色（组件挂 `C.btn + C.btnPrimary`），32px → 28px 与行内按钮齐平；
     菜单打开态改为品牌色内环。
7. **文档**：`docs/ui-design-guidelines.md`（选择器纪律 §3.5 + 操作列三件套口径 §6.4）、
   `docs/development-notes.md` 坑速查 +3 条、`CHANGELOG.md` 0.0.4、`docs/PRD-workbench-sidebar-modules.md`。

## 4. 已验证 / 未验证（**最重要的一节，别把未验证当已验证**）

**已验证（真机浏览器 + 计算样式，浅色与深色各一次）**

- 主操作按钮：浅色 IDLE `bg rgb(15,17,21)` / 白字，HOVER `color(srgb …/0.86)` / 白字；
  深色 IDLE `bg rgb(249,250,251)` / `rgb(35,35,36)`；禁用态悬停保持 `opacity .45`；零控制台报错。
- ••• ：`bg` 与主操作**逐字相同**、28×28，hover 同一个 86% 浓度，菜单打开时内环 `rgb(216,74,74)`。
- 行内确认键：琥珀 `#D6A348` 字 + 描边，与旁边的「取消」（中性）区分开；点「取消」回到主操作、不派发。
  顺带确认：它原来和「取消」长得一模一样（也被 §20 那条基础规则吃掉了），本轮一并修好。
- 门禁：`npm run check` 496/496、`npm run pack:assert` 173 文件、`git diff --check` 干净。
- 新增断言**都证伪过一次**（「按钮变体必须双类」「••• 必须与主操作共用变体」不满足即红）。

**未验证 / 需用户确认（下轮优先处理）**

1. **用户还没在 3080 上回报**主按钮悬停与 ••• 的效果（我让他刷新后确认，他直接让我提交了）。
   → 下轮先问这两条，别默认通过。
2. **`install/browser-check.mjs` 的浮层阶段从没完整跑通过**（本轮只做了定点探针，没跑整脚本）。
   该阶段（`phase('浮层：Tooltip 与 ••• 菜单')`，约 363–470 行）是**本轮新写的**，已带自足前置
   （清掉上一段留下的浮层/Dialog、确保站在报告列表上）+ 「没有带次级动作的行就跳过」的兜底，
   但**需要真的跑一次**：`node install/browser-check.mjs --url 'http://127.0.0.1:3083/?token=…'
   --playwright /tmp/pw/node_modules --out /tmp/pw/shots`。
3. **一条数据相关的验收已知 FAIL**：`install/browser-check.mjs:911`
   `存在可点开的「审核信息」入口`（当前没有"已完成并上云"的记录）。是数据条件，不是代码缺陷；
   要么等有数据，要么把断言改成条件式并说明。
4. **两处待用户拍板的判断**（我做了选择并已告知，他还没回）：
   - ••• 尺寸 32px → **28px**（与小鲸鱼/行内按钮齐平）；
   - 「确认重新审核」恢复了琥珀警示色（原来是中性，因为它同样被 §20 吃掉）。
5. **环境信息 / 报告评估两个页面的 token 迁移没有逐屏复看**（§19/§20 覆盖面较大，值得补截图）。

## 5. 下一步待办（按优先级）

1. 问用户 §4 的 1、4 两条；若要改回 32px，只动 `.crwu-audit-menu` 的 `width/height`。
2. 跑一次完整 `browser-check.mjs`，修掉浮层阶段暴露出来的问题（这才是它的第一次真跑）。
3. 处理 §4.3 那条数据相关 FAIL。
4. 补 §4.5 的两屏截图；顺手核对 `docs/ui-design-guidelines.md` 里 §19 token 白名单与实际用到的 `--dsw-*` 一致。
5. 用户明确说「测试没问题」→ 跑门禁 → 列改动 → 等他审代码；说「可以」→ `git commit`（**不 push**）。
6. 用户明确说「推送 / 发版」→ 才 `git push`、打 `plugin-v0.0.4` tag（§8.3）、`make plugin-dist`（§8.3.1：
   同版本对象不可覆盖，远端已有同版本且内容不同会**拒绝上传**）。**当前 0.0.4 未发版。**

## 6. 硬规则速查（改动前后都看一眼）

- **样式文本是模板字符串，注释里也不能出现反引号** —— 一个反引号就静默截断整段样式（本题本轮又踩过一次，
  症状是 `error TS1005`，因为模板被截断）。
- **类名一律 `crwu-audit-` 前缀**；类名常量集中在 `consts.ts` 的 `WORKBENCH_CLASSES`，
  有一条测试断言「每个常量都有一条 `.<类名>` 规则」；`install/browser-check.mjs` 里有硬编码选择器，改类名要同步。
- **变体一律双类**（`(0,2,0)`），别依赖书写顺序；**§20 迁移覆盖层必须留在样式表最后**，且它只允许
  把结构色映射到 `--crwu-*`，不要再写会压过变体的基础样式。
- **颜色只能来自 DSH 主题变量**（§19 白名单）；`#hex`/`rgb(`/`hsl(` 只允许出现在 §19 token 块里，
  有测试扫描（豁免范围就是 §19 那一段）。**未定义的 `var()` 会让整条声明失效且控制台不报错。**
- **客户端产物只能 `require('react')` 与 `react/jsx-runtime`** → **没有 `createPortal`**，浮层要用
  `position: fixed` + rect 自己算。`main` 槽位只有保留键 `conversation` 有会话绑定。
- **会话事件是信封**：`{type, seq, time, data:{…}}`，字段在 `data` 里；事件窗口只对**当前会话**打开，
  绑定与历史是异步就绪的（`open(id)` + 1.2s 轮询 + 引用比较）。
- **不要 `git checkout -- <path>`**：本仓长期大量未提交，那会直接退回 HEAD 丢成果（历史上丢过）。
  改造前 `cp` 到 `/tmp`，还原也用 `cp`。
- **两道人工关卡不许跳过**：用户测 → 用户审代码 → 才提交；未经明确说，**不 push、不发版**。
- 跑门禁：`cd plugins/dsh-crwu-workbench && npm run check && npm run pack:assert && git diff --check`。

## 7. 验证手法与三个已踩的坑

**① 想分辨"色值不对"还是"规则没生效"，用 CSSOM 而不是 `getComputedStyle`**（`getComputedStyle`
只给结果，看不出谁赢了）：

```js
// 在页面里遍历所有样式表，按顺序打印命中该元素的所有 background/color 声明
for (const sh of document.styleSheets) for (const r of sh.cssRules) {
  if (!r.selectorText) continue
  for (const sel of r.selectorText.split(',')) {
    if (n.matches(sel.trim())) console.log(sel, r.style.background, r.style.color)
  }
}
```

**② 探针必须挂进**真实面板节点内部**（坑：token 作用域）**：`--crwu-*` 定义在面板子树里，把探针
`appendChild` 到 `document.body` 会让每个 `var()` 都失效 → 量出来全是 `rgba(0,0,0,0)` + 继承色
（几何类声明照旧生效，看起来像"样式没加载"）。挂到
`.crwu-audit-td-action .crwu-audit-row-actions` 里，要浮角落再加 `position: fixed`；并且**把邻近的
真实按钮一起读**，能立刻发现"三个按钮全透明"这种整体失效。

**③ 验另一套主题要小心设置文件被回写**：改 `~/.dsh/settings.yaml` 的 `ui-theme.preference` 后，
渲染是每次请求读的（**不用重启**），但**正在跑的 profile 进程退出/写回时会把内存里的偏好写回文件**。
所以：改之前 `cp ~/.dsh/settings.yaml /tmp/settings.yaml.bak` → 改 → 量 → `cp` 还原 →
**停掉相关实例** → 再 `diff` 复核一次（本轮就被回写过两次，最后是停实例 + 还原 + `diff` 逐字核对）。

**浏览器验收的用法**（§7.7）：`node install/browser-check.mjs --url '<URL>' --playwright
/tmp/pw/node_modules --out /tmp/pw/shots`；等真实后端的断言一律 `waitForFunction` 条件等待，
不要 `waitForTimeout`；撤 `page.route` 要等被拖慢的那次请求先回来（否则 `Route is already handled`）。
脚本**不点「AI 审核」**，也不要改成会点。

**一次性 profile**（不想占用户 3080）：`dsh plugin --profile smoke-w2 add .` 之后
`DSH_PERMISSION_MODE=danger-full-access dsh --profile smoke-w2 --port 3083 --no-open`
（受限沙箱在 macOS 上会被 DSH 拒绝执行，插件每个 shell 调用都会失败）。
注意：这类 profile 没过环境门禁时，操作列按钮是**禁用态**（`opacity .45`），
要量"启用态"的观感得挑一个启用行，或在页面内临时去掉 `disabled` 属性（**纯视觉，别真的点**）。

## 8. 关键文件地图

| 文件 | 作用 |
| --- | --- |
| `src/client/features/workbench/consts.ts` | `WORKBENCH_CLASSES`（~200 键）+ `WORKBENCH_STYLE_TEXT`（§0–§15 来自 HEAD，§16–§18 本轮重写，**§19 token 层**，**§20 迁移覆盖层必须最后**） |
| `src/client/features/report-audit/ReportPane.tsx` | 报告审核页主体：页头/搜索/Tab 指示条/列表/分页/浮层状态（`openMenu`、`tip`）/行内确认/遮罩/Dialog/`auditsReady` 门禁 |
| `src/client/features/report-audit/row.ts` | `deriveRowView` / `primaryActionOf` / `menuActionsOf` / `restartButton` / `riskBadge`：一行的按钮与徽标都由这里派生（纯函数、有单测） |
| `src/client/features/report-audit/assistant-context.ts` / `assistant-session.ts` | 讨论会话的命名、查找（`findDiscussions` 要排除 `X-1` 命中 `X-10`）、prompt 注入、`ensureDiscussion` / `askDiscussion` |
| `src/host/report/files.ts` | Host 操作 `report-files`：氚云附件（`crwu h3yun files list`）+ 本地案例目录 + `ossIndex`，只列举不下载；导出 `parseH3yunFiles`（样本见 `tests/unit/host-report-files.test.mjs`） |
| `src/host/ops/core.ts` | 操作表（26 个）+ `boot.ported.done`；**加操作要同步 `tests/unit/host-package.test.mjs` 的冻结清单与数量注释** |
| `src/client/features/workbench/WorkbenchPanel.tsx` | 面板壳：`auditsReady` 状态、把 `port`/`workspace` 下发给子页、`ReportEvalPane` 的 Coming Soon |
| `src/client/features/workbench/LoadingPane.tsx` | `WorkbenchLoading({title,hint,size})`：整块等待页（中瑞世联 logo + 进度条） |
| `tests/unit/client-package.test.mjs` | 客户端半的主力（~101 条）：槽位注册、样式规则文本、列表/操作列/浮层、`auditsReady` 一致性 |
| `install/browser-check.mjs` | 真机浏览器验收（~165 条断言），含本轮新写的**浮层阶段**（§4.2 待跑） |
| `docs/ui-design-guidelines.md` / `docs/development-notes.md` / `docs/PRD-workbench-sidebar-modules.md` | 维护者读物：视觉与选择器纪律 / 生命周期与坑速查 / 侧栏与面板壳的返工记录。**新坑写回这里，别只留在对话里** |

## 9. 快速冷启动（下轮开工三步）

```bash
cd /Users/mungdong/code/github/mungdong/crwu-ai/plugins/dsh-crwu-workbench
git log --oneline -3          # 确认 a305628 在，工作树干净
npm run check                 # 496/496 起手基线（含 build + smoke:built）
# 需要真机时：起一个一次性 profile（见 §7），或让用户重启 3080 后刷新页面
```
