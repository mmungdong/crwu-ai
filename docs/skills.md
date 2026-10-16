# Skill 维护指南

本仓库不维护容易过期的 Skill 名单或数量。目录结构和每个 `SKILL.md` 的 frontmatter 才是事实源；
需要当前清单时，从工作树实时发现。

通用准则公共能力也执行本次报告披露根正文中已启用的报告与评估说明内部校对检查点，逐项记录
状态与本项目证据，输出限于内部质量控制意见；金额、公式和跨表勾稽仍由数据核对能力处理。
校对正文通过既有目录递归装配，新增知识条目不要求新增 Skill、模板或入库登记。

## 分层与归属

DSH 对每个 Skill 根只扫描一层，因此每一层都必须单独注册。

| 层 | 源目录 | 维护方式 |
| --- | --- | --- |
| 自研 | `plugins/dsh-crwu-workbench/skills/crwu/` | 本仓维护；修改后运行自洽性校验 |
| 自研·业务 | `plugins/dsh-crwu-workbench/skills/biz/` | 本仓维护；业务技能（估值等）独立执行，不依赖 `crwu-audit` 编排 |
| 上游 | `plugins/dsh-crwu-workbench/skills/dws/` | vendored `dingtalk-workspace-cli` 内容；只通过 `npm run dws:sync` 更新 |
| 公共 | `plugins/common/skills/` | 跨插件共享；通过 `npm run skills:sync` 同步进插件包 |

包内落点和 DSH 注册方式见
[`plugins/dsh-crwu-workbench/AGENTS.md`](../plugins/dsh-crwu-workbench/AGENTS.md)。

### 业务层的估值技能（`skills/biz/crwu-biz-valuation-realestate/`）

它是**房地产估值**的作业承包方：由工作台的「报告评估」模块发起，在一轮估值案例目录里完成
资料整理、案例选取、市场法/收益法/成本法测算与交付件生成。目录按**产物职责**分工：

| 目录 | 放什么 | 规矩 |
| --- | --- | --- |
| `references/` | 入口 Wiki 路由、执行工作流、通用工作簿与输出技术合同 | 业务正文只来自业务知识库；本地文件是**技术合同**，不是规范正文 |
| `template/` | 报告 HTML 模板（`valuation-report.html`） | **只读**：产物一律写进估值案例目录，不许回写模板；计算表模板由本轮知识取回，不随包发布 |
| `schemas/` | 报告数据 / 项目 / 对象 / 知识来源 / 规则参数的结构契约 | AI 输出的 JSON 结构校验；报告数据由 `build_report_data.py` 真实加载 |
| `assets/` | 站点清单与资源说明 | 只放可再分发且注明来源的资源 |
| `scripts/` | 提取、组装、计算、填报、校验脚本与它们的测试 | 不含裸 `crwu` / `dws` / `ossutil` 调用（本仓技能守卫扫描） |

调用方式是**结构化 Tool**，不是命令行：`crwu_valuation_case_bootstrap`（读冻结输入）、
`crwu_valuation_file_extract`、`crwu_valuation_knowledge_materialize`、`crwu_valuation_browser_preflight`、
`crwu_valuation_market_search` / `crwu_valuation_market_capture`（外部案例与证据）、
`crwu_valuation_artifact_validate`（交付前两道校验），以及跑技能脚本的 `crwu_run_python_script`。
这份名单（`VALUATION_CHILD_TOOLS`）在起估值**之前**会拿去问宿主注册表：缺任何一条就拒绝启动 ——
写在常量里不等于宿主真的注册了它们。

## 查看当前 Skill

从仓库根目录运行：

```bash
find plugins -name SKILL.md -type f -print | sort
```

任何包含 `SKILL.md` 的目录都视为一个 Skill。不要把命令输出复制成长期维护的静态表格，也不要在
README 中写固定总数。

非 DSH 宿主按需选择单个 Skill，并使用宿主支持的安装流程；本仓库不提供批量复制全部 Skill 的
Make 目标。宿主目录与替换注意事项见 [`agent-skill-dirs.md`](agent-skill-dirs.md)。

## 修改规则

- 每个 Skill 必须可被单独复制安装，不能依赖自身目录之外的仓库文件。
- 运行时脚本、schema、示例和必要说明放在 Skill 自己的目录内。
- CLI 命令、参数和输出契约以运行时 `crwu scheme` 为准，不在 Skill 中复制易漂移的命令表。
- 公共逻辑优先放在公共层；插件专属能力留在插件自研层。
- 上游 `dws` 层不做手工编辑；升级时同步来源、审查 diff，并更新 provenance。

`crwu-audit` 能力族采用路由器加多轴并集：路由器负责画像与装配，资产、业务、方法、覆盖层和公共轴
各自拥有规则；不创建“资产 × 业务”组合 Skill。运行期知识通过 `crwu-dws` 按本次清单读取，Skill 不复制
知识库正文。现行设计见 [`design-crwu-audit-skills.md`](v0.0.1/design-crwu-audit-skills.md) 和
[`design-audit-live-kb-protocol.md`](v0.0.1/design-audit-live-kb-protocol.md)。

最终交付按 Skill 内 [HTML/JSON 送达规范 v1.6](../plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/references/11-html-delivery-spec.md)
成对校验与渲染；远端发布分别维护在 [OSS 契约](../plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/references/15-oss-result-publish.md)
和 [钉钉契约](../plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/references/13-dingtalk-result-publish.md)，
顺序由 [运行时编排](../plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/references/14-orchestration-workflow.md) 统一维护。

外部数据核验只使用 iFinD：WorkBuddy 通过宿主连接器 `ifind-mcp`，DeepSeek Harness 通过受控的结构化
Tool `crwu_audit_ifind_query`。不要用第三方 Skill、裸 CLI 或子进程替代这些宿主边界。

## 同步与验证

在插件目录运行：

```bash
npm run skills:sync
npm run skills:check
npm run dws:check
python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate \
  --skill-root skills/crwu \
  --skill-root common/skills
```

完整插件门禁使用仓库根目录的 `make plugin-check`。安装目录发现规则见
[`agent-skill-dirs.md`](agent-skill-dirs.md)。
