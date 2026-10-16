# 0.0.45 验收矩阵：通用估值入口与可选登录（协议 39）

> [!NOTE]
> **状态：验收记录（插件 0.0.45 / 协议 39）。** 本文承接
> [`acceptance-0.0.42.md`](acceptance-0.0.42.md) 与 [`acceptance-0.0.43.md`](acceptance-0.0.43.md)，
> 只列**协议 39 新增或改判**的验收点，每条都对应到"删掉它，错的东西就能通过"的那一处强制点。
> 0.0.42 / 0.0.43 里被这一代改判的行已按仓库口径标 `⟪协议39改判作废⟫`，原文保留不改写。
> 现行入口见 [`README.md`](../README.md) 与 [`development-notes.md`](development-notes.md)。

## 怎么读这张表

- **强制点**是"删掉它，错的东西就能通过"的那一处，用 `「…」` 引用**断言原话**；
  守卫 `tests/unit/host/host-acceptance-matrix.test.mjs` 会把每句原话拿回测试源码里找一遍。
- 表里只列**可自动核**的部分；需要真机 / 真网络 / 人工的，在最后一节单独列，不写成"已满足"。
- 行首带 `⟪…⟫` 标记的行是**历史记录**，守卫只对**未标记**的行要求"引用的断言原话逐字存在"。

## 1. 通用估值页与输入交接（设计稿 §3）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 估值直接打开通用页，取消房地产二级导航 | `tests/unit/client/client-valuation-handoff.test.mjs`「估值是一级页：没有房地产二级导航，资产类型改在页面里选」 | 员工要先点一个"房地产"二级页签才能开始，页面暗示还有别的资产入口但点不进去 |
| 资产类型初始为空，未选不能确认 | `tests/unit/client/client-valuation-pane.test.mjs`「资产类型：初始为空、未选不能确认、只认已登记取值」 | 未确认的资产口径被写进冻结输入，报告里出现一个用户没选过的资产类型 |
| 资产类型是**稳定业务标识**，显示文案不承担路由 | `tests/unit/shared/valuation-project-contract.test.mjs`「Schema 版本常量集中在合同里（不在各处硬编码字符串）」+ `assets` 侧 `ASSET_TYPES` 断言 | 改一个中文显示名就把路由改坏，而类型系统不会拦 |
| 四种方法全部开放 | `tests/unit/client/client-valuation-pane.test.mjs`「方法：四项全部可选（适用性由本轮业务规范判断，界面不预先禁用）」 | 知识库补一章之后 UI 不跟着生效；员工以为"这个方法不能选" |
| ⟪面板重构改判作废⟫页面顺序：资料 → 共用条件 → 资产类型与方法 → 能力区 → 确认 | `tests/unit/client/client-valuation-pane.test.mjs`「输入页：资产类型下拉 + 方法四项全部可选 + 能力区；补充要求带 4000 上限」 | 能力状态挤在资料之前，员工先看到一个与当下无关的门禁结论 |
| 资产类型进冻结输入与输入摘要 | `tests/unit/host/host-valuation-handoff.test.mjs`「输入摘要只覆盖资产类型 + 有序清单 + 方法 + 基准日 + 补充要求 + Schema 版本；绝对路径不进摘要」 | 换了资产类型还按旧摘要启动，交接这一层拦不住 |

