# 房地产估值插件诊断与链家检索调研

> 历史诊断快照，日期：2026-10-14。审查基于 `feat/valuation_1012`、HEAD `4c12b85` 及当时工作区的未提交改动。本文记录问题与修复建议，不是当前运行指令。

本轮覆盖 Workbench 房地产估值的知识路由、浏览器门禁、案例搜索与取证、恢复协调、完成判定，以及相关 Go 浏览器实现。对照材料为用户提供的本地知识库导出。共整理 **25 项问题与兼容缺口**，附复现结果、修复顺序和人机拦截处理建议。业务源码和知识库均未修改。

用户这次的明确要求是：只校验链家；案例检索先通过页面搜索框发现真实结果 URL，再检索和取证；对齐现有知识库；解释途中结束和链家拦截问题。

## 结论与证据边界

已经复现的关键问题包括：`200万` 被标准化成 `200元`、现有知识文件无法命中路由、现有模板索引无法解析、搜索阶段提前把估值标为完成、验证码失败重复取页并被归为登录问题，以及恢复导航回到预检 URL。

本地导出只有 8 份文件，4 份非空、4 份空白。下载清单的 `spaceName` 是“中瑞世联评估审核知识库”，与目录名和代码要求的业务库不一致。这可能是导出清单标记错误，也可能是下载来源错误；**本轮没有重新查询线上知识库，不能据此认定线上正文不存在或空间身份确实错误**。

用户那次“半路直接退出”的运行记录没有提供。本轮确认了能产生提前结束或阻断的代码路径，尚不能把某一条路径认定为那一次运行的唯一根因。

## 知识库逐项对照

以下结果直接调用当前 `resolveRoute`，用实际本地文件组成只读目录清单。为了单独检测命名，路径测试暂设空间已验证；真实镜像身份另行调用 `loadVerifiedMirror` 检查，结果为拒绝。

| 路由 | 代码要求 | 本地导出事实 | 当前解析结果 |
| --- | --- | --- | --- |
| `realestate.common` | `01-房地产估值通用/` 中的正文 | 未导出这个目录；相关内容散见方法文档 | `empty` |
| `realestate.method-selection` | `02 估值方法/01 房地产评估方法选择方案.md` | 同名、非空 | `found` |
| `realestate.method.market` | `02 估值方法/02-市场法.md` | 实际是 `02 市场法.md` | `missing` |
| `realestate.method.income` | `03-收益法（TODO）.md` | 实际是 `03 收益法（TODO）.md`，空白 | `missing`；名称对齐后仍应为未支持 |
| `realestate.method.cost` | `04-成本法（TODO）.md` | 实际是 `04 成本法（TODO）.md`，空白 | `missing`；名称对齐后仍应为未支持 |
| `realestate.case-selection` | 独立的 `03-案例选取/` | 未导出该目录；市场法第 1、2 章已有渠道与选例要求 | `empty` |
| `realestate.parameters` | 独立的 `04-参数与税费/` | 未导出该目录；市场法第 3～8 章已有相关正文 | `empty` |
| `realestate.template-index` | `05-计算表模板/00-模板使用目录说明.md` | 实际目录是 `05 计算表模板` | `missing` |
| `realestate.template.market.residential` | `05-计算表模板/01-市场法/01-市场法计算表模板-住宅.xlsx` | 实际三段均用空格：`05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx` | `missing` |

**住宅模板本身已经对齐**：本地模板与随包 `template/valuation-workbook.xlsx` 都是 25,512 字节，SHA-256 都为 `f2e8f15e54299afb3c5a6d269791c6e7401b4112c69f70347a8aeb2634e1e08d`。两者均为七张可见表。本轮没有进行 Excel 重算，不能据此证明公式计算正确。

## 问题清单

P1 表示影响结果正确性、核心流程或恢复能力，应优先处理；P2 表示会误导检索、诊断或增加无效访问。这里的优先级是修复排序，不是全部问题都已在用户那次运行中发生。

### 01 · P1 · DOM 解析丢失“万”，总价缩小 10,000 倍【已复现】

