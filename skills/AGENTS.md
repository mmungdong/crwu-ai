# skills 维护规范

## 适用范围与规则优先级

- 本文件适用于 `skills/` 下所有 Skill、reference、配套文档与测试的维护，重点约束 `crwu-audit-asset-*` 和 `crwu-audit-biz-*` 两类审核 Skill。`crwu-audit-business-*` 仅视为待迁移的遗留前缀。
- 仓库根目录 `AGENTS.md` 的要求继续适用。本文件是 `skills/` 范围内的补充规则；若将来某个更深子目录存在更具体的 `AGENTS.md`，以更深层规则为准。
- 只修改并提交 source repo 中获授权的文件。不得直接写入、复制、链接或删除任何运行时 Skill 目录。

## 资产轴与业务轴边界

- 资产 Skill 只负责对象或资产类型的专业规则，例如权属、物理和经济特征、资产特有方法前提及对象特有风险。
- 业务 Skill 只负责评估目的、经济行为和场景规则，例如出租、处置、拍卖、抵押担保、减值测试等对口径、材料和判断的影响。
- **业务标签只取一级业务**：`business_types[]` 的取值域 = `01-业务路线/` 下的一级业务标签（现行 8 个：资产经营、交易与处置、财务报告、融资与债务、投资与资本运作、税务与历史确认、司法清算与补偿、咨询复核与其他，以 `04-business-classification.md` 为准）。租赁、清算、破产、拍卖、抵押质押、减值测试、计税、追溯评估、复核等历史行为词**降级为命中信号**，不是标签、不占 registry 行、不建 Skill。
- 同一报告同时命中资产与业务标签时，由 `crwu-audit` router 对各轴 Skill 做稳定并集加载；任何一轴都不得替代另一轴。
- 禁止创建 `asset × business` 组合 Skill。交叉场景的共同结果来自 router 装配，而不是复制两轴内容或新增组合目录。
- 新建或扩展资产 Skill 前，先在 `crwu-audit/references/03-asset-classification.md` 确认 canonical label；业务 Skill 对应检查 `crwu-audit/references/04-business-classification.md`。标签、状态或 Skill 映射发生变化时，同步更新 `crwu-audit/references/07-skill-registry.md`。

## 一级 Skill 与知识库目录粒度

- 资产 Skill 只映射 `02-资产类型/` 下一个一级资产目录；业务 Skill 只映射 `01-业务路线/` 下一个一级业务目录。
- `01-kb-assembly.md` 对该轴只登记一个精确一级根，`request_kind=directory`、`recursive=true`、`required=true`，并用 `expected_structure` 断言根内应有的结构。正式审核命中后由 `crwu-dws` 递归下载该根内全部支持正文；不得退回逐文件挑选模式。
- **一级根逐字使用库内精确路径**（含 `01-` 等数字排序前缀）；带前缀与省略前缀是两条不同路径，不得按显示名简写，也不得按另一个库的目录名推断。
- **寻址键写法**：逐字使用库内节点名（`crwu-dws` 的 `by_path` 键 = 原样精确名，不折叠大小写/全半角）。单文件项**不得带 `.md`**——`.md` 只是导出后的本地文件名（`<节点名>.md`），写进寻址键会与 `by_path` 不匹配而在 M2 记 failure；目录项必须以 `/` 结尾。旧库（节点名自带 `.md`）留下的带后缀写法属历史残留，禁止沿用。
- 资产目录中的细分对象与业务目录中的子业务只作为父 Skill 的二级选择索引，不各建 Skill、不各占 registry 行。
- 资产 Skill 始终读取命中一级根的 `01-共性参考/` 全部正文，再叠加命中细分对象的 `评估审核条目`。业务 Skill 根据评估目的等原始证据识别子业务，**先执行一级根直接文档 `共同审核点`（若存在）**，再执行命中子业务的 `01-业务通用审核要点` 和关联文件。
- `共同审核点` 是该一级业务的**共用层**：命中任一子业务都执行，不因命中集合变化而增删，也不得记成某个子业务的专属条目；它是条件性约定，**库内不存在时不记缺口**。
- 缺少资产 `01-共性参考/`、细分对象 `评估审核条目` 或子业务 `01-业务通用审核要点` 属于知识内容 gap；**必检项写「待补」、文档为空或为 `TODO` 占位同样记 gap**，并声明该处覆盖不完整。以上一律不得用新建空 Skill、凭标题或历史摘录编造规则来掩盖。

## 知识库驱动的维护流程

对每个命中的 `axis + label`，按以下顺序维护：