## 2. 链家登录从门禁改为可选能力（设计稿 §3.2 / §5.1）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 进估值页不自动探测站点 | `tests/unit/client/client-valuation-handoff.test.mjs`「进页面不做任何来源探测；打开确认抽屉时才独立查一次」 | 没登录的员工连资料都整理不了，首帧还要先等一次与当下无关的探测 |
| 未登录也能填完并启动 | `tests/unit/client/client-valuation-handoff.test.mjs`「未登录也能填完并启动；来源状态只在能力区如实展示」 | 一个未登录的来源把整页锁死；父会话永远拿不到来源策略 |
| 能力状态带检查时刻，缺失显示"尚未检查" | `tests/unit/client/client-valuation-scope.test.mjs`「能力区检查中：等待文案 + 主按钮 disabled/aria-busy；长等待给说明但不假报失败」 | 一次检查成功被当成整轮始终可用 |
| 未登录 / 未知 / 被挑战的处置各自分开 | `tests/unit/client/client-valuation-handoff.test.mjs`「能力区：被人机验证挡住时给"完成验证"的处置，且不给登录入口」+「能力区的三种状态各有各的话：未登录给登录入口、unknown 只给重新检查」 | 把网络问题说成"没登录"，员工反复重登一个没坏的账号 |
| 能力落点不改页面阶段 | `tests/unit/client/client-valuation-pane.test.mjs`「能力落点：未登录 / 查不出来都**不改阶段**（登录是可选用能力，不是门禁）」 | 登录又被写回门禁，而这一次界面看不出来 |
| 空必需集就是空（不回退成"全部必需"） | `tests/unit/host/host-valuation-browser-client.test.mjs`「站点清单按 CLI 同一口径校验，坏条目整批拒绝」 | 配置改成可选的当天，所有站点静默恢复成硬门禁 |
| 未登录 / 未知不阻断整轮，分类仍分开 | `tests/unit/host/host-valuation-market.test.mjs`「P13 三次失败：登录墙进 needsLogin、unknown 进 unconfirmed —— 两类处置不同，都不阻断整轮」 | 链家未登录就不再去找房天下与 58，整轮停在原地 |
| 交接指令带**来源策略**（逐来源分档 + 原因），不再固定空数组 | `tests/unit/host/host-valuation-lifecycle.test.mjs`「来源策略随交接交给父会话：逐来源分档与原因，且说明登录不阻断」 | 父会话以为"本轮一个来源都没有"，来源不足的结论无从区分是配置坏了还是真没站点 |

## 3. 业务判据回归知识库（设计稿 §4）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 指令不复制方法优先级与案例阈值 | `tests/unit/host/host-valuation-lifecycle.test.mjs`「业务判据搬进 Wiki：指令只留"读哪一份"，不再复制方法阈值与来源顺序」 | 改知识库不再生效：Agent 照着更旧的副本执行，而且两边都不报错 |
| 唯一业务入口是资产 Skill 声明的入口 Wiki | `tests/unit/host/host-valuation-lifecycle.test.mjs`「知识不是"必需项"：没有「必需知识缺失即停止测算」这一档，也不再有 realestate.* 口径」 | 知识入口散落在指令、配置与 Skill 三处，改一处不再够 |
| 指令不假定模板的工作表数量与业务公式 | `tests/unit/host/host-valuation-lifecycle.test.mjs`「指令把每一项交付与技术边界都写出来（少一项子会话就会自己收尾）」 | 换一份模板页签结构就要改通用脚本；或者反过来，通用脚本按七张表去读一份五张表的模板 |
| 无可用计算引擎时不许冒充重算完成 | 同上（`真实重算` 一段） | "表里有公式"被当成"已重算"，partial 被报成 completed |
| 重算记录**可被 Host 证伪**（模型写文件也过不去） | `tests/unit/host/host-valuation-finalize-facts.test.mjs`「模型自写的"重算成功"记录**不能**绕过真实验证：本机没有表格计算程序时判 failed」+「探测不到引擎时，finalize 把"声称重算成功"的记录降级（模型写文件也过不去）」 | 模型写一份 `{state:'recalculated',verified:true}` 就把 `partial` 抬成 `completed` |
| 引擎路径只能由部署显式给绝对路径 | `tests/unit/host/host-yaml-config.test.mjs`「valuation.recalculation.enginePath：缺省空串（= 本部署没有表格计算程序），只接受绝对路径」 | PATH 上的同名命令被当成引擎，算出来的数没人能解释 |
| Wiki 的库内相对链接按**当前文档目录**解析 | `tests/unit/host/host-valuation-wiki-links.test.mjs`「基准是**当前文档所在目录**，不是知识库根」 | 人工粘贴的正文必须先把库内路径改成本机路径或网页地址才能用 |
| 越界 / 绝对路径 / 外部地址 / 纯锚点分别报告 | `tests/unit/host/host-valuation-wiki-links.test.mjs`「不许逃出知识库根，也不接受绝对路径」+「parseWikiLinks 区分四类目标，并保留原始 target」 | 一条坏链接被静默丢掉，或者被当成库外文件读 |
| 链接随正文条目一起交给会话（下一跳依据） | `tests/unit/host/host-valuation-knowledge.test.mjs`「正文里的库内相对链接被解析出来（Agent 的下一跳依据），外部与越界如实分类」 | Wiki 写了导航但 Agent 看不到，于是自己猜下一步读什么 |
| 入口 Wiki 进配置且校验严（绝对路径 / `..` / 空串一律拒） | `tests/unit/host/host-yaml-config.test.mjs`「wikiPath 采用配置里的库内相对路径，且绝对路径 / .. / 空串一律拒绝」 | 配置把业务入口指到知识库外面 |
| 结果交出 `entryWikiPath`，走遗留 manifest 链路时有迁移提示 | `tests/unit/host/host-valuation-knowledge-tool.test.mjs`「入口 Wiki 是协议 39 起的唯一入口：结果里给出 wikiPath，并提示遗留的 manifest 链路」 | 换入口这件事只写在设计稿里，运维看不见；旧链路静默继续 |

