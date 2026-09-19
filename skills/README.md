# Skills

独立打包、按技能分目录交付。两类都放这里：

- **提示型（指令）Skill**：目录内一个 `SKILL.md`（含 name/description 元数据），
  教会 Agent 如何驱动 `crwu` CLI 完成某个工作流，不引入新依赖。
- **Python Skill**：目录内自带 `SKILL.md`、`pyproject.toml`、源码、测试与用法文档。

规则：Skill 依赖不进入根 Go 构建，不得成为 `crwu` 二进制的运行时依赖；
变更功能后按 `AGENTS.md` 在 `docs/CHANGELOG.md` 记纪要，并同步相关手册。

| Skill | 类型 | 作用 |
| --- | --- | --- |
| [`crwu-init`](crwu-init/SKILL.md) | 提示型 | crwu 环境**初始化/安装/更新分发器**：确定目标 agent（workbuddy/codex/opencode/deepseek harness，未指定则给选项 workbuddy/codex/deepseek harness）→ 联网核实其 skills 安装目录 → 从 `https://gitee.com/mengdong123/crwu-ai` 拉取 `skills/` → 安装全部/安装指定/更新（同名覆盖含子文件夹）到 agent skills 目录。不改技能正文、不跑业务 |
| [`crwu-h3yun-login`](crwu-h3yun-login/SKILL.md) | 提示型 | H3Yun 员工自助登录：自动开浏览器扫码绑定会话，令牌不进对话（原 `h3yun-login`） |
| [`crwu-h3yun-query`](crwu-h3yun-query/SKILL.md) | 提示型 | 交互式 H3Yun 查询：系统→表单→记录，20 条/页，支持标题关键词查找（原 `h3yun-query`） |
| [`crwu-audit`](crwu-audit/SKILL.md) | 提示型 | 报告审核能力族**总路由**（≤300 行入口 + `references/` 运行材料）：维护全部 crwu-audit-* 路由注册表；画像=报告形态→经济行为主线（受控角度词表）→对象→方法（附件名+抽验）→监管覆盖层（国资/证券/司法/金融）；字段画像先行、弱结构化名称兜底；细分未命中降级父大方向→汇总输出（自身不做审核判断）；**兜底/🅿️⏳ 命中时自动附《待建子技能提案》**（references/04：补哪个子技能/管什么/审什么）；画像必含 **scenario 装配键**（评估目的×方法双键，refs/00 §3 / 01）；**两阶段输出：阶段一独立审核（意见定稿前不下载/读取/参考复核记录）→ 阶段二复核对照 A/B/C + 综合对比（AI∩复核/AI 新增/复核独有=漏检候选）**；交付按技能内 **`references/11-html-delivery-spec.md`（CRWU 审核意见 HTML 送达规范 v1.6）**：AuditResult JSON 单一事实源 + **JSON 校验先行，合规后才成对生成员工 HTML 与同源监控 JSON** + 双证据链 + 《本次审核记录清单》+ **问题描述强制「员工话」两段式**（首句 ≤60 字说清问题是什么 + 2–4 行明细写明差异与去哪个文件/sheet/单元格核对；不得出现规则编号、知识库路径与内部代号，`validate` 硬校验拦截）+ **每个项目向员工只交付一个自包含单文件 HTML `审核意见.<项目ID>.html`（可离线、A4 可打印、含折叠专业审核轨迹），内部 JSON 与 HTML 内嵌 AuditResult 完全一致**；最终态监控 JSON **只回传至固定目标组织与团队空间**，按 `auditTask.auditTime` 自动创建缺失的 `YYYY/MM`，远端文件名追加 `fileTrace.generatedAt` 时间戳并拒绝覆盖同名文件；材料准备经技能内 `scripts/prepare_materials.py` 重建只含可见区的**工作版**，并把**媒体（图片）证据**导出到 `媒体证据/`、写 `媒体索引.json` 放行清单（锚点落在隐藏区者按 H0 不导出；读不到记未核，**未核 ≠ 缺失**）；阶段二复核件以 `--src 复核-人工 --label 复核` 复跑以抽取复核意见附件里的图，且不覆盖阶段一冻结产物；改前先读 `references/99-维护说明.md` |
| [`crwu-audit-leaf-common`](crwu-audit/references/12-leaf-common-contract.md) | 契约 | 资产/业务叶子的**共同约束**（轴边界·输入·一级根装配·二级选择·执行顺序·条目状态·来源优先级·证据出处·capability gap）：公共规则只写这一份，叶子引用不复制 |
| [`crwu-audit-asset-realestate`](crwu-audit-asset-realestate/SKILL.md) | 提示型 | 房地产（不动产/房产）**一级资产 Skill**：映射 `02-资产类型/01-房地产/` 一级根，运行时经 crwu-dws 递归下载根内全部支持正文；执行对象适用性 + 生成审核关注点，细分对象（如土地使用权）在已下载目录包内二次选用；业务要求由业务轴 Skill 并集提供，不建资产×业务组合 Skill |
| [`crwu-audit-asset-equipment`](crwu-audit-asset-equipment/SKILL.md) | 提示型 | 机器设备**一级资产 Skill**：映射 `02-资产类型/02-机器设备/` 一级根，递归下载根内全部正文；执行对象适用性 + 生成审核关注点，业务要求由业务轴并集提供 |
| [`crwu-audit-asset-enterprise-value`](crwu-audit-asset-enterprise-value/SKILL.md) | 提示型 | 企业价值**一级资产 Skill**：映射 `02-资产类型/03-企业价值/` 一级根，细分对象（股东全部/部分权益）在目录包内二次选用 |
| [`crwu-audit-asset-intangible`](crwu-audit-asset-intangible/SKILL.md) | 提示型 | 无形资产**一级资产 Skill**：映射 `02-资产类型/04-无形资产/` 一级根，细分对象（专利权/商标权/著作权/特许经营权/数据资产/商誉/其它）在目录包内二次选用 |
| [`crwu-audit-asset-mining-right`](crwu-audit-asset-mining-right/SKILL.md) | 提示型 | 矿业权**一级资产 Skill**：映射 `02-资产类型/05-矿业权/` 一级根，细分对象（采矿权/探矿权）在目录包内二次选用 |
| [`crwu-audit-asset-inventory`](crwu-audit-asset-inventory/SKILL.md) | 提示型 | 存货**一级资产 Skill**：映射 `02-资产类型/06-存货/` 一级根 |
| [`crwu-audit-asset-debt`](crwu-audit-asset-debt/SKILL.md) | 提示型 | 债权**一级资产 Skill**：映射 `02-资产类型/07-债权/` 一级根 |
| [`crwu-audit-asset-portfolio`](crwu-audit-asset-portfolio/SKILL.md) | 提示型 | 资产组合**一级资产 Skill**：映射 `02-资产类型/08-资产组合/` 一级根 |
| [`crwu-audit-asset-transport-equipment`](crwu-audit-asset-transport-equipment/SKILL.md) | 提示型 | 交通运输设备**一级资产 Skill**：映射 `02-资产类型/09-交通运输设备/` 一级根，细分对象（车辆/船舶）在目录包内二次选用 |
| [`crwu-audit-asset-asset-group-goodwill`](crwu-audit-asset-asset-group-goodwill/SKILL.md) | 提示型 | 资产组-含商誉**一级资产 Skill**：映射 `02-资产类型/10-资产组-含商誉/` 一级根 |
| [`crwu-audit-asset-scrap-materials`](crwu-audit-asset-scrap-materials/SKILL.md) | 提示型 | 废旧物资**一级资产 Skill**：映射 `02-资产类型/11-废旧物资/` 一级根 |
| [`crwu-audit-asset-other`](crwu-audit-asset-other/SKILL.md) | 提示型 | 其他**一级资产 Skill**：映射 `02-资产类型/12-其他/` 一级根 |
| [`crwu-audit-biz-asset-operation`](crwu-audit-biz-asset-operation/SKILL.md) | 提示型 | 资产经营**一级业务 Skill**：映射 `01-业务路线/01-资产经营/` 一级根，递归下载根内全部正文；先执行共用层 `共同审核点`（若存在），再按命中子业务执行 `01-业务通用审核要点`；子业务在已下载目录包内选用，不各建 Skill |
| [`crwu-audit-biz-transaction-disposal`](crwu-audit-biz-transaction-disposal/SKILL.md) | 提示型 | 交易与处置**一级业务 Skill**：映射 `01-业务路线/02-交易与处置/` 一级根，递归下载根内全部正文；先执行共用层 `共同审核点`（若存在），再按命中子业务执行 `01-业务通用审核要点`；子业务在已下载目录包内选用，不各建 Skill |
| [`crwu-audit-biz-financial-reporting`](crwu-audit-biz-financial-reporting/SKILL.md) | 提示型 | 财务报告**一级业务 Skill**：映射 `01-业务路线/03-财务报告/` 一级根，递归下载根内全部正文；先执行共用层 `共同审核点`（若存在），再按命中子业务执行 `01-业务通用审核要点`；子业务在已下载目录包内选用，不各建 Skill |
| [`crwu-audit-biz-financing-debt`](crwu-audit-biz-financing-debt/SKILL.md) | 提示型 | 融资与债务**一级业务 Skill**：映射 `01-业务路线/04-融资与债务/` 一级根，递归下载根内全部正文；先执行共用层 `共同审核点`（若存在），再按命中子业务执行 `01-业务通用审核要点`；子业务在已下载目录包内选用，不各建 Skill |
| [`crwu-audit-biz-investment-capital`](crwu-audit-biz-investment-capital/SKILL.md) | 提示型 | 投资与资本运作**一级业务 Skill**：映射 `01-业务路线/05-投资与资本运作/` 一级根，递归下载根内全部正文；先执行共用层 `共同审核点`（若存在），再按命中子业务执行 `01-业务通用审核要点`；子业务在已下载目录包内选用，不各建 Skill |
| [`crwu-audit-biz-tax-history`](crwu-audit-biz-tax-history/SKILL.md) | 提示型 | 税务与历史确认**一级业务 Skill**：映射 `01-业务路线/06-税务与历史确认/` 一级根，递归下载根内全部正文；先执行共用层 `共同审核点`（若存在），再按命中子业务执行 `01-业务通用审核要点`；子业务在已下载目录包内选用，不各建 Skill |
| [`crwu-audit-biz-judicial-liquidation-compensation`](crwu-audit-biz-judicial-liquidation-compensation/SKILL.md) | 提示型 | 司法清算与补偿**一级业务 Skill**：映射 `01-业务路线/07-司法清算与补偿/` 一级根，递归下载根内全部正文；先执行共用层 `共同审核点`（若存在），再按命中子业务执行 `01-业务通用审核要点`；子业务在已下载目录包内选用，不各建 Skill |
| [`crwu-audit-biz-consulting-review`](crwu-audit-biz-consulting-review/SKILL.md) | 提示型 | 咨询复核与其他**一级业务 Skill**：映射 `01-业务路线/08-咨询复核与其他/` 一级根，递归下载根内全部正文；先执行共用层 `共同审核点`（若存在），再按命中子业务执行 `01-业务通用审核要点`；子业务在已下载目录包内选用，不各建 Skill |
| [`crwu-audit-public-general-standards`](crwu-audit-public-general-standards/SKILL.md) | 提示型 | **公共轴（public）通用准则能力**：两层各自独立执行——**报告披露层**（`06-规则库/02-通用准则-报告与披露/`，`RULE-01-02-251~279`：报告结构/正文十四要素/声明/摘要/目的唯一性/基准日一致性/依据/假设/结论表述/特别事项七类/使用限制/附件）＋**程序质控层**（`06-规则库/03-通用准则-程序与档案/`，程序准则旧版 `RULE-01-02-101~127`、2026 版 `RULE-01-02-001~028`、质控指南 `RULE-01-02-401~456`）。**与报告形态、对象、业务、方法、监管无关，由 router 无条件并入 `public_skills[]`**；含**版本选择门禁**（程序准则 2026 版自 2027-01-01 施行，2026 年内报告按旧版整段引用，禁止新旧混引）。索引卡类节点不作引用依据 |
| [`crwu-audit-output-filter`](crwu-audit-output-filter/SKILL.md) | 提示型 | **公共轴（public）审核意见输出过滤能力**：恒装配但不参与专业检查；全部候选意见汇总后、阶段一冻结前，只读取知识库 `06-规则库/04-AI审核意见屏蔽/02-屏蔽清单`，按启用记录的稳定匹配标识、适用范围、屏蔽条件和例外精确过滤，不读取维护规则、不做模糊匹配；清单不可用时零屏蔽并保留全部意见。 |
| [`crwu-audit-datacheck`](crwu-audit-datacheck/SKILL.md) | 提示型 | 跨方向 **L2 数据/表格勾稽**（C1–C6）：测算/明细/汇总表合计与口径、公式错误、跨项目串扰词、占位残留 → 差异清单（含 xlsx/.xls 解析与公式重算工具链说明）。**H0：人工隐藏区（sheet/行/列/折叠组）强制跳过——禁读禁报，只审可见区**；**坐标基准：剔除隐藏后工作版行列收缩，公式/引用勾稽以 raw 原件坐标为准（可见区只读例外，见 crwu-audit refs/00 §Excel 隐藏数据隔离）** |
| [`crwu-audit-external-data`](crwu-audit-external-data/SKILL.md) | 提示型 | 跨方向 **L2 外部数据核验**（public 轴插拔）：`methods[]` 命中收益法/市场法时由 router 叠加；按知识库 `M-外部数据核验` 模块规程（表 A 触发范围 / 表 B 数据项触及 / 表 C 组合映射 / 表 D 源启用条件与降级）核验报告引用的外部公开数据——唯一数据源为**同花顺 iFinD**，取数路径随宿主而异（WorkBuddy 宿主连接器 `ifind-mcp` / DeepSeek Harness 的 `ifind-finance-data` 技能），口径标准化后比对，逐项出【符合 / 不符合 / 请说明 / 未检查】；**本环境不启用万得、不做双源复核**；**所有取数以报告基准日为锚，禁用取数时点滚动窗口**；先按知识库表 A 判断适用性，不适用时只写“本报告暂不涉及外部数据核验”；只有需要核验且两条取数路径都不可用时才按库内降级口径显式声明；`scripts/connector_probe.py` 只读探测两条取数路径（不读凭据值） |
| [`crwu-dev-audit-optimize`](crwu-dev-audit-optimize/SKILL.md) | 提示型（维护/元技能） | 审核能力族**维护/优化入口**（不经 crwu-audit 路由、不产审核判断）：既支持常规反馈分桶，也支持审核后 AI—人工差距分析。后者逐条对齐仅人工发现项，追踪知识库/Skill/路由/装配/执行/输出根因，生成表格 + ECharts 单文件 HTML、`L → 根因 → FIX` 双向映射、知识库人工修复单与经批准的 Skill 修复 prompt。**知识库只读且只能人工修复；Skill 逐项确认后才可改源仓**。规范见其 references/00-03 |
| [`crwu-dev-audit-skill-maintainer`](crwu-dev-audit-skill-maintainer/SKILL.md) | 提示型（维护/元技能） | 资产/业务 Skill 的盘点、创建、修复和重映射：读取目录树或 DWS 快照，识别缺失的一级资产/业务 Skill、遗留命名、失效根映射及细分审核文件缺口；资产用 `crwu-audit-asset-*`、业务用 `crwu-audit-biz-*`，细分对象和子业务只进入父 Skill 索引；修改 source 前先给逐文件方案并等待确认 |

