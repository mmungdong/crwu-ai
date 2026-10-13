# 案例分析来源抓取能力（`crwu browser`）设计

> 文档性质：2026-10-13 的设计方案，**待评审**。评审通过后进入实施计划；实现落地后本文转为设计快照。
> 当前实现以源码、测试与项目 `AGENTS.md` 为准。

## 1. 需求与成功标准

房地产估值必须取得外部可比案例与房源详情页证据。当前部署取不到，原因不是站点没有数据，而是
**通道不对**：插件只有纯 `fetch`，而三站分别用客户端令牌、登录墙和人机验证把人挡在外面。

本次要沉淀的能力：

1. **通用浏览器能力**：`crwu browser`，能开真实浏览器、附着到已登录会话、取渲染后的 DOM、截图。
2. **登录能力**：由员工先登录，登录态落在 `~/.crwu` 下，后续 agent 起的浏览器直接复用。
3. **验证能力**：能判定「现在到底有没有登录、能不能抓」，把「被拦」与「没有数据」分开。

成功标准：

- 员工登录一次后，同一 profile 后续无需重登即可抓取；过期时能被明确告知需要重登。
- 取到的页面证据（HTML + 全页截图）经得起复核：截图必须校验真伪，不得把验证页当房源页交付。
- **估值在没有登录时不得开始**；其他模块使用浏览器能力时不受此限制。

## 2. 现状与技术依据

### 2.1 现值取不到的三个具体原因（均为实测）

| 位置 | 现状 | 实测结论 |
| --- | --- | --- |
| `browser/fetch-transport.ts` | 只有全局 `fetch`，UA 明写 `crwu-workbench/valuation` | 链家/贝壳返回 `hip.lianjia.com/forbidden`「访问已被拦截」；安居客返回 58 反爬墙 |
| `browser/providers.ts` | 三条 URL 模板，源码自注「待真机核对」 | 房天下模板 host `search.fang.com` 的 DNS 解析到 `10.24.0.111`（RFC1918 内网地址），外部永不可达；链家模板 `{city}.lianjia.com` 传中文「北京」不可达，必须拼音 `bj.lianjia.com` |
| `market/jsonld.ts` | 只认 JSON-LD / `__NEXT_DATA__` | 三站的价格都在 DOM（房天下 `p.priceAverage`、链家 `data-price`），**页面取到了也是 0 条** |
| `apply.ts` | `deps.screenshot` 是**未实现的注入点** | 所有候选案例都写 `screenshot_missing` |

历史证据：上一轮真实估值（`估值-20261013-065144-d007`）的 `估值案例.json` 已把上述问题逐条记进
`capabilityGaps`，与本轮实测互相印证。

### 2.2 三个站点的真机行为（本轮实测）

| 站点 | 免登录 HTTP | 真实浏览器 | 关键事实 |
| --- | --- | --- | --- |
| 房天下 `esf.fang.com` | **可用** | 可用 | `check.3g.fang.com` 的「滑块」是**纯客户端装饰**：`rand-gen.js` 只写 `otherid = md5("ETFio#dr"+YYYYMMDDHH+"lzkrZlt")`，`checkyzm.min.js` 拖到最右即 `emit("complete")`，**服务端不校验轨迹** |
| 链家 `bj.lianjia.com` | 仅未过滤首页 | **登录后可用** | 过滤页/小区页/详情页均 302 跳 `clogin.lianjia.com`；130 秒冷却后作为全新会话首个请求仍跳登录 → **URL 级登录门禁，非限流** |
| 贝壳 `bj.ke.com` | ❌ | **登录后可用** | 与链家同一账号体系 |

**贝壳与链家是同一套数据源**：22 个共同 house ID 上，总价/面积/户型/楼型/梯户比/装修/朝向/楼层/
建筑结构/挂牌时间/房屋用途/抵押/小区**全部字段完全一致**；把「仅链家有」的 ID 拿到贝壳、
「仅贝壳有」的 ID 拿到链家，**全部正常打开**。差异仅在采样顺序。

### 2.3 环境约束（实测）