## 3.1 多方法与真实计算口径（协议 39 续）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 物业类型不再是代码白名单 | `tests/unit/shared/valuation-project-contract.test.mjs`「物业类型不再是代码白名单：商业 / 办公不当场判"不支持"，分类归知识判定」 | 一个业务分类问题被写成"软件不支持"，而真实原因是资料不足以分类 |
| 方法能不能跑是能力事实，不当场阻断整方案 | `tests/unit/shared/valuation-project-contract.test.mjs`「收益法 / 成本法：能力事实如实报"跑不了"，但**不当场阻断整方案**」 | 缺一个方法的模板就让整轮估值停摆 |
| 实测能力清单可覆盖部署默认 | `tests/unit/shared/valuation-project-contract.test.mjs`「实测的能力清单可以覆盖部署默认（知识补齐后不必改业务口径代码）」 | 知识补了一章还要发一次版 |
| 自动判断可采用**组合**方法 | `tests/unit/host/host-valuation-project.test.mjs`「自动判断可采用**组合**方法：适用且能跑的方法全部被采纳，不再只取第一个」 | 知识要求两种方法互相校核，实际只跑一个 |
| 用户指定方法不静默增补 | `tests/unit/host/host-valuation-project.test.mjs`「用户指定方法时**不静默增补**其它方法（即使它们也能跑）」 | 用户指定市场法却拿到两个方法的组合结论 |
| 缺一方法不误伤其他方法 | `tests/unit/host/host-valuation-project.test.mjs`「知识要求两种方法而只实现一种：跑得了的照跑，跑不了的记能力缺口（不误伤、不称业务不适用）」 | 能力缺口被写成"业务不需要"，或者把整方案拖死 |
| 组合方法各建一个任务 | `tests/unit/host/host-valuation-project.test.mjs`「组合方法各建一个任务（不再只按 primaryMethod 建）」 | 组合方法只有一个任务，第二个方法的依据与产物无处落 |
| ⟪协议40改判作废⟫多方法结果必须逐方法留痕 + 给协调记录 | `skills/.../scripts/test_valuation_contracts.py`「test_multi_method_result_needs_per_method_records_and_coordination」 | 结果里只留一个数，另一个方法的依据不可复核 |
| 加权必须有依据（不许默认平均） | 同上（`weights` 缺 reason 时判红） | 两个方法被悄悄平均成一个数 |
| 报告印出逐方法结果且不相加 | `skills/.../scripts/test_report_render.py`「test_the_page_shows_a_per_method_result_table」 | 读者以为多方法被加权或相加了 |

