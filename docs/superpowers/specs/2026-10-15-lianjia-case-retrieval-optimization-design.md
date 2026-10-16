# 链家案例取数链路的缺陷修复与详情字段补全 设计

> 文档性质：2026-10-15 的设计方案，**待评审**。评审通过后进入实施计划；实现落地后本文转为设计快照。
> 当前实现以源码、测试与项目 `AGENTS.md` 为准。

## 1. 背景：为什么现在从链家拿不到案例

三条**实测**证据，按对结果的影响排序。

### 1.1 登录门禁的判据页本身不设防（最严重）

`skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json` 里链家的 `protectedUrl` 是
`https://bj.lianjia.com/ershoufang/`。而 `protectedUrl` 的**唯一用途**就是「要求会话的页面」——
`crwu browser status --verify-page` 与估值前置检查都靠它区分「已登录」与「未登录」。

2026-10-15 实测（北京联通出口，真实 Chrome UA）：

| URL | http | 跳登录墙 | `data-price` |
| --- | --- | --- | --- |
| `https://bj.lianjia.com/ershoufang/`（**现用**） | 200 | **否** | **30** |
| `https://bj.lianjia.com/ershoufang/chaoyang/` | 200→302 | **是**（`clogin.lianjia.com`） | 0 |
| `https://bj.lianjia.com/xiaoqu/chaoyang/` | 200→302 | **是**（`clogin.lianjia.com`） | 0 |

后果：**未登录时权威判定也返回 `authenticated`**，于是估值带着「已登录」的错觉开跑，
真正取数时才被登录墙挡住。这直接抹掉了「cookie 存在性快判 + 页面权威判」双轨的意义。

### 1.2 站点清单加载失败不会以「清单问题」暴露

`browser/runtime.ts` 的 `createValuationBrowserRuntime` **无论 `loadBrowserSites` 成功与否都返回
runtime**（失败信息放在 `sitesError` 字段里）。而 `tools/report-evaluation/market-search.ts`
只读取 `runtime.toolClient` 与 `runtime.coordinator`（`:317`、`:318`），**从不读 `runtime.sitesError`**。

后果：清单缺失/畸形时，`crwu browser --sites <坏路径>` 被 CLI 拒绝，员工看到的是一条底层参数错误，
而不是「站点清单加载失败：<原因>」。

### 1.3 重试节奏与「抓成功那一轮」相反

`docs/superpowers/reviews/2026-10-15-lianjia-successful-run-reconstruction.md` §6 M15：
归档靠 **慢 + 每 URL 只导航一次**（列表 9s、详情 8.5s、详情间 2.5s、小区间 4s）活下来；
现行 `MARKET_ATTEMPTS = 3`（`browser/retry.ts:14`）并叠加挑战自动恢复，**增加**同一页面的访问次数。

在被风控的站点上，「再多试几次」是最容易把员工 IP 送进黑名单的做法——`retry.ts` 的注释自己就这么写。

### 1.4 详情页的比较因素字段根本没有被解析

盘点是：

| 环节 | 现状 |
| --- | --- |
| 列表行解析（`market/site-parsers.ts`） | **已产出** `orientation` |
| `market/normalize.ts` 别名表 | **没有 `orientation`** → 产出即丢弃（复盘 M17） |
| 详情页 | 只有 `looksLikeDetailPage`：一个「**是不是**详情页」的校验，**没有任何字段抽取器** |
| 楼型 / 梯户比 / 建筑结构 / 抵押权 / 房屋用途 | **从未被解析** |

而这几项正是市场法比较因素表要打分的项（朝向、住宅类型、建筑结构、权益状况）。
以力鸿花园那轮为例：估价对象是**板楼两梯两户、钢混、公寓**，而工作簿原来用的三个实例是
**塔楼三梯八户/十户**——这条差别正是「案例选得对不对」的核心，但它现在到不了估值。

## 2. 目标

1. 登录门禁的判据页**真的要求会话**；未登录时权威判定必须返回 `unauthenticated` 或 `unknown`，
   不得返回 `authenticated`。