1. **先经 `crwu-dws` 拉取最新目录**（只读），记录 `fetchedAt`/`complete`/`failures`，再定位与该标签对应的业务路线、资产类型、规则库、审核清单及其他必要目录或文件。目录缓存只用于定位加速，不得当作"最新"；离线或刷新失败时只能输出候选并显式标注"非本次在线结果"。
2. 形成“本次来源清单”，至少列出库内层级路径、文件或目录类型、预期读取的 RULE/CHK 范围和读取状态。目录快照只能用于定位，不能作为正文证据。
3. 使用 `crwu-dws` 按库内层级路径实时读取清单内正文；不得仅凭经验、旧缓存、历史摘录或文件名编写审核要点。
4. 逐文件提取并核对：RULE/CHK 编号、适用条件、必备材料、检查步骤、判断标准、冲突或例外、输出证据要求。
5. 基于本次真实读取的材料梳理审核要点，并把装配寻址与审核要点分别维护到对应 reference。不得把知识库正文复制到 Skill。

知识库资料缺失、实时下载失败、文件之间冲突，或现有资料不足以定义审核要点时，不得补写或猜测。分两种处置：

- **完全无法定义**（所需文件不存在、下载失败、来源冲突未决）→ 对应 `axis + label` 保持 `pending`，或记录 capability gap 与人工确认项，不得标 `available`。
- **部分内容待补但其余可真实归纳**（例：审核要点文件存在且「历史高频复核问题」有真实数据，仅「必检项要点」写「待补」）→ 可以标 `available`，但必须在该叶子对应位置明确声明覆盖不完整并记 gap；**不得用"已 available"掩盖内容缺口，也不得补造缺失部分**。

无论哪种，其他状态为 `available` 的 Skill 均按 router 规则继续并集加载，不因某一处 gap 停止整轴能力。

## 变更归口（两个元技能，均不经 crwu-audit 路由、不产审核判断）

| 想改什么 | 归口 | 说明 |
| --- | --- | --- |
| 规则/清单**内容**（库里 `06-规则库/` 条目写错、漏项）、词表取值、叶子**算法与流程** | `crwu-audit-optimize` | 从漏检/误检/复核反馈诊断根因后执行；内容变更按知识库维护流程另办 |
| **结构/映射**：一级 Skill 的新增改名、一级根、registry、classification、遗留命名迁移 | `crwu-audit-skill-maintainer` | 四模式 `audit`/`create`/`repair`/`remap`；`audit` 只读并同步校准表 |

- 两者都遵守**先逐文件方案、用户确认后才动文件**；门禁与校验口径只在 `crwu-audit-skill-maintainer/references/04`、`05` 定义一次，`crwu-audit-optimize` 不重复定义。
- 结构/映射类诊断（覆盖缺失、路径漂移）由 `crwu-audit-optimize` 只给根因与最低改动集，**交接** `crwu-audit-skill-maintainer` 执行；交接不继承修改授权。
- 现状速查：读 `crwu-audit-skill-maintainer/references/07-kb-skill-map.md`（知识库↔Skill 映射校准表，每次校准后刷新）。

## 技能自洽性：不得引用代码仓库（硬规则）

**每个技能必须以副本独立安装后可用。凡技能运行时要用到的内容，都必须在技能目录内；技能目录之外的一切（仓库目录、仓根文件、其他仓库路径）在安装后都不存在。**

### 1 不得引用的对象

技能目录（`skills/<skill>/`，含 `SKILL.md`、`references/*`、`scripts/*`）内**不得出现**下列引用：

- 仓库目录路径：`docs/`、`tools/`、`cmd/`、`internal/`、`bin/`（含 `./bin/darwin/crwu` 之类的构建产物写法）；
- 仓根文件：`Makefile`、`go.mod` 等；
- 逃出技能目录的相对链接：`[x](../../docs/…)`、`../docs/…` 等；
- 以仓库根为前缀的跨技能路径写法：`skills/<技能>/…`（技能之间是"同级安装"，不是仓库子树）。

### 2 正确写法

| 想表达 | 写法 |
| --- | --- |
| 需要解释、口径、设计依据 | 写进**本技能 `references/`**；不要把 `docs/design-*.md` 当运行时读物 |
| 需要运行脚本 | 放**本技能 `scripts/`**，命令写作技能内相对路径 `python3 scripts/<file>`（并说明在技能目录内执行） |
| 调用别的技能的脚本 | 写「`<技能名>` 技能的 `scripts/<file>`」，命令用 `python3 "$SKILLS_ROOT/<技能名>/scripts/<file>"`（`SKILLS_ROOT` = 本技能所安装到的 skills 根） |
| CLI 用法与字段 | 以 `crwu scheme`（运行时命令目录）为准，用 PATH 中的 `crwu` 命令；不要指向仓库里的手册文件 |
| 脚本内定位 skills 根 | 只能由 `__file__` 上溯推导（`Path(__file__).resolve().parents[N]`），不得硬编码仓库布局 |
| 变更登记（源仓维护动作） | 用功能性表述（源仓的设计文档、技能清单、变更纪要），不写仓库路径 |