## 3.2 来源阶梯与检索预算（协议 39 续）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 58 同城进来源枚举与站点定义，域名白名单逐来源判 | `tests/unit/host/host-valuation-site-parsers.test.mjs`「每个来源的模板都还在自己那一家的域名内（模板写错就是白名单漏口）」 | 模板写错落到别人家域名上，或"加了枚举"就当加了适配器 |
| 适配器依据可核对（归档字节 vs 公开路径约定） | `tests/unit/host/host-valuation-market-tool.test.mjs`「适配器依据随结果交出：没有归档字节的来源必须如实报"尚未真机验收"」 | 没验收的来源被当成可用，0 命中被写成"这个小区没有房源" |
| 依据随来源策略交给父会话 | `tests/unit/host/host-valuation-lifecycle.test.mjs`「来源策略随交接交给父会话：逐来源分档与原因，且说明登录不阻断」 | 父会话不知道 58 还没验收，于是把缺口写成业务结论 |
| 10 页 / 20 条上限，任一触顶即停 | `tests/unit/host/host-valuation-budget.test.mjs`「上限就是已确认的业务口径：10 页 / 20 条」+「候选先满 20 条就在页数没到 10 之前停」 | 上限只写在提示词里，模型可以一直翻 |
| ⟪协议42改判作废⟫换词 / 重复调用 / 恢复都不重置预算 | `tests/unit/host/host-valuation-budget.test.mjs`「预算与关键字无关：换词读到的是同一份账」+ `host-valuation-market-tool.test.mjs`「预算：换关键字**不**重置」+「页数与候选数都是 Host 持久记录的上限，触顶即停」 | 换一个关键词就是无限翻页的旁路 |
| 同源重复条目不算新候选 | `tests/unit/host/host-valuation-budget.test.mjs`「同源重复条目不算新候选」+ `host-valuation-market-tool.test.mjs`「翻页上限被夹住」 | 翻同几页重复内容就能刷出额度 |
| 分组 / 轮次不同则各记各的账 | `tests/unit/host/host-valuation-market-tool.test.mjs`「预算：轮次 / 分组不同则各记各的账；同组同轮才累计」 | 出售与租金的预算互相挤占，或换分组绕过上限 |
| 来源不覆盖 ≠ 输入非法 | `tests/unit/host/host-valuation-market-tool.test.mjs`「P7：城市不在来源覆盖范围 → **逐来源**记状态、跳过该来源，不把整个输入判非法」 | 链家不做这个地区就被写成"你的输入非法"，替代来源没机会跑 |
| 城市解析的四种状态分开 | `tests/unit/host/host-valuation-city.test.mjs`「城市不在公布列表里 → **not-covered（该来源不覆盖）**」+「解析不出来（网络失败 / 页面改版）→ unavailable」 | 网络抖动被写成"没有这个城市"，或反过来 |
| 绝不擅自换城市 | 同上（`urls.some(one => one.includes('ershoufang')) === false`） | 用错城市的房源池选可比案例，而结果看起来完全正常 |

> ⟪协议42改判作废⟫说明：旧"原始行数就是候选上限"已改判。当前合格预算只计知识合格且事实合格的记录，未评估的原始候选全部返回但不占合格名额，由 `host-valuation-market-tool.test.mjs` 的 `协议 40：未经知识评估的原始候选全部返回，合格预算不因原始条数增加` 与 `协议 40：复用同查询快照时只按事实合格的 qualified 计合格预算` 强制。