[site-parsers.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/market/site-parsers.ts) 第 145～146 行把 `200万` 提取成字符串 `200`；[normalize.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/market/normalize.ts) 第 150～160 行将纯数字按元处理。实际结果为总价 `200`、面积 `100`、单价 `20000`，金额勾稽已经矛盾；缺单价时，由总价推算的单价也会错误。应保留单位或显式返回元金额，并检查总价与单价乘面积的一致性。

### 02 · P1 · 知识路由和真实文件名不一致【已复现】

[route.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/route.ts) 第 133～265 行的市场法、收益法、成本法、模板索引和模板路径缺少现有空格形式的别名。解析器逐字匹配，因此文件存在也读不到。应以真实目录清单建立明确映射，并对歧义返回可处理的错误，不能靠任意模糊匹配挑第一份。

### 03 · P1 · 新设目录被当作必需前提，现有大文档章节没有接入【导出对照已复现】

`realestate.common` 被设为项目必需项，缺失时 [resolve.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/resolve.ts) 第 674～679 行返回“估值已停止”。案例选取、参数又要求独立目录，但现有市场法正文已经包含这些章节。应先核实线上清单，再支持现有文档的章节路由；不能因为知识尚未拆成新目录就将其视为没有规则。收益法、成本法的空白 TODO 则应如实保留为未支持。

### 04 · P1 · 用户下载目录无法直接接入本地镜像【已复现】

[mirror.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/mirror.ts) 第 169～194 行要求正确的 `spaceName` 以及 `entries[].path/digest/updatedAt`。实际导出是 `items[].localPath/status/bytes`，且空间标记不一致；[部署配置](../../../plugins/dsh-crwu-workbench/config/crwu-workbench.yml) 第 39 行默认镜像未启用。只填目录或只改空间名都不能接通。需要核实来源身份，并通过明确的导出格式适配生成可验证清单，不能伪造身份或跳过验真。

### 05 · P1 · 新数值规则契约要求 JSON，现有知识是自然语言【已复现的兼容缺口】

[rules.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/rules.ts) 第 334～355 行对实际 `02 市场法.md` 返回 `missing`、参数数为 0。生产计算入口 [calculate_market.py](../../../plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/calculate_market.py) 第 93～114 行也要求结构化参数。现有正文并非没有阈值，而是缺少代码要求的机器段。还没有发现 Host 生产路径调用该解析器的接线，单独函数存在不能证明转换已完成。需要补齐有章节出处、摘要绑定和业务审核的转换流程。

### 06 · P1 · 现有模板目录说明不是代码要求的机器索引【已复现】

[templates.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/templates.ts) 第 81～85 行只接受 JSON 围栏中的 `templates` 数组。实际索引是目录树和 Markdown 对应表，解析直接失败；[template.ts](../../../plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/template.ts) 第 278～283 行因此阻断取模板。应支持经确认的现有索引格式，或先完成知识库索引迁移，再启用这个门槛。

### 07 · P1 · 链家与贝壳被同时列为必需校验来源【已复现】

[部署配置](../../../plugins/dsh-crwu-workbench/config/crwu-workbench.yml) 第 22～24 行和 [config.ts](../../../plugins/dsh-crwu-workbench/src/host/config/config.ts) 第 69 行均要求 `beike`、`lianjia`。站点清单、来源枚举和部分测试也固化了双站要求。应按本次业务要求只校验链家，并同步配置缺省、能力表、界面和测试。统一账号体系不意味着应伪造另一个域名的 Cookie 或声明两个域名均已验证。

### 08 · P1 · 搜索直接拼 URL，没有通过搜索框发现真实路由【已复现】

[providers.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/providers.ts) 第 61、149～154 行直接拼 `/ershoufang/{keyword}pg{page}/`，源码还声明模板“待真机核对”。检索固定走在售路由，无法保证适合需要的成交案例。应先在真实城市页面选择检索类型，通过搜索框提交关键词，读取实际结果 URL、房源链接与分页链接；不能把一个猜出的路由替换成另一个固定模板。

