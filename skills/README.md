# Skills

独立打包、按技能分目录交付。两类都放这里：

- **提示型（指令）Skill**：目录内一个 `SKILL.md`（含 name/description 元数据），
  教会 Agent 如何驱动 `crwu` CLI 完成某个工作流，不引入新依赖。
- **Python Skill**：目录内自带 `SKILL.md`、`pyproject.toml`、源码、测试与用法文档。

规则：Skill 依赖不进入根 Go 构建，不得成为 `crwu` 二进制的运行时依赖；
变更功能后按 `AGENTS.md` 在 `docs/CHANGELOG.md` 记纪要，并同步相关手册。

| Skill | 类型 | 作用 |
| --- | --- | --- |
| [`h3yun-login`](h3yun-login/SKILL.md) | 提示型 | H3Yun 员工自助登录：自动开浏览器扫码绑定会话，令牌不进对话 |
| [`h3yun-query`](h3yun-query/SKILL.md) | 提示型 | 交互式 H3Yun 查询：系统→表单→记录，20 条/页，支持标题关键词查找 |
| [`crwu-audit`](crwu-audit/SKILL.md) | 提示型 | 报告审核能力族**总路由**（≤300 行入口 + `references/` 运行材料）：维护全部 crwu-audit-* 路由注册表；画像=报告形态→经济行为主线（受控角度词表）→对象→方法（附件名+抽验）→监管覆盖层（国资/证券/司法/金融）；字段画像先行、弱结构化名称兜底；细分未命中降级父大方向→汇总输出（自身不做审核判断）；**兜底/🅿️⏳ 命中时自动附《待建子技能提案》**（references/04：补哪个子技能/管什么/审什么）；画像必含 **scenario 装配键**（评估目的×方法双键，refs/00 §3 / 01）；改前先读 `references/99-维护说明.md` |
| [`crwu-audit-realestate`](crwu-audit-realestate/SKILL.md) | 提示型 | 房地产（不动产/房产）**大方向**通用审核：对象层+披露通用+方法适用性，按 报告/说明/明细表 分区（RULE-01-02-543~578、281~305） |
| [`crwu-audit-realestate-rent`](crwu-audit-realestate-rent/SKILL.md) | 提示型 | 房地产大方向下 **L2 细分**：商铺/办公/公寓等经营性物业·租金或市场价值评估报告，执行 CHK-MKT/CHK-CST 专项清单（含表格勾稽必做步骤）；**命中清单逐条裁定表=强制产物，校准点（B4/B8/B9/B11…）反查对应 CHK 为硬约束（OPT-2026-09-07-01）** |
| [`crwu-audit-datacheck`](crwu-audit-datacheck/SKILL.md) | 提示型 | 跨方向 **L2 数据/表格勾稽**（C1–C6）：测算/明细/汇总表合计与口径、公式错误、跨项目串扰词、占位残留 → 差异清单（含 xlsx/.xls 解析与公式重算工具链说明）。**H0：人工隐藏区（sheet/行/列/折叠组）强制跳过——禁读禁报，只审可见区**；**坐标基准：剔除隐藏后工作版行列收缩，公式/引用勾稽以 raw 原件坐标为准（可见区只读例外，见 crwu-audit refs/00 §6.1）** |
| [`crwu-audit-optimize`](crwu-audit-optimize/SKILL.md) | 提示型（维护/元技能） | 审核能力族**维护/优化入口**（不经 crwu-audit 路由、不产审核判断）：用户反馈驱动的 规则/覆盖/路径 演进——先定位单子画像与缺口分桶（A 规则内容/B 覆盖缺失/C 词表/D 算法/E 漂移）→ 输出《优化方案》（拟改文件清单，源仓+运行时双份）→ **用户确认后**按 99 流程执行 + kb_tool 校验回归。规范见其 references/00-02 |

## crwu-audit 审核能力族（分层可插拔）

三层模型：`crwu-audit`（L0 总路由：统一维护全部能力 skill 路由）→ L1 大方向技能（命中即按该方向
通用审核逻辑执行）→ L2 细分能力（挂在父大方向下可插拔；细分未命中降级父级大方向通用逻辑）。
设计、能力树与路由表见 [`docs/design-crwu-audit-skills.md`](../docs/design-crwu-audit-skills.md)。
总路由 `crwu-audit` 入口与知识库仓库解耦（不预读知识库入口文档/路径）；**叶子技能执行期按规则编号只读引用 CRWU_KB_ROOT（=`~/.crwu/knowledge/knowledge-base`）下规则正文（收益法等细则不进技能，不复制正文）**。
叶子技能只读引用、不复制规则正文。新增能力需在 crwu-audit 路由注册表 + 设计文档 §4 + 本表三处登记。
**族维护入口 = `crwu-audit-optimize`**（用户反馈驱动的规则/覆盖/路径优化：先方案、确认后执行；不经 crwu-audit 路由、不产审核判断）。


## V2.1 增补（2026-09-07）
- `crwu-audit` 目录 = 精简入口 `SKILL.md`（≤300 行）+ `references/` 四件运行材料
  （00 画像 schema / 01 受控角度词表 / 02 覆盖层判定 / 99 维护说明）；运行材料随技能加载，不再放 docs/。
- 画像层升级与注册表状态：enterprise-value / equipment / advisory / 财务报告专项 → **P1**；
  债权-金融不良 → P2；复核报告 → 待定；mining → P2。
- 数据基线：氚云「报告审核」8,486 条（2026-09-07 快照），词表体量列与覆盖层判定即源于此；
  复跑脚本 `pull_全量画像.py`（基线/统计由部署方维护，技能不持有）。
- **知识库唯一事实源与根常量：`CRWU_KB_ROOT=~/.crwu/knowledge/knowledge-base`**（`crwu-knowledge` 源仓已废弃、不再维护；`~/.crwu/knowledge` 仅是外层父目录，**不作为引用根**）。技能/文档中 `KB/…` 一律相对 CRWU_KB_ROOT 写完整路径，禁止省略号、禁止个人绝对路径；引用由 `tools/kb/kb_tool.py validate --skill-root <repo>/skills` 机器校验（README 见 `tools/kb/README.md`）。知识库内容由 dingcli 工具同步维护；钉钉知识库打通后只迁移目录内容并在此统一改根。**本 README 不随技能安装到 agent（仅源仓维护者视角）：每个会安装的 `SKILL.md` / `references/` 文件必须自带根常量字面定义，禁止回指本 README。**
- 2026-09-07：`references/03-业务风险分类判定.md` —— 机构 A/B/C 业务分类作为**路由首判**（严谨度参考、首页标注；
  agent 一律全面审核、不裁剪检查点，最终通过由人工复核；与氚云风险等级字段对照校验）。