2. 站点清单加载失败时，取数以**清单问题**暴露并说明原因，不伪装成底层 CLI 错误。
3. 同页自动重试上限降为 **2**。
4. `ValuationCase` 与取数输出契约补全 **6 个比较因素字段**，并让详情页真正产出它们。
5. 详情页一条字段都抽不到时报 **`template-stale`**，不报「该房源无此信息」。

## 3. 不在本次范围

- 不改截图任务、不改编排/恢复（`browser-recover.ts`、`challenge-recovery.ts`）——这部分已实现。
- 不改 `MARKET_USER_AGENT`（见 §7 的原则说明）。
- 不新增「出口 IP 归属查询」（复盘 §6 M13 已记为计划缺口，且它要引入一个外部 HTTP 依赖）。
- 不改 `market/city.ts` 的城市码设计（复盘 §6 M4 判定「设计如此」）。
- 不预检页 host 的改动（复盘 §6 M2 结论是「无证据支撑」，留给能一次改通道身份的人）。

## 4. 批次 A：三个小修

### A1 判据页改成真正要求会话的页

`browser-sites.json` 链家条目的 `protectedUrl` 改为 `https://bj.lianjia.com/ershoufang/chaoyang/`。

选它的理由：档案与今日实测都证明它在**未登录时 302 到 `clogin.lianjia.com`**，而登录后可用；
`/xiaoqu/chaoyang/` 同样成立，但取数的主战场是二手房，用同一频道更贴近真实取数路径。

`probeUrl`（预检页）**不动**：它要回答的是「公开检索放不放行」，本来就该用公开页。

**验收判据**：未登录时 `crwu browser status --verify-page --site lianjia` 必须**不是** `authenticated`。

### A2 清单失败以清单问题暴露

`market-search.ts` 在选取 transport 之前检查 `deps.browserRuntime?.sitesError`：非空即**直接失败**，
错误文本带上原因，`errorKind` 用 `capability-gap`（这是能力缺口，不是站点没有数据）。

判据：清单文件缺失/畸形时，取数返回的是「站点清单加载失败：<原因>」，且**不发起任何页面访问**。

### A3 重试上限降为 2

`MARKET_ATTEMPTS` 由 `3` 改为 `2`，并同步更新 `retry.ts` 的注释与所有引用它的测试期望。

判据：一条稳定失败的来源，页面访问次数上限是 2（可用假 transport 计数断言）。

## 5. 批次 B：详情页字段抽取器与契约扩展

### B1 新增 `market/detail-parser.ts`

与 `site-parsers.ts` **同一层、同一纪律**：选择器**写死在代码里**，模型提交不了；
站点改版时改这一个文件。

抽取源是详情页的 `label + value` 成对结构（`.introContent li > span.label` + 同级正文，
2026-10-13 归档实测 21 对）。本次只抽 §5.2 的 6 个字段，其余不抽（YAGNI：没有消费者的字段不收）。

### B2 契约新增字段（`ValuationCase` 与取数输出）

两处契约**命名风格不同**，实现时必须各按各的写（`ValuationCase` 用 camelCase，
取数输出 `SearchCase` 用 snake_case，两者的唯一转换点是 `market-search.ts` 的 `caseToJson`）：

| `ValuationCase` | `SearchCase` | 中文 | 取值示例 | 来源 |
| --- | --- | --- | --- | --- |
| `orientation` | `orientation` | 房屋朝向 | `南 西南 西` | 列表行**已产出**，补进 `normalize` 别名与契约 |
| `buildingType` | `building_type` | 建筑类型 | `板楼` / `塔楼` / `板塔结合` | 详情页新抽 |
| `ladderRatio` | `ladder_ratio` | 梯户比例 | `两梯两户` | 详情页新抽 |
| `buildingStructure` | `building_structure` | 建筑结构 | `钢混结构` | 详情页新抽 |
| `mortgage` | `mortgage` | 抵押信息 | `无抵押` | 详情页新抽 |
| `usage` | `usage` | 房屋用途 | `公寓` / `普通住宅` | 详情页新抽 |