### 09 · P1 · 完成搜索就把整个估值轮次推进到终态【已复现】

[login-state.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/login-state.ts) 第 131 行返回搜索阶段 `completed`；[market-search.ts](../../../plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/market-search.ts) 第 560 行经 [record.ts](../../../plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/record.ts) 第 116 行将它写入整个估值生命周期。复现时 `validationPassed=false` 仍进入 `completed`，随后推进 `running` 被拒绝。搜索完成应只更新检索任务，项目完成必须由所有方案的交付判定汇总。

### 10 · P1 · 实际父会话提示词与新流程相互矛盾【静态确认】

[handoff.ts](../../../plugins/dsh-crwu-workbench/src/host/operations/report-evaluation/handoff.ts) 第 359～362 行传入空知识清单、`knowledgeReady:true`，让 [prompt.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/prompt.ts) 第 133 行宣称“必需知识已取到”。提示词和 Skill 执行步骤又让模型复制随包模板，没有明确使用 `template_materialize` 验真的模板；交接给出的校验脚本路径是项目内 `scripts/`，但交接没有复制这些脚本，参数还指向项目根而非方案目录。另有“少于三例仍测算”的旧指导与知识正文的数量要求未统一。应统一为“尚待提取/物化”的真实状态和当前方案流程。

### 11 · P1 · 分类失败被抛成普通错误，验证码等被无差别重试【已复现】

[providers.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/providers.ts) 第 158 行把 `failureKind`、`recovery` 丢失，外层 [market-search.ts](../../../plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/market-search.ts) 第 459 行对所有错误调用三次重试。[retry.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/retry.ts) 默认无等待。一次等待人工验证被复现为三次 fetch、三次恢复调用，最终还可能被 [login-state.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/login-state.ts) 说成需要登录。应保留类型，只重试可恢复的网络/服务错误；验证码暂停、404 停止、429 冷却。

### 12 · P1 · 恢复任务标识没有项目、方案和页面身份【已复现】

[market-search.ts](../../../plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/market-search.ts) 第 202～205 行只用来源、城市、关键词生成恢复标识，预检与搜索共享它。[challenge-recovery.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/challenge-recovery.ts) 第 228～244 行复用第一次登记的 URL。实际复现中，第二次恢复搜索页面仍访问第一次预检页面。不同项目相同关键词也会共享预算。应按项目、方案、任务、页面绑定恢复上下文，并校验调用方归属。

### 13 · P1 · 冷却协调和超时预算在跨层接线后失效【参数复现与静态确认】

[challenge-recovery.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/challenge-recovery.ts) 第 184～195 行一次把剩余两次尝试交给 CLI，同时传 `cooldownMs:0`；[recover.go](../../../internal/platform/browser/recover.go) 第 360 行内部循环可将两次消耗完。模拟真实 CLI 返回两次消耗时，协调器等待次数为 0。普通 fetch 入口又不检查来源冷却截止时间。另一方面，[providers.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/providers.ts) 第 118 行的 20 秒超时包住整个恢复流程，与 30 秒冷却、120 秒恢复窗口冲突。应分别管理一次尝试、来源冷却与总任务期限。

### 14 · P1 · 人工继续仍选择自动解题，断点只保存在内存【已复现与静态确认】

[challenge-recovery.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/challenge-recovery.ts) 第 264 行的 `resume` 仍传 `strategy:'auto'`，而不是仅验证人工完成后的页面；Go 的 `auto` 可以执行自动挑战策略。`tasks`、`cooldowns` 也只有进程内 Map，插件重启后原任务无法继续。应持久化非凭据断点，人工继续只做页面与原房源核验。

### 15 · P1 · 等待验证的任务信息没有完整返回或落盘【静态确认】

[browser-transport.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/browser-transport.ts) 第 108～120 行提供恢复信息，但 provider 抛错后搜索结果仅留下普通失败文案，没有稳定的 `retrievalTaskId`、当前 URL、恢复状态与下次可尝试时间。模型需要调用恢复工具时缺少可依赖的任务回执。应返回并持久化结构化等待状态，明确继续哪个任务。

