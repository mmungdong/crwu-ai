---
name: crwu-dev-audit-optimize
description: Use when maintaining CRWU audit rules, checkpoints, routing, assembly, or skills, or when comparing AI audit results with human review feedback; not for issuing audit opinions.
---

# crwu-dev-audit-optimize（审核能力族 · 维护/优化入口）

> 本技能**不是审核叶子**：不产出任何审核意见、不参与 crwu-audit 分发。它是"按真实反馈演进族技能与
> 知识库"的总入口：先诊断定位 → 出方案 → **等用户明确确认** → 按方案执行 → 校验回归汇报。
> 正式审核请走 `crwu-audit`；技能安装机制 / 知识库版本管理 / 钉钉知识库内容打通属外部事项，本技能不处理。

## 脚本运行时（Python）

共享的 Python 运行时安全口径由 `crwu-dev-audit-skill-maintainer/SKILL.md` 的
**`## 脚本运行时（Python）`** 一节**唯一维护**（本技能不复制第二份，**按名回指、不复述**）。
执行本技能自带脚本前，按该 owner 的口径取得解释器；owner 不可用（取不到解释器路径 / 缺包）时，
登记 `capability gap` 并**停止**，不静默降级。

## 何时用 / 何时不用

| 用（触发本技能） | 不用 |
| --- | --- |
| 反馈"某检查点/口径错了、漏了、过严、缺依据"，要改审核规则 | 正式报告审核 → `crwu-audit` |
| 反馈"缺 XX 文档对 XX 文档 / 某业务·对象·形态组合的审核"（路由兜底/空能力） | 发布/试点状态处理 → 无此机制（知识库文档即权威、下载即审） |
| 审核结果与规则对不上，怀疑装配/索引/路径漂移 | 氚云/钉钉操作 → `crwu-h3yun-*` / `dingtalk-*` 技能 |
| 想新增对象方向、方法场景、文档分区的审核能力 | 技能安装/同步机制 → 三方维护 |
| 审核完成后对比 AI 审核结果与人工复核文件，分析仅人工发现项及修复方向 | 仅复述人工意见、不做根因与证据追溯 |

## 铁律与授权边界

1. **先方案、后动文件**：任何修改前必须输出《优化方案》并取得**用户明确确认**；禁止"边查边改"，
   禁止把方案与执行混在同一轮（模板见 `references/02-方案模板与确认门禁.md`；共享**两阶段修改门禁**见
   `crwu-dev-audit-skill-maintainer/references/04-registry-and-mapping-update.md`）。
2. 本技能不产审核判断、不复制规则正文进技能：规则正文只在钉钉知识库（经 `crwu-dws` 实时下载），
   技能内只写 RULE/CHK 编号 + 库内层级路径寻址键。
3. 改动只落在**唯一落点文件**并提交源仓（分层落点、红线与执行顺序见
   `references/00-优化规范与文件落点.md`）；**不得写运行时技能目录**（`~/.skills-manager`、`~/.dsh`、
   `~/.workbuddy` 等），运行时部署由用户 skills 管理机制负责。
4. 引用协议：技能正文引用一律写 RULE/CHK 编号 + 库内层级路径寻址键，不写知识库名称、不写本地根路径
   字面、不写 nodeId；正文经 `crwu-dws` 实时下载后只读引用，文件零缓存。
5. **知识库只读、修复必须人工执行**：知识库正文只可经 `crwu-dws` 只读下载用于诊断；所有知识库修复
   计划必须标记 `manual_only`，只输出目标文档、证据、建议修改位置与人工操作说明，**禁止修改知识库**；
   AI 只能在用户明确批准具体 `FIX-*` 后修改源仓 Skill 文件，批准不得从一次差距分析自动继承。

## 模式选择

- **AI—人工差距分析模式**：已有同一次审核的 AI 结果与人工复核文件时进入；流程与交付见
  `references/03-AI人工差距分析流程.md`。
- **常规反馈优化模式**：只有用户反馈或缺口描述时进入；定位、分桶与出方案按
  `references/01-反馈定位与画像流程.md` → `references/02-方案模板与确认门禁.md` 执行。
- **受控执行模式**：只有用户明确批准具体修复项后才进入；知识库项始终由用户人工处理，AI 不执行。

## 必读 references

按下列分工理解所有权；详细内容只按名回指，本入口不复述：

