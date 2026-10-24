# 房地产市场法工作流：实现与验收记录

日期：2026-10-22（Asia/Shanghai）。本文记录本轮实现、可复现验证与**未完成边界**，不是正式评估完成证明。

## 1. 设计依据

- 设计包：`房地产市场法-从零开发设计包.zip`（用户于 2026-10-22 提供）。
- 原型：`01-交互原型.html`，SHA-256 `1bd9d945adcb5c8d8878ee288c599a39efc2f1906673b61987b2328ff8e08a09`。
- 业务与验收：`02-从零开发设计方案.md`、`03-效果与行为验收.md`。
- 原型里的示例地址、案例、价格、定时器和演示状态只用于理解交互；生产实现未复制这些示例值或定时器。

## 2. 代码落点

| 层 | 文件 |
| --- | --- |
| 十一节点 Host 图 | `src/host/graph/valuation/realestate/template-market.ts` |
| 节点契约与校验 | `src/host/domains/report-evaluation/workflow/template-market-contracts.ts`、`src/shared/contracts/valuation-template-market.ts` |
| 节点流程 | `src/host/domains/report-evaluation/workflow/template-market-flow.ts` |
| Host 节点端口 | `src/host/integrations/valuation-workflow/production/template-market*.ts` |
| 原模板回填 | `src/host/integrations/valuation-workflow/services/market-workbook.ts`、`skills/biz/crwu-biz-valuation-realestate/scripts/build_market_workpaper.py` |
| Client 模型 | `src/client/modules/report-evaluation/market/model.ts` |
| Client 工作面 | `src/client/modules/report-evaluation/market/MarketWorkflow.tsx` |
| 抽屉与问答 | `src/client/modules/report-evaluation/market/MarketDrawer.tsx`、`MarketAnswerEditor.tsx` |
| 案例选择 | `src/client/modules/report-evaluation/market/MarketCaseList.tsx` |
| 原型样式 | `src/client/modules/report-evaluation/market/styles.ts`，色值集中在 `src/client/styles/tokens.ts` |
| 交互夹具 | `tests/browser/market-workflow-fixture.tsx` |
| 真实浏览器检查 | `install/market-workflow-browser-check.mjs` |

## 3. 原型控件—状态—契约—能力映射

| 原型 | 实现契约/状态 | 后端能力 |
| --- | --- | --- |
| 页头、摘要、节点 07/11 | `ValuationWorkflowProgressView.market` + Host `market.nodes` | 只读快照，不构造进度 |
| 11 节点与并行/汇合 | `TEMPLATE_MARKET_NODES`、LangGraph `templates`/`materials` → `collection-plan` | 模板与资料准备真实执行 |
| 03/04 方案与确认 | `TemplateMarketPlan`、`approvedPlanDigest` | 模板字段、来源、预算、停止规则；未确认不搜索 |
| 05/06 列表与候选 | `search-listings`、`candidate-workbook` | 受控网页列表、真实 URL/来源、候选 Excel |
| 07 案例多选与处理方式 | `select-cases` 问题、`control: multiselect/radio`、Other/defer | 候选版本绑定、用户勾选、不默认代选 |
| 08 详情与截图 | `inspect-details` | 只读所选案例的详情与页面截图 |
| 09 输入检查与交付路径 | `check-inputs`、`number/date/radio` | 输入校验、缺失项保持未知 |
| 10 原模板回填 | `fill-template` | 原模板副本、公式/样式保留、`recalculation` 状态 |
| 11 校验交付 | `validate-delivery` | 候选 Excel、证据索引、底稿、限制说明 |
| 等待/提交/排队/执行/失败/受限 | `status`、questionnaire drafts、submissionId、receipts | 等待停止模型、提交幂等、恢复同一轮 |

## 4. 行为验证

### 4.1 自动测试（已执行）