| [`crwu-dws`](crwu-dws/SKILL.md) | 提示型 | 钉钉「中瑞世联评估审核知识库」**只读域**（与 audit 族平级、互为上下游）：M1 查询并缓存目录元数据（含 `extension` 通道判据）；M2 按**本次审核清单**实时下载知识正文，清单可混合单文件路径和目录路径（目录递归展开、逐文件 exportedAt、跨审核重下、清单外零下载）；**取数按节点 `extension` 双通道分流**——`adoc`→`doc +export`，可读原生文本 `md`/`txt`→`drive +download`（原件即正文），其余类型记 `skipped` 不伪造正文；M3 按文件名/nodeId/库内层级路径定位，正文仍从钉钉现场下载；目录缓存无正文且不能作为正文兜底；对钉钉零写 |

## crwu-audit 审核能力族（分轴并集）

分轴模型：`crwu-audit`（总路由：画像 → 各轴标签 → 稳定并集加载，只分发不判断）→ 叶子按轴承担能力。
轴 = scope / asset / business / method / overlay / public；**不建资产×业务组合 Skill**，交叉场景的并集由 router 装配。

- **资产轴** `crwu-audit-asset-*`：一个 Skill 恰好映射 `02-资产类型/` 下一个一级资产目录。
- **业务轴** `crwu-audit-biz-*`：一个 Skill 恰好映射 `01-业务路线/` 下一个一级业务目录（`crwu-audit-business-*` 为待迁移遗留前缀）。
- 一级根按 `request_kind=directory`、`recursive=true` 递归下载根内全部支持正文；**细分对象与子业务不各建 Skill**，由父 Skill 在已下载目录包内二次选用。
- **方法轴与覆盖层技能为 `pending` 期间，其知识库内容仍必须被装配**：下载清单 = 命中叶子装配表 ＋ 公共执行契约 ＋ **router 按本次 `methods[]`/`overlays[]` 命中项追加的方法层与覆盖层目录**（映射唯一事实源：`crwu-audit/references/08-union-dispatch-rules.md`）。`pending` 表示能力未落地，不表示内容可以不装。