### 3 脚本归属与目录内聚

- 脚本归口到**唯一**负责它的技能，随技能安装；当前实现：`audit_delivery.py`（+schema/examples）归口 `crwu-audit`；`kb_tool.py` 归口 `crwu-audit-skill-maintainer`；三个契约测试归被测技能的 `scripts/`。
- 脚本与其 `README.md`、schema、`examples/`、`test_*.py` 同目录安置，测试随脚本同批移动。
- 不得把脚本写成"由部署环境注入可执行路径"。

### 4 例外（仅此两类）

- **外部工具**：确由部署方/第三方提供、本仓不持有的工具（如 `pull_全量画像.py`），技能内必须写明"本仓不提供、不随技能安装"，不得描述成技能资产。
- **源仓契约测试/源仓维护工具**：只在源仓维护时运行、运行时不需要的 `.py`，可在文件头 30 行内声明「源仓契约测试」或「源仓维护工具」后定位源仓；其中对源仓文档（`docs/…`）的断言在文档缺失（已安装副本）时**必须显式 skip**。此类文件不得被 `SKILL.md` 当作运行时步骤引用。

### 5 迁移与校验

- 搬迁或改写时同批完成：① 脚本内路径常量（如测试的 `REPO_ROOT`/`SKILLS_ROOT` 由 `__file__` 上溯推导）；② 所有**现行**引用点（技能正文、`references`、本文件、`skills/README.md`、源仓设计文档）；③ 新 CHANGELOG 条目。带日期的**历史记录**（变更纪要旧条目、评审记录、`docs/superpowers/plans|specs/*`）**不回改**。
- **机器门禁**：`python3 <skills 根>/crwu-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root <skills 根>` 必须 error=0 —— 其中的"技能自洽性 lint"会按上表拦截仓库目录引用（技能正文与技能内脚本都在扫描范围；`skills` 根的 `AGENTS.md`/`README.md` 是源仓文档，不算技能）。

## Skill 与 references 分工

以下总则仅适用于 `crwu-audit-asset-*` 与 `crwu-audit-biz-*` 审核叶子的 `SKILL.md` 和所有 references 中的知识装配内容，不扩大为对 `skills/` 下其他 Skill 的全局禁令：不得保存或硬编码知识库名称、个人绝对路径、本地正文路径、`nodeId` 常量值；不得逐字复制任何知识库正文。知识装配只允许保存 RULE/CHK 编号、库内层级路径寻址键，以及基于本次真实读取后归纳的审核要点。

上述限制不禁止使用 `nodeId` 协议字段名。`crwu-dws` 的操作、协议与 schema 文档可以定义该字段，运行时 manifest 和输出也可以携带其值，但该值必须来自本次 `crwu-dws` 实际返回，且不得写回任何 Skill source。

`SKILL.md` 保持入口化，只包含职责边界、输入、必读 reference、执行步骤和输出门禁；资产或业务叶子 `SKILL.md` 必须明确“仅经 `crwu-audit` 编排调用、禁止单独调用”。详细分类、装配映射和审核要点放入本 Skill 的 `references/`，推荐最小结构如下：

- `00-applicability.md`：canonical label 的适用、排除和边界条件，以及细分对象或子业务的识别规则。
- `01-kb-assembly.md`：只记录 RULE/CHK 编号与钉钉库内层级路径寻址键。先写一行一级根映射（`source_key`/`owner_axis`/`canonical_label`/`kb_root`/`request_kind`/`recursive`/`required`），再以 `expected_structure` 断言根内结构，最后才是二级选择索引与其他轴共享依赖。禁止保存或硬编码知识库名称、个人绝对路径、本地正文路径或 `nodeId` 常量值，也不得逐字复制知识库正文；目录或文件名变更时必须同步更新。
- `02-review-focus.md`：基于本次真实读取资料整理的结构化审核要点与映射。不得逐字复制知识库正文；每个要点必须回指 RULE/CHK 编号和库内层级路径。

**公共规则只写一份**：轴边界、输入、一级根装配、二级选择返回、执行顺序（一级共用层→命中二级条目）、必检项/历史问题状态字段、来源优先级、证据出处与 capability gap，统一落在 `crwu-audit/references/12-leaf-common-contract.md`。叶子 `SKILL.md` 用相对路径引用它，**只写本轴/本标签特有内容，不得复述共同规则**。新建叶子时以任一 `crwu-audit-biz-*` 的四件套为版式基线。

