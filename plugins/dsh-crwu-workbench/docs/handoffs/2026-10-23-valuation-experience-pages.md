# 交接：估值交互按新原型重写（2026-10-23）

> 历史快照。记录本轮在 `plugins/dsh-crwu-workbench` 内按三份新原型重写估值页面的范围、实现、验证与待接能力。

## 范围

用户明确要求：**完全按新原型重新设计估值交互**，旧估值页、旧操作顺序、旧抽屉与十一节点图界面可以放弃，不做旧页面换皮。本轮先完成页面与可交互链路，底层 OCR、真实渠道、模板重算按新交互后续接线。

## 页面与交互

| 原型 | 实现 | 位置 |
| --- | --- | --- |
| 资产评估项目总览 | 空项目/已有项目、摘要、阶段卡、进入/继续估值 | `valuation/ui/shell.tsx` 的 `AssetOverview` |
| 01 估值 · 选择对象 | 房地产可选，其他资产类别如实“暂未接通” | `valuation/ui/intake.tsx` 的 `ObjectView` |
| 资料与信息 | 文件/文件夹、树形清单、排除/恢复、重复/不支持原因、可选模板、手填字段、面积冲突 | `InfoView` / `DocsPanel` / `TemplatePanel` / `InfoForm` |
| 核对提交 | 资料候选 vs 我的填写 vs 本次采用、读取覆盖、模板、提交范围 | `ReviewView` / `CompareTable` / `CoverageRows` |
| 六步工作面 | 资料与模板、信息核对、方案推理、方案确认、案例获取、案例核对；右侧项目信息（信息/修改记录/采用依据） | `valuation/ui/workspace.tsx` |
| 方案调整/确认 | 渠道、面积范围、目标数量、停止条件、补充要求、补核时机；确认勾选后才进入案例获取 | `PlanEditor` / `ConfirmPage` |
| 案例采用/核对 | 最多 4 个采用、逐项核对、复核说明、完成核对、导出 CSV | `CasesPage` / `CaseCheckPage` |

## 状态与控制器

- `valuation/model.ts`：纯状态、资料清单/统计、字段与来源标签、面积冲突、方案有效期、案例匹配、CSV、Host 投影。
- `valuation/controller.ts`：`ValuationExperienceController`，组合真实 `ReportEvaluationController`（文件/模板/交接）与 `ValuationWorkflowController`（方案、问卷、候选、交付件）。
- `valuation/index.tsx`：总览与体验根组件。
- `apply.ts` 创建唯一实例并随 props 下发；`WorkbenchPanel` 在单测/独立挂载时兜底创建。切模块不丢草稿。
- 无跨进程协议变更，`WORKBENCH_PROTOCOL` 不需要递增。

## Host 与演示边界

- 真实模式：文件/文件夹选择、扫描、模板选择、交接走现有 Host 操作；工作区字段来自 Host 问卷，方案/候选来自 Host 回执；信息修改按问题答案提交，方案确认调用 `approvePlan`，不伪造成功。
- 演示模式：只由“载入示例项目”显式触发，顶部与页面内标注“示例数据/本地演示”；示例面积冲突、案例和覆盖率均为虚构。
- 空项目：不加载示例数据，摘要和标题显示空态；没有 Host 项目时直接进入资料入口。
- 尚未接通：真实 OCR 摘取、模板结构解析/公式重算、真实渠道（含 58）、Host 模式下结构化方案条件的双向编辑。
- 新页面暂未提供“新建另一个估值/清空当前任务”入口；已有项目通过「打开估值会话」继续，旧任务数据未被删除。
- 登录与人机验证能力区未挂到默认新页面；旧 `ValuationCapabilityArea` 组件仍在源码中，真实取数登录仍需后续接线。

## 被替换的默认交互

- `AssetAssessmentWorkflow` 不再默认渲染 `ValuationWorkflowPane` 十一节点图、`MarketWorkflow` 市场法图或 `ReportEvaluationPane` 旧输入页；改为总览/新体验。
- 旧组件文件仍在源码中（供历史测试与其他分支复用），但生产入口不再挂载它们。
- 旧的工具栏“清空/取消任务/交付件”不再是默认工作面；交付件仍可通过“打开估值会话”进入原生会话查看。

## 验证

- `npm run typecheck` 通过。
- `npm test`：3337 项，3333 通过、4 跳过、0 失败。
- `npm run build`、`npm run smoke:built` 通过。
- 逐页截图：`docs/evidence/2026-10-23-valuation-experience/`（真实组件 + Edge headless，1440 宽 + 900 窄面板 + 深色）。
- `install/ui-browser-check.mjs` 检测到新体验根后跳过旧的估值输入/图断言，避免把被替换的交互当成新页面验收。
- 新增 `tests/unit/client/client-valuation-experience.test.mjs`；重写锁定旧图/旧输入/旧清空入口的用例。
- 未验证：Windows、真实 DSH profile、真实文件/OCR、真实渠道登录、真实模板重算。
- 恢复限制：应用重启后，新页面能从 Host 恢复方案、问卷与候选；但入口所选的本机资料清单只存在于面板内存中。
  已有项目在资料页会明确提示“没有资料清单快照”，不会把历史资料显示成“没有资料”，也没有删除项目数据。

## 后续建议

1. 将本地资料/信息草稿接入 Host 持久化（当前仅面板实例内保留，重启后依赖 Host 项目恢复）。
2. 把真实 OCR 摘取结果映射到 `ExtractValue`，启用非演示面积/用途/坐落冲突。
3. 把 Host 模板要求映射为“模板缺项”明细，并接通原模板回填与重算。
4. 将方案条件编辑映射为 Host 修订请求（而非只读展示 + 问题答案）。
5. 在独立 profile 上由员工做 live 验收；Windows 需另跑 Edge/Chromium 截图与窄面板检查。
