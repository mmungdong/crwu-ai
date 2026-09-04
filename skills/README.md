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
| [`crwu-audit-realestate-rent`](crwu-audit-realestate-rent/SKILL.md) | 提示型 | 审核【评估报告 × 不动产(商铺/办公/公寓等经营性物业)·租金或市场价值】：按知识库 CHK-MKT/CHK-CST 分区清单逐项审核，输出带依据引用意见单（依赖 crwu-knowledge 规则 A 发布门禁，未发布仅试点） |

## crwu-audit 审核能力族

按审核能力逻辑划分（报告形态 × 对象大类 × 方法/场景 × 能力就绪度），设计、分类树与总路由
`crwu-audit` 契约见 [`docs/design-crwu-audit-skills.md`](../docs/design-crwu-audit-skills.md)。
规则/清单单一事实源在 crwu-knowledge（`/Users/mungdong/code/github/mungdong/crwu-knowledge`），
叶子技能只读引用、不复制规则正文。新增叶子需在该设计文档 §4 登记 + 本表注册。