1. **必须有头**。无头 Chromium 被链家识别为「访问已被拦截」。
2. **出口 IP 必须境内**。第一轮出口 `35.200.44.224`（东京 GCP）三家全封；切到北京联通家宽后房天下/贝壳可用。
3. **DSH 沙箱下必须 `--no-sandbox`**。不加则 `Failed to initialize sandbox` → `SIGTRAP`，浏览器起不来。
4. **浏览器进程必须托管**。DSH 会话结束时会把游离进程一并回收，直接 `spawn` 的浏览器会消失。

## 3. 核心架构决策：能力与策略分离

### 3.1 分层

```
估值子会话（模型）
 └─ 注册 Tool（估值域）
      └─ Host 操作代理（已注册 operation broker）      ← 不走 node:child_process
           └─ crwu browser …（打包二进制，Go）
                └─ 真实 Chromium + CDP
                     └─ ~/.crwu/browser/profile（已登录 profile＝凭据）
```

- `crwu browser` **零门禁、零估值知识**，不认识「房地产估值」这回事，谁都能调。
- 「未登录不得开始估值」是**估值域自己的策略**，只落在估值链路里。

### 3.2 为什么门禁不进全局环境模型

全局环境模型的 `required` 项是**全站阻塞项**：放进去会让「未登录」拦住所有模块，
正是要避免的。因此：

- **不**在 `shared/environment/model.ts` 新增 `required` 项；
- 门禁落在估值域的启动校验与估值技能里（见 §7）；
- 环境页只展示浏览器 profile 的**存在性**（非阻塞信息），不参与门禁判定。

## 4. `crwu browser` 命令契约

| 命令 | 作用 | 关键点 |
| --- | --- | --- |
| `crwu browser profile` | 打印 profile 路径、存在性、权限 | **不启动浏览器**，秒级；供界面展示 |
| `crwu browser login --site <id> [--timeout 5m]` | 开**可见**窗口到各站登录页，轮询到全部登录成功 | 人工完成验证码/滑块；**不做任何绕过** |
| `crwu browser status [--site <id>]` | **权威**判定登录态 | 三态；含出口 IP 归属 |
| `crwu browser fetch --url <u> --out <f> [--wait-ms] [--scroll] [--dump]` | 取**渲染后** DOM 写文件 | stdout 只回 JSON 元数据 |
| `crwu browser shot --url <u> --out <f> [--full-page]` | 全页 PNG | 写盘后**校验真伪** |

约定：

- 站点 id 是**开放枚举**（`ke` / `lianjia` / 其他），由 Host 在配置里声明站点与其登录 URL、
  受保护探测 URL、auth cookie 名。CLI 不硬编码站点语义。
- `fetch` / `shot` 的 stdout **不输出页面字节**，只输出元数据：
  `{ ok, failureKind, finalUrl, status, file, bytes, digest, captcha, loginWall, blocked }`。
- 一次调用只处理一个 URL；批量由调用方循环，便于逐页记账与限速。
- `--timeout` 与取消信号贯通；被取消时不得留下无主浏览器进程。

## 5. Profile 与登录

- 路径固定 `~/.crwu/browser/profile`，**权限 0700**；可用 `CRWU_BROWSER_PROFILE` 覆盖。
- 浏览器可执行文件沿用 `scanlogin.DiscoverBrowser()` 的发现顺序，`CRWU_BROWSER` 覆盖。
- **`login` 开可见、聚焦的窗口**，预开各站登录页，让员工看清在哪儿登、登哪个站。
- `fetch` / `shot` **优先附着到已在运行的浏览器**；确实没有在运行时才启动一个**正常位置的可见窗口**。
  - 附着优先的原因：新起实例会被 Edge 单例接管，调试端口根本不打开。
  - **不使用**历史上的 `--window-position=2000,2000`（移出屏幕）——按需求窗口应正常可见。
- 员工完成登录后，CLI 轮询各站 auth cookie；**全部站点都拿到才算成功**，成功后关闭窗口。
- 超时（默认 5 分钟）→ 返回失败但**保留窗口**，让员工继续操作。

## 6. 登录态判定（双轨）

