# skills 维护规范

## 适用范围与规则优先级

- 本文件适用于 `skills/` 下所有 Skill、reference、配套文档与测试的维护，重点约束 `crwu-audit-asset-*` 和 `crwu-audit-business-*` 两类审核 Skill。
- 仓库根目录 `AGENTS.md` 的要求继续适用。本文件是 `skills/` 范围内的补充规则；若将来某个更深子目录存在更具体的 `AGENTS.md`，以更深层规则为准。
- 只修改并提交 source repo 中获授权的文件。不得直接写入、复制、链接或删除任何运行时 Skill 目录。

## 资产轴与业务轴边界

- 资产 Skill 只负责对象或资产类型的专业规则，例如权属、物理和经济特征、资产特有方法前提及对象特有风险。
- 业务 Skill 只负责评估目的、经济行为和场景规则，例如租赁、清算、处置或拍卖对口径、材料和判断的影响。
- 同一报告同时命中资产与业务标签时，由 `crwu-audit` router 对各轴 Skill 做稳定并集加载；任何一轴都不得替代另一轴。
- 禁止创建 `asset × business` 组合 Skill。交叉场景的共同结果来自 router 装配，而不是复制两轴内容或新增组合目录。
- 新建或扩展资产 Skill 前，先在 `crwu-audit/references/03-asset-classification.md` 确认 canonical label；业务 Skill 对应检查 `crwu-audit/references/04-business-classification.md`。标签、状态或 Skill 映射发生变化时，同步更新 `crwu-audit/references/07-skill-registry.md`。

## 知识库驱动的维护流程

对每个命中的 `axis + label`，按以下顺序维护：

1. 核对钉钉知识库的目录树或目录地图，定位与该标签对应的业务路线、资产类型、规则库、审核清单及其他必要目录或文件。
2. 形成“本次来源清单”，至少列出库内层级路径、文件或目录类型、预期读取的 RULE/CHK 范围和读取状态。目录快照只能用于定位，不能作为正文证据。
3. 使用 `crwu-dws` 按库内层级路径实时读取清单内正文；不得仅凭经验、旧缓存、历史摘录或文件名编写审核要点。
4. 逐文件提取并核对：RULE/CHK 编号、适用条件、必备材料、检查步骤、判断标准、冲突或例外、输出证据要求。
5. 基于本次真实读取的材料梳理审核要点，并把装配寻址与审核要点分别维护到对应 reference。不得把知识库正文复制到 Skill。

知识库资料缺失、实时下载失败、文件之间冲突，或现有资料不足以定义审核要点时，不得补写或猜测。将对应 `axis + label` 保持 `pending`，或记录 capability gap 与人工确认项；其他状态为 `available` 的 Skill 仍按 router 规则继续并集加载。

## Skill 与 references 分工

`SKILL.md` 与 `references/` 下所有文件共同遵守以下总则：均不得写知识库名称、个人绝对路径、本地下载或缓存正文路径、`nodeId`；不得逐字复制任何知识库正文。凡需沉淀知识库相关信息，只允许写 RULE/CHK 编号、库内层级路径寻址键，以及基于本次真实读取后归纳的审核要点。

`SKILL.md` 保持入口化，只包含职责边界、输入、必读 reference、执行步骤和输出门禁；资产或业务叶子 `SKILL.md` 必须明确“仅经 `crwu-audit` 编排调用、禁止单独调用”。详细分类、装配映射和审核要点放入本 Skill 的 `references/`，推荐最小结构如下：

- `00-applicability.md`：canonical label 的适用、排除和边界条件。
- `01-kb-assembly.md`：只记录 RULE/CHK 编号与钉钉库内层级路径寻址键。禁止写知识库名称、个人绝对路径、本地正文缓存路径或 `nodeId`，也不得复制规则正文；目录或文件名变更时必须同步更新。
- `02-review-focus.md`：基于本次真实读取资料整理的结构化审核要点与映射。不得逐字复制知识库正文；每个要点必须回指 RULE/CHK 编号和库内层级路径。

可按需增加其他 reference，但每个文件必须有单一职责，且不得成为知识库正文副本。实际运行审核时仍须通过 `crwu-dws` 重新下载正文，最终出处使用“本次下载文件:行号 + `exportedAt`”；reference 中的映射不能替代本次下载证据。

## available 能力完成门禁

任何新增或扩展的资产或业务 `axis + label` 能力，以及既有能力从 `pending` 改为 `available`，只有在以下内容同批完成后，才可在 registry 标记为 `available`：

- 对应的资产或业务分类、`07-skill-registry.md` 已同步；
- `SKILL.md`、`00-applicability.md`、`01-kb-assembly.md`、`02-review-focus.md` 已完成且边界一致；
- 受影响的设计文档、`skills/README.md`、变更记录和测试已同步；
- 受影响 Skill 通过 skill-creator 的 `quick_validate.py`；
- router contract 与 DWS source contract 通过；
- `python3 tools/kb/kb_tool.py validate --skill-root skills` 通过。若处于经批准的分阶段迁移，因已知后续同步暂不能通过，必须记录实际命令、失败项和待同步内容，不得把该状态宣称为完整可用；
- `git diff --check` 通过，并复核提交范围只包含本次授权改动。

禁止为了占位创建空的 pending Skill 目录。凭据、下载的知识库正文、临时清单产物和本地缓存不得提交；Skill 与 reference 资产只能提交到 source repo。

常用契约命令：

```bash
python3 tools/kb/test_audit_multiaxis_router.py
python3 tools/kb/test_dws_source_contract.py
python3 tools/kb/kb_tool.py validate --skill-root skills
git diff --check
```

## 资产 / 业务能力新增、扩展或转 available 检查单

- [ ] 已确认轴和 canonical label，未创建组合 Skill。
- [ ] 已核对目录树并形成“本次来源清单”。
- [ ] 已通过 `crwu-dws` 逐文件实时读取，未使用旧缓存代替正文。
- [ ] 每个审核要点均可回指 RULE/CHK 和库内层级路径。
- [ ] 分类、registry、Skill、references、文档与测试已同步。
- [ ] 所有完成门禁已运行并保留结果；缺失或冲突已记录为 pending、gap 或人工确认项。
- [ ] 提交中不含凭据、下载正文、运行时文件或无关改动。
