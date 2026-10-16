# 0.0.46 验收矩阵：估值面板视觉与交互重构

> [!NOTE]
> **状态：验收记录（插件 0.0.46）。** 本文承接
> [`acceptance-0.0.45.md`](acceptance-0.0.45.md)，只列**这一轮新增或改判**的验收点，每条都对应到
> "删掉它，错的东西就能通过"的那一处强制点。0.0.45 里被这一轮改判的行已按仓库口径标
> `⟪面板重构改判作废⟫`，原文保留不改写。
> 现行入口见 [`README.md`](../README.md) 与 [`development-notes.md`](development-notes.md)。

## 怎么读这张表

- **强制点**是"删掉它，错的东西就能通过"的那一处，用 `「…」` 引用**断言原话**；
  守卫 `tests/unit/host/host-acceptance-matrix.test.mjs` 会把每句原话拿回测试源码里找一遍。
- 表里只列**可自动核**的部分；需要真机 / 真网络 / 人工的，在最后一节单独列，不写成"已满足"。
- 行首带 `⟪…⟫` 标记的行是**历史记录**，守卫只对**未标记**的行要求"引用的断言原话逐字存在"。

## 1. 两个必填项：状态、预览与交接（设计稿 §2）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 新草稿里资产类型与评估方法**都未选择**（`auto` 不是默认值） | `tests/unit/client/client-valuation-required.test.mjs`「新草稿：资产类型与评估方法**都未选择**（自动判定不是默认值）」 | "没选"与"选了自动判定"在状态里长得一模一样，必填校验恒真、空值被静默显示成"自动判定" |
| 空串与未知枚举都不是有效方法 | `tests/unit/client/client-valuation-required.test.mjs`「setMethod：四项通过、空串清回未选、未知枚举与大小写变体被拒」 | 一个不存在的枚举一路走到 Host 才被拒；界面把未知值回退成"自动判定" |
| 开始新一轮把两个必填项一起清回未选择 | `tests/unit/client/client-valuation-required.test.mjs`「开始新一轮：两个必填项一起清回未选择，保留最近会话入口」 | 上一轮的资产类型与方法被带进新一轮，员工以为已经选过了 |
| 完整性：`ok:true` 但缺/非法资产类型或方法 → 可恢复错误 + 留在草稿 | `tests/unit/client/client-valuation-required.test.mjs`「prepareReady：`ok:true` 但缺资产类型 / 方法 → 可恢复错误 + 留在草稿（输入一字不动）」 | 残缺回包被当成一次可信的核对结果，抽屉显示的条件与被冻结的输入不是同一份 |
| 一致性：回显与本次提交不同 → 可恢复错误 + 留在草稿 | `tests/unit/client/client-valuation-required.test.mjs`「prepareReady：完整且与本次提交一致的回包才进确认，方法/资产类型取自 Host 回包」 | 沿用草稿里的旧方法冒充本次 Host 确认结论 |
| 空方法根本发不出准备请求 | `tests/unit/client/client-valuation-required.test.mjs`「controller：空方法根本发不出准备请求（禁用判据与提交判据是同一处）」 | 禁用判据与提交判据分家，界面拦住了但请求还是发出去了 |
| 抽屉的资产类型与方法只认 Host 回包 | `tests/unit/client/client-valuation-required.test.mjs`「抽屉的资产类型与方法只认 Host 回包（组件不再接收草稿方法）」 | 抽屉另接一份可能漂移的草稿方法，核对回显与本次提交对不上 |
| 必填项顺序：资料区之后、所有可选条件与辅助能力之前 | `tests/unit/client/client-valuation-pane.test.mjs`「输入页：两个必填项紧跟资料区，用同一种单选下拉（四项可选 + 轻量推荐 + 必填标记）」 | 长文件清单把必填项推到大量重复元信息后面，员工找不到该填什么 |

## 2. 必填项的可见性与错误呈现（设计稿 §2）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 初次进入不显示字段红字；失焦或清空已填值之后才出现短错误 | `tests/unit/client/client-valuation-pane.test.mjs`「输入页：初次进入不显示字段红字；失焦或清空已填值之后才有短错误」 | 一进页面满屏红字；或者反过来，永远不告诉员工哪个字段是空的 |
| 底栏的禁用原因与字段顺序一致（先资产类型，再评估方法） | `tests/unit/client/client-valuation-pane.test.mjs`「输入页：底栏显示的必填原因与字段顺序一致（先资产类型，再评估方法）」 | 两个必填项都没选时先说第二条，员工改完一处还是点不动 |
| 两个必填项的标签与控件**真的关联**（`aria-labelledby` 指向存在的元素） | `tests/unit/client/client-valuation-pane.test.mjs`「输入页：两个必填项紧跟资料区，用同一种单选下拉（四项可选 + 轻量推荐 + 必填标记）」 | 控件没有可访问名称，读屏只念出一个"下拉" |