可按需增加其他 reference，但每个文件必须有单一职责，且不得成为知识库正文副本。实际运行审核时仍须通过 `crwu-dws` 重新下载正文；最终出处至少包含本次下载文件、实际行号、库内路径、本次运行返回的 `nodeId` 和 `exportedAt`。reference 中的映射不能替代本次下载证据，运行时 `nodeId` 值也不得写回 Skill source。

## available 能力完成门禁

任何新增或扩展的资产或业务 `axis + label` 能力，以及既有能力从 `pending` 改为 `available`，只有在以下内容同批完成后，才可在 registry 标记为 `available`：

- 对应的资产或业务分类、`07-skill-registry.md` 已同步；
- `SKILL.md`、`00-applicability.md`、`01-kb-assembly.md`、`02-review-focus.md` 已完成且边界一致；
- 受影响的设计文档、`skills/README.md`、变更记录和测试已同步；
- 受影响 Skill 通过 skill-creator 的 `quick_validate.py`；
- router contract 与 DWS source contract 通过；
- `python3 skills/crwu-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills` 通过。若处于经批准的分阶段迁移，因已知后续同步暂不能通过，必须记录实际命令、失败项和待同步内容，不得把该状态宣称为完整可用；
- **映射检查器对本次最新目录 error=0**：`python3 skills/crwu-audit-skill-maintainer/scripts/check_audit_skill_mappings.py --repo-root . --catalog <本次 crwu-dws 快照> --max-age-hours <H>` —— 覆盖一级根精确匹配、轴前缀、registry/classification 一致性、遗留命名、**库内路径键存在性（含公共轴）**；warning 需逐条判断并注明理由；
- **校准表已刷新**：`--emit-map skills/crwu-audit-skill-maintainer/references/07-kb-skill-map.md`，并在其「内容级校准备注」区写明本次正文核对结论与缺口（未下载正文时如实写"未核"，不得留空冒充合格）；
- 新增叶子已引用 `crwu-audit/references/12-leaf-common-contract.md` 且未复述共同规则；
- `git diff --check` 通过，并复核提交范围只包含本次授权改动。

禁止为了占位创建空的 pending Skill 目录。凭据、下载的知识库正文、临时清单产物和本地缓存不得提交；Skill 与 reference 资产只能提交到 source repo。

常用契约命令：

```bash
python3 skills/crwu-audit-skill-maintainer/scripts/test_audit_skill_maintainer.py
python3 skills/crwu-audit/scripts/test_audit_multiaxis_router.py
python3 skills/crwu-dws/scripts/test_dws_source_contract.py
python3 skills/crwu-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills
# 映射与路径键一致性（需本次 crwu-dws 快照；--emit-map 同步校准表）
python3 skills/crwu-audit-skill-maintainer/scripts/check_audit_skill_mappings.py \
  --repo-root . --catalog <快照> --max-age-hours 2 \
  --emit-map skills/crwu-audit-skill-maintainer/references/07-kb-skill-map.md
git diff --check
```

## 资产 / 业务能力新增、扩展或转 available 检查单

- [ ] 已确认轴和 canonical label，未创建组合 Skill。
- [ ] 已核对目录树并形成“本次来源清单”。
- [ ] 已通过 `crwu-dws` 逐文件实时读取，未使用旧缓存代替正文。
- [ ] 每个审核要点均可回指 RULE/CHK 和库内层级路径。
- [ ] 运行审核的最终出处包含本次下载文件、实际行号、库内路径、本次运行返回的 `nodeId` 和 `exportedAt`，且 `nodeId` 值未写回 Skill source。
- [ ] 一级根逐字等于库内节点名（含数字前缀），`directory`/`recursive`/`required` 三键齐全。
- [ ] 所有寻址键逐字等于库内节点名：单文件不带 `.md`、目录以 `/` 结尾。
- [ ] 业务叶子已处理一级根 `共同审核点`（存在则回指；不存在则如实记"未发现"且不记缺口）。
- [ ] 内容为「待补」/空文档/`TODO` 占位的位置已登记为 gap，未补造任何要求。
- [ ] 新增叶子引用了 `12-leaf-common-contract.md` 且未复述共同规则。
- [ ] 分类、registry、Skill、references、文档与测试已同步；校准表已刷新且内容级备注如实。
- [ ] 所有完成门禁已运行并保留结果；缺失或冲突已记录为 pending、gap 或人工确认项。
- [ ] 提交中不含凭据、下载正文、运行时文件或无关改动。
