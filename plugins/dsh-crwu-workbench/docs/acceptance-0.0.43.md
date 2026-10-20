# 0.0.43 验收矩阵：房地产估值"确认即交接"（协议 35）

> [!NOTE]
> **状态：验收记录（插件 0.0.43 / 协议 35）。** 本文承接
> [`acceptance-0.0.42.md`](acceptance-0.0.42.md)，只列**协议 35 新增或改判**的验收点，
> 每条都对应到"删掉它，错的东西就能通过"的那一处强制点。
> 现行入口见 [`README.md`](../README.md) 与 [`development-notes.md`](development-notes.md)；
> 设计稿 §16 的完整清单仍在 0.0.42 那份里，本文不重复。

## 怎么读这张表

- **强制点**是"删掉它，错的东西就能通过"的那一处，用 `「…」` 引用**断言原话**；
  守卫 `tests/unit/host/host-acceptance-matrix.test.mjs` 会把每句原话拿回测试源码里找一遍。
- 表里只列**可自动核**的部分；需要真机 / 真网络 / 人工的，在最后一节单独列，不写成"已满足"。
- 行首带 `⟪…作废⟫` 标记的行是**历史记录**：它逐字引用的用例名后来改名了（本仓口径是保留原文只加标记，
  不改写历史叙述）。守卫只对**未标记**的行要求"引用的断言原话逐字存在"。
  本表的 `⟪重试上限收敛作废⟫` 指同页重试上限由 3 降为 2。

## 1. 启动页、门禁与"只创建一个父会话"（设计稿 §4 与 §5）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| ⟪协议39改判作废⟫二级目录仍叫「房地产」，页面写明只支持住宅市场法 | `tests/unit/client/client-valuation-handoff.test.mjs`「二级目录仍叫「房地产」，页面正文写明当前只支持住宅市场法估值」 | 页面暗示支持收益法 / 成本法，员工按未实现的路径走 |
| ⟪协议39改判作废⟫门禁只拦房地产正文，其他二级目录照常可用 | `tests/unit/client/client-valuation-handoff.test.mjs`「未登录时房地产正文被拦，但目录切换 / 报告评估 / 报告审核 / 环境信息照常可用」 | 一个未登录的估值来源把整个工作台锁死 |
| ⟪协议39改判作废⟫加载即显示"正在检查登录状态"，不预画未登录空态 | `tests/unit/client/client-valuation-handoff.test.mjs`「加载即显示「正在检查案例来源登录状态」，不预画未登录空态」 | 界面先骗人一次，员工以为本来就不能用 |
| ⟪协议39改判作废⟫只有 authenticated 释放正文；unknown 只给原因与重新检查 | `tests/unit/client/client-valuation-handoff.test.mjs`「authenticated 才释放正文；unauthenticated 给中性登录按钮；unknown 只给原因与「重新检查」」 | 把网络问题说成"没登录"，员工反复重登 |
| ⟪面板重构改判作废⟫ 递归整理后的文件数才是依据（1–30），0 份不能启动 | `tests/unit/client/client-valuation-handoff.test.mjs`「递归整理后的文件数才是依据（不是选中的目录数）；>30 整批阻止；0 份不能启动」 | 界面按目录数放行，实际复制 200 份 |
| 30 份通过 / 31 份整批阻止且一份都不复制 | `tests/unit/host/host-valuation-handoff.test.mjs`「资料份数：30 份通过；31 份**整批阻止**且一份都不复制」 | 悄悄截取前 30 份，员工以为全算进去了 |
| 同名不同路径 / 重复内容都能分辨 | `tests/unit/host/host-valuation-handoff.test.mjs`「同名不同路径保留两条：归档按 -2 改名，fileId 能分辨」 | 两份资料被当成一份，其中一份永远没被读 |
| createdAt 取不到时是 null，不拿 mtime 冒充 | `tests/unit/host/host-valuation-handoff.test.mjs`「元信息逐条完整；createdAt 取不到时是 null（不许拿 mtime 冒充）」 | 界面显示一个看起来可靠的假创建时间 |
| 抽屉只展示文件元信息与三个用户输入 | `tests/unit/client/client-valuation-handoff.test.mjs`「确认抽屉只展示文件元信息与三个用户输入：没有知识库状态 / 字段 / 冲突 / 完整提示词 / 取证 / digest」 | 抽屉变成一份没人核对的运行看板 |
| ⟪面板重构改判作废⟫主页面「确认」、抽屉「开始估值」/「返回修改」 | `tests/unit/client/client-valuation-handoff.test.mjs`「主页面唯一 primary 逐字是「确认」；抽屉主操作逐字是「开始估值」、次操作是「返回修改」」 | 文案漂移，验收口径与实现脱钩 |
| 双击 / 超时重试只建一个父会话 | `tests/unit/host/host-valuation-handoff.test.mjs`「并发两次 handoffProject（双击）只建 1 个会话、只发 1 条指令」 | 一次确认留下两条空会话，资料算两遍 |
| 摘要不一致 / 归档被篡改时强制重新确认 | `tests/unit/host/host-valuation-handoff.test.mjs`「归档副本被篡改 → 强制重新确认（绝不按旧摘要启动）」 | 按被改过的输入算，而结论声称按冻结输入 |
| 交接成功即打开父会话，且不再有完成度请求 | `tests/unit/client/client-valuation-handoff.test.mjs`「交接成功：提示后立即打开父会话（顶层 openSession，不是 openSubagent），且不再有 status/result 请求」 | 面板继续轮询，删掉页面却留着后台请求 |

