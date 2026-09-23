---
name: crwu-audit-output-filter
description: Use when crwu-audit is preparing its final phase-one findings and must remove reviewer-approved, low-value opinion types through the live suppression checklist.
---

# 审核意见输出过滤

## 调用边界

仅经 `crwu-audit` router 编排调用，禁止单独调用。本技能是恒加载的 `public` 轴后处理能力：不产生审核意见、不改变专业判断，只在全部候选审核意见汇总完成后、阶段一冻结前，按知识库《02-屏蔽清单》过滤不进入正式审核结果的意见。

本技能只读取运行时清单，不读取《01-维护规则》。维护规则供人员维护知识库使用，不属于每次审核的运行材料。

## 输入

- 已完成归并、尚未冻结的候选审核意见；
- 每条候选意见的稳定匹配标识：优先使用 `checkId`；无 Check ID 时使用受控的 `字段编号:问题类型`；
- router 已确定的资产、业务、方法、监管覆盖和审核阶段；
- 经 `crwu-dws` 本次实时下载并验证的《02-屏蔽清单》。

缺少或无法读取屏蔽清单时，不执行任何屏蔽，保留全部候选意见并记录 capability gap。不得沿用上一轮清单或凭记忆过滤。

## 必读 references

1. [00-applicability.md](references/00-applicability.md)：适用范围和失败降级；
2. [01-kb-assembly.md](references/01-kb-assembly.md)：本次只下载运行时屏蔽清单；
3. [02-review-focus.md](references/02-review-focus.md)：精确匹配、例外和输出纪律。

## 执行结果

- 命中启用记录，且同时满足适用范围与屏蔽条件、未命中不屏蔽例外：该候选意见不进入正式审核结果；
- 未命中、匹配冲突、条件不完整或无法判断：保留候选意见；
- 屏蔽动作不得改写其他意见的事实、严重度、证据或 `source_skills[]`；
- 正式交付不得逐条展示已屏蔽意见，也不得用摘要、备注或“其他轻微问题”等措辞变相输出其内容。