设计、能力树与路由表见 [`docs/design-crwu-audit-skills.md`](../docs/design-crwu-audit-skills.md)。
总路由 `crwu-audit` 入口与知识库仓库解耦（不预读知识库入口文档/路径）；**叶子技能执行期按 RULE/CHK 编号 + 库内层级路径寻址，经 crwu-dws 按本次清单实时下载规则正文后引用（文件零缓存；不复制正文——实时引用协议 R1–R5 见 docs/design-audit-live-kb-protocol.md）**。
叶子技能只读引用、不复制规则正文。新增能力需在 crwu-audit 路由注册表 + 设计文档 + 本表三处登记。
**族维护分工**：`crwu-dev-audit-optimize` 负责从漏检、误检和复核反馈诊断“需要改什么”，并交付可视化差距报告；知识库修复单只供用户手工执行，Skill 修改须逐项确认。`crwu-dev-audit-skill-maintainer` 负责盘点目录树以及创建、修复、重映射资产/业务 Skill。两者都不经 crwu-audit 路由、不产审核判断。

## crwu-dws（钉钉知识库只读域：M1 目录查询+缓存 / M2 按清单实时下载 / M3 路径·缓存兜底查找）

- 独立能力线，与 crwu-audit 族**平级、互为上下游**：M1 查询钉钉知识库层级目录并写无正文缓存；M2 按 crwu-audit 路由/装配确定的本次清单实时下载到案例目录与源审核数据文件同级的 `knowledge/`，清单可混合单文件和目录路径；M3 供 skill 按文件名/nodeId/库内层级路径查找，正文仍现场下载。
- 缓存语义（用户口径）：**目录可缓存、正文不缓存**——目录缓存只存结构与 nodeId/全路径索引，正文每次实时从钉钉取回（本次下载物只属本次审核），保证"员工钉钉更新 → AI 取到的正文永远最新"。
- 取数通道（v0.6）：知识库文档的 `nodeType` 恒为 `file`，**格式只在 `extension` 里**；`doc +export` 仅支持 `adoc`。故 M2/M3 一律按 `extension` 分流——`adoc`→`doc +export`；`md`/`txt`→`drive +download`（原件即正文）；其余→`skipped`（**不是 failure**）。禁止"先 export 试一次失败再换通道"。节点 `extension`/`contentType` 由 M1 遍历写入快照与 node-index；旧缓存缺该字段时逐节点补查 `wiki +node-get`，不按名称后缀猜。
- 缓存名一致性（v0.3.1/D12）：缓存目录身份 = `.cache-meta.space`（name+workspaceId）；缓存库名与目标不一致（改名/换库/历史残留）→ **先清理缓存目录、再在线重下目标库目录结构**（防跨库误命中；见 SKILL.md §5.0 与 design §10）。
- 口径：钉钉知识库是知识正文唯一来源；案例 `knowledge/` 是本次审核工作集，跨审核必须重新下载；目录缓存只用于查找加速且无正文。audit 族实时引用协议见 [`docs/design-audit-live-kb-protocol.md`](../docs/design-audit-live-kb-protocol.md)（R1–R5）。
- 设计/决策点与改动纪律见 [`docs/design-crwu-dws.md`](../docs/design-crwu-dws.md)；改动只落源仓，运行时部署由用户 skills 管理机制负责（不直接写/ln/cp/rm `~/.skills-manager`、`~/.dsh`、`~/.workbuddy` 等运行时目录）。