| | 方式 | 代价 | 用途 |
| --- | --- | --- | --- |
| **快判** | profile 目录存在 + 目标站 auth cookie **存在性** | 秒级 | 界面展示、频繁轮询 |
| **权威判** | 用同一 profile 打开浏览器，访问该站**受保护页面**，看是否被 302 到登录页 | 5–8 秒 | **估值启动前必跑** |

为什么必须双轨：**cookie 存在 ≠ 有效**（可能已过期、或被风控）。只有行为判定能回答「现在能不能抓」。

判定输出固定三态（沿用既有 `LoginState`）：

- `authenticated` / `unauthenticated` / `unknown`

**`unknown` 不是 `unauthenticated`**：网络不通、出口 IP 在境外、人机验证页都归 `unknown`，
文案必须区分——否则员工会反复登录一个本来没坏的账号。

`status` 同时回**出口 IP 归属**；判定为境外或机房 IP 时直接给 `unknown` 并写明原因。

## 7. 估值域前置门禁

三处落点，**全部在估值域内**：

1. **Host 启动校验**：估值启动流程在**冻结输入快照之前**，对配置声明的必需站点各跑一次权威判定；
   未全部 `authenticated` → 拒绝启动，返回可执行指引（哪个站、去点哪个按钮）。
2. **估值技能**：`crwu-biz-valuation-realestate` 的完成门禁写明「未登录不得开始」，
   并说明它与环境自检的区别。
3. **面板呈现**：把「需要登录」作为**估值模块内的**阻塞态展示，而不是环境页的全站阻塞项。

按需求，**不提供降级开关**：未登录即不开始。

## 8. 失败分类与可诊断性

站点改版会让取数静默失效。因此 `fetch` / `shot` 必须返回**结构化失败类别**，
而不是一句「取不到」。

**归属**：下表前八类由 **CLI** 产出（它只看页面事实，不认识选择器）；
最后一类 `template-stale` 由**插件解析层**产出（只有它知道选择器命中了几条）。
两层各自返回自己那一层的类别，调用方按顺序取第一个非空类别。

| 类别 | 含义 | 下一步 |
| --- | --- | --- |
| `login` | 被登录墙挡住 | 去登录 |
| `captcha` | 人机验证 | 人工在窗口完成 |
| `blocked` | 明示拦截页（如 `hip.lianjia.com/forbidden`） | 查出口 IP / 风控 |
| `rate-limited` | 限流 | 降速重试 |
| `not-found` | 页面失效 | 检查 URL 模板 |
| `server-error` / `network` | 站点或网络异常 | 重试 / 换网络 |
| `template-stale` | **页面取到了，但选择器一个都没命中** | 用 `--dump` 取现场 DOM 重新推导 |
| `unknown` | 认不出来 | 不猜 |

`--dump` 把**原始已渲染 DOM** 存到调用方指定路径，供 agent 照现场重新推导选择器。

截图后置校验（写盘即验，不通过则判失败）：

- 尺寸合理；**非白像素占比**高于阈值；
- 命中验证页/拦截页特征时判 `captcha` / `blocked`，**不得**当房源页交付。

> 实测踩过：批量截图到第 12 张时贝壳弹出人机验证，截下来的就是验证页（38 KB / 非白 0.9%）。
> 没有这一步就等于交付伪证据。

## 9. 与现有代码的接缝

| 现有 | 变化 |
| --- | --- |
| `browser/fetch-transport.ts` | **保留**，作为房天下 HTTP 通道（客户端令牌，见 §2.2） |
| `browser/provider.ts` 的 `MarketTransport` | **新增** `browserTransport` 实现同一接口 → provider 层零改动 |
| `browser/providers.ts` | 按实测校正模板（房天下 host、链家/贝壳拼音域名与检索路径） |
| `market/jsonld.ts` | 由「只认 JSON-LD」改为「JSON-LD 优先 + 站点解析器兜底」，站点解析器与模板同处 |
| `browser/capture.ts` 截图注入点 | 接上 `crwu browser shot` → `screenshot_missing` 消失 |
| `internal/platform/scanlogin` | **不动**；仅复用其浏览器发现逻辑，**不共用 profile**（它是临时目录、用完即删） |

