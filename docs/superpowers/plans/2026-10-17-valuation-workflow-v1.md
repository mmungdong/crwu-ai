# Valuation Workflow V1 Implementation Plan

> **Historical snapshot.** This is the 2026-10-17 implementation plan record; it is not a current
> operating instruction. Its body (including the checklist state at the time) is preserved as written,
> and unfinished items are not relabeled. The current implementation guide is
> [`plugins/dsh-crwu-workbench/docs/valuation-workflow.md`](../../../plugins/dsh-crwu-workbench/docs/valuation-workflow.md).

> **Execution:** The user explicitly selected `dsh-orchestrator`. DSH implements each assignment; the supervisor runs tests, reviews the actual diff, and records acceptance. No additional implementation or review agents. This authorization includes implementation; no extra plan-approval round is required.

**Goal:** 在工作台中接入可执行的 LangGraph.js 房地产挂牌参考首版，从资料和适用知识形成可复核金额、底稿与来源。

**Architecture:** 按用户最新校正，以 `src/host/graph/graph.ts → graph/valuation/graph.ts → graph/valuation/realestate/graph.ts` 组成一个工作流。房地产编译子图通过显式注册函数接入估值业务图；估值图先根据用户输入与文件正文得到结构化意图，再路由至已注册专业图。通用图不导入 Cordis、DSH、Tool 或文件系统；Host 外层提供能力，Client 显示业务状态并提交决定。

**Tech Stack:** Existing TypeScript/React/Node test runner; add `@langchain/langgraph` as Host runtime dependency. Current registry version observed: 1.5.1. No SQLite or new external business command.

**Spec:** [通用估值流程设计](../specs/2026-10-17-valuation-langgraph-workflow-design.md)，首版重点实施第 3–5、10–11、15、18–19 节的单对象挂牌参考切片。

## Global Constraints

- 保留原始用途“公寓”；不得为推进流程强行改为住宅。
- 参考口径一经用户确认，在有效范围内持续生效；变更事实时重验实际依赖。
- 原始挂牌单价算术平均，未修正、未折扣；只交付参考成果，业务状态为 `partial`。
- 普通知识正文和表格都是可用来源，程序负责类型化；无 JSON 不得被描述为无知识。
- 专业参数须绑定真实原文与适用条件；未知不填零、不内置业务阈值、不执行任意生成代码。
- 凭据、员工身份、授权、案例归属、工作区与受控执行边界沿用现有服务。
- 关机恢复专项暂缓；运行中的等待、修订和重复调用防护仍需实现。
- 不提交、推送、发布，不更改真实员工 profile，不访问真实账号作为自动测试。
- 外部能力仅声明 macOS 实际验证范围；Windows 未执行时明确披露。

## Directory Responsibilities

| 目录或文件 | 职责 |
| --- | --- |
| `src/shared/contracts/valuation-workflow.ts` | 可序列化的阶段、输入输出、知识引用、待决项、修订及状态投影 |
| `src/host/graph/graph.ts` | 顶层编译图，组合业务子图并传递输入与结果 |
| `src/host/graph/valuation/` | 估值业务图、意图合同与专业图实例注册表；意图识别后分派 |
| `src/host/graph/valuation/realestate/` | 房地产专业编译子图与显式注册函数，承接七阶段执行 |
| `src/host/domains/report-evaluation/workflow/` | `ports.ts` 定义能力接口；`service.ts` 管运行、版本、互斥、等待和修订，不拥有图拓扑 |
| `src/host/domains/report-evaluation/assets/realestate/` | 专业要素核对、参考口径、对象与案例输入约束 |
| `src/host/domains/report-evaluation/knowledge/requirements.ts` | 原文定位、适用条件、单位和冲突校验；保留语义核实缺口 |
| `src/host/integrations/valuation-workflow/` | DSH 独立会话适配、真实知识通道、受控计算和文件验收的外层装配 |
| `src/host/operations/report-evaluation/workflow.ts` | 面板启动、状态、回答、修订与取消；核对当前工作区与项目归属 |
| `src/host/tools/report-evaluation/workflow.ts` | 已登记估值会话的命名业务接口；与面板复用同一实例 |
| `src/client/modules/report-evaluation/workflow/` | 页面状态控制、RPC 投影、过期响应防护及轮询清理 |
| `src/client/modules/report-evaluation/ui/ValuationWorkflowPane.tsx` | 阶段进度、节点输入输出、采用知识、澄清与修订交互 |

现有 Tool 内的业务能力如需抽取，移入对应应用服务供两侧调用，保留原有参数和授权行为；禁止在图中伪造 ToolRunContext 调用 Tool 的 `execute()`。入口文件只做装配。样式留在所属模块的 `styles/`，不把领域逻辑放进 shared、Client 或通用入口。

## Review Focus