## 2. 项目 / 方案 / 对象与执行调度（设计稿 §7 与 §9）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 同小区同口径三套住宅同方案但三个对象 | `tests/unit/host/host-valuation-project.test.mjs`「同小区同口径三套住宅可以同方案，但仍是三个对象」 | 三套房合成一个"平均对象"，逐对象结论丢失 |
| 住宅 + 商业必须拆方案 | `tests/unit/host/host-valuation-project.test.mjs`「住宅 + 商业必须拆方案：合在一个方案里就是 incompatib​le-field 冲突」 | 商业用房套住宅参数算出一个像样的数 |
| 权益 / 基准日不同不自动合并 | `tests/unit/host/host-valuation-project.test.mjs`「同小区但权益/基准日不同就是冲突，不自动合并」 | 两套不同权益的房子共用一个价值内涵 |
| 业务不适用 ≠ 当前未实现 | `tests/unit/host/host-valuation-project.test.mjs`「业务适用但未实现：能力缺口 ≠ 业务不适用」 | 能力缺失被写成"业务上不需要"，结论看起来完整 |
| 用户指定方法不可静默替换 | `tests/unit/host/host-valuation-project.test.mjs`「用户指定 market 而知识判定不适用：记冲突、请确认，不改用别的已实现方法」 | 用户要市场法，交付的却是另一个方法且不说明 |
| 房地分别评估生成有依赖的任务图 | `tests/unit/host/host-valuation-project.test.mjs`「separate 生成土地/建筑物/汇总任务与依赖，土地能力不存在 → 阻断该方案」 | 土地与建筑物各算一遍，合计时重复计价 |
| land-and-building 与 land-only 不许相加 | `tests/unit/host/host-valuation-project.test.mjs`「land-and-building 与 land-only 相加必须被拒绝（重复计价）」 | 同一块土地价值被算进两个方案再相加 |
| 状态未知 / 资源不足 → 父会话顺序执行 | `tests/unit/host/host-valuation-execution.test.mjs`「状态未知 → sequential（资源是不是真的空闲无从确认）」 | 在没有依据的情况下开并发，同一资料被两个执行者算 |
| 启动结果未知时父会话不许接手重算 | `tests/unit/host/host-valuation-execution.test.mjs`「子会话创建失败 → 租约保留未知状态（父会话不许接手重算）」 | 同一个方案写出两份都"正常"的结论 |
| 重复调度不会把同一任务排两遍 | `tests/unit/host/host-valuation-execution.test.mjs`「父会话拿到的一批任务**真的**进了租约：重复调度不会排第二遍」 | 模型重试一次调度就把方案算两遍 |
| 子会话可见性回读不过就停掉它 | `tests/unit/host/host-valuation-execution.test.mjs`「状态健康 + 多方案 → 有界并行；创建后回读可见性不过就停掉并留在未知状态」 | 子会话看不见必需工具，跑出来的结论不可复核 |
| 父会话没给结论不算做完 | `tests/unit/host/host-valuation-execution.test.mjs`「join：父会话没给结论就不算做完（不许把"没做完"记成"做完了"）」 | 任务被提前释放，后续调度重复执行 |