## 3.3 少案例、候选编号与新版复算（协议 39 续）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 候选编号由 Host 发且**只增不重用** | `tests/unit/host/host-valuation-revision.test.mjs`「编号只增不重用：新身份接着发号，旧身份沿用原号」 | 用户说的"3 号"指向另一条房源，而系统照着他没看过的那条重算 |
| 换关键字重搜不重排编号 | 同上「换关键字重搜不会重排编号：同一套房源拿到同一批号」 | 换一个词就把编号打乱，会话里的引用全部失效 |
| 未知 / 已退休编号分别报，不静默忽略 | 同上「用户编号只在方案内有效：未知 / 已退休编号单独报，不静默忽略」 | 用户写了错的编号却被当成"没有选择"或选到别的房源 |
| 新版本 pending，**不动当前指针** | 同上「新版本一出生是 pending：核对通过之前不动当前指针」 | 半成品被当成正式结论 |
| 重复提交幂等 | `tests/unit/host/host-valuation-revision-tool.test.mjs`「op=recompute：同一提交重复调用幂等（双击 / 超时重试不叠版本）」 | 双击一次留下两份一模一样的修订 |
| 每个版本有自己的交付件目录（旧版可读） | 同上「op=recompute：建 pending 版本、不动当前指针、旧版目录不被覆盖」 | 新版覆盖旧版，上一版的依据永久消失 |
| 提升必须过 Host 的完成判定；失败回滚 | 同上「op=promote：缺交付件时把该版标 failed，当前指针留在上一版（回滚）」 | 没有交付件的版本被挂成当前版 |
| 旧版本转 `superseded` 且保留记录 | `tests/unit/host/host-valuation-revision.test.mjs`「只有核对**本版**的回执才能提升；提升会把上一版标成 superseded 并保留」 | 旧报告与旧底稿不可查 |
| 指令写明按编号选例与旧版保留 | `tests/unit/host/host-valuation-lifecycle.test.mjs`「少案例与用户复算：指令写明按编号选例、建新版本、旧版保留」 | 行为只存在于对话里，换一个会话就没人知道该怎么复算 |

## 3.4 模板契约由模板自己的填写说明驱动（协议 39 续）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 换一份模板不必改脚本 | `skills/biz/crwu-biz-valuation-realestate/scripts/test_valuation_contracts.py` 的 `GenericWorkbookContractTest.test_a_different_template_shape_passes_without_touching_the_script` | 模板一换就得改脚本，等于"只支持随包那一份" |
| 描述文件能自动发现（不必带 `--contract`） | 同上 `test_sidecar_contract_is_discovered_without_a_flag` | 部署时忘带参数就退回内置 profile，静默按错的契约判 |
| 不强制表顺序 | 同上 `test_order_is_not_enforced_unless_declared` | 表顺序一变就被判不合格（顺序不是正确性） |
| 模板指纹按**实际字节**核对 | 同上 `test_template_digest_is_checked_against_the_real_bytes` | 自报的指纹被当成事实 |
| 受控写入：输入位不许是公式 | 同上 `test_input_cell_must_not_be_a_formula` + `BuildWorkbookContractTest.test_input_cell_still_rejects_a_formula_and_keeps_emptiness_empty` | 结论被硬编码进输入区 |
| 公式保护不依赖声明 | `BuildWorkbookContractTest.test_formula_protection_holds_in_both_channels` | "记得别覆盖公式"是记不住的 |
| 结果位空着就是缺口 | `GenericWorkbookContractTest.test_empty_result_cell_is_a_gap_not_a_pass` | 汇总没有结论却当成通过 |
| 公式区不能退化成常量 | 同上 `test_formula_role_sheet_without_any_formula_is_caught` | 模板看起来还在，其实已是空壳 |
| 空值不填零、单位一致 | 同上 `test_zero_is_not_empty_and_units_must_agree` | 空值被写成 0（0 是结论）；一处元一处万元 |
| 契约读不出来时不猜 | 同上 `test_broken_descriptor_fails_instead_of_passing` + `BuildWorkbookContractTest.test_unreadable_contract_does_not_guess_the_input_area` | 读不出来就当通过 / 猜一个输入区 |