**全部为字符串，拿不到时为空串**（与既有 `floor` / `decoration` 同一口径，不用 `null`：
这些是多值文本，不是数值，空串已经能表达「没有」）。

`normalize.ts` 的别名表同步补这 6 个（含中文标签别名，与既有 `publishedAt` 的写法一致）。

### B3 取数输出契约同步（已核实范围）

改**两处、仅两处**：

1. `market-search.ts` 的 `SearchCase` 接口（`interface SearchCase`）增加 6 个 snake_case 字段；
2. 同文件的 `caseToJson(item: ValuationCase): SearchCase` —— 它**是两者之间唯一的转换点**，
   6 个字段在这里逐字搬运。

**`delivery/finalize.ts` 不需要改**：已逐行核对，它的 `missing` 数组只覆盖
知识（`facts.knowledge.missing`）、对象结论（`missingConclusions`）、证据（`evidence.entries`）、
产物（`facts.artifacts.missing`）四类，**没有「案例字段齐备」类断言**。

### B4 抽不到 = `template-stale`

详情页**一条字段都没抽到**时，复用既有的 `ParseFailureKind`：报 `template-stale`，
**不报**「该房源没有这些信息」。理由与 `site-parsers.ts` 里那条一致：
一个看起来是详情页的页面里一个字段都没有，只可能是站点改版；报成「无此信息」会让结论建立在错误事实上。

## 6. 测试策略

- **纯函数**：`detail-parser` 用**按归档结构合成**的最小 DOM fixture（无真实页面字节），
  覆盖 6 个字段齐全 / 部分缺失 / 0 命中三类；断言 0 命中给 `template-stale`。
- **契约**：`normalize` 的别名表把 6 个字段映射进 `ValuationCase`，含「拿不到时为空串」。
- **取数**：假 transport 计数，断言 A3 的重试上限是 2；断言 A2 在 `sitesError` 非空时
  **零页面访问**且错误文本带原因。
- **配置**：一条断言钉住「`protectedUrl` 不得是免登录也能打开的页」——用**清单条目形状**断言
  （不能联网），即要求它落在 `/ershoufang/<区域>/` 这种过滤页形状上，并写明理由。
- **真机验收**（由员工执行）：未登录时 `status --verify-page` 不是 `authenticated`；
  登录后能取到一页详情，且 6 个字段有值。

## 7. 为什么不动 `MARKET_USER_AGENT`

复盘 M14 把「归档用真实 Chrome UA、我们自报 `crwu-workbench/valuation`」记为通道身份不一致，
修法字面上是「把 UA 换成真实 Chrome」。**本设计明确不做**：

- 现行 UA 是**刻意自报家门**的，源码注释写明「不伪装身份：站点要封就封这个 UA，那是它自己的判断」；
- 同一纪律已写进 `crwu browser` 的 spec；
- 更重要的是：**M14 只在「退回纯 HTTP 通道」时才咬人**。生产路径上链家走**浏览器通道**
  （`apply.ts:148` 总会装配 runtime），而真浏览器**本来就不需要伪装 UA**。

所以有原则的修法是让「静默退回纯 HTTP」不再可能（A2 让清单问题显式失败），而不是让 HTTP 通道冒充浏览器。

## 8. 风险与未决

1. **判据页也会被风控**：`/ershoufang/chaoyang/` 未登录时是 302 到登录墙，但如果该 IP 已被风控，
   它可能变成 CAPTCHA 页——那时 `status` 会返回 `unknown`（而非 `authenticated`），这是**正确**的行为方向。
2. **详情页选择器只有归档证据**：本次 fixture 是按归档结构合成的，**不证明**站点当前可用；
   真实解析仍需员工在授权环境验收一次（与 `site-parsers.ts` 同一条边界声明）。
3. **6 个字段的消费者**：本次只保证字段能到 `ValuationCase`；把它们接进比较因素打分表是估值业务侧的事，
   不在本设计内。