## 3. 知识与模板（设计稿 §6 与 §10.1）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| ⟪清单路由作废⟫模板必须先物化索引正文才能取 | `tests/unit/host/host-valuation-template-tool.test.mjs`「索引正文物化过才取模板：没有来源记录时说的是"顺序不对"，不是"模板不存在"」 | 顺序问题被写成"知识库没有模板"，员工去改知识库 |
| ⟪清单路由作废⟫只认 published；预留 / 空 / 停用进 nearMisses | `tests/unit/host/host-valuation-template-tool.test.mjs`「只认 published：预留条目进 nearMisses 并说清为什么不是它」 | TODO 标题被当成已发布模板，员工拿到一份填不了的表 |
| ⟪清单路由作废⟫模板字节按索引声明的指纹 / 大小验真 | `tests/unit/host/host-valuation-template-tool.test.mjs`「索引声明的指纹与下载字节不符 → 拒绝（索引过期或下载被改写）」 | 下载被网关改写的字节被当模板打开 |
| ⟪清单路由作废⟫非 xlsx 的响应必须被拦住 | `tests/unit/host/host-valuation-template-tool.test.mjs`「下载到的不是 xlsx（错误页）→ 拒绝，不算取到模板」 | 错误页 / 登录页进案例目录并交给填表脚本 |
| ⟪清单路由作废⟫大小与指纹没声明时只判魔数 | `tests/unit/host/host-valuation-template.test.mjs`「字节验真：大小与指纹声明了就必须对得上；没声明就只判魔数」 | 用"没声明"当"免检"，什么都放行 |

## 4. 取数、能力门禁与人机验证（设计稿 §8）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 方法声明做不到的能力 → 取数前阻断 | `tests/unit/host/host-valuation-market-tool.test.mjs`「能力门禁：知识声明 detail 能力而部署没有对应工具 → 阻断，且一个请求都不发」 | Agent 抓完才发现工具不存在，于是自由试错 |
| 降级能力缺席不阻断取数 | `tests/unit/host/host-valuation-market-tool.test.mjs`「能力门禁：降级能力（重算）缺席不阻断取数」 | 缺重算被当成不能取数，整条链路卡死 |
| ⟪重试上限收敛作废⟫每个分页恰好三次尝试（数调用次数） | `tests/unit/host/host-valuation-market-tool.test.mjs`「检索：每个分页**恰好**三次尝试（数调用次数），三次全败且登录未确认 → 暂停等人，但不算"要登录"」 | 无限重试把站点打到限流，还要员工反复登录 |
| JSON-LD 缺席时用固定选择器兜底 | `tests/unit/host/host-valuation-market-tool.test.mjs`「检索：只有 DOM（无 JSON-LD）→ 固定选择器兜底解析出案例（Agent 不猜选择器）」 | Agent 现场猜选择器 / 直接按标题猜价格 |
| 0 命中报 template-stale，不是"没有房源" | `tests/unit/host/host-valuation-market-tool.test.mjs`「检索：结果页结构在但选择器 0 命中 → template-stale（不是"该小区没有房源"）」 | 结论建立在一个错误的"无案例"事实上 |
| 凭据有效 + 页面被挑战 = 已登录（放行） | `tests/unit/host/host-valuation-browser-client.test.mjs`「门禁：凭据有效但页面被挑战 → 放行，并给出非阻塞的验证提示（不再自动导航）」 | 刚登录成功的员工被挑战挡在工作面之外，还被告知"没通过检查" |
| 凭据过期仍然算未登录 | `internal/platform/browser/verify_test.go`「TestVerifySiteRefusesAnExpiredCredentialEvenWhenThePageIsChallenged」 | 过期会话看起来像已登录，一路跑到取数才发现全废 |
| 可见挑战先调固定脚本，预算有界 | `tests/unit/host/host-valuation-challenge-recovery.test.mjs`「一次调用内部最多做 2 次自动尝试，并在两次之间于队列之外冷却」 | 模型循环重试 / sleep，把站点打到限流 |
| 未恢复保存 waiting-user 断点 | `tests/unit/host/host-valuation-challenge-recovery.test.mjs`「预算用尽后返回 waiting-user 与 nextEligibleAt，不再调用 CLI」 | 一次挑战就让整轮估值失败，员工无路可走 |
| 挑战形态不认识就 unsupported，不硬试 | `tests/unit/host/host-valuation-challenge-recovery.test.mjs`「不认识的挑战形态直接返回 unsupported，不反复重试」 | 拿滑块脚本去试别的挑战，失败原因被误读 |
| 同一个取数任务不能中途换来源 | `tests/unit/host/host-valuation-challenge-recovery.test.mjs`「同一取数任务不能中途换来源」 | 恢复的是 A 房源，证据写成 B 房源 |
| 恢复 Tool 只接业务 ID | `tests/unit/host/host-valuation-challenge-recovery.test.mjs`「工具签名只接业务 ID，不接 URL / 策略 / 脚本 / 输出目录」 | 模型提交任意 URL / 脚本，恢复变成绕过门禁 |