## 3.5 真实重算的执行与回读（协议 39 续）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 引擎路径只来自部署配置，空串 = 没有引擎 | `tests/unit/host/host-valuation-recalculation.test.mjs`「引擎路径只来自部署配置：空串 = 没有引擎，绝不扫 PATH」 | 扫 PATH 猜一个程序，算出来的数与"没人算过"一样不可信 |
| 引擎命令由 Host 拼（模型提交不了路径） | 同上「引擎命令由 Host 拼：固定参数 + 只把底稿与临时目录写进去」 | 模型能指挥任意可执行文件 |
| 没有引擎时不写"算过了"的记录 | `tests/unit/host/host-valuation-recalculate-tool.test.mjs`「没有配置表格计算程序 → unavailable + verified:false，并写明只能 partial」 | `unavailable` 被写成 `recalculated`，报告被抬成 completed |
| Host 不猜数值位置 | 同上「没给「对象 → 数值位置」时拒绝：Host 不猜格子」 | 猜错格子 = 拿别的数当结论 |
| 真实跑引擎 + 回读，各走命名操作 | 同上「有引擎时真的跑：引擎与回读各走一条命名操作，回读一致 → verified」 | "重算"只存在于文字里 |
| 不一致就不许 verified，差异逐项留下 | 同上「回读值与报告数据不一致 → verified:false 并把逐项差异写进记录」+「回读读不到该对象 → 也算不一致」 | "读不到"被当成"对得上" |
| 引擎失败如实报 failed | 同上「引擎失败 → failed + 记录写明原因」 | 失败被写成成功 |
| 回读脚本读缓存值；公式无缓存值单独报 | `skills/biz/crwu-biz-valuation-realestate/scripts/test_valuation_contracts.py` 的 `ReadWorkbookValuesTest` | "公式在、缓存空"被当成"这一项为空"，没重算也算过了 |
| 修订版本 > 1 时重算该版本的底稿 | 同上「修订版本 > 1：重算该版本目录下的底稿，结论也写在该版本下」 | 重算读错版本的文件 |
| 指令写明"没引擎就交 partial" | `tests/unit/host/host-valuation-lifecycle.test.mjs`（重算一段的契约断言） | 模型自己写一份"重算通过" |

## 3.6 manifest 链路退出主通道（协议 39 续）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 按 Wiki 路径读取**不需要** manifest | `tests/unit/host/host-valuation-knowledge.test.mjs`「按 Wiki 路径读取：**不需要 manifest** —— 入口 Wiki 与它的链接逐篇取回」 | manifest 读不到就把整轮业务卡死（旧行为） |
| 入口 Wiki 的链接成为下一跳 | `tests/unit/host/host-valuation-knowledge-tool.test.mjs`「按入口 Wiki 读取：**不需要 manifest**，正文里的 links[] 带回给会话当下一跳」 | 会话只能读槽位表允许的那几份，业务侧的导航失效 |
| 路径只按完整路径匹配（无前缀 / 模糊） | 取数层「Wiki 路径只按完整路径匹配：没有这条路径就是 missing，不做前缀 / 模糊匹配」 | 猜出来的路径安静地取到另一份规范 |
| 绝对路径 / 越界 / 未知后缀被拒 | 取数层「Wiki 路径不可用（绝对路径 / 越界 / 未知后缀）→ input 错误，不取任何正文」+ 工具参数面断言 | 路径跳出知识库根，或按二进制读回乱码 |
| 两条通道同时给时逐条都取并说明 | 取数层「两条通道同时给：逐条都取，并说明这一轮有两条来源」 | "都取了"只是一句话 |
| 落盘段名不因路径分隔符散架 | 取数层（同一用例里的快照路径断言） | 快照按库内目录结构散落，按路由隔离失效 |
| 遗留通道取正文时有迁移提示 | 工具层「入口 Wiki 是协议 39 起的唯一入口：结果里给出 wikiPath，并提示遗留的 manifest 链路」 | 维护者不知道入口已经换了 |