1. 用户输入缺失与材料冲突：合并必要问题，保留来源；不能靠重复确认解除同一个阻断。
2. 错误知识或错误语义：摘要、原文位置、用途与单位需要分别检查；仅有原文引用不证明语义正确。
3. 任务中途修订：原执行者未静止不启动新写入，旧响应不能覆盖新版本。
4. 图已经存在但产品没接：从现有估值入口、Host 装配和真实业务适配器到页面必须可达。
5. 假交付：脚本成功或文件非空不等于成果正确；实际金额、对象、链接、图片及限制需要回读核对。

## Task 1: Tests Before Implementation

**Files:**
- `tests/unit/host/host-valuation-workflow.test.mjs`
- `tests/unit/host/host-valuation-workflow-knowledge.test.mjs`
- `tests/unit/client/client-valuation-workflow.test.mjs`
- Optional `tests/helpers/valuation-workflow-fixture.mjs`

**Interfaces:** `createValuationWorkflowService(ports)` provides `start/get/answer/revise/cancel`. Inference, knowledge, calculation, artifact verification and cancellation are injected. Seven visible stages: `elements/rights/plan/evidence/calculation/review/delivery`. Snapshot includes stable run identity, revision, stage receipts and waiting/blocked/reference-delivered status. Worker reports exact test data and port contracts for implementation.

- [ ] DSH writes tests only: successful reference delivery, missing elements, accepted mode retention, knowledge validation, failure stops, revision impact and fresh sessions, stale outputs, Client inspection and correction.
- [ ] Supervisor runs the three tests and confirms intended red, rather than syntax or missing test tooling.
- [ ] Supervisor inspects test assertions and records the assignment verdict before resuming DSH.

## Task 2: Graph and Business Integration

**Files:** New domain/shared/integration units listed above; focused changes to current knowledge and listing services, Tool registration, application assembly, handoff prompt and scope plumbing.

**Interfaces:** Domain consumes validated business inputs and injected capabilities. Host adapters own real DSH identity and access. Every inference attempt receives only its explicit task package in a fresh supported session. Each node emits inspected input, output, adopted knowledge and checks. Knowledge requests follow verified Wiki links using resolved `path`, not unqualified relative `target`.

- [ ] Add the declared LangGraph Host dependency and build a real compiled `StateGraph`; do not substitute an unused dependency or hand-written stage counter.
- [ ] Implement seven-stage service with version guards, one active writer, missing-input wait, conditional next stage, retained decisions, immutable previous result and dependency-based rerun.
- [ ] Bind prose/table requirement candidates to actual snapshots, section/quote context, units and applicability; preserve ambiguity for necessary professional review. Fix misleading JSON-only error wording and relative-link Tool descriptions.
- [ ] Connect actual knowledge reads, material extraction, source/case acquisition, controlled listing calculation and actual artifact validation through production adapters. Reuse same business services as existing Tools; no duplicate unauthenticated execution path.
- [ ] Add regression tests before changing existing integration behavior, and hand them to supervisor for red confirmation.
- [ ] Supervisor runs narrow tests, TypeScript and actual diff review; observed failures become focused correction assignments.

## Task 3: Reachable Product Surface

**Files:** New Host workflow operations and Tool, current RPC/contracts and controller integration, dedicated workflow controller and pane, module-owned styles, fixture/browser assertions.

**Interfaces:** Client receives only validated public snapshots. Correction includes expected revision, allowed fields, reason and source; Host calculates impact and revalidates before dispatch. Authentication is server-side. The existing workspace and intake behavior remain available.

- [ ] Provide a usable entry from the current valuation workflow, project-bound status, node input/output/knowledge tabs and explicit waiting/failed/reference-delivered labels.
- [ ] Support necessary answers, correction impact preview and confirmed rerun; retain original result and identify new inference conversations.
- [ ] Ensure requests and polling clean up on navigation, stale revisions cannot mutate state, and percentages are not inferred from elapsed time or stage count.
- [ ] Update cross-process protocol `42 → 43` if these contracts change; synchronize frozen operation/Tool inventories and lifecycle assembly.
- [ ] Supervisor verifies visible behavior with existing render helpers; add a focused browser-check path and run it only if the supported browser/runtime is actually available.

## Task 4: Packaging and Acceptance

**Files:** `package.json`, `package-lock.json`, `VERSION`, Host version constant, plugin changelog, English/Chinese READMEs and current development/product notes as required by actual changes.

- [ ] Bump plugin `0.0.48 → 0.0.49` through the existing synchronization command; append accurate change and limitation notes.
- [ ] Supervisor runs `npm run typecheck`, focused workflow/regression tests, then `make plugin-check`, `make docs-check` and `git diff --check`.
- [ ] Run existing Python listing-reference contract tests with a capability-probed compatible interpreter and inspect generated deliverables where applicable.
- [ ] Inspect complete actual diff, including new files, for unrelated edits, secret-bearing data, architecture boundary violations, generated artifacts and stale docs.
- [ ] Record supervisor review with actual evidence. Mark each implemented task checked only after evidence exists.

Real employee knowledge access, production website scraping, Windows validation and installed-profile acceptance remain explicitly unverified unless separately performed. Automated tests use controlled fixtures; the final report distinguishes implementation, fixture acceptance and live acceptance.