```sh
cd plugins/dsh-crwu-workbench
npm run typecheck
node --test tests/unit/client/client-market-workbench-model.test.mjs
node --test tests/unit/host/host-workflow-template-market-graph.test.mjs \
  tests/unit/host/host-workflow-template-market-contracts.test.mjs \
  tests/unit/client/client-workflow-template-market.test.mjs
node --test tests/unit/host/host-workflow-production-runner.test.mjs
```

本记录写入时，上述聚焦测试均通过；完整 `npm test` 与仓库门禁的最终结果见第 6 节（以最终输出为准）。

### 4.2 真实浏览器交互（Edge 155，macOS）

```sh
cd plugins/dsh-crwu-workbench
node install/market-workflow-browser-check.mjs \
  --react-root "$PWD/node_modules" \
  --playwright "<playwright-core 所在 node_modules>" \
  --browser "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --out "$PWD/.browser-market/final"
```

覆盖：390/900/1440、浅色/深色、等待/提交中/排队/执行/正常完成/受限完成/保存失败；断言 44 项，包括 11 节点、并行行、抽屉正文滚动、固定底栏、Other 互斥与草稿恢复、提交禁用条件、Escape 关闭与焦点回到触发节点、窄屏无横向溢出。报告：`docs/evidence/2026-10-22-market-workflow/browser-check-report.json`。

### 4.3 视觉对照

- `compare-light-1440-graph.png`
- `compare-light-1440-drawer.png`
- `compare-dark-1440-drawer.png`
- `compare-light-390-drawer.png`

实现截图位于 `docs/evidence/2026-10-22-market-workflow/`。宿主工作台自带的左侧栏与顶部栏在真实插件中存在；夹具页面只渲染业务工作面，因此对照图中没有重复绘制宿主侧栏。

### 4.4 资料节点时序

v2 的 `startInput` 不再预先读取全部资料；新增测试证明启动命令读取 prepared cache 的次数为 0，资料读取留给 `materials` 节点。v1 行为保留。

## 5. 真实链路状态

已由 Host/领域测试覆盖：

- 模板与资料并行、汇合、两次确认、案例版本绑定、详情只读选中、原模板副本回填与交付分级。
- 提交幂等、草稿持久化、等待/排队/失败/取消状态、停止未知保留占用、冷恢复。
- 候选 Excel 生成、证据索引、工作簿填表轨迹的真实脚本路径（测试夹具与受控 Python 端口）。

**尚未在员工真实环境验证**：

- 真实知识库模板目录/说明的实际读取与适用性判断。
- 员工上传的文本 PDF、扫描 PDF、图片、Word、Excel 的真实读取；扫描件页面判读与逐页覆盖。
- 链家 / 房天下 / 58 的实际登录、列表分页、详情页与截图；58 当前未接入。
- 真实候选 Excel、所选案例证据、原模板副本的真实字节核对。
- 原模板公式的实际重算/验真；当前交付上限仍为 `partial`，金额不能称为正式评估结论。
- Windows 实机；本轮仅在 macOS 验证。
- 在活动 DSH profile 中安装、重启并按真实员工身份走完整链路；本轮未改动员工凭据、安装配置或活动环境，也未提交/推送/发布。

## 6. 门禁结果

- `npm run check`（0.0.45）：`3324` 项测试，`3320` 通过、`4` 跳过、`0` 失败；typecheck、build、`smoke:built` 通过。
- `make plugin-check`：exit 0（含包配置、Skills 一致性、CLI 守卫、全部 Node 测试、构建、冒烟与 Python 技能测试）。
- `make docs-check`：通过（36 个文档入口）。
- `npm run pack:assert`：通过（0.0.45 tarball 541 文件）。
- `git diff --check`：通过。
- 真实浏览器：`install/market-workflow-browser-check.mjs` 44 项断言通过；浏览器 Edge 155.0.4283.62，macOS。
- `npm run check` 的 4 项跳过是宿主环境不具备的 PowerShell / lsof 真实覆盖；不是失败。