### 16 · P1 · 给每套候选房源反复截同一个列表页【静态确认】

[market-search.ts](../../../plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/market-search.ts) 第 485～499 行在房源循环中使用 `url:pageUrl`，没有使用该房源的详情链接。N 个房源会反复导航、滚动、截图同一个结果页，增加访问次数，且不足以证明单套详情。生成的 `caseId` 也未随案例 JSON 返回。应列表页留一次检索证据，采用候选按稳定房源身份进入详情，逐套截图并登记关联。

### 17 · P1 · 详情取证 Tool 没走已装配的浏览器与截图通道【静态确认】

[market-search.ts](../../../plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/market-search.ts) 第 673～694 行的 capture 使用注入 transport 或原始 `fetchTransport`，没有复用浏览器 runtime 的员工会话、恢复与截图能力，成功结果还无条件写入 `SCREENSHOT_GAP`。但能力表把它登记为详情和截图能力。应将宣称的能力落实到真实通道，并校验房源详情、记录正式截图。

### 18 · P1 · 分阶段知识物化覆盖汇总索引，落盘状态与回执不一致【已复现】

[resolve.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/resolve.ts) 第 656～684 行每次覆盖同一 `.知识来源.json`，并在落盘之后才设置 `manifest.ok`。复现中首次返回 `ok:true`，保存的 `ok` 却是 `false`；第二阶段索引只剩市场法，通用规则被覆盖。方案也共用这份文件，而 finalize 读取它。应区分项目与方案知识，按路由合并版本化来源，并在确定状态之后落盘。

### 19 · P1 · 完成判定没有重新核验知识身份与实际正文【已复现的校验缺口】

[finalize-facts.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/delivery/finalize-facts.ts) 第 120～157 行只要求条目有非空 `routeId/digest`，没有验证顶层 `spaceVerified`、实际库名、必需路由是否齐备或正文文件摘要。一个 `spaceVerified:false`、错误空间名的索引仍返回 `missing:[]`。读取层随后可将知识标为已验证。应从受信任记录和实际文件核验整条来源链。

### 20 · P1 · “已验证镜像”允许缺少或非法摘要【静态确认】

[mirror.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/mirror.ts) 第 239～253 行仅在 `expected !== ''` 时比较 digest。未声明或非法摘要会跳过比较，仍记录“身份与 digest 均通过”。字节数也是可选，不能替代内容验真。应明确未声明摘要的信任级别，不能把未经清单摘要校验的本地文件标为已验证镜像。

### 21 · P1 · 特征相同的独立房源会被直接删除【已复现】

[normalize.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/market/normalize.ts) 第 283～317 行按小区、面积、总价档直接合并，连同站点不同房源也会合并。两套不同 URL、相同小区/面积/总价的房源从 2 条变成 1 条。listing ID 没进入标准化身份。同特征只能标为疑似重复，应优先使用稳定房源标识，并保留原始候选、来源证据与采用/剔除决定。

### 22 · P1 · 详情校验允许最终 URL 没有原房源 ID【已复现】

[site-parsers.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/market/site-parsers.ts) 第 246 行仅在两边都有 ID 且不等时拒绝，随后只要页面出现面积或价格即可通过。给出含“推荐房源100平米”的列表/导航地址，校验仍返回成功。应要求最终页面身份与原房源一致，并核验实际详情字段，而非推荐区域中的任意数字。

### 23 · P2 · 城市选择页、首页被说成“确实没有结果”【已复现】

[site-parsers.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/market/site-parsers.ts) 第 228～229 行把所有没有列表容器的非空页面归为 `no-results`。一个“城市选择”页面被复现为没有案例。这会掩盖错误路由和跳转问题。应只有明确空结果提示才能判定无结果，其余保留导航页、结构未知或解析失败类别。

### 24 · P2 · 检索任务没有兑现对象和选例规则【静态确认】

