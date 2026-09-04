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
| [`crwu-audit`](crwu-audit/SKILL.md) | 提示型 | 报告审核能力族**总路由**：维护全部 crwu-audit-* 路由注册表；画像→分层分发→细分未命中降级父大方向→汇总输出（自身不做审核判断） |
| [`crwu-audit-realestate`](crwu-audit-realestate/SKILL.md) | 提示型 | 房地产（不动产/房产）**大方向**通用审核：对象层+披露通用+方法适用性，按 报告/说明/明细表 分区（RULE-01-02-543~578、281~305） |
| [`crwu-audit-realestate-rent`](crwu-audit-realestate-rent/SKILL.md) | 提示型 | 房地产大方向下 **L2 细分**：商铺/办公/公寓等经营性物业·租金或市场价值评估报告，执行 CHK-MKT/CHK-CST 专项清单 |

## crwu-audit 审核能力族（分层可插拔）

三层模型：`crwu-audit`（L0 总路由：统一维护全部能力 skill 路由）→ L1 大方向技能（命中即按该方向
通用审核逻辑执行）→ L2 细分能力（挂在父大方向下可插拔；细分未命中降级父级大方向通用逻辑）。
设计、能力树与路由表见 [`docs/design-crwu-audit-skills.md`](../docs/design-crwu-audit-skills.md)。
规则/清单单一事实源在 crwu-knowledge（`/Users/mungdong/code/github/mungdong/crwu-knowledge`），
叶子技能只读引用、不复制规则正文。新增能力需在 crwu-audit 路由注册表 + 设计文档 §4 + 本表三处登记。