## 5. 交付、方案隔离与完成判定（设计稿 §11）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 方案级交付件互不串档 | `tests/unit/host/host-valuation-finalize-facts.test.mjs`「两个方案不串：plan-002 没落盘时读不到 plan-001 的报告数据」 | plan-002 读着 plan-001 的报告数据并通过校验 |
| planId 不安全时一律当作读不到 | `tests/unit/host/host-valuation-finalize-facts.test.mjs`「planId 不是单段安全标识时一律当作读不到（不退回项目根）」 | 构造一个 planId 就能读到项目根下别的方案的文件 |
| 没有重算记录上限就是 partial | `tests/unit/host/host-valuation-finalize-facts.test.mjs`「没有重算记录 → unavailable（绝不用"底稿里有公式"推断已重算）」 | "有公式"被当成"已重算"，partial 被报成 completed |
| 缺图 / 缺轨迹 / 未重算不许 completed | `tests/unit/host/host-valuation-finalize.test.mjs`「缺图 / 未重算 / 缺计算轨迹 → 一律降到 partial（不能 completed）」 | 模型一句"完成"就升级成正式结论 |
| 借改输入摘要通不过校验 | `tests/unit/host/host-valuation-finalize.test.mjs`「借改输入摘要"让校验通过" → failed（最危险的一种）」 | 结论与员工确认的输入脱钩且无人发现 |
| blocked 分支不要金额也不要工作簿 | `tests/unit/shared/valuation-project-contract.test.mjs`「blocked 分支：必填 stage/blockers/lookupAttempts，conclusion 恒为 null，不要金额也不要工作簿」 | 中断报告里出现一个看着像结论的金额 |
| ⟪协议40改判作废⟫项目汇总不把中断方案金额算进去 | `tests/integration/report-evaluation/valuation-deliverable-chain.test.mjs`「交付链 v3：住宅方案 completed、商业方案 blocked → project=partial，且中断金额不进总价」 | 中断变成"总价更好看"，而报告说这是完成的 |
| 交付校验必须带 planId | `tests/unit/host/host-valuation-artifact-validate.test.mjs`「校验结论与写回**一致**：过了就是 true，没过就是 false + 逐条原因」 | 校验读着项目根的文件，验的是别的方案 |

## 6. 需要真机 / 真网络 / 人工的部分

以下条目**不能**由离线测试证明，必须在员工授权环境验收一次；在此之前不写成"已满足"：

| 项目 | 为什么离线测不了 | 验收动作 |
| --- | --- | --- |
| 链家 / 贝壳真实检索与详情取证 | fixture 是按实测选择器**构造**的脱敏 DOM，不是线上字节 | 在已登录 profile 上跑一次真实检索 + 详情截图（`install/browser-check.mjs` + 会话内取数） |
| 可见人机验证的真实恢复 | 离线只证明"挑战识别 → 调固定脚本 → 回读页面"这条接线；真实滑块未验证过 | 遇到真实挑战时确认自动尝试与 waiting-user 断点表现 |
| **Geetest v4 挑战族未适配（2026-10-14 实测）** | 链家 / 贝壳当前用的是 **Geetest v4**（`gt4.js` + `gcaptcha4` + `geetest_click`/`geetest_slide`，DOM+SVG，无 canvas），而随包固定脚本只适配**极验 v3 canvas**。真实恢复的结论是 `unsupported/challenge-family-unsupported`（**不是** recovered），处置是"请在可见窗口完成验证" | 员工在可见窗口人工过验证一次；若要自动化，需另行为 v4 写探针与策略（本版不做，也不谎称已支持） |
| DWS 业务知识库正文（01/02/03/04/05） | 正文由业务负责人维护，本仓看不到线上内容 | 确认 `realestate.common` 与市场法正文、模板索引、住宅模板都已发布 |
| 商业 / 收益法 / 成本法 | 知识正文与模板未就绪 | 本版预期为 `blocked` + 中断 HTML，不是"算不出来" |
| 土地估值 | 候选技能 `crwu-biz-valuation-land` 未实现 | 房地分别评估的方案预期 `blocked`，且不出现重复计价 |
| 工作簿重算 | 依赖本机 Excel / LibreOffice，仓库不保证存在 | 确认本机有可用重算程序；没有时报告上限为 `partial` |
