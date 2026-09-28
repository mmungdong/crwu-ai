---
name: crwu-audit-external-data
description: Use when crwu-audit routes a report whose methods[] includes 收益法 or 市场法 and its external public-data claims may require iFinD verification.
---

# crwu-audit-external-data（外部数据核验 · 能力型）

> **单一事实源分工**
> **知识库 = 口径**：表 A 触发范围、表 B 数据项触及、表 C 组合映射、结论档位、
> 数据留痕要求、未检查项与缺口记录、员工补录机制——全部在库内正文，本技能不复制。
> 库内表 D（取数失败与降级）按**单源**执行：本技能只以同花顺 iFinD 取数，不作双源复核
> （见「数据源与两条取数路径」）。
> **本技能 = 能力**：数据项抽取、取数入口发现与调用、口径标准化、比对留痕、交付字段产出。

> **KB 逻辑装配表**：本技能 `references/00-KB装配表.md` = 库内层级路径寻址键表（命中本技能 →
> 该表路径并入本次审核下载清单 → 经 crwu-dws 实时下载正文、只读引用、出处 = 本次下载文件:行号 +
> exportedAt；每次审核重新下载、零正文缓存；改知识库内容不动技能）。

## ⚠️ 调用前置条件

本技能是跨方向**能力型**技能：**仅经 `crwu-audit` router 编排调用，禁止单独调用**——默认由总路由
在 `methods[]` 命中 **收益法 / 市场法** 时叠加调用，**禁止 Agent 脱离编排直接调用并据其输出下审核判断**。
例外：用户明确只要「外部数据核验结果」且不做审核判断时，可独立执行——输出仅限核验结果，并注明
"仅外部数据核验，未做审核判断，待方法轴技能/人工判读"。

## 定位与触发

- 何时用：`route_profile.methods[]` 含 `收益法` 或 `市场法`；是否真正取数仍按库内 **表 A** 三条
  （业务线 × 资产线 × 方法线）同时成立判定，缺一即不核验、记"不在本模块范围"。
- 与知识库口径：全部核验口径、数据项取舍与结论档位以库内 `M-外部数据核验` 模块规程为准；
  本技能只提供能力与执行规程，并叠加"单源（同花顺 iFinD）、不启用万得"这一环境事实。
- 与非本技能职责的边界：报告内部与跨表数字勾稽 → `crwu-audit-datacheck`；披露完整性通用检查 →
  `crwu-audit-public-general-standards`；参数合理性与方法判断 → 方法轴技能与人工。

## 必读 references

按下列分工理解所有权；运行时只读对应文件：

1. [00-KB装配表.md](references/00-KB装配表.md)：本技能装配的库内层级路径寻址键表（见上方 KB 逻辑装配表说明）。
2. [01-connector-access.md](references/01-connector-access.md)：**取数入口发现与调用**——宿主边界、发现顺序、降级与留痕契约；两宿主入口的判定结论一律以它为准。
3. [02-verification-workflow.md](references/02-verification-workflow.md)：**执行前必读**——前置适用性门禁、基准日锚定三档、核验步骤 0–7、口径标准化与结论边界、`externalDataVerification` 字段契约与详细禁止事项。

## 数据源与两条取数路径（同花顺 iFinD）

本技能的唯一外部数据源是**同花顺 iFinD**，但宿主不同，取数入口不同——**不要假定另一个宿主的入口存在**：

- 两条宿主入口取的是**同一上游 iFinD 服务**，但调用方式与凭据来源不同：不要拿 WorkBuddy 的连接器声明
  去推断 DSH 可用，也不要在 DSH 里去找 WorkBuddy 的连接器目录。
- **取数入口发现与调用细则**（发现顺序、降级、留痕契约、各宿主入口的判定结论）统一见
  `references/01-connector-access.md`。
- `scripts/connector_probe.py` 是 **WorkBuddy 专用**的只读预检：只在 WorkBuddy 会话未直接暴露
  iFinD MCP 工具时读宿主连接器声明，**不是**两宿主通用的可用性探测器。运行口径：
  `<WorkBuddy 宿主可用的绝对 Python 路径> scripts/connector_probe.py --format json`
  （只读，不读凭据值）。**禁止**裸 `python3` 名字、任何解释器查找，以及静默降级到系统解释器
  （缺包就记 capability gap 并停下）。
- **DeepSeek Harness 不运行 `connector_probe.py` 判断可用性**，也没有可读的宿主声明：DSH 侧入口
  就是结构化 Tool `crwu_audit_ifind_query` 对当前 Agent 的可见性；可见后以一次真实的
  `operation=list_tools` 成功返回为准（详见 `references/01-connector-access.md` §4）。
- **万得不参与本技能的取数**：库内表 B/C 的源统一为同花顺 iFinD；表 D 的双源复核条件不适用，
  按单源（D1–D4）降级执行。

## 输入

1. router 冻结的 `route_profile`（须含 `methods[]`，以及 `record_context.base_date`——**所有取数的基准日锚点**）；
2. router 已准备并隔离的报告、评估说明、测算明细表等材料路径；
3. router 已验证的本次 DWS manifest，至少含 `references/00-KB装配表.md` 的路径键对应正文。

缺少任一项即记录 capability gap，不自行补取、不沿用上一轮材料。不得接收复核记录。

## 输出与边界门禁

- 输出交付层 `externalDataVerification`（供 HTML《外部数据核验》区渲染）；字段契约与逐项核验要求见 [02-verification-workflow.md](references/02-verification-workflow.md)，意见条目结构以本次实时下载的库内正文为准。
- **门禁**（详细规则见 01 / 02）：不得跨宿主推断取数入口；不得把外部数据用作规则依据；不得声称双源复核；**口径无法统一时不得作数值判定**；需要核验而取数路径不可用时，按库内降级口径降级并在交付件中显式声明，不得静默跳过。