[retrieval.ts](../../../plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/execution/retrieval.ts) 第 158～198 行只取首个对象关键词，使用规则的城市而忽略对象自己的城市，且用拓展阶梯长度决定翻页数。`candidateCountMin`、面积区间、交易日期窗没有成为生成任务的筛选/终止条件。应区分关键词、分页、范围拓展与停止条件，按对象真实城市执行并保留知识出处。

### 25 · P2 · 每来源统计混入其他来源，补搜覆盖此前候选【静态确认】

[market-search.ts](../../../plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/market-search.ts) 第 519、530、537 行使用所有来源累计的 `cases.length`；后一来源 0 条也可能显示前面来源的数量，隐藏本来源解析缺口。第 577 行每次调用覆盖同一方案的 `估值案例.json`，更换关键词、拓展检索或恢复补搜会丢失前轮候选。应维护本来源计数，并以检索任务与房源身份合并候选账，而非覆盖整份清单。

## “半路退出”应怎样收敛

目前有三种需要分别处理的情况：

1. **知识阻断**：文件或格式不匹配。保留材料、已完成任务和缺口，输出说明原因的阶段报告；可补齐的问题提供同项目继续入口。
2. **浏览器等待**：验证、登录、限流。进入明确的等待状态，不让模型反复试、不把等待当完成，也不要求重传资料。
3. **业务完成**：所有对象和方案已结算，交付校验通过。只有这个分支可以完成项目；搜索成功不属于这个分支。

要定位用户那一次具体结束原因，仍需该会话末尾的工具回执或报错文本。不能仅凭静态审查把它称为已经修复。

## 链家人机拦截调研

### 官方事实