1. [00-优化规范与文件落点.md](references/00-优化规范与文件落点.md)：分层落点、红线与 optimize 特有执行顺序。
2. [01-反馈定位与画像流程.md](references/01-反馈定位与画像流程.md)：输入、五维画像、证据定位和反馈分桶。
3. [02-方案模板与确认门禁.md](references/02-方案模板与确认门禁.md)：优化方案模板与 optimize 特有授权补充。
4. [03-AI人工差距分析流程.md](references/03-AI人工差距分析流程.md)：双基线、状态、分层追踪、L/FIX 关系与 HTML 交付。

**共享 owner（跨技能按名回指，不建相对链接，保持安装自包含）**：**两阶段修改门禁**（阶段一：只读方案 → 阶段二：确认后执行）见
`crwu-dev-audit-skill-maintainer/references/04-registry-and-mapping-update.md`；**校验命令、执行方法与完成判据**见
`crwu-dev-audit-skill-maintainer/references/05-validation-and-delivery.md`。这两项只在那两个文件里定义一次，本技能只回指、不复述。

## A–E 根因桶与执行归属

本技能只做**诊断**（"为什么要改、改哪一层"），并**只亲自执行内容层与算法层**的 Skill 改动；
结构与映射层一律交接 `crwu-dev-audit-skill-maintainer`。

| 桶 | 落点 | 谁执行 |
| --- | --- | --- |
| **A 规则/清单内容** | 知识库 `06-规则库/`（精编条目 / `M-*` / `清单-M-*`） | 本技能出**知识库人工修复单**；用户手动修改知识库 |
| **B 覆盖缺失** | 一级 Skill 的创建与登记 | **交接 maintainer**（`create`） |
| **C 词表/画像取值** | `00-总纲/治理/标签词典` + router 画像契约 | **知识库部分人工修复**；Skill 部分经逐项批准后由本技能执行，但目标含 classification / registry 三份 owner 文件时**一律交接 maintainer** |
| **D 技能算法与流程** | 对应叶子 `SKILL.md` + 其 `02-review-focus.md` | **本技能执行**（公共规则改动落规范源，再同步叶子副本） |
| **E 路径/装配/指针漂移** | 叶子 `01-kb-assembly.md` / registry / classification | **交接 maintainer**（`audit`／`remap`／`repair`） |

每桶给出证据、影响面与最低改动集；**交接不继承修改授权**——维护器仍须先出逐文件方案并取得用户确认；细化与映射规则以维护器 references 为准，本技能不重复定义。
**classification / registry 排他归口**：一级资产/业务 `03-asset-classification.md`、`04-business-classification.md` 与 `07-skill-registry.md` 的标签、别名、状态、一级 Skill 映射修改，**无论根因来自 B、C 还是 E 桶，一律交接 `crwu-dev-audit-skill-maintainer`，本技能不得自行修改**（交接只含根因、证据与最低改动集）。
router 的 scope / method / overlay / 并集分发 / 降级与冲突处理等**运行时算法**仍属 D 桶：本技能诊断后、经逐项批准可执行。

## 执行入口

1. **出方案**：按 `references/01-反馈定位与画像流程.md` 定位分桶，按 `references/02-方案模板与确认门禁.md`
   输出《优化方案》，然后**停下等用户确认**；未确认不动任何文件。
2. **执行**：仅执行用户明确批准的源仓 Skill `FIX-*`，按 `references/00-优化规范与文件落点.md` 的顺序改
   文件；知识库 `FIX-*` 只交付人工修复单，不执行、不通过 CLI 写入。
3. **校验回归**：按 `crwu-dev-audit-skill-maintainer/references/05-validation-and-delivery.md` 的校验命令与
   完成判据执行，**全过才算完成**；随后汇报文件级改动清单、校验结果与剩余风险。

## 边界与回退

- 方案被驳回 → 记录驳回原因，可缩小范围重提（引用原方案编号）；
- 执行中发现超范围新问题 → **停下**，回到「执行入口」第 1 步重新出方案；
- 无发布状态判定与登记机制（知识库文档即权威、下载即审，不做发布/试点状态判定与登记）；
- 新增审核叶子能力属 **B 桶 → 交接 `crwu-dev-audit-skill-maintainer`**（`create`），本技能不代办；新叶子必须自带"仅经 `crwu-audit` 编排调用、禁止单独调用"门禁；
- 知识库版本管理、钉钉知识库内容打通、基线脚本、技能安装机制均不在本技能范围。