## 3. 统一单选下拉（设计稿 §4）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| select-only combobox + listbox/option 语义（不是 menu/menuitem） | `tests/unit/client/client-valuation-select.test.mjs`「展开后：listbox + option 语义、当前选中用 aria-selected、活动项用 aria-activedescendant」 | 读屏把"选一个值"念成"打开菜单"，`aria-expanded` / `aria-activedescendant` 全丢 |
| 键盘：方向键移动、Home/End 首尾、Enter 确定、Escape 关闭保留原值、Tab 放行 | `tests/unit/client/client-valuation-select.test.mjs`「键盘：方向键移动活动项、Enter 确定、Escape 关闭并保留原值、Tab 关闭且不拦截」 | Escape 顺手把已选值清掉；Tab 被拦下来，焦点出不去表单 |
| 浮层定位：下方优先、贴底翻转、靠右夹取、限高滚动 | `tests/unit/client/client-valuation-select.test.mjs`「浮层几何：贴底时翻到上方（上方更宽裕才翻）」 | 靠底 / 靠右展开时被裁切，选项点不到 |
| 落点不靠猜：自校准偏移 + 只认真正的固定定位包含块 | `tests/unit/client/client-valuation-select.test.mjs`「包含块探测：认 transform / backdrop-filter / contain，但**不认** container-type」 | 把 `container-type` 当成包含块会让浮层整体偏移一个工作面原点（真机实测：贴右下的下拉跑到资料区左上角） |
| 同时只开一个下拉 | `tests/unit/client/client-valuation-select.test.mjs`「同时只开一个：后开的先关掉前一个；释放只清掉自己」 | 两个浮层叠在一起，点哪一个都像点错 |
| 关闭先播淡出再卸载；减少动画立即完成 | `tests/unit/client/client-valuation-select.test.mjs`「关闭：先播淡出（-out）再卸载；减少动画时立即卸载，且不多等一帧」 | 关的一瞬间就卸载（动画根本不播）；减少动画时反而多等一帧 |
| 监听与计时器在展开 / 卸载之间可释放 | `tests/unit/client/client-valuation-select.test.mjs`「展开期间挂上外部点击 / Escape / scroll / resize 监听，卸载时逐条摘掉」 | 切模块后仍然留着全局监听与计时器 |

## 4. 文件区与折叠（设计稿 §5）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 文件夹展开 / 收起是真的（收起后子列表不渲染） | `tests/unit/client/client-valuation-required.test.mjs`「文件夹展开 / 收起是真的：收起后子列表不渲染，aria-expanded 与实际一致」 | 有文件的目录一直展开，箭头点了没用；被收起的后代仍在键盘顺序里 |
| 资料区在两个必填项之前，必填项在补充条件与辅助区之前 | `tests/unit/client/client-valuation-required.test.mjs`「资料区在两个必填项之前；两个必填项在补充条件与辅助区之前」 | 页面顺序退回到"可选条件先、必填项埋在中段" |

## 5. 信息获取辅助（设计稿 §6）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 对外名字统一为「信息获取辅助」+ 轻标「可选」+ 固定说明 | `tests/unit/client/client-valuation-required.test.mjs`「信息获取辅助：对外名字统一、说明始终可见、辅助区错误不再借用整页 error」 | 它又被叫回"案例来源 / 必需能力"，员工以为不登录就不能估值 |
| 摘要行始终在、未登录时说明降级平台 | `tests/unit/client/client-valuation-required.test.mjs`「信息获取辅助：对外名字统一、说明始终可见、辅助区错误不再借用整页 error」 | 唯一的登录入口藏进折叠层；降级平台的事实消失 |
| 未登录 / unknown / 被挑战三种处置仍然分开 | `tests/unit/client/client-valuation-handoff.test.mjs`「能力区：被人机验证挡住时给"完成验证"的处置，且不给登录入口」 | 把网络问题说成"没登录"，员工反复重登一个没坏的账号 |
| 未登录也能填完并启动 | `tests/unit/client/client-valuation-handoff.test.mjs`「未登录也能填完并启动；来源状态只在能力区如实展示」 | 一个未登录的来源把整页锁死 |
| 辅助区的失败只归它自己（不重复整页 error） | `tests/unit/client/client-valuation-required.test.mjs`「信息获取辅助：对外名字统一、说明始终可见、辅助区错误不再借用整页 error」 | 文件校验错误在链家区再出现一次，员工去查一个没坏的东西 |