## 3.7 候选的批量筛选与优选（协议 39 续）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 名额 / 优先级 / 渠道顺序只来自知识 | `tests/unit/host/host-valuation-select.test.mjs`「缺名额 / 缺顺序 / 缺渠道顺序一律拒绝（代码里没有默认值）」 | 代码里出现"惯例 3"这样的隐形阈值 |
| 挂牌 / 无证据硬性排除，且不许凑数 | 同上「挂牌 / 询价不能直接作可比实例；没有页面证据的也不能」+「硬性排除的案例**不会**因为名额没满被启用」 | 名额不够时拿挂牌价当成交价用 |
| 排序确定（同一批输入同一批入选） | 同上「逐级比较与名额截断：面积最接近的先入选，落选理由具体到名次与名额」（含换序复算断言） | 每次调用选出不同的案例，稳定编号失去前提 |
| 落选理由具体到名次与名额 | 同上 | "没选上"没有理由，用户无法判断要不要纳入 |
| 筛选不改动候选清单 | `tests/unit/host/host-valuation-market-tool.test.mjs`「择优：名额由知识给（代码里没有默认），入选/落选/理由随结果交出，且不改动 cases」 | 相近未达标的候选被筛掉，用户再也选不到 |
| 缺名额时在发请求之前拒绝 | 同上（用例 ③） | 发了一轮请求才发现规则不全 |
| 指令写明照抄知识取值 | `tests/unit/host/host-valuation-lifecycle.test.mjs`（择优一段的契约断言） | 模型自己编一个名额 |

## 3.8 各来源独立解析地区（协议 39 续）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 城市表逐来源登记（页 / 进 URL 的方式 / 依据 / 是否已适配） | `tests/unit/host/host-valuation-city.test.mjs`「城市表逐来源登记：只有链家已适配，其余如实标"尚未适配"（含依据与来源页）」 | 把链家公布的列表当成所有来源的映射，在别家上"解析成功但指向另一个城市" |
| 已适配 ⇔ 有归档依据 | 同上（`adapted === (evidence === 'archived-capture')`） | 只有公开路径约定的表被当成已适配 |
| **不覆盖**与**尚未适配**分开说 | 同上「只有**自己那份表已适配**才谈得上「该来源不覆盖这个地区」」+ 工具层「P7：城市不在来源覆盖范围 → **逐来源**记状态、跳过该来源，不把整个输入判非法」 | 员工以为"58 不覆盖北京"，其实只是没适配这张表 |
| 城市标识的来源可核对 | 同上「解析成功时所有来源都能用；结论里带上标识是哪来的」+ 工具层 `citySourcePage` / `citySourceEvidence` 断言 | 报告说不清"这个 bj 是哪来的" |
| 未登记城市表的来源说"还没登记" | 同上「没有登记城市表的来源说"还没登记"，不借用别家的覆盖范围」 | 借用别家的覆盖范围，把"我们没接"写成"这家不做" |
| 输入非法 / 城市表读不出来不写成"不覆盖" | 同上「providerCityStatus：输入非法 / 城市表读不出来对每个来源都是同一件事」 | 网络抖动被写成"这家不做这个地区" |

## 3.9 少案例：参考结论与"没有结论"（协议 39 续）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 1~2 条可核案例 + 有依据 → 仍给参考结论 | `test_calculate_market.py`「too_few_adopted_cases_still_gives_a_reference_number」 | 数量一少就把金额清空，复核的人看不到任何可比信息 |
| 参考结论必须显式标记并写清差几条 | 同上（`provisional` / `provisionalReason` / 限制段三处断言） | 参考值被当成正式结论交付 |
| 缺额进 `ruleChecks` | 同上（`market.comparables.min-adopted` 记 `passed: false`） | 规则层看起来全过，只有读限制段才知道没过 |
| 一条可用依据都没有 → 不给金额 | 同上「no_usable_case_at_all_gives_no_number」 | 没有依据也凑出一个数字 |
| 挂牌价被排除但不因此清空 | 同上「listing_price_cannot_be_a_comparable_case」 | 挂牌被排除后直接没结论（旧行为） |
| 案例单价必须为正 | 同上「missing_or_non_positive_case_price_is_rejected」 | 0 元单价算出一个 0 元"比准价格" |
| 生产计算入口在门禁里 | `Makefile` 的 `plugin-check` 目标（`test_calculate_market.py` 一行） | 生产入口 17 条契约长期不执行 |