## V2.1 增补（2026-09-07）
- `crwu-audit` 目录 = 精简入口 `SKILL.md`（≤300 行）+ `references/` 四件运行材料
  （00 画像 schema / 01 受控角度词表 / 02 覆盖层判定 / 99 维护说明）；运行材料随技能加载，不再放 docs/。
- 画像层升级与注册表状态：enterprise-value / equipment / advisory / 财务报告专项 → **P1**；
  债权-金融不良 → P2；复核报告 → 待定；mining → P2。
- 数据基线：氚云「报告审核」8,486 条（2026-09-07 快照），词表体量列与覆盖层判定即源于此；
  复跑脚本 `pull_全量画像.py`（基线/统计由部署方维护，技能不持有）。
- **知识库推理引用协议（实时版，2026-09-08）**：crwu-audit 族技能引用知识库只写 RULE/CHK 编号 + **库内层级路径**（如 `06-规则库/清单-M-市场法/不动产-房产-市场法租金比较-报告审核`），不写知识库名称、本地根路径或节点 nodeId。**单文件寻址键不带 `.md`**（`.md` 只是导出到本地时的文件名；带后缀会与 `by_path` 键不匹配而在 M2 记 failure），目录项以 `/` 结尾。nodeId 每次由 crwu-dws 目录树动态解析，正文按**本次审核清单**从钉钉实时下载；清单支持单文件与目录路径，文件零缓存、跨审核重下。设计/决策见 [`docs/design-audit-live-kb-protocol.md`](../docs/design-audit-live-kb-protocol.md)（R1–R5）与 `docs/design-crwu-dws.md`。机器校验：`skills/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root <repo>/skills`；对单个 audit 根加 `--forbid-literal <库名>` 禁知识库名字面。**本 README 不随技能安装到 agent（仅源仓维护者视角）。**
- 2026-09-07：`references/03-业务风险分类判定.md` —— 机构 A/B/C 业务分类作为**路由首判**（严谨度参考、首页标注；
  agent 一律全面审核、不裁剪检查点，最终通过由人工复核；与氚云风险等级字段对照校验）。