## 6. 确认抽屉与交接（设计稿 §7–§8）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 首屏是四个关键事实的只读摘要（资产类型 / 方法 / 份数 / 基准日） | `tests/unit/client/client-valuation-scope.test.mjs`「UX-15 抽屉用只读键值摘要，不再画一排 disabled radio；方法说明与本次选择相符」 | 三十份文件把方法与日期推到底部；又一排 disabled radio 让人以为这是个不能用的表单 |
| 方法说明与本次选择相符（旧的能力限制文案不许回来） | `tests/unit/client/client-valuation-handoff.test.mjs`「抽屉里的方法改成只读键值摘要（UX-15）：范围说明仍在、基准日未指定要写明、补充要求 4000 上限」 | 抽屉里写着"当前支持住宅市场法"这类与用户选择无关的旧事实 |
| 创建期间辅助区不再发起新的登录 / 检查 | `install/browser-check.mjs`（隔离 fixture 阶段「创建期间辅助区不再发起新的登录 / 检查（冻结的是"新发起"）」） | 创建途中顺手点一下登录，让"正在按什么输入创建"说不清 |
| 创建期间同一抽屉 + 主按钮 pending，四条关闭路径一起失效 | `tests/unit/client/client-valuation-scope.test.mjs`「UX-01 创建期间仍渲染同一个只读抽屉，主按钮 pending（原操作界面不许消失）」 | 点下「开始估值」的一瞬间操作界面消失，员工不知道发生了什么 |
| 抽屉退出先播 150ms 动画再卸载 | `tests/unit/client/client-valuation-scope.test.mjs`「UX-16 抽屉退出先播 150ms 动画再卸载（切回草稿那一刻不会立刻消失）」 | 退出动画永远不播（父层直接换树） |
| 复制路径的短反馈约 1.5 秒后恢复，卸载时清计时器 | `tests/unit/client/client-valuation-required.test.mjs`「复制路径：成功反馈约 1.5 秒后恢复；卸载时清掉计时器」 | 复制成功提示永远挂着；卸载后计时器还在写已卸载组件的状态 |
| 复制路径的短反馈会恢复、卸载时清计时器 | `tests/unit/client/client-valuation-required.test.mjs`「复制路径：成功反馈约 1.5 秒后恢复；卸载时清掉计时器」 | 复制成功提示永远挂着；卸载后计时器还在写已卸载组件的状态 |

## 7. 视觉与工作纸（设计稿 §3）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 必填输入用可识别的语义边界，不拿发丝线当控件边界 | `tests/unit/client/client-valuation-scope.test.mjs`「UX-12 必要说明与输入边界用可读的语义 token（不再拿 tertiary 承载操作信息）」 | 浅色下看不出哪里能填，深色下退回旧值 |
| 命中区：移除按钮 44×44 槽、文件夹标题区 44px、按钮组只纵向扩 | `tests/unit/client/client-valuation-scope.test.mjs`「UX-11 命中区：文件移除 44px 按钮槽、文件夹标题区 44px、按钮组纵向外扩到 44px」 | 点不到小图标；或者横向外扩把窄面板顶出横向滚动条 |
| `hidden` 隐藏的元素必须有作者兜底规则 | `tests/unit/client/client-valuation-scope.test.mjs`「UX-16 抽屉打开时输入工作面隐藏但**保留在 DOM 里**（表单展示记忆）」 | 作者样式的 `display` 盖掉 UA 的 `hidden`，被隐藏的表单仍然可见可点 |
| 类名常量与组件 / 样式里的字面量一致 | `tests/unit/client/client-valuation-pane.test.mjs`「类名常量与组件里用的字面量一致（改名字必须一起改）」 | 改类名只改一处，样式或真机脚本静默失联 |

## 8. 需要真机 / 真网络 / 人工的部分

- **面板宽度与主题的几何验收**：`install/browser-check.mjs` 的估值阶段要在真实面板上量
  "无意外横向滚动、必填两项同高对齐、窄面板堆叠、下拉浮层完全可见、抽屉底部可达"。
  本机没有装插件的 profile 时这一段查不了，**不得记成"已通过"**。
- **改前 / 改后对照截图**：375 / 500 / 768 / 1024 / 1440px × 浅色 / 深色，另有约 600px 短高度的抽屉。
  截图必须使用测试资料，不含真实用户文件路径或员工信息。
- **下拉浮层不被正文 `overflow` 裁切的真机确认**：`position: fixed` 在 `.crwu-valuation`
  （`container-type`）里的行为按 CSS 包含块规则推演过，但只有真机能证明"贴底打开不裁切"。
- **登录 / 验证的真实链路**：沿用协议 39 的受控 Host 操作与幂等恢复，本轮只改呈现，
  未在本机跑过真实登录。