## 3.10 门禁：干净机器上 `make plugin-check` 通过（协议 39 续）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 运行时缓存根不算"引用缺失" | `skills/crwu/crwu-dev-audit-skill-maintainer/scripts/test_audit_skill_maintainer.py`「skill_path_lint_exempts_runtime_knowledge_cache_roots」 | 一份没跑过审核的技能副本判自己不合格，门禁在任何干净机器上都是红的 |
| 未登记层下的本地路径仍然拦 | 同上「skill_path_lint_still_flags_a_missing_local_knowledge_path」 | 把正文当本地文件引用（正文一律实时取回，不缓存）被放过 |

## 4. 需要真机 / 真网络 / 人工的部分

以下条目**不能**由离线测试证明，必须在员工授权环境验收一次；在此之前不写成"已满足"：

| 项目 | 为什么离线测不了 | 验收动作 |
| --- | --- | --- |
| 链家 / 房天下 / 安居客真实检索与详情取证 | fixture 是按实测选择器**构造**的脱敏 DOM，不是线上字节 | 在已登录 profile 上跑一次真实检索 + 详情截图 |
| **58 同城适配器** | 已实现站点定义 + 来源枚举 + 依据登记，但 URL 模板与选择器**只有公开路径约定**（`public-pattern`），没有归档字节 | 在授权环境跑一次真实检索：核对 58 的列表 URL、分页参数与列表 DOM / JSON-LD 结构，把 `evidence` 升为 `archived-capture` 并补一份真实 fixture |
| 房天下 / 安居客适配器 | 同上：`public-pattern`，从未在授权环境跑通一次 | 同上（逐来源各跑一次） |
| 各来源独立城市表 | 登记表与判定已实现（§3.8）：只有链家是 `adapted: true`（有归档字节），其余三家如实记"尚未适配" | 在授权环境分别取一次安居客 / 58 同城 / 房天下的城市列表页（或城市取值表），补实测依据并把 `adapted` 置真 |
| 检索预算 | 上限、持久化与"换词不重置"都有离线回归；真机上还需一次多轮取数确认落盘与触顶表现 | 真机验证触顶、换词、验证码恢复后的累计 |
| 跨站去重与最终优选 3 条 | 需要三家真实数据 | 真机核对去重与剔除记录 |
| 可见人机验证的真实恢复 | 离线只证明"挑战识别 → 调固定脚本 → 回读页面"这条接线 | 遇到真实挑战时确认自动尝试与 waiting-user 断点表现 |
| 多方法**真实计算**与协调 | 覆盖门禁、`auto` 多选、任务图按方法、结果 Schema 与校验器都已改判（见 §3.1）；但收益法 / 成本法的**模板与计算能力**仍未验收 | 需要先交付并验收收益法 / 成本法模板与受控计算，才能真跑组合方法 |
| 模板真实重算回读 | 执行链路已接通（命名操作 + 引擎转换 + 回读脚本 + Host 写结论）；**本机没有安装任何表格计算程序**，所以真机验证还没做 | 在部署里指定一个真实的 LibreOffice / Excel（`valuation.recalculation.enginePath`），跑一次真实底稿确认转换与回读 |
| 少案例结论与按编号复算新版 | 编号册、修订索引与提升判定都已实现（见 §3.3）；真机上还需一次多轮取数 + 用户选例的完整演练 | 真机走一遍"取数 → 列相近候选 → 用户说加入 2 号 → 新版 → 提升 → 旧版仍可读" |
| 业务知识正文发布 | 正文由业务负责人维护，本仓看不到线上内容 | 按交付目录把 `wiki.md` 与各方法正文粘贴上线，并核对入口链接 |