## 10. 安全边界与取舍

1. **profile 就是凭据**。`~/.crwu/browser/profile` 含完整登录态：权限 0700；CLI **永不回显 cookie 值**，
   只报域名/名字/长度/存在性；不写入日志、不进结果 JSON、不进对话。
2. **profile 不加密**。浏览器 profile 无法加密（浏览器需直接读写）。若要求加密，只能改为把 cookie
   抽出来走 OS keyring，代价是每次重建 profile、浏览器的设备指纹丢失、**更容易被风控**。
   本设计选择「不加密但严格不外泄」。
3. **`--no-sandbox` 取舍**：为了让 DSH 能调到浏览器，该实例关闭 Chromium 自身沙箱。
   缓解：独立 profile、仅访问配置声明的白名单站点、不加载任意 URL。
4. **不做 `browser eval`**（页面内跑任意 JS）。它会开一个任意脚本注入面。
   先用「渲染后 HTML + 插件侧解析」；若解析稳定性不足再单独评审。
5. **不做人机验证绕过**。`login` 全程人工；CLI 不实现打码、轨迹伪造或代填。

## 11. 设计依据（历史参考件）

本设计的技术点来自 2026-10-13 会话归档里的历史脚本。**这些脚本不入仓**（避免两份实现漂移），
已另存本机 `~/.crwu/reference/browser-scraping/`（含 README 与出处），仅在排障时作对照。

必须逐条对齐的六条技术点：

1. **非无头**——无头被指纹识别；
2. **持久 profile**——`--user-data-dir` 固定目录，登录态活在其中；
3. **附着优先**——新起实例会被单例接管，调试端口不打开；
4. **四态判定**——`CAPTCHA` / `LOGIN-WALL` / `BLOCKED` / `OK`，把「被拦」与「没有数据」分开；
5. **先滚动再截图**——否则懒加载区域是灰框；
6. **登录态验证走浏览器级 WS**（`/json/version`）+ `Network.getCookies`，只报存在性。

归档出处：`dsh-session-session-房屋信息抓取seesion-a715-4eae-ad63-157de2ad014e.zip`；
参考件位置：`~/.crwu/reference/browser-scraping/README.md`。

## 12. 测试策略

- **Go**：CDP 客户端用本地替身（HTTP + WS）；profile 路径与 0700 权限；cookie 存在性判定；
  **启动参数断言**（必须含 `--remote-debugging-port` / `--user-data-dir` / `--no-sandbox`，
  **不得**含 `--headless`）；超时与取消；失败分类映射。
- **截图校验**：验证页与空白页样本必须被判失败（用固定的小样本图，不访问外网）。
- **契约**：`crwu scheme` 含 `browser` 全树与示例；同步 `cli-manual.md`、`cli-command-contract.md`、CHANGELOG。
- **插件**：`browserTransport` 用内存替身；**门禁单测**（未登录 → 估值启动必须被拒、
  且其他模块不受影响）；环境模型不变量不被破坏。
- **真机验收**（由员工在本机执行）：登录一次 → `status` 判 `authenticated` → 抓一页贝壳详情 + 一张截图。

## 13. 未决问题

1. **房天下是否仍走 HTTP**。本轮实测纯 HTTP 可过（客户端令牌）；但上一轮记录为「必须浏览器」。
   倾向：**双通道 + 优先 HTTP**，HTTP 失败再降级浏览器，并在结果里记明实际用了哪条。
2. **改版检测的自动化**。`template-stale` 只在真跑时才发现。是否需要一个定期自检任务，待定。
3. **profile 过期提醒**。是否在临近过期时提前提示员工重登，待定。
4. **多员工 / 多 profile**。当前 `~/.crwu` 按 OS 用户隔离；同一台机器多员工共用时如何隔离，待定。

## 14. 不在本次范围

- 不改估值业务规则（可比案例打分、修正体系、结论口径）。
- 不新增或迁移既有 AuditResult / 估值结果 JSON 字段。
- 不改造审核链路（`crwu-audit`）的环境自检。
- 不把抓取能力做成面向员工的独立界面；本次只沉淀 CLI 能力与估值域的接入。