- 链家隐私声明描述了贝壳旗下产品的统一账号体系。它支持本次“只校验链家”的业务简化，但不证明浏览器中的两个域名会话一定同时有效。[链家隐私声明](https://www.lianjia.com/privacy)
- 贝壳服务政策将异常抓取列为可能触发账号处理的异常访问，并限制自动化或远高于正常用户频率的数据访问。[贝壳服务政策](https://www.ke.com/zhuanti/serviceProtocol)
- 本轮读取的 `www.lianjia.com/robots.txt` 对通配 User-agent 声明禁止全路径。城市域名的 robots 本轮未成功读取，不能将主域内容当作所有子域的完整契约，也不能把页面可打开当作自动化授权。[链家 robots](https://www.lianjia.com/robots.txt)
- 验证系统可以综合请求行为、环境、设备、IP 等信号；并不是只要通过一次图形题就能持续取数。这是验证厂商的一般机制说明，本轮**未确认链家当前具体使用哪个版本或策略**。[极验产品说明](https://docs.geetest.com/gt4/overview/prodes)、[极验风险码说明](https://docs.geetest.com/deepknow/overview/riskcode)
- HTTP 429 可能包含 `Retry-After`，客户端应按服务端提示等待。[MDN：429 Too Many Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429)

本轮没有查到官方保证不会触发验证的访问频率，也没有核实可直接供本项目使用的公开房源 API。建议中的节流属于减少无效访问的工程措施，不能承诺免拦截。

### 推荐处理流程

```text
链家单一门禁
  → 在员工已授权、可见的同一浏览器会话中进入目标城市
  → 页面搜索框提交关键词，读取实际结果 URL 与检索类型
  → 校验城市/小区/结果类型，记录实际分页与房源链接
  → 按知识条件筛选候选，足够时停止补搜
  → 详情核验与正式截图
       ├─ 验证：保存断点，暂停该来源，等待员工完成验证
       ├─ 429：遵守 Retry-After，来源进入冷却
       ├─ 登录墙：提示员工登录
       ├─ 403/持续拦截：暂停该来源，记录原因及替代作业入口
       └─ 正常：继续计算、重算和交付判定
```

具体落点：

1. **URL 来自页面动作和链接**。固定可信站点入口可以保留，关键词结果路由和翻页 URL 通过页面实际行为获取。Host 校验域名、城市、查询上下文，避免让模型提交任意地址。
2. **复用员工的同一浏览器会话**。验证在同一窗口完成，插件只管理页面和任务，不导出 Cookie。人工继续先检查当前页面，核验原房源后再取正式证据。
3. **验证码出现即停止该任务的自动取页循环**。持久化项目/方案/任务、实际 URL、房源 ID、阶段、已完成证据、失败类别、冷却时间；不持久化凭据。其他不依赖该来源的任务继续。
4. **默认采用人工验证恢复**。当前 Go 的 `geetest-v3-canvas` 源码明确标为候选策略，没有独立真实页面成功验收。它不应成为生产必需能力，更不能作为稳定免拦截方案。[当前实现](../../../internal/platform/browser/recover.go) 第 34～41 行。
5. **减少无效访问**。单来源受控排队、相同检索复用结果、列表只留一次证据、采用候选才进入详情、按候选数量停止。429 的等待按服务端提示；没有提示时使用可配置退避，不宣传某个固定秒数是官方安全频率。
6. **持续不可用时仍交付过程说明**。依照现有知识，使用经授权取得的官方网签材料或经纪机构台账核实，并保留来源与复核记录。挂牌不能直接当成交；证据不足时给阶段结果或阻断原因。批量取数需求应先向平台确认授权或合作数据渠道。

## 建议修复顺序与验收

| 顺序 | 修复范围 | 必须能证明的验收结果 |
| --- | --- | --- |
| 1 | 金额单位、提前完成 | `200万` 归一化为 `2000000元`；搜索成功后项目仍可进入后续计算，未校验交付不会完成 |
| 2 | 单链家门禁、真实页面搜索 | 贝壳不可用不阻塞；不同城市/小区的 URL 来自真实搜索操作；分页沿实际链接 |
| 3 | 现有知识路由与格式 | 实际导出的非空正文可唯一命中；规则带章节出处；模板索引可解析；本地镜像身份和清单正确 |
| 4 | 验证、限流、断点恢复 | 挑战出现不会三次连抓；任务不串项目；人工通过后核验原页面；重启后能恢复非凭据断点 |
| 5 | 详情、截图、候选账 | 正式图对应单套详情；不同房源不被误合并；补搜保留前轮候选；每来源统计独立 |
| 6 | 来源汇总与最终交付 | 多阶段、多方案索引不相互覆盖；错误空间/正文摘要不符不能通过；重算与报告数字勾稽 |

测试需要覆盖真实模块间的数据传递。例如当前 DOM 测试断言抽取总价为 `998`，却没有继续断言标准化应为 `9980000`；恢复测试中的模拟 CLI 常只消耗一次尝试，未覆盖真实 CLI 一次消耗两次且零冷却的组合。单模块测试通过不能证明完整工作流正确。

## 本轮验证记录

- 只读诊断调用实际目录解析、镜像加载、规则和索引解析，确认市场法路由、模板索引和单链家要求的断言失败。没有改知识库或调用真实登录/取数。
- 注入页面及 CLI 替身，复现金额单位、重复挑战取页、错误恢复 URL、提前终态、错误去重、导航页空结果和详情身份漏检。
- 连续调用真实知识物化函数，复现来源汇总覆盖，以及返回 `ok:true`、落盘 `ok:false` 的差异。
- 最终相关 Node 测试：**503 项通过，0 失败**。命令在插件目录执行：

  ```bash
  node --test --test-timeout=15000 tests/unit/host/host-valuation*.test.mjs \
    tests/unit/client/client-valuation*.test.mjs \
    tests/unit/shared/valuation*.test.mjs \
    tests/integration/report-evaluation/valuation-deliverable-chain.test.mjs
  ```

- `npm run typecheck` 通过；`go test ./internal/platform/browser ./internal/transport/cli` 通过。
- 审查期间前端测试被其他工作更新：首次扩大运行出现 13 项失败和未退出进程；重新运行后全部通过。最终结论使用复跑结果，先前失败不作为当前缺陷数量。
- 本轮未执行完整 `make plugin-check`、构建发布、真实链家取数或员工环境验收。测试通过与这些业务缺陷并存，报告不声称已经修复。
